import { AssetKind, AssetStatus, OfficialProcessStatus, PrismaClient, ProcessingStatus } from '@prisma/client';
import sharp from 'sharp';
import { upsertAssetRecord } from './asset-record.js';
import { config } from './config.js';
import { removeBackground, standardJpeg, trimTransparent } from './processor.js';
import { getObject, putObject } from './object-store.js';

export interface OfficialProcessJobData {
  officialBagId: string;
  version: number;
  matting: boolean;
}

export interface OfficialClaimJobData {
  officialBagId: string;
  userId: string;
  collectibleId: string;
}

const prisma = new PrismaClient();

async function upsertOfficialAsset(input: {
  officialBagId: string;
  kind: AssetKind;
  key: string;
  contentType: string;
  body: Buffer;
  width: number;
  height: number;
  version: number;
}) {
  await putObject(input.key, input.body, input.contentType);
  await prisma.officialBagImage.upsert({
    where: { objectKey: input.key },
    create: {
      officialBagId: input.officialBagId,
      kind: input.kind,
      status: AssetStatus.AVAILABLE,
      objectKey: input.key,
      contentType: input.contentType,
      declaredByteSize: BigInt(input.body.length),
      byteSize: BigInt(input.body.length),
      width: input.width,
      height: input.height,
      version: input.version
    },
    update: {
      status: AssetStatus.AVAILABLE,
      contentType: input.contentType,
      declaredByteSize: BigInt(input.body.length),
      byteSize: BigInt(input.body.length),
      width: input.width,
      height: input.height
    }
  });
}

/**
 * 官方袋子的展示图与缩略图。抠图结果走透明 PNG（沿用 trim 逻辑）；
 * 不抠图时直接用标准 JPEG 出图，不做 trim —— JPEG 没有透明像素，
 * trim 会按角落颜色误裁实体内容。
 */
async function writeOfficialRenditions(
  data: OfficialProcessJobData,
  source: Buffer,
  baseKey: string,
  transparent: boolean
) {
  const material = transparent ? await trimTransparent(source) : source;
  const [display, thumbnail] = await Promise.all([
    sharp(material, { limitInputPixels: config.MAX_IMAGE_PIXELS })
      .resize({ width: 2048, height: 2048, fit: 'inside', withoutEnlargement: true })
      .png({ compressionLevel: 6 })
      .toBuffer({ resolveWithObject: true }),
    sharp(material, { limitInputPixels: config.MAX_IMAGE_PIXELS })
      .resize({ width: 512, height: 512, fit: 'inside', withoutEnlargement: true })
      .webp({ quality: 82, ...(transparent ? { alphaQuality: 90 } : {}) })
      .toBuffer({ resolveWithObject: true })
  ]);
  if (!display.info.width || !display.info.height) throw new Error('无法读取展示图尺寸');
  if (!thumbnail.info.width || !thumbnail.info.height) throw new Error('无法读取缩略图尺寸');
  await Promise.all([
    upsertOfficialAsset({
      officialBagId: data.officialBagId,
      kind: AssetKind.DISPLAY,
      key: `${baseKey}/display/v${data.version}.png`,
      contentType: 'image/png',
      body: display.data,
      width: display.info.width,
      height: display.info.height,
      version: data.version
    }),
    upsertOfficialAsset({
      officialBagId: data.officialBagId,
      kind: AssetKind.THUMBNAIL,
      key: `${baseKey}/thumbnail/v${data.version}.webp`,
      contentType: 'image/webp',
      body: thumbnail.data,
      width: thumbnail.info.width,
      height: thumbnail.info.height,
      version: data.version
    })
  ]);
}

/**
 * 管理后台上传官方袋子原图后的处理链路：
 * 原图 → STANDARD(≤4096 JPEG) →（可选抠图 → CUTOUT）→ DISPLAY + THUMBNAIL → READY。
 * 不抠图时完全不调用腾讯云万象，官方库每天的录入量不受用户抠图配额与成本限制。
 */
