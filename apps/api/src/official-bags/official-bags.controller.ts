import { Controller, Get, Param, Post, Query, UseGuards } from '@nestjs/common';
import { AuthGuard } from '../auth/auth.guard.js';
import { CurrentUser, type AuthUser } from '../common/current-user.js';
import { OfficialBagsService } from './official-bags.service.js';

@Controller('official-bags')
@UseGuards(AuthGuard)
export class OfficialBagsController {
  constructor(private readonly officialBags: OfficialBagsService) {}

  @Get()
  list(
    @CurrentUser() user: AuthUser,
    @Query('search') search?: string,
    @Query('brandId') brandId?: string,
    @Query('cursor') cursor?: string,
    @Query('limit') rawLimit?: string
  ) {
    return this.officialBags.list(user.userId, {
      search,
      brandId,
      cursor,
      limit: rawLimit ? Number(rawLimit) : undefined
    });
  }

  @Get(':id')
  detail(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    return this.officialBags.detail(user.userId, id);
  }

  @Post(':id/claim')
  claim(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    return this.officialBags.claim(user.userId, id);
  }
}
