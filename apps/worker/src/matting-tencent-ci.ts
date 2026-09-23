/**
 * 腾讯云数据万象抠图（生产使用的抠图实现）
 * =====================================================================
 * 使用「下载时处理」方式调用万象抠图接口：把 `ci-process=AIPicMatting`（当前默认，接口名由
 * `CI_MATTING_PROCESS` 配置）与签名一起
 * 拼进裁剪图的 COS 私有读 URL，万象在返回响应体时执行抠图，直接回传带透明通道的 PNG。
 *
 * 为什么选「下载时处理」而不是另外两种方式：
 * - 「上传时处理」（Pic-Operations 头）只作用于刚 PUT 上去的原图，而我们要抠的是用户
 *   裁剪之后的图，时机对不上。
 * - 「云上数据处理」（POST ?image_process）会把结果另存成 COS 对象，Worker 还得再下载一次，
 *   多一次往返和一次需清理的中间对象，没有收益。
 *
 * 与自托管推理服务（apps/worker/src/matting.ts，已不在主链路中使用，文件保留未删除）的差异：
 * - 万象按原图分辨率抠图，没有模型输入边长限制，因此不需要降采样送推理再回放大的两步操作。
 * - 图片会离开自己的服务器，因此该实现改变了原有的隐私边界，详见 docs/TENCENT_CI_MATTING.md。
 * - 按调用次数计费，因此重试次数必须克制（每次重试都会重新计费）。
 *
 * 两者互不牵连：本文件不引用 matting.ts 里的任何工具函数，matting.ts 也不是本实现的替代路径。
 */

import sharp from 'sharp';

export type TencentCiMattingProcess = 'GoodsMatting' | 'AIPicMatting';

export interface TencentCiMattingOptions {
  /** 万象抠图接口名。 */
  process: TencentCiMattingProcess;
  /** 单次请求超时（毫秒）。 */
  timeoutMs: number;
  /** 允许读取的响应体上限（字节），防止异常服务耗尽 Worker 内存。 */
  maxResponseBytes: number;
  /** 解码像素上限，防御超大图。 */
  maxImagePixels: number;
  /** 同时进行的抠图请求数上限。 */
  maxConcurrency: number;
  /** 返回尺寸与裁剪图不一致时的处理策略。 */
  sizeMode: 'strict' | 'rescale';
  /** 可重试失败的额外尝试次数。0 表示不重试。 */
  retry: number;
}

/** 待抠图的目标：对象 Key + 期望的裁剪图尺寸。 */
export interface MattingTarget {
  objectKey: string;
  width: number;
  height: number;
}

export type FetchLike = (input: string | URL, init?: RequestInit) => Promise<Response>;

/** 把查询参数签进 COS 私有读 URL。由调用方注入，便于测试时替换。 */
export type SignedUrlResolver = (objectKey: string, query: Record<string, string>) => string;

/**
 * 抠图失败。`retryable` 决定这次失败是否值得重试：
 * 超时、5xx、429 和网络中断值得重试；4xx、返回内容非法、透明通道缺失不值得——
 * 重试只会再付一次费，结果不会变。
 */
class TencentCiMattingError extends Error {
  constructor(message: string, readonly retryable = false) {
    super(message);
    this.name = 'TencentCiMattingError';
  }
}

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
    throw new TencentCiMattingError('万象抠图返回内容过大');
  }
  if (!response.body) throw new TencentCiMattingError('万象抠图返回空响应');

  const reader = response.body.getReader();
  const chunks: Buffer[] = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel().catch(() => undefined);
      throw new TencentCiMattingError('万象抠图返回内容过大');
    }
    chunks.push(Buffer.from(value));
  }
  if (total === 0) throw new TencentCiMattingError('万象抠图返回空响应');
  return Buffer.concat(chunks, total);
}

