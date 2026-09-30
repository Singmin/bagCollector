import { resolve } from 'node:path';
import { loadEnvFile } from 'node:process';
import { z } from 'zod';

if (!process.env.DATABASE_URL) {
  try {
    loadEnvFile(resolve(process.cwd(), '../../.env'));
  } catch {
    // CI and production inject environment variables directly.
  }
}

const schema = z
  .object({
    NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
    DATABASE_URL: z.string().min(1),
    REDIS_URL: z.string().url(),
    STORAGE_DRIVER: z.enum(['local', 'cos']).default('cos'),

    // ---------------------------------------------------------------------
    // 腾讯云数据万象抠图（Worker 唯一的抠图实现）
    // ---------------------------------------------------------------------
    // 万象的抠图接口名。AIPicMatting=通用抠图（0.02 元/次），GoodsMatting=商品抠图（0.01 元/次）。
    // 两者请求方式与响应格式一致，只有计费和主体识别策略不同，可随时切换。
    // 默认取通用抠图：真实输入是用户随手拍、手工裁剪的照片，背景常有桌面/床铺/地板，
    // 通用抠图对杂乱背景宽容得多（见 docs/TENCENT_CI_MATTING.md 第 7.2 节 A/B 实测）。
    // 代价是单价翻倍，且细结构（细绳、细带）可能被侵蚀，因此 MAX_DAILY_MATTING 同步减半。
    CI_MATTING_PROCESS: z.enum(['GoodsMatting', 'AIPicMatting']).default('AIPicMatting'),
    CI_MATTING_TIMEOUT_MS: z.coerce.number().int().min(1_000).max(600_000).default(60_000),
    CI_MATTING_MAX_RESPONSE_BYTES: z.coerce.number().int().min(1_048_576).default(83_886_080),
    // 万象是远端付费接口，不是本机进程，可以放开并发。默认 4 足以打满单张的等待时间。
    CI_MATTING_MAX_CONCURRENCY: z.coerce.number().int().min(1).max(16).default(4),
    // 签名 URL 有效期。只需要覆盖「发起请求到读完全部响应」这段时间。
    CI_MATTING_SIGN_EXPIRES_SECONDS: z.coerce.number().int().min(60).max(3_600).default(600),
    // 可重试失败的额外尝试次数（超时、5xx、429、网络中断）。默认 1，即最多请求 2 次。
    // 注意：每次重试都会重新计费，因此不要设得过大。
    CI_MATTING_RETRY: z.coerce.number().int().min(0).max(3).default(1),
    // 万象返回画布与裁剪图尺寸不一致时的处理方式：
    // strict  = 直接判失败，用于确认接口是否 1:1 返回原画布；
    // rescale = 宽高比一致时把结果缩放到裁剪图尺寸，宽高比不一致仍然判失败，
    //           避免主体错位后静默产出错图。
    CI_MATTING_SIZE_MODE: z.enum(['strict', 'rescale']).default('rescale'),

    // ---------------------------------------------------------------------
    // 卡死任务对账：processStatus 长时间停在 PROCESSING/NORMALIZING/MATTING
    // 说明任务没有被消费（worker 宕机、任务丢失或 stalled 后 attempts 已耗尽），
    // 定时把这类记录翻成 FAILED，让管理后台/用户能看到失败原因并手动重试，
    // 而不是永远「处理中」。队列积压时任务可能合法地排队更久，
    // 所以阈值要明显大于单张图的正常处理时长。
    // ---------------------------------------------------------------------
    RECONCILE_INTERVAL_MS: z.coerce.number().int().min(10_000).default(60_000),
    STUCK_PROCESSING_MS: z.coerce.number().int().min(60_000).default(900_000),

    LOCAL_STORAGE_PATH: z.string().min(1).default('../../data/local-storage'),
    COS_SECRET_ID: z.string().default(''),
    COS_SECRET_KEY: z.string().default(''),
    COS_BUCKET: z.string().default(''),
    COS_REGION: z.string().default('ap-guangzhou'),
    MAX_IMAGE_PIXELS: z.coerce.number().int().positive().default(60_000_000),
    WORKER_CONCURRENCY: z.coerce.number().int().min(1).max(8).default(2)
  })
  .superRefine((value, context) => {
    // 抠图是 Worker 唯一的产出路径，而万象只能读 COS 上的对象。
    // 用 local 存储时裁剪图写在磁盘上，万象拿不到它，所以这里在启动阶段就拦下来，
    // 而不是等第一张图处理到一半才失败。
    if (value.STORAGE_DRIVER !== 'cos') {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Worker 的抠图走腾讯云数据万象，要求 STORAGE_DRIVER=cos：万象只能读取 COS 上的对象，本地磁盘文件它拿不到'
      });
    }

    if (!value.COS_SECRET_ID || !value.COS_SECRET_KEY || !value.COS_BUCKET || !value.COS_REGION) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: '数据万象抠图需要 COS_SECRET_ID、COS_SECRET_KEY、COS_BUCKET 与 COS_REGION'
      });
    }
  });

export const config = schema.parse(process.env);
