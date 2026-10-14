import { Body, Controller, Get, HttpStatus, Param, Patch, Post, Query, Req, UseGuards } from '@nestjs/common';
import type { FastifyRequest } from 'fastify';
import { userStatuses, updateUserQuotaSchema } from '@bagcollect/contracts';
import { ApiError } from '../common/api-error.js';
import { parseBody } from '../common/zod.js';
import { AdminGuard, type AdminAuth } from '../admin/admin.guard.js';
import { UsersAdminService } from './users-admin.service.js';

function currentAdmin(request: FastifyRequest & { adminAuth?: AdminAuth }): AdminAuth {
  if (!request.adminAuth) {
    throw new ApiError('UNAUTHORIZED', '管理员未登录', HttpStatus.UNAUTHORIZED);
  }
  return request.adminAuth;
}

@Controller('admin/users')
@UseGuards(AdminGuard)
export class UsersAdminController {
  constructor(private readonly users: UsersAdminService) {}

  @Get()
  list(
    @Query('status') status?: string,
    @Query('search') search?: string,
    @Query('page') rawPage?: string,
    @Query('pageSize') rawPageSize?: string,
    @Query('sort') sort?: string,
    @Query('order') order?: string
  ) {
    const statusValue =
      status && (userStatuses as readonly string[]).includes(status)
        ? (status as (typeof userStatuses)[number])
        : undefined;
    const sortValue =
      sort === 'collectibleCount' || sort === 'shelfCount' || sort === 'storageUsedBytes' || sort === 'lastLoginAt'
        ? sort
        : undefined;
    const orderValue = order === 'asc' ? 'asc' : order === 'desc' ? 'desc' : undefined;
    return this.users.list({
      status: statusValue,
      search,
      page: rawPage ? Number(rawPage) : undefined,
      pageSize: rawPageSize ? Number(rawPageSize) : undefined,
      sort: sortValue,
      order: orderValue
    });
  }

  @Get(':id')
  detail(@Param('id') id: string) {
    return this.users.detail(id);
  }

  @Post(':id/suspend')
  suspend(@Req() request: FastifyRequest & { adminAuth?: AdminAuth }, @Param('id') id: string) {
    return this.users.suspend(currentAdmin(request).adminId, id);
  }

  @Post(':id/activate')
  activate(@Req() request: FastifyRequest & { adminAuth?: AdminAuth }, @Param('id') id: string) {
    return this.users.activate(currentAdmin(request).adminId, id);
  }

  @Patch(':id/quota')
  updateQuota(
    @Req() request: FastifyRequest & { adminAuth?: AdminAuth },
    @Param('id') id: string,
    @Body() body: unknown
  ) {
    return this.users.updateQuota(currentAdmin(request).adminId, id, parseBody(updateUserQuotaSchema, body));
  }
}