export async function processOfficialImage(data: OfficialProcessJobData) {
  await prisma.officialBag.update({
    where: { id: data.officialBagId },
    data: { processStatus: OfficialProcessStatus.PROCESSING, processError: null }
  });
  const original = await prisma.officialBagImage.findFirstOrThrow({
    where: {
      officialBagId: data.officialBagId,
      kind: AssetKind.ORIGINAL,
      version: data.version,
      status: AssetStatus.AVAILABLE
    },
    orderBy: { createdAt: 'desc' }
  });
  const source = await getObject(original.objectKey);
  const standard = await standardJpeg(source);
  const baseKey = `official/${data.officialBagId}`;
  const standardKey = `${baseKey}/standard/v${data.version}.jpg`;
  await upsertOfficialAsset({
    officialBagId: data.officialBagId,
    kind: AssetKind.STANDARD,
    key: standardKey,
    contentType: 'image/jpeg',
    body: standard.body,
    width: standard.width,
    height: standard.height,
    version: data.version
  });

  if (data.matting) {
    // 与用户链路同口径：万象按原图分辨率对标准图抠图，先落 COS 再触发下载时处理。
    const cutout = await removeBackground({
      objectKey: standardKey,
      width: standard.width,
      height: standard.height
    });
    await Promise.all([
      upsertOfficialAsset({
        officialBagId: data.officialBagId,
        kind: AssetKind.CUTOUT,
        key: `${baseKey}/cutout/v${data.version}.png`,
        contentType: 'image/png',
        body: cutout,
        width: standard.width,
        height: standard.height,
        version: data.version
      }),
      writeOfficialRenditions(data, cutout, baseKey, true)
    ]);
  } else {
    await writeOfficialRenditions(data, standard.body, baseKey, false);
  }

  await prisma.officialBag.update({
    where: { id: data.officialBagId },
    data: { processStatus: OfficialProcessStatus.READY, processError: null }
  });
}

/**
 * 用户「拥有」官方袋子：把官方图片资产复制到用户名下，成为一条普通 Collectible。
 * 复制 STANDARD / CUTOUT / DISPLAY / THUMBNAIL（不含 ORIGINAL，重新裁剪只需要标准图），
 * 存储计入用户配额（upsertAssetRecord 内部带配额校验），产出后即 READY。
 */
export async function claimOfficialBag(data: OfficialClaimJobData) {
  const collectible = await prisma.collectible.findFirstOrThrow({
    where: { id: data.collectibleId, userId: data.userId }
  });
  const images = await prisma.officialBagImage.findMany({
    where: {
      officialBagId: data.officialBagId,
      status: AssetStatus.AVAILABLE,
      kind: { in: [AssetKind.STANDARD, AssetKind.CUTOUT, AssetKind.DISPLAY, AssetKind.THUMBNAIL] }
    },
    orderBy: { version: 'desc' }
  });
  // 同一 kind 只复制最新版本，与用户侧「按版本取最新」的读取口径一致。
  const latest = new Map<AssetKind, (typeof images)[number]>();
  for (const image of images) {
    if (!latest.has(image.kind)) latest.set(image.kind, image);
  }
  if (!latest.has(AssetKind.STANDARD)) throw new Error('官方袋子缺少标准图');
  if (!latest.has(AssetKind.DISPLAY) || !latest.has(AssetKind.THUMBNAIL)) {
    throw new Error('官方袋子尚未完成图片处理');
  }

  for (const [kind, image] of latest) {
    const body = await getObject(image.objectKey);
    const extension = image.contentType === 'image/webp' ? 'webp' : image.contentType === 'image/png' ? 'png' : 'jpg';
    const key = `users/${data.userId}/collectibles/${collectible.id}/${kind.toLowerCase()}/v1.${extension}`;
    await putObject(key, body, image.contentType);
    await upsertAssetRecord(prisma, {
      userId: data.userId,
      collectibleId: collectible.id,
      kind,
      key,
      contentType: image.contentType,
      byteSize: body.length,
      width: image.width ?? 0,
      height: image.height ?? 0,
      version: 1
    });
  }

  await prisma.collectible.update({
    where: { id: collectible.id },
    data: { processingStatus: ProcessingStatus.READY, processingError: null }
  });
}

export async function failOfficialProcess(data: OfficialProcessJobData, error: unknown) {
  const message = error instanceof Error ? error.message.slice(0, 500) : '官方袋子图片处理失败';
  await prisma.officialBag.update({
    where: { id: data.officialBagId },
    data: { processStatus: OfficialProcessStatus.FAILED, processError: message }
  });
}

export async function failOfficialClaim(data: OfficialClaimJobData, error: unknown) {
  const message = error instanceof Error ? error.message.slice(0, 500) : '同步到收藏夹失败';
  await prisma.collectible.update({
    where: { id: data.collectibleId },
    data: { processingStatus: ProcessingStatus.FAILED, processingError: message }
  });
}

export async function closeOfficialProcessor() {
  await prisma.$disconnect();
}
