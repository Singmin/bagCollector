import { AssetKind, AssetStatus, ImageSide, JobStatus, ProcessingStatus, PrismaClient } from '@prisma/client';
import sharp from 'sharp';
import type { ImageCrop } from '@bagcollect/contracts';
import { addWhiteStroke, DEFAULT_STROKE_PARAMS, strokeParamsSchema, type StrokeParams } from '@bagcollect/stroke';
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
  side?: ImageSide;
  sourceVersion?: number;
  crop?: ImageCrop;
  /* 已抠图的图再次裁剪时为 true：worker 必须重新调万象抠图，否则新展示图与旧透明图在构图上失配。
     由 /crop 入口在「已有 CUTOUT 资产」时置位；首次抠图计用户配额；重裁剪仍再次产生云服务成本 */
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
  side?: ImageSide;
  sourceVersion?: number;
  crop?: ImageCrop;
}) {
  await putObject(input.key, input.body, input.contentType);
  try { await upsertAssetRecord(prisma, {
    userId: input.userId,
    collectibleId: input.collectibleId,
    kind: input.kind,
    side: input.side ?? ImageSide.FRONT, sourceVersion: input.sourceVersion,
    key: input.key,
    contentType: input.contentType,
    byteSize: input.body.length,
    width: input.width,
    height: input.height,
    version: input.version
  }); } catch (error) {
    if (error instanceof Error && error.message === 'STALE_IMAGE_JOB') await deleteObjects([input.key]);
    throw error;
  }
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

/* 描边参数缓存：描边是每个抠图结果的必经路径，参数又是运营低频调整的配置，
   加 30s 短 TTL 缓存，避免每次描边都多一次 DB 往返，同时「后台改完很快生效」。 */
let strokeParamsCache: { value: StrokeParams; at: number } | null = null;
const STROKE_CACHE_TTL_MS = 30_000;

/** 读取白描边参数（存 AppSetting，后台「描边预览」页可改）。库里没有或脏数据时回退默认。
 *  导出给官方袋子链路复用：官方库可选抠图，描边口径与用户链路保持一致。 */
export async function getStrokeParams(): Promise<StrokeParams> {
  const now = Date.now();
  if (strokeParamsCache && now - strokeParamsCache.at < STROKE_CACHE_TTL_MS) return strokeParamsCache.value;
  const row = await prisma.appSetting.findUnique({ where: { key: 'stroke.settings' } });
  let params = DEFAULT_STROKE_PARAMS;
  try {
    params = strokeParamsSchema.parse({ ...DEFAULT_STROKE_PARAMS, ...(row ? JSON.parse(row.value) : {}) });
  } catch {
    params = { ...DEFAULT_STROKE_PARAMS };
  }
  strokeParamsCache = { value: params, at: now };
  return params;
}

async function writeRenditions(data: ProcessingJobData, source: Buffer, baseKey: string, options: { trim: boolean }) {
  /* 只有抠图结果（带透明边）才 trim 白/透明边；普通裁剪图是实拍照片，trim 会啃掉画面边缘 */
  const trimmed = options.trim ? await trimTransparent(source) : source;
  /* 白描边（贴纸效果）只作用于抠图结果；普通裁剪图是实拍照片，不该加描边。
     在 resize 前统一加一次，等比缩放后 display/thumbnail 的描边与主体比例保持一致。
     参数来自 AppSetting（后台「描边预览」页），ratio=0 时关闭描边。 */
  const strokeParams = options.trim ? await getStrokeParams() : null;
  const hasStroke = Boolean(strokeParams && strokeParams.ratio > 0);
  const stroked = hasStroke ? await addWhiteStroke(trimmed, strokeParams!) : trimmed;
  /* 无白边版（DISPLAY_PLAIN/THUMBNAIL_PLAIN）：只在「实际加了白边」时派生。
     素材就是 trim 后未描边的同一张透明图 —— 白边是最后才画上去的，源图仍在手边，
     直接复用即可，无需重新 trim。 */
  const plain = hasStroke ? trimmed : null;
  // 展示图与缩略图互不依赖，并行编码，避免白白多等一轮 CPU。
  const encode = (material: Buffer) => Promise.all([
    sharp(material, { limitInputPixels: config.MAX_IMAGE_PIXELS })
      .resize({ width: 2048, height: 2048, fit: 'inside', withoutEnlargement: true })
      .png({ compressionLevel: 6 })
      .toBuffer({ resolveWithObject: true }),
    sharp(material, { limitInputPixels: config.MAX_IMAGE_PIXELS })
      .resize({ width: 512, height: 512, fit: 'inside', withoutEnlargement: true })
      .webp({ quality: 82, alphaQuality: 90 })
      .toBuffer({ resolveWithObject: true })
  ]);
  const [display, thumbnail] = await encode(stroked);
  const plainPair = plain ? await encode(plain) : null;
  if (!display.info.width || !display.info.height) throw new Error('无法读取展示图尺寸');
  if (!thumbnail.info.width || !thumbnail.info.height) throw new Error('无法读取缩略图尺寸');
  /* 串行写库：资产落库走 Serializable 事务并对同一 User/Collectible 行 FOR UPDATE，
     并行提交会在等锁醒来时抛 40001 序列化冲突，图片编码（上面的 sharp）已并行，这里不求快求稳 */
  await upsertAsset({
    ...data,
    kind: AssetKind.DISPLAY,
    key: `${baseKey}/display/v${data.version}.png`,
    contentType: 'image/png',
    body: display.data,
    width: display.info.width,
    height: display.info.height
  });
  await upsertAsset({
    ...data,
    kind: AssetKind.THUMBNAIL,
    key: `${baseKey}/thumbnail/v${data.version}.webp`,
    contentType: 'image/webp',
    body: thumbnail.data,
    width: thumbnail.info.width,
    height: thumbnail.info.height
  });
  if (plainPair) {
    /* 无白边版是「可选增强产物」：主图（DISPLAY/THUMBNAIL）已成功落库后，无白边版写库失败
       （最常见是用户存储配额不足 —— upsertAssetRecord 有硬配额检查）绝不能反过来让整张图失败。
       这里降级处理：吞掉异常，前端拿不到 plain 字段会自动回退到有白边版。 */
    try {
      const [plainDisplay, plainThumbnail] = plainPair;
      if (!plainDisplay.info.width || !plainDisplay.info.height) throw new Error('无法读取无白边展示图尺寸');
      if (!plainThumbnail.info.width || !plainThumbnail.info.height) throw new Error('无法读取无白边缩略图尺寸');
      await upsertAsset({
        ...data,
        kind: AssetKind.DISPLAY_PLAIN,
        key: `${baseKey}/display-plain/v${data.version}.png`,
        contentType: 'image/png',
        body: plainDisplay.data,
        width: plainDisplay.info.width,
        height: plainDisplay.info.height
      });
      await upsertAsset({
        ...data,
        kind: AssetKind.THUMBNAIL_PLAIN,
        key: `${baseKey}/thumbnail-plain/v${data.version}.webp`,
        contentType: 'image/webp',
        body: plainThumbnail.data,
        width: plainThumbnail.info.width,
        height: plainThumbnail.info.height
      });
    } catch (error) {
      console.warn(`[writeRenditions] 无白边版写入失败，降级为仅有白边版：collectible=${data.collectibleId} side=${data.side ?? 'FRONT'} v${data.version}`, error instanceof Error ? error.message : error);
    }
  }
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
 * - 默认输出 JPEG：用户链路标准化后可裁剪，并可选择万象抠图，透明度由抠图生成，
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
      side: data.side ?? ImageSide.FRONT,
      kind: AssetKind.ORIGINAL,
      version: data.sourceVersion ?? data.version,
      status: AssetStatus.AVAILABLE
    },
    orderBy: { createdAt: 'desc' }
  });
  const source = await getObject(original.objectKey);
  // 用户链路统一白底 JPEG，后续裁剪和抠图分别按用户选择执行。
  const standard = await standardImage(source);
  const key = `users/${data.userId}/collectibles/${data.collectibleId}/${(data.side ?? ImageSide.FRONT).toLowerCase()}/standard/v${data.version}.${standard.extension}`;
  await upsertAsset({
    ...data,
    ...standard,
    kind: AssetKind.STANDARD,
    key
  });
  if (data.sourceVersion !== undefined) {
    await prisma.$transaction(async tx => {
      await tx.$queryRaw`SELECT "id" FROM "Collectible" WHERE "id" = ${data.collectibleId} FOR UPDATE`;
      const changed = await tx.collectibleImageSide.updateMany({ where: { collectibleId: data.collectibleId, side: data.side ?? ImageSide.FRONT, sourceVersion: data.sourceVersion, processingVersion: data.version }, data: { processingStatus: ProcessingStatus.AWAITING_CROP, processingError: null } });
      if (!changed.count) throw new Error('STALE_IMAGE_JOB');
      const state = await tx.collectibleImageSide.findUniqueOrThrow({ where: { collectibleId_side: { collectibleId: data.collectibleId, side: data.side ?? ImageSide.FRONT } } });
      if ((data.side ?? ImageSide.FRONT) === ImageSide.FRONT) await tx.collectible.update({ where: { id: data.collectibleId }, data: { processingStatus: state.publishedVersion ? ProcessingStatus.READY : ProcessingStatus.AWAITING_CROP, processingError: null } });
    });
  } else await prisma.collectible.update({ where: { id: data.collectibleId }, data: { processingStatus: ProcessingStatus.AWAITING_CROP, processingError: null } });
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
  const collectible = await prisma.collectible.findFirstOrThrow({ where: { id: data.collectibleId, userId: data.userId } });
  const ownStandard = await prisma.imageAsset.findFirst({
    where: {
      collectibleId: data.collectibleId,
      userId: data.userId,
      side: data.side ?? ImageSide.FRONT,
      kind: AssetKind.STANDARD,
      status: AssetStatus.AVAILABLE,
      version: data.sourceVersion !== undefined ? data.sourceVersion : { lte: data.version }
    },
    orderBy: { version: 'desc' }
  });
  /* 认领的官方袋子不再复制图片到用户名下：标准图回退到官方库（同 COS，objectKey 可直接读） */
  let standard: { objectKey: string } | null = ownStandard;
  if (!standard && collectible.sourceOfficialBagId) {
    standard = await prisma.officialBagImage.findFirst({
      where: { officialBagId: collectible.sourceOfficialBagId, kind: AssetKind.STANDARD, status: AssetStatus.AVAILABLE },
      orderBy: { version: 'desc' }
    });
  }
  if (!standard) throw new Error('缺少标准图');
  if (data.crop) Object.assign(collectible, { cropX: data.crop.x, cropY: data.crop.y, cropWidth: data.crop.width, cropHeight: data.crop.height, cropRotation: data.crop.rotation, cropBrightness: data.crop.brightness, cropContrast: data.crop.contrast, cropSaturation: data.crop.saturation });
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
  // metadata() describes the input, not the dimensions after rotation. Materialize
  // raw pixels so crop coordinates use the actual rotated bounds, without JPEG re-encoding.
  const rotated = await sharp(source, { limitInputPixels: config.MAX_IMAGE_PIXELS })
    .rotate(collectible.cropRotation ?? 0, { background: '#ffffff' }).raw().toBuffer({ resolveWithObject: true });
  const metadata = rotated.info;
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
  let pipeline = sharp(rotated.data, { raw: { width: metadata.width, height: metadata.height, channels: metadata.channels } }).extract(rect).flatten({ background: { r: 255, g: 255, b: 255 } });
  if (brightness !== 1 || saturation !== 1) pipeline = pipeline.modulate({ brightness, saturation });
  if (contrast !== 1) pipeline = pipeline.linear(contrast, -(128 * contrast) + 128); // 标准对比度公式
  const cropped = await pipeline.jpeg({ quality: 90, mozjpeg: true }).toBuffer();
  const croppedKey = `users/${data.userId}/collectibles/${data.collectibleId}/${(data.side ?? ImageSide.FRONT).toLowerCase()}/cropped/v${data.version}.jpg`;
  const baseKey = `users/${data.userId}/collectibles/${data.collectibleId}/${(data.side ?? ImageSide.FRONT).toLowerCase()}`;
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
    /* 串行写库，理由同 writeRenditions：避免同收藏并行 Serializable 事务互撞（40001） */
    await upsertAsset({
      ...data,
      kind: AssetKind.CUTOUT,
      key: `${baseKey}/cutout/v${data.version}.png`,
      contentType: 'image/png',
      body: cutout,
      width: rect.width,
      height: rect.height
    });
    await writeRenditions(data, cutout, baseKey, { trim: true });
  } else {
    await writeRenditions(data, cropped, baseKey, { trim: false });
  }
  await publishSide(data, !!data.rematte);
  await setSucceeded(data.processingJobId);
}

