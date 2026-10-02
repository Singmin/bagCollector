import { AssetKind, AssetStatus, JobStatus, ProcessingStatus, PrismaClient } from '@prisma/client';
import sharp from 'sharp';
import { upsertAssetRecord } from './asset-record.js';
import { config } from './config.js';
import { computeCropRect } from './geometry.js';
import { createTencentCiBackgroundRemover } from './matting-tencent-ci.js';
import { deleteObjects, getObject, getSignedObjectUrl, putObject } from './object-store.js';

export interface ProcessingJobData {
  processingJobId: string;
  collectibleId: string;
  userId: string;
  version: number;
  /* 已抠图的图再次裁剪时为 true：worker 必须重新调万象抠图，否则新展示图与旧透明图在构图上失配。
     由 /crop 入口在「已有 CUTOUT 资产」时置位；同一张图只计一次万象扣费（配额在 /matte 入口计） */
  rematte?: boolean;
}

const prisma = new PrismaClient();

// 抠图实现只在模块加载时构建一次：并发限流器必须跨任务共享，不能每次调用都重建。
// 导出给官方袋子处理链路复用（官方库可选抠图，与用户链路使用同一实现与计费口径）。
export const removeBackground = createTencentCiBackgroundRemover(
  {
    process: config.CI_MATTING_PROCESS,
    timeoutMs: config.CI_MATTING_TIMEOUT_MS,
    maxResponseBytes: config.CI_MATTING_MAX_RESPONSE_BYTES,
    maxImagePixels: config.MAX_IMAGE_PIXELS,
    maxConcurrency: config.CI_MATTING_MAX_CONCURRENCY,
    sizeMode: config.CI_MATTING_SIZE_MODE,
    retry: config.CI_MATTING_RETRY
  },
  (objectKey, query) =>
    getSignedObjectUrl(objectKey, { query, expiresSeconds: config.CI_MATTING_SIGN_EXPIRES_SECONDS })
);

async function setRunning(jobId: string) {
  await prisma.processingJob.update({
    where: { id: jobId },
    data: { status: JobStatus.RUNNING, startedAt: new Date(), attemptCount: { increment: 1 }, errorMessage: null }
  });
}

async function setSucceeded(jobId: string) {
  await prisma.processingJob.update({
    where: { id: jobId },
    data: { status: JobStatus.SUCCEEDED, finishedAt: new Date(), errorMessage: null }
  });
}

async function upsertAsset(input: {
  userId: string;
  collectibleId: string;
  kind: AssetKind;
  key: string;
  contentType: string;
  body: Buffer;
  width: number;
  height: number;
  version: number;
}) {
  await putObject(input.key, input.body, input.contentType);
  await upsertAssetRecord(prisma, {
    userId: input.userId,
    collectibleId: input.collectibleId,
    kind: input.kind,
    key: input.key,
    contentType: input.contentType,
    byteSize: input.body.length,
    width: input.width,
    height: input.height,
    version: input.version
  });
}

/**
 * 裁掉抠图结果的透明边缘，让展示图/缩略图紧贴袋子实体 —— 否则画布留白会稀释
 * 前端按比例展示时的可见尺寸（与素材处理口径一致）。
 * 整图透明等极端情况（trim 后尺寸非法或解码失败）回退原图，不阻断出图。
 */
export async function trimTransparent(source: Buffer): Promise<Buffer> {
  try {
    const trimmed = await sharp(source, { limitInputPixels: config.MAX_IMAGE_PIXELS })
      .trim()
      .png()
      .toBuffer();
    const meta = await sharp(trimmed, { limitInputPixels: config.MAX_IMAGE_PIXELS }).metadata();
    if (meta.width && meta.height && meta.width > 0 && meta.height > 0) return trimmed;
    return source;
  } catch {
    return source;
  }
}

async function writeRenditions(data: ProcessingJobData, source: Buffer, baseKey: string, options: { trim: boolean }) {
  /* 只有抠图结果（带透明边）才 trim 白/透明边；普通裁剪图是实拍照片，trim 会啃掉画面边缘 */
  const trimmed = options.trim ? await trimTransparent(source) : source;
  // 展示图与缩略图互不依赖，并行编码，避免白白多等一轮 CPU。
  const [display, thumbnail] = await Promise.all([
    sharp(trimmed, { limitInputPixels: config.MAX_IMAGE_PIXELS })
      .resize({ width: 2048, height: 2048, fit: 'inside', withoutEnlargement: true })
      .png({ compressionLevel: 6 })
      .toBuffer({ resolveWithObject: true }),
    sharp(trimmed, { limitInputPixels: config.MAX_IMAGE_PIXELS })
      .resize({ width: 512, height: 512, fit: 'inside', withoutEnlargement: true })
      .webp({ quality: 82, alphaQuality: 90 })
      .toBuffer({ resolveWithObject: true })
  ]);
  if (!display.info.width || !display.info.height) throw new Error('无法读取展示图尺寸');
  if (!thumbnail.info.width || !thumbnail.info.height) throw new Error('无法读取缩略图尺寸');
  await Promise.all([
    upsertAsset({
      ...data,
      kind: AssetKind.DISPLAY,
      key: `${baseKey}/display/v${data.version}.png`,
      contentType: 'image/png',
      body: display.data,
      width: display.info.width,
      height: display.info.height
    }),
    upsertAsset({
      ...data,
      kind: AssetKind.THUMBNAIL,
      key: `${baseKey}/thumbnail/v${data.version}.webp`,
      contentType: 'image/webp',
      body: thumbnail.data,
      width: thumbnail.info.width,
      height: thumbnail.info.height
    })
  ]);
}

