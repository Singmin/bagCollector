import { HttpStatus, Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import type { BrandDto } from '@bagcollect/contracts';
import { ApiError } from '../common/api-error.js';
import { PrismaService } from '../database/prisma.service.js';

@Injectable()
export class BrandsAdminService {
  constructor(private readonly prisma: PrismaService) {}

  private toDto(brand: Prisma.BrandGetPayload<{ include: { _count: { select: { bags: true } } } }>): BrandDto {
    return {
      id: brand.id,
      name: brand.name,
      sortOrder: brand.sortOrder,
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
    return brands.map((brand) => this.toDto(brand));
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
    await this.prisma.brand.delete({ where: { id } });
    await this.prisma.auditLog.create({ data: { adminId, action: 'BRAND_DELETE', targetId: id, metadata: { name: brand.name } } });
    return { success: true };
  }
}
