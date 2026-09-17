import { HttpStatus, Injectable } from '@nestjs/common';
import { AssetKind, AssetStatus, JobStatus, JobType, ProcessingStatus, Prisma } from '@prisma/client';
import type { CropInput } from '@bagcollect/contracts';
import { ApiError } from '../common/api-error.js';
import { QueueService } from '../common/queue.service.js';
import { PrismaService } from '../database/prisma.service.js';
import { AssetsService } from '../assets/assets.service.js';

@Injectable()
export class CollectiblesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly assets: AssetsService,
    private readonly queues: QueueService
  ) {}

  private async assertShelf(userId: string, shelfId?: string) {
    const shelf = shelfId
      ? await this.prisma.shelf.findFirst({ where: { id: shelfId, userId } })
      : await this.prisma.shelf.findFirst({ where: { userId, isSystem: true } });
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
    const urls = await this.assets.urlsByKind(collectible.id, collectible.userId);
    return {
      id: collectible.id,
      name: collectible.name,
      notes: collectible.notes,
      tags: collectible.tags.map((entry: any) => entry.tag.displayName),
      shelfId: collectible.shelfId,
      shelfName: collectible.shelf.name,
      processingStatus: collectible.processingStatus,
      ...(collectible.processingError ? { processingError: collectible.processingError } : {}),
      ...(urls.THUMBNAIL ? { thumbnailUrl: urls.THUMBNAIL } : {}),
      ...(urls.DISPLAY ? { displayImageUrl: urls.DISPLAY } : {}),
      ...(urls.STANDARD ? { standardImageUrl: urls.STANDARD } : {}),
      addedAt: collectible.addedAt.toISOString(),
      updatedAt: collectible.updatedAt.toISOString()
    };
  }

  private include() {
    return {
      shelf: true,
      tags: { include: { tag: true } }
    } satisfies Prisma.CollectibleInclude;
  }

  async create(userId: string, input: { name?: string; shelfId?: string }) {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      include: { _count: { select: { collectibles: true } } }
    });
    if (!user) throw new ApiError('UNAUTHORIZED', '用户不存在', HttpStatus.UNAUTHORIZED);
    if (user._count.collectibles >= user.collectibleQuota) {
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
        name: input.name?.trim() || '未命名收藏',
        shelfOrder: (last._max.shelfOrder ?? -1) + 1
      },
      include: this.include()
    });
    return this.toDto(collectible);
  }

  async list(userId: string, query: { search?: string; shelfId?: string; cursor?: string; limit?: number }) {
    const limit = Math.min(Math.max(query.limit ?? 30, 1), 100);
    const search = query.search?.trim();
    const items = await this.prisma.collectible.findMany({
      where: {
        userId,
        ...(query.shelfId ? { shelfId: query.shelfId } : {}),
        ...(search
          ? {
              OR: [
                { name: { contains: search, mode: 'insensitive' } },
                { notes: { contains: search, mode: 'insensitive' } },
                { tags: { some: { tag: { displayName: { contains: search, mode: 'insensitive' } } } } }
              ]
            }
          : {}),
        ...(query.cursor ? { addedAt: { lt: new Date(query.cursor) } } : {})
      },
      include: this.include(),
      orderBy: [{ addedAt: 'desc' }, { id: 'desc' }],
      take: limit + 1
    });
    const hasMore = items.length > limit;
    const page = hasMore ? items.slice(0, limit) : items;
    return {
      items: await Promise.all(page.map((item) => this.toDto(item))),
      nextCursor: hasMore ? page.at(-1)?.addedAt.toISOString() : null
    };
  }

  async detail(userId: string, id: string) {
    const collectible = await this.prisma.collectible.findFirst({
      where: { id, userId },
      include: this.include()
    });
    if (!collectible) throw new ApiError('NOT_FOUND', '收藏不存在', HttpStatus.NOT_FOUND);
    return this.toDto(collectible);
  }

  async update(
    userId: string,
    id: string,
    input: { name?: string; notes?: string; tags?: string[]; shelfId?: string }
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
          ...(input.shelfId !== undefined ? { shelfId: input.shelfId } : {})
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

  private async enqueueMatting(userId: string, id: string, crop: CropInput, isRetry = false) {
    const startOfDay = new Date();
    startOfDay.setHours(0, 0, 0, 0);
    const [collectible, user, todayJobs] = await Promise.all([
      this.prisma.collectible.findFirst({ where: { id, userId } }),
      this.prisma.user.findUnique({ where: { id: userId } }),
      this.prisma.processingJob.count({ where: { userId, type: JobType.MATTING, createdAt: { gte: startOfDay } } })
    ]);
    if (!collectible || !user) throw new ApiError('NOT_FOUND', '收藏不存在', HttpStatus.NOT_FOUND);
    if (!isRetry && collectible.processingStatus !== ProcessingStatus.AWAITING_CROP) {
      throw new ApiError('CONFLICT', '图片尚未准备好裁剪', HttpStatus.CONFLICT);
    }
    if (todayJobs >= user.dailyMattingQuota) {
      throw new ApiError('QUOTA_EXCEEDED', '今日自动抠图次数已用完', HttpStatus.TOO_MANY_REQUESTS);
    }
    const version = isRetry ? collectible.processingVersion + 1 : collectible.processingVersion;
    const idempotencyKey = `matting:${id}:v${version}`;
    const job = await this.prisma.$transaction(async (transaction) => {
      await transaction.collectible.update({
        where: { id },
        data: {
          processingStatus: ProcessingStatus.MATTING,
          processingError: null,
          processingVersion: version,
          cropX: crop.x,
          cropY: crop.y,
          cropWidth: crop.width,
          cropHeight: crop.height,
          cropRotation: crop.rotation
        }
      });
      return transaction.processingJob.upsert({
        where: { idempotencyKey },
        create: { userId, collectibleId: id, type: JobType.MATTING, status: JobStatus.QUEUED, idempotencyKey },
        update: { status: JobStatus.QUEUED, errorMessage: null }
      });
    });
    await this.queues.add('matting', { processingJobId: job.id, collectibleId: id, userId, version }, idempotencyKey);
    return { jobId: job.id, processingStatus: ProcessingStatus.MATTING };
  }

  crop(userId: string, id: string, crop: CropInput) {
    return this.enqueueMatting(userId, id, crop);
  }

  async retry(userId: string, id: string) {
    const collectible = await this.prisma.collectible.findFirst({ where: { id, userId } });
    if (!collectible) throw new ApiError('NOT_FOUND', '收藏不存在', HttpStatus.NOT_FOUND);
    if (collectible.processingStatus !== ProcessingStatus.FAILED) {
      throw new ApiError('CONFLICT', '当前任务不需要重试', HttpStatus.CONFLICT);
    }
    if (
      collectible.cropX === null ||
      collectible.cropY === null ||
      collectible.cropWidth === null ||
      collectible.cropHeight === null ||
      collectible.cropRotation === null
    ) {
      throw new ApiError('CONFLICT', '缺少裁剪信息，请重新裁剪', HttpStatus.CONFLICT);
    }
    return this.enqueueMatting(
      userId,
      id,
      {
        x: collectible.cropX,
        y: collectible.cropY,
        width: collectible.cropWidth,
        height: collectible.cropHeight,
        rotation: collectible.cropRotation as CropInput['rotation']
      },
      true
    );
  }

  async keepCrop(userId: string, id: string) {
    const collectible = await this.prisma.collectible.findFirst({ where: { id, userId } });
    if (!collectible) throw new ApiError('NOT_FOUND', '收藏不存在', HttpStatus.NOT_FOUND);
    const fallback = await this.prisma.imageAsset.findFirst({
      where: { collectibleId: id, userId, kind: AssetKind.DISPLAY, status: AssetStatus.AVAILABLE },
      orderBy: { version: 'desc' }
    });
    if (!fallback) throw new ApiError('CONFLICT', '裁剪图尚未准备好', HttpStatus.CONFLICT);
    await this.prisma.collectible.update({
      where: { id },
      data: { processingStatus: ProcessingStatus.READY, processingError: null }
    });
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
    await this.prisma.$transaction(async (transaction) => {
      await transaction.collectible.delete({ where: { id } });
      await transaction.$executeRaw`
        UPDATE "User"
        SET "storageUsedBytes" = GREATEST(0, "storageUsedBytes" - ${bytes})
        WHERE "id" = ${userId}
      `;
    });
    if (keys.length) await this.queues.add('cleanup', { keys });
    return { success: true };
  }
}
