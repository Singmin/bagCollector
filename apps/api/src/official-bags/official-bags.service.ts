import { HttpStatus, Injectable } from '@nestjs/common';
import { OfficialBagStatus, OfficialProcessStatus, Prisma, ProcessingStatus, ShelfTheme } from '@prisma/client';
import type { OfficialBagDto } from '@bagcollect/contracts';
import { ApiError } from '../common/api-error.js';
import { QueueService } from '../common/queue.service.js';
import { PrismaService } from '../database/prisma.service.js';
import { CosService } from '../assets/cos.service.js';

const DEFAULT_SHELF_NAME = '未分类';
const DEFAULT_SHELF_THEME: ShelfTheme = 'SAGE';

/** 袋子查询统一带出品牌名。 */
type BagWithBrand = Prisma.OfficialBagGetPayload<{ include: { brand: true } }>;

@Injectable()
export class OfficialBagsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly cos: CosService,
    private readonly queues: QueueService
  ) {}

  private async thumbnailUrl(officialBagId: string): Promise<string | undefined> {
    const thumbnail = await this.prisma.officialBagImage.findFirst({
      where: { officialBagId, kind: 'THUMBNAIL', status: 'AVAILABLE' },
      orderBy: { version: 'desc' }
    });
    return thumbnail ? this.cos.signedUrl(thumbnail.objectKey) : undefined;
  }

  private async displayUrl(officialBagId: string): Promise<string | undefined> {
    const display = await this.prisma.officialBagImage.findFirst({
      where: { officialBagId, kind: 'DISPLAY', status: 'AVAILABLE' },
      orderBy: { version: 'desc' }
    });
    return display ? this.cos.signedUrl(display.objectKey) : undefined;
  }

  private async toDto(bag: BagWithBrand, claimed?: boolean): Promise<OfficialBagDto> {
    const [thumbnailUrl, displayUrl] = await Promise.all([
      this.thumbnailUrl(bag.id),
      this.displayUrl(bag.id)
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
      ...(thumbnailUrl ? { thumbnailUrl } : {}),
      ...(displayUrl ? { displayImageUrl: displayUrl } : {}),
      ...(claimed !== undefined ? { claimed } : {}),
      createdAt: bag.createdAt.toISOString(),
      updatedAt: bag.updatedAt.toISOString()
    };
  }

  /** 发现页列表：只返回已发布且图片处理完成的袋子，支持按品牌筛选。 */
  async list(
    userId: string,
    query: { search?: string; brandId?: string; cursor?: string; limit?: number }
  ) {
    const limit = Math.min(Math.max(query.limit ?? 30, 1), 100);
    const search = query.search?.trim();
    const brandId = query.brandId?.trim();
    const where = {
      status: OfficialBagStatus.PUBLISHED,
      processStatus: OfficialProcessStatus.READY,
      ...(brandId ? { brandId } : {}),
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
        orderBy: [{ sortOrder: 'desc' }, { publishedAt: 'desc' }, { id: 'desc' }],
        take: limit + 1,
        include: { brand: true }
      }),
      this.prisma.officialBag.count({ where })
    ]);
    const hasMore = items.length > limit;
    const page = hasMore ? items.slice(0, limit) : items;
    const claims = await this.prisma.officialClaim.findMany({
      where: { userId, officialBagId: { in: page.map((bag) => bag.id) } },
      select: { officialBagId: true }
    });
    const claimedIds = new Set(claims.map((claim) => claim.officialBagId));
    return {
      items: await Promise.all(page.map((bag) => this.toDto(bag, claimedIds.has(bag.id)))),
      nextCursor: hasMore ? page.at(-1)?.id ?? null : null,
      totalCount
    };
  }

  async detail(userId: string, id: string) {
    const bag = await this.prisma.officialBag.findFirst({
      where: { id, status: OfficialBagStatus.PUBLISHED, processStatus: OfficialProcessStatus.READY },
      include: { brand: true }
    });
    if (!bag) throw new ApiError('NOT_FOUND', '袋子不存在或暂不可见', HttpStatus.NOT_FOUND);
    const claim = await this.prisma.officialClaim.findUnique({
      where: { userId_officialBagId: { userId, officialBagId: id } },
      select: { id: true }
    });
    return this.toDto(bag, Boolean(claim));
  }

  /** 用户指定的「品牌 / 店铺」必须是自己名下的展架。 */
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

  private async resolveDefaultShelf(userId: string) {
    const existing = await this.prisma.shelf.findFirst({
      where: { userId, name: DEFAULT_SHELF_NAME },
      orderBy: { createdAt: 'asc' }
    });
    if (existing) return existing;
    const count = await this.prisma.shelf.count({ where: { userId } });
    return this.prisma.shelf.create({
      data: { userId, name: DEFAULT_SHELF_NAME, theme: DEFAULT_SHELF_THEME, sortOrder: count }
    });
  }

  /**
   * 「拥有」官方袋子：创建一条归属当前用户的 Collectible（名称/备注/标签带过去，
   * 默认进「未分类」展示架，由用户自己归类），并排队把官方图片复制到用户名下。
   * 同一用户对同一袋子只能拥有一次（唯一约束兜底并发）。
   *
   * overrides：标记半窗里用户改过的名称 / 品牌展架 / 标签 / 备注；不传就用官方袋子自带内容。
   * 注意 processingStatus 起步是 NORMALIZING（图片还在后台复制），
   * 收藏列表只返回 READY —— 复制完成后才会出现在收藏架里。
   */
  async claim(
    userId: string,
    id: string,
    overrides: { name?: string; shelfId?: string; notes?: string; tags?: string[] } = {}
  ) {
    const bag = await this.prisma.officialBag.findFirst({
      where: { id, status: OfficialBagStatus.PUBLISHED, processStatus: OfficialProcessStatus.READY }
    });
    if (!bag) throw new ApiError('NOT_FOUND', '袋子不存在或暂不可见', HttpStatus.NOT_FOUND);

    const existing = await this.prisma.officialClaim.findUnique({
      where: { userId_officialBagId: { userId, officialBagId: id } },
      include: { officialBag: { select: { name: true } } }
    });
    if (existing) {
      throw new ApiError('CONFLICT', '你已经拥有过这个袋子', HttpStatus.CONFLICT);
    }

    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      include: { _count: { select: { collectibles: true } } }
    });
    if (!user) throw new ApiError('UNAUTHORIZED', '用户不存在', HttpStatus.UNAUTHORIZED);
    if (user._count.collectibles >= user.collectibleQuota) {
      throw new ApiError('QUOTA_EXCEEDED', '收藏数量已达到上限', HttpStatus.PAYLOAD_TOO_LARGE);
    }

    const shelf = overrides.shelfId
      ? await this.assertShelf(userId, overrides.shelfId)
      : await this.resolveDefaultShelf(userId);
    const name = overrides.name?.trim() || bag.name;
    const notes = overrides.notes ?? bag.notes;
    const tags = overrides.tags ? this.normalizeTags(overrides.tags) : bag.tags;
    const last = await this.prisma.collectible.aggregate({
      where: { userId, shelfId: shelf.id },
      _max: { shelfOrder: true }
    });

    let collectibleId: string;
    try {
      const collectible = await this.prisma.$transaction(async (transaction) => {
        const created = await transaction.collectible.create({
          data: {
            userId,
            shelfId: shelf.id,
            name,
            notes,
            // 图片仍在后台复制，先置 NORMALIZING，完成后由 worker 置 READY。
            processingStatus: ProcessingStatus.NORMALIZING,
            shelfOrder: (last._max.shelfOrder ?? -1) + 1
          }
        });
        for (const displayName of tags) {
          const normalized = displayName.toLocaleLowerCase();
          const tag = await transaction.tag.upsert({
            where: { userId_normalized: { userId, normalized } },
            create: { userId, normalized, displayName },
            update: { displayName }
          });
          await transaction.collectibleTag.create({ data: { collectibleId: created.id, tagId: tag.id } });
        }
        await transaction.officialClaim.create({
          data: { userId, officialBagId: bag.id, collectibleId: created.id }
        });
        await transaction.officialBag.update({
          where: { id: bag.id },
          data: { claimedCount: { increment: 1 } }
        });
        return created;
      });
      collectibleId = collectible.id;
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
        throw new ApiError('CONFLICT', '你已经拥有过这个袋子', HttpStatus.CONFLICT);
      }
      throw error;
    }

    await this.queues.add(
      'official-claim',
      { officialBagId: bag.id, userId, collectibleId },
      `official-claim:${userId}:${bag.id}`
    );
    return { collectibleId, processingStatus: ProcessingStatus.NORMALIZING as ProcessingStatus };
  }
}
