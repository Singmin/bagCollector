import { Module } from '@nestjs/common';
import { AdminGuard } from '../admin/admin.guard.js';
import { SubmissionsAdminController } from './submissions-admin.controller.js';
import { SubmissionsAdminService } from './submissions-admin.service.js';

@Module({
  controllers: [SubmissionsAdminController],
  providers: [SubmissionsAdminService, AdminGuard]
})
export class SubmissionsModule {}
