import { Module } from '@nestjs/common';
import { AdminGuard } from '../admin/admin.guard.js';
import { AuthModule } from '../auth/auth.module.js';
import { ChangelogDocsService } from './changelog-docs.service.js';
import {
  ChangelogDocsController,
  PlansController,
  ReleasesController
} from './releases.controller.js';
import { ReleasesService } from './releases.service.js';

@Module({
  imports: [AuthModule],
  controllers: [ReleasesController, PlansController, ChangelogDocsController],
  providers: [ReleasesService, ChangelogDocsService, AdminGuard]
})
export class ReleasesModule {}
