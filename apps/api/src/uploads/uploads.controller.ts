import { Body, Controller, HttpStatus, Param, Post, Req, UseGuards } from '@nestjs/common';
import type { FastifyRequest } from 'fastify';
import { uploadCompleteSchema, uploadPolicySchema } from '@bagcollect/contracts';
import { AuthGuard } from '../auth/auth.guard.js';
import { CurrentUser, type AuthUser } from '../common/current-user.js';
import { ApiError } from '../common/api-error.js';
import { parseBody } from '../common/zod.js';
import { UploadsService } from './uploads.service.js';

@Controller('uploads')
@UseGuards(AuthGuard)
export class UploadsController {
  constructor(private readonly uploads: UploadsService) {}

  @Post('policy')
  policy(@CurrentUser() user: AuthUser, @Body() body: unknown) {
    return this.uploads.policy(user.userId, parseBody(uploadPolicySchema, body));
  }

  @Post('complete')
  complete(@CurrentUser() user: AuthUser, @Body() body: unknown) {
    return this.uploads.complete(user.userId, parseBody(uploadCompleteSchema, body));
  }

  @Post('local/:assetId')
  async localUpload(
    @CurrentUser() user: AuthUser,
    @Param('assetId') assetId: string,
    @Req() request: FastifyRequest
  ) {
    const file = await request.file();
    if (!file) throw new ApiError('UPLOAD_INVALID', '没有收到图片文件', HttpStatus.BAD_REQUEST);
    const body = await file.toBuffer();
    return this.uploads.localUpload(user.userId, assetId, body, file.mimetype);
  }
}
