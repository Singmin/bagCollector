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

  /** 上传/替换品牌展示图（multipart 单文件，字段名 file）。 */
  @Post(':id/image')
  async uploadImage(@Req() request: FastifyRequest & { adminAuth?: AdminAuth }, @Param('id') id: string) {
    const file = await request.file();
    if (!file) throw new ApiError('UPLOAD_INVALID', '没有收到图片文件', HttpStatus.BAD_REQUEST);
    const body = await file.toBuffer();
    return this.brands.uploadImage(currentAdmin(request).adminId, id, { body, contentType: file.mimetype });
  }

  @Delete(':id/image')
  removeImage(@Req() request: FastifyRequest & { adminAuth?: AdminAuth }, @Param('id') id: string) {
    return this.brands.removeDisplayImage(currentAdmin(request).adminId, id);
  }
}