/** 裁剪 + 抠图（POST /collectibles/:id/matte 的 MATTING 任务） */
export async function matImage(data: ProcessingJobData) {
  const { croppedKey, croppedAsset, rect, baseKey } = await cropToAsset(data);

  const cutout = await produceCutout({ croppedKey, croppedAsset, rect });

  // 抠图结果尺寸已由万象实现按裁剪图尺寸校验过，无需再解码确认。
  /* 串行写库，理由同 writeRenditions：避免同收藏并行 Serializable 事务互撞（40001） */
  await upsertAsset({
    ...data,
    kind: AssetKind.CUTOUT,
    key: `${baseKey}/cutout/v${data.version}.png`,
    contentType: 'image/png',
    body: cutout,
    width: rect.width,
    height: rect.height
  });
  await writeRenditions(data, cutout, baseKey, { trim: true });

  await publishSide(data, true);
  await setSucceeded(data.processingJobId);
}

async function publishSide(data: ProcessingJobData, matted: boolean) {
  if (data.sourceVersion === undefined) {
    await prisma.collectible.update({ where: { id: data.collectibleId }, data: { processingStatus: ProcessingStatus.READY, processingError: null } });
    return;
  }
  await prisma.$transaction(async tx => {
    await tx.$queryRaw`SELECT "id" FROM "Collectible" WHERE "id" = ${data.collectibleId} FOR UPDATE`;
    const changed = await tx.collectibleImageSide.updateMany({ where: { collectibleId: data.collectibleId, side: data.side ?? ImageSide.FRONT, sourceVersion: data.sourceVersion, processingVersion: data.version }, data: { publishedVersion: data.version, publishedSourceVersion: data.sourceVersion, processingStatus: ProcessingStatus.READY, processingError: null, ...(matted ? { mattedSourceVersion: data.sourceVersion } : {}) } });
    if (!changed.count) throw new Error('STALE_IMAGE_JOB');
    if ((data.side ?? ImageSide.FRONT) === ImageSide.FRONT) await tx.collectible.update({ where: { id: data.collectibleId }, data: { processingStatus: ProcessingStatus.READY, processingError: null } });
  });
}

