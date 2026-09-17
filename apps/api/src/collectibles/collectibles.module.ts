import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module.js';
import { CollectiblesController } from './collectibles.controller.js';
import { CollectiblesService } from './collectibles.service.js';

@Module({ imports: [AuthModule], controllers: [CollectiblesController], providers: [CollectiblesService] })
export class CollectiblesModule {}
