import { Global, Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module.js';
import { AssetsController, LocalAssetsController } from './assets.controller.js';
import { AssetsService } from './assets.service.js';
import { CosService } from './cos.service.js';

@Global()
@Module({
  imports: [AuthModule],
  controllers: [LocalAssetsController, AssetsController],
  providers: [AssetsService, CosService],
  exports: [AssetsService, CosService]
})
export class AssetsModule {}
