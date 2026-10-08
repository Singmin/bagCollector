/**
 * 本地联调 mock 数据：品牌分类 + 官方纸袋 + 用户展架 / 收藏 / 心愿 / 标签。
 *
 * 为什么需要它：本地 `pnpm dev:api` 起的是空库，发现页（feed / official-bags）
 * 和收藏架（shelves / collectibles）全是空的；worker 在本地又跑不起来
 * （抠图链路强制 COS），所以图片处理完成态只能由脚本直接落库 + 落盘模拟。
 *
 * 所有 id 带 `mock` 前缀，`--reset` 可以精确清掉，不碰真实数据（真实 cuid 以 c 开头）。
 * 图片走本地存储驱动（STORAGE_DRIVER=local），文件写到 LOCAL_STORAGE_PATH，
 * API 通过 /api/assets/file?token=... 读出来 —— 小程序拿到的 thumbnailUrl 能直接显示。
 *
 * 用法：
 *   pnpm seed:local:mock              # 写入（可反复运行，幂等 upsert）
 *   pnpm seed:local:mock -- --reset   # 先清理旧的 mock 数据再写入
 *   pnpm seed:local:mock -- --openid mock_xxx   # 挂到指定用户（默认挂本地联调固定 code 的用户）
 */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PrismaClient } from '@prisma/client';
import sharp from 'sharp';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/* ── 本地联调固定登录 code：与 apps/miniapp/.env.localbuild 的 VITE_WECHAT_MOCK_CODE 保持一致 ── */
const LOCAL_DEV_CODE = 'bagcollect-local-demo';
const DEMO_USER_ID = 'mockuser_local_demo';

/* ══════════════════════════════════════════════════════════════════
   环境：根 .env（API 读的就是它）
   ══════════════════════════════════════════════════════════════════ */
