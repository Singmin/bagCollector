import { setTimeout as delay } from 'node:timers/promises';
import sharp from 'sharp';
import { describe, expect, it, vi } from 'vitest';
import {
  createTencentCiBackgroundRemover,
  type FetchLike,
  type SignedUrlResolver,
  type TencentCiMattingOptions
} from '../src/matting-tencent-ci.js';

const baseOptions: TencentCiMattingOptions = {
  process: 'GoodsMatting',
  timeoutMs: 1_000,
  maxResponseBytes: 1_000_000,
  maxImagePixels: 1_000_000,
  maxConcurrency: 1,
  sizeMode: 'rescale',
  retry: 0
};

const target = { objectKey: 'users/u/collectibles/c/cropped/v1.jpg', width: 4, height: 4 };

const resolveSignedUrl: SignedUrlResolver = (objectKey, query) =>
  `https://bucket-1250000000.cos.ap-guangzhou.myqcloud.com/${objectKey}?${new URLSearchParams(query).toString()}`;

async function rgbaPng(alphaValues: number[], width = 4, height = 4) {
  const pixels = Buffer.alloc(width * height * 4);
  for (let index = 0; index < width * height; index += 1) {
    pixels[index * 4] = 30;
    pixels[index * 4 + 1] = 60;
    pixels[index * 4 + 2] = 90;
    pixels[index * 4 + 3] = alphaValues[index] ?? alphaValues.at(-1) ?? 255;
  }
  return sharp(pixels, { raw: { width, height, channels: 4 } }).png().toBuffer();
}

function pngResponse(body: Buffer, headers: Record<string, string> = {}) {
  return new Response(body, { headers: { 'content-type': 'image/png', ...headers } });
}