/** 标准化产物：统一 ≤4096px，透明输入可保留 alpha（PNG），其余为白底 JPEG。 */
export interface StandardImage {
  body: Buffer;
  width: number;
  height: number;
  contentType: 'image/jpeg' | 'image/png';
  extension: 'jpg' | 'png';
}

/**
 * 原图标准化为 ≤4096px 的图片，供裁剪/抠图/展示链路复用。
 *
 * - 默认输出 JPEG：用户链路标准化后必然走裁剪 + 万象抠图，透明度由抠图重新生成，
 *   JPEG 体积小且抠图输入更稳定。JPEG 不支持透明通道，透明像素先铺成白色
 *   （sharp 默认合成到黑色背景，会导致黑底）。
 * - `keepTransparency: true` 且原图带 alpha 时输出 PNG：官方库常直接上传现成的
 *   透明素材，未开抠图时若转 JPEG 会丢掉透明度；PNG 超过 10MB 时回退白底 JPEG，
 *   维持既有的标准图体积预算。
 */
export async function standardImage(
  source: Buffer,
  options: { keepTransparency?: boolean } = {}
): Promise<StandardImage> {
  const base = sharp(source, { limitInputPixels: config.MAX_IMAGE_PIXELS }).rotate().resize({
    width: 4096,
    height: 4096,
    fit: 'inside',
    withoutEnlargement: true
  });

  if (options.keepTransparency) {
    const metadata = await sharp(source, { limitInputPixels: config.MAX_IMAGE_PIXELS }).metadata();
    if (metadata.hasAlpha) {
      const { data, info } = await base
        .clone()
        .png({ compressionLevel: 6 })
        .toBuffer({ resolveWithObject: true });
      if (!info.width || !info.height) throw new Error('无法读取标准图尺寸');
      if (data.length <= 10_000_000) {
        return { body: data, width: info.width, height: info.height, contentType: 'image/png', extension: 'png' };
      }
      // 超出体积预算的透明图回退白底 JPEG，避免标准图无限膨胀。
    }
  }

  const flattened = base.flatten({ background: { r: 255, g: 255, b: 255 } });
  for (const quality of [90, 84, 78, 72]) {
    // resolveWithObject 直接带回输出尺寸，省掉一次完整 JPEG 解码。
    const { data, info } = await flattened.clone().jpeg({ quality, mozjpeg: true }).toBuffer({ resolveWithObject: true });
    if (!info.width || !info.height) throw new Error('无法读取标准图尺寸');
    if (data.length <= 10_000_000 || quality === 72) {
      return { body: data, width: info.width, height: info.height, contentType: 'image/jpeg', extension: 'jpg' };
    }
  }
  throw new Error('图片标准化失败');
}

export async function normalizeImage(data: ProcessingJobData) {
  await setRunning(data.processingJobId);
  const original = await prisma.imageAsset.findFirstOrThrow({
    where: {
      collectibleId: data.collectibleId,
      userId: data.userId,
      kind: AssetKind.ORIGINAL,
      version: data.version,
      status: AssetStatus.AVAILABLE
    },
    orderBy: { createdAt: 'desc' }
  });
  const source = await getObject(original.objectKey);
  // 用户链路标准化后必然走裁剪 + 抠图，透明度由抠图重新生成，统一白底 JPEG。
  const standard = await standardImage(source);
  const key = `users/${data.userId}/collectibles/${data.collectibleId}/standard/v${data.version}.${standard.extension}`;
  await upsertAsset({
    ...data,
    ...standard,
    kind: AssetKind.STANDARD,
    key
  });
  await prisma.collectible.update({
    where: { id: data.collectibleId },
    data: { processingStatus: ProcessingStatus.AWAITING_CROP, processingError: null }
  });
  await setSucceeded(data.processingJobId);
}