/** 把万象返回的图片规范成与裁剪图严格对位、且确实带透明区域的 PNG。 */
async function normalizeTransparentPng(input: Buffer, target: MattingTarget, options: TencentCiMattingOptions) {
  let metadata: sharp.Metadata;
  try {
    metadata = await sharp(input, { limitInputPixels: options.maxImagePixels }).metadata();
  } catch {
    throw new TencentCiMattingError('万象抠图返回的内容不是有效图片');
  }
  if (!metadata.width || !metadata.height || !metadata.channels) {
    throw new TencentCiMattingError('万象抠图返回的图片没有有效尺寸');
  }
  if (!metadata.hasAlpha) throw new TencentCiMattingError('万象抠图结果缺少透明通道');

  const sameSize = metadata.width === target.width && metadata.height === target.height;
  if (!sameSize) {
    const detail = `${metadata.width}x${metadata.height} ≠ ${target.width}x${target.height}`;
    if (options.sizeMode === 'strict') {
      throw new TencentCiMattingError(`万象抠图结果尺寸与裁剪图不一致（${detail}）`);
    }
    // 宽高比一致说明只是画布被整体缩放，缩放回来就能与裁剪图逐像素对位。
    // 宽高比不一致必然意味着主体位置发生偏移，缩放只会产出错图，直接失败更安全。
    const expectedRatio = target.width / target.height;
    const actualRatio = metadata.width / metadata.height;
    if (Math.abs(expectedRatio - actualRatio) > 0.01) {
      throw new TencentCiMattingError(`万象抠图结果宽高比与裁剪图不一致（${detail}）`);
    }
    console.warn(
      JSON.stringify({ event: 'matting_tencent_ci_rescaled', from: detail, sizeMode: options.sizeMode })
    );
  }

  // 注意：不要改用 extractChannel('alpha') + stats() 来省一次通道统计。
  // 当前 sharp 版本下 extractChannel 不会被 stats() 采纳，仍然返回全部通道，
  // 会导致下面的校验被静默跳过。
  const statistics = await sharp(input, { limitInputPixels: options.maxImagePixels }).stats();
  const alpha = statistics.channels[metadata.channels - 1];
  if (!alpha || alpha.min >= 255) throw new TencentCiMattingError('万象抠图结果没有透明背景');
  if (alpha.max <= 0) throw new TencentCiMattingError('万象抠图结果没有可见主体');

  const output = sharp(input, { limitInputPixels: options.maxImagePixels });
  if (!sameSize) output.resize({ width: target.width, height: target.height, fit: 'fill' });
  return output.png({ compressionLevel: 6 }).toBuffer();
}

/**
 * 创建基于数据万象的背景移除函数。
 *
 * @param resolveSignedUrl 把 `ci-process` 等查询参数签进 COS URL 的函数
 * @param fetchImpl 便于测试注入的 fetch
 */
export function createTencentCiBackgroundRemover(
  options: TencentCiMattingOptions,
  resolveSignedUrl: SignedUrlResolver,
  fetchImpl: FetchLike = fetch
) {
  const limiter = new ConcurrencyLimiter(options.maxConcurrency);

  async function requestOnce(target: MattingTarget) {
    if (!Number.isInteger(target.width) || !Number.isInteger(target.height) || target.width <= 0 || target.height <= 0) {
      throw new TencentCiMattingError('缺少有效的裁剪图尺寸，无法校验抠图结果');
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), options.timeoutMs);
    try {
      // 显式带上 center-layout=0：让万象保持原画布、只把背景透明化，
      // 这样输出才能与裁剪图逐像素对位。默认值虽然是 0，但这里写死避免以后被改默认值影响。
      const url = resolveSignedUrl(target.objectKey, {
        'ci-process': options.process,
        'center-layout': '0'
      });
      const response = await fetchImpl(url, { method: 'GET', signal: controller.signal, redirect: 'follow' });
      if (!response.ok) {
        throw new TencentCiMattingError(
          `万象抠图请求失败（${response.status}）`,
          response.status >= 500 || response.status === 429
        );
      }
      const contentType = response.headers.get('content-type')?.toLowerCase() ?? '';
      if (!contentType.startsWith('image/')) {
        // 万象在权限不足、服务未开通、对象不存在等情况下会返回 200 + XML/JSON 错误体，
        // 而不是非 2xx 状态码，因此内容类型必须当成一道独立的闸门。
        const detail = await response
          .text()
          .then((text) => text.replace(/\s+/g, ' ').trim().slice(0, 200))
          .catch(() => '');
        throw new TencentCiMattingError(`万象抠图没有返回图片${detail ? `：${detail}` : ''}`);
      }
      const body = await readLimited(response, options.maxResponseBytes);
      return await normalizeTransparentPng(body, target, options);
    } catch (error) {
      if (controller.signal.aborted) throw new TencentCiMattingError('万象抠图请求超时', true);
      // fetch 自身抛错（连接被重置、DNS 失败等）没有包装成 TencentCiMattingError，统一按可重试处理。
      if (error instanceof TencentCiMattingError) throw error;
      throw new TencentCiMattingError(`万象抠图请求异常：${error instanceof Error ? error.message : '未知错误'}`, true);
    } finally {
      clearTimeout(timeout);
    }
  }

  return (target: MattingTarget) =>
    limiter.run(async () => {
      let lastError: unknown;
      for (let attempt = 0; attempt <= options.retry; attempt += 1) {
        try {
          return await requestOnce(target);
        } catch (error) {
          lastError = error;
          const retryable = error instanceof TencentCiMattingError && error.retryable;
          if (!retryable || attempt === options.retry) throw error;
          console.warn(
            JSON.stringify({
              event: 'matting_tencent_ci_retry',
              attempt: attempt + 1,
              objectKey: target.objectKey,
              error: error instanceof Error ? error.message : String(error)
            })
          );
        }
      }
      throw lastError;
    });
}
