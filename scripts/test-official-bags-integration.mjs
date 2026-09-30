import './test-env.mjs';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { AssetKind, AssetStatus, OfficialProcessStatus, PrismaClient } from '@prisma/client';
import sharp from 'sharp';
import { hashPassword } from '../apps/api/dist/common/crypto.js';

// 官方袋子库集成测试：管理后台 CRUD / 图片上传 / 发布校验 / 发现页可见性 /
// 用户「拥有」（幂等、配额、归类、标签复制）/ 下架与删除保护。
// 与 test-api-integration.mjs 同一套路：真实拉起 API（本地存储 + 微信 mock），
// 全部走 HTTP 断言，数据库状态用 Prisma 直查。worker 在本地跑不了（强制 COS），
// 图片处理完成态由 simulateProcessing 落库模拟，队列任务只断言已入队不消费。

const port = 3102;
const origin = `http://127.0.0.1:${port}/api`;
const localStoragePath = 'data/test-official-storage';
const adminUsername = `integration-official-${Date.now()}`;
const adminPassword = 'integration-password-123';

const prisma = new PrismaClient();
const server = spawn(process.execPath, ['apps/api/dist/main.js'], {
  env: {
    ...process.env,
    NODE_ENV: process.env.DEBUG_API === 'true' ? 'development' : 'test',
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
    headers: {
      ...(init.body !== undefined && !(init.body instanceof FormData)
        ? { 'content-type': 'application/json' }
        : {}),
      ...(init.headers || {})
    }
  });
  const body = await response.json().catch(() => null);
  if (response.status !== expected) {
    throw new Error(`${init.method || 'GET'} ${path}: expected ${expected}, got ${response.status}\n${JSON.stringify(body)}`);
  }
  return body;
}

async function waitUntilReady() {
  // Windows 冷启动（杀软扫描、Prisma engine 首次解压）可能明显慢于 Linux，
  // 等待窗口放宽到 60 秒。
  for (let attempt = 0; attempt < 120; attempt += 1) {
    try {
      await request('/health/ready');
      return;
    } catch {
      if (server.exitCode !== null) throw new Error(`API exited early (${server.exitCode})\n${output}`);
      await delay(500);
    }
  }
  throw new Error(`API did not become ready\n${output}`);
}

function bearer(token) {
  return { Authorization: `Bearer ${token}` };
}

// 与 auth.service 的 mock 模式一致：openid = mock_ + sha256(code) 前 40 位。
function mockOpenid(code) {
  return `mock_${createHash('sha256').update(code).digest('hex').slice(0, 40)}`;
}

async function pngBytes(width, height) {
  return sharp({ create: { width, height, channels: 3, background: { r: 120, g: 90, b: 60 } } }).png().toBuffer();
}

/**
 * 模拟 worker 的 official-process 完成态：写 standard/display/thumbnail 三个对象
 * 与对应 OfficialBagImage 记录，并把袋子置 READY。文件真实落在本地存储，
 * 这样发现页返回的签名 URL 可以被 fetch 验证。
 */
async function simulateProcessing(bagId, version) {
  const baseKey = `official/${bagId}`;
  const root = resolve(process.cwd(), localStoragePath);
  const files = [
    { kind: AssetKind.STANDARD, extension: 'jpg', contentType: 'image/jpeg', buffer: await pngBytes(200, 200) },
    { kind: AssetKind.DISPLAY, extension: 'png', contentType: 'image/png', buffer: await pngBytes(160, 160) },
    { kind: AssetKind.THUMBNAIL, extension: 'webp', contentType: 'image/webp', buffer: await sharp(await pngBytes(80, 80)).webp().toBuffer() }
  ];
  for (const file of files) {
    const key = `${baseKey}/${file.kind.toLowerCase()}/v${version}.${file.extension}`;
    const path = resolve(root, key);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, file.buffer);
    await prisma.officialBagImage.upsert({
      where: { objectKey: key },
      create: {
        officialBagId: bagId,
        kind: file.kind,
        status: AssetStatus.AVAILABLE,
        objectKey: key,
        contentType: file.contentType,
        declaredByteSize: BigInt(file.buffer.length),
        byteSize: BigInt(file.buffer.length),
        width: 80,
        height: 80,
        version
      },
      update: { status: AssetStatus.AVAILABLE, byteSize: BigInt(file.buffer.length) }
    });
  }
  await prisma.officialBag.update({
    where: { id: bagId },
    data: { processStatus: OfficialProcessStatus.READY, processError: null }
  });
}

