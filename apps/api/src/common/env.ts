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
    MAX_COLLECTIBLES_PER_USER: z.coerce.number().int().positive().default(500),
    MAX_STORAGE_BYTES: z.coerce.number().int().positive().default(5_368_709_120),
    // 抠图用通用抠图（0.02 元/次），配额定为 25 是为了让单用户成本天花板维持 0.50 元/天
    // （此前商品抠图 0.01 元/次 × 50 次）。注意：这个值只在首次登录建档时写入 User.dailyMattingQuota，
    // 改动默认值不会影响已注册用户，存量数据需要单独回填。
    MAX_DAILY_MATTING: z.coerce.number().int().positive().default(25),
    MAX_UPLOAD_BYTES: z.coerce.number().int().positive().default(31_457_280),
    MAX_IMAGE_PIXELS: z.coerce.number().int().positive().default(60_000_000)
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
