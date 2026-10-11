import { randomUUID } from 'node:crypto';
import { COLOR_SCAN_MODEL, DINO_SCAN_MODEL, normalizeScanImage, scanCandidates, type ScanScore, type ScanSettings } from '@bagcollect/bag-vision';
import type { CreateMatchScanInput } from '@bagcollect/contracts';
import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { ApiError } from '../common/api-error.js';
import { QueueService } from '../common/queue.service.js';
import { PrismaService } from '../database/prisma.service.js';
import { CosService } from '../assets/cos.service.js';
import { SettingsService } from '../settings/settings.service.js';
import { OfficialBagsService } from './official-bags.service.js';

@Injectable()
export class MatchScansService {
  constructor(private readonly prisma: PrismaService, private readonly queues: QueueService,
    private readonly cos: CosService, private readonly settings: SettingsService, private readonly bags: OfficialBagsService) {}

  async create(userId: string, input: CreateMatchScanInput): Promise<{ scanId: string }> {
    const existing = await this.prisma.matchScan.findUnique({ where: { userId_requestId: { userId, requestId: input.requestId } } });
    if (existing) {
      const oldCrop = existing.crop as unknown as CreateMatchScanInput['crop'];
      const sameCrop = ['x', 'y', 'width', 'height', 'rotation'].every(key =>
        (oldCrop?.[key as keyof NonNullable<typeof oldCrop>] ?? (key === 'rotation' ? 0 : null)) ===
        (input.crop?.[key as keyof NonNullable<typeof oldCrop>] ?? (key === 'rotation' ? 0 : null)));
      if (existing.collectibleId !== input.collectibleId || existing.source !== input.source || !sameCrop) {
        throw new ApiError('CONFLICT', '请求标识已用于另一张图片或裁剪范围', 409);
      }
      return { scanId: existing.id };
    }
    const owned = await this.prisma.collectible.findFirst({ where: { id: input.collectibleId, userId } });
    if (!owned) throw new ApiError('NOT_FOUND', '收藏不存在', 404);
    if (await this.prisma.matchScan.count({ where: { userId, createdAt: { gte: new Date(Date.now() - 60_000) } } }) >= 10) {
      throw new ApiError('QUOTA_EXCEEDED', '扫描过于频繁，请稍后再试', 429);
    }
    // ORIGINAL preserves alpha and matches EXIF-oriented crop coordinates. STANDARD is only a fallback.
    const image = await this.prisma.imageAsset.findFirst({ where: { collectibleId: input.collectibleId, userId, kind: 'ORIGINAL', status: 'AVAILABLE' }, orderBy: { version: 'desc' } })
      ?? await this.prisma.imageAsset.findFirst({ where: { collectibleId: input.collectibleId, userId, kind: 'STANDARD', status: 'AVAILABLE' }, orderBy: { version: 'desc' } });
    if (!image) throw new ApiError('CONFLICT', '照片尚未准备好', 409);
    const settings = await this.settings.scanSettings();
    let scan;
    try {
      scan = await this.prisma.matchScan.create({ data: {
        userId, collectibleId: input.collectibleId, requestId: input.requestId, source: input.source,
        sourceKey: image.objectKey, sourceVersion: image.version, crop: input.crop ? { ...input.crop } : undefined,
        settings: { ...settings }, model: settings.engine === 'dino' ? DINO_SCAN_MODEL : COLOR_SCAN_MODEL
      } });
    } catch (error) {
      if (!(error instanceof Prisma.PrismaClientKnownRequestError) || error.code !== 'P2002') throw error;
      return this.create(userId, input);
    }
    let timer: NodeJS.Timeout | undefined;
    try {
      await Promise.race([
        this.queues.addScan(scan.id),
        new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('Queue timeout')), 5000); timer.unref(); })
      ]);
    } catch {
      // A late Redis write is harmless: the worker only claims QUEUED tasks.
      await this.prisma.matchScan.updateMany({ where: { id: scan.id, stage: 'QUEUED', finishedAt: null }, data: {
        stage: 'FAILED', reason: 'QUEUE_UNAVAILABLE', finishedAt: new Date(), elapsedMs: Date.now() - scan.createdAt.getTime()
      } });
    } finally { if (timer) clearTimeout(timer); }
    return { scanId: scan.id };
  }

  async result(userId: string, id: string) {
    let scan = await this.prisma.matchScan.findFirst({ where: { id, userId } });
    if (!scan) throw new ApiError('NOT_FOUND', '扫描任务不存在', 404);
    if (!scan.finishedAt && Date.now() - scan.createdAt.getTime() > 45_000) {
      await this.prisma.matchScan.updateMany({ where: { id, finishedAt: null }, data: {
        stage: (scan.scores as unknown as ScanScore[]).length ? 'DONE' : 'FAILED', reason: 'TIMEOUT', finishedAt: new Date(), elapsedMs: Date.now() - scan.createdAt.getTime()
      } });
      scan = (await this.prisma.matchScan.findUnique({ where: { id } }))!;
    }
    const settings = scan.settings as unknown as ScanSettings;
    const scores = scanCandidates(scan.scores as unknown as ScanScore[], settings);
    const candidates = [];
    for (const entry of scores) {
      // Revalidate publication/claim state at read time, not only when the scan ran.
      const bag = await this.prisma.officialBag.findFirst({ where: { id: entry.bagId, status: 'PUBLISHED', processStatus: 'READY' } });
      if (bag) candidates.push({ bag: await this.bags.detail(userId, bag.id), score: Number(entry.score.toFixed(4)) });
    }
    return { scanId: id, stage: scan.stage, reason: scan.reason, enhancement: scan.enhancement, elapsedMs: scan.elapsedMs,
      compared: scan.compared, result: candidates.length ? 'CANDIDATES' : 'NONE', candidates };
  }

  async feedback(userId: string, id: string, input: { bagId?: string; feedback: 'SELECTED' | 'NONE' }) {
    const scan = await this.prisma.matchScan.findFirst({ where: { id, userId } });
    if (!scan) throw new ApiError('NOT_FOUND', '扫描任务不存在', 404);
    if (input.feedback === 'SELECTED') {
      if (!(scan.scores as unknown as ScanScore[]).some(s => s.bagId === input.bagId)) throw new ApiError('VALIDATION', '选择不在候选中', 400);
      const claim = await this.prisma.officialClaim.findFirst({ where: { userId, officialBagId: input.bagId, createdAt: { gte: scan.createdAt } } });
      if (!claim) throw new ApiError('CONFLICT', '请先确认收进收藏', 409);
    }
    await this.prisma.matchScan.update({ where: { id }, data: { feedback: input.feedback, selectedBagId: input.feedback === 'SELECTED' ? input.bagId : null } });
    return { success: true };
  }

  async diagnostics(page = 1) {
    const safePage = Number.isInteger(page) ? Math.max(1, page) : 1;
    const [items, total] = await Promise.all([
      this.prisma.matchScan.findMany({ orderBy: { createdAt: 'desc' }, skip: (safePage - 1) * 20, take: 20 }),
      this.prisma.matchScan.count()
    ]);
    return { items, total };
  }

  async references(bagId: string) {
    const rows = await this.prisma.bagReferenceImage.findMany({ where: { officialBagId: bagId }, orderBy: { createdAt: 'asc' } });
    return Promise.all(rows.map(async row => ({ ...row, url: await this.cos.signedUrl(row.objectKey),
      models: (await this.prisma.scanEmbedding.findMany({ where: { officialBagId: bagId, referenceKey: row.id }, select: { model: true } })).map(e => e.model) })));
  }

  async addReference(adminId: string, bagId: string, body: Buffer, contentType: string) {
    if (body.length > 30 * 1024 * 1024 || !['image/jpeg', 'image/png', 'image/webp', 'image/heic', 'image/heif'].includes(contentType)) {
      throw new ApiError('UPLOAD_INVALID', '参考图格式无效或超过 30MB', 400);
    }
    try { await normalizeScanImage(body); } catch { throw new ApiError('UPLOAD_INVALID', '参考图无效或没有可识别主体', 400); }
    const id = randomUUID(); const key = `official/${bagId}/references/${id}/source`;
    await this.cos.putObject(key, body, contentType);
    try {
      await this.prisma.$transaction(async tx => {
        const bags = await tx.$queryRaw<{ id: string }[]>`SELECT id FROM "OfficialBag" WHERE id = ${bagId} FOR UPDATE`;
        if (!bags.length) throw new ApiError('NOT_FOUND', '袋子不存在', 404);
        if (await tx.bagReferenceImage.count({ where: { officialBagId: bagId } }) >= 5) throw new ApiError('CONFLICT', '每款最多添加 5 张参考图', 409);
        await tx.bagReferenceImage.create({ data: { id, officialBagId: bagId, objectKey: key, contentType } });
        await tx.auditLog.create({ data: { adminId, action: 'BAG_REFERENCE_ADD', targetId: bagId, metadata: { referenceId: id } } });
      });
    } catch (error) { await this.queues.add('cleanup', { keys: [key] }); throw error; }
    await this.queues.scans.add('reconcile', {}, { attempts: 1, removeOnComplete: 20, removeOnFail: 20 });
    return { id };
  }

  async removeReference(adminId: string, bagId: string, id: string) {
    const ref = await this.prisma.bagReferenceImage.findFirst({ where: { id, officialBagId: bagId } });
    if (!ref) throw new ApiError('NOT_FOUND', '参考图不存在', 404);
    await this.prisma.$transaction(async tx => {
      await tx.$queryRaw`SELECT id FROM "OfficialBag" WHERE id = ${bagId} FOR UPDATE`;
      await tx.scanEmbedding.deleteMany({ where: { officialBagId: bagId, referenceKey: id } });
      await tx.bagReferenceImage.deleteMany({ where: { id, officialBagId: bagId } });
      await tx.auditLog.create({ data: { adminId, action: 'BAG_REFERENCE_REMOVE', targetId: bagId, metadata: { referenceId: id } } });
    });
    await this.queues.add('cleanup', { keys: [ref.objectKey] });
    return { success: true };
  }

  async reconcile(bagId?: string) {
    if (bagId) await this.prisma.scanEmbedding.deleteMany({ where: { officialBagId: bagId, model: { in: [COLOR_SCAN_MODEL, DINO_SCAN_MODEL] } } });
    await this.queues.scans.add('reconcile', {}, { attempts: 1, removeOnComplete: 20, removeOnFail: 20 });
    return { queued: true };
  }
}
