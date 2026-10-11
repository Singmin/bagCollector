import { COLOR_SCAN_MODEL, DINO_SCAN_MODEL, DEFAULT_SCAN_SETTINGS, cropScanImage, extractScanFeature, needsScanEnhancement, rankScanCandidates, scanCandidates,
  type ScanCrop, type ScanSettings, type ScanEntry, type ScanScore } from '@bagcollect/bag-vision';
import { PrismaClient } from '@prisma/client';
import sharp from 'sharp';
import { config } from './config.js';
import { getObject, putObject, getSignedObjectUrl, deleteObjects } from './object-store.js';
import { createTencentCiBackgroundRemover } from './matting-tencent-ci.js';

export const scanPrisma = new PrismaClient();
const serviceUrl = process.env.VISION_SERVICE_URL;
const scanMatting = createTencentCiBackgroundRemover({
  process: config.CI_MATTING_PROCESS, timeoutMs: 12_000, maxResponseBytes: config.CI_MATTING_MAX_RESPONSE_BYTES,
  maxImagePixels: config.MAX_IMAGE_PIXELS, maxConcurrency: 1, sizeMode: config.CI_MATTING_SIZE_MODE, retry: 0
}, (key, query) => getSignedObjectUrl(key, { query, expiresSeconds: 120 }));

export function shanghaiDay(date = new Date()) { return new Date(date.getTime() + 8 * 3600_000).toISOString().slice(0, 10); }

