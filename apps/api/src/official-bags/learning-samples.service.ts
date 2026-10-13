import { randomUUID } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { COLOR_SCAN_MODEL, DINO_SCAN_MODEL, DEFAULT_LEARNING_SETTINGS, scanCandidates, type ScanScore, type ScanSettings } from '@bagcollect/bag-vision';
import type { z } from 'zod';
import type { learningReviewSchema } from '@bagcollect/contracts';
import { PrismaService } from '../database/prisma.service.js';
import { CosService } from '../assets/cos.service.js';
import { QueueService } from '../common/queue.service.js';
import { ApiError } from '../common/api-error.js';

const DAY = 86400_000;
const lockBudget = (tx: Prisma.TransactionClient) => tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext('learning-capacity'))`;
const invalid = (message: string) => new ApiError('CONFLICT', message, 409);
type Review = z.infer<typeof learningReviewSchema>;

@Injectable()
export class LearningSamplesService {
  constructor(private readonly prisma: PrismaService, private readonly cos: CosService, private readonly queues: QueueService) {}

  async settings() {
    const row = await this.prisma.appSetting.findUnique({ where: { key: 'learning.settings' } });
    let settings = DEFAULT_LEARNING_SETTINGS;
    try { if (row) settings = { ...settings, ...JSON.parse(row.value) }; } catch { /* disabled defaults */ }
    const [usage, states, featureFailures] = await Promise.all([
      this.prisma.learningSample.aggregate({ _sum: { byteSize: true } }),
      this.prisma.learningSample.groupBy({ by: ['state'], _count: true }),
      this.prisma.learningSample.count({ where: { state: 'PENDING', featureState: 'FAILED' } })
    ]);
    return { ...settings, usedBytes: Number(usage._sum.byteSize ?? 0n), featureFailures, states: Object.fromEntries(states.map(s => [s.state, s._count])) };
  }
  async saveSettings(adminId: string, input: typeof DEFAULT_LEARNING_SETTINGS) {
    await this.prisma.$transaction(async tx => {
      await lockBudget(tx);
      await tx.appSetting.upsert({ where: { key: 'learning.settings' }, create: { key: 'learning.settings', value: JSON.stringify(input) }, update: { value: JSON.stringify(input) } });
      await tx.auditLog.create({ data: { adminId, action: 'LEARNING_SETTINGS', metadata: input } });
    });
    return this.settings();
  }

  /** Marking is independent of photo availability; late/replayed requests never relabel a reviewed sample. */
  async feedback(userId: string, scanId: string, input: { feedback: 'SELECTED' | 'CORRECTED' | 'NONE'; bagId?: string }) {
    const result = await this.prisma.$transaction(async tx => {
      await tx.$queryRaw`SELECT id FROM "MatchScan" WHERE id = ${scanId} FOR UPDATE`;
      const scan = await tx.matchScan.findFirst({ where: { id: scanId, userId } });
      if (!scan) throw new ApiError('NOT_FOUND', '扫描任务不存在', 404);
      if (!scan.finishedAt) throw invalid('请等待扫描完成');
      if (scan.feedback && (scan.feedback !== input.feedback || scan.selectedBagId !== (input.feedback === 'NONE' ? null : input.bagId))) {
        throw invalid('这次扫描已提交标记，不能重复更改');
      }
      if (input.feedback !== 'NONE') {
        if (!input.bagId) throw new ApiError('VALIDATION', '需要款式 ID', 400);
        if (input.feedback === 'SELECTED' && !scanCandidates(scan.scores as unknown as ScanScore[], scan.settings as unknown as ScanSettings).some(s => s.bagId === input.bagId)) {
          throw new ApiError('VALIDATION', '选择不在候选中', 400);
        }
        // Serialize with publication changes and admin reference operations.
        await tx.$queryRaw`SELECT id FROM "OfficialBag" WHERE id = ${input.bagId} FOR UPDATE`;
        if (!await tx.officialBag.findFirst({ where: { id: input.bagId, status: 'PUBLISHED', processStatus: 'READY' } })) throw invalid('款式已下架或图片未就绪');
        const claim = await tx.officialClaim.findFirst({ where: { userId, officialBagId: input.bagId } });
        if (!claim || !await tx.collectible.findFirst({ where: { id: claim.collectibleId, userId, sourceOfficialBagId: input.bagId } })) throw invalid('请先确认收进收藏');
      }
      await tx.matchScan.update({ where: { id: scanId }, data: { feedback: input.feedback, selectedBagId: input.feedback === 'NONE' ? null : input.bagId } });
      await tx.$queryRaw`SELECT id FROM "LearningSample" WHERE "scanId" = ${scanId} FOR UPDATE`;
      let sample = await tx.learningSample.findUnique({ where: { scanId } });
      if (!sample) sample = await tx.learningSample.create({ data: { scanId, userId, source: scan.source, model: scan.model,
        snapshot: { crop: scan.crop, settings: scan.settings, scores: scan.scores }, state: 'SKIPPED', reason: 'SAMPLE_UNAVAILABLE', expiresAt: new Date(Date.now() + DAY) } });
      if (!scan.feedback && input.feedback !== 'NONE') {
        const uploading = sample.state === 'STAGING';
        const canCollect = ['STAGED', 'STAGING'].includes(sample.state) && !!sample.objectKey && !!sample.expiresAt && sample.expiresAt > new Date();
        const duplicate = canCollect && sample.hash ? await tx.learningSample.findFirst({ where: { id: { not: sample.id }, officialBagId: input.bagId,
          hash: sample.hash, state: { in: ['PENDING', 'APPROVED'] } } }) : null;
        sample = await tx.learningSample.update({ where: { id: sample.id }, data: {
          officialBagId: input.bagId, snapshot: { ...(sample.snapshot as Prisma.JsonObject), crop: scan.crop, settings: scan.settings, scores: scan.scores, feedback: input.feedback, elapsedMs: scan.elapsedMs, enhancement: scan.enhancement },
          state: canCollect ? duplicate ? 'REJECTED' : 'PENDING' : sample.state,
          featureState: canCollect && !duplicate ? uploading ? 'WAITING_UPLOAD' : 'QUEUED' : sample.featureState,
          reason: duplicate ? 'EXACT_DUPLICATE' : canCollect ? null : sample.reason ?? 'SAMPLE_EXPIRED',
          expiresAt: canCollect ? new Date(Date.now() + (duplicate ? 7 : 14) * DAY) : sample.expiresAt
        } });
      }
      return { success: true, sampleId: sample.id, sampleStatus: sample.state, skipReason: sample.reason };
    });
    if (result.sampleStatus === 'PENDING') {
      // The timer recovers an unavailable Redis write without losing the committed label.
      void this.queues.scans.add('learning', { sampleId: result.sampleId }, { jobId: `learning-${result.sampleId}`, priority: 10, attempts: 1, removeOnComplete: true, removeOnFail: true }).catch(() => undefined);
    }
    return result;
  }

  async list(page: number, state?: string) {
    const safePage = Number.isInteger(page) ? Math.max(1, page) : 1;
    const where = state ? { state } : {};
    const [rows, total] = await Promise.all([
      this.prisma.learningSample.findMany({ where, orderBy: { createdAt: 'desc' }, skip: (safePage - 1) * 20, take: 20, include: { features: { select: { model: true } } } }),
      this.prisma.learningSample.count({ where })
    ]);
    const items = await Promise.all(rows.map(async row => {
      const bag = row.officialBagId ? await this.prisma.officialBag.findUnique({ where: { id: row.officialBagId }, select: { id: true, name: true, status: true, processStatus: true, images: { where: { side: 'FRONT', status: 'AVAILABLE', kind: 'DISPLAY' }, orderBy: { version: 'desc' }, take: 1 } } }) : null;
      return { ...row, byteSize: Number(row.byteSize), url: row.objectKey && !row.deletedAt && !['STAGING', 'FAILED', 'DELETING'].includes(row.state) ? await this.cos.privateSignedUrl(row.objectKey) : null,
        bag: bag ? { id: bag.id, name: bag.name, status: bag.status, processStatus: bag.processStatus, url: bag.images[0] ? await this.cos.signedUrl(bag.images[0].objectKey) : null } : null };
    }));
    return { items, total };
  }

  /** Archive any active extra reference; original admin images do not count against the new sample budget. */
  async archiveReference(tx: Prisma.TransactionClient, adminId: string, bagId: string, referenceId: string, state: 'WITHDRAWN' | 'REPLACED') {
    const ref = await tx.bagReferenceImage.findFirst({ where: { id: referenceId, officialBagId: bagId } });
    if (!ref) throw invalid('指定替换的参考图不存在');
    let sample = await tx.learningSample.findUnique({ where: { objectKey: ref.objectKey } });
    if (sample) {
      await tx.$queryRaw`SELECT id FROM "LearningSample" WHERE id = ${sample.id} FOR UPDATE`;
      sample = await tx.learningSample.update({ where: { id: sample.id }, data: { state, referenceId: null, expiresAt: new Date(Date.now() + 7 * DAY), reviewedById: adminId, reviewedAt: new Date() } });
    } else {
      sample = await tx.learningSample.create({ data: { officialBagId: bagId, origin: 'ADMIN_ARCHIVE', source: 'admin', model: DINO_SCAN_MODEL,
        snapshot: { referenceId: ref.id, version: ref.version, contentType: ref.contentType }, objectKey: ref.objectKey, state,
        featureState: 'READY', expiresAt: new Date(Date.now() + 7 * DAY), reviewedById: adminId, reviewedAt: new Date() } });
      const features = await tx.scanEmbedding.findMany({ where: { officialBagId: bagId, referenceKey: referenceId } });
      for (const f of features) await tx.learningSampleFeature.create({ data: { sampleId: sample.id, model: f.model, vector: f.vector, colorVector: f.colorVector } });
    }
    await tx.scanEmbedding.deleteMany({ where: { officialBagId: bagId, referenceKey: referenceId } });
    await tx.bagReferenceImage.delete({ where: { id: referenceId } });
    await tx.auditLog.create({ data: { adminId, action: `LEARNING_${state}`, targetId: sample.id, metadata: { bagId, referenceId } } });
    return sample.id;
  }

  async review(adminId: string, id: string, input: Review) {
    await this.prisma.$transaction(async tx => {
      // Consistent order: capacity -> bag -> sample, including replacement archives.
      await lockBudget(tx);
      const initial = await tx.learningSample.findUnique({ where: { id } });
      if (!initial) throw new ApiError('NOT_FOUND', '样本不存在', 404);
      const bagId = input.bagId ?? initial.officialBagId;
      if (input.bagId && input.action !== 'CORRECT' && input.bagId !== initial.officialBagId) throw invalid('请先纠正款式再审核');
      if (bagId) await tx.$queryRaw`SELECT id FROM "OfficialBag" WHERE id = ${bagId} FOR UPDATE`;
      await tx.$queryRaw`SELECT id FROM "LearningSample" WHERE id = ${id} FOR UPDATE`;
      const sample = await tx.learningSample.findUniqueOrThrow({ where: { id }, include: { features: true } });
      if (sample.deletedAt || sample.state === 'DELETING' || !sample.objectKey || (sample.expiresAt && sample.expiresAt <= new Date())) throw invalid('样本照片已过期或正在清理');
      const bag = bagId ? await tx.officialBag.findFirst({ where: { id: bagId, status: 'PUBLISHED', processStatus: 'READY' } }) : null;
      const patch: Prisma.LearningSampleUpdateInput = { reviewedById: adminId, reviewedAt: new Date() };
      if (input.action === 'CORRECT') {
        if (!['PENDING', 'REJECTED', 'WITHDRAWN', 'REPLACED'].includes(sample.state)) throw invalid('请先撤回有效参考，再纠正款式');
        if (!bag) throw invalid('款式未发布或图片未就绪');
        const duplicate = sample.hash ? await tx.learningSample.findFirst({ where: { officialBagId: bag.id, hash: sample.hash, id: { not: id }, state: { in: ['PENDING', 'APPROVED'] } } }) : null;
        if (duplicate) throw invalid('该款式已有完全相同的样本');
        patch.officialBagId = bag.id; patch.possibleDuplicate = null; patch.state = 'PENDING'; patch.reason = null;
        patch.expiresAt = new Date(Date.now() + 14 * DAY);
        if (sample.featureState !== 'READY') { patch.featureState = 'QUEUED'; patch.retryAt = null; }
      } else if (input.action === 'RECOMPUTE') {
        if (sample.state !== 'PENDING') throw invalid('仅待审样本可以重算');
        patch.featureState = 'QUEUED'; patch.retryAt = null; patch.reason = null;
      } else if (input.action === 'REJECT') {
        if (sample.state !== 'PENDING') throw invalid('仅待审样本可以驳回');
        patch.state = 'REJECTED'; patch.expiresAt = new Date(Date.now() + 7 * DAY);
      } else if (input.action === 'WITHDRAW') {
        if (sample.state !== 'APPROVED' || !sample.referenceId || !bagId) throw invalid('样本当前不是有效参考');
        await this.archiveReference(tx, adminId, bagId, sample.referenceId, 'WITHDRAWN');
      } else {
        const restoring = input.action === 'RESTORE';
        if (restoring ? !['REJECTED', 'WITHDRAWN', 'REPLACED'].includes(sample.state) : sample.state !== 'PENDING') throw invalid('样本当前状态不支持此操作');
        if (!bag) throw invalid('款式已下架或图片未就绪');
        const complete = [COLOR_SCAN_MODEL, DINO_SCAN_MODEL].every(model => {
          const f = sample.features.find(f => f.model === model);
          return f && f.vector.length === (model === DINO_SCAN_MODEL ? 384 : 389) && f.colorVector.length === 389 && [...f.vector, ...f.colorVector].every(Number.isFinite);
        });
        if (sample.featureState !== 'READY' || !complete) {
          if (restoring) {
            patch.state = 'PENDING'; patch.featureState = 'QUEUED'; patch.retryAt = null; patch.reason = null; patch.expiresAt = new Date(Date.now() + 14 * DAY);
          } else throw invalid('样本特征尚未就绪');
        } else {
          const models = [COLOR_SCAN_MODEL, DINO_SCAN_MODEL];
          for (const model of models) {
            const f = sample.features.find(f => f.model === model);
            if (!f || f.vector.length !== (model === DINO_SCAN_MODEL ? 384 : 389) || f.colorVector.length !== 389 || ![...f.vector, ...f.colorVector].every(Number.isFinite)) throw invalid('当前模型特征不完整，请重算');
          }
          if (sample.hash && await tx.learningSample.findFirst({ where: { officialBagId: bag.id, hash: sample.hash, state: 'APPROVED', id: { not: id } } })) throw invalid('该款式已有完全相同的有效参考');
          if (input.replaceReferenceId) await this.archiveReference(tx, adminId, bag.id, input.replaceReferenceId, 'REPLACED');
          const referenceId = randomUUID();
          const snapshot = sample.snapshot as { contentType?: string; version?: number };
          const version = sample.origin === 'ADMIN_ARCHIVE' ? snapshot.version ?? 1 : 1;
          await tx.bagReferenceImage.create({ data: { id: referenceId, officialBagId: bag.id, objectKey: sample.objectKey,
            contentType: sample.origin === 'ADMIN_ARCHIVE' ? snapshot.contentType ?? 'image/jpeg' : 'image/jpeg', version } });
          for (const f of sample.features.filter(f => models.includes(f.model))) await tx.scanEmbedding.create({ data: {
            officialBagId: bag.id, referenceKey: referenceId, model: f.model, vector: f.vector, colorVector: f.colorVector, sourceKind: 'ORIGINAL', sourceVersion: version
          } });
          patch.state = 'APPROVED'; patch.referenceId = referenceId; patch.expiresAt = null; patch.reason = null;
        }
      }
      await tx.learningSample.update({ where: { id }, data: patch });
      await tx.auditLog.create({ data: { adminId, action: `LEARNING_${input.action}`, targetId: id, metadata: { ...input, previousState: sample.state, previousBagId: sample.officialBagId, bagId } } });
    });
    return { success: true };
  }
}
