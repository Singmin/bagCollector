/**
 * 【已废弃 / DEPRECATED】自托管 rembg + BiRefNet 抠图实现
 * =====================================================================
 * 2026-09-21 起，生产抠图已切换为腾讯云数据万象，实现见 apps/worker/src/matting-tencent-ci.ts，
 * 方案说明见 docs/TENCENT_CI_MATTING.md。
 *
 * 本文件连同下列配套资产一起保留，未删除、也不参与主链路：
 * - infra/rembg-entrypoint.sh、infra/Dockerfile 的 `rembg` stage
 * - infra/docker-compose.yml 中被注释掉的 `rembg` 服务
 * - scripts/run-rembg-local.sh、scripts/warmup-rembg.mjs
 * - scripts/measure-matting-throughput.mjs、scripts/diagnose-matting-perf.mjs、scripts/diagnose-ort-memory.py
 * - docs/OPEN_SOURCE_MATTING.md
 * - package.json 的 `dev:rembg` 与 `warmup:rembg`
 *
 * 保留原因：它记录了 BiRefNet 的推理性能、线程数与常驻内存实测数据，做模型对比时仍有参考价值。
 *
 * 它已经不在主链路上：processor.ts 不再 import 本文件，配置里也没有 rembg 相关开关，
 * 生产与本地开发都不会走到这里。这是一段独立实现，必须显式传入 url 才会工作。
 * 改动抠图行为请改 apps/worker/src/matting-tencent-ci.ts。
 */

import sharp from 'sharp';

export interface MattingOptions {
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

  // 注意：不要改用 extractChannel('alpha') + stats() 来省一次通道统计。
  // 当前 sharp 版本下 extractChannel 不会被 stats() 采纳，仍然返回全部通道，
  // channels[0] 会取到红色通道，导致下面两项校验被静默跳过。
  const statistics = await sharp(input, { limitInputPixels: maxPixels }).stats();
  const alpha = statistics.channels[3];
  if (!alpha || alpha.min >= 255) throw new Error('抠图结果没有透明背景');
  if (alpha.max <= 0) throw new Error('抠图结果没有可见主体');

  return sharp(input, { limitInputPixels: maxPixels }).png({ compressionLevel: 6 }).toBuffer();
}

export function createBackgroundRemover(options: MattingOptions, fetchImpl: FetchLike = fetch) {
  const limiter = new ConcurrencyLimiter(options.maxConcurrency);

  return (input: Buffer) =>
    limiter.run(async () => {
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
