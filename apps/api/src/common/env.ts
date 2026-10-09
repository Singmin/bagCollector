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

const booleanFromString = z
  .enum(['true', 'false'])
  .default('false')
  .transform((value) => value === 'true');

const schema = z
  .object({
    NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
    API_PORT: z.coerce.number().int().positive().default(3001),
    API_PUBLIC_URL: z.string().url().default('http://localhost:3001'),
    /* 图片对外的 URL 形态：
       proxy（默认）= API 域名代理（/api/assets/file?token=...），桶可保持私有读，
                      但每张图都要 API 服务器中转 COS 一跳，小程序端还必须走
                      downloadFile 限流队列（真机实测整页出图 9s 的主因）；
       public       = 桶开放公有读，图片直接用 COS/CDN 域名（COS_PUBLIC_HOST）。
                      URL 无签名且永不变化（key 自带 v{n} 版本），<image>/CDN/浏览器
                      缓存长期命中；小程序拿到 https 直链后由 <image> 渲染层并发加载，
                      不再进 downloadFile 队列。切法见 docs/IMAGE_PIPELINE.md「CDN 直连」。 */
    ASSET_URL_MODE: z.enum(['proxy', 'public']).default('proxy'),
    STORAGE_DRIVER: z.enum(['local', 'cos']).default('local'),
    LOCAL_STORAGE_PATH: z.string().min(1).default('../../data/local-storage'),
    DATABASE_URL: z.string().min(1),
    REDIS_URL: z.string().url(),
    JWT_SECRET: z.string().min(32),
    ACCESS_TOKEN_TTL: z.string().default('2h'),
    REFRESH_TOKEN_DAYS: z.coerce.number().int().min(1).max(365).default(30),
    WECHAT_APP_ID: z.string().default(''),
    WECHAT_APP_SECRET: z.string().default(''),
    WECHAT_AUTH_MOCK: booleanFromString,
    COS_SECRET_ID: z.string().default(''),
    COS_SECRET_KEY: z.string().default(''),
    COS_BUCKET: z.string().default(''),
    COS_REGION: z.string().default('ap-guangzhou'),
    COS_PUBLIC_HOST: z.string().default(''),
    COS_STS_DURATION_SECONDS: z.coerce.number().int().min(300).max(3600).default(600),
    MAX_COLLECTIBLES_PER_USER: z.coerce.number().int().positive().default(9999),
    MAX_STORAGE_BYTES: z.coerce.number().int().positive().default(5_368_709_120),
    // 抠图用通用抠图（0.02 元/次），配额定为 25 是为了让单用户成本天花板维持 0.50 元/天
    // （此前商品抠图 0.01 元/次 × 50 次）。注意：这个值只在首次登录建档时写入 User.dailyMattingQuota，
    // 改动默认值不会影响已注册用户，存量数据需要单独回填。
    MAX_DAILY_MATTING: z.coerce.number().int().positive().default(25),
    MAX_UPLOAD_BYTES: z.coerce.number().int().positive().default(31_457_280),
    MAX_IMAGE_PIXELS: z.coerce.number().int().positive().default(60_000_000),

    // ---------------------------------------------------------------------
    // 「拍照扫描袋子」的判定阈值（余弦相似度）
    //
    //   ≥ BAG_MATCH_AUTO_THRESHOLD        认定为同一只袋子，前端零操作直接入库
    //   ≥ BAG_MATCH_CANDIDATE_THRESHOLD   交给用户从候选里点选
    //   低于候选阈值                       视为官方库没有这只袋子，引导走手动上传
    //
    // 这两个值是经验值，必须拿真实数据调。匹配接口会把 top 候选的分数一并返回，
    // 便于观察实际分布后再收紧或放宽 —— 阈值定得太松会把不相干的袋子自动塞进
    // 用户收藏，比多点一下难受得多。
    // ---------------------------------------------------------------------
    BAG_MATCH_AUTO_THRESHOLD: z.coerce.number().min(0).max(1).default(0.9),
    BAG_MATCH_CANDIDATE_THRESHOLD: z.coerce.number().min(0).max(1).default(0.72),
    BAG_MATCH_CANDIDATE_LIMIT: z.coerce.number().int().min(1).max(10).default(3)
  })
  .superRefine((value, context) => {
    if (!value.WECHAT_AUTH_MOCK && (!value.WECHAT_APP_ID || !value.WECHAT_APP_SECRET)) {
      context.addIssue({ code: z.ZodIssueCode.custom, message: 'WECHAT_APP_ID and WECHAT_APP_SECRET are required' });
    }
    if (value.NODE_ENV === 'production' && value.STORAGE_DRIVER !== 'cos') {
      context.addIssue({ code: z.ZodIssueCode.custom, message: 'STORAGE_DRIVER must be cos in production' });
    }
    if (value.STORAGE_DRIVER === 'cos' && (!value.COS_SECRET_ID || !value.COS_SECRET_KEY || !value.COS_BUCKET)) {
      context.addIssue({ code: z.ZodIssueCode.custom, message: 'COS credentials are required in production' });
    }
  });

export type Env = z.infer<typeof schema>;

let cached: Env | undefined;

export function env() {
  cached ??= schema.parse(process.env);
  return cached;
}
