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
    config: {
      CI_MATTING_PROCESS: 'GoodsMatting',
      CI_MATTING_TIMEOUT_MS: 60_000,
      CI_MATTING_MAX_RESPONSE_BYTES: 83_886_080,
      CI_MATTING_MAX_CONCURRENCY: 4,
      CI_MATTING_SIGN_EXPIRES_SECONDS: 600,
      CI_MATTING_SIZE_MODE: 'rescale',
      CI_MATTING_RETRY: 1,
      MAX_IMAGE_PIXELS: 60_000_000
    },
    getObject: vi.fn(),
    getSignedObjectUrl: vi.fn(),
    putObject: vi.fn(),
    deleteObjects: vi.fn(),
    upsertAssetRecord: vi.fn(),
    removeBackground: vi.fn(),
    // processor.ts 在模块加载时就把签名解析器注册进万象实现，这里把它接出来单独断言。
    signedUrlResolver: { current: undefined as undefined | ((key: string, query: Record<string, string>) => string) }
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

vi.mock('../src/config.js', () => ({ config: mocks.config }));

vi.mock('../src/object-store.js', () => ({
  getObject: mocks.getObject,
  getSignedObjectUrl: mocks.getSignedObjectUrl,
  putObject: mocks.putObject,
  deleteObjects: mocks.deleteObjects
}));

vi.mock('../src/asset-record.js', () => ({ upsertAssetRecord: mocks.upsertAssetRecord }));
vi.mock('../src/matting-tencent-ci.js', () => ({
  createTencentCiBackgroundRemover: (_options: unknown, resolveSignedUrl: never) => {
    mocks.signedUrlResolver.current = resolveSignedUrl;
    return (target: unknown) => mocks.removeBackground(target);
  }
}));

const { AssetKind, JobStatus, ProcessingStatus } = await import('@prisma/client');
const { failProcessing, matImage, standardImage } = await import('../src/processor.js');

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
  mocks.getSignedObjectUrl.mockImplementation(
    (key: string, options: { query: Record<string, string> }) =>
      `https://bucket.cos.ap-guangzhou.myqcloud.com/${key}?${new URLSearchParams(options.query).toString()}`
  );
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

  it('keeps only the crop asset and never creates renditions when matting fails', async () => {
    mocks.removeBackground.mockRejectedValue(new Error('万象抠图请求失败（403）'));

    await expect(matImage(jobData)).rejects.toThrow('万象抠图请求失败（403）');

    expect(mocks.upsertAssetRecord.mock.calls.map((call) => call[1].kind)).toEqual([AssetKind.CROPPED]);
    expect(mocks.upsertAssetRecord.mock.calls.some((call) => call[1].kind === AssetKind.CUTOUT)).toBe(false);
    expect(mocks.prisma.collectible.update).not.toHaveBeenCalled();
  });

  it('runs 万象 on the cropped object and writes a cutout at the crop size', async () => {
    mocks.removeBackground.mockResolvedValue(await transparentPng());

    await matImage(jobData);

    expect(mocks.removeBackground).toHaveBeenCalledWith({
      objectKey: expect.stringContaining('/cropped/v1.jpg'),
      width: 4,
      height: 4
    });

    const cutout = mocks.putObject.mock.calls.find((call) => String(call[0]).includes('/cutout/'));
    const cutoutMeta = await sharp(cutout![1] as Buffer).metadata();
    expect([cutoutMeta.width, cutoutMeta.height]).toEqual([4, 4]);
    expect(mocks.upsertAssetRecord.mock.calls.map((call) => call[1].kind)).toEqual([
      AssetKind.CROPPED,
      AssetKind.CUTOUT,
      AssetKind.DISPLAY,
      AssetKind.THUMBNAIL
    ]);
  });

  it('signs the 万象 ci-process query onto the cropped COS URL', async () => {
    mocks.removeBackground.mockResolvedValue(await transparentPng());

    await matImage(jobData);

    const resolver = mocks.signedUrlResolver.current;
    expect(resolver).toBeTypeOf('function');
    const url = resolver!('users/u/collectibles/c/cropped/v1.jpg', {
      'ci-process': 'GoodsMatting',
      'center-layout': '0'
    });
    expect(url).toContain('ci-process=GoodsMatting');
    expect(url).toContain('center-layout=0');
    expect(mocks.getSignedObjectUrl).toHaveBeenCalledWith('users/u/collectibles/c/cropped/v1.jpg', {
      query: { 'ci-process': 'GoodsMatting', 'center-layout': '0' },
      expiresSeconds: 600
    });
  });

  it('marks both the job and collectible FAILED immediately', async () => {
    await failProcessing(jobData, new Error('processing failure'));

    expect(mocks.prisma.processingJob.update).toHaveBeenCalledWith({
      where: { id: jobData.processingJobId },
      data: { status: JobStatus.FAILED, errorMessage: 'processing failure', finishedAt: expect.any(Date) }
    });
    expect(mocks.prisma.collectible.update).toHaveBeenCalledWith({
      where: { id: jobData.collectibleId },
      data: { processingStatus: ProcessingStatus.FAILED, processingError: 'processing failure' }
    });
  });
});

