import sharp from 'sharp';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => {
  const prisma = {
    processingJob: { update: vi.fn() },
    collectible: { findFirstOrThrow: vi.fn(), update: vi.fn() },
    imageAsset: { findFirstOrThrow: vi.fn() },
    $transaction: vi.fn(),
    $disconnect: vi.fn()
  };
  return {
    prisma,
    getObject: vi.fn(),
    putObject: vi.fn(),
    deleteObjects: vi.fn(),
    upsertAssetRecord: vi.fn(),
    removeBackground: vi.fn()
  };
});

vi.mock('@prisma/client', async () => {
  const actual = await vi.importActual<typeof import('@prisma/client')>('@prisma/client');
  return {
    ...actual,
    PrismaClient: class {
      constructor() {
        return mocks.prisma;
      }
    }
  };
});

vi.mock('../src/config.js', () => ({
  config: {
    MATTING_DRIVER: 'rembg',
    REMBG_URL: 'http://127.0.0.1:7000',
    REMBG_MODEL: 'birefnet-general-lite',
    REMBG_TIMEOUT_MS: 120_000,
    REMBG_MAX_RESPONSE_BYTES: 83_886_080,
    REMBG_MAX_CONCURRENCY: 1,
    MAX_IMAGE_PIXELS: 60_000_000
  }
}));

vi.mock('../src/object-store.js', () => ({
  getObject: mocks.getObject,
  putObject: mocks.putObject,
  deleteObjects: mocks.deleteObjects
}));

vi.mock('../src/asset-record.js', () => ({ upsertAssetRecord: mocks.upsertAssetRecord }));
vi.mock('../src/matting.js', () => ({
  createBackgroundRemover: () => (input: Buffer) => mocks.removeBackground(input)
}));

const { AssetKind, JobStatus, ProcessingStatus } = await import('@prisma/client');
const { failProcessing, matImage } = await import('../src/processor.js');

const jobData = {
  processingJobId: 'job-1',
  collectibleId: 'collectible-1',
  userId: 'user-1',
  version: 1
};

async function jpeg() {
  return sharp({ create: { width: 4, height: 4, channels: 3, background: '#eeeeee' } })
    .jpeg()
    .toBuffer();
}

async function transparentPng() {
  const pixels = Buffer.alloc(4 * 4 * 4, 255);
  pixels[3] = 0;
  return sharp(pixels, { raw: { width: 4, height: 4, channels: 4 } }).png().toBuffer();
}

beforeEach(async () => {
  vi.clearAllMocks();
  mocks.prisma.processingJob.update.mockResolvedValue(undefined);
  mocks.prisma.collectible.findFirstOrThrow.mockResolvedValue({
    cropX: 0,
    cropY: 0,
    cropWidth: 1,
    cropHeight: 1,
    cropRotation: 0
  });
  mocks.prisma.collectible.update.mockResolvedValue(undefined);
  mocks.prisma.imageAsset.findFirstOrThrow.mockResolvedValue({ objectKey: 'standard.jpg' });
  mocks.prisma.$transaction.mockImplementation(async (operations: Promise<unknown>[]) => Promise.all(operations));
  mocks.getObject.mockResolvedValue(await jpeg());
  mocks.putObject.mockResolvedValue(undefined);
  mocks.upsertAssetRecord.mockResolvedValue(undefined);
});

describe('worker matting processor', () => {
  it('writes every derived asset and marks the collectible READY only after successful matting', async () => {
    mocks.removeBackground.mockResolvedValue(await transparentPng());

    await matImage(jobData);

    expect(mocks.upsertAssetRecord.mock.calls.map((call) => call[1].kind)).toEqual([
      AssetKind.CROPPED,
      AssetKind.CUTOUT,
      AssetKind.DISPLAY,
      AssetKind.THUMBNAIL
    ]);
    expect(mocks.prisma.collectible.update).toHaveBeenCalledWith({
      where: { id: jobData.collectibleId },
      data: { processingStatus: ProcessingStatus.READY, processingError: null }
    });
    expect(mocks.prisma.processingJob.update).toHaveBeenLastCalledWith({
      where: { id: jobData.processingJobId },
      data: { status: JobStatus.SUCCEEDED, finishedAt: expect.any(Date), errorMessage: null }
    });
  });

  it('keeps crop renditions but never creates a CUTOUT or READY state when matting fails', async () => {
    mocks.removeBackground.mockRejectedValue(new Error('rembg unavailable'));

    await expect(matImage(jobData)).rejects.toThrow('rembg unavailable');

    expect(mocks.upsertAssetRecord.mock.calls.map((call) => call[1].kind)).toEqual([
      AssetKind.CROPPED,
      AssetKind.DISPLAY,
      AssetKind.THUMBNAIL
    ]);
    expect(mocks.upsertAssetRecord.mock.calls.some((call) => call[1].kind === AssetKind.CUTOUT)).toBe(false);
    expect(mocks.prisma.collectible.update).not.toHaveBeenCalled();
  });

  it('returns a retryable job to QUEUED without marking the collectible failed', async () => {
    await failProcessing(jobData, new Error('temporary failure'), false);

    expect(mocks.prisma.processingJob.update).toHaveBeenCalledWith({
      where: { id: jobData.processingJobId },
      data: { status: JobStatus.QUEUED, errorMessage: 'temporary failure', finishedAt: null }
    });
    expect(mocks.prisma.collectible.update).not.toHaveBeenCalled();
  });

  it('marks both the job and collectible FAILED after the final attempt', async () => {
    await failProcessing(jobData, new Error('final failure'), true);

    expect(mocks.prisma.processingJob.update).toHaveBeenCalledWith({
      where: { id: jobData.processingJobId },
      data: { status: JobStatus.FAILED, errorMessage: 'final failure', finishedAt: expect.any(Date) }
    });
    expect(mocks.prisma.collectible.update).toHaveBeenCalledWith({
      where: { id: jobData.collectibleId },
      data: { processingStatus: ProcessingStatus.FAILED, processingError: 'final failure' }
    });
  });
});