export async function failProcessing(data: ProcessingJobData, error: unknown) {
  const message = error instanceof Error ? error.message.slice(0, 500) : '图片处理失败';
  if (data.sourceVersion === undefined) {
    await prisma.$transaction([
      prisma.processingJob.update({ where: { id: data.processingJobId }, data: { status: JobStatus.FAILED, errorMessage: message, finishedAt: new Date() } }),
      prisma.collectible.update({ where: { id: data.collectibleId }, data: { processingStatus: ProcessingStatus.FAILED, processingError: message } })
    ]);
    return;
  }
  await prisma.$transaction(async tx => {
    await tx.$queryRaw`SELECT "id" FROM "Collectible" WHERE "id" = ${data.collectibleId} FOR UPDATE`;
    await tx.processingJob.updateMany({ where: { id: data.processingJobId }, data: { status: JobStatus.FAILED, errorMessage: message, finishedAt: new Date() } });
    const changed = await tx.collectibleImageSide.updateMany({ where: { collectibleId: data.collectibleId, side: data.side ?? ImageSide.FRONT, processingVersion: data.version, sourceVersion: data.sourceVersion }, data: { processingStatus: ProcessingStatus.FAILED, processingError: message } });
    if (changed.count && (data.side ?? ImageSide.FRONT) === ImageSide.FRONT) {
      const state = await tx.collectibleImageSide.findUniqueOrThrow({ where: { collectibleId_side: { collectibleId: data.collectibleId, side: ImageSide.FRONT } } });
      await tx.collectible.update({ where: { id: data.collectibleId }, data: { processingStatus: state.publishedVersion ? ProcessingStatus.READY : ProcessingStatus.FAILED, processingError: message } });
    }
  });
}

