import { selectSideAssets, type ImageSideDto } from '@bagcollect/contracts';
import { HttpStatus, Injectable } from '@nestjs/common';
import {
  AssetKind, ImageSide,
  AssetStatus,
  OfficialBagStatus,
  OfficialProcessStatus,
  Prisma,
  ProcessingStatus,
  SubmissionStatus
} from '@prisma/client';
import type {
  ClaimPageDto,
  ClaimedBagRankDto,
  PromoteSubmissionInput,
  RejectSubmissionInput,
  SubmissionDto,
  SubmissionPageDto,
  SubmissionStatus as SubmissionStatusContract
} from '@bagcollect/contracts';
import { ApiError } from '../common/api-error.js';
import { QueueService } from '../common/queue.service.js';
import { PrismaService } from '../database/prisma.service.js';
import { CosService } from '../assets/cos.service.js';

const EXTENSION: Record<string, string> = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
  'image/heic': 'heic',
  'image/heif': 'heif'
};

/** 把「YYYY-MM-DD」按服务器本地时区解析成当天起止时刻；非法输入返回 undefined。 */
function parseDayBoundary(raw: string | undefined, endOfDay: boolean): Date | undefined {
  if (!raw) return undefined;
  const date = new Date(`${raw}T${endOfDay ? '23:59:59.999' : '00:00:00'}`);
  return Number.isNaN(date.getTime()) ? undefined : date;
}

type CollectibleRow = Prisma.CollectibleGetPayload<{
  include: { shelf: { select: { name: true } }; tags: { include: { tag: true } } };
}>;

interface ResolvedImages {
  sides?: Partial<Record<ImageSide, ImageSideDto>>;
  thumbnailUrl?: string;
  displayImageUrl?: string;
  hasCutout: boolean;
  /** 该收藏全部可用图片资产的字节数之和，供管理端展示/排序「图片大小」。 */
  byteSize: number;
}

@Injectable()
export class SubmissionsAdminService {
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

  /** 批量取用户袋子的缩略图/展示图与是否抠图，避免逐条查询（N+1）。 */
  private async resolveImages(collectibleIds: string[]): Promise<Map<string, ResolvedImages>> {
    const result = new Map<string, ResolvedImages>();
    for (const id of collectibleIds) result.set(id, { hasCutout: false, byteSize: 0 });
    if (!collectibleIds.length) return result;

    const assets = await this.prisma.imageAsset.findMany({
      where: { collectibleId: { in: collectibleIds }, status: AssetStatus.AVAILABLE },
      orderBy: { version: 'desc' }
    });
    const states = await this.prisma.collectibleImageSide.findMany({ where: { collectibleId: { in: collectibleIds } } });
    for (const asset of assets) result.get(asset.collectibleId)!.byteSize += Number(asset.byteSize);
    await Promise.all(states.map(async state => {
      const selected = selectSideAssets(assets.filter(asset => asset.collectibleId === state.collectibleId), state);
      const dto: ImageSideDto = { side: state.side, sourceVersion: state.sourceVersion, processingVersion: state.processingVersion,
        publishedVersion: state.publishedVersion, processingStatus: state.processingStatus,
        ...(state.processingError ? { processingError: state.processingError } : {}), matted: state.mattedSourceVersion === state.sourceVersion };
      await Promise.all(Object.entries({ thumbnailUrl: 'THUMBNAIL', displayImageUrl: 'DISPLAY', cutoutImageUrl: 'CUTOUT' }).map(async ([key, kind]) => {
        const asset = selected[kind]; if (asset) Object.assign(dto, { [key]: await this.cos.signedUrl(asset.objectKey) });
      }));
      const entry = result.get(state.collectibleId)!;
      entry.sides ??= {}; entry.sides[state.side] = dto;
      if (state.side === ImageSide.FRONT) { entry.thumbnailUrl = dto.thumbnailUrl; entry.displayImageUrl = dto.displayImageUrl; entry.hasCutout = !!dto.cutoutImageUrl; }
    }));
    return result;
  }

