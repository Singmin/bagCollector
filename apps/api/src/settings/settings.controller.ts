import { Body, Controller, Get, HttpStatus, Put, Req, UseGuards } from '@nestjs/common';
import type { FastifyRequest } from 'fastify';
import { matchSettingsSchema } from '@bagcollect/contracts';
import { AdminGuard, type AdminAuth } from '../admin/admin.guard.js';
import { ApiError } from '../common/api-error.js';
import { parseBody } from '../common/zod.js';
import { SettingsService } from './settings.service.js';

function currentAdmin(request: FastifyRequest & { adminAuth?: AdminAuth }): AdminAuth {
  if (!request.adminAuth) {
    throw new ApiError('UNAUTHORIZED', '管理员未登录', HttpStatus.UNAUTHORIZED);
  }
  return request.adminAuth;
}

/** 管理端：运行时可变的应用设置。目前只有拍照扫描袋子的判定阈值。 */
@Controller('admin/settings')
@UseGuards(AdminGuard)
export class SettingsController {
  constructor(private readonly settings: SettingsService) {}

  /** 当前生效的匹配阈值（库里没存过的键已由 env 默认值补齐）。 */
  @Get('match')
  matchSettings() {
    return this.settings.matchSettings();
  }

  /** 更新匹配阈值。保存即生效 —— 匹配接口每次都读库，中间没有缓存层。 */
  @Put('match')
  updateMatchSettings(@Req() request: FastifyRequest & { adminAuth?: AdminAuth }, @Body() body: unknown) {
    return this.settings.updateMatchSettings(currentAdmin(request).adminId, parseBody(matchSettingsSchema, body));
  }
}
