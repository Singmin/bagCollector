import { spawn } from 'node:child_process';
import { rm } from 'node:fs/promises';
import { resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { AssetKind, AssetStatus, PrismaClient } from '@prisma/client';
import { UploadsService } from '../apps/api/dist/uploads/uploads.service.js';
import { upsertAssetRecord } from '../apps/worker/dist/asset-record.js';

const port = 3101;
const origin = `http://127.0.0.1:${port}/api`;
const localStoragePath = 'data/test-integration-storage';
const prisma = new PrismaClient();
const server = spawn(process.execPath, ['apps/api/dist/main.js'], {
  env: {
    ...process.env,
    NODE_ENV: 'test',
    API_PORT: String(port),
    API_PUBLIC_URL: `http://127.0.0.1:${port}`,
    WECHAT_AUTH_MOCK: 'true',
    STORAGE_DRIVER: 'local',
    LOCAL_STORAGE_PATH: localStoragePath
  },
  stdio: ['ignore', 'pipe', 'pipe']
});

let output = '';
server.stdout.on('data', (chunk) => { output += chunk.toString(); });
server.stderr.on('data', (chunk) => { output += chunk.toString(); });

async function request(path, init = {}, expected = 200) {
  const response = await fetch(`${origin}${path}`, {
    ...init,
    headers: { ...(init.body !== undefined ? { 'content-type': 'application/json' } : {}), ...(init.headers || {}) }
  });
  const body = await response.json().catch(() => null);
  if (response.status !== expected) {
    throw new Error(`${init.method || 'GET'} ${path}: expected ${expected}, got ${response.status}\n${JSON.stringify(body)}`);
  }
  return body;
}

async function waitUntilReady() {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    try {
      await request('/health/ready');
      return;
    } catch {
      if (server.exitCode !== null) throw new Error(`API exited early (${server.exitCode})\n${output}`);
      await delay(250);
    }
  }
  throw new Error(`API did not become ready\n${output}`);
}

function bearer(token) {
  return { Authorization: `Bearer ${token}` };
}

