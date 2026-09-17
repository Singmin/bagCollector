import { Controller, Get, Param, Query, StreamableFile, UseGuards } from '@nestjs/common';
import { AuthGuard } from '../auth/auth.guard.js';
import { CurrentUser, type AuthUser } from '../common/current-user.js';
import { AssetsService } from './assets.service.js';
import { CosService } from './cos.service.js';

@Controller('assets/local')
export class LocalAssetsController {
  constructor(private readonly cos: CosService) {}

  @Get()
  file(@Query('token') token: string) {
    const local = this.cos.localStream(token);
    return new StreamableFile(local.stream, { type: local.type });
  }
}

@Controller('assets')
@UseGuards(AuthGuard)
export class AssetsController {
  constructor(private readonly assets: AssetsService) {}

  @Get(':id/url')
  url(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    return this.assets.urlFor(user.userId, id);
  }
}
