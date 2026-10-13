import { randomUUID } from 'node:crypto';
import {
  Body,
  Controller,
  Delete,
  Get,
  HttpStatus,
  Param,
  Patch,
  Post,
  Query,
  Req,
  UseGuards
} from '@nestjs/common';
import type { FastifyRequest } from 'fastify';
import {
  createPlanItemSchema,
  createReleaseCommentSchema,
  createReleaseSchema,
  updatePlanItemSchema,
  updateReleaseSchema,
  type ReleaseNoteStatus
} from '@bagcollect/contracts';
import { AdminGuard, type AdminAuth } from '../admin/admin.guard.js';
import { ApiError } from '../common/api-error.js';
import { parseBody } from '../common/zod.js';
import { CosService } from '../assets/cos.service.js';
import { ChangelogDocsService } from './changelog-docs.service.js';
import { ReleasesService } from './releases.service.js';

function currentAdmin(request: FastifyRequest & { adminAuth?: AdminAuth }): AdminAuth {
  if (!request.adminAuth) {
    throw new ApiError('UNAUTHORIZED', '管理员未登录', HttpStatus.UNAUTHORIZED);
  }
  return request.adminAuth;
}

/** 管理端：版本改动记录 + 留言。 */
@Controller('admin/releases')
@UseGuards(AdminGuard)
export class ReleasesController {
  constructor(private readonly releases: ReleasesService) {}

  @Get()
  list(
    @Query('status') status?: ReleaseNoteStatus,
    @Query('page') rawPage?: string,
    @Query('pageSize') rawPageSize?: string
  ) {
    return this.releases.listReleases({
      status,
      page: rawPage ? Number(rawPage) : undefined,
      pageSize: rawPageSize ? Number(rawPageSize) : undefined
    });
  }

  @Post()
  create(@Req() request: FastifyRequest & { adminAuth?: AdminAuth }, @Body() body: unknown) {
    return this.releases.createRelease(currentAdmin(request).adminId, parseBody(createReleaseSchema, body));
  }

  @Patch(':id')
  update(@Param('id') id: string, @Body() body: unknown) {
    return this.releases.updateRelease(id, parseBody(updateReleaseSchema, body));
  }

  @Delete(':id')
  remove(@Param('id') id: string) {
    return this.releases.deleteRelease(id);
  }

  @Get(':id/comments')
  comments(@Param('id') id: string) {
    return this.releases.listComments(id);
  }

  @Post(':id/comments')
  addComment(
    @Req() request: FastifyRequest & { adminAuth?: AdminAuth },
    @Param('id') id: string,
    @Body() body: unknown
  ) {
    return this.releases.createComment(id, currentAdmin(request).adminId, parseBody(createReleaseCommentSchema, body));
  }

  @Delete(':id/comments/:commentId')
  removeComment(@Param('id') id: string, @Param('commentId') commentId: string) {
    return this.releases.deleteComment(id, commentId);
  }
}

/** 管理端：仓库 docs/ 下的改动记录文档，自动与 md 文件同步，无需手工录入。 */
@Controller('admin/changelog-docs')
@UseGuards(AdminGuard)
export class ChangelogDocsController {
  constructor(private readonly docs: ChangelogDocsService) {}

  @Get()
  list() {
    return this.docs.list();
  }
}

/** 管理端：下期改动计划。 */
@Controller('admin/plans')
@UseGuards(AdminGuard)
export class PlansController {
  constructor(private readonly releases: ReleasesService) {}

  @Get()
  list() {
    return this.releases.listPlans();
  }

  @Post()
  create(@Req() request: FastifyRequest & { adminAuth?: AdminAuth }, @Body() body: unknown) {
    return this.releases.createPlan(currentAdmin(request).adminId, parseBody(createPlanItemSchema, body));
  }

  @Patch(':id')
  update(@Param('id') id: string, @Body() body: unknown) {
    return this.releases.updatePlan(id, parseBody(updatePlanItemSchema, body));
  }

  @Delete(':id')
  remove(@Param('id') id: string) {
    return this.releases.deletePlan(id);
  }
}

/** 版本记录正文插图：≤10MB，格式按 MIME 白名单映射扩展名。 */
const RELEASE_IMAGE_EXT: Record<string, string> = {
  'image/jpeg': '.jpg',
  'image/png': '.png',
  'image/webp': '.webp',
  'image/gif': '.gif'
};
const RELEASE_IMAGE_MAX_BYTES = 10 * 1024 * 1024;

/** 管理端：版本记录正文的插图上传，服务端直写 COS/本地后返回可访问 URL。 */
@Controller('admin/release-images')
@UseGuards(AdminGuard)
export class ReleaseImagesController {
  constructor(private readonly cos: CosService) {}

  @Post()
  async upload(@Req() request: FastifyRequest & { adminAuth?: AdminAuth }) {
    const file = await request.file();
    if (!file) throw new ApiError('UPLOAD_INVALID', '没有收到图片', HttpStatus.BAD_REQUEST);
    const ext = RELEASE_IMAGE_EXT[file.mimetype];
    if (!ext) throw new ApiError('UPLOAD_INVALID', '仅支持 jpg/png/webp/gif 图片', HttpStatus.BAD_REQUEST);
    const body = await file.toBuffer();
    if (body.length > RELEASE_IMAGE_MAX_BYTES) {
      throw new ApiError('UPLOAD_INVALID', '图片不能超过 10MB', HttpStatus.BAD_REQUEST);
    }
    const now = new Date();
    const key = `release-notes/${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, '0')}/${randomUUID()}/v1${ext}`;
    await this.cos.putObject(key, body, file.mimetype);
    /* public 模式（生产）返回 CDN 永久直链，正文里存的 URL 长期有效；
       代理模式下 signedUrl 是带 token 的链接，这里给 30 天有效期，够后台自查用 */
    return { url: await this.cos.signedUrl(key, 30 * 24 * 3600) };
  }
}
