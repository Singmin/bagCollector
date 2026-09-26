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
}

const prisma = new PrismaClient();

// 抠图实现只在模块加载时构建一次：并发限流器必须跨任务共享，不能每次调用都重建。
const removeBackground = createTencentCiBackgroundRemover(
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
async function trimTransparent(source: Buffer): Promise<Buffer> {
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

async function writeRenditions(data: ProcessingJobData, source: Buffer, baseKey: string) {
  const trimmed = await trimTransparent(source);
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

async function standardJpeg(source: Buffer) {
  const base = sharp(source, { limitInputPixels: config.MAX_IMAGE_PIXELS }).rotate().resize({
    width: 4096,
    height: 4096,
    fit: 'inside',
    withoutEnlargement: true
  });
  for (const quality of [90, 84, 78, 72]) {
    // resolveWithObject 直接带回输出尺寸，省掉一次完整 JPEG 解码。
    const { data, info } = await base.clone().jpeg({ quality, mozjpeg: true }).toBuffer({ resolveWithObject: true });
    if (!info.width || !info.height) throw new Error('无法读取标准图尺寸');
    if (data.length <= 10_000_000 || quality === 72) {
      return { body: data, width: info.width, height: info.height };
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
  const standard = await standardJpeg(source);
  const key = `users/${data.userId}/collectibles/${data.collectibleId}/standard/v${data.version}.jpg`;
  await upsertAsset({
    ...data,
    kind: AssetKind.STANDARD,
    key,
    contentType: 'image/jpeg',
    ...standard
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

export async function matImage(data: ProcessingJobData) {
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
  const rotated = sharp(source, { limitInputPixels: config.MAX_IMAGE_PIXELS }).rotate(collectible.cropRotation);
  const metadata = await rotated.metadata();
  if (!metadata.width || !metadata.height) throw new Error('无法读取裁剪图尺寸');
  const rect = computeCropRect(metadata.width, metadata.height, {
    x: collectible.cropX,
    y: collectible.cropY,
    width: collectible.cropWidth,
    height: collectible.cropHeight
  });
  const cropped = await rotated.extract(rect).jpeg({ quality: 90, mozjpeg: true }).toBuffer();
  const croppedKey = `users/${data.userId}/collectibles/${data.collectibleId}/cropped/v${data.version}.jpg`;
  const baseKey = `users/${data.userId}/collectibles/${data.collectibleId}`;
  // 裁剪图必须先写入存储并在 COS 上可见，万象才读得到它。
  // 这里立刻挂一个空 catch，否则失败时会触发未处理拒绝，真正的错误在下面 await 时抛出。
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
    writeRenditions(data, cutout, baseKey)
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

export async function cleanup(keys: string[]) {
  if (keys.length) await deleteObjects(keys);
}

export async function closeProcessor() {
  await prisma.$disconnect();
}
