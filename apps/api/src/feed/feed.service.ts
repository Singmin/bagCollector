import { HttpStatus, Injectable } from '@nestjs/common';
import { AssetKind, AssetStatus, OfficialBagStatus, OfficialProcessStatus, Prisma } from '@prisma/client';
import type { CollectibleDto, CollectiblePageDto } from '@bagcollect/contracts';
import { imageData } from '../common/image-sides.js';
import { ApiError } from '../common/api-error.js';
import { PrismaService } from '../database/prisma.service.js';
import { CosService } from '../assets/cos.service.js';

/** 发现页 / 心愿袋可见的官方袋子：已发布且图片处理完成（与官方袋子列表口径一致）。 */
const VISIBLE_BAG: Prisma.OfficialBagWhereInput = {
  status: OfficialBagStatus.PUBLISHED,
  processStatus: OfficialProcessStatus.READY
};

type BagWithBrand = Prisma.OfficialBagGetPayload<{ include: { brand: true } }>;

type ImageUrlResolver = (bagId: string, kind: AssetKind, side?: 'FRONT' | 'BACK') => string | undefined;

@Injectable()
export class FeedService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly cos: CosService
  ) {}

  /** 批量取袋子最新可用图片的签名 URL，避免逐袋子查图（N+1）。
   *  正反面都取：反面缩略图让小程序详情卡在打开瞬间就按 A/B 布局渲染。 */
  private async imageUrls(bagIds: string[]): Promise<ImageUrlResolver> {
    if (!bagIds.length) return () => undefined;
    const images = await this.prisma.officialBagImage.findMany({
      where: {
        officialBagId: { in: bagIds },
        kind: { in: [AssetKind.THUMBNAIL, AssetKind.DISPLAY] },
        side: { in: ['FRONT', 'BACK'] as const }, status: AssetStatus.AVAILABLE
      },
      orderBy: { version: 'desc' }
    });
    const states = await this.prisma.officialBagImageSide.findMany({ where: { officialBagId: { in: bagIds } } });
    const published = new Map(
      states.filter(state => state.publishedVersion !== null)
        .map(state => [`${state.officialBagId}:${state.side}` as const, state.publishedVersion])
    );
    const latest = new Map<string, string>();
    for (const image of images) {
      if (image.version !== published.get(`${image.officialBagId}:${image.side}`)) continue;
      const key = `${image.officialBagId}:${image.side}:${image.kind}`;
      if (!latest.has(key)) latest.set(key, image.objectKey);
    }
    const urls = new Map<string, string>();
    await Promise.all(
      [...latest.entries()].map(async ([key, objectKey]) => {
        urls.set(key, await this.cos.signedUrl(objectKey));
      })
    );
    return (bagId, kind, side = 'FRONT') => urls.get(`${bagId}:${side}:${kind}`);
  }

  /**
   * 官方袋子 → 发现页条目。前端 feed / 心愿袋统一按 Collectible 结构消费
   * （卡背面要展示标签与备注），shelf 字段留空、ownerName = 品牌名。
   * 心愿条目与 feed 同 id（都是袋子 id），详情卡靠 GET /collectibles/:id 兜底打开。
   */
  private toFeedItem(bag: BagWithBrand, urlFor: ImageUrlResolver, myCollectibleId?: string): CollectibleDto {
    const thumbnail = urlFor(bag.id, AssetKind.THUMBNAIL);
    const display = urlFor(bag.id, AssetKind.DISPLAY);
    const backThumbnail = urlFor(bag.id, AssetKind.THUMBNAIL, 'BACK');
    return {
      id: bag.id, imageEditable: false, sourceOfficialBagId: bag.id, imageRevision: bag.updatedAt.toISOString(),
      name: bag.name,
      shelfId: '',
      shelfName: '',
      processingStatus: 'READY',
      notes: bag.notes,
      tags: bag.tags,
      ownerName: bag.brand?.name ?? '官方精选',
      ...(thumbnail ? { thumbnailUrl: thumbnail } : {}),
      ...(display ? { displayImageUrl: display } : {}),
      ...(backThumbnail ? { backThumbnailUrl: backThumbnail } : {}),
      /* 当前用户已认领该袋子 → 带回认领生成的收藏 id：
         小程序据此恢复「标记已有」已标记态（撤回标记时按这个 id 删除收藏） */
      ...(myCollectibleId ? { myCollectibleId } : {}),
      addedAt: (bag.publishedAt ?? bag.createdAt).toISOString(),
      updatedAt: bag.updatedAt.toISOString()
    };
  }

  /** 批量查当前用户的认领记录（袋子 id → 认领生成的收藏 id），避免逐袋子查询（N+1）。 */
  private async myClaims(userId: string, bagIds: string[]): Promise<Map<string, string>> {
    if (!bagIds.length) return new Map();
    const claims = await this.prisma.officialClaim.findMany({
      where: { userId, officialBagId: { in: bagIds } },
      select: { officialBagId: true, collectibleId: true }
    });
    return new Map(claims.map((claim) => [claim.officialBagId, claim.collectibleId]));
  }

  /** 发现页「纸袋上新」：官方精选 feed，排序与官方袋子列表一致（sortOrder 大者靠前）。 */
  async feed(userId: string, query: { search?: string; cursor?: string; limit?: number }): Promise<CollectiblePageDto> {
    /* 上限 1000：官方袋子是后台人工录入的精选内容，量级天然有限；
       小程序侧要求展示数量不受限制（虚拟列表渲染，一次取全不翻页）。
       仍保留上限而非完全放开，防止异常调用拖垮 findMany。 */
    const limit = Math.min(Math.max(query.limit ?? 30, 1), 1000);
    const search = query.search?.trim();
    const where = {
      ...VISIBLE_BAG,
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
    const urlFor = await this.imageUrls(page.map((bag) => bag.id));
    const claims = await this.myClaims(userId, page.map((bag) => bag.id));
    return {
      items: page.map((bag) => this.toFeedItem(bag, urlFor, claims.get(bag.id))),
      nextCursor: hasMore ? page.at(-1)?.id ?? null : null,
      totalCount
    };
  }

  /** 心愿袋列表：只带出仍可见的袋子（下架/删除的自动隐藏），按加入时间倒序。 */
  async wishlist(userId: string): Promise<CollectibleDto[]> {
    const entries = await this.prisma.wishlistItem.findMany({
      where: { userId, officialBag: VISIBLE_BAG },
      orderBy: { createdAt: 'desc' },
      include: { officialBag: { include: { brand: true } } }
    });
    const urlFor = await this.imageUrls(entries.map((entry) => entry.officialBagId));
    const claims = await this.myClaims(userId, entries.map((entry) => entry.officialBagId));
    return entries.map((entry) => this.toFeedItem(entry.officialBag, urlFor, claims.get(entry.officialBagId)));
  }

  async addWishlist(userId: string, bagId: string) {
    const bag = await this.prisma.officialBag.findFirst({ where: { id: bagId, ...VISIBLE_BAG } });
    if (!bag) throw new ApiError('NOT_FOUND', '纸袋不存在或已下架', HttpStatus.NOT_FOUND);
    /* 已经拥有的袋子不能再进心愿袋（心愿 = 想要但还没有）。前端按钮会置灰，
       这里再兜一层：多端操作或旧客户端绕过 UI 时也不会写出矛盾数据。 */
    const claimed = await this.prisma.officialClaim.findUnique({
      where: { userId_officialBagId: { userId, officialBagId: bagId } },
      select: { id: true }
    });
    if (claimed) throw new ApiError('CONFLICT', '这只袋子已在收藏架', HttpStatus.CONFLICT);
    await this.prisma.wishlistItem.upsert({
      where: { userId_officialBagId: { userId, officialBagId: bagId } },
      create: { userId, officialBagId: bagId },
      update: {}
    });
    return { success: true };
  }

  async removeWishlist(userId: string, bagId: string) {
    await this.prisma.wishlistItem.deleteMany({ where: { userId, officialBagId: bagId } });
    return { success: true };
  }

  /** 收藏详情兜底：心愿袋条目的 id 是官方袋子 id，详情卡要点开看（只读）。 */
  async bagAsCollectible(bagId: string): Promise<CollectibleDto | null> {
    const bag = await this.prisma.officialBag.findFirst({
      where: { id: bagId, ...VISIBLE_BAG },
      include: { brand: true }
    });
    if (!bag) return null;
    const urlFor = await this.imageUrls([bag.id]);
    const resolved = await imageData(this.prisma, this.cos, bag.id, true);
    return { ...this.toFeedItem(bag, urlFor), ...resolved };
  }
}
