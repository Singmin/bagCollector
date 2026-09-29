import { Body, Controller, Delete, Get, HttpStatus, Param, Patch, Post, Req, UseGuards } from '@nestjs/common';
import type { FastifyRequest } from 'fastify';
import { createBrandSchema, updateBrandSchema } from '@bagcollect/contracts';
import { ApiError } from '../common/api-error.js';
import { parseBody } from '../common/zod.js';
import { AdminGuard, type AdminAuth } from '../admin/admin.guard.js';
import { BrandsAdminService } from './brands-admin.service.js';

function currentAdmin(request: FastifyRequest & { adminAuth?: AdminAuth }): AdminAuth {
  if (!request.adminAuth) {
    throw new ApiError('UNAUTHORIZED', '管理员未登录', HttpStatus.UNAUTHORIZED);
  }
  return request.adminAuth;
}

@Controller('admin/brands')
@UseGuards(AdminGuard)
export class BrandsAdminController {
  constructor(private readonly brands: BrandsAdminService) {}

  @Get()
  list() {
    return this.brands.list();
  }

  @Post()
  create(@Req() request: FastifyRequest & { adminAuth?: AdminAuth }, @Body() body: unknown) {
    return this.brands.create(currentAdmin(request).adminId, parseBody(createBrandSchema, body));
  }

  @Patch(':id')
  update(
    @Req() request: FastifyRequest & { adminAuth?: AdminAuth },
    @Param('id') id: string,
    @Body() body: unknown
  ) {
    return this.brands.update(currentAdmin(request).adminId, id, parseBody(updateBrandSchema, body));
  }

  @Delete(':id')
  remove(@Req() request: FastifyRequest & { adminAuth?: AdminAuth }, @Param('id') id: string) {
    return this.brands.remove(currentAdmin(request).adminId, id);
  }
}
