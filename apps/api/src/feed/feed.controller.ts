import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import { AuthGuard } from '../auth/auth.guard.js';
import { FeedService } from './feed.service.js';

/** 发现页「纸袋上新」官方精选 feed（登录后可见）。 */
@Controller('feed')
@UseGuards(AuthGuard)
export class FeedController {
  constructor(private readonly feed: FeedService) {}

  @Get()
  list(
    @Query('search') search?: string,
    @Query('cursor') cursor?: string,
    @Query('limit') rawLimit?: string
  ) {
    return this.feed.feed({ search, cursor, limit: rawLimit ? Number(rawLimit) : undefined });
  }
}
