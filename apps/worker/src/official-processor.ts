import { AssetKind, AssetStatus, OfficialProcessStatus, PrismaClient, ProcessingStatus } from '@prisma/client';
import sharp from 'sharp';
import { upsertAssetRecord } from './asset-record.js';
import { ensureBagEmbedding } from './bag-embeddings.js';
import { config } from './config.js';
import { removeBackground, standardImage, trimTransparent } from './processor.js';
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
 * 官方袋子的展示图与缩略图。透明口径（抠图结果、或保留了透明度的标准图）走透明
 * PNG（沿用 trim 逻辑）；白底 JPEG 标准图不做 trim —— 没有透明像素，
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
 * 原图 → STANDARD(≤4096；开抠图为白底 JPEG，不开抠图且原图透明时为 PNG) →
 * （可选抠图 → CUTOUT）→ DISPLAY + THUMBNAIL → READY。
 * 不抠图时完全不调用腾讯云万象，官方库每天的录入量不受用户抠图配额与成本限制。
 */
export async function processOfficialImage(data: OfficialProcessJobData) {
  const current = await prisma.officialBag.findUnique({
    where: { id: data.officialBagId },
    select: { version: true }
  });
  // 图片已被替换或删除时 version 会变，旧任务直接丢弃，避免把已清理的图片写回来。
  if (!current || current.version !== data.version) return;
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
  // 不抠图时保留原图透明度：官方库常直接上传现成的透明 PNG 素材，
  // 转白底 JPEG 会丢掉透明背景；开抠图时仍统一白底 JPEG，万象输入更稳定。
  const standard = await standardImage(source, { keepTransparency: !data.matting });
  const transparent = !data.matting && standard.contentType === 'image/png';
  const baseKey = `official/${data.officialBagId}`;
  const standardKey = `${baseKey}/standard/v${data.version}.${standard.extension}`;
  await upsertOfficialAsset({
    officialBagId: data.officialBagId,
    kind: AssetKind.STANDARD,
    key: standardKey,
    contentType: standard.contentType,
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
    // 标准图若保留了透明度，展示图/缩略图同样按透明口径出图（含 trim）。
    await writeOfficialRenditions(data, standard.body, baseKey, transparent);
  }

  await prisma.officialBag.updateMany({
    where: { id: data.officialBagId, version: data.version },
    data: { processStatus: OfficialProcessStatus.READY, processError: null }
  });

  /* 顺手把视觉向量算出来，让袋子发布后立刻能被「拍照扫描」匹配到（否则要等下一轮对账）。
     提取失败绝不能影响图片处理的结果 —— 图和状态都已落定，这里只记日志，
     由对账任务在后续轮次补上（见 bag-embeddings.ts）。 */
  try {
    await ensureBagEmbedding(data.officialBagId);
  } catch (error) {
    console.error(
      JSON.stringify({
        event: 'bag_embedding_inline_failed',
        officialBagId: data.officialBagId,
        error: error instanceof Error ? error.message : String(error)
      })
    );
  }
}

/**
 * 用户「拥有」官方袋子：把官方图片资产复制到用户名下，成为一条普通 Collectible。
 * 复制 STANDARD / CUTOUT / DISPLAY / THUMBNAIL（不含 ORIGINAL，重新裁剪只需要标准图），
 * 存储计入用户配额（upsertAssetRecord 内部带配额校验），产出后即 READY。
 */
export async function claimOfficialBag(data: OfficialClaimJobData) {
  /* 认领可能已在任务排队期间被撤回（删除收藏会连带删认领记录）——
     此时无事可做，静默完成；不能 throw，否则 failOfficialClaim 对已删记录
     再 update 也会崩，任务反复失败占住队列（还会让同 id 的新任务被去重吞掉） */
  const collectible = await prisma.collectible.findFirst({
    where: { id: data.collectibleId, userId: data.userId }
  });
  if (!collectible) return;
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
  // 过期任务（图片已被替换或删除）不再改动袋子状态。
  await prisma.officialBag.updateMany({
    where: { id: data.officialBagId, version: data.version },
    data: { processStatus: OfficialProcessStatus.FAILED, processError: message }
  });
}

/**
 * 卡死对账：PROCESSING 超过阈值说明任务没被消费（worker 宕机 / 任务丢失 / stalled），
 * 翻成 FAILED 让管理后台可见、可手动重传。若任务其实只是排在长队尾，
 * 它最终跑完时仍会把状态写回 READY，不影响自愈。
 */
export async function reconcileStuckOfficialProcessing(stuckBefore: Date) {
  const result = await prisma.officialBag.updateMany({
    where: { processStatus: OfficialProcessStatus.PROCESSING, updatedAt: { lt: stuckBefore } },
    data: {
      processStatus: OfficialProcessStatus.FAILED,
      processError: '处理超时：任务长时间未完成，请重新上传图片触发重试'
    }
  });
  if (result.count > 0) {
    console.warn(JSON.stringify({ event: 'reconcile_stuck_official', count: result.count }));
  }
  return result.count;
}

export async function failOfficialClaim(data: OfficialClaimJobData, error: unknown) {
  const message = error instanceof Error ? error.message.slice(0, 500) : '同步到收藏夹失败';
  /* updateMany：收藏可能已在排队期间被删除——update 对不存在的记录会 throw，
     把失败处理本身炸掉，任务进入无意义的反复重试 */
  await prisma.collectible.updateMany({
    where: { id: data.collectibleId },
    data: { processingStatus: ProcessingStatus.FAILED, processingError: message }
  });
}

export async function closeOfficialProcessor() {
  await prisma.$disconnect();
}
