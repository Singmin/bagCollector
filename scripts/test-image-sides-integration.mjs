import './test-env.mjs';
import 'reflect-metadata';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { PrismaClient } from '@prisma/client';
import { Queue } from 'bullmq';
import { Redis } from 'ioredis';
import sharp from 'sharp';

// Deliberately restricted to the disposable test services, never the project's .env.
const database = process.env.DATABASE_URL ?? 'postgresql://bagcollect:bagcollect_test@127.0.0.1:5433/bagcollect_test';
const db = new URL(database);
if (!['127.0.0.1', 'localhost'].includes(db.hostname) || !['5432', '5433'].includes(db.port) || db.pathname !== '/bagcollect_test') throw new Error('Use an isolated localhost bagcollect_test database');
const redisUrl = process.env.IMAGE_SIDES_TEST_REDIS_URL ?? 'redis://127.0.0.1:6380';
if (!['127.0.0.1', 'localhost'].includes(new URL(redisUrl).hostname)) throw new Error('Use isolated local test Redis');
const port = 3117;
const origin = `http://127.0.0.1:${port}/api`;
const storage = resolve('data/test-image-sides-storage');
const env = { ...process.env, DATABASE_URL: database, REDIS_URL: redisUrl, NODE_ENV: 'test', API_PORT: String(port),
  API_PUBLIC_URL: `http://127.0.0.1:${port}`, JWT_SECRET: 'image-sides-isolated-integration-test-secret',
  WECHAT_AUTH_MOCK: 'true', STORAGE_DRIVER: 'local', LOCAL_STORAGE_PATH: storage,
  COS_SECRET_ID: '', COS_SECRET_KEY: '', COS_BUCKET: '', RECONCILE_INTERVAL_MS: '600000' };