describe('standardImage', () => {
  it('flattens transparent PNGs onto a white background instead of black', async () => {
    const width = 100;
    const height = 100;
    const pixels = Buffer.alloc(width * height * 4, 0);
    for (let y = 0; y < height; y += 1) {
      for (let x = 0; x < width; x += 1) {
        const i = (y * width + x) * 4;
        if (x < width / 2) {
          pixels[i] = 255;
          pixels[i + 1] = 0;
          pixels[i + 2] = 0;
          pixels[i + 3] = 255;
        }
        // 右半边保持 alpha=0（已初始化为 0）
      }
    }
    const png = await sharp(pixels, { raw: { width, height, channels: 4 } }).png().toBuffer();

    const standard = await standardImage(png);

    expect(standard.contentType).toBe('image/jpeg');
    expect(standard.extension).toBe('jpg');
    expect(standard.width).toBe(width);
    expect(standard.height).toBe(height);

    const raw = await sharp(standard.body).raw().toBuffer();
    // 取样右半边几个点，确认透明区域被铺成白色而非黑色。
    // 右半边远离红/透明边界取样，避开 JPEG 压缩带来的边界混色。
    const sampleIndices = [55, 65, 75, 85, 95];
    for (const x of sampleIndices) {
      const offset = (x + width * Math.floor(height / 2)) * 3;
      expect([raw[offset], raw[offset + 1], raw[offset + 2]]).toEqual([255, 255, 255]);
    }
  });

  it('keeps transparency as PNG when keepTransparency is requested', async () => {
    const width = 100;
    const height = 100;
    const pixels = Buffer.alloc(width * height * 4, 0);
    for (let y = 0; y < height; y += 1) {
      for (let x = 0; x < width; x += 1) {
        const i = (y * width + x) * 4;
        if (x < width / 2) {
          pixels[i] = 255;
          pixels[i + 1] = 0;
          pixels[i + 2] = 0;
          pixels[i + 3] = 255;
        }
        // 右半边保持 alpha=0（已初始化为 0）
      }
    }
    const png = await sharp(pixels, { raw: { width, height, channels: 4 } }).png().toBuffer();

    const standard = await standardImage(png, { keepTransparency: true });

    expect(standard.contentType).toBe('image/png');
    expect(standard.extension).toBe('png');
    expect(standard.width).toBe(width);
    expect(standard.height).toBe(height);

    const meta = await sharp(standard.body).metadata();
    expect(meta.format).toBe('png');
    expect(meta.hasAlpha).toBe(true);
    // 右半边仍应是完全透明。
    const raw = await sharp(standard.body).raw().toBuffer();
    const offset = (75 + width * Math.floor(height / 2)) * 4;
    expect(raw[offset + 3]).toBe(0);
  });

  it('falls back to flattened JPEG for opaque images even with keepTransparency', async () => {
    const png = await sharp({
      create: { width: 8, height: 8, channels: 3, background: '#ff0000' }
    })
      .png()
      .toBuffer();

    const standard = await standardImage(png, { keepTransparency: true });

    expect(standard.contentType).toBe('image/jpeg');
    expect(standard.extension).toBe('jpg');
    const meta = await sharp(standard.body).metadata();
    expect(meta.format).toBe('jpeg');
  });
});
