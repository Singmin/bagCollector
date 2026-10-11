import './test-env.mjs';
import assert from 'node:assert/strict';
import { randomUUID, createHmac } from 'node:crypto';
import { spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { resolve } from 'node:path';
import { PrismaClient } from '@prisma/client';
import sharp from 'sharp';
import { DEFAULT_SCAN_SETTINGS, COLOR_SCAN_MODEL, DINO_SCAN_MODEL, BAG_FEATURE_MODEL, bagFeatures } from '../packages/bag-vision/dist/index.js';

if (!new URL(process.env.DATABASE_URL).pathname.endsWith('_test')) throw new Error('Scan integration requires an isolated *_test database');
process.env.STORAGE_DRIVER = 'local';
process.env.LOCAL_STORAGE_PATH = resolve('.runtime/test-scan-storage');
const { scanPrisma, processScan, reserveEnhancement, reconcileScanEmbeddings, cleanupScans, shanghaiDay } = await import('../apps/worker/dist/scan-processor.js');
const { putObject, getObject, deleteObjects } = await import('../apps/worker/dist/object-store.js');
const { MatchScansService } = await import('../apps/api/dist/official-bags/match-scans.service.js');
const { OfficialBagsService } = await import('../apps/api/dist/official-bags/official-bags.service.js');
const { SettingsService } = await import('../apps/api/dist/settings/settings.service.js');
const { CosService } = await import('../apps/api/dist/assets/cos.service.js');
const prisma = new PrismaClient();
const prefix = `scan-test-${randomUUID()}`;
let server; let scanWorker; let adminId;
const userIds = []; const bagIds = []; const keys = [];
const day = shanghaiDay();
const oldGlobal = await prisma.scanEnhancementUsage.findUnique({ where: { day_scope: { day, scope: 'global' } } });
const oldSettings = await prisma.appSetting.findUnique({ where: { key: 'scan.settings' } });
let enqueued = 0;
const queues = { addScan: async () => { enqueued++; }, add: async () => {}, scans: { add: async () => {} } };
const settingsService = new SettingsService(prisma);
const bagsService = new OfficialBagsService(prisma, new CosService(), settingsService);
const scans = new MatchScansService(prisma, queues, new CosService(), settingsService, bagsService);
const defaults = { ...DEFAULT_SCAN_SETTINGS, enhancementEnabled: false };
const newJob = async (userId, suffix, extra = {}) => prisma.matchScan.create({ data: {
  userId, collectibleId: `${prefix}-none`, requestId: `${prefix}-${suffix}`, source: 'album', sourceKey: 'none', sourceVersion: 1,
  model: COLOR_SCAN_MODEL, settings: defaults, ...extra
} });
function token(sub, typ) {
  const header = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url');
  const payload = Buffer.from(JSON.stringify({ sub, sid: 'test', typ, exp: Math.floor(Date.now() / 1000) + 300 })).toString('base64url');
  return `${header}.${payload}.${createHmac('sha256', process.env.JWT_SECRET).update(`${header}.${payload}`).digest('base64url')}`;
}
async function http(path, authorization, init = {}, expected = 200) {
  const response = await fetch(`http://127.0.0.1:3188/api${path}`, { ...init,
    headers: { ...(authorization ? { Authorization: `Bearer ${authorization}` } : {}), ...(typeof init.body === 'string' ? { 'content-type': 'application/json' } : {}) } });
  const body = await response.json(); assert.equal(response.status, expected, JSON.stringify(body)); return body;
}
try {
  assert.equal(shanghaiDay(new Date('2026-10-10T16:00:00Z')), '2026-10-11');
  for (let i = 0; i < 2; i++) userIds.push((await prisma.user.create({ data: {
    openid: `${prefix}-${i}`, storageQuotaBytes: 10000000n, collectibleQuota: 50, dailyMattingQuota: 3
  } })).id);
  const [userId, otherUser] = userIds;
  await prisma.appSetting.upsert({ where: { key: 'scan.settings' }, create: { key: 'scan.settings', value: JSON.stringify(defaults) }, update: { value: JSON.stringify(defaults) } });
  const shelf = await prisma.shelf.create({ data: { userId, name: prefix, theme: 'SAGE' } });
  const collectible = await prisma.collectible.create({ data: { userId, shelfId: shelf.id, name: prefix, processingStatus: 'AWAITING_CROP' } });
  const image = await sharp(Buffer.from('<svg width="200" height="300"><rect width="200" height="300" fill="white"/><rect x="30" y="35" width="140" height="230" fill="#b43f21"/><circle cx="90" cy="130" r="40" fill="#352480"/></svg>')).png().toBuffer();
  const sourceKey = `${prefix}/original.png`; keys.push(sourceKey);
  await putObject(sourceKey, image, 'image/png');
  await prisma.imageAsset.create({ data: { userId, collectibleId: collectible.id, kind: 'ORIGINAL', status: 'AVAILABLE', objectKey: sourceKey, contentType: 'image/png', byteSize: BigInt(image.length) } });
  const bag = await prisma.officialBag.create({ data: { name: prefix, status: 'PUBLISHED', processStatus: 'READY', version: 1 } }); bagIds.push(bag.id);
  await prisma.officialBagImage.create({ data: { officialBagId: bag.id, kind: 'DISPLAY', objectKey: sourceKey, contentType: 'image/png' } });
  const lowBag = await prisma.officialBag.create({ data: { name: `${prefix}-low`, status: 'PUBLISHED', processStatus: 'READY', version: 1 } }); bagIds.push(lowBag.id);
  const legacyVector = Array.from(await bagFeatures.extract(image));
  for (const [id, vector] of [[bag.id, legacyVector], [lowBag.id, legacyVector.map(v => -v)]]) {
    await prisma.bagEmbedding.create({ data: { officialBagId: id, model: BAG_FEATURE_MODEL, vector, sourceKind: 'DISPLAY', sourceVersion: 1 } });
  }
  const legacyResult = await bagsService.match(userId, collectible.id);
  assert.equal(legacyResult.result, 'CANDIDATES'); assert.equal(legacyResult.candidates.length, 1, 'legacy must filter every score');
  await prisma.officialBag.update({ where: { id: lowBag.id }, data: { status: 'OFFLINE' } });
  await assert.rejects(settingsService.updateScanSettings('unused', { ...defaults, engine: 'dino' }), e => e.getStatus() === 409);
  await reconcileScanEmbeddings(100);
  assert.ok(await prisma.scanEmbedding.findUnique({ where: { officialBagId_model_referenceKey: { officialBagId: bag.id, model: COLOR_SCAN_MODEL, referenceKey: 'primary' } } }));
  const input = { collectibleId: collectible.id, source: 'album', requestId: `${prefix}-album` };
  const created = await Promise.all([scans.create(userId, input), scans.create(userId, input)]);
  assert.equal(created[0].scanId, created[1].scanId); assert.equal(enqueued, 1);
  await assert.rejects(scans.create(userId, { ...input, source: 'camera' }), e => e.getStatus() === 409);
  await assert.rejects(scans.result(otherUser, created[0].scanId), e => e.getStatus() === 404);
  await processScan(created[0].scanId);
  const result = await scans.result(userId, created[0].scanId);
  assert.equal(result.stage, 'DONE'); assert.equal(result.result, 'CANDIDATES');
  assert.equal(result.candidates[0].bag.id, bag.id); assert.equal(result.candidates[0].score, 1);
  assert.equal(await prisma.officialClaim.count({ where: { userId } }), 0, 'recognition must never auto-claim');
  assert.deepEqual(await getObject(sourceKey), image, 'original must remain unchanged');
  const before = await prisma.matchScan.findUnique({ where: { id: created[0].scanId } });
  await processScan(created[0].scanId);
  assert.deepEqual(await prisma.matchScan.findUnique({ where: { id: created[0].scanId } }), before, 'redelivery cannot reprocess');
  server = spawn(process.execPath, ['apps/api/dist/main.js'], { env: { ...process.env, API_PORT: '3188', NODE_ENV: 'test' }, stdio: ['ignore', 'pipe', 'pipe'] });
  let serverOutput = ''; server.stdout.on('data', d => { serverOutput += d; }); server.stderr.on('data', d => { serverOutput += d; });
  let ready = false;
  for (let i = 0; i < 120; i++) {
    if (server.exitCode !== null) throw new Error(serverOutput);
    try { const response = await fetch('http://127.0.0.1:3188/api/health/ready'); if (response.ok) { ready = true; break; } } catch { /* starting */ }
    await delay(500);
  }
  assert.ok(ready, serverOutput);
  const userToken = token(userId, 'access');
  await http(`/official-bags/match-scans/${created[0].scanId}`, null, {}, 401);
  await http(`/official-bags/match-scans/${created[0].scanId}`, token(otherUser, 'access'), {}, 404);
  assert.equal((await http('/official-bags/match-scans', userToken, { method: 'POST', body: JSON.stringify(input) }, 201)).scanId, created[0].scanId);
  await http('/official-bags/match-scans', userToken, { method: 'POST', body: JSON.stringify({ ...input, requestId: `${prefix}-invalid`, crop: { x: .9, y: 0, width: .5, height: 1 } }) }, 400);
  assert.equal((await http(`/official-bags/match-scans/${created[0].scanId}`, userToken)).candidates[0].bag.id, bag.id);
  adminId = (await prisma.admin.create({ data: { username: prefix, passwordHash: 'unused-test' } })).id;
  const adminToken = token(adminId, 'admin');
  await http('/admin/settings/scan', userToken, {}, 401);
  await http('/admin/settings/scan', adminToken, { method: 'PUT', body: JSON.stringify(defaults) });
  assert.ok((await http('/admin/match-scans', adminToken)).items.some(row => row.id === created[0].scanId));
  const uploads = await Promise.all(Array.from({ length: 6 }, async () => {
    const form = new FormData(); form.append('file', new Blob([image], { type: 'image/png' }), 'reference.png');
    const response = await fetch(`http://127.0.0.1:3188/api/admin/official-bags/${bag.id}/references`, { method: 'POST', headers: { Authorization: `Bearer ${adminToken}` }, body: form });
    const body = await response.json(); return { status: response.status, body };
  }));
  assert.equal(uploads.filter(r => r.status === 201).length, 5, JSON.stringify(uploads));
  assert.equal(uploads.filter(r => r.status === 409).length, 1, 'concurrent reference upload must respect five-image limit');
  const refs = await http(`/admin/official-bags/${bag.id}/references`, adminToken); assert.equal(refs.length, 5);
  keys.push(...refs.map(r => r.objectKey));
  await reconcileScanEmbeddings(100);
  assert.equal(await prisma.scanEmbedding.count({ where: { officialBagId: bag.id, model: COLOR_SCAN_MODEL } }), 6, 'one primary plus five references');
  await http(`/admin/official-bags/${bag.id}/references/${refs[0].id}`, adminToken, { method: 'DELETE' });
  assert.equal(await prisma.scanEmbedding.count({ where: { officialBagId: bag.id, referenceKey: refs[0].id } }), 0);
  await reconcileScanEmbeddings(100);
  assert.equal(await prisma.scanEmbedding.count({ where: { officialBagId: bag.id, referenceKey: refs[0].id } }), 0, 'deleted reference cannot be resurrected');
  if (process.env.VISION_SERVICE_URL) {
    scanWorker = spawn(process.execPath, ['apps/worker/dist/scan-main.js'], { env: { ...process.env, NODE_ENV: 'test' }, stdio: ['ignore', 'pipe', 'pipe'] });
    let workerOutput = ''; scanWorker.stdout.on('data', d => { workerOutput += d; }); scanWorker.stderr.on('data', d => { workerOutput += d; });
    await http('/admin/settings/scan', adminToken, { method: 'PUT', body: JSON.stringify({ ...defaults, engine: 'dino' }) });
    const dino = await http('/official-bags/match-scans', userToken, { method: 'POST', body: JSON.stringify({ ...input, requestId: `${prefix}-dino-query` }) }, 201);
    let dinoResult;
    for (let i = 0; i < 40; i++) {
      if (scanWorker.exitCode !== null) throw new Error(workerOutput);
      dinoResult = await http(`/official-bags/match-scans/${dino.scanId}`, userToken);
      if (['DONE', 'FAILED'].includes(dinoResult.stage)) break;
      await delay(500);
    }
    assert.equal(dinoResult.stage, 'DONE'); assert.equal(dinoResult.candidates[0].bag.id, bag.id);
    assert.equal(dinoResult.candidates.length, 1, 'reference deduplication in real DINO query');
    assert.equal((await prisma.matchScan.findUnique({ where: { id: dino.scanId } })).model, DINO_SCAN_MODEL);
    await http('/admin/settings/scan', adminToken, { method: 'PUT', body: JSON.stringify(defaults) });
  }
  await bagsService.claim(userId, bag.id);
  await scans.feedback(userId, created[0].scanId, { feedback: 'SELECTED', bagId: bag.id });
  assert.equal((await scans.result(userId, created[0].scanId)).candidates[0].bag.claimed, true);
  await prisma.officialBag.update({ where: { id: bag.id }, data: { status: 'OFFLINE' } });
  assert.equal((await scans.result(userId, created[0].scanId)).candidates.length, 0);
  await prisma.officialBag.update({ where: { id: bag.id }, data: { status: 'PUBLISHED' } });
  const timeout = await newJob(userId, 'timeout', { createdAt: new Date(Date.now() - 46000), scores: [{ bagId: bag.id, score: .9 }] });
  assert.equal((await scans.result(userId, timeout.id)).stage, 'DONE', 'timeout retains base candidates');
  await prisma.scanEnhancementUsage.upsert({ where: { day_scope: { day, scope: 'global' } }, create: { day, scope: 'global', count: 0 }, update: { count: 0 } });
  const quotaJobs = await Promise.all(Array.from({ length: 8 }, (_, i) => newJob(userId, `quota-${i}`)));
  const reservations = await Promise.all(quotaJobs.map(j => reserveEnhancement(j.id, userId, DEFAULT_SCAN_SETTINGS)));
  assert.equal(reservations.filter(Boolean).length, 5, 'concurrent user limit is atomic');
  assert.equal(await reserveEnhancement(quotaJobs.find((_, i) => reservations[i]).id, userId, DEFAULT_SCAN_SETTINGS), false, 'issued request cannot charge twice');
  assert.equal((await prisma.user.findUnique({ where: { id: userId } })).dailyMattingQuota, 3, 'manual matting allowance is independent');
  assert.equal((await prisma.scanEnhancementUsage.findUnique({ where: { day_scope: { day, scope: 'global' } } })).count, 5);
  const disabled = await newJob(otherUser, 'disabled');
  assert.equal(await reserveEnhancement(disabled.id, otherUser, { ...defaults, dailyGlobalEnhancements: 0 }), false);
  assert.equal(await reserveEnhancement(disabled.id, otherUser, { ...DEFAULT_SCAN_SETTINGS, dailyGlobalEnhancements: 5 }), false, 'global limit spans users');
  assert.equal(await reserveEnhancement(timeout.id, userId, DEFAULT_SCAN_SETTINGS), false, 'expired task cannot spend');
  await prisma.matchScan.updateMany({ where: { id: { in: quotaJobs.map(j => j.id) } }, data: { createdAt: new Date(Date.now() - 120000) } });
  await prisma.scanEmbedding.updateMany({ where: { officialBagId: bag.id }, data: { sourceVersion: 0 } });
  const stale = await scans.create(userId, { ...input, requestId: `${prefix}-stale` }); await processScan(stale.scanId);
  assert.equal((await scans.result(userId, stale.scanId)).reason, 'INDEX_NOT_READY');
  await prisma.officialBag.update({ where: { id: bag.id }, data: { status: 'OFFLINE' } });
  if (await prisma.officialBag.count({ where: { status: 'PUBLISHED', processStatus: 'READY' } }) === 0) {
    const empty = await scans.create(userId, { ...input, requestId: `${prefix}-empty` }); await processScan(empty.scanId);
    assert.equal((await scans.result(userId, empty.scanId)).reason, 'LIBRARY_EMPTY');
  }
  queues.addScan = async () => { throw new Error('Redis offline'); };
  const noQueue = await scans.create(userId, { ...input, requestId: `${prefix}-queue-offline` });
  assert.equal((await scans.result(userId, noQueue.scanId)).reason, 'QUEUE_UNAVAILABLE');
  await processScan(noQueue.scanId);
  assert.equal((await scans.result(userId, noQueue.scanId)).reason, 'QUEUE_UNAVAILABLE', 'late delivery must not restart a failed job');
  const temporary = `${prefix}/temporary.png`; keys.push(temporary); await putObject(temporary, image, 'image/png');
  const old = await newJob(userId, 'cleanup', { createdAt: new Date(Date.now() - 31 * 86400000), temporaryKeys: [temporary] });
  await cleanupScans();
  assert.equal(await prisma.collectible.findUnique({ where: { id: collectible.id } }), null, 'confirmed draft cleanup survives a missed client DELETE');
  assert.equal(await prisma.officialClaim.count({ where: { userId } }), 1, 'confirmed official collection is preserved');
  assert.equal(await prisma.matchScan.findUnique({ where: { id: old.id } }), null); await assert.rejects(getObject(temporary));
  if (process.env.VISION_SERVICE_URL) assert.ok(await prisma.scanEmbedding.count({ where: { officialBagId: bag.id, model: DINO_SCAN_MODEL } }), 'real DINO backfill');
  console.log('Scan integration passed: authenticated HTTP routes, legacy compatibility, idempotency, real image processing, confirmation, concurrent reference limit/deletion, stale/offline filtering, quota concurrency, timeout and cleanup.');
} finally {
  if (scanWorker) { scanWorker.kill(); await Promise.race([new Promise(r => scanWorker.once('exit', r)), delay(3000)]); }
  if (server) { server.kill(); await Promise.race([new Promise(r => server.once('exit', r)), delay(3000)]); }
  await prisma.officialClaim.deleteMany({ where: { userId: { in: userIds } } });
  await prisma.collectible.deleteMany({ where: { userId: { in: userIds } } });
  await prisma.user.deleteMany({ where: { id: { in: userIds } } });
  await prisma.officialBag.deleteMany({ where: { id: { in: bagIds } } });
  await prisma.scanEnhancementUsage.deleteMany({ where: { scope: { in: userIds } } });
  if (adminId) { await prisma.auditLog.deleteMany({ where: { adminId } }); await prisma.admin.delete({ where: { id: adminId } }); }
  if (oldGlobal) await prisma.scanEnhancementUsage.update({ where: { day_scope: { day, scope: 'global' } }, data: { count: oldGlobal.count } });
  else await prisma.scanEnhancementUsage.deleteMany({ where: { day, scope: 'global' } });
  if (oldSettings) await prisma.appSetting.update({ where: { key: 'scan.settings' }, data: { value: oldSettings.value } });
  else await prisma.appSetting.deleteMany({ where: { key: 'scan.settings' } });
  await deleteObjects(keys); await prisma.$disconnect(); await scanPrisma.$disconnect();
}
