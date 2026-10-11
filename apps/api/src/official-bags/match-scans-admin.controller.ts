import { Controller, Get, Post, Delete, Param, Query, Req, UseGuards } from '@nestjs/common';
import type { FastifyRequest } from 'fastify';
import { AdminGuard, type AdminAuth } from '../admin/admin.guard.js';
import { ApiError } from '../common/api-error.js';
import { MatchScansService } from './match-scans.service.js';

@Controller('admin')
@UseGuards(AdminGuard)
export class MatchScansAdminController {
  constructor(private readonly scans: MatchScansService) {}
  @Get('match-scans')
  diagnostics(@Query('page') page?: string) { return this.scans.diagnostics(Number(page ?? 1)); }
  @Post('match-scans/reconcile')
  reconcile() { return this.scans.reconcile(); }
  @Get('official-bags/:id/references')
  references(@Param('id') id: string) { return this.scans.references(id); }
  @Post('official-bags/:id/references')
  async upload(@Param('id') id: string, @Req() request: FastifyRequest & { adminAuth: AdminAuth }) {
    const file = await request.file();
    if (!file) throw new ApiError('UPLOAD_INVALID', '没有收到图片', 400);
    return this.scans.addReference(request.adminAuth.adminId, id, await file.toBuffer(), file.mimetype);
  }
  @Delete('official-bags/:id/references/:referenceId')
  remove(@Param('id') id: string, @Param('referenceId') referenceId: string, @Req() request: FastifyRequest & { adminAuth: AdminAuth }) {
    return this.scans.removeReference(request.adminAuth.adminId, id, referenceId);
  }
  @Post('official-bags/:id/references/recompute')
  recompute(@Param('id') id: string) { return this.scans.reconcile(id); }
}
