// 白描边（贴纸效果）存量回填脚本（生产用）
//
// 背景：官方袋子链路历史未接白描边，用户存量图在描边参数调整后也不会自动更新。
// 本脚本遍历存量透明资产（用户 CUTOUT / 官方 CUTOUT / 官方透明 STANDARD），
// 按与 worker 出图完全一致的口径重新派生 DISPLAY/THUMBNAIL（trim → addWhiteStroke → resize），
// 原地覆盖写回 COS 并更新 DB 的宽高/字节数。
//
// 覆盖写后 CDN 边缘缓存仍是旧图（object-store 写的是 CacheControl: immutable, max-age=1年），
// 必须刷新 CDN 才会生效。本脚本把需要刷新的 URL 清单写到 URL_MANIFEST，
// 由你在腾讯云控制台「CDN → 刷新预热」里手动提交（提交 URL 刷新即可，无需目录刷新）。
//
// 运行（在 worker 容器内，env 已由 compose 注入）：
//   docker cp scripts/backfill-stroke.mjs infra-worker-1:/app/backfill-stroke.mjs
//   docker exec infra-worker-1 node /app/backfill-stroke.mjs            # dry-run：统计 + 出清单，不写
//   docker exec infra-worker-1 node /app/backfill-stroke.mjs --execute  # 真正覆盖写 + 更新 DB
//
// 安全设计：
//   1. 默认 dry-run，只有带 --execute 才真正写；
//   2. 幂等：覆盖写同一 v{n} 的 key，重跑安全；
//   3. 只处理「当前发布版本」的资产（join publishedVersion），不碰历史旧版本；
//   4. 单条失败不中断，记录失败并继续，末尾汇总。
import { PrismaClient } from '@prisma/client';
import COS from 'cos-nodejs-sdk-v5';
import sharp from 'sharp';
import { addWhiteStroke, DEFAULT_STROKE_PARAMS, strokeParamsSchema } from '@bagcollect/stroke';
import { writeFileSync } from 'node:fs';

const EXECUTE = process.argv.includes('--execute');
// 只回填指定范围：--scope=official 只处理官方袋子，--scope=user 只处理用户；不传则全部。
const SCOPE = process.argv.includes('--scope=official') ? 'official'
  : process.argv.includes('--scope=user') ? 'user'
    : null;
const CONCURRENCY = Number(process.env.STROKE_BACKFILL_CONCURRENCY ?? 4);
const MAX_IMAGE_PIXELS = Number(process.env.MAX_IMAGE_PIXELS ?? 60_000_000);
const URL_MANIFEST = process.env.URL_MANIFEST ?? '/tmp/stroke-backfill-urls.txt';

const prisma = new PrismaClient();

function die(message) {
  console.error(message);
  process.exit(1);
}

const { COS_SECRET_ID, COS_SECRET_KEY, COS_BUCKET: Bucket, COS_REGION: Region } = process.env;
if (!COS_SECRET_ID || !COS_SECRET_KEY || !Bucket || !Region) {
  die('缺少 COS 环境变量：COS_SECRET_ID / COS_SECRET_KEY / COS_BUCKET / COS_REGION');
}
if (!process.env.DATABASE_URL) die('缺少 DATABASE_URL');

const cos = new COS({ SecretId: COS_SECRET_ID, SecretKey: COS_SECRET_KEY });

const getObject = (Key) =>
  new Promise((resolve, reject) =>
    cos.getObject({ Bucket, Region, Key }, (error, data) => {
      if (error) reject(error);
      else resolve(Buffer.isBuffer(data.Body) ? data.Body : Buffer.from(data.Body));
    })
  );

const putObject = (Key, Body, ContentType) =>
  new Promise((resolve, reject) =>
    cos.putObject(
      {
        Bucket,
        Region,
        Key,
        Body,
        ContentType,
        ContentLength: Body.length,
        CacheControl: 'public, max-age=31536000, immutable',
        ServerSideEncryption: 'AES256'
      },
      (error) => (error ? reject(error) : resolve())
    )
  );

