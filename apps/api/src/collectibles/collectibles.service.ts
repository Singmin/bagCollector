import { HttpStatus, Injectable } from '@nestjs/common';
import { AssetKind, AssetStatus, JobStatus, JobType, ProcessingStatus, Prisma } from '@prisma/client';
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

  /** 官方袋子的最新可用图片签名 URL（按 kind）。认领的收藏自己没有图时回退到这里。 */
  private async officialUrlsByKind(bagId: string): Promise<Partial<Record<AssetKind, string>>> {
    const assets = await this.prisma.officialBagImage.findMany({
      where: { officialBagId: bagId, status: AssetStatus.AVAILABLE },
      orderBy: { version: 'desc' }
    });
    const first = (kind: AssetKind) => assets.find((asset) => asset.kind === kind);
    const entries = await Promise.all(
      [AssetKind.THUMBNAIL, AssetKind.DISPLAY, AssetKind.STANDARD, AssetKind.CUTOUT].map(async (kind) => {
        const asset = first(kind);
        return [kind, asset ? await this.cos.signedUrl(asset.objectKey) : undefined] as const;
      })
    );
    return Object.fromEntries(entries) as Partial<Record<AssetKind, string>>;
  }

  /** 官方袋子缩略图签名 URL（列表页认领收藏按需回退，只查缩略图）。 */
  private async officialThumbnailUrl(bagId: string): Promise<string | undefined> {
    const thumbnail = await this.prisma.officialBagImage.findFirst({
      where: { officialBagId: bagId, kind: AssetKind.THUMBNAIL, status: AssetStatus.AVAILABLE },
      orderBy: { version: 'desc' }
    });
    return thumbnail ? this.cos.signedUrl(thumbnail.objectKey) : undefined;
  }

  private async toDto(collectible: any) {
    const urls = await this.assets.urlsByKind(collectible.id, collectible.userId);
    const official = collectible.sourceOfficialBagId
      ? await this.officialUrlsByKind(collectible.sourceOfficialBagId)
      : {};
    const url = (kind: AssetKind) => urls[kind] ?? official[kind];
    return {
      id: collectible.id,
      name: collectible.name,
      notes: collectible.notes,
      quantity: collectible.quantity ?? 1,
      visibility: collectible.visibility ?? 'PUBLIC',
      tags: collectible.tags.map((entry: any) => entry.tag.displayName),
      shelfId: collectible.shelfId,
      shelfName: collectible.shelf.name,
      processingStatus: collectible.processingStatus,
      ...(collectible.processingError ? { processingError: collectible.processingError } : {}),
      ...(url(AssetKind.THUMBNAIL) ? { thumbnailUrl: url(AssetKind.THUMBNAIL) } : {}),
      ...(url(AssetKind.DISPLAY) ? { displayImageUrl: url(AssetKind.DISPLAY) } : {}),
      ...(url(AssetKind.STANDARD) ? { standardImageUrl: url(AssetKind.STANDARD) } : {}),
      /* 抠图结果：有值表示已有透明图，编辑页据此隐藏「自动抠图」按钮（裁剪不产出该资产） */
      ...(url(AssetKind.CUTOUT) ? { cutoutImageUrl: url(AssetKind.CUTOUT) } : {}),
      /* 已保存的裁剪参数：编辑页「自动抠图」要原样回传，否则会把用户裁好的画面重置成全幅 */
      ...(collectible.cropX !== null
        ? {
            crop: {
              x: collectible.cropX,
              y: collectible.cropY ?? 0,
              width: collectible.cropWidth ?? 1,
              height: collectible.cropHeight ?? 1,
              rotation: collectible.cropRotation ?? 0,
              ...(collectible.cropBrightness !== null ? { brightness: collectible.cropBrightness } : {}),
              ...(collectible.cropContrast !== null ? { contrast: collectible.cropContrast } : {}),
              ...(collectible.cropSaturation !== null ? { saturation: collectible.cropSaturation } : {})
            }
          }
        : {}),
      addedAt: collectible.addedAt.toISOString(),
      updatedAt: collectible.updatedAt.toISOString()
    };
  }

  private async toSummary(collectible: any) {
    const thumbnail = collectible.imageAssets[0];
    const thumbnailUrl = thumbnail
      ? await this.assets.signedUrlForObjectKey(thumbnail.objectKey)
      : collectible.sourceOfficialBagId
        ? await this.officialThumbnailUrl(collectible.sourceOfficialBagId)
        : undefined;
    return {
      id: collectible.id,
      name: collectible.name,
      shelfId: collectible.shelfId,
      shelfName: collectible.shelf.name,
      quantity: collectible.quantity ?? 1,
      visibility: collectible.visibility ?? 'PUBLIC',
      processingStatus: collectible.processingStatus,
      ...(thumbnailUrl ? { thumbnailUrl } : {}),
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

  private listInclude() {
    return {
      shelf: true,
      imageAssets: {
        where: { kind: AssetKind.THUMBNAIL, status: AssetStatus.AVAILABLE },
        orderBy: { version: 'desc' as const },
        take: 1
      }
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
    const limit = Math.min(Math.max(query.limit ?? 30, 1), 100);
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

  /* 只有「空闲」状态才允许再发起一次处理：AWAITING_CROP 是首次，READY / FAILED 可重跑；
     正在处理中（UPLOADING / NORMALIZING / CROPPING / MATTING）一律拒绝 */
  private assertIdle(status: ProcessingStatus, conflictMessage: string) {
    const idle: ProcessingStatus[] = [
      ProcessingStatus.AWAITING_CROP,
      ProcessingStatus.READY,
      ProcessingStatus.FAILED
    ];
    if (!idle.includes(status)) throw new ApiError('CONFLICT', conflictMessage, HttpStatus.CONFLICT);
  }

  /* 重跑（READY / FAILED 之后再提交）递增版本号：产物写到新版本，
     不然同名对象被覆盖、签名 URL 不变，前端可能还在读旧图 */
  private nextVersion(collectible: { processingStatus: ProcessingStatus; processingVersion: number }) {
    return collectible.processingStatus === ProcessingStatus.AWAITING_CROP
      ? collectible.processingVersion
      : collectible.processingVersion + 1;
  }

  /* 成本闸门：抠图按次计费（万象），每张图只允许成功抠一次。
     判据是「有没有可用的 CUTOUT 资产」，而不是状态 —— 状态会被后续裁剪改写。
     仅在 READY（上一次已成功跑完）时把闸门拉死；FAILED 允许重试，避免一次网络抖动就废掉整张图 */
  private async assertNotMatted(userId: string, collectibleId: string, conflictMessage: string) {
    const cutout = await this.prisma.imageAsset.findFirst({
      where: {
        userId,
        collectibleId,
        kind: AssetKind.CUTOUT,
        status: AssetStatus.AVAILABLE
      },
      select: { id: true }
    });
    if (cutout) throw new ApiError('CONFLICT', conflictMessage, HttpStatus.CONFLICT);
  }

  private cropFields(crop: Partial<CropInput>) {
    return {
      cropX: crop.x ?? 0,
      cropY: crop.y ?? 0,
      cropWidth: crop.width ?? 1,
      cropHeight: crop.height ?? 1,
      cropRotation: crop.rotation ?? 0,
      cropBrightness: crop.brightness ?? null,
      cropContrast: crop.contrast ?? null,
      cropSaturation: crop.saturation ?? null
    };
  }

  /** POST /collectibles/:id/crop —— 裁剪：按裁剪参数重新出图（展示图 / 缩略图）。
   *  该图已抠过时（rematte）会顺带重新抠图，保持透明图与新展示图对齐；
   *  此举不消耗每日配额（同一张图只计一次万象扣费，配额在 /matte 入口计），也不会被成本闸门拦截。 */
  private async enqueueCrop(userId: string, id: string, crop: CropInput) {
    const collectible = await this.prisma.collectible.findFirst({ where: { id, userId } });
    if (!collectible) throw new ApiError('NOT_FOUND', '收藏不存在', HttpStatus.NOT_FOUND);
    this.assertIdle(collectible.processingStatus, '图片尚未准备好裁剪');
    /* 已有透明图的图再次裁剪：必须重新抠图，否则新展示图与旧透明图构图上失配。
       不拦截、不计配额 —— worker 据 rematte 走「裁剪 + 重新抠图」流水线。
       透明图判定含官方源：认领的官方袋子若官方已抠图，用户裁剪同样要保持透明 */
    const rematte = await this.isTransparent(userId, collectible);
    const version = this.nextVersion(collectible);
    const idempotencyKey = `crop:${id}:v${version}`;
    const job = await this.prisma.$transaction(async (transaction) => {
      await transaction.collectible.update({
        where: { id },
        data: {
          processingStatus: ProcessingStatus.CROPPING,
          processingError: null,
          processingVersion: version,
          ...this.cropFields(crop)
        }
      });
      return transaction.processingJob.upsert({
        where: { idempotencyKey },
        create: { userId, collectibleId: id, type: JobType.CROP, status: JobStatus.QUEUED, idempotencyKey },
        update: { status: JobStatus.QUEUED, errorMessage: null }
      });
    });
    await this.queues.add('crop', { processingJobId: job.id, collectibleId: id, userId, version, rematte }, idempotencyKey);
    return { jobId: job.id, processingStatus: ProcessingStatus.CROPPING };
  }

  /** 该图是否已有可用的抠图结果（CUTOUT 资产）。抠图按次计费，凭此判定「是否已抠过」 */
  private async hasCutout(userId: string, collectibleId: string) {
    const cutout = await this.prisma.imageAsset.findFirst({
      where: { userId, collectibleId, kind: AssetKind.CUTOUT, status: AssetStatus.AVAILABLE },
      select: { id: true }
    });
    return !!cutout;
  }

  /** 该收藏是否已有透明图（决定裁剪是否要 rematte 重抠）：
   *  用户自己抠过，或引用官方袋子且官方已抠过图（透明展示图）。 */
  private async isTransparent(userId: string, collectible: { id: string; sourceOfficialBagId: string | null }) {
    if (await this.hasCutout(userId, collectible.id)) return true;
    if (!collectible.sourceOfficialBagId) return false;
    const official = await this.prisma.officialBagImage.findFirst({
      where: { officialBagId: collectible.sourceOfficialBagId, kind: AssetKind.CUTOUT, status: AssetStatus.AVAILABLE },
      select: { id: true }
    });
    return !!official;
  }

  /** POST /collectibles/:id/matte —— 抠图：沿用已保存的裁剪参数（从未裁剪过则全幅），
      override 可只覆盖其中几个字段。配额按次计，与裁剪无关 */
  private async enqueueMatting(userId: string, id: string, override: MatteInput) {
    const startOfDay = new Date();
    startOfDay.setHours(0, 0, 0, 0);
    const [collectible, user, todayJobs] = await Promise.all([
      this.prisma.collectible.findFirst({ where: { id, userId } }),
      this.prisma.user.findUnique({ where: { id: userId } }),
      /* 配额只计「已成功 + 进行中」的抠图，失败的不计入——
         否则一次万象抖动就会吃掉当日名额、还挡住重试（P1 修复）。
         同一张图不会并发两次（assertIdle 拦 MATTING），故 QUEUED/RUNNING 不会重复计数 */
      this.prisma.processingJob.count({
        where: {
          userId,
          type: JobType.MATTING,
          createdAt: { gte: startOfDay },
          status: { in: [JobStatus.QUEUED, JobStatus.RUNNING, JobStatus.SUCCEEDED] }
        }
      })
    ]);
    if (!collectible || !user) throw new ApiError('NOT_FOUND', '收藏不存在', HttpStatus.NOT_FOUND);
    this.assertIdle(collectible.processingStatus, '图片尚未准备好抠图');
    /* 每张图只允许抠一次（万象按次计费）：已成功抠过就直接拒绝，不再重复扣费 */
    if (collectible.processingStatus === ProcessingStatus.READY) {
      await this.assertNotMatted(userId, id, '这张图片已经抠过图了，每张图片仅支持抠图一次');
    }
    if (todayJobs >= user.dailyMattingQuota) {
      throw new ApiError('QUOTA_EXCEEDED', '今日自动抠图次数已用完', HttpStatus.TOO_MANY_REQUESTS);
    }
    const version = this.nextVersion(collectible);
    /* 抠图不能凭空改变画面：优先用请求里给的字段，其次用上次保存的裁剪参数，都没有才按全幅 */
    const crop = {
      x: override.x ?? collectible.cropX ?? 0,
      y: override.y ?? collectible.cropY ?? 0,
      width: override.width ?? collectible.cropWidth ?? 1,
      height: override.height ?? collectible.cropHeight ?? 1,
      rotation: override.rotation ?? collectible.cropRotation ?? 0,
      brightness: override.brightness ?? collectible.cropBrightness ?? undefined,
      contrast: override.contrast ?? collectible.cropContrast ?? undefined,
      saturation: override.saturation ?? collectible.cropSaturation ?? undefined
    };
    const idempotencyKey = `matting:${id}:v${version}`;
    const job = await this.prisma.$transaction(async (transaction) => {
      await transaction.collectible.update({
        where: { id },
        data: {
          processingStatus: ProcessingStatus.MATTING,
          processingError: null,
          processingVersion: version,
          ...this.cropFields(crop)
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
    return this.enqueueCrop(userId, id, crop);
  }

  matte(userId: string, id: string, override: MatteInput) {
    return this.enqueueMatting(userId, id, override);
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
