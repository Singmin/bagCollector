import { Body, Controller, Get, Param, Post, Query, UseGuards } from '@nestjs/common';
import { JobStatus } from '@prisma/client';
import { adminLoginSchema } from '@bagcollect/contracts';
import { parseBody } from '../common/zod.js';
import { AdminGuard, type AdminAuth } from './admin.guard.js';
import { AdminService } from './admin.service.js';
import { CurrentAdmin } from './current-admin.js';

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

  @Post('jobs/:id/retry')
  @UseGuards(AdminGuard)
  retry(@CurrentAdmin() admin: AdminAuth, @Param('id') id: string) {
    return this.admin.retryJob(admin.adminId, id);
  }
}
