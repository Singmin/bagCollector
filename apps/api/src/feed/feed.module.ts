import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module.js';
import { FeedController } from './feed.controller.js';
import { FeedService } from './feed.service.js';
import { WishlistController } from './wishlist.controller.js';

/** 发现页 feed + 心愿袋（数据源都是官方袋子，共享 FeedService 的映射逻辑）。 */
@Module({
  imports: [AuthModule],
  controllers: [FeedController, WishlistController],
  providers: [FeedService],
  exports: [FeedService]
})
export class FeedModule {}
