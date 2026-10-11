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