describe('腾讯云数据万象 background remover', () => {
  it('requests the signed 万象 URL and normalizes a transparent PNG', async () => {
    const output = await rgbaPng([0, 120, 255, 255]);
    const fetchImpl: FetchLike = async (input, init) => {
      expect(String(input)).toContain('bucket-1250000000.cos.ap-guangzhou.myqcloud.com');
      expect(String(input)).toContain('ci-process=GoodsMatting');
      // 必须显式保持原画布，否则输出无法与裁剪图对位。
      expect(String(input)).toContain('center-layout=0');
      expect(init?.method).toBe('GET');
      return pngResponse(output);
    };

    const result = await createTencentCiBackgroundRemover(baseOptions, resolveSignedUrl, fetchImpl)(target);
    const metadata = await sharp(result).metadata();
    expect(metadata.format).toBe('png');
    expect(metadata.hasAlpha).toBe(true);
    expect([metadata.width, metadata.height]).toEqual([4, 4]);
  });

  it('accepts an identical-size canvas without re-encoding the geometry', async () => {
    const output = await rgbaPng([0, 255, 255, 255]);
    const result = await createTencentCiBackgroundRemover(baseOptions, resolveSignedUrl, async () =>
      pngResponse(output)
    )(target);
    expect([(await sharp(result).metadata()).width, (await sharp(result).metadata()).height]).toEqual([4, 4]);
  });

  it('rejects a different canvas size in strict mode', async () => {
    const output = await rgbaPng([0, 255, 255, 255], 2, 2);
    const remove = createTencentCiBackgroundRemover(
      { ...baseOptions, sizeMode: 'strict' },
      resolveSignedUrl,
      async () => pngResponse(output)
    );
    await expect(remove(target)).rejects.toThrow('万象抠图结果尺寸与裁剪图不一致');
  });

  it('rescales a same-aspect output back to the crop size', async () => {
    const output = await rgbaPng([0, 255, 255, 255], 2, 2);
    const result = await createTencentCiBackgroundRemover(baseOptions, resolveSignedUrl, async () =>
      pngResponse(output)
    )(target);
    const metadata = await sharp(result).metadata();
    expect([metadata.width, metadata.height]).toEqual([4, 4]);
    expect(metadata.hasAlpha).toBe(true);
  });

  it('rejects an output whose aspect ratio differs because the subject would be misaligned', async () => {
    const output = await rgbaPng([0, 255, 255, 255], 6, 2);
    const remove = createTencentCiBackgroundRemover(baseOptions, resolveSignedUrl, async () => pngResponse(output));
    await expect(remove(target)).rejects.toThrow('万象抠图结果宽高比与裁剪图不一致');
  });

  it.each([
    ['opaque output', [255, 255, 255, 255], '万象抠图结果没有透明背景'],
    ['transparent output', [0, 0, 0, 0], '万象抠图结果没有可见主体']
  ])('rejects %s', async (_name, alphaValues, expectedMessage) => {
    const output = await rgbaPng(alphaValues as number[]);
    const remove = createTencentCiBackgroundRemover(baseOptions, resolveSignedUrl, async () => pngResponse(output));
    await expect(remove(target)).rejects.toThrow(expectedMessage as string);
  });

  it('rejects a JPEG response because it cannot carry alpha', async () => {
    const output = await sharp({ create: { width: 4, height: 4, channels: 3, background: '#eeeeee' } })
      .jpeg()
      .toBuffer();
    const remove = createTencentCiBackgroundRemover(baseOptions, resolveSignedUrl, async () =>
      new Response(output, { headers: { 'content-type': 'image/jpeg' } })
    );
    await expect(remove(target)).rejects.toThrow('万象抠图结果缺少透明通道');
  });

  it.each([
    ['HTTP 404', async () => new Response('failed', { status: 404 }), '万象抠图请求失败（404）'],
    ['empty response', async () => pngResponse(Buffer.alloc(0)), '万象抠图返回空响应'],
    [
      'wrong content type',
      async () => new Response('text', { headers: { 'content-type': 'text/plain' } }),
      '万象抠图没有返回图片'
    ],
    ['invalid image', async () => pngResponse(Buffer.from('not an image')), '万象抠图返回的内容不是有效图片']
  ])('rejects %s', async (_name, fetchImpl, expectedMessage) => {
    const remove = createTencentCiBackgroundRemover(baseOptions, resolveSignedUrl, fetchImpl as FetchLike);
    await expect(remove(target)).rejects.toThrow(expectedMessage as string);
  });

  it('surfaces the 万象 error body when the service is not enabled or authorized', async () => {
    // 万象在权限不足、服务未开通等场景会返回 200 + XML 错误体，这必须被当成失败而不是空图。
    const body = '<?xml version="1.0"?><Error><Code>NoSuchBucket</Code><Message>bucket not found</Message></Error>';
    const remove = createTencentCiBackgroundRemover(baseOptions, resolveSignedUrl, async () =>
      new Response(body, { headers: { 'content-type': 'application/xml' } })
    );
    await expect(remove(target)).rejects.toThrow('NoSuchBucket');
  });

  it('rejects a declared oversized response before reading it', async () => {
    const output = await rgbaPng([0, 120, 255, 255]);
    const remove = createTencentCiBackgroundRemover(
      { ...baseOptions, maxResponseBytes: 100 },
      resolveSignedUrl,
      async () => pngResponse(output, { 'content-length': '101' })
    );
    await expect(remove(target)).rejects.toThrow('万象抠图返回内容过大');
  });

  it('rejects an oversized streamed response without a content-length header', async () => {
    const remove = createTencentCiBackgroundRemover(
      { ...baseOptions, maxResponseBytes: 100 },
      resolveSignedUrl,
      async () => pngResponse(Buffer.alloc(101))
    );
    await expect(remove(target)).rejects.toThrow('万象抠图返回内容过大');
  });

  it('aborts a timed-out request', async () => {
    const fetchImpl: FetchLike = async (_input, init) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')), { once: true });
      });
    const remove = createTencentCiBackgroundRemover({ ...baseOptions, timeoutMs: 10 }, resolveSignedUrl, fetchImpl);
    await expect(remove(target)).rejects.toThrow('万象抠图请求超时');
  });

  it('rejects an invalid target size before spending a billable request', async () => {
    const fetchImpl = vi.fn();
    const remove = createTencentCiBackgroundRemover(baseOptions, resolveSignedUrl, fetchImpl as unknown as FetchLike);
    await expect(remove({ objectKey: 'a.jpg', width: 0, height: 4 })).rejects.toThrow('缺少有效的裁剪图尺寸');
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('limits concurrent 万象 requests', async () => {
    const output = await rgbaPng([0, 120, 255, 255]);
    let active = 0;
    let peak = 0;
    const fetchImpl: FetchLike = async () => {
      active += 1;
      peak = Math.max(peak, active);
      await delay(15);
      active -= 1;
      return pngResponse(output);
    };
    const remove = createTencentCiBackgroundRemover(baseOptions, resolveSignedUrl, fetchImpl);
    await Promise.all([remove(target), remove(target), remove(target)]);
    expect(peak).toBe(1);
  });

  it('retries a 5xx once when retry is enabled and succeeds on the second attempt', async () => {
    const output = await rgbaPng([0, 120, 255, 255]);
    let attempts = 0;
    const fetchImpl: FetchLike = async () => {
      attempts += 1;
      return attempts === 1 ? new Response('busy', { status: 503 }) : pngResponse(output);
    };
    const remove = createTencentCiBackgroundRemover({ ...baseOptions, retry: 1 }, resolveSignedUrl, fetchImpl);
    const result = await remove(target);
    expect(attempts).toBe(2);
    expect((await sharp(result).metadata()).hasAlpha).toBe(true);
  });

  it('does not retry a 4xx because retrying would only be billed again', async () => {
    let attempts = 0;
    const fetchImpl: FetchLike = async () => {
      attempts += 1;
      return new Response('forbidden', { status: 403 });
    };
    const remove = createTencentCiBackgroundRemover({ ...baseOptions, retry: 2 }, resolveSignedUrl, fetchImpl);
    await expect(remove(target)).rejects.toThrow('万象抠图请求失败（403）');
    expect(attempts).toBe(1);
  });

  it('does not retry when the service returns a non-image payload', async () => {
    let attempts = 0;
    const fetchImpl: FetchLike = async () => {
      attempts += 1;
      return new Response('<Error/>', { headers: { 'content-type': 'application/xml' } });
    };
    const remove = createTencentCiBackgroundRemover({ ...baseOptions, retry: 2 }, resolveSignedUrl, fetchImpl);
    await expect(remove(target)).rejects.toThrow('万象抠图没有返回图片');
    expect(attempts).toBe(1);
  });
});