/**
 * 卡死对账：NORMALIZING/MATTING 超过阈值说明任务没被消费，翻成 FAILED 让用户可见并
 * 可重新触发。AWAITING_CROP 是在等用户裁剪，可能合法停留很久，不参与对账。
 */
export async function reconcileStuckProcessing(stuckBefore: Date) {
  const stuck = await prisma.collectibleImageSide.findMany({ where: { processingStatus: { in: [ProcessingStatus.NORMALIZING, ProcessingStatus.CROPPING, ProcessingStatus.MATTING, ProcessingStatus.UPLOADING] }, sourceVersion: { gt: 0 }, updatedAt: { lt: stuckBefore } } });
  let count = 0;
  for (const state of stuck) {
    const jobs = await prisma.processingJob.findMany({ where: { collectibleId: state.collectibleId, side: state.side, version: state.processingVersion, status: { in: [JobStatus.QUEUED, JobStatus.RUNNING] } } });
    for (const job of jobs) await failProcessing({ processingJobId: job.id, collectibleId: job.collectibleId, userId: job.userId, side: state.side, version: state.processingVersion, sourceVersion: state.sourceVersion }, new Error('处理超时，请重试或重新上传图片'));
    if (!jobs.length) await prisma.$transaction(async tx => {
      await tx.$queryRaw`SELECT "id" FROM "Collectible" WHERE "id" = ${state.collectibleId} FOR UPDATE`;
      const message = '上传超时，请重新选择图片';
      const changed = await tx.collectibleImageSide.updateMany({ where: { collectibleId: state.collectibleId, side: state.side, processingVersion: state.processingVersion, processingStatus: state.processingStatus, updatedAt: { lt: stuckBefore } }, data: { processingStatus: ProcessingStatus.FAILED, processingError: message } });
      if (changed.count && state.side === ImageSide.FRONT) await tx.collectible.update({ where: { id: state.collectibleId }, data: { processingStatus: state.publishedVersion !== null ? ProcessingStatus.READY : ProcessingStatus.FAILED, processingError: message } });
    });
    count++;
  }
  const result = { count };
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

/**
 * 被遗弃裁剪对账：AWAITING_CROP 且超过阈值（ABANDONED_CROP_MS，默认 1h）的记录，
 * 是「用户上传并标准化完成、却在「确定添加」之前退出」的死数据 —— 收藏列表只返回 READY、
 * 又没有继续编辑入口，用户永远不会再回到这个状态。这类记录不再进审核列表（见
 * submissions-admin.service），这里连同 COS 对象一起删除，并归还 storageUsedBytes 配额。
 * CollectibleTag / CollectibleImageSide / ImageAsset / ProcessingJob 由数据库级联清理。
 * 排除被扫描（MatchScan）或认领（OfficialClaim）引用的记录：前者由 cleanupScans 处理，
 * 后者有 sourceOfficialBagId（天然被过滤），避免重复删除或留下悬空引用。
 */
export async function reconcileAbandonedCrops(before: Date) {
  const candidates = await prisma.collectible.findMany({
    where: {
      processingStatus: ProcessingStatus.AWAITING_CROP,
      sourceOfficialBagId: null,
      promotedBagId: null,
      updatedAt: { lt: before }
    },
    select: { id: true, userId: true }
  });
  if (!candidates.length) return 0;

  const candidateIds = candidates.map((row) => row.id);
  const [scanRefs, claimRefs] = await Promise.all([
    prisma.matchScan.findMany({ where: { collectibleId: { in: candidateIds } }, select: { collectibleId: true } }),
    prisma.officialClaim.findMany({ where: { collectibleId: { in: candidateIds } }, select: { collectibleId: true } })
  ]);
  const referenced = new Set([...scanRefs, ...claimRefs].map((row) => row.collectibleId));
  const doomed = candidates.filter((row) => !referenced.has(row.id));
  if (!doomed.length) return 0;

  let deleted = 0;
  for (const row of doomed) {
    // 事务里锁行、再确认仍是 AWAITING_CROP（期间可能被推进到 READY），
    // 然后收集对象键与字节数、删收藏、归还配额；对象删除放在事务成功后，
    // 保证「先删库后删对象」失败时对象仍可被发现回收（与 cleanupScans 同口径）。
    const keys = await prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT "id" FROM "Collectible" WHERE "id" = ${row.id} FOR UPDATE`;
      const current = await tx.collectible.findFirst({
        where: { id: row.id, processingStatus: ProcessingStatus.AWAITING_CROP, sourceOfficialBagId: null, promotedBagId: null },
        include: { imageAssets: true }
      });
      if (!current) return [];
      const assetKeys = current.imageAssets.map((asset) => asset.objectKey);
      const bytes = current.imageAssets.reduce((sum, asset) => sum + (asset.status === AssetStatus.AVAILABLE ? asset.byteSize : 0n), 0n);
      await tx.collectible.delete({ where: { id: row.id } });
      await tx.$executeRaw`UPDATE "User" SET "storageUsedBytes" = GREATEST(0, "storageUsedBytes" - ${bytes}) WHERE "id" = ${row.userId}`;
      return assetKeys;
    });
    if (keys.length) await deleteObjects(keys);
    deleted++;
  }
  if (deleted > 0) {
    console.warn(JSON.stringify({ event: 'reconcile_abandoned_crop', count: deleted }));
  }
  return deleted;
}

export async function cleanup(keys: string[]) {
  if (keys.length) await deleteObjects(keys);
}

export async function closeProcessor() {
  await prisma.$disconnect();
}
