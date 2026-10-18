import { Body, Controller, Delete, Get, HttpCode, HttpStatus, Post, Put, UseGuards } from '@nestjs/common';
import { logoutSchema, refreshSchema, updateAccountSchema, wechatLoginSchema } from '@bagcollect/contracts';
import { CurrentUser, type AuthUser } from '../common/current-user.js';
import { parseBody } from '../common/zod.js';
import { AuthGuard } from './auth.guard.js';
import { AuthService } from './auth.service.js';

@Controller()
export class AuthController {
  constructor(private readonly auth: AuthService) {}

  @Post('auth/wechat/login')
  @HttpCode(HttpStatus.OK)
  login(@Body() body: unknown) {
    const input = parseBody(wechatLoginSchema, body);
    return this.auth.login(input.code, input.deviceName);
  }

  @Post('auth/refresh')
  @HttpCode(HttpStatus.OK)
  refresh(@Body() body: unknown) {
    return this.auth.refresh(parseBody(refreshSchema, body).refreshToken);
  }

  @Post('auth/logout')
  @HttpCode(HttpStatus.OK)
  logout(@Body() body: unknown) {
    return this.auth.logout(parseBody(logoutSchema, body).refreshToken);
  }

  @Delete('account')
  @UseGuards(AuthGuard)
  deleteAccount(@CurrentUser() user: AuthUser) {
    return this.auth.deleteAccount(user.userId);
  }

  @Get('account')
  @UseGuards(AuthGuard)
  account(@CurrentUser() user: AuthUser) {
    return this.auth.account(user.userId);
  }

  @Put('account')
  @UseGuards(AuthGuard)
  updateAccount(@CurrentUser() user: AuthUser, @Body() body: unknown) {
    return this.auth.updateAccount(user.userId, parseBody(updateAccountSchema, body));
  }
}