  private toDto(collectible: CollectibleRow, images: ResolvedImages): SubmissionDto {
    return {
      id: collectible.id,
      name: collectible.name,
      notes: collectible.notes,
      tags: collectible.tags.map((entry) => entry.tag.displayName),
      userId: collectible.userId,
      shelfName: collectible.shelf.name,
      processingStatus: collectible.processingStatus,
      submissionStatus: collectible.submissionStatus,
      ...(collectible.reviewNote ? { reviewNote: collectible.reviewNote } : {}),
      ...(collectible.promotedBagId ? { promotedBagId: collectible.promotedBagId } : {}),
      ...(images.thumbnailUrl ? { thumbnailUrl: images.thumbnailUrl } : {}),
      ...(images.displayImageUrl ? { displayImageUrl: images.displayImageUrl } : {}),
      sides: images.sides, hasCutout: images.hasCutout,
      byteSize: images.byteSize,
      addedAt: collectible.addedAt.toISOString(),
      ...(collectible.reviewedAt ? { reviewedAt: collectible.reviewedAt.toISOString() } : {})
    };
  }

  /** openid 脱敏：保留首 4 尾 4，中间打码；过短则收窄到首 2 尾 2（与用户管理页同一口径）。 */
  private maskOpenid(openid: string) {
    const head = openid.length <= 8 ? 2 : 4;
    const tail = openid.length <= 8 ? 2 : 4;
    return `${openid.slice(0, head)}***${openid.slice(-tail)}`;
  }

  private async audit(adminId: string, action: string, targetId: string, metadata?: Prisma.InputJsonValue) {
    await this.prisma.auditLog.create({
      data: { adminId, action, targetId, ...(metadata !== undefined ? { metadata } : {}) }
    });
  }