async function loginAdmin() {
  await prisma.admin.create({
    data: { username: adminUsername, passwordHash: await hashPassword(adminPassword) }
  });
  return request('/admin/login', {
    method: 'POST',
    body: JSON.stringify({ username: adminUsername, password: adminPassword })
  }, 201);
}

async function uploadImage(adminToken, bagId, expected = 201, buffer, matting) {
  const body = buffer ?? (await pngBytes(100, 100));
  const form = new FormData();
  form.append('file', new Blob([body], { type: 'image/png' }), 'bag.png');
  const query = matting === undefined ? '' : `?matting=${matting}`;
  return request(`/admin/official-bags/${bagId}/image${query}`, { method: 'POST', headers: bearer(adminToken), body: form }, expected);
}

try {
  await waitUntilReady();
  process.on('unhandledRejection', () => undefined);
  const suffix = `${Date.now()}-${Math.random()}`;

  // ---- 管理端鉴权 ----
  await request('/admin/official-bags', {}, 401);
  const userEarly = await request('/auth/wechat/login', {
    method: 'POST', body: JSON.stringify({ code: `official-early-${suffix}` })
  });
  await request('/admin/official-bags', { headers: bearer(userEarly.accessToken) }, 401);
  const admin = await loginAdmin();
  if (!admin.accessToken) throw new Error('Admin login did not return a token');

  // ---- 品牌管理 ----
  await request('/admin/brands', {}, 401);
  const brand = await request('/admin/brands', {
    method: 'POST',
    headers: bearer(admin.accessToken),
    body: JSON.stringify({ name: `TestBrand ${suffix}`, sortOrder: 0 })
  }, 201);
  if (!brand.id || brand.bagCount !== 0) throw new Error('Brand creation failed');
  const brandDuplicate = await request('/admin/brands', {
    method: 'POST',
    headers: bearer(admin.accessToken),
    body: JSON.stringify({ name: `testbrand ${suffix}` })
  }, 409);
  if (!brandDuplicate) throw new Error('Duplicate brand should be rejected');

  // ---- 创建与审计 ----
  const bag = await request('/admin/official-bags', {
    method: 'POST',
    headers: bearer(admin.accessToken),
    body: JSON.stringify({
      name: `集成测试袋 ${suffix}`,
      brandId: brand.id,
      notes: '集成测试备注',
      tags: ['手提袋', '牛皮纸'],
      matting: false
    })
  }, 201);
  if (bag.status !== 'DRAFT' || bag.processStatus !== 'PENDING') throw new Error('New bag did not start as DRAFT/PENDING');
  if (bag.brandId !== brand.id || bag.brand !== brand.name) throw new Error('Bag brand relation missing in DTO');
  await request('/admin/official-bags', {
    method: 'POST',
    headers: bearer(admin.accessToken),
    body: JSON.stringify({ name: '坏袋子', brandId: 'nonexistent-brand' })
  }, 400);
  const createAudits = await prisma.auditLog.count({
    where: { action: 'OFFICIAL_BAG_CREATE', targetId: bag.id }
  });
  if (createAudits !== 1) throw new Error('Bag creation was not audited');

  // ---- 发布校验：无图片不能发布 ----
  await request(`/admin/official-bags/${bag.id}`, {
    method: 'PATCH', headers: bearer(admin.accessToken), body: JSON.stringify({ status: 'PUBLISHED' })
  }, 409);

  // ---- 图片上传与替换 ----
  const uploaded = await uploadImage(admin.accessToken, bag.id);
  if (uploaded.version !== 1 || uploaded.processStatus !== 'PROCESSING') {
    throw new Error('First upload did not return version 1 / PROCESSING');
  }
  const originals = await prisma.officialBagImage.findMany({
    where: { officialBagId: bag.id, kind: AssetKind.ORIGINAL }
  });
  if (originals.length !== 1 || originals[0].byteSize === 0n) {
    throw new Error('Original image record missing or empty');
  }
  const replaced = await uploadImage(admin.accessToken, bag.id, 201, Buffer.from(await pngBytes(120, 120)));
  if (replaced.version !== 2) throw new Error('Image replacement did not bump the version');
  const bagRecord = await prisma.officialBag.findUniqueOrThrow({ where: { id: bag.id } });
  if (bagRecord.version !== 2 || bagRecord.matting !== false) {
    throw new Error('Bag version/matting state is incorrect after re-upload');
  }

  // ---- 处理完成（模拟 worker）后发布 ----
  await simulateProcessing(bag.id, 2);
  const published = await request(`/admin/official-bags/${bag.id}`, {
    method: 'PATCH', headers: bearer(admin.accessToken), body: JSON.stringify({ status: 'PUBLISHED' })
  });
  if (published.status !== 'PUBLISHED' || !published.publishedAt) throw new Error('Publish did not set status/publishedAt');

  // ---- 用户发现页 ----
  const userA = await request('/auth/wechat/login', {
    method: 'POST', body: JSON.stringify({ code: `official-a-${suffix}` })
  });
  await request('/official-bags', {}, 401);
  const discover = await request('/official-bags', { headers: bearer(userA.accessToken) });
  const listed = discover.items.find((item) => item.id === bag.id);
  if (!listed) throw new Error('Published bag missing from the discover list');
  if (listed.claimed !== false || listed.thumbnailUrl === undefined) {
    throw new Error('Discover list missing claimed flag or thumbnail');
  }
  const thumbnail = await fetch(listed.thumbnailUrl);
  if (!thumbnail.ok || !(thumbnail.headers.get('content-type') || '').startsWith('image/')) {
    throw new Error(`Signed thumbnail URL failed: ${thumbnail.status}`);
  }
  const searched = await request(`/official-bags?search=${encodeURIComponent('集成测试袋')}`, {
    headers: bearer(userA.accessToken)
  });
  if (!searched.items.some((item) => item.id === bag.id)) throw new Error('Discover search by name failed');
  const searchedBrand = await request(`/official-bags?search=${encodeURIComponent(`TestBrand ${suffix}`)}`, {
    headers: bearer(userA.accessToken)
  });
  if (!searchedBrand.items.some((item) => item.id === bag.id)) throw new Error('Discover search by brand failed');
  const filteredByBrand = await request(`/official-bags?brandId=${encodeURIComponent(brand.id)}`, {
    headers: bearer(userA.accessToken)
  });
  if (!filteredByBrand.items.some((item) => item.id === bag.id)) throw new Error('Discover filter by brandId failed');
  const miss = await request(`/official-bags?search=${encodeURIComponent('不存在的关键词')}`, {
    headers: bearer(userA.accessToken)
  });
  if (miss.items.some((item) => item.id === bag.id)) throw new Error('Discover search matched an unrelated keyword');
  const detail = await request(`/official-bags/${bag.id}`, { headers: bearer(userA.accessToken) });
  if (detail.name !== bag.name || detail.brand !== brand.name || detail.displayImageUrl === undefined) {
    throw new Error('Discover detail is incomplete');
  }

  // ---- 用户 A 拥有 ----
  const claim = await request(`/official-bags/${bag.id}/claim`, {
    method: 'POST', headers: bearer(userA.accessToken)
  }, 201);
  if (claim.processingStatus !== 'NORMALIZING') throw new Error('Claim did not enter the copying state');
  const userARecord = await prisma.user.findUniqueOrThrow({ where: { openid: mockOpenid(`official-a-${suffix}`) } });
  const unsorted = await prisma.shelf.findFirst({ where: { userId: userARecord.id, name: '未分类' } });
  if (!unsorted) throw new Error('Claim did not create the default shelf');
  const claimed = await prisma.collectible.findUniqueOrThrow({ where: { id: claim.collectibleId } });
  if (
    claimed.userId !== userARecord.id ||
    claimed.shelfId !== unsorted.id ||
    claimed.name !== bag.name ||
    claimed.processingStatus !== 'NORMALIZING'
  ) {
    throw new Error('Claimed collectible fields are incorrect');
  }
  const claimedTags = await prisma.collectibleTag.count({ where: { collectibleId: claim.collectibleId } });
  if (claimedTags !== 2) throw new Error('Claim did not copy the bag tags');
  const claimRecord = await prisma.officialClaim.findUniqueOrThrow({
    where: { userId_officialBagId: { userId: userARecord.id, officialBagId: bag.id } }
  });
  if (claimRecord.collectibleId !== claim.collectibleId) throw new Error('Claim record points at the wrong collectible');
  const bagAfterClaim = await prisma.officialBag.findUniqueOrThrow({ where: { id: bag.id } });
  if (bagAfterClaim.claimedCount !== 1) throw new Error('claimedCount was not incremented');
  const readyList = await request('/collectibles', { headers: bearer(userA.accessToken) });
  if (readyList.items.some((item) => item.id === claim.collectibleId)) {
    throw new Error('Claimed collectible leaked into the ready list before worker completion');
  }

  // ---- 重复拥有 / 已拥有保护 ----
  await request(`/official-bags/${bag.id}/claim`, {
    method: 'POST', headers: bearer(userA.accessToken)
  }, 409);
  await uploadImage(admin.accessToken, bag.id, 409, Buffer.from(await pngBytes(90, 90)));
  await request(`/admin/official-bags/${bag.id}`, {
    method: 'DELETE', headers: bearer(admin.accessToken)
  }, 409);

  // ---- 用户 B 拥有同一袋子 + claimed 标记 ----
  const userB = await request('/auth/wechat/login', {
    method: 'POST', body: JSON.stringify({ code: `official-b-${suffix}` })
  });
  const claimB = await request(`/official-bags/${bag.id}/claim`, {
    method: 'POST', headers: bearer(userB.accessToken)
  }, 201);
  const bagAfterClaimB = await prisma.officialBag.findUniqueOrThrow({ where: { id: bag.id } });
  if (bagAfterClaimB.claimedCount !== 2) throw new Error('claimedCount did not reach 2');
  const detailForB = await request(`/official-bags/${bag.id}`, { headers: bearer(userB.accessToken) });
  if (detailForB.claimed !== true) throw new Error('claimed flag missing after claiming');
  const discoverForA = await request('/official-bags', { headers: bearer(userA.accessToken) });
  if (discoverForA.items.find((item) => item.id === bag.id)?.claimed !== true) {
    throw new Error('claimed flag missing on the discover list');
  }

  // ---- 配额 ----
  const quotaBag = await request('/admin/official-bags', {
    method: 'POST',
    headers: bearer(admin.accessToken),
    body: JSON.stringify({ name: `配额测试袋 ${suffix}` })
  }, 201);
  await uploadImage(admin.accessToken, quotaBag.id);
  await simulateProcessing(quotaBag.id, 1);
  await request(`/admin/official-bags/${quotaBag.id}`, {
    method: 'PATCH', headers: bearer(admin.accessToken), body: JSON.stringify({ status: 'PUBLISHED' })
  });
  const userACollectibleCount = await prisma.collectible.count({ where: { userId: userARecord.id } });
  await prisma.user.update({
    where: { id: userARecord.id },
    data: { collectibleQuota: userACollectibleCount }
  });
  await request(`/official-bags/${quotaBag.id}/claim`, {
    method: 'POST', headers: bearer(userA.accessToken)
  }, 413);
  await prisma.user.update({
    where: { id: userARecord.id },
    data: { collectibleQuota: 1000 }
  });

  // ---- 下架：发现页隐藏、不可再拥有、已有收藏不受影响 ----
  await request(`/admin/official-bags/${bag.id}`, {
    method: 'PATCH', headers: bearer(admin.accessToken), body: JSON.stringify({ status: 'OFFLINE' })
  });
  const discoverAfterOffline = await request('/official-bags', { headers: bearer(userA.accessToken) });
  if (discoverAfterOffline.items.some((item) => item.id === bag.id)) {
    throw new Error('Offline bag still visible in the discover list');
  }
  await request(`/official-bags/${bag.id}`, { headers: bearer(userA.accessToken) }, 404);
  const userC = await request('/auth/wechat/login', {
    method: 'POST', body: JSON.stringify({ code: `official-c-${suffix}` })
  });
  await request(`/official-bags/${bag.id}/claim`, {
    method: 'POST', headers: bearer(userC.accessToken)
  }, 404);
  const stillThere = await prisma.collectible.findUnique({ where: { id: claim.collectibleId } });
  if (!stillThere) throw new Error('Offline bag deleted an already-claimed collectible');

  // ---- 上传时按表单开关执行抠图 + 删除图片 ----
  const imageBag = await request('/admin/official-bags', {
    method: 'POST',
    headers: bearer(admin.accessToken),
    body: JSON.stringify({ name: `图片管理袋 ${suffix}`, matting: false })
  }, 201);
  const mattingUpload = await uploadImage(admin.accessToken, imageBag.id, 201, Buffer.from(await pngBytes(64, 64)), true);
  if (mattingUpload.version !== 1) throw new Error('Upload with matting did not start at version 1');
  if ((await prisma.officialBag.findUniqueOrThrow({ where: { id: imageBag.id } })).matting !== true) {
    throw new Error('Upload did not override the bag matting flag');
  }
  await simulateProcessing(imageBag.id, 1);
  await request(`/admin/official-bags/${imageBag.id}`, {
    method: 'PATCH', headers: bearer(admin.accessToken), body: JSON.stringify({ status: 'PUBLISHED' })
  });
  const cleared = await request(`/admin/official-bags/${imageBag.id}/image`, {
    method: 'DELETE', headers: bearer(admin.accessToken)
  });
  if (cleared.thumbnailUrl !== undefined || cleared.displayImageUrl !== undefined) {
    throw new Error('Deleting images left rendition URLs on the bag');
  }
  if (cleared.status !== 'OFFLINE' || cleared.processStatus !== 'PENDING') {
    throw new Error('Deleting images did not offline the bag / reset processStatus');
  }
  if ((await prisma.officialBagImage.count({ where: { officialBagId: imageBag.id } })) !== 0) {
    throw new Error('Deleting images did not remove the image records');
  }
  await request(`/admin/official-bags/${imageBag.id}`, {
    method: 'PATCH', headers: bearer(admin.accessToken), body: JSON.stringify({ status: 'PUBLISHED' })
  }, 409);
  await request(`/admin/official-bags/${imageBag.id}`, {
    method: 'DELETE', headers: bearer(admin.accessToken)
  });

  // ---- 未被拥有的袋子可删除 ----
  await request(`/admin/official-bags/${quotaBag.id}`, {
    method: 'DELETE', headers: bearer(admin.accessToken)
  });
  if (await prisma.officialBag.findUnique({ where: { id: quotaBag.id } })) {
    throw new Error('Unclaimed bag was not deleted');
  }

  // ---- 管理端列表过滤 ----
  const adminList = await request(`/admin/official-bags?status=OFFLINE`, {
    headers: bearer(admin.accessToken)
  });
  if (!adminList.items.some((item) => item.id === bag.id)) throw new Error('Admin status filter failed');
  if (adminList.items.some((item) => item.id === quotaBag.id)) throw new Error('Deleted bag leaked into the admin list');

  // ---- 删除收藏解除拥有：可重新拥有、计数回减、最终可删除袋子 ----
  await request(`/admin/official-bags/${bag.id}`, {
    method: 'PATCH', headers: bearer(admin.accessToken), body: JSON.stringify({ status: 'PUBLISHED' })
  });
  await request(`/collectibles/${claim.collectibleId}`, { method: 'DELETE', headers: bearer(userA.accessToken) });
  const claimAfterDelete = await prisma.officialClaim.findUnique({
    where: { userId_officialBagId: { userId: userARecord.id, officialBagId: bag.id } }
  });
  if (claimAfterDelete) throw new Error('Deleting a claimed collectible did not release the claim');
  if ((await prisma.officialBag.findUniqueOrThrow({ where: { id: bag.id } })).claimedCount !== 1) {
    throw new Error('claimedCount did not decrement after collectible deletion');
  }
  const reclaim = await request(`/official-bags/${bag.id}/claim`, {
    method: 'POST', headers: bearer(userA.accessToken)
  }, 201);
  if (reclaim.collectibleId === claim.collectibleId) throw new Error('Re-claim reused the old collectible');
  await request(`/collectibles/${reclaim.collectibleId}`, { method: 'DELETE', headers: bearer(userA.accessToken) });
  await request(`/collectibles/${claimB.collectibleId}`, { method: 'DELETE', headers: bearer(userB.accessToken) });
  if ((await prisma.officialBag.findUniqueOrThrow({ where: { id: bag.id } })).claimedCount !== 0) {
    throw new Error('claimedCount did not return to zero after cleanup');
  }
  await request(`/admin/official-bags/${bag.id}`, {
    method: 'DELETE', headers: bearer(admin.accessToken)
  });
  if (await prisma.officialBag.findUnique({ where: { id: bag.id } })) {
    throw new Error('Bag with zero claims was not deleted');
  }

  // ---- 品牌删除：袋子清空后可删、bagCount 校验 ----
  await request(`/admin/brands/${brand.id}`, {
    method: 'DELETE', headers: bearer(admin.accessToken)
  });
  if (await prisma.brand.findUnique({ where: { id: brand.id } })) {
    throw new Error('Brand was not deleted after its bags were removed');
  }
  const brandWithBags = await request('/admin/brands', {
    method: 'POST',
    headers: bearer(admin.accessToken),
    body: JSON.stringify({ name: `OccupiedBrand ${suffix}` })
  }, 201);
  const occupiedBag = await request('/admin/official-bags', {
    method: 'POST',
    headers: bearer(admin.accessToken),
    body: JSON.stringify({ name: `品牌占用袋 ${suffix}`, brandId: brandWithBags.id })
  }, 201);
  await request(`/admin/brands/${brandWithBags.id}`, {
    method: 'DELETE', headers: bearer(admin.accessToken)
  }, 409);
  await request(`/admin/official-bags/${occupiedBag.id}`, {
    method: 'DELETE', headers: bearer(admin.accessToken)
  });

  console.log('Official bags integration: admin auth, brand CRUD, bag CRUD, upload/replace, upload-time matting, image delete, publish guard, discover visibility, claim idempotency/quota/default shelf/tags, offline, delete guards, and claim release passed');
} catch (error) {
  // 失败时带上 API 服务器日志（NODE_ENV=test 时 Nest 不打日志，调试用 DEBUG_API=true 开 development）。
  // 等一拍让服务端异步写入的错误堆栈先刷出来。
  await delay(1_000);
  console.error('---- API server output ----');
  console.error(output.slice(-6_000));
  console.error('---- failure ----');
  throw error;
} finally {
  server.kill('SIGTERM');
  await Promise.race([new Promise((resolve) => server.once('exit', resolve)), delay(5_000)]);
  await prisma.$disconnect();
  await rm(resolve(process.cwd(), localStoragePath), { recursive: true, force: true });
}
