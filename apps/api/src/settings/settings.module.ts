import { Module } from '@nestjs/common';
import { AdminGuard } from '../admin/admin.guard.js';
import { AuthModule } from '../auth/auth.module.js';
import { SettingsController } from './settings.controller.js';
import { SettingsService } from './settings.service.js';

/**
 * 导出 SettingsService：匹配链路（official-bags）要读它拿当前阈值。
 */
@Module({
  imports: [AuthModule],
  controllers: [SettingsController],
  providers: [SettingsService, AdminGuard],
  exports: [SettingsService]
})
export class SettingsModule {}
