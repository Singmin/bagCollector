import { Module } from '@nestjs/common';
import { AdminController } from './admin.controller.js';
import { AdminGuard } from './admin.guard.js';
import { AdminService } from './admin.service.js';
import { StrokePreviewController } from './stroke-preview.controller.js';
import { StrokePreviewService } from './stroke-preview.service.js';

@Module({
  controllers: [AdminController, StrokePreviewController],
  providers: [AdminService, AdminGuard, StrokePreviewService]
})
export class AdminModule {}
