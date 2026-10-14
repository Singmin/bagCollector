import { HttpStatus, Injectable } from '@nestjs/common';
import { AssetKind, AssetStatus, ImageSide, JobStatus, JobType, ProcessingStatus, Prisma } from '@prisma/client';
import { imageRevision, selectSideAssets } from '@bagcollect/contracts';
import { assertImageWritable, imageData, lockImageOwner, failImageSubmission } from '../common/image-sides.js';
import type { CropInput, MatteInput } from '@bagcollect/contracts';
import { ApiError } from '../common/api-error.js';
import { QUOTA_COUNTED_STATUSES } from '../common/quota.js';
import { QueueService } from '../common/queue.service.js';
import { PrismaService } from '../database/prisma.service.js';
import { AssetsService } from '../assets/assets.service.js';
import { CosService } from '../assets/cos.service.js';
import { FeedService } from '../feed/feed.service.js';

@Injectable()
export class CollectiblesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly assets: AssetsService,
    private readonly cos: CosService,
    private readonly queues: QueueService,
    private readonly feedBags: FeedService
  ) {}

  private async assertShelf(userId: string, shelfId: string) {
    const shelf = await this.prisma.shelf.findFirst({ where: { id: shelfId, userId } });
    if (!shelf) throw new ApiError('NOT_FOUND', '展示架不存在', HttpStatus.NOT_FOUND);
    return shelf;
  }

  private normalizeTags(tags: string[]) {
    const seen = new Set<string>();
    return tags
      .map((tag) => tag.trim())
      .filter((tag) => {
        const normalized = tag.toLocaleLowerCase();
        if (!tag || seen.has(normalized)) return false;
        seen.add(normalized);
        return true;
      });
  }

  private async toDto(collectible: any) {
    const official = !!collectible.sourceOfficialBagId;
    const images = await imageData(this.prisma, this.cos, collectible.sourceOfficialBagId ?? collectible.id, official);
    const front = images.sides.FRONT;
    return {
      id: collectible.id, name: collectible.name, notes: collectible.notes,
      quantity: collectible.quantity ?? 1, visibility: collectible.visibility ?? 'PUBLIC',
      tags: collectible.tags.map((entry: any) => entry.tag.displayName),
      shelfId: collectible.shelfId, shelfName: collectible.shelf.name,
      processingStatus: collectible.processingStatus,
      ...images, imageEditable: !official,
      ...(official ? { sourceOfficialBagId: collectible.sourceOfficialBagId } : {}),
      ...(front?.processingError ? { processingError: front.processingError } : {}),
      ...(front ? { thumbnailUrl: front.thumbnailUrl, displayImageUrl: front.displayImageUrl,
        standardImageUrl: front.standardImageUrl, cutoutImageUrl: front.cutoutImageUrl, crop: front.crop } : {}),
      addedAt: collectible.addedAt.toISOString(), updatedAt: collectible.updatedAt.toISOString()
    };
  }

  private async toSummary(collectible: any) {
    const source = collectible.sourceOfficialBagId ? collectible.sourceOfficialBag : collectible;
    const states = source?.imageSides ?? [];
    const front = states.find((state: any) => state.side === 'FRONT');
    const candidates = source?.images ?? source?.imageAssets ?? [];
    const thumbnail = front
      ? selectSideAssets<{ side: ImageSide; kind: string; version: number; objectKey: string }>(candidates, front).THUMBNAIL
      : candidates[0];
    const thumbnailUrl = thumbnail ? await this.assets.signedUrlForObjectKey(thumbnail.objectKey) : undefined;
    /* B 面缩略图：与详情接口同口径（sourceVersion>0 或已发布才算有该面），
       让小程序详情卡在打开瞬间就能按 A/B 布局渲染，不等详情返回再跳变 */
    const back = states.find((state: any) => state.side === 'BACK');
    const backVisible = !!back && (back.sourceVersion > 0 || back.publishedVersion !== null);
    const backThumbnail = backVisible
      ? selectSideAssets<{ side: ImageSide; kind: string; version: number; objectKey: string }>(candidates, back).THUMBNAIL
      : undefined;
    const backThumbnailUrl = backThumbnail ? await this.assets.signedUrlForObjectKey(backThumbnail.objectKey) : undefined;
    return {
      id: collectible.id, name: collectible.name, shelfId: collectible.shelfId,
      shelfName: collectible.shelf.name, quantity: collectible.quantity ?? 1,
      visibility: collectible.visibility ?? 'PUBLIC', processingStatus: collectible.processingStatus,
      imageEditable: !collectible.sourceOfficialBagId,
      ...(collectible.sourceOfficialBagId ? { sourceOfficialBagId: collectible.sourceOfficialBagId } : {}),
      imageRevision: imageRevision(collectible.sourceOfficialBagId ?? collectible.id, states),
      ...(thumbnailUrl ? { thumbnailUrl } : {}),
      ...(backThumbnailUrl ? { backThumbnailUrl } : {}),
      addedAt: collectible.addedAt.toISOString(), updatedAt: collectible.updatedAt.toISOString()
    };
  }

  private include() {
    return {
      shelf: true,
      tags: { include: { tag: true } }
    } satisfies Prisma.CollectibleInclude;
  }

  private listInclude() {
    return {
      shelf: true, imageSides: true,
      imageAssets: { where: { kind: AssetKind.THUMBNAIL, side: { in: [ImageSide.FRONT, ImageSide.BACK] }, status: AssetStatus.AVAILABLE } },
      sourceOfficialBag: { include: { imageSides: true, images: { where: { kind: AssetKind.THUMBNAIL, side: { in: [ImageSide.FRONT, ImageSide.BACK] }, status: AssetStatus.AVAILABLE } } } }
    } satisfies Prisma.CollectibleInclude;
  }

  async create(userId: string, input: { name: string; shelfId: string }) {
    const [user, collectibleCount] = await Promise.all([
      this.prisma.user.findUnique({ where: { id: userId } }),
      this.prisma.collectible.count({ where: { userId, processingStatus: { in: QUOTA_COUNTED_STATUSES } } })
    ]);
    if (!user) throw new ApiError('UNAUTHORIZED', '用户不存在', HttpStatus.UNAUTHORIZED);
    if (collectibleCount >= user.collectibleQuota) {
      throw new ApiError('QUOTA_EXCEEDED', '收藏数量已达到上限', HttpStatus.PAYLOAD_TOO_LARGE);
    }
    const shelf = await this.assertShelf(userId, input.shelfId);
    const last = await this.prisma.collectible.aggregate({
      where: { userId, shelfId: shelf.id },
      _max: { shelfOrder: true }
    });
    const collectible = await this.prisma.collectible.create({
      data: {
        userId,
        shelfId: shelf.id,
        name: input.name.trim(),
        shelfOrder: (last._max.shelfOrder ?? -1) + 1
      },
      include: this.include()
    });
    return this.toDto(collectible);
  }

  async list(userId: string, query: { search?: string; shelfId?: string; cursor?: string; limit?: number }) {
    /* 上限 1000（对齐 feed）：收藏是个人数据、量级有限，且展架视图按品牌分组，
       分页加载会让后面的品牌分组「缺 items」而被前端过滤掉，用户要拉到底才补得全。
       一次取全后前端宫格仍按 GRID_STEP 增量渲染，不产生一次性大 DOM 的开销。 */
    const limit = Math.min(Math.max(query.limit ?? 30, 1), 1000);
    const search = query.search?.trim();
    const where = {
      userId,
      processingStatus: ProcessingStatus.READY,
      ...(query.shelfId ? { shelfId: query.shelfId } : {}),
      // 搜索同时看「名称 / 备注 / 标签 / 展示架名」。展示架名要算进来，
      // 是因为收藏架页的搜索框写的是「搜索名称 / 品牌 / 标签」——
      // 品牌在数据里就是展示架名，漏掉它用户搜品牌会一个结果都搜不到。
      ...(search
        ? {
            OR: [
              { name: { contains: search, mode: 'insensitive' as const } },
              { notes: { contains: search, mode: 'insensitive' as const } },
              { shelf: { name: { contains: search, mode: 'insensitive' as const } } },
              { tags: { some: { tag: { displayName: { contains: search, mode: 'insensitive' as const } } } } }
            ]
          }
        : {})
    } satisfies Prisma.CollectibleWhereInput;
    const [items, totalCount] = await Promise.all([
      this.prisma.collectible.findMany({
        where: {
          ...where,
          ...(query.cursor ? { addedAt: { lt: new Date(query.cursor) } } : {})
        },
        include: this.listInclude(),
        orderBy: [{ addedAt: 'desc' }, { id: 'desc' }],
        take: limit + 1
      }),
      this.prisma.collectible.count({ where })
    ]);
    const hasMore = items.length > limit;
    const page = hasMore ? items.slice(0, limit) : items;
    return {
      items: await Promise.all(page.map((item) => this.toSummary(item))),
      nextCursor: hasMore ? page.at(-1)?.addedAt.toISOString() : null,
      totalCount
    };
  }

  async detail(userId: string, id: string) {
    const collectible = await this.prisma.collectible.findFirst({
      where: { id, userId },
      include: this.include()
    });
    if (collectible) return this.toDto(collectible);
    /* 兜底官方袋子：心愿袋条目的 id 是袋子 id（与 feed 同 id），详情卡要点开看。
       写操作（PUT/DELETE）不兜底 —— 心愿/feed 条目对用户只读。 */
    const official = await this.feedBags.bagAsCollectible(id);
    if (official) return official;
    throw new ApiError('NOT_FOUND', '收藏不存在', HttpStatus.NOT_FOUND);
  }

  async update(
    userId: string,
    id: string,
    input: { name?: string; notes?: string; tags?: string[]; shelfId?: string; quantity?: number; addedAt?: string; visibility?: 'PRIVATE' | 'PUBLIC' }
  ) {
    const collectible = await this.prisma.collectible.findFirst({ where: { id, userId } });
    if (!collectible) throw new ApiError('NOT_FOUND', '收藏不存在', HttpStatus.NOT_FOUND);
    if (input.shelfId) await this.assertShelf(userId, input.shelfId);
    const normalizedTags = input.tags ? this.normalizeTags(input.tags) : undefined;
    await this.prisma.$transaction(async (transaction) => {
      await transaction.collectible.update({
        where: { id },
        data: {
          ...(input.name !== undefined ? { name: input.name } : {}),
          ...(input.notes !== undefined ? { notes: input.notes } : {}),
          ...(input.shelfId !== undefined ? { shelfId: input.shelfId } : {}),
          ...(input.quantity !== undefined ? { quantity: input.quantity } : {}),
          ...(input.addedAt !== undefined ? { addedAt: new Date(input.addedAt) } : {}),
          ...(input.visibility !== undefined ? { visibility: input.visibility } : {})
        }
      });
      if (normalizedTags) {
        await transaction.collectibleTag.deleteMany({ where: { collectibleId: id } });
        for (const displayName of normalizedTags) {
          const normalized = displayName.toLocaleLowerCase();
          const tag = await transaction.tag.upsert({
            where: { userId_normalized: { userId, normalized } },
            create: { userId, normalized, displayName },
            update: { displayName }
          });
          await transaction.collectibleTag.create({ data: { collectibleId: id, tagId: tag.id } });
        }
      }
    });
    return this.detail(userId, id);
  }

  private async enqueueImage(userId: string, id: string, input: MatteInput, matte: boolean) {
    const side = input.side ?? ImageSide.FRONT;
    const result = await this.prisma.$transaction(async tx => {
      await lockImageOwner(tx, id, userId);
      const item = await tx.collectible.findFirst({ where: { id, userId } });
      if (!item) throw new ApiError('NOT_FOUND', '收藏不存在', HttpStatus.NOT_FOUND);
      assertImageWritable(item);
      const state = await tx.collectibleImageSide.findUnique({ where: { collectibleId_side: { collectibleId: id, side } } });
      if (!state?.sourceVersion) throw new ApiError('CONFLICT', '请先上传这一面的图片', HttpStatus.CONFLICT);
      if (!['AWAITING_CROP', 'READY', 'FAILED'].includes(state.processingStatus)) throw new ApiError('CONFLICT', '这一面的图片正在处理中', HttpStatus.CONFLICT);
      if (input.sourceVersion !== undefined && input.sourceVersion !== state.sourceVersion) throw new ApiError('CONFLICT', '图片已替换，请重新打开编辑页', HttpStatus.CONFLICT);
      const matted = state.mattedSourceVersion === state.sourceVersion;
      if (matte && matted) throw new ApiError('CONFLICT', '这张来源图片已经抠过图', HttpStatus.CONFLICT);
      if (matte) {
        const start = new Date(); start.setHours(0, 0, 0, 0);
        const [user, count] = await Promise.all([
          tx.user.findUniqueOrThrow({ where: { id: userId } }),
          tx.processingJob.count({ where: { userId, type: JobType.MATTING, createdAt: { gte: start }, status: { in: [JobStatus.QUEUED, JobStatus.RUNNING, JobStatus.SUCCEEDED] } } })
        ]);
        if (count >= user.dailyMattingQuota) throw new ApiError('QUOTA_EXCEEDED', '今日自动抠图次数已用完', HttpStatus.TOO_MANY_REQUESTS);
      }
      const old = (state.crop ?? {}) as Partial<CropInput>;
      const crop = { x: input.x ?? old.x ?? 0, y: input.y ?? old.y ?? 0,
        width: input.width ?? old.width ?? 1, height: input.height ?? old.height ?? 1,
        rotation: input.rotation ?? old.rotation ?? 0,
        brightness: input.brightness ?? old.brightness ?? 1,
        contrast: input.contrast ?? old.contrast ?? 1, saturation: input.saturation ?? old.saturation ?? 1 };
      if (crop.x + crop.width > 1.000001 || crop.y + crop.height > 1.000001) throw new ApiError('VALIDATION', '裁剪区域超出图片', HttpStatus.BAD_REQUEST);
      const version = state.processingVersion + 1;
      const status = matte ? ProcessingStatus.MATTING : ProcessingStatus.CROPPING;
      await tx.collectibleImageSide.update({ where: { collectibleId_side: { collectibleId: id, side } }, data: { processingVersion: version, processingStatus: status, processingError: null, crop } });
      if (side === ImageSide.FRONT) await tx.collectible.update({ where: { id }, data: {
        processingStatus: state.publishedVersion ? ProcessingStatus.READY : status, processingVersion: version, processingError: null,
        cropX: crop.x, cropY: crop.y, cropWidth: crop.width, cropHeight: crop.height, cropRotation: crop.rotation,
        cropBrightness: crop.brightness, cropContrast: crop.contrast, cropSaturation: crop.saturation
      } });
      const name: 'matting' | 'crop' = matte ? 'matting' : 'crop';
      const key = `${name}:${id}:${side}:v${version}`;
      const job = await tx.processingJob.create({ data: { userId, collectibleId: id, side, version, sourceVersion: state.sourceVersion,
        type: matte ? JobType.MATTING : JobType.CROP, status: JobStatus.QUEUED, idempotencyKey: key } });
      return { name, key, data: { processingJobId: job.id, collectibleId: id, userId, side, version, sourceVersion: state.sourceVersion, crop, rematte: !matte && matted }, status };
    });
    try { await this.queues.add(result.name, result.data, result.key); }
    catch (error) {
      await failImageSubmission(this.prisma, result.data);
      throw error;
    }
    return { jobId: result.data.processingJobId, side, version: result.data.version, processingStatus: result.status };
  }
  crop(userId: string, id: string, crop: CropInput) { return this.enqueueImage(userId, id, crop, false); }
  matte(userId: string, id: string, input: MatteInput) { return this.enqueueImage(userId, id, input, true); }

  async removeImage(userId: string, id: string, side: ImageSide) {
    if (side !== ImageSide.BACK) throw new ApiError('CONFLICT', '正面主图不能移除，请替换图片', HttpStatus.CONFLICT);
    const keys = await this.prisma.$transaction(async tx => {
      await lockImageOwner(tx, id, userId);
      const item = await tx.collectible.findFirst({ where: { id, userId } });
      if (!item) throw new ApiError('NOT_FOUND', '收藏不存在', HttpStatus.NOT_FOUND);
      assertImageWritable(item);
      const state = await tx.collectibleImageSide.findUnique({ where: { collectibleId_side: { collectibleId: id, side } } });
      if (!state) return [];
      const assets = await tx.imageAsset.findMany({ where: { collectibleId: id, side } });
      await tx.collectibleImageSide.update({ where: { collectibleId_side: { collectibleId: id, side } }, data: { sourceVersion: 0, processingVersion: { increment: 1 }, publishedVersion: null, mattedSourceVersion: null, crop: Prisma.DbNull, processingStatus: ProcessingStatus.UPLOADING, processingError: null } });
      await tx.imageAsset.deleteMany({ where: { collectibleId: id, side } });
      const bytes = assets.reduce((sum, asset) => sum + (asset.status === AssetStatus.AVAILABLE ? asset.byteSize : 0n), 0n);
      await tx.$executeRaw`UPDATE "User" SET "storageUsedBytes" = GREATEST(0, "storageUsedBytes" - ${bytes}) WHERE "id" = ${userId}`;
      return assets.map(asset => asset.objectKey);
    });
    if (keys.length) await this.queues.add('cleanup', { keys });
    return this.detail(userId, id);
  }

  async remove(userId: string, id: string) {
    const collectible = await this.prisma.collectible.findFirst({
      where: { id, userId },
      include: { imageAssets: { select: { objectKey: true, byteSize: true, status: true } } }
    });
    if (!collectible) throw new ApiError('NOT_FOUND', '收藏不存在', HttpStatus.NOT_FOUND);
    const bytes = collectible.imageAssets.reduce(
      (total, asset) => total + (asset.status === AssetStatus.AVAILABLE ? asset.byteSize : 0n),
      0n
    );
    const keys = collectible.imageAssets.map((asset) => asset.objectKey);
    // 「拥有」官方袋子得到的收藏被删除时，同步解除拥有关系并回减计数，
    // 否则用户删掉后将永远无法再次拥有同一个袋子（唯一约束会一直命中）。
    const claim = await this.prisma.officialClaim.findFirst({
      where: { collectibleId: id, userId },
      select: { id: true, officialBagId: true }
    });
    await this.prisma.$transaction(async (transaction) => {
      await transaction.collectible.delete({ where: { id } });
      await transaction.$executeRaw`
        UPDATE "User"
        SET "storageUsedBytes" = GREATEST(0, "storageUsedBytes" - ${bytes})
        WHERE "id" = ${userId}
      `;
      if (claim) {
        await transaction.officialClaim.delete({ where: { id: claim.id } });
        await transaction.officialBag.update({
          where: { id: claim.officialBagId },
          data: { claimedCount: { decrement: 1 } }
        });
      }
    });
    if (keys.length) await this.queues.add('cleanup', { keys });
    return { success: true };
  }
}