  async list(query: {
    status?: SubmissionStatusContract;
    /* 图片处理进度分组：PROCESSING 是「还没出图」的几个中间状态的并集 */
    process?: 'READY' | 'PROCESSING' | 'FAILED';
    search?: string;
    from?: string;
    to?: string;
    page?: number;
    pageSize?: number;
    /* 服务端排序：name / addedAt 是主表列，直接数据库排序；
       byteSize 是图片资产字节数的聚合值（不在主表上），走聚合查询排序。 */
    sort?: 'name' | 'addedAt' | 'byteSize';
    order?: 'asc' | 'desc';
  }): Promise<SubmissionPageDto> {
    /* 上限 200：这个列表每行都要签一次图片 URL，一次拉太多会把响应体与签名开销
       一起顶上去 —— 分页的目的本来就是「每次只取一屏」。 */
    const pageSize = Math.min(Math.max(query.pageSize ?? 30, 1), 200);
    const currentPage = Math.max(query.page ?? 1, 1);
    const search = query.search?.trim();
    const fromDate = parseDayBoundary(query.from, false);
    const toDate = parseDayBoundary(query.to, true);
    /* 库里处理进度是细分的六个状态，而列表上只分「已就绪 / 处理中 / 失败」三档，
       这里把三档展开成 in 查询。必须放在服务端做 —— 客户端过滤只能过滤当前页，
       分页之后「只看失败」会变成「只看当前页里失败的」，口径是错的。 */
    const processStatuses =
      query.process === 'READY'
        ? [ProcessingStatus.READY]
        : query.process === 'FAILED'
          ? [ProcessingStatus.FAILED]
          : query.process === 'PROCESSING'
            ? [
                ProcessingStatus.UPLOADING,
                ProcessingStatus.NORMALIZING,
                ProcessingStatus.AWAITING_CROP,
                ProcessingStatus.CROPPING,
                ProcessingStatus.MATTING
              ]
            : null;
    const where = {
      /* 认领官方袋子生成的收藏（sourceOfficialBagId 非空）不是用户上传，
         不参与审核 —— 它们展示在「认领收藏」页签。 */
      sourceOfficialBagId: null,
      ...(query.status ? { submissionStatus: query.status } : {}),
      ...(processStatuses ? { processingStatus: { in: processStatuses } } : {}),
      ...(fromDate || toDate
        ? {
            addedAt: {
              ...(fromDate ? { gte: fromDate } : {}),
              ...(toDate ? { lte: toDate } : {})
            }
          }
        : {}),
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
    const include = { shelf: { select: { name: true } }, tags: { include: { tag: true } } } satisfies Prisma.CollectibleInclude;
    const order = query.order === 'asc' ? 'asc' : 'desc';
    /* 主表列排序：数据库 orderBy（id 作稳定 tiebreaker），保持 skip/take 快路径 */
    if (query.sort === 'name' || query.sort === 'addedAt') {
      const key = query.sort;
      const [items, totalCount] = await Promise.all([
        this.prisma.collectible.findMany({
          where,
          orderBy: [{ [key]: order }, { id: order }] as Prisma.CollectibleOrderByWithRelationInput[],
          skip: (currentPage - 1) * pageSize,
          take: pageSize,
          include
        }),
        this.prisma.collectible.count({ where })
      ]);
      const images = await this.resolveImages(items.map((collectible) => collectible.id));
      return { items: items.map((collectible) => this.toDto(collectible, images.get(collectible.id)!)), totalCount };
    }
    /* 图片大小排序：byteSize = 该收藏全部可用图片资产字节之和，Prisma 不支持按
       关系聚合值 orderBy —— 先取全部命中 id，聚合各收藏字节和后在内存里排序分页，
       再只为当前页那一屏取完整行与签名 URL（和筛选项一样，排序必须全量口径）。 */
    if (query.sort === 'byteSize') {
      const rows = await this.prisma.collectible.findMany({ where, select: { id: true } });
      const sums = await this.prisma.imageAsset.groupBy({
        by: ['collectibleId'],
        where: { collectibleId: { in: rows.map((row) => row.id) }, status: AssetStatus.AVAILABLE },
        _sum: { byteSize: true }
      });
      const sizeById = new Map(sums.map((sum) => [sum.collectibleId, Number(sum._sum.byteSize ?? 0)]));
      const sortedIds = rows
        .map((row) => row.id)
        .sort((a, b) => {
          const delta = (sizeById.get(a) ?? 0) - (sizeById.get(b) ?? 0);
          return order === 'asc' ? delta : -delta;
        });
      const pageIds = sortedIds.slice((currentPage - 1) * pageSize, currentPage * pageSize);
      const [pageRows, totalCount] = await Promise.all([
        this.prisma.collectible.findMany({ where: { id: { in: pageIds } }, include }),
        rows.length
      ]);
      const rowById = new Map(pageRows.map((row) => [row.id, row]));
      const items = pageIds.flatMap((id) => {
        const row = rowById.get(id);
        return row ? [row] : [];
      });
      const images = await this.resolveImages(pageIds);
      return { items: items.map((collectible) => this.toDto(collectible, images.get(collectible.id)!)), totalCount };
    }
    const [items, totalCount] = await Promise.all([
      this.prisma.collectible.findMany({
        where,
        orderBy: [{ addedAt: 'desc' }, { id: 'desc' }],
        skip: (currentPage - 1) * pageSize,
        take: pageSize,
        include
      }),
      this.prisma.collectible.count({ where })
    ]);
    const images = await this.resolveImages(items.map((collectible) => collectible.id));
    return {
      items: items.map((collectible) => this.toDto(collectible, images.get(collectible.id)!)),
      totalCount
    };
  }

  /**
   * 把用户上传的袋子纳入官方库：创建一条官方袋子（名称/备注/标签沿用用户填写内容），
   * 把用户已处理好的 STANDARD / DISPLAY / THUMBNAIL（有抠图则带上 CUTOUT）复制到官方路径，
   * 图片直接就绪（READY），管理员可在官方袋子库直接发布，无需再跑处理任务。
   */
  async promote(adminId: string, id: string, input: PromoteSubmissionInput) {
    const collectible = await this.prisma.collectible.findUnique({
      where: { id },
      include: {
        shelf: { select: { name: true } },
        tags: { include: { tag: true } },
        imageSides: true, imageAssets: { where: { status: AssetStatus.AVAILABLE }, orderBy: { version: 'desc' } }
      }
    });
    if (!collectible) throw new ApiError('NOT_FOUND', '用户袋子不存在', HttpStatus.NOT_FOUND);
    if (collectible.promotedBagId) {
      throw new ApiError('CONFLICT', '该袋子已纳入过官方库', HttpStatus.CONFLICT);
    }

    const frontState = collectible.imageSides.find(state => state.side === ImageSide.FRONT);
    if (!frontState?.publishedVersion) throw new ApiError('CONFLICT', '正面尚未处理完成', HttpStatus.CONFLICT);
    const committedSides = collectible.imageSides.filter(state => state.publishedVersion !== null);
    const selections = committedSides.map(state => ({ state, assets: selectSideAssets(collectible.imageAssets, { ...state, sourceVersion: state.publishedSourceVersion ?? state.sourceVersion }) }));
    const latest = selections.find(selection => selection.state.side === ImageSide.FRONT)!.assets;
    if (!latest.STANDARD || !latest.DISPLAY || !latest.THUMBNAIL) throw new ApiError('CONFLICT', '缺少完整正面产物，无法纳入官方库', HttpStatus.CONFLICT);
    const name = input.name?.trim() || collectible.name;
    const brandId = input.brandId !== undefined ? await this.resolveBrandId(input.brandId) : null;
    const notes = input.notes ?? collectible.notes;
    const tags = input.tags ? this.normalizeTags(input.tags) : collectible.tags.map((entry) => entry.tag.displayName);
    const matting = !!latest.CUTOUT;

    const max = await this.prisma.officialBag.aggregate({ _max: { sortOrder: true } });
    const bag = await this.prisma.officialBag.create({
      data: {
        name,
        brandId,
        notes,
        tags,
        matting,
        sortOrder: (max._max.sortOrder ?? -1) + 1,
        status: OfficialBagStatus.DRAFT,
        processStatus: OfficialProcessStatus.READY,
        version: 1,
        createdById: adminId
      }
    });

    const copiedKeys: string[] = [];
    try {
      for (const { state, assets } of selections) {
        const kinds: AssetKind[] = [AssetKind.STANDARD, AssetKind.DISPLAY, AssetKind.THUMBNAIL];
        if (assets.CUTOUT) kinds.push(AssetKind.CUTOUT);
        for (const kind of kinds) {
          const asset = assets[kind];
          if (!asset) throw new ApiError('CONFLICT', '这一面缺少完整图片产物', HttpStatus.CONFLICT);
          const body = await this.cos.getObject(asset.objectKey);
          const extension = EXTENSION[asset.contentType] ?? 'bin';
          const key = `official/${bag.id}/${state.side.toLowerCase()}/${kind.toLowerCase()}/v1.${extension}`;
          await this.cos.putObject(key, body, asset.contentType); copiedKeys.push(key);
          await this.prisma.officialBagImage.create({ data: { officialBagId: bag.id, side: state.side, kind, status: AssetStatus.AVAILABLE,
            objectKey: key, contentType: asset.contentType, declaredByteSize: asset.byteSize, byteSize: asset.byteSize, width: asset.width, height: asset.height, version: 1 } });
        }
        await this.prisma.officialBagImageSide.create({ data: { officialBagId: bag.id, side: state.side, sourceVersion: 1, processingVersion: 1, publishedVersion: 1, publishedSourceVersion: 1, processingStatus: OfficialProcessStatus.READY, matting: !!assets.CUTOUT } });
      }
    } catch (error) {
      // 复制失败回滚：删掉刚建的官方袋子（级联清除图片记录），并把已写出的对象交给清理队列。
      await this.prisma.officialBag.delete({ where: { id: bag.id } }).catch(() => undefined);
      if (copiedKeys.length) await this.queues.add('cleanup', { keys: copiedKeys });
      throw error;
    }

    await this.prisma.collectible.update({
      where: { id },
      data: {
        submissionStatus: SubmissionStatus.APPROVED,
        promotedBagId: bag.id,
        reviewedById: adminId,
        reviewedAt: new Date(),
        reviewNote: null
      }
    });
    await this.audit(adminId, 'SUBMISSION_PROMOTE', id, {
      officialBagId: bag.id,
      name,
      brandId,
      objectCount: copiedKeys.length
    });
    return { officialBagId: bag.id, officialBagName: bag.name, submissionStatus: SubmissionStatus.APPROVED };
  }

  async reject(adminId: string, id: string, input: RejectSubmissionInput) {
    const collectible = await this.prisma.collectible.findUnique({
      where: { id },
      include: { shelf: { select: { name: true } }, tags: { include: { tag: true } } }
    });
    if (!collectible) throw new ApiError('NOT_FOUND', '用户袋子不存在', HttpStatus.NOT_FOUND);
    if (collectible.promotedBagId) {
      throw new ApiError('CONFLICT', '该袋子已纳入过官方库，不能驳回', HttpStatus.CONFLICT);
    }
    await this.prisma.collectible.update({
      where: { id },
      data: {
        submissionStatus: SubmissionStatus.REJECTED,
        reviewNote: input.note?.trim() || null,
        reviewedById: adminId,
        reviewedAt: new Date()
      }
    });
    await this.audit(adminId, 'SUBMISSION_REJECT', id, { note: input.note });
    const images = await this.resolveImages([id]);
    const row = await this.prisma.collectible.findUniqueOrThrow({
      where: { id },
      include: { shelf: { select: { name: true } }, tags: { include: { tag: true } } }
    });
    return this.toDto(row, images.get(id)!);
  }

  /** 重新打开：把驳回/已处理的袋子退回待审核，清除审核意见。 */
  async reopen(adminId: string, id: string) {
    const collectible = await this.prisma.collectible.findUnique({
      where: { id },
      include: { shelf: { select: { name: true } }, tags: { include: { tag: true } } }
    });
    if (!collectible) throw new ApiError('NOT_FOUND', '用户袋子不存在', HttpStatus.NOT_FOUND);
    await this.prisma.collectible.update({
      where: { id },
      data: {
        submissionStatus: SubmissionStatus.PENDING,
        reviewNote: null,
        reviewedById: adminId,
        reviewedAt: new Date()
      }
    });
    await this.audit(adminId, 'SUBMISSION_REOPEN', id);
    const images = await this.resolveImages([id]);
    const row = await this.prisma.collectible.findUniqueOrThrow({
      where: { id },
      include: { shelf: { select: { name: true } }, tags: { include: { tag: true } } }
    });
    return this.toDto(row, images.get(id)!);
  }

  /* ------------------------------ 认领收藏 ------------------------------ */

  /** 用户在发现页点「标记已有」生成的认领记录（ OfficialClaim），按认领时间倒序。 */
  async listClaims(query: { search?: string; page?: number; pageSize?: number }): Promise<ClaimPageDto> {
    const pageSize = Math.min(Math.max(query.pageSize ?? 30, 1), 200);
    const currentPage = Math.max(query.page ?? 1, 1);
    const search = query.search?.trim();
    const where = search
      ? {
          OR: [
            { officialBag: { name: { contains: search, mode: 'insensitive' as const } } },
            { officialBag: { brand: { name: { contains: search, mode: 'insensitive' as const } } } },
            { user: { openid: { contains: search, mode: 'insensitive' as const } } }
          ]
        }
      : undefined;
    const [items, totalCount] = await Promise.all([
      this.prisma.officialClaim.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip: (currentPage - 1) * pageSize,
        take: pageSize,
        include: {
          officialBag: { include: { brand: { select: { name: true } } } },
          user: { select: { openid: true } }
        }
      }),
      this.prisma.officialClaim.count({ where })
    ]);
    return {
      items: items.map((claim) => ({
        id: claim.id,
        userId: claim.userId,
        openidMasked: this.maskOpenid(claim.user.openid),
        bagId: claim.officialBagId,
        bagName: claim.officialBag.name,
        ...(claim.officialBag.brand ? { brandName: claim.officialBag.brand.name } : {}),
        collectibleId: claim.collectibleId,
        claimedAt: claim.createdAt.toISOString()
      })),
      totalCount
    };
  }

  /** 被认领最多的官方袋子排行：按 OfficialClaim 分组统计，认领次数降序。 */
  async topClaimedBags(limit = 50): Promise<ClaimedBagRankDto[]> {
    const groups = await this.prisma.officialClaim.groupBy({
      by: ['officialBagId'],
      _count: { officialBagId: true },
      _max: { createdAt: true },
      orderBy: { _count: { officialBagId: 'desc' } },
      take: Math.min(Math.max(limit, 1), 200)
    });
    if (!groups.length) return [];
    const bags = await this.prisma.officialBag.findMany({
      where: { id: { in: groups.map((group) => group.officialBagId) } },
      include: { brand: { select: { name: true } } }
    });
    const bagById = new Map(bags.map((bag) => [bag.id, bag]));
    return groups.flatMap((group) => {
      const bag = bagById.get(group.officialBagId);
      if (!bag) return [];
      return [
        {
          bagId: bag.id,
          bagName: bag.name,
          ...(bag.brand ? { brandName: bag.brand.name } : {}),
          claimCount: group._count.officialBagId,
          latestClaimedAt: (group._max.createdAt ?? bag.createdAt).toISOString()
        }
      ];
    });
  }
}