const publicHost = (process.env.COS_PUBLIC_HOST || `https://${Bucket}.cos.${Region}.myqcloud.com`).replace(/\/+$/, '');
const publicUrl = (key) => `${publicHost}/${key.split('/').map(encodeURIComponent).join('/')}`;

/** 从 CUTOUT/STANDARD 的 objectKey 推出目录前缀（去掉末尾 {kind}/v{n}.{ext} 两段）。 */
function baseOfKey(objectKey) {
  const parts = objectKey.split('/');
  parts.pop(); // v{n}.{ext}
  parts.pop(); // cutout / standard
  return parts.join('/');
}

/** 与 worker processor.trimTransparent 同口径：裁掉透明边缘，失败回退原图。 */
async function trimTransparent(source) {
  try {
    const trimmed = await sharp(source, { limitInputPixels: MAX_IMAGE_PIXELS }).trim().png().toBuffer();
    const meta = await sharp(trimmed).metadata();
    if (meta.width > 0 && meta.height > 0) return trimmed;
    return source;
  } catch {
    return source;
  }
}

/** 读取白描边参数（AppSetting key=stroke.settings），与 worker getStrokeParams 同口径。 */
async function loadStrokeParams() {
  const row = await prisma.appSetting.findUnique({ where: { key: 'stroke.settings' } });
  try {
    return strokeParamsSchema.parse({ ...DEFAULT_STROKE_PARAMS, ...(row ? JSON.parse(row.value) : {}) });
  } catch {
    return { ...DEFAULT_STROKE_PARAMS };
  }
}

/** 查全部待回填目标：用户 CUTOUT + 官方 CUTOUT + 官方透明 STANDARD（无 CUTOUT 的袋子）。 */
async function loadTargets() {
  const userCutouts = await prisma.$queryRaw`
    SELECT 'user' AS scope, ia."objectKey" AS key, ia.version, ia."collectibleId" AS id
    FROM "ImageAsset" ia
    JOIN "CollectibleImageSide" cis
      ON cis."collectibleId" = ia."collectibleId" AND cis.side = ia.side
    WHERE ia.kind = 'CUTOUT' AND ia.status = 'AVAILABLE'
      AND cis."publishedVersion" IS NOT NULL
      AND ia.version = cis."publishedVersion"
  `;
  const officialCutouts = await prisma.$queryRaw`
    SELECT 'official' AS scope, oi."objectKey" AS key, oi.version, oi."officialBagId" AS id
    FROM "OfficialBagImage" oi
    JOIN "OfficialBagImageSide" ois
      ON ois."officialBagId" = oi."officialBagId" AND ois.side = oi.side
    WHERE oi.kind = 'CUTOUT' AND oi.status = 'AVAILABLE'
      AND ois."publishedVersion" IS NOT NULL
      AND oi.version = ois."publishedVersion"
  `;
  const officialTransparentStandard = await prisma.$queryRaw`
    SELECT 'official' AS scope, oi."objectKey" AS key, oi.version, oi."officialBagId" AS id
    FROM "OfficialBagImage" oi
    JOIN "OfficialBagImageSide" ois
      ON ois."officialBagId" = oi."officialBagId" AND ois.side = oi.side
    WHERE oi.kind = 'STANDARD' AND oi.status = 'AVAILABLE' AND oi."contentType" = 'image/png'
      AND ois."publishedVersion" IS NOT NULL
      AND oi.version = ois."publishedVersion"
      AND NOT EXISTS (
        SELECT 1 FROM "OfficialBagImage" c
        WHERE c."officialBagId" = oi."officialBagId" AND c.side = oi.side
          AND c.kind = 'CUTOUT' AND c.status = 'AVAILABLE'
      )
  `;
  return [...userCutouts, ...officialCutouts, ...officialTransparentStandard];
}

