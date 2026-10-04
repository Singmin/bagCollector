import { Body, Controller, Get, Post, Query, UseGuards } from '@nestjs/common';
import { JobStatus } from '@prisma/client';
import { adminLoginSchema } from '@bagcollect/contracts';
import { parseBody } from '../common/zod.js';
import { AdminGuard } from './admin.guard.js';
import { AdminService } from './admin.service.js';

@Controller('admin')
export class AdminController {
  constructor(private readonly admin: AdminService) {}

  @Post('login')
  login(@Body() body: unknown) {
    const input = parseBody(adminLoginSchema, body);
    return this.admin.login(input.username, input.password);
  }

  @Get('overview')
  @UseGuards(AdminGuard)
  overview() {
    return this.admin.overview();
  }

  @Get('jobs')
  @UseGuards(AdminGuard)
  jobs(@Query('status') status?: JobStatus) {
    return this.admin.jobs(status);
  }

  @Get('audit-logs')
  @UseGuards(AdminGuard)
  auditLogs(
    @Query('action') action?: string,
    @Query('from') from?: string,
    @Query('to') to?: string,
    @Query('cursor') cursor?: string,
    @Query('limit') rawLimit?: string
  ) {
    return this.admin.auditLogs({
      action,
      from,
      to,
      cursor,
      limit: rawLimit ? Number(rawLimit) : undefined
    });
  }
}
