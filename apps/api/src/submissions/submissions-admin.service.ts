import { HttpStatus, Injectable } from '@nestjs/common';
import {
  AssetKind,
  AssetStatus,
  OfficialBagStatus,
  OfficialProcessStatus,
  Prisma,
  ProcessingStatus,
  SubmissionStatus
} from '@prisma/client';
import type {
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
    const latest = new Map<string, Map<AssetKind, (typeof assets)[number]>>();
    for (const asset of assets) {
      const resolved = result.get(asset.collectibleId)!;
      resolved.byteSize += Number(asset.byteSize);
      const byKind = latest.get(asset.collectibleId) ?? new Map<AssetKind, (typeof assets)[number]>();
      if (!byKind.has(asset.kind)) byKind.set(asset.kind, asset);
      latest.set(asset.collectibleId, byKind);
    }

    const signTargets: { collectibleId: string; kind: AssetKind; objectKey: string }[] = [];
    for (const [collectibleId, byKind] of latest) {
      const resolved = result.get(collectibleId)!;
      if (byKind.has(AssetKind.CUTOUT)) resolved.hasCutout = true;
      const thumbnail = byKind.get(AssetKind.THUMBNAIL);
      const display = byKind.get(AssetKind.DISPLAY);
      if (thumbnail) signTargets.push({ collectibleId, kind: AssetKind.THUMBNAIL, objectKey: thumbnail.objectKey });
      if (display) signTargets.push({ collectibleId, kind: AssetKind.DISPLAY, objectKey: display.objectKey });
    }
    await Promise.all(
      signTargets.map(async ({ collectibleId, kind, objectKey }) => {
        const resolved = result.get(collectibleId)!;
        const url = await this.cos.signedUrl(objectKey);
        if (kind === AssetKind.THUMBNAIL) resolved.thumbnailUrl = url;
        else resolved.displayImageUrl = url;
      })
    );
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
      hasCutout: images.hasCutout,
      byteSize: images.byteSize,
      addedAt: collectible.addedAt.toISOString(),
      ...(collectible.reviewedAt ? { reviewedAt: collectible.reviewedAt.toISOString() } : {})
    };
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
    const [items, totalCount] = await Promise.all([
      this.prisma.collectible.findMany({
        where,
        orderBy: [{ addedAt: 'desc' }, { id: 'desc' }],
        skip: (currentPage - 1) * pageSize,
        take: pageSize,
        include: { shelf: { select: { name: true } }, tags: { include: { tag: true } } }
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
        imageAssets: { where: { status: AssetStatus.AVAILABLE }, orderBy: { version: 'desc' } }
      }
    });
    if (!collectible) throw new ApiError('NOT_FOUND', '用户袋子不存在', HttpStatus.NOT_FOUND);
    if (collectible.promotedBagId) {
      throw new ApiError('CONFLICT', '该袋子已纳入过官方库', HttpStatus.CONFLICT);
    }

    const latest = new Map<AssetKind, (typeof collectible.imageAssets)[number]>();
    for (const asset of collectible.imageAssets) {
      if (!latest.has(asset.kind)) latest.set(asset.kind, asset);
    }
    const standard = latest.get(AssetKind.STANDARD);
    const display = latest.get(AssetKind.DISPLAY);
    const thumbnail = latest.get(AssetKind.THUMBNAIL);
    if (!standard || !display || !thumbnail) {
      throw new ApiError('CONFLICT', '该袋子图片尚未处理完成，无法纳入官方库', HttpStatus.CONFLICT);
    }

    const name = input.name?.trim() || collectible.name;
    const brandId = input.brandId !== undefined ? await this.resolveBrandId(input.brandId) : null;
    const notes = input.notes ?? collectible.notes;
    const tags = input.tags ? this.normalizeTags(input.tags) : collectible.tags.map((entry) => entry.tag.displayName);
    const matting = latest.has(AssetKind.CUTOUT);

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
      const kinds: AssetKind[] = [AssetKind.STANDARD, AssetKind.DISPLAY, AssetKind.THUMBNAIL];
      if (latest.has(AssetKind.CUTOUT)) kinds.push(AssetKind.CUTOUT);
      for (const kind of kinds) {
        const asset = latest.get(kind)!;
        const body = await this.cos.getObject(asset.objectKey);
        const extension = EXTENSION[asset.contentType] ?? 'bin';
        const key = `official/${bag.id}/${kind.toLowerCase()}/v1.${extension}`;
        await this.cos.putObject(key, body, asset.contentType);
        copiedKeys.push(key);
        await this.prisma.officialBagImage.create({
          data: {
            officialBagId: bag.id,
            kind,
            status: AssetStatus.AVAILABLE,
            objectKey: key,
            contentType: asset.contentType,
            declaredByteSize: asset.byteSize,
            byteSize: asset.byteSize,
            width: asset.width,
            height: asset.height,
            version: 1
          }
        });
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
}
