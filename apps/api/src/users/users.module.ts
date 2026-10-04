import { Module } from '@nestjs/common';
import { AdminGuard } from '../admin/admin.guard.js';
import { UsersAdminController } from './users-admin.controller.js';
import { UsersAdminService } from './users-admin.service.js';

@Module({
  controllers: [UsersAdminController],
  providers: [UsersAdminService, AdminGuard]
})
export class UsersModule {}
