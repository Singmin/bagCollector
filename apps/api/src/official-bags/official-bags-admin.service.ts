import { HttpStatus, Injectable } from '@nestjs/common';
import { AssetKind, AssetStatus, OfficialBagStatus, OfficialProcessStatus, Prisma } from '@prisma/client';
import type { OfficialBagDto, OfficialBagStatus as OfficialBagStatusContract } from '@bagcollect/contracts';
import { ApiError } from '../common/api-error.js';
import { QueueService } from '../common/queue.service.js';
import { PrismaService } from '../database/prisma.service.js';
import { CosService } from '../assets/cos.service.js';

const ALLOWED_CONTENT_TYPES = ['image/jpeg', 'image/png', 'image/webp', 'image/heic', 'image/heif'] as const;

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

  async list(
    query: { status?: OfficialBagStatusContract; search?: string; cursor?: string; limit?: number }
  ) {
    const limit = Math.min(Math.max(query.limit ?? 30, 1), 100);
    const search = query.search?.trim();
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
        ...(query.cursor ? { cursor: { id: query.cursor }, skip: 1 } : {}),
        orderBy: [{ sortOrder: 'desc' }, { createdAt: 'desc' }],
        take: limit + 1,
        include: { brand: true }
      }),
      this.prisma.officialBag.count({ where })
    ]);
    const hasMore = items.length > limit;
    const page = hasMore ? items.slice(0, limit) : items;
    return {
      items: await Promise.all(page.map((bag) => this.toDto(bag))),
      nextCursor: hasMore ? page.at(-1)?.id ?? null : null,
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

  async remove(adminId: string, id: string) {
    const bag = await this.findBag(id);
    if (bag.claimedCount > 0) {
      throw new ApiError('CONFLICT', '该袋子已被用户拥有，只能下架不能删除', HttpStatus.CONFLICT);
    }
    const images = await this.prisma.officialBagImage.findMany({
      where: { officialBagId: id },
      select: { objectKey: true }
    });
    await this.prisma.officialBag.delete({ where: { id } });
    if (images.length) {
      await this.queues.add('cleanup', { keys: images.map((image) => image.objectKey) });
    }
    await this.audit(adminId, 'OFFICIAL_BAG_DELETE', id, { name: bag.name });
    return { success: true };
  }
}
