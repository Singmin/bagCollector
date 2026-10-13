import { Body, Controller, Get, Param, Post, Query, UseGuards } from '@nestjs/common';
import { claimOfficialBagSchema, matchOfficialBagSchema, createMatchScanSchema, scanFeedbackSchema } from '@bagcollect/contracts';
import { MatchScansService } from './match-scans.service.js';
import { AuthGuard } from '../auth/auth.guard.js';
import { CurrentUser, type AuthUser } from '../common/current-user.js';
import { parseBody } from '../common/zod.js';
import { OfficialBagsService } from './official-bags.service.js';

@Controller('official-bags')
@UseGuards(AuthGuard)
export class OfficialBagsController {
  constructor(private readonly officialBags: OfficialBagsService, private readonly scans: MatchScansService) {}

  @Post('match-scans')
  createScan(@CurrentUser() user: AuthUser, @Body() body: unknown) { return this.scans.create(user.userId, parseBody(createMatchScanSchema, body)); }
  @Get('match-scans/:scanId')
  scan(@CurrentUser() user: AuthUser, @Param('scanId') scanId: string) { return this.scans.result(user.userId, scanId); }
  @Post('match-scans/:scanId/feedback')
  feedback(@CurrentUser() user: AuthUser, @Param('scanId') scanId: string, @Body() body: unknown) { return this.scans.feedback(user.userId, scanId, parseBody(scanFeedbackSchema, body)); }

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

  /* 品牌分类列表（逛袋子页）：必须声明在 @Get(':id') 之前，否则 /official-bags/brands 会被 :id 吞掉 */
  @Get('brands')
  brands() {
    return this.officialBags.brands();
  }

  @Get(':id')
  detail(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    return this.officialBags.detail(user.userId, id);
  }

  /**
   * 「拍照扫描袋子」：拿刚上传的那条收藏的照片比对官方袋子库。
   * Compatibility endpoint: all matches require explicit user confirmation.
   */
  @Post('match')
  match(@CurrentUser() user: AuthUser, @Body() body: unknown) {
    return this.officialBags.match(user.userId, parseBody(matchOfficialBagSchema, body).collectibleId);
  }

  /**
   * 「拥有」这个袋子。body 可选：前端标记半窗允许改名 / 归类 / 改标签备注；
   * 不传则用官方袋子自带内容，并按品牌归类（无品牌才进「未分类」）。
   */
  @Post(':id/claim')
  claim(@CurrentUser() user: AuthUser, @Param('id') id: string, @Body() body: unknown) {
    /* 不带 body 的调用（老版本小程序 / 无覆盖值）也要能过：只在拿到对象时才当覆盖值解析 */
    const overrides = body && typeof body === 'object' ? body : {};
    const { increment, ...rest } = parseBody(claimOfficialBagSchema, overrides);
    return this.officialBags.claim(user.userId, id, rest, increment === true);
  }
}
