import { Controller, Delete, Get, Param, Post, UseGuards } from '@nestjs/common';
import { AuthGuard } from '../auth/auth.guard.js';
import { CurrentUser, type AuthUser } from '../common/current-user.js';
import { FeedService } from './feed.service.js';

/** 心愿袋：发现页 ♥ 标记的官方袋子。:id 为官方袋子 id（与 feed 条目同 id）。 */
@Controller('wishlist')
@UseGuards(AuthGuard)
export class WishlistController {
  constructor(private readonly feed: FeedService) {}

  @Get()
  list(@CurrentUser() user: AuthUser) {
    return this.feed.wishlist(user.userId);
  }

  @Post(':id')
  add(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    return this.feed.addWishlist(user.userId, id);
  }

  @Delete(':id')
  remove(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    return this.feed.removeWishlist(user.userId, id);
  }
}