/** 单条目标：读源 → trim → 描边 → resize → 覆盖写 DISPLAY/THUMBNAIL → 更新 DB。 */
async function processTarget(target, params) {
  const base = baseOfKey(target.key);
  const displayKey = `${base}/display/v${target.version}.png`;
  const thumbnailKey = `${base}/thumbnail/v${target.version}.webp`;

  const source = await getObject(target.key);
  const trimmed = await trimTransparent(source);
  const stroked = params.ratio > 0 ? await addWhiteStroke(trimmed, params) : trimmed;

  const [display, thumbnail] = await Promise.all([
    sharp(stroked, { limitInputPixels: MAX_IMAGE_PIXELS })
      .resize({ width: 2048, height: 2048, fit: 'inside', withoutEnlargement: true })
      .png({ compressionLevel: 6 })
      .toBuffer({ resolveWithObject: true }),
    sharp(stroked, { limitInputPixels: MAX_IMAGE_PIXELS })
      .resize({ width: 512, height: 512, fit: 'inside', withoutEnlargement: true })
      .webp({ quality: 82, alphaQuality: 90 })
      .toBuffer({ resolveWithObject: true })
  ]);

  await putObject(displayKey, display.data, 'image/png');
  await putObject(thumbnailKey, thumbnail.data, 'image/webp');

  const displayMeta = {
    width: display.info.width,
    height: display.info.height,
    byteSize: BigInt(display.data.length),
    declaredByteSize: BigInt(display.data.length)
  };
  const thumbnailMeta = {
    width: thumbnail.info.width,
    height: thumbnail.info.height,
    byteSize: BigInt(thumbnail.data.length),
    declaredByteSize: BigInt(thumbnail.data.length)
  };
  if (target.scope === 'user') {
    await prisma.imageAsset.updateMany({ where: { objectKey: displayKey }, data: displayMeta });
    await prisma.imageAsset.updateMany({ where: { objectKey: thumbnailKey }, data: thumbnailMeta });
  } else {
    await prisma.officialBagImage.updateMany({ where: { objectKey: displayKey }, data: displayMeta });
    await prisma.officialBagImage.updateMany({ where: { objectKey: thumbnailKey }, data: thumbnailMeta });
  }

  return { displayKey, thumbnailKey };
}

/** 简单并发池：避免一次性把 COS 读 + sharp 编码全打满。 */
async function mapLimit(items, limit, fn) {
  const queue = [...items];
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (queue.length) await fn(queue.shift());
  });
  await Promise.all(workers);
}

async function main() {
  const params = await loadStrokeParams();
  if (params.ratio <= 0) {
    die('stroke.settings 的 ratio=0（描边关闭）。请先在后台「描边预览」页把 ratio 调到 > 0 再跑。');
  }

  const loaded = await loadTargets();
  const targets = SCOPE ? loaded.filter((t) => t.scope === SCOPE) : loaded;
  const byScope = { user: 0, official: 0 };
  for (const t of targets) byScope[t.scope]++;

  const urls = new Set();
  for (const t of targets) {
    const base = baseOfKey(t.key);
    urls.add(publicUrl(`${base}/display/v${t.version}.png`));
    urls.add(publicUrl(`${base}/thumbnail/v${t.version}.webp`));
  }
  const urlList = [...urls].sort();
  writeFileSync(URL_MANIFEST, urlList.join('\n') + '\n');

  console.log(
    JSON.stringify({
      event: 'stroke_backfill_targets',
      mode: EXECUTE ? 'execute' : 'dry-run',
      strokeParams: params,
      total: targets.length,
      user: byScope.user,
      official: byScope.official,
      refreshUrlCount: urlList.length,
      manifest: URL_MANIFEST
    })
  );

  if (!EXECUTE) {
    console.log('dry-run 结束：未写任何数据。确认无误后加 --execute 重跑。');
    return;
  }

  let ok = 0;
  let failed = 0;
  await mapLimit(targets, CONCURRENCY, async (t) => {
    try {
      const { displayKey } = await processTarget(t, params);
      ok++;
      console.log(`OK  ${displayKey}`);
    } catch (error) {
      failed++;
      console.error(`FAIL ${t.key} -> ${error instanceof Error ? error.message : String(error)}`);
    }
  });

  console.log(
    JSON.stringify({ event: 'stroke_backfill_done', ok, failed, manifest: URL_MANIFEST })
  );
  if (failed > 0) process.exitCode = 1;
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
