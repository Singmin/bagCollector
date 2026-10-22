import { HttpStatus, Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import type { BrandDto } from '@bagcollect/contracts';
import { ApiError } from '../common/api-error.js';
import { QueueService } from '../common/queue.service.js';
import { PrismaService } from '../database/prisma.service.js';
import { CosService } from '../assets/cos.service.js';

const ALLOWED_CONTENT_TYPES = ['image/jpeg', 'image/png', 'image/webp', 'image/heic', 'image/heif'] as const;

@Injectable()
export class BrandsAdminService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly cos: CosService,
    private readonly queues: QueueService
  ) {}

  private async toDto(brand: Prisma.BrandGetPayload<{ include: { _count: { select: { bags: true } } } }>): Promise<BrandDto> {
    return {
      id: brand.id,
      name: brand.name,
      sortOrder: brand.sortOrder,
      ...(brand.displayImageKey ? { displayImageUrl: await this.cos.signedUrl(brand.displayImageKey) } : {}),
      bagCount: brand._count.bags,
      createdAt: brand.createdAt.toISOString(),
      updatedAt: brand.updatedAt.toISOString()
    };
  }

  async list() {
    const brands = await this.prisma.brand.findMany({
      orderBy: [{ sortOrder: 'desc' }, { createdAt: 'asc' }],
      include: { _count: { select: { bags: true } } }
    });
    return Promise.all(brands.map((brand) => this.toDto(brand)));
  }

  async create(adminId: string, input: { name: string; sortOrder?: number }) {
    const name = input.name.trim();
    if (!name) throw new ApiError('VALIDATION', '品牌名不能为空', HttpStatus.BAD_REQUEST);
    const existing = await this.prisma.brand.findFirst({ where: { name: { equals: name, mode: 'insensitive' } } });
    if (existing) throw new ApiError('CONFLICT', '同名品牌已存在', HttpStatus.CONFLICT);
    // 未显式传排序时自动接在现有最大值后面（数字越大越靠前，新品牌排最前）。
    const max = input.sortOrder !== undefined
      ? undefined
      : await this.prisma.brand.aggregate({ _max: { sortOrder: true } });
    const brand = await this.prisma.brand.create({
      data: {
        name,
        ...(input.sortOrder !== undefined
          ? { sortOrder: input.sortOrder }
          : { sortOrder: (max?._max.sortOrder ?? -1) + 1 })
      },
      include: { _count: { select: { bags: true } } }
    });
    await this.prisma.auditLog.create({ data: { adminId, action: 'BRAND_CREATE', targetId: brand.id, metadata: { name } } });
    return this.toDto(brand);
  }

  async update(adminId: string, id: string, input: { name?: string; sortOrder?: number }) {
    const brand = await this.prisma.brand.findUnique({ where: { id } });
    if (!brand) throw new ApiError('NOT_FOUND', '品牌不存在', HttpStatus.NOT_FOUND);
    const data: Prisma.BrandUpdateInput = {};
    if (input.name !== undefined) {
      const name = input.name.trim();
      if (!name) throw new ApiError('VALIDATION', '品牌名不能为空', HttpStatus.BAD_REQUEST);
      const duplicate = await this.prisma.brand.findFirst({
        where: { name: { equals: name, mode: 'insensitive' }, id: { not: id } }
      });
      if (duplicate) throw new ApiError('CONFLICT', '同名品牌已存在', HttpStatus.CONFLICT);
      data.name = name;
    }
    if (input.sortOrder !== undefined) data.sortOrder = input.sortOrder;
    const updated = await this.prisma.brand.update({
      where: { id },
      data,
      include: { _count: { select: { bags: true } } }
    });
    await this.prisma.auditLog.create({
      data: { adminId, action: 'BRAND_UPDATE', targetId: id, metadata: { name: input.name, sortOrder: input.sortOrder } }
    });
    return this.toDto(updated);
  }

  /**
   * 上传/替换品牌展示图。与官方袋子一样经 API 中转写入 COS，
   * key 自带 v{n} 版本号（换 key 而非覆盖，避免 CDN 长缓存旧图）；
   * 上传成功后旧图交清理队列删除。
   */
  async uploadImage(adminId: string, id: string, file: { body: Buffer; contentType: string }) {
    if (!ALLOWED_CONTENT_TYPES.includes(file.contentType as (typeof ALLOWED_CONTENT_TYPES)[number]) || !file.body.length) {
      throw new ApiError('UPLOAD_INVALID', '图片格式或大小不正确', HttpStatus.BAD_REQUEST);
    }
    const brand = await this.prisma.brand.findUnique({ where: { id } });
    if (!brand) throw new ApiError('NOT_FOUND', '品牌不存在', HttpStatus.NOT_FOUND);
    const extension = ({ 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'image/heic': 'heic', 'image/heif': 'heif' } as Record<string, string>)[file.contentType];
    const version = brand.displayImageVersion + 1;
    const key = `brand/${id}/display/v${version}.${extension}`;
    await this.cos.putObject(key, file.body, file.contentType);
    const updated = await this.prisma.brand.update({
      where: { id },
      data: { displayImageKey: key, displayImageVersion: version },
      include: { _count: { select: { bags: true } } }
    });
    if (brand.displayImageKey) await this.queues.add('cleanup', { keys: [brand.displayImageKey] });
    await this.prisma.auditLog.create({
      data: { adminId, action: 'BRAND_UPDATE_IMAGE', targetId: id, metadata: { name: brand.name, version } }
    });
    return this.toDto(updated);
  }

  /** 移除品牌展示图：清空字段，COS 对象交清理队列删除。 */
  async removeDisplayImage(adminId: string, id: string) {
    const brand = await this.prisma.brand.findUnique({ where: { id } });
    if (!brand) throw new ApiError('NOT_FOUND', '品牌不存在', HttpStatus.NOT_FOUND);
    const updated = await this.prisma.brand.update({
      where: { id },
      data: { displayImageKey: null },
      include: { _count: { select: { bags: true } } }
    });
    if (brand.displayImageKey) await this.queues.add('cleanup', { keys: [brand.displayImageKey] });
    await this.prisma.auditLog.create({
      data: { adminId, action: 'BRAND_REMOVE_IMAGE', targetId: id, metadata: { name: brand.name } }
    });
    return this.toDto(updated);
  }

  /**
   * 删除品牌：旗下还有袋子时不允许直接删（袋子会失去品牌归属），
   * 提示先把袋子转移到其他品牌或清空品牌后再删。
   */
  async remove(adminId: string, id: string) {
    const brand = await this.prisma.brand.findUnique({
      where: { id },
      include: { _count: { select: { bags: true } } }
    });
    if (!brand) throw new ApiError('NOT_FOUND', '品牌不存在', HttpStatus.NOT_FOUND);
    if (brand._count.bags > 0) {
      throw new ApiError('CONFLICT', `该品牌下还有 ${brand._count.bags} 个袋子，请先转移或清空后再删除`, HttpStatus.CONFLICT);
    }
    const keys = brand.displayImageKey ? [brand.displayImageKey] : [];
    await this.prisma.brand.delete({ where: { id } });
    if (keys.length) await this.queues.add('cleanup', { keys });
    await this.prisma.auditLog.create({ data: { adminId, action: 'BRAND_DELETE', targetId: id, metadata: { name: brand.name } } });
    return { success: true };
  }
}
