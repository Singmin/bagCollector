import { setTimeout as delay } from 'node:timers/promises';
import sharp from 'sharp';
import { describe, expect, it } from 'vitest';
import { createBackgroundRemover, type FetchLike, type MattingOptions } from '../src/matting.js';

const baseOptions: MattingOptions = {
  url: 'http://127.0.0.1:7000/',
  model: 'birefnet-general-lite',
  timeoutMs: 1_000,
  maxResponseBytes: 1_000_000,
  maxImagePixels: 1_000_000,
  maxConcurrency: 1
};

async function jpeg(width = 2, height = 2) {
  return sharp({
    create: { width, height, channels: 3, background: { r: 240, g: 240, b: 240 } }
  })
    .jpeg()
    .toBuffer();
}

async function rgbaPng(alphaValues: number[], width = 2, height = 2) {
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

describe('rembg background remover', () => {
  it('submits the configured model and normalizes a transparent PNG', async () => {
    const output = await rgbaPng([0, 120, 255, 255]);
    const fetchImpl: FetchLike = async (input, init) => {
      expect(String(input)).toBe('http://127.0.0.1:7000/api/remove');
      expect(init?.method).toBe('POST');
      expect(init?.body).toBeInstanceOf(FormData);
      const form = init?.body as FormData;
      expect(form.get('model')).toBe('birefnet-general-lite');
      expect(form.get('file')).toBeInstanceOf(Blob);
      return pngResponse(output);
    };

    const result = await createBackgroundRemover(baseOptions, fetchImpl)(await jpeg());
    const metadata = await sharp(result).metadata();
    expect(metadata.format).toBe('png');
    expect(metadata.hasAlpha).toBe(true);
    expect([metadata.width, metadata.height]).toEqual([2, 2]);
  });

  it.each([
    ['opaque output', [255, 255, 255, 255], '抠图结果没有透明背景'],
    ['transparent output', [0, 0, 0, 0], '抠图结果没有可见主体']
  ])('rejects %s', async (_name, alphaValues, expectedMessage) => {
    const output = await rgbaPng(alphaValues as number[]);
    const remove = createBackgroundRemover(baseOptions, async () => pngResponse(output));
    await expect(remove(await jpeg())).rejects.toThrow(expectedMessage as string);
  });

  it('rejects an output with different dimensions', async () => {
    const output = await rgbaPng([0, 255, 255, 255], 3, 2);
    const remove = createBackgroundRemover(baseOptions, async () => pngResponse(output));
    await expect(remove(await jpeg())).rejects.toThrow('抠图结果尺寸与裁剪图不一致');
  });

  it.each([
    ['HTTP failure', async () => new Response('failed', { status: 500 }), '抠图服务请求失败（500）'],
    ['empty response', async () => pngResponse(Buffer.alloc(0)), '抠图服务返回空响应'],
    ['wrong content type', async () => new Response('text', { headers: { 'content-type': 'text/plain' } }), '抠图服务没有返回 PNG 图片'],
    ['invalid image', async () => pngResponse(Buffer.from('not an image')), '抠图服务返回的内容不是有效图片']
  ])('rejects %s', async (_name, fetchImpl, expectedMessage) => {
    const remove = createBackgroundRemover(baseOptions, fetchImpl as FetchLike);
    await expect(remove(await jpeg())).rejects.toThrow(expectedMessage as string);
  });

  it('rejects a declared oversized response before reading it', async () => {
    const output = await rgbaPng([0, 120, 255, 255]);
    const remove = createBackgroundRemover(
      { ...baseOptions, maxResponseBytes: 100 },
      async () => pngResponse(output, { 'content-length': '101' })
    );
    await expect(remove(await jpeg())).rejects.toThrow('抠图服务返回内容过大');
  });

  it('rejects an oversized streamed response without a content-length header', async () => {
    const remove = createBackgroundRemover(
      { ...baseOptions, maxResponseBytes: 100 },
      async () => pngResponse(Buffer.alloc(101))
    );
    await expect(remove(await jpeg())).rejects.toThrow('抠图服务返回内容过大');
  });

  it('rejects an input that exceeds the configured pixel limit', async () => {
    const remove = createBackgroundRemover({ ...baseOptions, maxImagePixels: 3 }, async () => {
      throw new Error('fetch should not be called');
    });
    await expect(remove(await jpeg(2, 2))).rejects.toThrow('待抠图图片超过像素限制或无法解码');
  });

  it('aborts a timed-out request', async () => {
    const fetchImpl: FetchLike = async (_input, init) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')), { once: true });
      });
    const remove = createBackgroundRemover({ ...baseOptions, timeoutMs: 10 }, fetchImpl);
    await expect(remove(await jpeg())).rejects.toThrow('抠图服务请求超时');
  });

  it('limits concurrent model requests', async () => {
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
    const remove = createBackgroundRemover(baseOptions, fetchImpl);
    const input = await jpeg();
    await Promise.all([remove(input), remove(input), remove(input)]);
    expect(peak).toBe(1);
  });
});
