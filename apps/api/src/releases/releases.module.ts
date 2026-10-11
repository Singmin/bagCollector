import { Module } from '@nestjs/common';
import { AdminGuard } from '../admin/admin.guard.js';
import { AuthModule } from '../auth/auth.module.js';
import { PlansController, ReleasesController } from './releases.controller.js';
import { ReleasesService } from './releases.service.js';

@Module({
  imports: [AuthModule],
  controllers: [ReleasesController, PlansController],
  providers: [ReleasesService, AdminGuard]
})
export class ReleasesModule {}
