import sharp from 'sharp';

export type MattingDriver = 'rembg' | 'passthrough';

export interface MattingOptions {
  driver: MattingDriver;
  url: string;
  model: string;
  timeoutMs: number;
  maxResponseBytes: number;
  maxImagePixels: number;
  maxConcurrency: number;
}

export type FetchLike = (input: string | URL, init?: RequestInit) => Promise<Response>;

class ConcurrencyLimiter {
  private active = 0;
  private readonly waiters: Array<() => void> = [];

  constructor(private readonly limit: number) {}

  async run<T>(task: () => Promise<T>): Promise<T> {
    if (this.active >= this.limit) {
      await new Promise<void>((resolve) => this.waiters.push(resolve));
    }
    this.active += 1;
    try {
      return await task();
    } finally {
      this.active -= 1;
      this.waiters.shift()?.();
    }
  }
}

async function readLimited(response: Response, maxBytes: number) {
  const declaredLength = Number(response.headers.get('content-length') ?? 0);
  if (Number.isFinite(declaredLength) && declaredLength > maxBytes) {
    throw new Error('抠图服务返回内容过大');
  }
  if (!response.body) throw new Error('抠图服务返回空响应');

  const reader = response.body.getReader();
  const chunks: Buffer[] = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel().catch(() => undefined);
      throw new Error('抠图服务返回内容过大');
    }
    chunks.push(Buffer.from(value));
  }
  if (total === 0) throw new Error('抠图服务返回空响应');
  return Buffer.concat(chunks, total);
}

async function normalizeTransparentPng(input: Buffer, expectedWidth: number, expectedHeight: number, maxPixels: number) {
  let metadata: sharp.Metadata;
  try {
    metadata = await sharp(input, { limitInputPixels: maxPixels }).metadata();
  } catch {
    throw new Error('抠图服务返回的内容不是有效图片');
  }
  if (!metadata.width || !metadata.height) throw new Error('抠图服务返回的图片没有有效尺寸');
  if (metadata.width !== expectedWidth || metadata.height !== expectedHeight) {
    throw new Error('抠图结果尺寸与裁剪图不一致');
  }
  if (!metadata.hasAlpha) throw new Error('抠图结果缺少透明通道');

  const statistics = await sharp(input, { limitInputPixels: maxPixels }).stats();
  const alpha = statistics.channels[3];
  if (!alpha || alpha.min >= 255) throw new Error('抠图结果没有透明背景');
  if (alpha.max <= 0) throw new Error('抠图结果没有可见主体');

  return sharp(input, { limitInputPixels: maxPixels }).png({ compressionLevel: 9 }).toBuffer();
}

export function createBackgroundRemover(options: MattingOptions, fetchImpl: FetchLike = fetch) {
  const limiter = new ConcurrencyLimiter(options.maxConcurrency);

  return (input: Buffer) =>
    limiter.run(async () => {
      if (options.driver === 'passthrough') {
        throw new Error('自动抠图未启用，可以保留裁剪图');
      }

      let inputMetadata: sharp.Metadata;
      try {
        inputMetadata = await sharp(input, { limitInputPixels: options.maxImagePixels }).metadata();
      } catch {
        throw new Error('待抠图图片超过像素限制或无法解码');
      }
      if (!inputMetadata.width || !inputMetadata.height) throw new Error('无法读取待抠图图片尺寸');

      const form = new FormData();
      form.append('file', new Blob([Uint8Array.from(input)], { type: 'image/jpeg' }), 'cropped.jpg');
      form.append('model', options.model);

      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), options.timeoutMs);
      try {
        const endpoint = `${options.url.replace(/\/$/, '')}/api/remove`;
        const response = await fetchImpl(endpoint, { method: 'POST', body: form, signal: controller.signal });
        if (!response.ok) throw new Error(`抠图服务请求失败（${response.status}）`);
        const contentType = response.headers.get('content-type')?.toLowerCase() ?? '';
        if (!contentType.startsWith('image/png')) throw new Error('抠图服务没有返回 PNG 图片');
        const body = await readLimited(response, options.maxResponseBytes);
        return await normalizeTransparentPng(
          body,
          inputMetadata.width,
          inputMetadata.height,
          options.maxImagePixels
        );
      } catch (error) {
        if (controller.signal.aborted) throw new Error('抠图服务请求超时');
        throw error;
      } finally {
        clearTimeout(timeout);
      }
    });
}
