import { HttpStatus } from '@nestjs/common';
import type { ZodType } from 'zod';
import { ApiError } from './api-error.js';

export function parseBody<T>(schema: ZodType<T>, value: unknown): T {
  const result = schema.safeParse(value);
  if (!result.success) {
    throw new ApiError('VALIDATION_FAILED', '请求参数不正确', HttpStatus.BAD_REQUEST, result.error.flatten());
  }
  return result.data;
}
