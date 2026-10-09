import { Body, Controller, Delete, Get, HttpStatus, Param, Patch, Post, Query, Req, UseGuards } from '@nestjs/common';
import type { FastifyRequest } from 'fastify';
import { createOfficialBagSchema, importOfficialBagsSchema, officialBagStatuses, updateOfficialBagSchema } from '@bagcollect/contracts';
import { ApiError } from '../common/api-error.js';
import { parseBody } from '../common/zod.js';
import { AdminGuard, type AdminAuth } from '../admin/admin.guard.js';
import { OfficialBagsAdminService } from './official-bags-admin.service.js';

function currentAdmin(request: FastifyRequest & { adminAuth?: AdminAuth }): AdminAuth {
  if (!request.adminAuth) {
    throw new ApiError('UNAUTHORIZED', '管理员未登录', HttpStatus.UNAUTHORIZED);
  }
  return request.adminAuth;
}

/** 上传时的「执行抠图」开关：用 query 传，避免 multipart 字段解析顺序带来的不确定性。 */
function parseMatting(raw?: string): boolean | undefined {
  if (raw === 'true') return true;
  if (raw === 'false') return false;
  return undefined;
}

@Controller('admin/official-bags')
@UseGuards(AdminGuard)
export class OfficialBagsAdminController {
  constructor(private readonly admin: OfficialBagsAdminService) {}

  @Post()
  create(@Req() request: FastifyRequest & { adminAuth?: AdminAuth }, @Body() body: unknown) {
    return this.admin.create(currentAdmin(request).adminId, parseBody(createOfficialBagSchema, body));
  }

  @Post('import')
  importBags(@Req() request: FastifyRequest & { adminAuth?: AdminAuth }, @Body() body: unknown) {
    return this.admin.importBags(currentAdmin(request).adminId, parseBody(importOfficialBagsSchema, body));
  }

  /**
   * 手动补算官方袋子向量。与 worker 定时跑的那轮是同一套逻辑，区别只是不等定时器 ——
   * 刚纳入/上传完袋子、想让它立刻能被扫到时点这个。
   */
  @Post('embeddings/reconcile')
  reconcileEmbeddings(@Req() request: FastifyRequest & { adminAuth?: AdminAuth }) {
    return this.admin.reconcileEmbeddings(currentAdmin(request).adminId);
  }

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
      status && (officialBagStatuses as readonly string[]).includes(status)
        ? (status as (typeof officialBagStatuses)[number])
        : undefined;
    return this.admin.list({
      status: statusValue,
      search,
      page: rawPage ? Number(rawPage) : undefined,
      pageSize: rawPageSize ? Number(rawPageSize) : undefined,
      sort,
      order
    });
  }

  @Get(':id')
  detail(@Param('id') id: string) {
    return this.admin.detail(id);
  }

  @Patch(':id')
  update(
    @Req() request: FastifyRequest & { adminAuth?: AdminAuth },
    @Param('id') id: string,
    @Body() body: unknown
  ) {
    return this.admin.update(currentAdmin(request).adminId, id, parseBody(updateOfficialBagSchema, body));
  }

  @Post(':id/image')
  async uploadImage(
    @Req() request: FastifyRequest & { adminAuth?: AdminAuth },
    @Param('id') id: string,
    @Query('matting') matting?: string
  ) {
    const file = await request.file();
    if (!file) throw new ApiError('UPLOAD_INVALID', '没有收到图片文件', HttpStatus.BAD_REQUEST);
    const body = await file.toBuffer();
    return this.admin.uploadImage(currentAdmin(request).adminId, id, {
      body,
      contentType: file.mimetype,
      matting: parseMatting(matting)
    });
  }

  @Delete(':id/image')
  removeImage(@Req() request: FastifyRequest & { adminAuth?: AdminAuth }, @Param('id') id: string) {
    return this.admin.removeImage(currentAdmin(request).adminId, id);
  }

  @Delete(':id')
  remove(@Req() request: FastifyRequest & { adminAuth?: AdminAuth }, @Param('id') id: string) {
    return this.admin.remove(currentAdmin(request).adminId, id);
  }
}
