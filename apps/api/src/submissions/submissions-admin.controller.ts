import { Body, Controller, Get, HttpStatus, Param, Post, Query, Req, UseGuards } from '@nestjs/common';
import type { FastifyRequest } from 'fastify';
import { promoteSubmissionSchema, rejectSubmissionSchema, submissionStatuses } from '@bagcollect/contracts';
import { ApiError } from '../common/api-error.js';
import { parseBody } from '../common/zod.js';
import { AdminGuard, type AdminAuth } from '../admin/admin.guard.js';
import { SubmissionsAdminService } from './submissions-admin.service.js';

function currentAdmin(request: FastifyRequest & { adminAuth?: AdminAuth }): AdminAuth {
  if (!request.adminAuth) {
    throw new ApiError('UNAUTHORIZED', '管理员未登录', HttpStatus.UNAUTHORIZED);
  }
  return request.adminAuth;
}

@Controller('admin/submissions')
@UseGuards(AdminGuard)
export class SubmissionsAdminController {
  constructor(private readonly submissions: SubmissionsAdminService) {}

  @Get()
  list(
    @Query('status') status?: string,
    @Query('process') process?: string,
    @Query('search') search?: string,
    @Query('from') from?: string,
    @Query('to') to?: string,
    @Query('page') rawPage?: string,
    @Query('pageSize') rawPageSize?: string
  ) {
    const statusValue =
      status && (submissionStatuses as readonly string[]).includes(status)
        ? (status as (typeof submissionStatuses)[number])
        : undefined;
    const processValue =
      process === 'READY' || process === 'PROCESSING' || process === 'FAILED' ? process : undefined;
    return this.submissions.list({
      status: statusValue,
      process: processValue,
      search,
      from,
      to,
      page: rawPage ? Number(rawPage) : undefined,
      pageSize: rawPageSize ? Number(rawPageSize) : undefined
    });
  }

  @Post(':id/promote')
  promote(@Req() request: FastifyRequest & { adminAuth?: AdminAuth }, @Param('id') id: string, @Body() body: unknown) {
    return this.submissions.promote(currentAdmin(request).adminId, id, parseBody(promoteSubmissionSchema, body));
  }

  @Post(':id/reject')
  reject(@Req() request: FastifyRequest & { adminAuth?: AdminAuth }, @Param('id') id: string, @Body() body: unknown) {
    return this.submissions.reject(currentAdmin(request).adminId, id, parseBody(rejectSubmissionSchema, body ?? {}));
  }

  @Post(':id/reopen')
  reopen(@Req() request: FastifyRequest & { adminAuth?: AdminAuth }, @Param('id') id: string) {
    return this.submissions.reopen(currentAdmin(request).adminId, id);
  }
}
