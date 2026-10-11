import './test-env.mjs';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { mkdir, rm } from 'node:fs/promises';
import { PrismaClient } from '@prisma/client';
import sharp from 'sharp';
import { COLOR_SCAN_MODEL, DINO_SCAN_MODEL, DEFAULT_SCAN_SETTINGS, DEFAULT_LEARNING_SETTINGS, extractScanFeature, compressLearningSample } from '../packages/bag-vision/dist/index.js';

if (!new URL(process.env.DATABASE_URL).pathname.endsWith('_test')) throw new Error('Requires isolated *_test database');
process.env.STORAGE_DRIVER = 'local';
process.env.LOCAL_STORAGE_PATH = resolve('.runtime/test-learning-storage');
// Deterministic inference stub validates lifecycle/transport, not model quality or performance.
let brokenModel = false;
const vision = createServer(async (request, response) => {
  for await (const chunk of request) { void chunk; }
  if (brokenModel) { response.writeHead(503); response.end(); return; }
  response.setHeader('content-type', 'application/json');
  response.end(JSON.stringify({ model: DINO_SCAN_MODEL, vector: Array.from({ length: 384 }, (_, i) => i === 0 ? 1 : 0) }));
});
await new Promise(resolve => vision.listen(0, '127.0.0.1', resolve));
const stubUrl = `http://127.0.0.1:${vision.address().port}`;
const realVisionUrl = process.env.LEARNING_TEST_VISION_URL;
const visionUrl = realVisionUrl || stubUrl;
process.env.VISION_SERVICE_URL = visionUrl;
const { scanPrisma, processScan } = await import('../apps/worker/dist/scan-processor.js');
const { captureLearningSample, computeLearningSample, cleanupLearningSamples, deleteLearningSample } = await import('../apps/worker/dist/learning-processor.js');
const { putObject, getObject, deleteObjects } = await import('../apps/worker/dist/object-store.js');
const { LearningSamplesService } = await import('../apps/api/dist/official-bags/learning-samples.service.js');
const { MatchScansService } = await import('../apps/api/dist/official-bags/match-scans.service.js');
const { SettingsService } = await import('../apps/api/dist/settings/settings.service.js');
const { OfficialBagsService } = await import('../apps/api/dist/official-bags/official-bags.service.js');
const { CosService } = await import('../apps/api/dist/assets/cos.service.js');
const prisma = new PrismaClient(); const prefix = `learning-test-${randomUUID()}`;
const originalSettings = await prisma.appSetting.findUnique({ where: { key: 'learning.settings' } });
const queues = { scans: { add: async () => {} }, add: async () => {}, addScan: async () => {} };
const cos = new CosService(); const settingsService = new SettingsService(prisma);
const bags = new OfficialBagsService(prisma, cos, settingsService);
const learning = new LearningSamplesService(prisma, cos, queues);
const scans = new MatchScansService(prisma, queues, cos, settingsService, bags, learning);
let user, other, admin, bag, offline, worker; const scanIds = []; const objectKeys = []; const extraSampleIds = [];
const scanSettings = { ...DEFAULT_SCAN_SETTINGS, engine: 'dino', enhancementEnabled: false };
async function config(budgetBytes, enabled = true) { return learning.saveSettings(admin.id, { enabled, budgetBytes }); }
async function job(extra = {}) {
  const row = await prisma.matchScan.create({ data: { userId: user.id, collectibleId: `${prefix}-none`, requestId: randomUUID(), source: 'camera',
    sourceKey: 'none', sourceVersion: 1, model: DINO_SCAN_MODEL, settings: scanSettings, stage: 'DONE', finishedAt: new Date(), scores: [{ bagId: bag.id, score: .9 }], ...extra } });
  scanIds.push(row.id); return row;
}
const sampleOf = scan => prisma.learningSample.findUniqueOrThrow({ where: { scanId: scan.id } });
const featureCount = () => prisma.scanEmbedding.count({ where: { officialBagId: bag.id, referenceKey: { not: 'primary' } } });
const eligible = e => e.getStatus() === 409;
try {
  user = await prisma.user.create({ data: { openid: prefix, storageQuotaBytes: 100000000n, collectibleQuota: 100, dailyMattingQuota: 3 } });
  other = await prisma.user.create({ data: { openid: `${prefix}-other`, storageQuotaBytes: 10000000n, collectibleQuota: 50, dailyMattingQuota: 3 } });
  admin = await prisma.admin.create({ data: { username: prefix, passwordHash: 'unused' } });
  bag = await prisma.officialBag.create({ data: { name: prefix, status: 'PUBLISHED', processStatus: 'READY', version: 1 } });
  offline = await prisma.officialBag.create({ data: { name: `${prefix}-offline`, status: 'OFFLINE', processStatus: 'READY', version: 1 } });
  assert.equal(DEFAULT_LEARNING_SETTINGS.enabled, false);
  const initial = await learning.settings(); assert.equal(initial.enabled, false, 'migration defaults off');
  await config(1024 ** 3);
  const image = await sharp(Buffer.from('<svg width="700" height="1000"><rect width="700" height="1000" fill="white"/><rect x="90" y="140" width="500" height="780" fill="#8220ad"/><circle cx="280" cy="420" r="100" fill="#123463"/></svg>')).png().toBuffer();
  const compressed = await compressLearningSample(image); const compressedMeta = await sharp(compressed).metadata();
  assert.equal(compressedMeta.height, 512); assert.ok(compressed.length <= 200 * 1024);
  const sourceKey = `${prefix}/original.png`; objectKeys.push(sourceKey); await putObject(sourceKey, image, 'image/png');
  await prisma.officialBagImage.create({ data: { officialBagId: bag.id, kind: 'DISPLAY', objectKey: sourceKey, contentType: 'image/png' } });
  const color = (await extractScanFeature(image, 'color')).colorVector;
  const referenceFeature = await extractScanFeature(image, 'dino', visionUrl);
  await prisma.scanEmbedding.create({ data: { officialBagId: bag.id, model: DINO_SCAN_MODEL, referenceKey: 'primary', vector: referenceFeature.vector.map(v => -v), colorVector: color, sourceKind: 'DISPLAY', sourceVersion: 1 } });
  const shelf = await prisma.shelf.create({ data: { userId: user.id, name: prefix, theme: 'SAGE' } });
  const draft = await prisma.collectible.create({ data: { userId: user.id, shelfId: shelf.id, name: prefix, processingStatus: 'AWAITING_CROP' } });
  await prisma.imageAsset.create({ data: { userId: user.id, collectibleId: draft.id, kind: 'ORIGINAL', objectKey: sourceKey, contentType: 'image/png', status: 'AVAILABLE', byteSize: BigInt(image.length) } });
  const scan = await job({ collectibleId: draft.id, sourceKey, stage: 'QUEUED', finishedAt: null, scores: [] });
  await processScan(scan.id);
  const sample = await sampleOf(scan); assert.equal(sample.state, 'STAGED'); assert.equal(sample.featureState, 'WAITING_LABEL');
  assert.deepEqual(await getObject(sample.objectKey), compressed, 'independent compressed actual scan crop saved before confirmation');
  await assert.rejects(learning.feedback(other.id, scan.id, { feedback: 'CORRECTED', bagId: bag.id }), e => e.getStatus() === 404);
  await assert.rejects(learning.feedback(user.id, scan.id, { feedback: 'CORRECTED', bagId: bag.id }), eligible);
  await bags.claim(user.id, bag.id);
  const owned = await prisma.officialClaim.findUniqueOrThrow({ where: { userId_officialBagId: { userId: user.id, officialBagId: bag.id } } });
  await prisma.officialClaim.update({ where: { id: owned.id }, data: { createdAt: new Date(Date.now() - 86400_000) } });
  await assert.rejects(learning.feedback(user.id, scan.id, { feedback: 'SELECTED', bagId: bag.id }), e => e.getStatus() === 400);
  await assert.rejects(learning.feedback(user.id, scan.id, { feedback: 'CORRECTED', bagId: offline.id }), eligible);
  const feedback = await Promise.all([1, 2, 3].map(() => learning.feedback(user.id, scan.id, { feedback: 'CORRECTED', bagId: bag.id })));
  assert.ok(feedback.every(r => r.success && r.sampleStatus === 'PENDING'));
  assert.equal(await prisma.learningSample.count({ where: { scanId: scan.id } }), 1);
  await assert.rejects(learning.feedback(user.id, scan.id, { feedback: 'NONE' }), eligible);
  assert.equal(await prisma.officialClaim.count({ where: { userId: user.id } }), 1, 'already owned feedback does not duplicate claim');
  assert.equal(await featureCount(), 0, 'unreviewed sample never indexed');
  await prisma.collectible.delete({ where: { id: draft.id } }); await deleteObjects([sourceKey]);
  assert.deepEqual(await getObject(sample.objectKey), compressed, 'deleting original draft cannot remove independent sample');
  brokenModel = true; process.env.VISION_SERVICE_URL = stubUrl; await computeLearningSample(sample.id);
  assert.equal((await sampleOf(scan)).featureState, 'FAILED'); assert.equal(await featureCount(), 0);
  brokenModel = false; process.env.VISION_SERVICE_URL = visionUrl; await learning.review(admin.id, sample.id, { action: 'RECOMPUTE' }); await computeLearningSample(sample.id);
  const computed = await prisma.learningSample.findUniqueOrThrow({ where: { id: sample.id }, include: { features: true } });
  assert.equal(computed.featureState, 'READY'); assert.equal(computed.features.length, 2);
  const exact = await extractScanFeature(compressed, 'dino', process.env.VISION_SERVICE_URL);
  assert.ok(computed.features.find(f => f.model === DINO_SCAN_MODEL).colorVector.every((v, i) => Math.abs(v - exact.colorVector[i]) < 1e-12), 'embed stored JPEG, not original query');
  await learning.review(admin.id, sample.id, { action: 'APPROVE' }); assert.equal(await featureCount(), 2);
  const active = await sampleOf(scan); assert.equal(active.state, 'APPROVED'); assert.equal(active.expiresAt, null);
  assert.equal(await deleteLearningSample(sample.id, true), false, 'capacity eviction cannot delete approved reference');
  await learning.review(admin.id, sample.id, { action: 'WITHDRAW' }); assert.equal(await featureCount(), 0);
  await learning.review(admin.id, sample.id, { action: 'RESTORE' }); assert.equal(await featureCount(), 2);
  await prisma.matchScan.delete({ where: { id: scan.id } }); assert.equal((await prisma.learningSample.findUniqueOrThrow({ where: { id: sample.id } })).state, 'APPROVED');
  // Real scan ranking responds to reference addition/removal (fixture is not an accuracy evaluation).
  await putObject(sourceKey, compressed, 'image/jpeg');
  const queryDraft = await prisma.collectible.create({ data: { userId: user.id, shelfId: shelf.id, name: `${prefix}-query`, processingStatus: 'AWAITING_CROP' } });
  await prisma.imageAsset.create({ data: { userId: user.id, collectibleId: queryDraft.id, kind: 'ORIGINAL', objectKey: `${prefix}/query.jpg`, contentType: 'image/jpeg', status: 'AVAILABLE' } });
  objectKeys.push(`${prefix}/query.jpg`); await putObject(`${prefix}/query.jpg`, compressed, 'image/jpeg');
  const query = await job({ collectibleId: queryDraft.id, sourceKey: `${prefix}/query.jpg`, stage: 'QUEUED', finishedAt: null, scores: [] });
  await processScan(query.id); assert.equal((await scans.result(user.id, query.id)).candidates[0].bag.id, bag.id);
  await learning.review(admin.id, sample.id, { action: 'WITHDRAW' });
  const noRef = await job({ collectibleId: queryDraft.id, sourceKey: `${prefix}/query.jpg`, stage: 'QUEUED', finishedAt: null, scores: [] });
  await processScan(noRef.id); assert.equal((await scans.result(user.id, noRef.id)).candidates.length, 0);
  await learning.review(admin.id, sample.id, { action: 'RESTORE' });
  const duplicateScan = await job(); await captureLearningSample(duplicateScan, image);
  assert.equal((await learning.feedback(user.id, duplicateScan.id, { feedback: 'SELECTED', bagId: bag.id })).skipReason, 'EXACT_DUPLICATE');
  const lateLabel = await job();
  await captureLearningSample(lateLabel, await sharp(image).modulate({ hue: 25 }).png().toBuffer(), async (...args) => {
    await learning.feedback(user.id, lateLabel.id, { feedback: 'SELECTED', bagId: bag.id });
    const waiting = await sampleOf(lateLabel); assert.equal(waiting.featureState, 'WAITING_UPLOAD');
    await computeLearningSample(waiting.id); assert.equal(await prisma.learningSampleFeature.count({ where: { sampleId: waiting.id } }), 0);
    await putObject(...args);
  });
  assert.equal((await sampleOf(lateLabel)).state, 'PENDING'); assert.equal((await sampleOf(lateLabel)).featureState, 'QUEUED', 'late upload completion must not erase an already committed label');
  // Correction, review replacement with shared manual slots, and concurrent approvals.
  const alternateImage = await sharp(image).modulate({ hue: 80 }).png().toBuffer();
  const replacementScan = await job(); await captureLearningSample(replacementScan, alternateImage);
  await learning.feedback(user.id, replacementScan.id, { feedback: 'SELECTED', bagId: bag.id });
  const replacement = await sampleOf(replacementScan); await computeLearningSample(replacement.id);
  if (!realVisionUrl) assert.ok((await sampleOf(replacementScan)).possibleDuplicate, 'high similarity is flagged, not automatically discarded');
  await learning.review(admin.id, replacement.id, { action: 'CORRECT', bagId: bag.id });
  for (let i = 0; i < 4; i++) {
    const key = `${prefix}/admin-${i}.jpg`; objectKeys.push(key); await putObject(key, compressed, 'image/jpeg');
    const ref = await prisma.bagReferenceImage.create({ data: { officialBagId: bag.id, objectKey: key, contentType: 'image/jpeg' } });
    for (const f of computed.features) await prisma.scanEmbedding.create({ data: { officialBagId: bag.id, model: f.model, referenceKey: ref.id, sourceKind: 'ORIGINAL', sourceVersion: 1, vector: f.vector, colorVector: f.colorVector } });
  }
  await assert.rejects(learning.review(admin.id, replacement.id, { action: 'APPROVE' }), eligible);
  const oldRef = (await prisma.learningSample.findUniqueOrThrow({ where: { id: sample.id } })).referenceId;
  const concurrent = await Promise.allSettled([1, 2].map(() => learning.review(admin.id, replacement.id, { action: 'APPROVE', replaceReferenceId: oldRef })));
  assert.equal(concurrent.filter(r => r.status === 'fulfilled').length, 1); assert.equal(await prisma.bagReferenceImage.count({ where: { officialBagId: bag.id } }), 5);
  assert.equal((await prisma.learningSample.findUniqueOrThrow({ where: { id: sample.id } })).state, 'REPLACED');
  await assert.rejects(learning.review(admin.id, sample.id, { action: 'RESTORE' }), eligible);
  const replacedRef = (await sampleOf(replacementScan)).referenceId;
  await learning.review(admin.id, sample.id, { action: 'RESTORE', replaceReferenceId: replacedRef });
  assert.equal(await prisma.bagReferenceImage.count({ where: { officialBagId: bag.id } }), 5);
  const manualRef = await prisma.bagReferenceImage.findFirst({ where: { officialBagId: bag.id, objectKey: `${prefix}/admin-0.jpg` } });
  await scans.removeReference(admin.id, bag.id, manualRef.id);
  const archived = await prisma.learningSample.findUniqueOrThrow({ where: { objectKey: manualRef.objectKey } }); extraSampleIds.push(archived.id);
  assert.equal(archived.origin, 'ADMIN_ARCHIVE'); assert.equal(archived.byteSize, 0n, 'legacy admin images excluded from sample budget');
  await learning.review(admin.id, archived.id, { action: 'RESTORE' });
  assert.equal(await prisma.bagReferenceImage.count({ where: { officialBagId: bag.id } }), 5);
  await assert.rejects(learning.review(admin.id, replacement.id, { action: 'CORRECT', bagId: offline.id }), eligible);
  await prisma.officialBag.update({ where: { id: offline.id }, data: { status: 'PUBLISHED' } });
  await learning.review(admin.id, replacement.id, { action: 'CORRECT', bagId: offline.id });
  assert.equal((await sampleOf(replacementScan)).state, 'PENDING'); assert.equal((await sampleOf(replacementScan)).officialBagId, offline.id);
  await learning.review(admin.id, replacement.id, { action: 'APPROVE' });
  await learning.review(admin.id, replacement.id, { action: 'WITHDRAW' });
  await learning.review(admin.id, replacement.id, { action: 'CORRECT', bagId: bag.id });
  assert.equal(await prisma.bagReferenceImage.count({ where: { officialBagId: offline.id } }), 0, 'withdraw/correct cannot leave a wrong reference active');
  // Atomic reservation: concurrent captures never oversubscribe. No count-based quotas.
  const used = (await learning.settings()).usedBytes;
  await config(used + compressed.length);
  const capacityJobs = await Promise.all(Array.from({ length: 8 }, () => job()));
  await Promise.all(capacityJobs.map(s => captureLearningSample(s, image)));
  assert.ok((await learning.settings()).usedBytes <= used + compressed.length);
  const unmarked = await prisma.learningSample.findMany({ where: { scanId: { in: capacityJobs.map(s => s.id) }, state: 'STAGED' } });
  assert.ok(unmarked.reduce((sum, row) => sum + Number(row.byteSize), 0) <= used + compressed.length, 'new objects remain within byte budget after oldest staging eviction');
  await config(0);
  const noSpace = await job(); await captureLearningSample(noSpace, image);
  const labelOnly = await learning.feedback(user.id, noSpace.id, { feedback: 'SELECTED', bagId: bag.id });
  assert.equal(labelOnly.success, true); assert.equal(labelOnly.skipReason, 'CAPACITY_FULL');
  assert.equal((await prisma.matchScan.findUniqueOrThrow({ where: { id: noSpace.id } })).selectedBagId, bag.id);
  // Upload interruption / delete failure retains charged capacity, then recovers without orphan keys.
  await config(1024 ** 3);
  const failScan = await job();
  const uploadFailure = await job();
  await captureLearningSample(uploadFailure, image, async (...args) => { await putObject(...args); throw new Error('connection lost after upload'); });
  const uncertainUpload = await sampleOf(uploadFailure); assert.equal(uncertainUpload.state, 'FAILED'); assert.ok(uncertainUpload.byteSize > 0n);
  await cleanupLearningSamples(); assert.equal((await sampleOf(uploadFailure)).byteSize, 0n); await assert.rejects(getObject(uncertainUpload.objectKey));
  await mkdir(resolve(process.env.LOCAL_STORAGE_PATH, 'learning-samples'), { recursive: true });
  // A persisted interrupted reservation survives worker restart.
  const interruptedKey = `learning-samples/${prefix}-interrupted/image.jpg`; objectKeys.push(interruptedKey);
  await putObject(interruptedKey, compressed, 'image/jpeg');
  const interrupted = await prisma.learningSample.create({ data: { scanId: failScan.id, userId: user.id, source: 'camera', model: DINO_SCAN_MODEL, snapshot: {},
    objectKey: interruptedKey, byteSize: BigInt(compressed.length), state: 'STAGING', updatedAt: new Date(Date.now() - 700_000) } });
  await cleanupLearningSamples(); const deleted = await sampleOf(failScan); assert.equal(deleted.state, 'DELETED'); assert.equal(deleted.byteSize, 0n);
  await assert.rejects(getObject(interrupted.objectKey));
  const failureKey = `learning-samples/${prefix}-delete-failure/image.jpg`; objectKeys.push(failureKey);
  await mkdir(resolve(process.env.LOCAL_STORAGE_PATH, failureKey), { recursive: true });
  const deleteFailure = await prisma.learningSample.create({ data: { source: 'camera', model: DINO_SCAN_MODEL, snapshot: {}, objectKey: failureKey,
    byteSize: 100n, state: 'REJECTED', expiresAt: new Date(Date.now() - 1) } }); extraSampleIds.push(deleteFailure.id);
  assert.equal(await deleteLearningSample(deleteFailure.id), false);
  assert.equal((await prisma.learningSample.findUniqueOrThrow({ where: { id: deleteFailure.id } })).byteSize, 100n);
  await rm(resolve(process.env.LOCAL_STORAGE_PATH, failureKey), { recursive: true });
  await cleanupLearningSamples(); assert.equal((await prisma.learningSample.findUniqueOrThrow({ where: { id: deleteFailure.id } })).byteSize, 0n);
  await prisma.learningSample.update({ where: { id: replacement.id }, data: { expiresAt: new Date(Date.now() - 1) } });
  await assert.rejects(learning.review(admin.id, replacement.id, { action: 'RESTORE' }), eligible);
  await cleanupLearningSamples(); assert.equal((await sampleOf(replacementScan)).state, 'DELETED');
  assert.equal((await prisma.learningSample.findUniqueOrThrow({ where: { id: sample.id } })).state, 'APPROVED');
  await config(1024 ** 3, false);
  const disabled = await job(); await captureLearningSample(disabled, image); assert.equal((await sampleOf(disabled)).reason, 'COLLECTION_DISABLED');
  const blank = await job(); await config(1024 ** 3); await captureLearningSample(blank, await sharp({ create: { width: 200, height: 200, channels: 3, background: 'white' } }).png().toBuffer());
  assert.equal((await sampleOf(blank)).reason, 'INVALID_SAMPLE');
  const diagnostic = await learning.list(1); assert.ok(diagnostic.total); assert.ok(JSON.stringify(diagnostic));
  assert.ok(await prisma.auditLog.count({ where: { adminId: admin.id, action: 'LEARNING_APPROVE' } }));
  // Persisted work survives a missed Redis submission and is picked up on worker startup.
  const recoveryScan = await job();
  await captureLearningSample(recoveryScan, await sharp(image).modulate({ hue: 180 }).png().toBuffer());
  await learning.feedback(user.id, recoveryScan.id, { feedback: 'SELECTED', bagId: bag.id });
  const recovering = await sampleOf(recoveryScan);
  assert.equal(recovering.featureState, 'QUEUED');
  let workerOutput = '';
  worker = spawn(process.execPath, ['apps/worker/dist/scan-main.js'], { env: { ...process.env, NODE_ENV: 'test' }, stdio: ['ignore', 'pipe', 'pipe'] });
  worker.stdout.on('data', d => { workerOutput += d; }); worker.stderr.on('data', d => { workerOutput += d; });
  let ready = false;
  for (let i = 0; i < 80; i++) {
    if (worker.exitCode !== null) throw new Error(workerOutput);
    const row = await sampleOf(recoveryScan);
    if (row.featureState === 'READY') { ready = true; break; }
    await delay(250);
  }
  assert.ok(ready, `queue recovery failed: ${workerOutput}`);
  assert.equal((await sampleOf(recoveryScan)).state, 'PENDING', 'queued feature completion alone cannot approve a reference');
  console.log(`Learning integration passed: labels, ownership, independent JPEG, model recovery, review lifecycle, shared slots, capacity races, retention and cleanup recovery. Inference: ${realVisionUrl ? 'real DINO' : 'deterministic stub'}; production performance/accuracy remain unmeasured.`);
} finally {
  if (worker) { worker.kill(); await Promise.race([new Promise(resolve => worker.once('exit', resolve)), delay(3000)]); }
  const samples = await prisma.learningSample.findMany({ where: { OR: [{ userId: { in: [user?.id, other?.id].filter(Boolean) } }, { id: { in: extraSampleIds } }] } });
  await prisma.learningSample.deleteMany({ where: { id: { in: samples.map(s => s.id) } } });
  await prisma.officialBag.deleteMany({ where: { id: { in: [bag?.id, offline?.id].filter(Boolean) } } });
  await prisma.user.deleteMany({ where: { id: { in: [user?.id, other?.id].filter(Boolean) } } });
  if (admin) { await prisma.auditLog.deleteMany({ where: { adminId: admin.id } }); await prisma.admin.delete({ where: { id: admin.id } }); }
  await deleteObjects([...new Set([...objectKeys, ...samples.flatMap(s => s.objectKey ? [s.objectKey] : [])])]);
  if (originalSettings) await prisma.appSetting.upsert({ where: { key: originalSettings.key }, create: originalSettings, update: { value: originalSettings.value } });
  else await prisma.appSetting.deleteMany({ where: { key: 'learning.settings' } });
  await scanPrisma.$disconnect(); await prisma.$disconnect(); await new Promise(resolve => vision.close(resolve));
}
