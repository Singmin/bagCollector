import { AssetKind, AssetStatus, ImageSide, OfficialProcessStatus, PrismaClient, ProcessingStatus } from '@prisma/client';
import sharp from 'sharp';
import { addWhiteStroke } from '@bagcollect/stroke';
import { ensureBagEmbedding } from './bag-embeddings.js';
import { config } from './config.js';
import { getStrokeParams, removeBackground, standardImage, trimTransparent } from './processor.js';
import { getObject, putObject, deleteObjects } from './object-store.js';

export interface OfficialProcessJobData {
  officialBagId: string;
  version: number;
  matting: boolean;
  side?: ImageSide;
  sourceVersion?: number;
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
  side?: ImageSide;
  sourceVersion?: number;
}) {
  await putObject(input.key, input.body, input.contentType);
  try {
    await prisma.$transaction(async tx => {
      await tx.$queryRaw`SELECT "id" FROM "OfficialBag" WHERE "id" = ${input.officialBagId} FOR UPDATE`;
      if (input.sourceVersion !== undefined) {
        const state = await tx.officialBagImageSide.findUnique({ where: { officialBagId_side: { officialBagId: input.officialBagId, side: input.side ?? ImageSide.FRONT } } });
        if (!state || state.processingVersion !== input.version || state.sourceVersion !== input.sourceVersion) throw new Error('STALE_IMAGE_JOB');
      }
  await tx.officialBagImage.upsert({
    where: { objectKey: input.key },
    create: {
      officialBagId: input.officialBagId,
      kind: input.kind, side: input.side ?? ImageSide.FRONT,
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
    });
  } catch (error) {
    if (error instanceof Error && error.message === 'STALE_IMAGE_JOB') await deleteObjects([input.key]);
    throw error;
  }
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
  /* 白描边（贴纸效果）只作用于透明口径（抠图结果 / 保留透明度的标准图），与用户链路口径一致；
     白底 JPEG 是实拍素材，不加描边。参数来自 AppSetting（后台「描边预览」页），ratio=0 时关闭。 */
  const trimmed = transparent ? await trimTransparent(source) : source;
  const strokeParams = transparent ? await getStrokeParams() : null;
  const hasStroke = Boolean(strokeParams && strokeParams.ratio > 0);
  const material = hasStroke ? await addWhiteStroke(trimmed, strokeParams!) : trimmed;
  /* 无白边版：只在「实际加了白边」时派生，素材就是 trim 后未描边的同一张透明图。 */
  const plain = hasStroke ? trimmed : null;
  const encode = (input: Buffer) => Promise.all([
    sharp(input, { limitInputPixels: config.MAX_IMAGE_PIXELS })
      .resize({ width: 2048, height: 2048, fit: 'inside', withoutEnlargement: true })
      .png({ compressionLevel: 6 })
      .toBuffer({ resolveWithObject: true }),
    sharp(input, { limitInputPixels: config.MAX_IMAGE_PIXELS })
      .resize({ width: 512, height: 512, fit: 'inside', withoutEnlargement: true })
      .webp({ quality: 82, ...(transparent ? { alphaQuality: 90 } : {}) })
      .toBuffer({ resolveWithObject: true })
  ]);
  const [display, thumbnail] = await encode(material);
  const plainPair = plain ? await encode(plain) : null;
  if (!display.info.width || !display.info.height) throw new Error('无法读取展示图尺寸');
  if (!thumbnail.info.width || !thumbnail.info.height) throw new Error('无法读取缩略图尺寸');
  const writes = [
    upsertOfficialAsset({
      officialBagId: data.officialBagId, side: data.side ?? ImageSide.FRONT, sourceVersion: data.sourceVersion,
      kind: AssetKind.DISPLAY,
      key: `${baseKey}/display/v${data.version}.png`,
      contentType: 'image/png',
      body: display.data,
      width: display.info.width,
      height: display.info.height,
      version: data.version
    }),
    upsertOfficialAsset({
      officialBagId: data.officialBagId, side: data.side ?? ImageSide.FRONT, sourceVersion: data.sourceVersion,
      kind: AssetKind.THUMBNAIL,
      key: `${baseKey}/thumbnail/v${data.version}.webp`,
      contentType: 'image/webp',
      body: thumbnail.data,
      width: thumbnail.info.width,
      height: thumbnail.info.height,
      version: data.version
    })
  ];
  if (plainPair) {
    const [plainDisplay, plainThumbnail] = plainPair;
    if (!plainDisplay.info.width || !plainDisplay.info.height) throw new Error('无法读取无白边展示图尺寸');
    if (!plainThumbnail.info.width || !plainThumbnail.info.height) throw new Error('无法读取无白边缩略图尺寸');
    writes.push(
      upsertOfficialAsset({
        officialBagId: data.officialBagId, side: data.side ?? ImageSide.FRONT, sourceVersion: data.sourceVersion,
        kind: AssetKind.DISPLAY_PLAIN,
        key: `${baseKey}/display-plain/v${data.version}.png`,
        contentType: 'image/png',
        body: plainDisplay.data,
        width: plainDisplay.info.width,
        height: plainDisplay.info.height,
        version: data.version
      }),
      upsertOfficialAsset({
        officialBagId: data.officialBagId, side: data.side ?? ImageSide.FRONT, sourceVersion: data.sourceVersion,
        kind: AssetKind.THUMBNAIL_PLAIN,
        key: `${baseKey}/thumbnail-plain/v${data.version}.webp`,
        contentType: 'image/webp',
        body: plainThumbnail.data,
        width: plainThumbnail.info.width,
        height: plainThumbnail.info.height,
        version: data.version
      })
    );
  }
  await Promise.all(writes);
}

/**
 * 管理后台上传官方袋子原图后的处理链路：
 * 原图 → STANDARD(≤4096；开抠图为白底 JPEG，不开抠图且原图透明时为 PNG) →
 * （可选抠图 → CUTOUT）→ DISPLAY + THUMBNAIL → READY。
 * 不抠图时完全不调用腾讯云万象，官方库每天的录入量不受用户抠图配额与成本限制。
 */
export async function processOfficialImage(data: OfficialProcessJobData) {
  const side = data.side ?? ImageSide.FRONT;
  const state = await prisma.officialBagImageSide.findUnique({ where: { officialBagId_side: { officialBagId: data.officialBagId, side } } });
  if (!state || state.sourceVersion !== (data.sourceVersion ?? data.version) || state.processingVersion !== data.version) return;
  const original = await prisma.officialBagImage.findFirstOrThrow({
    where: {
      officialBagId: data.officialBagId,
      side, kind: AssetKind.ORIGINAL,
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
  const baseKey = `official/${data.officialBagId}/${side.toLowerCase()}`;
  const standardKey = `${baseKey}/standard/v${data.version}.${standard.extension}`;
  await upsertOfficialAsset({
    officialBagId: data.officialBagId, side, sourceVersion: data.sourceVersion,
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
        officialBagId: data.officialBagId, side: data.side ?? ImageSide.FRONT, sourceVersion: data.sourceVersion,
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

  await prisma.$transaction(async tx => {
    await tx.$queryRaw`SELECT "id" FROM "OfficialBag" WHERE "id" = ${data.officialBagId} FOR UPDATE`;
    const changed = await tx.officialBagImageSide.updateMany({ where: { officialBagId: data.officialBagId, side, sourceVersion: data.sourceVersion ?? data.version, processingVersion: data.version }, data: { publishedVersion: data.version, publishedSourceVersion: data.sourceVersion ?? data.version, processingStatus: OfficialProcessStatus.READY, processingError: null } });
    if (!changed.count) throw new Error('STALE_IMAGE_JOB');
    await tx.officialBag.update({ where: { id: data.officialBagId }, data: side === ImageSide.FRONT ? { version: data.version, processStatus: OfficialProcessStatus.READY, processError: null } : { updatedAt: new Date() } });
  });
  if (side === ImageSide.FRONT) await ensureBagEmbedding(data.officialBagId).catch(error => console.warn('embedding_pending', error instanceof Error ? error.message : 'unknown'));

}

/** Legacy queued claims now link to the official library instead of copying assets. */
export async function claimOfficialBag(data: OfficialClaimJobData) {
  /* 认领可能已在任务排队期间被撤回（删除收藏会连带删认领记录）——
     此时无事可做，静默完成；不能 throw，否则 failOfficialClaim 对已删记录
     再 update 也会崩，任务反复失败占住队列（还会让同 id 的新任务被去重吞掉） */
  const collectible = await prisma.collectible.findFirst({
    where: { id: data.collectibleId, userId: data.userId }
  });
  if (!collectible) return;
  await prisma.collectible.update({ where: { id: collectible.id }, data: { sourceOfficialBagId: data.officialBagId, processingStatus: ProcessingStatus.READY, processingError: null } });

}

export async function failOfficialProcess(data: OfficialProcessJobData, error: unknown) {
  const message = error instanceof Error ? error.message.slice(0, 500) : '官方袋子图片处理失败';
  const side = data.side ?? ImageSide.FRONT;
  await prisma.$transaction(async tx => {
    await tx.$queryRaw`SELECT "id" FROM "OfficialBag" WHERE "id" = ${data.officialBagId} FOR UPDATE`;
    const changed = await tx.officialBagImageSide.updateMany({ where: { officialBagId: data.officialBagId, side, processingVersion: data.version, sourceVersion: data.sourceVersion ?? data.version }, data: { processingStatus: OfficialProcessStatus.FAILED, processingError: message } });
    const state = await tx.officialBagImageSide.findUnique({ where: { officialBagId_side: { officialBagId: data.officialBagId, side } } });
    if (changed.count && side === ImageSide.FRONT) await tx.officialBag.updateMany({ where: { id: data.officialBagId }, data: { processStatus: state?.publishedVersion ? OfficialProcessStatus.READY : OfficialProcessStatus.FAILED, processError: message } });
  });

}

/**
 * 卡死对账：PROCESSING 超过阈值说明任务没被消费（worker 宕机 / 任务丢失 / stalled），
 * 翻成 FAILED 让管理后台可见、可手动重传。若任务其实只是排在长队尾，
 * 它最终跑完时仍会把状态写回 READY，不影响自愈。
 */
export async function reconcileStuckOfficialProcessing(stuckBefore: Date) {
  const states = await prisma.officialBagImageSide.findMany({ where: { processingStatus: OfficialProcessStatus.PROCESSING, updatedAt: { lt: stuckBefore } } });
  for (const state of states) await failOfficialProcess({ officialBagId: state.officialBagId, side: state.side, version: state.processingVersion, sourceVersion: state.sourceVersion, matting: state.matting }, new Error('处理超时，请重新上传这一面'));
  const result = { count: states.length };
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
