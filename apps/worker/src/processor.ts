import { AssetKind, AssetStatus, JobStatus, ProcessingStatus, PrismaClient } from '@prisma/client';
import sharp from 'sharp';
import { upsertAssetRecord } from './asset-record.js';
import { config } from './config.js';
import { computeCropRect } from './geometry.js';
import { createBackgroundRemover } from './matting.js';
import { deleteObjects, getObject, putObject } from './object-store.js';

export interface ProcessingJobData {
  processingJobId: string;
  collectibleId: string;
  userId: string;
  version: number;
}

const prisma = new PrismaClient();
const removeBackground = createBackgroundRemover({
  driver: config.MATTING_DRIVER,
  url: config.REMBG_URL,
  model: config.REMBG_MODEL,
  timeoutMs: config.REMBG_TIMEOUT_MS,
  maxResponseBytes: config.REMBG_MAX_RESPONSE_BYTES,
  maxImagePixels: config.MAX_IMAGE_PIXELS,
  maxConcurrency: config.REMBG_MAX_CONCURRENCY
});

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

async function writeRenditions(data: ProcessingJobData, source: Buffer, baseKey: string) {
  const display = await sharp(source, { limitInputPixels: config.MAX_IMAGE_PIXELS })
    .resize({ width: 2048, height: 2048, fit: 'inside', withoutEnlargement: true })
    .png({ compressionLevel: 9 })
    .toBuffer();
  const displayMeta = await sharp(display).metadata();
  if (!displayMeta.width || !displayMeta.height) throw new Error('无法读取展示图尺寸');
  await upsertAsset({
    ...data,
    kind: AssetKind.DISPLAY,
    key: `${baseKey}/display/v${data.version}.png`,
    contentType: 'image/png',
    body: display,
    width: displayMeta.width,
    height: displayMeta.height
  });

  const thumbnail = await sharp(source, { limitInputPixels: config.MAX_IMAGE_PIXELS })
    .resize({ width: 512, height: 512, fit: 'inside', withoutEnlargement: true })
    .webp({ quality: 82, alphaQuality: 90 })
    .toBuffer();
  const thumbnailMeta = await sharp(thumbnail).metadata();
  if (!thumbnailMeta.width || !thumbnailMeta.height) throw new Error('无法读取缩略图尺寸');
  await upsertAsset({
    ...data,
    kind: AssetKind.THUMBNAIL,
    key: `${baseKey}/thumbnail/v${data.version}.webp`,
    contentType: 'image/webp',
    body: thumbnail,
    width: thumbnailMeta.width,
    height: thumbnailMeta.height
  });
}

async function standardJpeg(source: Buffer) {
  const base = sharp(source, { limitInputPixels: config.MAX_IMAGE_PIXELS }).rotate().resize({
    width: 4096,
    height: 4096,
    fit: 'inside',
    withoutEnlargement: true
  });
  for (const quality of [90, 84, 78, 72]) {
    const body = await base.clone().jpeg({ quality, mozjpeg: true }).toBuffer();
    if (body.length <= 10_000_000 || quality === 72) {
      const metadata = await sharp(body).metadata();
      if (!metadata.width || !metadata.height) throw new Error('无法读取标准图尺寸');
      return { body, width: metadata.width, height: metadata.height };
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
    collectible.cropHeight === null
  ) {
    throw new Error('缺少裁剪参数');
  }
  const source = await getObject(standard.objectKey);
  const rotated = sharp(source, { limitInputPixels: config.MAX_IMAGE_PIXELS }).rotate(collectible.cropRotation ?? 0);
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
  await upsertAsset({
    ...data,
    kind: AssetKind.CROPPED,
    key: croppedKey,
    contentType: 'image/jpeg',
    body: cropped,
    width: rect.width,
    height: rect.height
  });

  const baseKey = `users/${data.userId}/collectibles/${data.collectibleId}`;
  let cutout: Buffer;
  try {
    cutout = await removeBackground(cropped);
  } catch (error) {
    await writeRenditions(data, cropped, baseKey);
    throw error;
  }
  const cutoutMeta = await sharp(cutout, { limitInputPixels: config.MAX_IMAGE_PIXELS }).metadata();
  if (!cutoutMeta.width || !cutoutMeta.height) throw new Error('抠图结果无效');
  await upsertAsset({
    ...data,
    kind: AssetKind.CUTOUT,
    key: `${baseKey}/cutout/v${data.version}.png`,
    contentType: 'image/png',
    body: cutout,
    width: cutoutMeta.width,
    height: cutoutMeta.height
  });
  await writeRenditions(data, cutout, baseKey);

  await prisma.collectible.update({
    where: { id: data.collectibleId },
    data: { processingStatus: ProcessingStatus.READY, processingError: null }
  });
  await setSucceeded(data.processingJobId);
}

export async function failProcessing(data: ProcessingJobData, error: unknown, isFinalAttempt: boolean) {
  const message = error instanceof Error ? error.message.slice(0, 500) : '图片处理失败';
  if (!isFinalAttempt) {
    await prisma.processingJob.update({
      where: { id: data.processingJobId },
      data: { status: JobStatus.QUEUED, errorMessage: message, finishedAt: null }
    });
    return;
  }
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
