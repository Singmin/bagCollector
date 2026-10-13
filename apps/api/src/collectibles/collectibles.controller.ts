import { Body, Controller, Delete, Get, Param, Patch, Post, Put, Query, UseGuards } from '@nestjs/common';
import { createCollectibleSchema, cropSchema, matteSchema, updateCollectibleSchema } from '@bagcollect/contracts';
import { AuthGuard } from '../auth/auth.guard.js';
import { CurrentUser, type AuthUser } from '../common/current-user.js';
import { parseBody } from '../common/zod.js';
import { parseSide } from '../common/image-sides.js';
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

  /* 语义拆分：/crop 只裁剪（不调万象、不产抠图），/matte 只抠图（沿用已保存裁剪参数）。
     裁剪页提交走 /crop，编辑页「自动抠图」按钮走 /matte —— 后端同事请勿把两者再合并回一个端点 */
  @Post(':id/crop')
  crop(@CurrentUser() user: AuthUser, @Param('id') id: string, @Body() body: unknown) {
    return this.collectibles.crop(user.userId, id, parseBody(cropSchema, body));
  }

  @Post(':id/matte')
  matte(@CurrentUser() user: AuthUser, @Param('id') id: string, @Body() body: unknown) {
    /* body 允许为空对象 / 缺省：抠图默认沿用已保存的裁剪参数 */
    return this.collectibles.matte(user.userId, id, parseBody(matteSchema, body ?? {}));
  }

  @Delete(':id/images/:side')
  removeImage(@CurrentUser() user: AuthUser, @Param('id') id: string, @Param('side') side: string) {
    return this.collectibles.removeImage(user.userId, id, parseSide(side));
  }

  @Delete(':id')
  remove(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    return this.collectibles.remove(user.userId, id);
  }
}
