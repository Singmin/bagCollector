import { Body, Controller, Get, Param, Post, Put, Query, Req, UseGuards } from '@nestjs/common';
import { learningReviewSchema, learningSettingsSchema } from '@bagcollect/contracts';
import { AdminGuard, type AdminAuth } from '../admin/admin.guard.js';
import { parseBody } from '../common/zod.js';
import { LearningSamplesService } from './learning-samples.service.js';

@Controller('admin')
@UseGuards(AdminGuard)
export class LearningSamplesAdminController {
  constructor(private readonly samples: LearningSamplesService) {}
  @Get('settings/learning')
  settings() { return this.samples.settings(); }
  @Put('settings/learning')
  save(@Req() request: { adminAuth: AdminAuth }, @Body() body: unknown) { return this.samples.saveSettings(request.adminAuth.adminId, parseBody(learningSettingsSchema, body)); }
  @Get('learning-samples')
  list(@Query('page') page?: string, @Query('state') state?: string) { return this.samples.list(Number(page ?? 1), state); }
  @Post('learning-samples/:id/review')
  review(@Req() request: { adminAuth: AdminAuth }, @Param('id') id: string, @Body() body: unknown) { return this.samples.review(request.adminAuth.adminId, id, parseBody(learningReviewSchema, body)); }
}