const prisma = new PrismaClient({ datasourceUrl: database });
const redis = new Redis(redisUrl, { maxRetriesPerRequest: null });
const queue = new Queue('bagcollect-images', { connection: redis });
const processes = [];
let logs = '';
let token = ''; let adminToken = ''; let userId; let adminId; let officialId; let promotedId;
function start(file) {
  const child = spawn(process.execPath, [file], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  child.stdout.on('data', chunk => { logs = (logs + chunk).slice(-24000); });
  child.stderr.on('data', chunk => { logs = (logs + chunk).slice(-24000); });
  processes.push(child); return child;
}
async function request(path, { admin = false, status, ...init } = {}) {
  const auth = admin ? adminToken : token;
  const response = await fetch(`${origin}${path}`, { ...init, headers: {
    ...(auth ? { Authorization: `Bearer ${auth}` } : {}),
    ...(init.body && !(init.body instanceof FormData) ? { 'content-type': 'application/json' } : {})
  } });
  const body = await response.json();
  assert.equal(response.status, status ?? (path === '/auth/wechat/login' ? 200 : init.method === 'POST' ? 201 : 200), `${path}: ${JSON.stringify(body.error ?? { message: 'unexpected HTTP status' })}`);
  return body;
}
const imageKey = url => JSON.parse(Buffer.from(new URL(url).searchParams.get('token').split('.')[0], 'base64url')).key;
const post = (path, body, options = {}) => request(path, { method: 'POST', body: JSON.stringify(body), ...options });
async function wait(side, id, status, official = false) {
  for (let i = 0; i < 100; i++) {
    const item = await request(official ? `/admin/official-bags/${id}` : `/collectibles/${id}`, { admin: official });
    if (item.sides?.[side]?.processingStatus === status) return item;
    if (item.sides?.[side]?.processingStatus === 'FAILED' && status !== 'FAILED') throw new Error(`${side}: ${item.sides[side].processingError}`);
    await delay(150);
  }
  throw new Error(`Timed out: ${side} ${status}\n${logs}`);
}
const picture = await sharp({ create: { width: 96, height: 128, channels: 3, background: '#d7c8a2' } }).png().toBuffer();
async function upload(id, side, body = picture) {
  const policy = await post('/uploads/policy', { collectibleId: id, side, fileName: 'bag.png', contentType: 'image/png', size: body.length });
  const form = new FormData(); form.append('file', new Blob([body], { type: 'image/png' }), 'bag.png');
  await request(`/uploads/local/${policy.assetId}`, { method: 'POST', body: form });
  await post('/uploads/complete', { assetId: policy.assetId, collectibleId: id, key: policy.key });
  return policy;
}
async function officialUpload(side) {
  const form = new FormData(); form.append('file', new Blob([picture], { type: 'image/png' }), 'official.png');
  await request(`/admin/official-bags/${officialId}/image?side=${side}&matting=false`, { admin: true, method: 'POST', body: form });
  return wait(side, officialId, 'READY', true);
}
try {
  const apiChild = start('apps/api/dist/main.js');
  start('apps/worker/dist/main.js');
  for (let i = 0; i < 240; i++) {
    try { await request('/health/ready'); break; } catch { if (i === 239 || apiChild.exitCode !== null) throw new Error(`API exit=${apiChild.exitCode}\n${logs}`); await delay(250); }
  }
  const suffix = `sides-${Date.now()}`;
  const tokens = await post('/auth/wechat/login', { code: suffix }); token = tokens.accessToken;
  userId = JSON.parse(Buffer.from(token.split('.')[1], 'base64url')).sub;
  const shelf = await post('/shelves', { name: suffix, theme: 'SAGE' });
  const bag = await post('/collectibles', { name: '双面测试', shelfId: shelf.id });
  await upload(bag.id, 'FRONT'); await wait('FRONT', bag.id, 'AWAITING_CROP');
  const crop = { x: 0, y: 0, width: 1, height: 1, rotation: 0 };
  await post(`/collectibles/${bag.id}/crop`, crop); const front = await wait('FRONT', bag.id, 'READY');
  assert.ok(front.displayImageUrl.includes('/api/assets/'));
  await upload(bag.id, 'BACK'); await wait('BACK', bag.id, 'AWAITING_CROP');
  await post(`/collectibles/${bag.id}/crop`, { ...crop, side: 'BACK', rotation: 90, brightness: 1.1 });
  const both = await wait('BACK', bag.id, 'READY');
  assert.equal(imageKey(both.displayImageUrl), imageKey(front.displayImageUrl));
  assert.equal(both.sides.FRONT.crop.rotation, 0); assert.equal(both.sides.BACK.crop.rotation, 90);
  const list = await request('/collectibles');
  assert.equal(list.items.find(item => item.id === bag.id).imageRevision, both.imageRevision);

  await upload(bag.id, 'BACK', Buffer.from('broken image'));
  const failed = await wait('BACK', bag.id, 'FAILED');
  assert.equal(failed.processingStatus, 'READY');
  assert.equal(imageKey(failed.sides.BACK.displayImageUrl), imageKey(both.sides.BACK.displayImageUrl));
  await upload(bag.id, 'BACK'); await wait('BACK', bag.id, 'AWAITING_CROP');
  await post(`/collectibles/${bag.id}/crop`, { ...crop, side: 'BACK' }); await wait('BACK', bag.id, 'READY');

  await queue.pause();
  const obsolete = await post(`/collectibles/${bag.id}/crop`, { ...crop, side: 'BACK' });
  await request(`/collectibles/${bag.id}/images/BACK`, { method: 'DELETE' });
  await queue.resume();
  for (let i = 0; i < 100; i++) {
    const job = await prisma.processingJob.findUnique({ where: { id: obsolete.jobId } });
    if (job.status === 'FAILED' || job.status === 'SUCCEEDED') break;
    await delay(100);
  }
  assert.equal(await prisma.imageAsset.count({ where: { collectibleId: bag.id, side: 'BACK' } }), 0);
  assert.equal((await request(`/collectibles/${bag.id}`)).sides.BACK, undefined);

  const { hashPassword } = await import('../apps/api/dist/common/crypto.js');
  const password = `test-${suffix}`;
  const admin = await prisma.admin.create({ data: { username: suffix, passwordHash: await hashPassword(password) } }); adminId = admin.id;
  adminToken = (await post('/admin/login', { username: suffix, password })).accessToken;
  await upload(bag.id, 'BACK'); await wait('BACK', bag.id, 'AWAITING_CROP');
  await post(`/collectibles/${bag.id}/crop`, { ...crop, side: 'BACK' }); await wait('BACK', bag.id, 'READY');
  const promoted = await post(`/admin/submissions/${bag.id}/promote`, { name: '双面审核纳入测试' }, { admin: true }); promotedId = promoted.officialBagId;
  assert.equal(await prisma.officialBagImageSide.count({ where: { officialBagId: promotedId, publishedVersion: 1 } }), 2);
  assert.equal((await request(`/collectibles/${bag.id}`)).imageEditable, true);
  const originalBytes = (await prisma.imageAsset.aggregate({ where: { userId, status: 'AVAILABLE' }, _sum: { byteSize: true } }))._sum.byteSize ?? 0n;
  assert.equal((await prisma.user.findUniqueOrThrow({ where: { id: userId } })).storageUsedBytes, originalBytes);
  const official = await post('/admin/official-bags', { name: suffix, matting: false }, { admin: true }); officialId = official.id;
  await officialUpload('FRONT');
  await request(`/admin/official-bags/${officialId}`, { admin: true, method: 'PATCH', body: JSON.stringify({ status: 'PUBLISHED' }) });
  const claim = await post(`/official-bags/${officialId}/claim`, {});
  const claimedBefore = await request(`/collectibles/${claim.collectibleId}`);
  assert.equal(claimedBefore.imageEditable, false); assert.equal(claimedBefore.sourceOfficialBagId, officialId);
  await officialUpload('BACK');
  const claimedAfter = await request(`/collectibles/${claim.collectibleId}`);
  assert.ok(claimedAfter.sides.BACK.displayImageUrl); assert.notEqual(claimedAfter.imageRevision, claimedBefore.imageRevision);
  assert.equal(await prisma.imageAsset.count({ where: { collectibleId: claim.collectibleId } }), 0);
  for (const side of ['FRONT', 'BACK']) {
    await post('/uploads/policy', { collectibleId: claim.collectibleId, side, fileName: 'bag.png', contentType: 'image/png', size: picture.length }, { status: 403 });
    await post(`/collectibles/${claim.collectibleId}/crop`, { ...crop, side }, { status: 403 });
    await post(`/collectibles/${claim.collectibleId}/matte`, { side }, { status: 403 });
  }
  await request(`/collectibles/${claim.collectibleId}/images/BACK`, { method: 'DELETE', status: 403 });
  await request(`/collectibles/${claim.collectibleId}`, { method: 'PUT', body: JSON.stringify({ quantity: 2, notes: '私人备注' }) });
  await officialUpload('FRONT');
  const refreshed = await request(`/collectibles/${claim.collectibleId}`);
  assert.notEqual(imageKey(refreshed.displayImageUrl), imageKey(claimedAfter.displayImageUrl));
  assert.equal(refreshed.notes, '私人备注'); assert.equal(refreshed.quantity, 2);
  await request(`/admin/official-bags/${officialId}/image?side=FRONT`, { admin: true, method: 'DELETE', status: 409 });
  await request(`/admin/official-bags/${officialId}/image?side=BACK`, { admin: true, method: 'DELETE' });
  assert.equal((await request(`/collectibles/${claim.collectibleId}`)).sides.BACK, undefined);
  console.log('PASS: real A/B upload/crop, source isolation, failed replacement, stale deletion, official sync, image permissions personal metadata, quota accounting and A/B promotion');
} finally {
  await queue.resume();
  for (const process of processes) { if (process.exitCode === null) { const exited = once(process, 'exit'); process.kill(); await exited; } }
  if (userId) { await prisma.officialClaim.deleteMany({ where: { userId } }); await prisma.user.deleteMany({ where: { id: userId } }); }
  if (officialId) await prisma.officialBag.deleteMany({ where: { id: officialId } });
  if (promotedId) await prisma.officialBag.deleteMany({ where: { id: promotedId } });
  if (adminId) await prisma.admin.deleteMany({ where: { id: adminId } });
  await queue.close(); await redis.quit(); await prisma.$disconnect();
}
