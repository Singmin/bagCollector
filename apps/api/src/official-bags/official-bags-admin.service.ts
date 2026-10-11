import { BAG_FEATURE_MODEL } from '@bagcollect/bag-vision';
import { HttpStatus, Injectable } from '@nestjs/common';
import { AssetKind, AssetStatus, OfficialBagStatus, OfficialProcessStatus, Prisma } from '@prisma/client';
import type { OfficialBagDto, OfficialBagStatus as OfficialBagStatusContract } from '@bagcollect/contracts';
import { ApiError } from '../common/api-error.js';
import { QueueService } from '../common/queue.service.js';
import { PrismaService } from '../database/prisma.service.js';
import { CosService } from '../assets/cos.service.js';

const ALLOWED_CONTENT_TYPES = ['image/jpeg', 'image/png', 'image/webp', 'image/heic', 'image/heif'] as const;

/** 管理端列表允许排序的字段（白名单，防注入任意列排序）。 */
const SORTABLE_FIELDS = ['sortOrder', 'name', 'createdAt', 'claimedCount'] as const;

/** 袋子查询统一带出品牌名。 */
type BagWithBrand = Prisma.OfficialBagGetPayload<{ include: { brand: true } }>;

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
    const first = (kind: AssetKind) => images.find((image) => image.kind === kind);
    const [thumbnail, display] = await Promise.all([
      first(AssetKind.THUMBNAIL),
      first(AssetKind.DISPLAY)
    ]);
    return {
      id: bag.id,
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
    const bag = await this.prisma.officialBag.findUnique({ where: { id }, include: { brand: true } });
    if (!bag) throw new ApiError('NOT_FOUND', '官方袋子不存在', HttpStatus.NOT_FOUND);
    return bag;
  }

  async create(
    adminId: string,
    input: { name: string; brandId?: string | null; notes?: string; tags?: string[]; matting?: boolean }
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
        sortOrder: (max._max.sortOrder ?? -1) + 1,
        createdById: adminId
      },
      include: { brand: true }
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
        include: { brand: true }
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
      status?: OfficialBagStatusContract;
      sortOrder?: number;
    }
  ) {
    const bag = await this.findBag(id);
    if (input.status === OfficialBagStatus.PUBLISHED) {
      const hasImage = await this.prisma.officialBagImage.findFirst({
        where: { officialBagId: id, kind: AssetKind.ORIGINAL, status: AssetStatus.AVAILABLE }
      });
      if (!hasImage || bag.processStatus !== OfficialProcessStatus.READY) {
        throw new ApiError('CONFLICT', '图片尚未上传或处理完成，不能发布', HttpStatus.CONFLICT);
      }
    }
    await this.prisma.officialBag.update({
      where: { id },
      data: {
        ...(input.name !== undefined ? { name: input.name } : {}),
        ...(input.brandId !== undefined ? { brandId: await this.resolveBrandId(input.brandId) } : {}),
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
    await this.audit(adminId, 'OFFICIAL_BAG_UPDATE', id, { status: input.status });
    return this.toDto(
      await this.prisma.officialBag.findUniqueOrThrow({ where: { id }, include: { brand: true } })
    );
  }

  /**
   * 上传/替换官方袋子原图。管理后台统一经 API 服务器中转写入对象存储，
   * 上传后自动入队处理（可选抠图），处理状态在袋子上跟踪。
   * `matting` 由后台表单传入时会同时覆盖袋子的抠图设置。
   */
  async uploadImage(
    adminId: string,
    id: string,
    file: { body: Buffer; contentType: string; matting?: boolean }
  ) {
    const bag = await this.findBag(id);
    if (!ALLOWED_CONTENT_TYPES.includes(file.contentType as (typeof ALLOWED_CONTENT_TYPES)[number])) {
      throw new ApiError('UPLOAD_INVALID', '只支持 JPEG / PNG / WebP / HEIC 图片', HttpStatus.BAD_REQUEST);
    }
    if (file.body.length <= 0) {
      throw new ApiError('UPLOAD_INVALID', '图片内容为空', HttpStatus.BAD_REQUEST);
    }
    const version = bag.version + 1;
    const extension = ({
      'image/jpeg': 'jpg',
      'image/png': 'png',
      'image/webp': 'webp',
      'image/heic': 'heic',
      'image/heif': 'heif'
    } as Record<string, string>)[file.contentType] ?? 'bin';
    const key = `official/${bag.id}/original/v${version}.${extension}`;
    await this.cos.putObject(key, file.body, file.contentType);
    await this.prisma.officialBagImage.create({
      data: {
        officialBagId: bag.id,
        kind: AssetKind.ORIGINAL,
        status: AssetStatus.AVAILABLE,
        objectKey: key,
        contentType: file.contentType,
        declaredByteSize: BigInt(file.body.length),
        byteSize: BigInt(file.body.length),
        version
      }
    });
    // 表单里的「执行抠图」开关直接决定这次处理：勾了就按抠图跑，不必先保存再上传。
    const matting = file.matting ?? bag.matting;
    await this.prisma.officialBag.update({
      where: { id: bag.id },
      data: {
        version,
        processStatus: OfficialProcessStatus.PROCESSING,
        processError: null,
        ...(file.matting !== undefined ? { matting: file.matting } : {})
      }
    });
    await this.queues.add(
      'official-process',
      { officialBagId: bag.id, version, matting },
      `official-process:${bag.id}:v${version}`
    );
    await this.audit(adminId, 'OFFICIAL_BAG_UPLOAD', bag.id, {
      version,
      byteSize: file.body.length,
      matting
    });
    return { version, processStatus: OfficialProcessStatus.PROCESSING };
  }

  /**
   * 删除袋子上的全部图片（原图 + 各版本衍生图），把袋子退回「未上传图片」状态。
   * 已发布袋子会一并下架，避免小程序端展示空图；已被拥有的袋子同样允许操作。
   * version 继续自增，让仍在处理中的旧任务判定为过期，不再把图片写回来。
   */
  async removeImage(adminId: string, id: string) {
    const bag = await this.findBag(id);
    const images = await this.prisma.officialBagImage.findMany({
      where: { officialBagId: id },
      select: { objectKey: true }
    });
    await this.prisma.$transaction([
      this.prisma.officialBagImage.deleteMany({ where: { officialBagId: id } }),
      this.prisma.officialBag.update({
        where: { id },
        data: {
          version: bag.version + 1,
          processStatus: OfficialProcessStatus.PENDING,
          processError: null,
          status: bag.status === OfficialBagStatus.PUBLISHED ? OfficialBagStatus.OFFLINE : bag.status
        }
      })
    ]);
    if (images.length) {
      await this.queues.add('cleanup', { keys: images.map((image) => image.objectKey) });
    }
    await this.audit(adminId, 'OFFICIAL_BAG_IMAGE_DELETE', id, {
      version: bag.version,
      objectCount: images.length
    });
    return this.toDto(await this.prisma.officialBag.findUniqueOrThrow({ where: { id }, include: { brand: true } }));
  }

  /**
   * 删除官方袋子。已被用户「拥有」的也允许删（管理端会二次确认）：
   * 用户的拥有记录（OfficialClaim）与心愿标记（WishlistItem）由数据库级联清除，
   * 用户已收藏到自己架子的袋子是独立副本，不受影响。
   */
  async remove(adminId: string, id: string) {
    const bag = await this.findBag(id);
    const images = await this.prisma.officialBagImage.findMany({
      where: { officialBagId: id },
      select: { objectKey: true }
    });
    const references = await this.prisma.bagReferenceImage.findMany({ where: { officialBagId: id }, select: { objectKey: true } });
    images.push(...references);
    await this.prisma.officialBag.delete({ where: { id } });
    if (images.length) {
      await this.queues.add('cleanup', { keys: images.map((image) => image.objectKey) });
    }
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
    await this.queues.scans.add('reconcile', {}, { attempts: 1, removeOnComplete: 20, removeOnFail: 20 });
    await this.audit(adminId, 'OFFICIAL_BAG_EMBEDDING_RECONCILE', 'embeddings', { pending });
    return { queued: true, pending };
  }
}
