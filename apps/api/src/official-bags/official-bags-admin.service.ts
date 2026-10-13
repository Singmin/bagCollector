import { BAG_FEATURE_MODEL, DINO_SCAN_MODEL } from '@bagcollect/bag-vision';
import { HttpStatus, Injectable } from '@nestjs/common';
import { AssetKind, AssetStatus, ImageSide, OfficialBagStatus, OfficialProcessStatus, Prisma } from '@prisma/client';
import type { OfficialBagDto, OfficialBagStatus as OfficialBagStatusContract } from '@bagcollect/contracts';
import { imageData } from '../common/image-sides.js';
import { ApiError } from '../common/api-error.js';
import { QueueService } from '../common/queue.service.js';
import { PrismaService } from '../database/prisma.service.js';
import { CosService } from '../assets/cos.service.js';

const ALLOWED_CONTENT_TYPES = ['image/jpeg', 'image/png', 'image/webp', 'image/heic', 'image/heif'] as const;

/** 管理端列表允许排序的字段（白名单，防注入任意列排序）。 */
const SORTABLE_FIELDS = ['sortOrder', 'name', 'createdAt', 'claimedCount'] as const;

/** 袋子查询统一带出品牌名，以及「新扫描模型（DINO）主参考向量」的来源信息，
    用于在列表上标注该袋子是否已有特征向量。 */
const bagInclude = {
  brand: true,
  scanEmbeddings: {
    where: { model: DINO_SCAN_MODEL, referenceKey: 'primary' },
    select: { sourceKind: true, sourceVersion: true }
  }
} satisfies Prisma.OfficialBagInclude;

type BagWithBrand = Prisma.OfficialBagGetPayload<{ include: typeof bagInclude }>;

