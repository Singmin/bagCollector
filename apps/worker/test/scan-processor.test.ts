import sharp from 'sharp';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { COLOR_SCAN_MODEL, DEFAULT_SCAN_SETTINGS } from '@bagcollect/bag-vision';

const mocks = vi.hoisted(() => ({
  job: {} as Record<string, any>,
  prisma: {
    matchScan: { findUnique: vi.fn(), findFirst: vi.fn(), updateMany: vi.fn(), update: vi.fn() },
    officialBag: { findMany: vi.fn() }, imageAsset: { findFirst: vi.fn() }, appSetting: { findUnique: vi.fn() },
    scanEnhancementUsage: { findUnique: vi.fn(), upsert: vi.fn() }, scanEmbedding: { upsert: vi.fn() },
    learningSample: { updateMany: vi.fn(async () => ({ count: 0 })) },
    $transaction: vi.fn(), $executeRaw: vi.fn(), $queryRaw: vi.fn()
  }, getObject: vi.fn(), putObject: vi.fn(), removeBackground: vi.fn(), extract: vi.fn(), options: {} as Record<string, unknown>
}));
vi.mock('@prisma/client', () => ({ PrismaClient: class { constructor() { return mocks.prisma; } } }));
vi.mock('../src/config.js', () => ({ config: { STORAGE_DRIVER: 'cos', CI_MATTING_PROCESS: 'AIPicMatting', CI_MATTING_SIZE_MODE: 'rescale', MAX_IMAGE_PIXELS: 60000000, CI_MATTING_MAX_RESPONSE_BYTES: 83886080 } }));
vi.mock('../src/object-store.js', () => ({ getObject: mocks.getObject, putObject: mocks.putObject, getSignedObjectUrl: vi.fn(), deleteObjects: vi.fn() }));
vi.mock('../src/learning-processor.js', () => ({ captureLearningSample: vi.fn(async () => {}), recordSkippedLearningSample: vi.fn(async () => {}) }));
vi.mock('../src/matting-tencent-ci.js', () => ({ createTencentCiBackgroundRemover: (options: Record<string, unknown>) => { mocks.options = options; return mocks.removeBackground; } }));
vi.mock('@bagcollect/bag-vision', async original => ({ ...await original<typeof import('@bagcollect/bag-vision')>(), extractScanFeature: mocks.extract }));
const { processScan, reconcileScanEmbeddings } = await import('../src/scan-processor.js');
const vector = (a: number, b: number) => [a, b, ...Array(387).fill(0)] as number[];
const query = { vector: vector(1, 0), colorVector: vector(1, 0) };
beforeEach(async () => {
  vi.clearAllMocks();
  mocks.job = { id: 'scan-1', userId: 'user-1', collectibleId: 'draft-1', sourceKey: 'original.png', createdAt: new Date(),
    model: COLOR_SCAN_MODEL, settings: { ...DEFAULT_SCAN_SETTINGS }, crop: null, stage: 'QUEUED', finishedAt: null, enhancementIssued: false, scores: [] };
  mocks.prisma.matchScan.findUnique.mockImplementation(async () => ({ ...mocks.job }));
  mocks.prisma.matchScan.findFirst.mockImplementation(async () => mocks.job.finishedAt ? null : { ...mocks.job });
  mocks.prisma.matchScan.updateMany.mockImplementation(async ({ where, data }) => {
    if (mocks.job.finishedAt || (where.stage && where.stage !== mocks.job.stage)) return { count: 0 };
    Object.assign(mocks.job, Object.fromEntries(Object.entries(data).filter(([, v]) => v !== undefined))); return { count: 1 };
  });
  mocks.prisma.matchScan.update.mockImplementation(async ({ data }) => Object.assign(mocks.job, data));
  mocks.prisma.$transaction.mockImplementation(async fn => fn(mocks.prisma));
  mocks.prisma.imageAsset.findFirst.mockResolvedValue({ objectKey: 'original.png' });
  mocks.prisma.officialBag.findMany.mockResolvedValue([{ id: 'bag-1', version: 1, images: [{ kind: 'DISPLAY', version: 1 }], references: [],
    scanEmbeddings: [{ referenceKey: 'primary', sourceKind: 'DISPLAY', sourceVersion: 1, vector: vector(.7, Math.sqrt(.51)), colorVector: vector(.7, Math.sqrt(.51)) }] }]);
  mocks.prisma.appSetting.findUnique.mockResolvedValue(null);
  mocks.prisma.scanEnhancementUsage.findUnique.mockResolvedValue(null);
  const image = await sharp({ create: { width: 100, height: 150, channels: 3, background: '#b43221' } }).png().toBuffer();
  mocks.getObject.mockResolvedValue(image); mocks.putObject.mockResolvedValue(undefined); mocks.removeBackground.mockResolvedValue(image);
  mocks.extract.mockResolvedValue(query);
});
describe('scan enhancement failure boundaries', () => {
  it('yields background reference backfill after one feature to preserve scan priority', async () => {
    mocks.prisma.officialBag.findMany.mockResolvedValue([{ id: 'feature-job-bag', version: 1, images: [{ kind: 'DISPLAY', version: 1, objectKey: 'primary.jpg' }],
      references: [{ id: 'reference-1', version: 1, objectKey: 'reference.jpg' }], scanEmbeddings: [] }]);
    mocks.prisma.$queryRaw.mockResolvedValue([{ version: 1 }]);
    expect((await reconcileScanEmbeddings(1, 1)).more).toBe(true);
    expect(mocks.extract).toHaveBeenCalledTimes(1); expect(mocks.prisma.scanEmbedding.upsert).toHaveBeenCalledTimes(1);
  });
  it('retains basic candidates after an issued cloud failure, charges once, and never retries a redelivery', async () => {
    mocks.removeBackground.mockRejectedValue(new Error('cloud timeout'));
    await processScan('scan-1'); await processScan('scan-1');
    expect(mocks.job.stage).toBe('DONE'); expect(mocks.job.enhancement).toBe('FAILED');
    expect(mocks.job.scores[0]).toEqual({ bagId: 'bag-1', score: .7 });
    expect(mocks.job.enhancementIssued).toBe(true); expect(mocks.removeBackground).toHaveBeenCalledTimes(1);
    expect(mocks.prisma.scanEnhancementUsage.upsert).toHaveBeenCalledTimes(2);
    expect(mocks.options.retry).toBe(0); expect(mocks.options.maxConcurrency).toBe(1);
    expect(mocks.putObject).toHaveBeenCalledWith('scans/scan-1/crop.png', expect.any(Buffer), 'image/png');
  });
  it('uses the latest disabled flag for an already queued scan without spending', async () => {
    mocks.prisma.appSetting.findUnique.mockResolvedValue({ value: JSON.stringify({ enhancementEnabled: false }) });
    await processScan('scan-1');
    expect(mocks.job.enhancement).toBe('QUOTA_OR_DISABLED'); expect(mocks.job.scores[0].score).toBe(.7);
    expect(mocks.removeBackground).not.toHaveBeenCalled(); expect(mocks.prisma.scanEnhancementUsage.upsert).not.toHaveBeenCalled();
  });
  it('retains base results when global quota is exhausted', async () => {
    mocks.prisma.scanEnhancementUsage.findUnique.mockResolvedValue({ count: 100 });
    await processScan('scan-1'); expect(mocks.job.enhancement).toBe('QUOTA_OR_DISABLED');
    expect(mocks.removeBackground).not.toHaveBeenCalled(); expect(mocks.job.stage).toBe('DONE');
  });
  it('keeps scores from both rounds and distinguishes no improvement', async () => {
    await processScan('scan-1'); expect(mocks.job.enhancement).toBe('NOT_IMPROVED'); expect(mocks.job.scores[0].score).toBe(.7);
  });
  it('improves a score using the enhanced query', async () => {
    mocks.extract.mockResolvedValueOnce(query).mockResolvedValueOnce({ vector: vector(.8, .6), colorVector: vector(.8, .6) });
    await processScan('scan-1'); expect(mocks.job.enhancement).toBe('SUCCEEDED'); expect(mocks.job.scores[0].score).toBeGreaterThan(.98);
  });
  it('distinguishes an unavailable inference service from no candidates', async () => {
    mocks.extract.mockRejectedValue(new Error('model service offline'));
    const warning = vi.spyOn(console, 'error').mockImplementation(() => {});
    try { await processScan('scan-1'); expect(mocks.job.stage).toBe('FAILED'); expect(mocks.job.reason).toBe('SERVICE_UNAVAILABLE'); }
    finally { warning.mockRestore(); }
    expect(mocks.removeBackground).not.toHaveBeenCalled();
  });
  it('bounds failed backfill attempts and lets the next style progress while the failed one backs off', async () => {
    const bags = ['retry-bad', 'retry-good'].map(id => ({ id, version: 1, images: [{ kind: 'DISPLAY', version: 1, objectKey: id }], references: [], scanEmbeddings: [] }));
    mocks.prisma.officialBag.findMany.mockResolvedValue(bags);
    const image = await mocks.getObject(); mocks.getObject.mockClear();
    mocks.getObject.mockImplementation(async key => { if (key === 'retry-bad') throw new Error('cannot download'); return image; });
    mocks.prisma.$queryRaw.mockResolvedValue([{ version: 1 }]);
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      expect((await reconcileScanEmbeddings(1)).repaired).toBe(0);
      expect(mocks.getObject.mock.calls.every(([key]) => key === 'retry-bad')).toBe(true);
      expect((await reconcileScanEmbeddings(1)).repaired).toBe(1);
      expect(mocks.prisma.scanEmbedding.upsert).toHaveBeenCalled();
    } finally { warning.mockRestore(); }
  });
});
