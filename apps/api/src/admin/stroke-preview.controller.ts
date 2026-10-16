import { Body, Controller, Get, HttpStatus, Post, Put, Query, Req, UseGuards } from '@nestjs/common';
import type { FastifyRequest } from 'fastify';
import { DEFAULT_STROKE_PARAMS, strokeParamsSchema, type StrokeParams } from '@bagcollect/stroke';
import { z } from 'zod';
import { ApiError } from '../common/api-error.js';
import { parseBody } from '../common/zod.js';
import { AdminGuard, type AdminAuth } from './admin.guard.js';
import { StrokePreviewService } from './stroke-preview.service.js';

/** 预览参数走 query 传（与官方袋子图片上传同理，避免 multipart 字段顺序不确定性）。 */
const strokeQuerySchema = z.object({
  ratio: z.coerce.number().min(0).max(0.3).default(DEFAULT_STROKE_PARAMS.ratio),
  baseFrequency: z.coerce.number().min(0.005).max(0.2).default(DEFAULT_STROKE_PARAMS.baseFrequency),
  wobble: z.coerce.number().min(0).max(1).default(DEFAULT_STROKE_PARAMS.wobble),
  soften: z.coerce.number().min(0).max(1).default(0),
  down: z.coerce.number().int().min(1).max(8).default(DEFAULT_STROKE_PARAMS.down)
});

function fromQuery(query: Record<string, unknown>): StrokeParams {
  const raw = strokeQuerySchema.parse(query);
  return {
    ratio: raw.ratio,
    baseFrequency: raw.baseFrequency,
    wobble: raw.wobble,
    soften: raw.soften === 1,
    down: raw.down
  };
}

function currentAdmin(request: FastifyRequest & { adminAuth?: AdminAuth }): AdminAuth {
  if (!request.adminAuth) throw new ApiError('UNAUTHORIZED', '管理员未登录', HttpStatus.UNAUTHORIZED);
  return request.adminAuth;
}

@Controller('admin')
export class StrokePreviewController {
  constructor(private readonly service: StrokePreviewService) {}

  @Get('stroke-settings')
  @UseGuards(AdminGuard)
  settings() {
    return this.service.settings();
  }

  @Put('stroke-settings')
  @UseGuards(AdminGuard)
  updateSettings(@Req() request: FastifyRequest & { adminAuth?: AdminAuth }, @Body() body: unknown) {
    return this.service.updateSettings(currentAdmin(request).adminId, parseBody(strokeParamsSchema, body));
  }

  @Post('stroke-preview')
  @UseGuards(AdminGuard)
  async preview(@Req() request: FastifyRequest & { adminAuth?: AdminAuth }, @Query() query: Record<string, unknown>) {
    const file = await request.file();
    if (!file) throw new ApiError('UPLOAD_INVALID', '没有收到图片文件', HttpStatus.BAD_REQUEST);
    const body = await file.toBuffer();
    return this.service.preview(body, fromQuery(query));
  }
}
