import { HttpStatus } from '@nestjs/common';
import { AssetStatus, ImageSide, JobStatus, Prisma, ProcessingStatus } from '@prisma/client';
import { imageRevision, selectSideAssets, type ImageSideDto } from '@bagcollect/contracts';
import { ApiError } from './api-error.js';
import type { PrismaService } from '../database/prisma.service.js';
import type { CosService } from '../assets/cos.service.js';

export function assertImageWritable(item: { sourceOfficialBagId: string | null }) {
  if (item.sourceOfficialBagId) throw new ApiError('FORBIDDEN', '官方袋子的图片由管理员维护', HttpStatus.FORBIDDEN);
}
export function parseSide(raw?: string): ImageSide {
  if (raw === undefined || raw === 'FRONT') return ImageSide.FRONT;
  if (raw === 'BACK') return ImageSide.BACK;
  throw new ApiError('VALIDATION', '图片面别必须是 FRONT 或 BACK', HttpStatus.BAD_REQUEST);
}
/** includeEmpty: 保留「已重置」的分面（sourceVersion=0 且无已发布版本，如官方反面被移除后的占位）。
 *  只有管理端编辑表单需要它读取该面的抠图设置；用户侧详情必须隐藏空面。 */
export async function imageData(prisma: PrismaService, cos: CosService, id: string, official = false, includeEmpty = false) {
  // Read the publication pointer before fetching assets: a newly observed pointer
  // always has its complete assets already committed.
  const states = official ? await prisma.officialBagImageSide.findMany({ where: { officialBagId: id } }) : await prisma.collectibleImageSide.findMany({ where: { collectibleId: id } });
  const assets = official ? await prisma.officialBagImage.findMany({ where: { officialBagId: id, status: AssetStatus.AVAILABLE } }) : await prisma.imageAsset.findMany({ where: { collectibleId: id, status: AssetStatus.AVAILABLE } });
  const sides: Partial<Record<ImageSide, ImageSideDto>> = {};
  await Promise.all(states.filter(state => includeEmpty || state.sourceVersion > 0 || state.publishedVersion !== null).map(async state => {
    const selected = selectSideAssets<{ side: ImageSide; kind: string; version: number; objectKey: string }>(assets, state);
    const dto: ImageSideDto = {
      side: state.side, sourceVersion: state.sourceVersion, processingVersion: state.processingVersion,
      publishedVersion: state.publishedVersion, processingStatus: state.processingStatus,
      ...(state.processingError ? { processingError: state.processingError } : {}),
      ...('crop' in state && state.crop ? { crop: state.crop as unknown as ImageSideDto['crop'] } : {}),
      ...('mattedSourceVersion' in state ? { matted: state.mattedSourceVersion === state.sourceVersion } : {}),
      ...('matting' in state ? { matting: state.matting } : {})
    };
    await Promise.all(Object.entries({ thumbnailUrl: 'THUMBNAIL', displayImageUrl: 'DISPLAY', standardImageUrl: 'STANDARD', cutoutImageUrl: 'CUTOUT' }).map(async ([field, kind]) => {
      const asset = selected[kind];
      if (asset) Object.assign(dto, { [field]: await cos.signedUrl(asset.objectKey) });
    }));
    sides[state.side] = dto;
  }));
  return { sides, imageRevision: imageRevision(id, states) };
}
export async function lockImageOwner(tx: Prisma.TransactionClient, id: string, userId: string) {
  // Serialize quota reservations across both faces and all bags owned by the user.
  await tx.$queryRaw`SELECT "id" FROM "User" WHERE "id" = ${userId} FOR UPDATE`;
  await tx.$queryRaw`SELECT "id" FROM "Collectible" WHERE "id" = ${id} FOR UPDATE`;
}
export async function failImageSubmission(prisma: PrismaService, input: {
  collectibleId: string; userId: string; side: ImageSide; version: number; processingJobId?: string;
}) {
  await prisma.$transaction(async tx => {
    await lockImageOwner(tx, input.collectibleId, input.userId);
    const state = await tx.collectibleImageSide.findUnique({ where: { collectibleId_side: { collectibleId: input.collectibleId, side: input.side } } });
    if (!state || state.processingVersion !== input.version || !['NORMALIZING', 'CROPPING', 'MATTING'].includes(state.processingStatus)) return;
    const message = '处理任务提交失败，请重试';
    await tx.collectibleImageSide.update({ where: { collectibleId_side: { collectibleId: input.collectibleId, side: input.side } }, data: { processingStatus: ProcessingStatus.FAILED, processingError: message } });
    if (input.side === ImageSide.FRONT) await tx.collectible.update({ where: { id: input.collectibleId }, data: {
      processingStatus: state.publishedVersion !== null ? ProcessingStatus.READY : ProcessingStatus.FAILED, processingError: message
    } });
    if (input.processingJobId) await tx.processingJob.updateMany({ where: { id: input.processingJobId, status: JobStatus.QUEUED }, data: { status: JobStatus.FAILED, errorMessage: message } });
  });
}
