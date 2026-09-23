import { HttpStatus, Injectable } from '@nestjs/common';
import type { ShelfTheme } from '@prisma/client';
import { ApiError } from '../common/api-error.js';
import { PrismaService } from '../database/prisma.service.js';

@Injectable()
export class ShelvesService {
  constructor(private readonly prisma: PrismaService) {}

  async list(userId: string) {
    const shelves = await this.prisma.shelf.findMany({
      where: { userId },
      include: { _count: { select: { collectibles: true } } },
      orderBy: [{ sortOrder: 'asc' }, { createdAt: 'asc' }]
    });
    return shelves.map((shelf) => ({
      id: shelf.id,
      name: shelf.name,
      theme: shelf.theme,
      sortOrder: shelf.sortOrder,
      itemCount: shelf._count.collectibles
    }));
  }

  async create(userId: string, input: { name: string; theme: ShelfTheme }) {
    const count = await this.prisma.shelf.count({ where: { userId } });
    return this.prisma.shelf.create({
      data: { userId, name: input.name, theme: input.theme, sortOrder: count }
    });
  }

  async update(userId: string, id: string, input: { name?: string; theme?: ShelfTheme }) {
    const shelf = await this.prisma.shelf.findFirst({ where: { id, userId } });
    if (!shelf) throw new ApiError('NOT_FOUND', '展示架不存在', HttpStatus.NOT_FOUND);
    return this.prisma.shelf.update({ where: { id }, data: input });
  }

  async reorder(userId: string, ids: string[]) {
    const shelves = await this.prisma.shelf.findMany({ where: { userId }, select: { id: true } });
    const actual = new Set(shelves.map((shelf) => shelf.id));
    if (ids.length !== actual.size || ids.some((id) => !actual.has(id))) {
      throw new ApiError('VALIDATION_FAILED', '排序列表必须包含全部展示架', HttpStatus.BAD_REQUEST);
    }
    await this.prisma.$transaction(
      ids.map((id, index) => this.prisma.shelf.update({ where: { id }, data: { sortOrder: index } }))
    );
    return this.list(userId);
  }

  async remove(userId: string, id: string) {
    const shelf = await this.prisma.shelf.findFirst({ where: { id, userId } });
    if (!shelf) throw new ApiError('NOT_FOUND', '展示架不存在', HttpStatus.NOT_FOUND);
    const itemCount = await this.prisma.collectible.count({ where: { userId, shelfId: id } });
    if (itemCount > 0) throw new ApiError('CONFLICT', '展示架中仍有收藏，无法删除', HttpStatus.CONFLICT);
    await this.prisma.shelf.delete({ where: { id } });
    return { success: true };
  }
}
