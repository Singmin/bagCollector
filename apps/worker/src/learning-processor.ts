import { createHash, randomUUID } from 'node:crypto';
import { Prisma, type MatchScan } from '@prisma/client';
import { COLOR_SCAN_MODEL, DINO_SCAN_MODEL, DEFAULT_LEARNING_SETTINGS, compressLearningSample,
  normalizeScanImage, extractScanFeature, cosineSimilarity } from '@bagcollect/bag-vision';
import { scanPrisma } from './scan-database.js';
import { config } from './config.js';
import { getObject, putObject, deleteObjects } from './object-store.js';

const DAY = 86400_000;
export async function learningSettings() {
  const row = await scanPrisma.appSetting.findUnique({ where: { key: 'learning.settings' } });
  try { return { ...DEFAULT_LEARNING_SETTINGS, ...(row ? JSON.parse(row.value) : {}) } as typeof DEFAULT_LEARNING_SETTINGS; }
  catch { return DEFAULT_LEARNING_SETTINGS; }
}
const lockBudget = (tx: Prisma.TransactionClient) => tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext('learning-capacity'))`;

export async function recordSkippedLearningSample(scan: MatchScan, reason: string) {
  await scanPrisma.learningSample.upsert({ where: { scanId: scan.id }, create: {
    scanId: scan.id, userId: scan.userId, source: scan.source, model: scan.model,
    snapshot: { crop: scan.crop, settings: scan.settings, sourceVersion: scan.sourceVersion }, state: 'SKIPPED', reason, expiresAt: new Date(Date.now() + DAY)
  }, update: {} });
}

/** Claim deletion first; review/feedback can no longer make this object active. Keep bytes charged on any failure. */
export async function deleteLearningSample(id: string, evict = false) {
  const sample = await scanPrisma.$transaction(async tx => {
    await lockBudget(tx);
    await tx.$queryRaw`SELECT id FROM "LearningSample" WHERE id = ${id} FOR UPDATE`;
    const row = await tx.learningSample.findUnique({ where: { id } });
    if (!row || row.deletedAt || row.state === 'APPROVED' || row.state === 'STAGING') return null;
    if (row.state !== 'DELETING' && !(row.expiresAt && row.expiresAt <= new Date()) && !(evict && row.state === 'STAGED')) return null;
    return tx.learningSample.update({ where: { id }, data: { state: 'DELETING', reason: evict ? 'CAPACITY_EVICTED' : row.reason } });
  });
  if (!sample) return false;
  try {
    if (sample.objectKey) await deleteObjects([sample.objectKey]);
    await scanPrisma.$transaction(async tx => {
      await lockBudget(tx);
      await tx.learningSample.updateMany({ where: { id, state: 'DELETING' }, data: { state: 'DELETED', byteSize: 0n, deletedAt: new Date() } });
    });
    return true;
  } catch (error) {
    console.warn(JSON.stringify({ event: 'learning_delete_failed', sampleId: id, error: String(error) }));
    return false;
  }
}

export async function cleanupLearningSamples() {
  // Only one queue consumer uploads. A stale STAGING row means a dead upload process;
  // the 10 minute grace exceeds the bounded COS SDK request timeout.
  await scanPrisma.learningSample.updateMany({ where: { OR: [{ state: 'STAGING' }, { state: 'PENDING', featureState: 'WAITING_UPLOAD' }], updatedAt: { lt: new Date(Date.now() - 600_000) } },
    data: { state: 'FAILED', reason: 'UPLOAD_INTERRUPTED', expiresAt: new Date() } });
  await scanPrisma.learningSample.updateMany({ where: { featureState: 'COMPUTING', updatedAt: { lt: new Date(Date.now() - 120_000) } },
    data: { featureState: 'QUEUED', retryAt: new Date() } });
  // Bag deletion removes reference rows. Preserve sample objects as withdrawable archives.
  const approved = await scanPrisma.learningSample.findMany({ where: { state: 'APPROVED' }, select: { id: true, referenceId: true, officialBagId: true } });
  const refs = await scanPrisma.bagReferenceImage.findMany({ where: { id: { in: approved.flatMap(s => s.referenceId ? [s.referenceId] : []) } }, select: { id: true } });
  const present = new Set(refs.map(r => r.id));
  for (const row of approved) if (!row.referenceId || !present.has(row.referenceId)) {
    await scanPrisma.$transaction(async tx => {
      await lockBudget(tx);
      if (row.officialBagId) await tx.$queryRaw`SELECT id FROM "OfficialBag" WHERE id = ${row.officialBagId} FOR UPDATE`;
      await tx.$queryRaw`SELECT id FROM "LearningSample" WHERE id = ${row.id} FOR UPDATE`;
      const current = await tx.learningSample.findUnique({ where: { id: row.id } });
      if (!current || current.state !== 'APPROVED' || (current.referenceId && await tx.bagReferenceImage.findUnique({ where: { id: current.referenceId } }))) return;
      await tx.learningSample.update({ where: { id: row.id }, data: { state: 'WITHDRAWN', referenceId: null, expiresAt: new Date(Date.now() + 7 * DAY), reason: 'REFERENCE_REMOVED' } });
    });
  }
  const rows = await scanPrisma.learningSample.findMany({ where: { OR: [
    { state: 'DELETING' }, { state: { notIn: ['APPROVED', 'STAGING', 'DELETED'] }, expiresAt: { lte: new Date() } }
  ] }, take: 100, orderBy: { expiresAt: 'asc' } });
  for (const row of rows) await deleteLearningSample(row.id);
  await scanPrisma.learningSample.deleteMany({ where: { deletedAt: { lt: new Date(Date.now() - 30 * DAY) }, byteSize: 0n, state: 'DELETED' } });
}

/** Independent JPEG is reserved and uploaded before the scan becomes confirmable. */
export async function captureLearningSample(scan: MatchScan, image: Buffer, writeObject = putObject) {
  if (await scanPrisma.learningSample.findUnique({ where: { scanId: scan.id } })) return;
  const id = randomUUID();
  const snapshot = { crop: scan.crop, settings: scan.settings, sourceVersion: scan.sourceVersion, scores: scan.scores, scanCreatedAt: scan.createdAt.toISOString() } as Prisma.InputJsonValue;
  const base = { id, scanId: scan.id, userId: scan.userId, source: scan.source, model: scan.model, snapshot };
  const skip = async (reason: string) => {
    await scanPrisma.learningSample.upsert({ where: { scanId: scan.id }, create: { ...base, state: 'SKIPPED', reason, expiresAt: new Date(Date.now() + DAY) }, update: {} });
  };
  let reserved = false;
  try {
    if (!(await learningSettings()).enabled) { await skip('COLLECTION_DISABLED'); return; }
    const jpeg = await compressLearningSample(image, config.MAX_IMAGE_PIXELS);
    await normalizeScanImage(jpeg, config.MAX_IMAGE_PIXELS);
    const objectKey = `learning-samples/${id}/image.jpg`;
    const hash = createHash('sha256').update(jpeg).digest('hex');
    const reserve = () => scanPrisma.$transaction(async tx => {
      await lockBudget(tx);
      if (await tx.learningSample.findUnique({ where: { scanId: scan.id } })) return 'EXISTS';
      const configRow = await tx.appSetting.findUnique({ where: { key: 'learning.settings' } });
      const settings = configRow ? JSON.parse(configRow.value) as typeof DEFAULT_LEARNING_SETTINGS : DEFAULT_LEARNING_SETTINGS;
      if (!settings.enabled) return 'DISABLED';
      const used = (await tx.learningSample.aggregate({ _sum: { byteSize: true } }))._sum.byteSize ?? 0n;
      if (used + BigInt(jpeg.length) > BigInt(settings.budgetBytes)) return 'FULL';
      await tx.learningSample.create({ data: { ...base, objectKey, byteSize: BigInt(jpeg.length), hash, expiresAt: new Date(Date.now() + DAY) } });
      return 'RESERVED';
    });
    let result = await reserve();
    if (result === 'FULL') {
      await cleanupLearningSamples(); result = await reserve();
      // Evict in bounded pages until enough space or no eligible staging photos remain.
      while (result === 'FULL') {
        const oldest = await scanPrisma.learningSample.findFirst({ where: { state: 'STAGED' }, orderBy: { createdAt: 'asc' } });
        if (!oldest || !await deleteLearningSample(oldest.id, true)) break;
        result = await reserve();
      }
    }
    if (result === 'EXISTS') return;
    if (result !== 'RESERVED') { await skip(result === 'DISABLED' ? 'COLLECTION_DISABLED' : 'CAPACITY_FULL'); return; }
    reserved = true;
    await writeObject(objectKey, jpeg, 'image/jpeg', true);
    await scanPrisma.$transaction(async tx => {
      await tx.$queryRaw`SELECT id FROM "LearningSample" WHERE id = ${id} FOR UPDATE`;
      const current = await tx.learningSample.findUnique({ where: { id } });
      if (current?.state === 'STAGING') await tx.learningSample.update({ where: { id }, data: { state: 'STAGED' } });
      else if (current?.state === 'PENDING' && current.featureState === 'WAITING_UPLOAD') await tx.learningSample.update({ where: { id }, data: { featureState: 'QUEUED' } });
    });
  } catch (error) {
    const reason = error instanceof Error && error.message === 'SAMPLE_TOO_LARGE' ? 'SAMPLE_TOO_LARGE' : reserved ? 'COS_UPLOAD_FAILED' : 'INVALID_SAMPLE';
    if (reserved) await scanPrisma.learningSample.update({ where: { id }, data: { state: 'FAILED', reason, expiresAt: new Date() } });
    else await skip(reason);
    console.warn(JSON.stringify({ event: 'learning_capture_failed', scanId: scan.id, reason, error: String(error) }));
  }
}

/** One sample per job, same consumer as live scans. Never calls cloud matting. */
export async function computeLearningSample(id: string) {
  const claimed = await scanPrisma.learningSample.updateMany({ where: { id, state: 'PENDING', featureState: { in: ['QUEUED', 'FAILED'] },
    OR: [{ retryAt: null }, { retryAt: { lte: new Date() } }] }, data: { featureState: 'COMPUTING', attempts: { increment: 1 } } });
  if (!claimed.count) return;
  const sample = (await scanPrisma.learningSample.findUnique({ where: { id } }))!;
  try {
    if (!sample.objectKey || !sample.officialBagId) throw new Error('SAMPLE_MISSING');
    if (!process.env.VISION_SERVICE_URL) throw new Error('DINO_SERVICE_UNAVAILABLE');
    const jpeg = await getObject(sample.objectKey);
    const dino = await extractScanFeature(jpeg, 'dino', process.env.VISION_SERVICE_URL, config.MAX_IMAGE_PIXELS);
    const color = { vector: dino.colorVector, colorVector: dino.colorVector };
    const refs = await scanPrisma.scanEmbedding.findMany({ where: { officialBagId: sample.officialBagId, model: DINO_SCAN_MODEL } });
    const duplicate = refs.find(r => cosineSimilarity(r.vector, dino.vector) >= .98)?.referenceKey;
    await scanPrisma.$transaction(async tx => {
      await tx.$queryRaw`SELECT id FROM "LearningSample" WHERE id = ${id} FOR UPDATE`;
      const current = await tx.learningSample.findUnique({ where: { id } });
      if (!current || current.state !== 'PENDING' || current.featureState !== 'COMPUTING') return;
      for (const [model, feature] of [[DINO_SCAN_MODEL, dino], [COLOR_SCAN_MODEL, color]] as const) {
        await tx.learningSampleFeature.upsert({ where: { sampleId_model: { sampleId: id, model } }, create: { sampleId: id, model, ...feature }, update: feature });
      }
      await tx.learningSample.update({ where: { id }, data: { featureState: 'READY', reason: null, possibleDuplicate: duplicate ?? null, retryAt: null } });
    });
  } catch (error) {
    await scanPrisma.learningSample.updateMany({ where: { id, state: 'PENDING', featureState: 'COMPUTING' }, data: {
      featureState: 'FAILED', reason: 'FEATURE_FAILED', retryAt: new Date(Date.now() + Math.min(3600_000, 60_000 * 2 ** Math.min(sample.attempts, 6)))
    } });
    console.warn(JSON.stringify({ event: 'learning_feature_failed', sampleId: id, error: String(error) }));
  }
}