/**
 * 用腾讯云数据万象「下载时处理」产出与裁剪图严格对位的透明 PNG。
 *
 * 裁剪图必须先落到 COS，万象才读得到它；万象按原图分辨率抠图，没有模型输入边长限制，
 * 因此这里不需要降采样送推理再回放大掩码。
 */
async function produceCutout(input: {
  croppedKey: string;
  croppedAsset: Promise<void>;
  rect: { width: number; height: number };
}) {
  await input.croppedAsset;
  return removeBackground({
    objectKey: input.croppedKey,
    width: input.rect.width,
    height: input.rect.height
  });
}

/** 两条流水线（只裁剪 / 裁剪+抠图）共用的第一步：按 Collectible 上保存的裁剪参数
 *  旋转 → 裁剪 → 调色，产出裁剪图并写入 CROPPED 资产。返回万象需要的全部上下文。 */
async function cropToAsset(data: ProcessingJobData) {
  await setRunning(data.processingJobId);
  const [collectible, standard] = await Promise.all([
    prisma.collectible.findFirstOrThrow({ where: { id: data.collectibleId, userId: data.userId } }),
    prisma.imageAsset.findFirstOrThrow({
      where: {
        collectibleId: data.collectibleId,
        userId: data.userId,
        kind: AssetKind.STANDARD,
        status: AssetStatus.AVAILABLE,
        version: { lte: data.version }
      },
      orderBy: { version: 'desc' }
    })
  ]);
  if (
    collectible.cropX === null ||
    collectible.cropY === null ||
    collectible.cropWidth === null ||
    collectible.cropHeight === null ||
    collectible.cropRotation === null
  ) {
    throw new Error('缺少裁剪参数');
  }
  const source = await getObject(standard.objectKey);
  /* P1：任意角度旋转（非 90° 倍数时必须给 background 补角，这里用白底，输出 JPEG 无透明通道） */
  const rotated = sharp(source, { limitInputPixels: config.MAX_IMAGE_PIXELS })
    .rotate(collectible.cropRotation ?? 0, { background: '#ffffff' });
  const metadata = await rotated.metadata();
  if (!metadata.width || !metadata.height) throw new Error('无法读取裁剪图尺寸');
  const rect = computeCropRect(metadata.width, metadata.height, {
    x: collectible.cropX,
    y: collectible.cropY,
    width: collectible.cropWidth,
    height: collectible.cropHeight
  });
  /* 「认领官方袋子」复制过来的标准图可能是透明 PNG —— 裁剪图要送万象抠图，
     先铺白底再出 JPEG，避免透明像素被合成成黑底。
     P2：调色在裁剪之后做（与前端预览同一顺序），缺省 1 = 不调整 */
  const brightness = collectible.cropBrightness ?? 1;
  const contrast = collectible.cropContrast ?? 1;
  const saturation = collectible.cropSaturation ?? 1;
  let pipeline = rotated.extract(rect).flatten({ background: { r: 255, g: 255, b: 255 } });
  if (brightness !== 1 || saturation !== 1) pipeline = pipeline.modulate({ brightness, saturation });
  if (contrast !== 1) pipeline = pipeline.linear(contrast, -(128 * contrast) + 128); // 标准对比度公式
  const cropped = await pipeline.jpeg({ quality: 90, mozjpeg: true }).toBuffer();
  const croppedKey = `users/${data.userId}/collectibles/${data.collectibleId}/cropped/v${data.version}.jpg`;
  const baseKey = `users/${data.userId}/collectibles/${data.collectibleId}`;
  // 裁剪图必须先写入存储并在 COS 上可见，万象才读得到它。
  // 这里立刻挂一个空 catch，否则失败时会触发未处理拒绝，真正的错误在调用方 await 时抛出。
  const croppedAsset = upsertAsset({
    ...data,
    kind: AssetKind.CROPPED,
    key: croppedKey,
    contentType: 'image/jpeg',
    body: cropped,
    width: rect.width,
    height: rect.height
  });
  croppedAsset.catch(() => undefined);
  return { collectible, cropped, croppedKey, croppedAsset, rect, baseKey };
}

/** 裁剪（POST /collectibles/:id/crop 的 CROP 任务）。
 *  常规：不调万象，展示图/缩略图直接由裁剪图派生（不写 CUTOUT）；
 *  rematte：该图已抠过图，再次裁剪必须重新抠图，否则新展示图与旧透明图在构图上失配——
 *  复用 matte 流水线（万象重抠一次），产出 CUTOUT + 裁剪后的展示图。 */