/** Serialize reservations for both counters and the job marker in ONE transaction. Failed issued calls remain charged. */
export async function reserveEnhancement(scanId: string, userId: string, settings: ScanSettings) {
  if (!settings.enhancementEnabled || settings.dailyUserEnhancements === 0 || settings.dailyGlobalEnhancements === 0) return false;
  const day = shanghaiDay();
  return scanPrisma.$transaction(async tx => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`scan-enhancement:${day}`}))`;
    const job = await tx.matchScan.findUnique({ where: { id: scanId } });
    if (!job || job.userId !== userId || job.enhancementIssued || job.finishedAt || Date.now() - job.createdAt.getTime() >= 45_000) return false;
    const global = await tx.scanEnhancementUsage.findUnique({ where: { day_scope: { day, scope: 'global' } } });
    const user = await tx.scanEnhancementUsage.findUnique({ where: { day_scope: { day, scope: userId } } });
    if ((global?.count ?? 0) >= settings.dailyGlobalEnhancements || (user?.count ?? 0) >= settings.dailyUserEnhancements) return false;
    for (const scope of ['global', userId]) await tx.scanEnhancementUsage.upsert({
      where: { day_scope: { day, scope } }, create: { day, scope, count: 1 }, update: { count: { increment: 1 } }
    });
    await tx.matchScan.update({ where: { id: scanId }, data: { enhancementIssued: true, enhancement: 'ISSUED', stage: 'ENHANCING' } });
    return true;
  });
}

function featureSource(images: { kind: string; version: number; objectKey: string }[], version: number) {
  return images.find(i => i.version === version && i.kind === 'CUTOUT') ?? images.find(i => i.version === version && i.kind === 'DISPLAY');
}

/** Only current image/reference versions can participate; stale embeddings never silently affect ranking. */
async function indexFor(model: string): Promise<{ entries: ScanEntry[]; total: number }> {
  const bags = await scanPrisma.officialBag.findMany({ where: { status: 'PUBLISHED', processStatus: 'READY' },
    include: { images: { where: { status: 'AVAILABLE', kind: { in: ['CUTOUT', 'DISPLAY'] } } }, references: true, scanEmbeddings: { where: { model } } } });
  const entries: ScanEntry[] = [];
  for (const bag of bags) for (const embedding of bag.scanEmbeddings) {
    const source = embedding.referenceKey === 'primary' ? featureSource(bag.images, bag.version) : bag.references.find(r => r.id === embedding.referenceKey);
    if (!source || embedding.sourceVersion !== source.version || ('kind' in source && embedding.sourceKind !== source.kind)) continue;
    const expectedDim = model === DINO_SCAN_MODEL ? 384 : 389;
    if (embedding.vector.length !== expectedDim || embedding.colorVector.length !== 389 || ![...embedding.vector, ...embedding.colorVector].every(Number.isFinite)) continue;
    entries.push({ officialBagId: bag.id, vector: embedding.vector, colorVector: embedding.colorVector });
  }
  return { entries, total: bags.length };
}

export async function processScan(scanId: string) {
  // A stalled/redelivered job cannot issue the paid request again.
  const claimed = await scanPrisma.matchScan.updateMany({ where: { id: scanId, stage: 'QUEUED', finishedAt: null }, data: { stage: 'RECOGNIZING' } });
  if (!claimed.count) return;
  const scan = (await scanPrisma.matchScan.findUnique({ where: { id: scanId } }))!;
  const settings = scan.settings as unknown as ScanSettings;
  const active = () => scanPrisma.matchScan.findFirst({ where: { id: scanId, finishedAt: null, createdAt: { gt: new Date(Date.now() - 45_000) } } });
  const finish = async (data: { reason?: string | null; scores?: ScanScore[]; compared?: number; enhancement?: string; stage?: string }) => {
    await scanPrisma.matchScan.updateMany({ where: { id: scanId, finishedAt: null }, data: {
      ...data, scores: data.scores ? data.scores.map(s => ({ ...s })) : undefined,
      stage: data.stage ?? 'DONE', elapsedMs: Date.now() - scan.createdAt.getTime(), finishedAt: new Date()
    } });
  };
  let baseScores: ScanScore[] = [];
  try {
    if (Date.now() - scan.createdAt.getTime() >= 45_000) { await finish({ stage: 'FAILED', reason: 'TIMEOUT' }); return; }
    const source = await scanPrisma.imageAsset.findFirst({ where: { collectibleId: scan.collectibleId, userId: scan.userId, objectKey: scan.sourceKey, status: 'AVAILABLE' } });
    if (!source) { await finish({ stage: 'FAILED', reason: 'SOURCE_REMOVED' }); return; }
    const { entries, total } = await indexFor(scan.model);
    const compared = new Set(entries.map(e => e.officialBagId)).size;
    if (!entries.length) { await finish({ compared: 0, reason: total ? 'INDEX_NOT_READY' : 'LIBRARY_EMPTY' }); return; }
    const crop = scan.crop as unknown as ScanCrop | undefined;
    const image = await cropScanImage(await getObject(scan.sourceKey), crop ?? undefined, config.MAX_IMAGE_PIXELS);
    const query = await extractScanFeature(image, settings.engine, serviceUrl, config.MAX_IMAGE_PIXELS);
    baseScores = rankScanCandidates([query], entries, settings);
    await scanPrisma.matchScan.updateMany({ where: { id: scanId, finishedAt: null }, data: { scores: baseScores.map(s => ({ ...s })), compared } });
    if (!await active()) return;
    let scores = baseScores; let enhancement = 'NOT_NEEDED';
    if (needsScanEnhancement(scores, settings)) {
      if (config.STORAGE_DRIVER !== 'cos') enhancement = 'LOCAL_STORAGE';
      else {
        const key = `scans/${scanId}/crop.png`;
        // Register key BEFORE uploading: even an interrupted upload has a discoverable cleanup target.
        await scanPrisma.matchScan.updateMany({ where: { id: scanId, finishedAt: null }, data: { temporaryKeys: [key] } });
        await putObject(key, image, 'image/png');
        // Re-read budget at invocation time, so lowering a limit affects jobs already queued.
        const current = await scanPrisma.appSetting.findUnique({ where: { key: 'scan.settings' } });
        let budget = { ...DEFAULT_SCAN_SETTINGS, ...settings };
        try { if (current) budget = { ...budget, ...JSON.parse(current.value) }; } catch { /* snapshot defaults */ }
        if (!budget.enhancementEnabled || !await reserveEnhancement(scanId, scan.userId, budget)) enhancement = 'QUOTA_OR_DISABLED';
        else {
          try {
            const meta = await sharp(image).metadata();
            const cutout = await scanMatting({ objectKey: key, width: meta.width!, height: meta.height! });
            const enhanced = await extractScanFeature(cutout, settings.engine, serviceUrl, config.MAX_IMAGE_PIXELS);
            scores = rankScanCandidates([query, enhanced], entries, settings);
            enhancement = scores.some(s => s.score > (baseScores.find(b => b.bagId === s.bagId)?.score ?? -1) + 1e-6) ? 'SUCCEEDED' : 'NOT_IMPROVED';
          } catch { enhancement = 'FAILED'; }
        }
      }
    }
    await finish({ scores, compared, enhancement, reason: scanCandidates(scores, settings).length ? null : 'NO_CANDIDATES' });
  } catch (error) {
    console.error(JSON.stringify({ event: 'scan_failed', scanId, error: error instanceof Error ? error.message : String(error) }));
    if (baseScores.length) await finish({ scores: baseScores, enhancement: 'FAILED' });
    else await finish({ stage: 'FAILED', reason: error instanceof Error && error.message.includes('主体') ? 'INVALID_IMAGE' : 'SERVICE_UNAVAILABLE' });
  }
}

/** Backfill both models and all references, one bag per sweep by default. */
const backfillRetryAfter = new Map<string, number>();
export async function reconcileScanEmbeddings(limit = 1) {
  const bags = await scanPrisma.officialBag.findMany({ where: { processStatus: 'READY' },
    include: { images: { where: { status: 'AVAILABLE', kind: { in: ['CUTOUT', 'DISPLAY'] } } }, references: true, scanEmbeddings: true }, orderBy: { updatedAt: 'asc' } });
  let repaired = 0; let attemptedBags = 0;
  for (const bag of bags) {
    const primary = featureSource(bag.images, bag.version);
    const sources = [...(primary ? [{ key: 'primary', ...primary }] : []), ...bag.references.map(r => ({ key: r.id, kind: 'ORIGINAL' as const, version: r.version, objectKey: r.objectKey }))];
    let changed = false; let attempted = false;
    for (const source of sources) for (const engine of (serviceUrl ? ['color', 'dino'] : ['color']) as ('color' | 'dino')[]) {
      const model = engine === 'dino' ? DINO_SCAN_MODEL : COLOR_SCAN_MODEL;
      if (bag.scanEmbeddings.some(e => e.referenceKey === source.key && e.model === model && e.sourceVersion === source.version && e.sourceKind === source.kind &&
        e.vector.length === (engine === 'dino' ? 384 : 389) && e.colorVector.length === 389 && [...e.vector, ...e.colorVector].every(Number.isFinite))) continue;
      const retryKey = `${bag.id}:${source.key}:${source.version}:${source.kind}:${model}`;
      if ((backfillRetryAfter.get(retryKey) ?? 0) > Date.now()) continue;
      attempted = true;
      try {
        const feature = await extractScanFeature(await getObject(source.objectKey), engine, serviceUrl, config.MAX_IMAGE_PIXELS);
        // Re-check the source after inference. A concurrent replacement/removal must not resurrect an old vector.
        await scanPrisma.$transaction(async tx => {
          const locked = await tx.$queryRaw<{ version: number }[]>`SELECT version FROM "OfficialBag" WHERE id = ${bag.id} FOR UPDATE`;
          if (!locked.length) return;
          if (source.key === 'primary' && locked[0]!.version !== source.version) return;
          if (source.key !== 'primary' && !await tx.bagReferenceImage.findUnique({ where: { id: source.key } })) return;
          const payload = { ...feature, sourceKind: source.kind as 'ORIGINAL' | 'CUTOUT' | 'DISPLAY', sourceVersion: source.version };
          await tx.scanEmbedding.upsert({ where: { officialBagId_model_referenceKey: { officialBagId: bag.id, model, referenceKey: source.key } },
            create: { officialBagId: bag.id, model, referenceKey: source.key, ...payload }, update: payload });
        });
        backfillRetryAfter.delete(retryKey);
        changed = true;
      } catch (error) {
        backfillRetryAfter.set(retryKey, Date.now() + 300_000);
        console.warn(JSON.stringify({ event: 'scan_embedding_failed', bagId: bag.id, referenceKey: source.key, model, error: String(error) }));
      }
    }
    if (changed) repaired++;
    // Bound attempts as well as successful repairs. A failed service must not scan
    // the entire library with one timeout per reference and starve interactive work.
    if (attempted && ++attemptedBags >= limit) break;
  }
  return { repaired };
}

export async function cleanupScans() {
  // Retry confirmed draft cleanup independently of the miniapp's DELETE request.
  // Only untouched AWAITING_CROP drafts that still carry this exact source qualify.
  const pendingDrafts = await scanPrisma.$queryRaw<{ id: string }[]>`
    SELECT s.id FROM "MatchScan" s JOIN "Collectible" c ON c.id = s."collectibleId" AND c."userId" = s."userId"
    WHERE s.feedback = 'SELECTED' AND c."processingStatus" = 'AWAITING_CROP' AND c."sourceOfficialBagId" IS NULL
    ORDER BY s."createdAt" ASC LIMIT 100`;
  const confirmed = await scanPrisma.matchScan.findMany({ where: { id: { in: pendingDrafts.map(row => row.id) } } });
  for (const scan of confirmed) {
    const keys = await scanPrisma.$transaction(async tx => {
      await tx.$queryRaw`SELECT id FROM "Collectible" WHERE id = ${scan.collectibleId} AND "userId" = ${scan.userId} FOR UPDATE`;
      const draft = await tx.collectible.findFirst({ where: { id: scan.collectibleId, userId: scan.userId, processingStatus: 'AWAITING_CROP',
        sourceOfficialBagId: null, imageAssets: { some: { objectKey: scan.sourceKey, version: scan.sourceVersion, status: 'AVAILABLE' } } }, include: { imageAssets: true } });
      if (!draft) return [];
      const draftKeys = draft.imageAssets.map(asset => asset.objectKey);
      const bytes = draft.imageAssets.reduce((sum, asset) => sum + (asset.status === 'AVAILABLE' ? asset.byteSize : 0n), 0n);
      // Keep every object discoverable if storage cleanup fails after the DB transaction.
      await tx.matchScan.update({ where: { id: scan.id }, data: { temporaryKeys: [...new Set([...scan.temporaryKeys, ...draftKeys])] } });
      await tx.collectible.delete({ where: { id: draft.id } });
      await tx.$executeRaw`UPDATE "User" SET "storageUsedBytes" = GREATEST(0, "storageUsedBytes" - ${bytes}) WHERE id = ${scan.userId}`;
      return draftKeys;
    });
    if (keys.length) {
      await deleteObjects(keys);
      // Remove only deleted draft keys, retaining enhancement objects until their TTL.
      const current = await scanPrisma.matchScan.findUnique({ where: { id: scan.id } });
      if (current) await scanPrisma.matchScan.update({ where: { id: scan.id }, data: { temporaryKeys: current.temporaryKeys.filter(key => !keys.includes(key)) } });
    }
  }
  const stale = await scanPrisma.matchScan.findMany({ where: { createdAt: { lt: new Date(Date.now() - 24 * 3600_000) }, NOT: { temporaryKeys: { isEmpty: true } } }, take: 100 });
  for (const scan of stale) { await deleteObjects(scan.temporaryKeys); await scanPrisma.matchScan.update({ where: { id: scan.id }, data: { temporaryKeys: [] } }); }
  // Only delete diagnostics AFTER temporary object cleanup has succeeded.
  await scanPrisma.matchScan.deleteMany({ where: { createdAt: { lt: new Date(Date.now() - 30 * 86400_000) }, temporaryKeys: { isEmpty: true } } });
  await scanPrisma.scanEnhancementUsage.deleteMany({ where: { day: { lt: shanghaiDay(new Date(Date.now() - 31 * 86400_000)) } } });
  const stuck = await scanPrisma.matchScan.findMany({ where: { finishedAt: null, createdAt: { lt: new Date(Date.now() - 45_000) } } });
  for (const scan of stuck) await scanPrisma.matchScan.updateMany({ where: { id: scan.id, finishedAt: null }, data: {
    stage: (scan.scores as unknown as ScanScore[]).length ? 'DONE' : 'FAILED', reason: 'TIMEOUT', finishedAt: new Date(), elapsedMs: Date.now() - scan.createdAt.getTime()
  } });
}