try {
  await waitUntilReady();
  const suffix = `${Date.now()}-${Math.random()}`;
  const userA = await request('/auth/wechat/login', {
    method: 'POST', body: JSON.stringify({ code: `integration-a-${suffix}` })
  });
  const shelves = await request('/shelves', { headers: bearer(userA.accessToken) });
  if (shelves.length !== 0) throw new Error('First login unexpectedly created a shelf');
  await request('/collectibles', {
    method: 'POST', headers: bearer(userA.accessToken), body: JSON.stringify({})
  }, 400);

  const shelf = await request('/shelves', {
    method: 'POST', headers: bearer(userA.accessToken), body: JSON.stringify({ name: '集成测试架', theme: 'SKY' })
  }, 201);
  const collectible = await request('/collectibles', {
    method: 'POST', headers: bearer(userA.accessToken), body: JSON.stringify({ name: '隔离测试', shelfId: shelf.id })
  }, 201);

  const userB = await request('/auth/wechat/login', {
    method: 'POST', body: JSON.stringify({ code: `integration-b-${suffix}` })
  });
  const userBShelves = await request('/shelves', { headers: bearer(userB.accessToken) });
  if (userBShelves.length !== 0) throw new Error('Second user unexpectedly received a shelf');
  const userBShelf = await request('/shelves', {
    method: 'POST', headers: bearer(userB.accessToken), body: JSON.stringify({ name: '用户 B 展示架', theme: 'ROSE' })
  }, 201);
  await request(`/collectibles/${collectible.id}`, { headers: bearer(userB.accessToken) }, 404);
  const userBItems = await request('/collectibles', { headers: bearer(userB.accessToken) });
  if (userBItems.items.length !== 0) throw new Error('User isolation failed');
  if (userBItems.totalCount !== 0) throw new Error('Empty collectible total is incorrect');
  await request('/collectibles', {
    method: 'POST',
    headers: bearer(userA.accessToken),
    body: JSON.stringify({ name: '跨用户展示架', shelfId: userBShelf.id })
  }, 404);

  const userBCollectible = await request('/collectibles', {
    method: 'POST',
    headers: bearer(userB.accessToken),
    body: JSON.stringify({ name: '标签隔离测试', shelfId: userBShelf.id })
  }, 201);
  await request(`/collectibles/${collectible.id}`, {
    method: 'PATCH', headers: bearer(userA.accessToken), body: JSON.stringify({ tags: ['Travel'] })
  });
  await request(`/collectibles/${userBCollectible.id}`, {
    method: 'PATCH', headers: bearer(userB.accessToken), body: JSON.stringify({ tags: ['TRAVEL'] })
  });
  const taggedA = await request(`/collectibles/${collectible.id}`, { headers: bearer(userA.accessToken) });
  const taggedB = await request(`/collectibles/${userBCollectible.id}`, { headers: bearer(userB.accessToken) });
  if (taggedA.tags[0] !== 'Travel' || taggedB.tags[0] !== 'TRAVEL') {
    throw new Error('Tags are not isolated per user');
  }

  const shelfARecord = await prisma.shelf.findUniqueOrThrow({ where: { id: shelf.id } });
  let crossTenantConstraintHeld = false;
  try {
    await prisma.collectible.create({
      data: { userId: shelfARecord.userId, shelfId: userBShelf.id, name: '数据库跨租户测试' }
    });
  } catch (error) {
    crossTenantConstraintHeld = error?.code === 'P2003';
  }
  await request(`/shelves/${shelf.id}`, { method: 'DELETE', headers: bearer(userA.accessToken) }, 409);
  if (!crossTenantConstraintHeld) throw new Error('Database did not reject a cross-user shelf relation');

  const reserved = await request('/collectibles', {
    method: 'POST', headers: bearer(userA.accessToken), body: JSON.stringify({ name: '预留上传删除测试', shelfId: shelf.id })
  }, 201);
  await prisma.imageAsset.create({
    data: {
      userId: shelfARecord.userId,
      collectibleId: reserved.id,
      kind: AssetKind.ORIGINAL,
      status: AssetStatus.RESERVED,
      objectKey: `integration/${reserved.id}/reserved.jpg`,
      contentType: 'image/jpeg',
      declaredByteSize: 1024n,
      byteSize: 0n,
      version: 1
    }
  });
  await request(`/collectibles/${reserved.id}`, { method: 'DELETE', headers: bearer(userA.accessToken) });
  const accountAfterReservedDelete = await request('/account', { headers: bearer(userA.accessToken) });
  if (accountAfterReservedDelete.storageUsedBytes !== 0) {
    throw new Error('Deleting a reserved upload changed accounted storage');
  }

  const localUploadCollectible = await request('/collectibles', {
    method: 'POST', headers: bearer(userA.accessToken), body: JSON.stringify({ name: '本地上传测试', shelfId: shelf.id })
  }, 201);
  const localPolicy = await request('/uploads/policy', {
    method: 'POST',
    headers: bearer(userA.accessToken),
    body: JSON.stringify({
      collectibleId: localUploadCollectible.id,
      fileName: 'tiny.jpg',
      contentType: 'image/jpeg',
      size: 4
    })
  }, 201);
  const form = new FormData();
  form.append('file', new Blob([new Uint8Array([0xff, 0xd8, 0xff, 0xd9])], { type: 'image/jpeg' }), 'tiny.jpg');
  const localUploadResponse = await fetch(localPolicy.uploadUrl, {
    method: 'POST', headers: bearer(userA.accessToken), body: form
  });
  if (!localUploadResponse.ok) throw new Error(`Local upload failed with ${localUploadResponse.status}`);
  const localComplete = await request('/uploads/complete', {
    method: 'POST',
    headers: bearer(userA.accessToken),
    body: JSON.stringify({
      assetId: localPolicy.assetId,
      collectibleId: localUploadCollectible.id,
      key: localPolicy.key
    })
  }, 201);
  if (localComplete.processingStatus !== 'NORMALIZING') throw new Error('Local upload did not enter normalization');
  await request(`/collectibles/${localUploadCollectible.id}`, {
    method: 'DELETE', headers: bearer(userA.accessToken)
  });

  const concurrent = await request('/collectibles', {
    method: 'POST', headers: bearer(userA.accessToken), body: JSON.stringify({ name: '并发完成测试', shelfId: shelf.id })
  }, 201);
  const concurrentAsset = await prisma.imageAsset.create({
    data: {
      userId: shelfARecord.userId,
      collectibleId: concurrent.id,
      kind: AssetKind.ORIGINAL,
      status: AssetStatus.RESERVED,
      objectKey: `integration/${concurrent.id}/concurrent.jpg`,
      contentType: 'image/jpeg',
      declaredByteSize: 100n,
      byteSize: 0n,
      version: 1
    }
  });
  let queuedJobs = 0;
  const uploads = new UploadsService(
    prisma,
    { headObject: async () => ({ contentLength: 100, contentType: 'image/jpeg' }) },
    { add: async () => { queuedJobs += 1; } }
  );
  const completionInput = {
    assetId: concurrentAsset.id,
    collectibleId: concurrent.id,
    key: concurrentAsset.objectKey
  };
  const completed = await Promise.all([
    uploads.complete(shelfARecord.userId, completionInput),
    uploads.complete(shelfARecord.userId, completionInput)
  ]);
  const accountAfterConcurrentComplete = await request('/account', { headers: bearer(userA.accessToken) });
  if (
    accountAfterConcurrentComplete.storageUsedBytes !== 100 ||
    completed[0].jobId !== completed[1].jobId ||
    queuedJobs !== 1
  ) {
    throw new Error('Concurrent upload completion was not idempotent');
  }
  await request(`/collectibles/${concurrent.id}`, { method: 'DELETE', headers: bearer(userA.accessToken) });

  const derived = await request('/collectibles', {
    method: 'POST', headers: bearer(userA.accessToken), body: JSON.stringify({ name: '派生图片幂等测试', shelfId: shelf.id })
  }, 201);
  const derivedKey = `integration/${derived.id}/display.png`;
  const derivedInput = {
    userId: shelfARecord.userId,
    collectibleId: derived.id,
    kind: AssetKind.DISPLAY,
    key: derivedKey,
    contentType: 'image/png',
    byteSize: 100,
    width: 10,
    height: 10,
    version: 1
  };
  const storageBeforeDerived = (await prisma.user.findUniqueOrThrow({ where: { id: shelfARecord.userId } })).storageUsedBytes;
  await Promise.all([
    upsertAssetRecord(prisma, derivedInput),
    upsertAssetRecord(prisma, derivedInput)
  ]);
  const [storageAfterDerived, derivedAssets] = await Promise.all([
    prisma.user.findUniqueOrThrow({ where: { id: shelfARecord.userId } }),
    prisma.imageAsset.count({ where: { objectKey: derivedKey } })
  ]);
  if (storageAfterDerived.storageUsedBytes - storageBeforeDerived !== 100n || derivedAssets !== 1) {
    throw new Error('Concurrent derived asset accounting was not idempotent');
  }
  await request(`/collectibles/${derived.id}`, { method: 'DELETE', headers: bearer(userA.accessToken) });

  const failedCollectible = await request('/collectibles', {
    method: 'POST', headers: bearer(userA.accessToken), body: JSON.stringify({ name: '失败任务测试', shelfId: shelf.id })
  }, 201);
  await prisma.collectible.update({
    where: { id: failedCollectible.id },
    data: { processingStatus: 'FAILED', processingError: '万象抠图请求失败（403）' }
  });
  await request(`/collectibles/${failedCollectible.id}/keep-crop`, { method: 'POST', headers: bearer(userA.accessToken) }, 404);
  await request(`/collectibles/${failedCollectible.id}/retry`, { method: 'POST', headers: bearer(userA.accessToken) }, 404);
  const visibleItems = await request('/collectibles', { headers: bearer(userA.accessToken) });
  if (visibleItems.items.some((item) => item.id === failedCollectible.id)) throw new Error('Failed collectible leaked into the ready list');
  if (visibleItems.totalCount !== visibleItems.items.length) throw new Error('Ready collectible total is incorrect');
  await request(`/collectibles/${failedCollectible.id}`, { method: 'DELETE', headers: bearer(userA.accessToken) });

  const userBRecord = await prisma.shelf.findUniqueOrThrow({ where: { id: userBShelf.id } });
  await request('/account', { method: 'DELETE', headers: bearer(userB.accessToken) });
  if (await prisma.user.findUnique({ where: { id: userBRecord.userId } })) {
    throw new Error('Account deletion did not cascade through tenant-owned records');
  }

  const rotated = await request('/auth/refresh', {
    method: 'POST', body: JSON.stringify({ refreshToken: userA.refreshToken })
  });
  await request('/auth/refresh', {
    method: 'POST', body: JSON.stringify({ refreshToken: userA.refreshToken })
  }, 401);
  await request('/auth/logout', {
    method: 'POST', body: JSON.stringify({ refreshToken: rotated.refreshToken })
  });
  await request('/auth/refresh', {
    method: 'POST', body: JSON.stringify({ refreshToken: rotated.refreshToken })
  }, 401);
  console.log(
    'API integration: explicit creation, tenant constraints, scoped tags, idempotent accounting, terminal failures, and account cascade passed'
  );
} finally {
  server.kill('SIGTERM');
  await Promise.race([new Promise((resolve) => server.once('exit', resolve)), delay(5_000)]);
  await prisma.$disconnect();
  await rm(resolve(process.cwd(), localStoragePath), { recursive: true, force: true });
}