@Injectable()
export class OfficialBagsAdminService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly cos: CosService,
    private readonly queues: QueueService
  ) {}

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

  private async resolveBrandId(brandId: string | null | undefined): Promise<string | null> {
    if (brandId === null || brandId === undefined) return null;
    const brand = await this.prisma.brand.findUnique({ where: { id: brandId } });
    if (!brand) throw new ApiError('VALIDATION', '品牌不存在', HttpStatus.BAD_REQUEST);
    return brand.id;
  }

  private async toDto(bag: BagWithBrand): Promise<OfficialBagDto> {
    const images = await this.prisma.officialBagImage.findMany({
      where: { officialBagId: bag.id, status: AssetStatus.AVAILABLE },
      orderBy: { version: 'desc' }
    });
    const resolved = await imageData(this.prisma, this.cos, bag.id, true);
    const frontState = await this.prisma.officialBagImageSide.findUnique({ where: { officialBagId_side: { officialBagId: bag.id, side: ImageSide.FRONT } } });
    const first = (kind: AssetKind) => images.find((image) => image.side === ImageSide.FRONT && image.kind === kind && image.version === frontState?.publishedVersion);
    const [thumbnail, display] = await Promise.all([
      first(AssetKind.THUMBNAIL),
      first(AssetKind.DISPLAY)
    ]);
    /* 「是否已有特征向量」：当前版本图的提特征来源（CUTOUT 优先，DISPLAY 兜底），
       与 DINO 主参考向量的 sourceKind + sourceVersion 一致才算就绪，口径与匹配覆盖率一致。 */
    const featureSource =
      images.find((image) => image.side === ImageSide.FRONT && image.kind === AssetKind.CUTOUT && image.version === frontState?.publishedVersion) ??
      images.find((image) => image.side === ImageSide.FRONT && image.kind === AssetKind.DISPLAY && image.version === frontState?.publishedVersion);
    const hasEmbedding =
      Boolean(featureSource) &&
      bag.scanEmbeddings.some(
        (embedding) =>
          embedding.sourceKind === featureSource!.kind &&
          embedding.sourceVersion === featureSource!.version
      );
    return {
      id: bag.id, ...resolved,
      name: bag.name,
      ...(bag.brandId ? { brandId: bag.brandId } : {}),
      ...(bag.brand ? { brand: bag.brand.name } : {}),
      notes: bag.notes,
      tags: bag.tags,
      matting: bag.matting,
      status: bag.status,
      processStatus: bag.processStatus,
      ...(bag.processError ? { processError: bag.processError } : {}),
      claimedCount: bag.claimedCount,
      sortOrder: bag.sortOrder,
      ...(bag.publishedAt ? { publishedAt: bag.publishedAt.toISOString() } : {}),
      ...(thumbnail ? { thumbnailUrl: await this.cos.signedUrl(thumbnail.objectKey) } : {}),
      ...(display ? { displayImageUrl: await this.cos.signedUrl(display.objectKey) } : {}),
      hasEmbedding,
      createdAt: bag.createdAt.toISOString(),
      updatedAt: bag.updatedAt.toISOString()
    };
  }

  private async audit(adminId: string, action: string, targetId: string, metadata?: Prisma.InputJsonValue) {
    await this.prisma.auditLog.create({
      data: { adminId, action, targetId, ...(metadata !== undefined ? { metadata } : {}) }
    });
  }

  private async findBag(id: string) {
    const bag = await this.prisma.officialBag.findUnique({ where: { id }, include: bagInclude });
    if (!bag) throw new ApiError('NOT_FOUND', '官方袋子不存在', HttpStatus.NOT_FOUND);
    return bag;
  }

  async create(
    adminId: string,
    input: { name: string; brandId?: string | null; notes?: string; tags?: string[]; matting?: boolean; backMatting?: boolean }
  ) {
    // 新袋子自动排在最前（数字越大越靠前），运营不用手动填排序号。
    const max = await this.prisma.officialBag.aggregate({ _max: { sortOrder: true } });
    const bag = await this.prisma.officialBag.create({
      data: {
        name: input.name.trim(),
        ...(input.brandId !== undefined && input.brandId !== null
          ? { brandId: await this.resolveBrandId(input.brandId) }
          : {}),
        notes: input.notes ?? '',
        tags: input.tags ? this.normalizeTags(input.tags) : [],
        ...(input.matting !== undefined ? { matting: input.matting } : {}),
        imageSides: { create: [{ side: ImageSide.FRONT, matting: input.matting ?? false }, { side: ImageSide.BACK, matting: input.backMatting ?? false }] },
        sortOrder: (max._max.sortOrder ?? -1) + 1,
        createdById: adminId
      },
      include: bagInclude
    });
    await this.audit(adminId, 'OFFICIAL_BAG_CREATE', bag.id, { name: bag.name });
    return this.toDto(bag);
  }

  /**
   * Excel 批量导入。品牌按名称匹配（不区分大小写），不存在则自动创建；
   * 导入的袋子统一为草稿（DRAFT），由运营补图后手动点发布。
   * 整体跑在事务里：任一行失败则全部回滚，避免半成品。
   */
  async importBags(
    adminId: string,
    input: { items: Array<{ name: string; brandName?: string; notes?: string; tags?: string[] }> }
  ) {
    const createdIds = await this.prisma.$transaction(async (tx) => {
      const brandCache = new Map<string, string>();
      let nextSort = ((await tx.officialBag.aggregate({ _max: { sortOrder: true } }))._max.sortOrder ?? -1) + 1;
      let nextBrandSort = ((await tx.brand.aggregate({ _max: { sortOrder: true } }))._max.sortOrder ?? -1) + 1;

      const ids: string[] = [];
      for (const row of input.items) {
        let brandId: string | null = null;
        const brandName = row.brandName?.trim();
        if (brandName) {
          const key = brandName.toLocaleLowerCase();
          const cached = brandCache.get(key);
          if (cached) {
            brandId = cached;
          } else {
            const existing = await tx.brand.findFirst({
              where: { name: { equals: brandName, mode: 'insensitive' } }
            });
            if (existing) {
              brandId = existing.id;
            } else {
              const brand = await tx.brand.create({ data: { name: brandName, sortOrder: nextBrandSort++ } });
              brandId = brand.id;
            }
            brandCache.set(key, brandId);
          }
        }
        const bag = await tx.officialBag.create({
          data: {
            name: row.name.trim(),
            ...(brandId ? { brandId } : {}),
            notes: row.notes ?? '',
            tags: row.tags ? this.normalizeTags(row.tags) : [],
            sortOrder: nextSort++,
            createdById: adminId
          }
        });
        ids.push(bag.id);
      }
      return ids;
    });

    await this.audit(adminId, 'OFFICIAL_BAG_IMPORT', 'bulk', { count: createdIds.length });
    return { created: createdIds.length, ids: createdIds };
  }

  async list(
    query: {
      status?: OfficialBagStatusContract;
      search?: string;
      page?: number;
      pageSize?: number;
      sort?: string;
      order?: string;
    }
  ) {
    const pageSize = Math.min(Math.max(query.pageSize ?? 20, 1), 200);
    const page = Math.max(query.page ?? 1, 1);
    const search = query.search?.trim();
    const sortField = (SORTABLE_FIELDS as readonly string[]).includes(query.sort ?? '')
      ? (query.sort as (typeof SORTABLE_FIELDS)[number])
      : 'sortOrder';
    const sortOrder = query.order === 'asc' ? 'asc' : 'desc';
    const where = {
      ...(query.status ? { status: query.status } : {}),
      ...(search
        ? {
            OR: [
              { name: { contains: search, mode: 'insensitive' as const } },
              { brand: { name: { contains: search, mode: 'insensitive' as const } } },
              { tags: { has: search } }
            ]
          }
        : {})
    } satisfies Prisma.OfficialBagWhereInput;
    const [items, totalCount] = await Promise.all([
      this.prisma.officialBag.findMany({
        where,
        orderBy: [
          { [sortField]: sortOrder },
          { id: sortOrder }
        ] as Prisma.OfficialBagOrderByWithRelationInput[],
        skip: (page - 1) * pageSize,
        take: pageSize,
        include: bagInclude
      }),
      this.prisma.officialBag.count({ where })
    ]);
    return {
      items: await Promise.all(items.map((bag) => this.toDto(bag))),
      nextCursor: null,
      totalCount
    };
  }

  async detail(id: string) {
    return this.toDto(await this.findBag(id));
  }

  async update(
    adminId: string,
    id: string,
    input: {
      name?: string;
      brandId?: string | null;
      notes?: string;
      tags?: string[];
      matting?: boolean;
      backMatting?: boolean;
      status?: OfficialBagStatusContract;
      sortOrder?: number;
    }
  ) {
    const bag = await this.findBag(id);
    const brandId = input.brandId !== undefined ? await this.resolveBrandId(input.brandId) : undefined;
    await this.prisma.$transaction(async tx => {
      await tx.$queryRaw`SELECT "id" FROM "OfficialBag" WHERE "id" = ${id} FOR UPDATE`;
      if (input.status === OfficialBagStatus.PUBLISHED) {
        const front = await tx.officialBagImageSide.findUnique({ where: { officialBagId_side: { officialBagId: id, side: ImageSide.FRONT } } });
        if (front?.publishedVersion == null) throw new ApiError('CONFLICT', '正面图片尚未处理完成，不能发布', HttpStatus.CONFLICT);
      }
      await tx.officialBag.update({
      where: { id },
      data: {
        ...(input.name !== undefined ? { name: input.name } : {}),
        ...(brandId !== undefined ? { brandId } : {}),
        ...(input.notes !== undefined ? { notes: input.notes } : {}),
        ...(input.tags ? { tags: this.normalizeTags(input.tags) } : {}),
        ...(input.matting !== undefined ? { matting: input.matting } : {}),
        ...(input.sortOrder !== undefined ? { sortOrder: input.sortOrder } : {}),
        ...(input.status !== undefined
          ? {
              status: input.status,
              ...(input.status === OfficialBagStatus.PUBLISHED && bag.status !== OfficialBagStatus.PUBLISHED
                ? { publishedAt: new Date() }
                : {})
            }
          : {})
      }
      });
      for (const [side, matting] of [[ImageSide.FRONT, input.matting], [ImageSide.BACK, input.backMatting]] as const) {
        if (matting === undefined) continue;
        await tx.officialBagImageSide.upsert({ where: { officialBagId_side: { officialBagId: id, side } }, create: { officialBagId: id, side, matting }, update: { matting } });
      }
    });
    await this.audit(adminId, 'OFFICIAL_BAG_UPDATE', id, { status: input.status });
    return this.toDto(
      await this.prisma.officialBag.findUniqueOrThrow({ where: { id }, include: bagInclude })
    );
  }

  /**
   * 上传/替换官方袋子原图。管理后台统一经 API 服务器中转写入对象存储，
   * 上传后自动入队处理（可选抠图），处理状态在袋子上跟踪。
   * `matting` 由后台表单传入时会同时覆盖袋子的抠图设置。
   */
  async uploadImage(adminId: string, id: string, file: { body: Buffer; contentType: string; matting?: boolean; side?: ImageSide }) {
    if (!ALLOWED_CONTENT_TYPES.includes(file.contentType as (typeof ALLOWED_CONTENT_TYPES)[number]) || !file.body.length) throw new ApiError('UPLOAD_INVALID', '图片格式或大小不正确', HttpStatus.BAD_REQUEST);
    const side = file.side ?? ImageSide.FRONT;
    const bag = await this.findBag(id);
    const result = await this.prisma.$transaction(async tx => {
      await tx.$queryRaw`SELECT "id" FROM "OfficialBag" WHERE "id" = ${id} FOR UPDATE`;
      const state = await tx.officialBagImageSide.findUnique({ where: { officialBagId_side: { officialBagId: id, side } } });
      if (state?.processingStatus === OfficialProcessStatus.PROCESSING) throw new ApiError('CONFLICT', '这一面的图片正在处理', HttpStatus.CONFLICT);
      const version = (state?.processingVersion ?? 0) + 1;
      const matting = file.matting ?? state?.matting ?? (side === ImageSide.FRONT ? bag.matting : false);
      await tx.officialBagImageSide.upsert({ where: { officialBagId_side: { officialBagId: id, side } },
        create: { officialBagId: id, side, sourceVersion: version, processingVersion: version, processingStatus: OfficialProcessStatus.PROCESSING, matting },
        update: { sourceVersion: version, processingVersion: version, processingStatus: OfficialProcessStatus.PROCESSING, processingError: null, matting } });
      if (side === ImageSide.FRONT) await tx.officialBag.update({ where: { id }, data: { processStatus: state?.publishedVersion ? OfficialProcessStatus.READY : OfficialProcessStatus.PROCESSING, processError: null, matting } });
      return { version, matting };
    });
    const extension = ({ 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'image/heic': 'heic', 'image/heif': 'heif' } as Record<string, string>)[file.contentType];
    const key = `official/${id}/${side.toLowerCase()}/original/v${result.version}.${extension}`;
    try {
      await this.cos.putObject(key, file.body, file.contentType);
      await this.prisma.$transaction(async tx => {
        await tx.$queryRaw`SELECT "id" FROM "OfficialBag" WHERE "id" = ${id} FOR UPDATE`;
        const active = await tx.officialBagImageSide.findUnique({ where: { officialBagId_side: { officialBagId: id, side } } });
        if (!active || active.processingVersion !== result.version || active.sourceVersion !== result.version) throw new ApiError('CONFLICT', '这次图片上传已被取消', HttpStatus.CONFLICT);
      await tx.officialBagImage.create({ data: { officialBagId: id, side, kind: AssetKind.ORIGINAL, objectKey: key, contentType: file.contentType,
        declaredByteSize: BigInt(file.body.length), byteSize: BigInt(file.body.length), version: result.version } });
      });
      await this.queues.add('official-process', { officialBagId: id, side, version: result.version, sourceVersion: result.version, matting: result.matting }, `official-process:${id}:${side}:v${result.version}`);
    } catch (error) {
      await this.prisma.$transaction(async tx => {
        await tx.$queryRaw`SELECT "id" FROM "OfficialBag" WHERE "id" = ${id} FOR UPDATE`;
        const state = await tx.officialBagImageSide.findUnique({ where: { officialBagId_side: { officialBagId: id, side } } });
        if (!state || state.processingVersion !== result.version || state.processingStatus !== OfficialProcessStatus.PROCESSING) return;
        const message = '图片上传或任务提交失败，请重新上传';
        await tx.officialBagImageSide.update({ where: { officialBagId_side: { officialBagId: id, side } }, data: { processingStatus: OfficialProcessStatus.FAILED, processingError: message } });
        if (side === ImageSide.FRONT) await tx.officialBag.update({ where: { id }, data: { processStatus: state.publishedVersion !== null ? OfficialProcessStatus.READY : OfficialProcessStatus.FAILED, processError: message } });
      });
      throw error;
    }
    await this.audit(adminId, 'official-bag.upload-image', id, { side, version: result.version });
    return { ...result, side, processStatus: OfficialProcessStatus.PROCESSING };
  }

  async removeImage(adminId: string, id: string, side: ImageSide = ImageSide.FRONT) {
    const keys = await this.prisma.$transaction(async tx => {
      await tx.$queryRaw`SELECT "id" FROM "OfficialBag" WHERE "id" = ${id} FOR UPDATE`;
      const bag = await tx.officialBag.findUniqueOrThrow({ where: { id } });
      if (side === ImageSide.FRONT && bag.status === OfficialBagStatus.PUBLISHED) throw new ApiError('CONFLICT', '请先下架袋子，再移除正面主图', HttpStatus.CONFLICT);
      const images = await tx.officialBagImage.findMany({ where: { officialBagId: id, side } });
      await tx.officialBagImageSide.upsert({ where: { officialBagId_side: { officialBagId: id, side } }, create: { officialBagId: id, side }, update: { sourceVersion: 0, processingVersion: { increment: 1 }, publishedVersion: null, processingStatus: OfficialProcessStatus.PENDING, processingError: null } });
      await tx.officialBagImage.deleteMany({ where: { officialBagId: id, side } });
      if (side === ImageSide.FRONT) await tx.officialBag.update({ where: { id }, data: { version: { increment: 1 }, processStatus: OfficialProcessStatus.PENDING, processError: null } });
      return images.map(image => image.objectKey);
    });
    if (keys.length) await this.queues.add('cleanup', { keys });
    await this.audit(adminId, 'official-bag.remove-image', id, { side });
    return this.detail(id);
  }

  async remove(adminId: string, id: string) {
    const bag = await this.findBag(id);
    const keys = await this.prisma.$transaction(async tx => {
      await tx.$queryRaw`SELECT "id" FROM "OfficialBag" WHERE "id" = ${id} FOR UPDATE`;
      const [collections, claims] = await Promise.all([
        tx.collectible.count({ where: { sourceOfficialBagId: id } }),
        tx.officialClaim.count({ where: { officialBagId: id } })
      ]);
      if (collections || claims) throw new ApiError('CONFLICT', '此袋子仍被用户收藏引用，请下架保留，不能删除', HttpStatus.CONFLICT);
      const images = await tx.officialBagImage.findMany({ where: { officialBagId: id }, select: { objectKey: true } });
      const references = await tx.bagReferenceImage.findMany({ where: { officialBagId: id }, select: { objectKey: true } });
      // Learned images retain their own lifecycle and capacity accounting.
      images.push(...references.filter(ref => !ref.objectKey.startsWith('learning-samples/')));
      await tx.officialBag.delete({ where: { id } });
      return images.map(image => image.objectKey);
    });
    if (keys.length) await this.queues.add('cleanup', { keys });
    await this.audit(adminId, 'OFFICIAL_BAG_DELETE', id, { name: bag.name });
    return { success: true };
  }

  /**
   * 手动触发官方袋子向量补算（管理后台的「补算袋子向量」按钮）。
   *
   * 走队列而不是在 API 进程里直接算：提取特征要下载并解码图片、做像素级计算，
   * 是 CPU 活，放在这里会占住事件循环、拖慢所有接口。worker 本来就在干这类事，
   * 而且有并发控制 —— 那边跑的就是它定时跑的那一轮（找缺失 + 限量补算）。
   *
   * 返回的 pending 是「完全没有向量」的袋子数，是个近似值：它不统计「向量还在、
   * 但依据的是旧版本图」的情况 —— 那需要在 worker 里逐袋比对图片版本才知道，
   * 为一句进度提示多花一次全表扫描不值得。真正的补算结果以 worker 那轮为准。
   */
  async reconcileEmbeddings(adminId: string) {
    const pending = await this.prisma.officialBag.count({
      where: {
        processStatus: OfficialProcessStatus.READY,
        embeddings: { none: { model: BAG_FEATURE_MODEL } }
      }
    });
    await this.queues.add('embed-reconcile', {});
    await this.queues.scans.add('reconcile', {}, { priority: 20, attempts: 1, removeOnComplete: 20, removeOnFail: 20 });
    await this.audit(adminId, 'OFFICIAL_BAG_EMBEDDING_RECONCILE', 'embeddings', { pending });
    return { queued: true, pending };
  }
}
