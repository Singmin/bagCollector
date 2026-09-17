import { Body, Controller, Delete, Get, Param, Patch, Post, Put, UseGuards } from '@nestjs/common';
import { createShelfSchema, reorderSchema, updateShelfSchema } from '@bagcollect/contracts';
import { CurrentUser, type AuthUser } from '../common/current-user.js';
import { parseBody } from '../common/zod.js';
import { AuthGuard } from '../auth/auth.guard.js';
import { ShelvesService } from './shelves.service.js';

@Controller('shelves')
@UseGuards(AuthGuard)
export class ShelvesController {
  constructor(private readonly shelves: ShelvesService) {}

  @Get()
  list(@CurrentUser() user: AuthUser) {
    return this.shelves.list(user.userId);
  }

  @Post()
  create(@CurrentUser() user: AuthUser, @Body() body: unknown) {
    return this.shelves.create(user.userId, parseBody(createShelfSchema, body));
  }

  @Patch(':id')
  updatePatch(@CurrentUser() user: AuthUser, @Param('id') id: string, @Body() body: unknown) {
    return this.shelves.update(user.userId, id, parseBody(updateShelfSchema, body));
  }

  @Put(':id')
  updatePut(@CurrentUser() user: AuthUser, @Param('id') id: string, @Body() body: unknown) {
    return this.shelves.update(user.userId, id, parseBody(updateShelfSchema, body));
  }

  @Post('reorder')
  reorder(@CurrentUser() user: AuthUser, @Body() body: unknown) {
    return this.shelves.reorder(user.userId, parseBody(reorderSchema, body).ids);
  }

  @Delete(':id')
  remove(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    return this.shelves.remove(user.userId, id);
  }
}
