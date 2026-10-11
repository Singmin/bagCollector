import { Module } from '@nestjs/common';
import { AdminGuard } from '../admin/admin.guard.js';
import { AuthModule } from '../auth/auth.module.js';
import { SettingsModule } from '../settings/settings.module.js';
import { BrandsAdminController } from './brands-admin.controller.js';
import { BrandsAdminService } from './brands-admin.service.js';
import { OfficialBagsAdminController } from './official-bags-admin.controller.js';
import { OfficialBagsAdminService } from './official-bags-admin.service.js';
import { OfficialBagsController } from './official-bags.controller.js';
import { OfficialBagsService } from './official-bags.service.js';
import { MatchScansService } from './match-scans.service.js';
import { MatchScansAdminController } from './match-scans-admin.controller.js';

@Module({
  imports: [AuthModule, SettingsModule],
  controllers: [OfficialBagsController, OfficialBagsAdminController, BrandsAdminController, MatchScansAdminController],
  providers: [OfficialBagsService, OfficialBagsAdminService, BrandsAdminService, AdminGuard, MatchScansService]
})
export class OfficialBagsModule {}