export async function cropImage(data: ProcessingJobData) {
  const { croppedKey, croppedAsset, cropped, rect, baseKey } = await cropToAsset(data);
  await croppedAsset;
  if (data.rematte) {
    const cutout = await produceCutout({ croppedKey, croppedAsset, rect });
    await Promise.all([
      upsertAsset({
        ...data,
        kind: AssetKind.CUTOUT,
        key: `${baseKey}/cutout/v${data.version}.png`,
        contentType: 'image/png',
        body: cutout,
        width: rect.width,
        height: rect.height
      }),
      writeRenditions(data, cutout, baseKey, { trim: true })
    ]);
  } else {
    await writeRenditions(data, cropped, baseKey, { trim: false });
  }
  await prisma.collectible.update({
    where: { id: data.collectibleId },
    data: { processingStatus: ProcessingStatus.READY, processingError: null }
  });
  await setSucceeded(data.processingJobId);
}

/** 裁剪 + 抠图（POST /collectibles/:id/matte 的 MATTING 任务） */
export async function matImage(data: ProcessingJobData) {
  const { croppedKey, croppedAsset, rect, baseKey } = await cropToAsset(data);

  const cutout = await produceCutout({ croppedKey, croppedAsset, rect });

  // 抠图结果尺寸已由万象实现按裁剪图尺寸校验过，无需再解码确认。
  await Promise.all([
    upsertAsset({
      ...data,
      kind: AssetKind.CUTOUT,
      key: `${baseKey}/cutout/v${data.version}.png`,
      contentType: 'image/png',
      body: cutout,
      width: rect.width,
      height: rect.height
    }),
    writeRenditions(data, cutout, baseKey, { trim: true })
  ]);

  await prisma.collectible.update({
    where: { id: data.collectibleId },
    data: { processingStatus: ProcessingStatus.READY, processingError: null }
  });
  await setSucceeded(data.processingJobId);
}

export async function failProcessing(data: ProcessingJobData, error: unknown) {
  const message = error instanceof Error ? error.message.slice(0, 500) : '图片处理失败';
  await prisma.$transaction([
    prisma.processingJob.update({
      where: { id: data.processingJobId },
      data: { status: JobStatus.FAILED, errorMessage: message, finishedAt: new Date() }
    }),
    prisma.collectible.update({
      where: { id: data.collectibleId },
      data: { processingStatus: ProcessingStatus.FAILED, processingError: message }
    })
  ]);
}

/**
 * 卡死对账：NORMALIZING/MATTING 超过阈值说明任务没被消费，翻成 FAILED 让用户可见并
 * 可重新触发。AWAITING_CROP 是在等用户裁剪，可能合法停留很久，不参与对账。
 */
export async function reconcileStuckProcessing(stuckBefore: Date) {
  const result = await prisma.collectible.updateMany({
    where: {
      processingStatus: { in: [ProcessingStatus.NORMALIZING, ProcessingStatus.MATTING] },
      updatedAt: { lt: stuckBefore }
    },
    data: { processingStatus: ProcessingStatus.FAILED, processingError: '处理超时，请重新上传图片' }
  });
  if (result.count > 0) {
    console.warn(JSON.stringify({ event: 'reconcile_stuck_collectible', count: result.count }));
  }
  return result.count;
}

/**
 * 被遗弃上传对账：UPLOADING 且没有任何图片资产、又超过阈值（ABANDONED_UPLOAD_MS，
 * 默认 24h）的记录是「建了记录但图永远不会来」的残骸 —— 典型来源是旧版小程序的
 * 「标记已有」误走拍照上传接口（POST /collectibles 建完记录就关页面，图根本不会传）。
 * 这类记录在收藏列表里不可见（列表只返回 READY），却占着用户的收藏配额，直接删除；
 * CollectibleTag / ImageAsset / ProcessingJob 由数据库级联清理。
 * 认领得到的记录起步是 NORMALIZING，理论上不会是 UPLOADING，但 OfficialClaim 没有
 * 外键，删除前仍排除已被认领引用的记录，避免孤儿认领行。
 */
export async function reconcileAbandonedUploads(before: Date) {
  const candidates = await prisma.collectible.findMany({
    where: {
      processingStatus: ProcessingStatus.UPLOADING,
      updatedAt: { lt: before },
      imageAssets: { none: {} }
    },
    select: { id: true }
  });
  if (!candidates.length) return 0;
  const claimed = await prisma.officialClaim.findMany({
    where: { collectibleId: { in: candidates.map((row) => row.id) } },
    select: { collectibleId: true }
  });
  const claimedIds = new Set(claimed.map((row) => row.collectibleId));
  const doomed = candidates.map((row) => row.id).filter((id) => !claimedIds.has(id));
  if (!doomed.length) return 0;
  const result = await prisma.collectible.deleteMany({ where: { id: { in: doomed } } });
  if (result.count > 0) {
    console.warn(JSON.stringify({ event: 'reconcile_abandoned_upload', count: result.count }));
  }
  return result.count;
}

export async function cleanup(keys: string[]) {
  if (keys.length) await deleteObjects(keys);
}

export async function closeProcessor() {
  await prisma.$disconnect();
}