function readRootEnv() {
  const map = {};
  let text;
  try {
    text = readFileSync(resolve(repoRoot, '.env'), 'utf8');
  } catch {
    return map;
  }
  for (const line of text.split(/\r?\n/)) {
    const matched = /^\s*([A-Za-z0-9_]+)\s*=\s*(.*?)\s*$/.exec(line);
    if (!matched || line.trimStart().startsWith('#')) continue;
    map[matched[1]] = matched[2].replace(/^["']|["']$/g, '');
  }
  return map;
}

const rootEnv = readRootEnv();
process.env.DATABASE_URL ??= rootEnv.DATABASE_URL;
if (!process.env.DATABASE_URL) throw new Error('缺少 DATABASE_URL（检查仓库根目录 .env）');

/* API 的 cwd 是 apps/api，所以 LOCAL_STORAGE_PATH 相对它解析 */
const storageRoot = resolve(repoRoot, 'apps/api', rootEnv.LOCAL_STORAGE_PATH || '../../data/local-storage');

/* ══════════════════════════════════════════════════════════════════
   图片生成：SVG 纸袋 → png / webp / jpg（sharp 渲染，无需外部素材）
   ══════════════════════════════════════════════════════════════════ */
const PALETTES = [
  { bg: ['#1f5c3d', '#0d3321'], bag: ['#f7f1e6', '#e3d5bd'], strap: '#c9a75f', text: '#1f5c3d' },
  { bg: ['#16388c', '#0a1f57'], bag: ['#ffffff', '#d8e2f8'], strap: '#3a6ff2', text: '#16388c' },
  { bg: ['#2a2a2a', '#0c0c0c'], bag: ['#f4f4f4', '#d9d9d9'], strap: '#b3b3b3', text: '#2a2a2a' },
  { bg: ['#e9b306', '#bd8500'], bag: ['#fffbf0', '#f2e3bd'], strap: '#8a5a00', text: '#6b4400' },
  { bg: ['#5b2c6f', '#2f1740'], bag: ['#f4ebf8', '#dcc7e9'], strap: '#a06fc0', text: '#4a1f5c' },
  { bg: ['#b81d24', '#731016'], bag: ['#fdeceb', '#f4cdca'], strap: '#e05a5f', text: '#8c1418' },
  { bg: ['#0f766e', '#094744'], bag: ['#eafaf7', '#c6ebe5'], strap: '#2fb3a4', text: '#0b5d57' },
  { bg: ['#c2410c', '#7d2805'], bag: ['#fff4ea', '#f2d5bb'], strap: '#e07a3f', text: '#8a2c06' },
  { bg: ['#1d4ed8', '#102a7d'], bag: ['#eff4ff', '#ccdbfa'], strap: '#6b8ef5', text: '#1a3fae' },
  { bg: ['#111827', '#374151'], bag: ['#f9fafb', '#e3e5e9'], strap: '#9ca3af', text: '#111827' }
];

function bagSvg(size, palette, initials) {
  const w = size;
  const h = size;
  const bagW = w * 0.44;
  const bagH = h * 0.46;
  const x = (w - bagW) / 2;
  const y = h * 0.32;
  const stroke = Math.max(1, w * 0.016);
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0%" stop-color="${palette.bg[0]}"/><stop offset="100%" stop-color="${palette.bg[1]}"/>
    </linearGradient>
    <linearGradient id="bag" x1="0" y1="0" x2="0.3" y2="1">
      <stop offset="0%" stop-color="${palette.bag[0]}"/><stop offset="100%" stop-color="${palette.bag[1]}"/>
    </linearGradient>
    <filter id="soft" x="-30%" y="-30%" width="160%" height="160%">
      <feDropShadow dx="0" dy="${h * 0.018}" stdDeviation="${h * 0.028}" flood-color="#000" flood-opacity="0.22"/>
    </filter>
  </defs>
  <rect width="${w}" height="${h}" rx="${w * 0.08}" fill="url(#bg)"/>
  <circle cx="${w * 0.84}" cy="${h * 0.17}" r="${w * 0.17}" fill="#ffffff" opacity="0.07"/>
  <circle cx="${w * 0.14}" cy="${h * 0.86}" r="${w * 0.21}" fill="#ffffff" opacity="0.05"/>
  <g filter="url(#soft)">
    <path d="M${x - stroke} ${y + bagH * 0.1} L${x + bagW + stroke} ${y + bagH * 0.1} L${x + bagW * 0.94} ${y + bagH} L${x + bagW * 0.06} ${y + bagH} Z" fill="url(#bag)"/>
    <path d="M${x + bagW * 0.28} ${y + bagH * 0.1} q${bagW * 0.22} ${-bagH * 0.42} ${bagW * 0.44} 0" fill="none" stroke="${palette.strap}" stroke-width="${stroke * 1.6}" stroke-linecap="round"/>
    <rect x="${x + bagW * 0.06}" y="${y + bagH * 0.1}" width="${bagW * 0.88}" height="${bagH * 0.1}" fill="${palette.strap}" opacity="0.32"/>
    <text x="${w / 2}" y="${y + bagH * 0.78}" text-anchor="middle" font-family="Arial, Helvetica, sans-serif" font-size="${w * 0.13}" font-weight="700" fill="${palette.text}" opacity="0.85">${initials}</text>
  </g>
</svg>`;
}

const renderCache = new Map();

/** 同一张底图只渲染一次，再派生出各尺寸与格式 */
async function renditions(size, palette, initials) {
  const cacheKey = `${size}-${palette.bg[0]}-${initials}`;
  if (renderCache.has(cacheKey)) return renderCache.get(cacheKey);
  const base = await sharp(Buffer.from(bagSvg(size, palette, initials))).png().toBuffer();
  const result = {
    png: base,
    webp: await sharp(base).resize(Math.round(size / 3)).webp({ quality: 84 }).toBuffer(),
    jpg: await sharp(base).jpeg({ quality: 86 }).toBuffer()
  };
  renderCache.set(cacheKey, result);
  return result;
}

/* ══════════════════════════════════════════════════════════════════
   mock 内容定义
   ══════════════════════════════════════════════════════════════════ */

/* 品牌分类：explore 页的品牌 chips（只显示有可见袋子的品牌） */
const BRANDS = [
  { slug: 'starbucks', name: '星巴克', initials: 'SB', palette: 0, bags: ['臻选圣诞红杯手提袋', '中秋限定月亮袋', '樱花季粉袋', '城市系列限定袋', '黑金臻选牛皮纸袋'] },
  { slug: 'luckin', name: '瑞幸咖啡', initials: 'LK', palette: 1, bags: ['小蓝杯联名袋', '生椰拿铁纸袋', '茅台联名限定袋', '轻乳茶纸袋', '椰云拿铁手提袋'] },
  { slug: 'manner', name: 'Manner', initials: 'MN', palette: 2, bags: ['燕麦拿铁纸袋', '黄油小熊联名袋', '经典黑标袋', '冷萃限定袋', '门店纸袋（大）'] },
  { slug: 'arabica', name: 'Arabica', initials: '%', palette: 3, bags: ['% 标志性黄袋', '岚山限定袋', '京都门店纸袋', '燕麦阿芙佳朵袋', '冬日限定袋'] },
  { slug: 'peets', name: '皮爷咖啡', initials: 'PT', palette: 4, bags: ['深烘经典袋', '季节限定紫袋', '皮爷大杯纸袋', '冷萃深绿袋', '周年纪念袋'] },
  { slug: 'tims', name: 'Tims 天好', initials: 'TM', palette: 5, bags: ['小红杯纸袋', '甜甜圈联名袋', '枫叶限定袋', '暖冬热饮袋', '贝果套餐袋'] },
  { slug: 'mstand', name: 'M Stand', initials: 'MS', palette: 6, bags: ['水泥灰纸袋', '燕麦曲奇拿铁袋', '黑白线条款', '气泡冷萃袋', '极简门店袋'] },
  { slug: 'seesaw', name: 'Seesaw', initials: 'SS', palette: 7, bags: ['云南豆限定袋', '橘色经典袋', '果咖联名袋', '夜市限定袋', '轻食套餐袋'] },
  { slug: 'cotti', name: '库迪咖啡', initials: 'CT', palette: 8, bags: ['蓝白经典袋', '果咖系列袋', '联名插画袋', '轻乳茶纸袋', '热压烘焙袋'] },
  { slug: 'bluebottle', name: '蓝瓶咖啡', initials: 'BB', palette: 9, bags: ['蓝瓶经典袋', '单源手冲袋', '限定主题袋', '咖啡豆外带袋', '极简白袋'] }
];

/* 用户展架：library 页的分组 */
const SHELVES = [
  { key: 'unsorted', name: '未分类', theme: 'SAGE' },
  { key: 'daily', name: '咖啡日常', theme: 'AMBER' },
  { key: 'limited', name: '限定收藏', theme: 'ROSE' },
  { key: 'bakery', name: '烘焙纸袋', theme: 'SKY' },
  { key: 'street', name: '潮牌联名', theme: 'GRAPHITE' },
  { key: 'clear', name: '透明珍藏', theme: 'SAGE' },
  { key: 'travel', name: '旅行纪念', theme: 'AMBER' },
  { key: 'gift', name: '礼盒包装', theme: 'SKY' }
];

/* 我的收藏：shelf 归属 / 数量 / 可见性 / 标签 / 关联的官方袋子（brand slug + 袋子序号）/ 是否已抠图 */
const COLLECTIBLES = [
  { shelf: 'daily', name: '星巴克 圣诞红杯手提袋', quantity: 2, tags: ['咖啡', '节日'], source: ['starbucks', 0], cutout: true },
  { shelf: 'daily', name: '瑞幸 小蓝杯联名袋', quantity: 1, tags: ['咖啡'], source: ['luckin', 0], cutout: true },
  { shelf: 'daily', name: 'Manner 燕麦拿铁纸袋', quantity: 3, tags: ['咖啡', '燕麦'], source: ['manner', 0], cutout: false },
  { shelf: 'limited', name: '星巴克 中秋限定月亮袋', quantity: 1, tags: ['限定', '节日'], source: ['starbucks', 1], cutout: true },
  { shelf: 'limited', name: '瑞幸 茅台联名限定袋', quantity: 1, tags: ['限定', '联名'], source: ['luckin', 2], cutout: true },
  { shelf: 'limited', name: '% Arabica 岚山限定袋', quantity: 1, tags: ['限定', '旅行'], source: ['arabica', 1], cutout: true },
  { shelf: 'bakery', name: 'Tims 甜甜圈联名袋', quantity: 2, tags: ['烘焙', '联名'], source: ['tims', 1], cutout: false },
  { shelf: 'bakery', name: '库迪 热压烘焙袋', quantity: 1, tags: ['烘焙'], source: ['cotti', 4], cutout: false },
  { shelf: 'bakery', name: '皮爷 深烘经典袋', quantity: 1, tags: ['咖啡', '烘焙'], source: ['peets', 0], cutout: true },
  { shelf: 'street', name: 'Manner 黄油小熊联名袋', quantity: 1, tags: ['联名', '可爱'], source: ['manner', 1], cutout: true },
  { shelf: 'street', name: 'Seesaw 果咖联名袋', quantity: 1, tags: ['联名'], source: ['seesaw', 2], cutout: false },
  { shelf: 'street', name: '库迪 联名插画袋', quantity: 4, tags: ['联名', '插画'], source: ['cotti', 2], cutout: false },
  { shelf: 'clear', name: 'M Stand 水泥灰纸袋', quantity: 1, tags: ['极简'], source: ['mstand', 0], cutout: true },
  { shelf: 'clear', name: '蓝瓶 单源手冲袋', quantity: 2, tags: ['咖啡', '极简'], source: ['bluebottle', 1], cutout: true },
  { shelf: 'clear', name: '透明 PVC 收纳袋（自购）', quantity: 3, tags: ['收纳'], source: null, cutout: false },
  { shelf: 'travel', name: '京都门店纸袋', quantity: 1, tags: ['旅行', '咖啡'], source: ['arabica', 2], cutout: true },
  { shelf: 'travel', name: '机场免税店购物袋', quantity: 2, tags: ['旅行'], source: null, cutout: false },
  { shelf: 'travel', name: '海边市集牛皮纸袋', quantity: 1, tags: ['旅行', '牛皮纸'], source: null, cutout: false },
  { shelf: 'gift', name: '礼盒外包装袋（红）', quantity: 5, tags: ['礼盒', '节日'], source: null, cutout: false },
  { shelf: 'gift', name: '皮爷 周年纪念袋', quantity: 1, tags: ['限定', '纪念'], source: ['peets', 4], cutout: true },
  { shelf: 'gift', name: '丝带手提礼袋', quantity: 2, tags: ['礼盒'], source: null, cutout: false },
  { shelf: 'unsorted', name: '临时收到的纸袋', quantity: 1, tags: [], source: null, cutout: false },
  { shelf: 'unsorted', name: '蓝瓶 咖啡豆外带袋', quantity: 1, tags: ['咖啡'], source: ['bluebottle', 3], cutout: false },
  { shelf: 'unsorted', name: 'M Stand 气泡冷萃袋', quantity: 1, visibility: 'PRIVATE', tags: ['咖啡'], source: ['mstand', 3], cutout: false }
];

/* 心愿袋：只能放「还没拥有」的袋子 —— 已拥有的会被 API 拒绝（心愿 = 想要但还没有），
   所以这里的 5 个都必须与上面 COLLECTIBLES 的 source 不重叠 */
const WISHLIST_SLUGS = [
  ['starbucks', 4],
  ['bluebottle', 0],
  ['arabica', 4],
  ['seesaw', 3],
  ['cotti', 3]
];

/* ══════════════════════════════════════════════════════════════════
   工具
   ══════════════════════════════════════════════════════════════════ */
const prisma = new PrismaClient();

function mockOpenid(code) {
  return `mock_${createHash('sha256').update(code).digest('hex').slice(0, 40)}`;
}

const brandId = (slug) => `mockbrand_${slug}`;
const bagId = (slug, index) => `mockbag_${slug}_${index}`;
const shelfId = (key) => `mockshelf_${key}`;
const collectibleId = (index) => `mockcol_${String(index).padStart(2, '0')}`;
const assetId = (collectible, kind) => `mockasset_${collectible}_${kind.toLowerCase()}`;
const tagId = (userId, slug) => `mocktag_${userId}_${slug}`;

async function putObject(key, buffer) {
  const path = resolve(storageRoot, key);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, buffer);
  return BigInt(buffer.length);
}

/** 官方袋子：写 standard/display/thumbnail 三张图 + OfficialBagImage 记录 */
async function writeOfficialImages(id, palette, initials) {
  const { png, webp, jpg } = await renditions(480, palette, initials);
  const definitions = [
    { kind: 'STANDARD', extension: 'jpg', contentType: 'image/jpeg', buffer: jpg, size: 720 },
    { kind: 'DISPLAY', extension: 'png', contentType: 'image/png', buffer: png, size: 480 },
    { kind: 'THUMBNAIL', extension: 'webp', contentType: 'image/webp', buffer: webp, size: 160 }
  ];
  for (const definition of definitions) {
    const key = `official/${id}/${definition.kind.toLowerCase()}/v1.${definition.extension}`;
    const byteSize = await putObject(key, definition.buffer);
    await prisma.officialBagImage.upsert({
      where: { objectKey: key },
      create: {
        officialBagId: id,
        kind: definition.kind,
        status: 'AVAILABLE',
        objectKey: key,
        contentType: definition.contentType,
        declaredByteSize: byteSize,
        byteSize,
        width: definition.size,
        height: definition.size,
        version: 1
      },
      update: { status: 'AVAILABLE', byteSize }
    });
  }
}

/** 我的收藏：写 display/thumbnail(+standard/cutout) 与 ImageAsset 记录 */
async function writeCollectibleImages(id, userId, palette, initials, withCutout) {
  const { png, webp, jpg } = await renditions(480, palette, initials);
  const definitions = [
    { kind: 'STANDARD', extension: 'jpg', contentType: 'image/jpeg', buffer: jpg, size: 720 },
    { kind: 'DISPLAY', extension: 'png', contentType: 'image/png', buffer: png, size: 480 },
    { kind: 'THUMBNAIL', extension: 'webp', contentType: 'image/webp', buffer: webp, size: 160 }
  ];
  if (withCutout) {
    /* 抠图结果：透明底 PNG，主体缩到中间（模拟已抠图，编辑页会隐藏「自动抠图」按钮） */
    definitions.push({
      kind: 'CUTOUT',
      extension: 'png',
      contentType: 'image/png',
      buffer: await sharp(png).resize(360, 360, { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } }).png().toBuffer(),
      size: 360
    });
  }
  let total = 0n;
  for (const definition of definitions) {
    const key = `users/${userId}/collectibles/${id}/${definition.kind.toLowerCase()}/v1.${definition.extension}`;
    const byteSize = await putObject(key, definition.buffer);
    total += byteSize;
    await prisma.imageAsset.upsert({
      where: { objectKey: key },
      create: {
        id: assetId(id, definition.kind),
        userId,
        collectibleId: id,
        kind: definition.kind,
        status: 'AVAILABLE',
        objectKey: key,
        contentType: definition.contentType,
        declaredByteSize: byteSize,
        byteSize,
        width: definition.size,
        height: definition.size,
        version: 1
      },
      update: { status: 'AVAILABLE', byteSize }
    });
  }
  return total;
}

/* ══════════════════════════════════════════════════════════════════
   主流程
   ══════════════════════════════════════════════════════════════════ */
const args = process.argv.slice(2);
const shouldReset = args.includes('--reset');
const openidArgIndex = args.indexOf('--openid');
const targetOpenid = openidArgIndex >= 0 ? args[openidArgIndex + 1] : mockOpenid(LOCAL_DEV_CODE);
if (openidArgIndex >= 0 && !targetOpenid) throw new Error('--openid 后面需要跟 openid');

async function reset() {
  await prisma.collectibleTag.deleteMany({ where: { collectibleId: { startsWith: 'mockcol_' } } });
  await prisma.imageAsset.deleteMany({ where: { id: { startsWith: 'mockasset_' } } });
  await prisma.collectible.deleteMany({ where: { id: { startsWith: 'mockcol_' } } });
  await prisma.shelf.deleteMany({ where: { id: { startsWith: 'mockshelf_' } } });
  await prisma.tag.deleteMany({ where: { id: { startsWith: 'mocktag_' } } });
  await prisma.officialClaim.deleteMany({ where: { officialBagId: { startsWith: 'mockbag_' } } });
  await prisma.wishlistItem.deleteMany({ where: { officialBagId: { startsWith: 'mockbag_' } } });
  await prisma.officialBagImage.deleteMany({ where: { officialBagId: { startsWith: 'mockbag_' } } });
  await prisma.officialBag.deleteMany({ where: { id: { startsWith: 'mockbag_' } } });
  await prisma.brand.deleteMany({ where: { id: { startsWith: 'mockbrand_' } } });
  await prisma.user.deleteMany({ where: { id: DEMO_USER_ID } });
  await rm(resolve(storageRoot, 'official'), { recursive: true, force: true });
  await rm(resolve(storageRoot, 'users', DEMO_USER_ID), { recursive: true, force: true });
  console.log('已清理旧的 mock 数据与图片文件');
}

async function seedBrandsAndBags() {
  let bagTotal = 0;
  for (const [brandIndex, brand] of BRANDS.entries()) {
    const palette = PALETTES[brand.palette];
    await prisma.brand.upsert({
      where: { id: brandId(brand.slug) },
      create: { id: brandId(brand.slug), name: brand.name, sortOrder: brandIndex },
      update: { name: brand.name, sortOrder: brandIndex }
    });

    for (const [bagIndex, bagName] of brand.bags.entries()) {
      const id = bagId(brand.slug, bagIndex);
      const publishedAt = new Date(Date.now() - (bagTotal + 1) * 8 * 3_600_000);
      const record = {
        name: bagName,
        brandId: brandId(brand.slug),
        notes: `${brand.name} 官方纸袋，mock 样例数据`,
        tags: bagIndex % 3 === 0 ? ['咖啡', '纸袋'] : bagIndex % 3 === 1 ? ['限定'] : ['日常'],
        status: 'PUBLISHED',
        processStatus: 'READY',
        processError: null,
        matting: bagIndex % 2 === 0,
        sortOrder: bagTotal,
        version: 1,
        publishedAt
      };
      await prisma.officialBag.upsert({
        where: { id },
        create: { id, ...record },
        update: record
      });
      await writeOfficialImages(id, palette, brand.initials);
      bagTotal += 1;
    }
  }
  return bagTotal;
}

async function seedUser() {
  const user = await prisma.user.upsert({
    where: { openid: targetOpenid },
    create: {
      id: targetOpenid === mockOpenid(LOCAL_DEV_CODE) ? DEMO_USER_ID : undefined,
      openid: targetOpenid,
      storageQuotaBytes: BigInt(rootEnv.MAX_STORAGE_BYTES || 5_368_709_120),
      collectibleQuota: Number(rootEnv.MAX_COLLECTIBLES_PER_USER || 500),
      dailyMattingQuota: Number(rootEnv.MAX_DAILY_MATTING || 25)
    },
    update: {}
  });

  let storageUsed = 0n;
  let cutoutCount = 0;

  for (const [shelfIndex, shelf] of SHELVES.entries()) {
    await prisma.shelf.upsert({
      where: { id_userId: { id: shelfId(shelf.key), userId: user.id } },
      create: { id: shelfId(shelf.key), userId: user.id, name: shelf.name, theme: shelf.theme, sortOrder: shelfIndex },
      update: { name: shelf.name, theme: shelf.theme, sortOrder: shelfIndex }
    });
  }

  for (const [itemIndex, item] of COLLECTIBLES.entries()) {
    const id = collectibleId(itemIndex);
    const palette = item.source ? PALETTES[BRANDS.find((brand) => brand.slug === item.source[0]).palette] : PALETTES[itemIndex % PALETTES.length];
    const initials = item.source ? BRANDS.find((brand) => brand.slug === item.source[0]).initials : 'BG';
    let sourceOfficialBagId = null;

    if (item.source) {
      sourceOfficialBagId = bagId(item.source[0], item.source[1]);
      await prisma.officialClaim.upsert({
        where: { userId_officialBagId: { userId: user.id, officialBagId: sourceOfficialBagId } },
        create: { userId: user.id, officialBagId: sourceOfficialBagId, collectibleId: id },
        update: { collectibleId: id }
      });
      const claims = await prisma.officialClaim.count({ where: { officialBagId: sourceOfficialBagId } });
      await prisma.officialBag.update({ where: { id: sourceOfficialBagId }, data: { claimedCount: claims } });
    }

    const addedAt = new Date(Date.now() - (itemIndex + 1) * 3.5 * 86_400_000);
    const record = {
      userId: user.id,
      shelfId: shelfId(item.shelf),
      name: item.name,
      notes: item.tags.includes('限定') ? '限定款，收的时候特意问了店员' : '',
      quantity: item.quantity,
      visibility: item.visibility || 'PUBLIC',
      shelfOrder: itemIndex,
      processingStatus: 'READY',
      processingError: null,
      processingVersion: 1,
      addedAt,
      submissionStatus: 'APPROVED',
      sourceOfficialBagId
    };
    await prisma.collectible.upsert({
      where: { id_userId: { id, userId: user.id } },
      create: { id, ...record },
      update: record
    });

    storageUsed += await writeCollectibleImages(id, user.id, palette, initials, item.cutout);
    if (item.cutout) cutoutCount += 1;

    for (const label of item.tags) {
      const slug = Buffer.from(label).toString('hex').slice(0, 16);
      await prisma.tag.upsert({
        where: { userId_normalized: { userId: user.id, normalized: label } },
        create: { id: tagId(user.id, slug), userId: user.id, normalized: label, displayName: label },
        update: { displayName: label }
      });
      await prisma.collectibleTag.upsert({
        where: { collectibleId_tagId: { collectibleId: id, tagId: tagId(user.id, slug) } },
        create: { collectibleId: id, tagId: tagId(user.id, slug) },
        update: {}
      });
    }
  }

  /* 先清掉本用户的 mock 心愿再按清单写入：清单调整后库里不会残留旧的矛盾数据
     （已拥有的袋子不允许留在心愿袋，规则见 API 的 addWishlist / claim） */
  await prisma.wishlistItem.deleteMany({
    where: { userId: user.id, officialBagId: { startsWith: 'mockbag_' } }
  });
  for (const [slug, index] of WISHLIST_SLUGS) {
    await prisma.wishlistItem.create({ data: { userId: user.id, officialBagId: bagId(slug, index) } });
  }

  await prisma.user.update({ where: { id: user.id }, data: { storageUsedBytes: storageUsed } });
  return { user, cutoutCount };
}

try {
  if (shouldReset) await reset();
  const bagTotal = await seedBrandsAndBags();
  const { user, cutoutCount } = await seedUser();

  console.log('');
  console.log(`品牌分类：${BRANDS.length} 个`);
  console.log(`官方纸袋：${bagTotal} 个（全部 PUBLISHED + READY，含 DISPLAY/THUMBNAIL 图片）`);
  console.log(`展架：${SHELVES.length} 个 / 收藏：${COLLECTIBLES.length} 条（其中 ${cutoutCount} 条已抠图）/ 心愿袋：${WISHLIST_SLUGS.length} 个`);
  console.log(`图片目录：${storageRoot}`);
  console.log(`挂载用户：${user.id}（openid ${user.openid}）`);
  if (user.openid === mockOpenid(LOCAL_DEV_CODE)) {
    console.log('本地小程序会用固定 code 登录到这个用户，直接在小程序里下拉刷新即可看到数据。');
  } else {
    console.log('提示：这是自定义 openid，小程序端需要用它登录才能看到这批数据。');
  }
} finally {
  await prisma.$disconnect();
}
