import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import { AuthGuard } from '../auth/auth.guard.js';
import { CurrentUser } from '../common/current-user.js';
import type { AuthUser } from '../common/current-user.js';
import { FeedService } from './feed.service.js';

/** 发现页「纸袋上新」官方精选 feed（登录后可见）。 */
@Controller('feed')
@UseGuards(AuthGuard)
export class FeedController {
  constructor(private readonly feed: FeedService) {}

  @Get()
  list(
    @CurrentUser() user: AuthUser,
    @Query('search') search?: string,
    @Query('cursor') cursor?: string,
    @Query('limit') rawLimit?: string
  ) {
    /* 带上当前用户：feed 条目要标注「我是否已认领 / 认领生成的收藏 id」，
       小程序据此恢复「标记已有」的已标记状态（内存态刷新即丢） */
    return this.feed.feed(user.userId, { search, cursor, limit: rawLimit ? Number(rawLimit) : undefined });
  }
}
