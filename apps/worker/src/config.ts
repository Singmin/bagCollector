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
    STORAGE_DRIVER: z.enum(['local', 'cos']).default('local'),
    MATTING_DRIVER: z.enum(['rembg', 'passthrough']).default('rembg'),
    REMBG_URL: z.union([z.literal(''), z.string().url()]).default(''),
    REMBG_MODEL: z.string().min(1).default('birefnet-general-lite'),
    REMBG_TIMEOUT_MS: z.coerce.number().int().min(1_000).max(600_000).default(120_000),
    REMBG_MAX_RESPONSE_BYTES: z.coerce.number().int().min(1_048_576).default(83_886_080),
    REMBG_MAX_CONCURRENCY: z.coerce.number().int().min(1).max(8).default(1),
    LOCAL_STORAGE_PATH: z.string().min(1).default('../../data/local-storage'),
    COS_SECRET_ID: z.string().default(''),
    COS_SECRET_KEY: z.string().default(''),
    COS_BUCKET: z.string().default(''),
    COS_REGION: z.string().default('ap-guangzhou'),
    MAX_IMAGE_PIXELS: z.coerce.number().int().positive().default(60_000_000),
    WORKER_CONCURRENCY: z.coerce.number().int().min(1).max(8).default(2)
  })
  .superRefine((value, context) => {
    if (value.STORAGE_DRIVER === 'cos' && (!value.COS_SECRET_ID || !value.COS_SECRET_KEY || !value.COS_BUCKET)) {
      context.addIssue({ code: z.ZodIssueCode.custom, message: 'COS credentials are required for cos storage' });
    }
    if (value.NODE_ENV === 'production' && value.MATTING_DRIVER === 'passthrough') {
      context.addIssue({ code: z.ZodIssueCode.custom, message: 'MATTING_DRIVER cannot be passthrough in production' });
    }
    if (value.MATTING_DRIVER === 'rembg' && !value.REMBG_URL) {
      context.addIssue({ code: z.ZodIssueCode.custom, message: 'REMBG_URL is required for rembg matting' });
    }
  });

export const config = schema.parse(process.env);
