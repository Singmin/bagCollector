import { Module } from '@nestjs/common';
import { AdminGuard } from '../admin/admin.guard.js';
import { AuthModule } from '../auth/auth.module.js';
import { BrandsAdminController } from './brands-admin.controller.js';
import { BrandsAdminService } from './brands-admin.service.js';
import { OfficialBagsAdminController } from './official-bags-admin.controller.js';
import { OfficialBagsAdminService } from './official-bags-admin.service.js';
import { OfficialBagsController } from './official-bags.controller.js';
import { OfficialBagsService } from './official-bags.service.js';

@Module({
  imports: [AuthModule],
  controllers: [OfficialBagsController, OfficialBagsAdminController, BrandsAdminController],
  providers: [OfficialBagsService, OfficialBagsAdminService, BrandsAdminService, AdminGuard]
})
export class OfficialBagsModule {}
