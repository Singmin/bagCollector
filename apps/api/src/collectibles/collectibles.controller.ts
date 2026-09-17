import { Body, Controller, Delete, Get, Param, Patch, Post, Put, Query, UseGuards } from '@nestjs/common';
import { createCollectibleSchema, cropSchema, updateCollectibleSchema } from '@bagcollect/contracts';
import { AuthGuard } from '../auth/auth.guard.js';
import { CurrentUser, type AuthUser } from '../common/current-user.js';
import { parseBody } from '../common/zod.js';
import { CollectiblesService } from './collectibles.service.js';

@Controller('collectibles')
@UseGuards(AuthGuard)
export class CollectiblesController {
  constructor(private readonly collectibles: CollectiblesService) {}

  @Get()
  list(
    @CurrentUser() user: AuthUser,
    @Query('search') search?: string,
    @Query('shelfId') shelfId?: string,
    @Query('cursor') cursor?: string,
    @Query('limit') rawLimit?: string
  ) {
    return this.collectibles.list(user.userId, {
      search,
      shelfId,
      cursor,
      limit: rawLimit ? Number(rawLimit) : undefined
    });
  }

  @Post()
  create(@CurrentUser() user: AuthUser, @Body() body: unknown) {
    return this.collectibles.create(user.userId, parseBody(createCollectibleSchema, body));
  }

  @Get(':id')
  detail(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    return this.collectibles.detail(user.userId, id);
  }

  @Patch(':id')
  updatePatch(@CurrentUser() user: AuthUser, @Param('id') id: string, @Body() body: unknown) {
    return this.collectibles.update(user.userId, id, parseBody(updateCollectibleSchema, body));
  }

  @Put(':id')
  updatePut(@CurrentUser() user: AuthUser, @Param('id') id: string, @Body() body: unknown) {
    return this.collectibles.update(user.userId, id, parseBody(updateCollectibleSchema, body));
  }

  @Post(':id/crop')
  crop(@CurrentUser() user: AuthUser, @Param('id') id: string, @Body() body: unknown) {
    return this.collectibles.crop(user.userId, id, parseBody(cropSchema, body));
  }

  @Post(':id/retry')
  retry(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    return this.collectibles.retry(user.userId, id);
  }

  @Post(':id/keep-crop')
  keepCrop(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    return this.collectibles.keepCrop(user.userId, id);
  }

  @Delete(':id')
  remove(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    return this.collectibles.remove(user.userId, id);
  }
}
