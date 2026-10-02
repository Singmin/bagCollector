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

/**
 * 存储无关的统一图片代理（token 签名保护，免登录 —— canvas/image 无法带请求头）。
 * local 与 cos 两种驱动都从这里出流：小程序的 canvas 2d 受 downloadFile 合法域名
 * 白名单限制，统一走 API 域名后白名单只需配一个。
 * 旧路由 /assets/local 保留兼容已发出的 URL。
 */
@Controller('assets/file')
export class ProxyAssetsController {
  constructor(private readonly cos: CosService) {}

  @Get()
  async file(@Query('token') token: string) {
    const stream = await this.cos.streamByToken(token);
    return new StreamableFile(stream.stream, { type: stream.type });
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
