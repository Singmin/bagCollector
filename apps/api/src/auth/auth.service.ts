import { createHash } from 'node:crypto';
import { HttpStatus, Injectable } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { ProcessingStatus, UserStatus } from '@prisma/client';
import type { AuthTokens } from '@bagcollect/contracts';
import { ApiError } from '../common/api-error.js';
import { hashToken, randomToken } from '../common/crypto.js';
import { env } from '../common/env.js';
import { QueueService } from '../common/queue.service.js';
import { PrismaService } from '../database/prisma.service.js';

interface WechatSessionResponse {
  openid?: string;
  unionid?: string;
  errcode?: number;
  errmsg?: string;
}

@Injectable()
export class AuthService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly jwt: JwtService,
    private readonly queues: QueueService
  ) {}

  private async exchangeWechatCode(code: string) {
    const config = env();
    if (config.WECHAT_AUTH_MOCK) {
      return { openid: `mock_${createHash('sha256').update(code).digest('hex').slice(0, 40)}` };
    }

    const query = new URLSearchParams({
      appid: config.WECHAT_APP_ID,
      secret: config.WECHAT_APP_SECRET,
      js_code: code,
      grant_type: 'authorization_code'
    });
    const response = await fetch(`https://api.weixin.qq.com/sns/jscode2session?${query}`, {
      signal: AbortSignal.timeout(10_000)
    });
    const body = (await response.json()) as WechatSessionResponse;
    if (!response.ok || body.errcode || !body.openid) {
      throw new ApiError('WECHAT_LOGIN_FAILED', '微信登录失败，请稍后重试', HttpStatus.BAD_GATEWAY, {
        errcode: body.errcode
      });
    }
    return { openid: body.openid, unionid: body.unionid };
  }

  private async issueTokens(userId: string, sessionId: string, refreshToken: string): Promise<AuthTokens> {
    const config = env();
    const refreshTokenExpiresAt = new Date(Date.now() + config.REFRESH_TOKEN_DAYS * 86_400_000);
    const accessToken = await this.jwt.signAsync(
      { sub: userId, sid: sessionId, typ: 'access' },
      { expiresIn: config.ACCESS_TOKEN_TTL as never }
    );
    return {
      accessToken,
      accessTokenExpiresIn: 7_200,
      refreshToken,
      refreshTokenExpiresAt: refreshTokenExpiresAt.toISOString()
    };
  }

  async login(code: string, deviceName?: string) {
    const wechat = await this.exchangeWechatCode(code);
    const config = env();
    const user = await this.prisma.$transaction(async (transaction) => {
      const existing = await transaction.user.findUnique({ where: { openid: wechat.openid } });
      if (existing) {
        return transaction.user.update({
          where: { id: existing.id },
          data: { lastLoginAt: new Date(), ...(wechat.unionid ? { unionid: wechat.unionid } : {}) }
        });
      }
      return transaction.user.create({
        data: {
          openid: wechat.openid,
          unionid: wechat.unionid,
          storageQuotaBytes: BigInt(config.MAX_STORAGE_BYTES),
          collectibleQuota: config.MAX_COLLECTIBLES_PER_USER,
          dailyMattingQuota: config.MAX_DAILY_MATTING
        }
      });
    });

    if (user.status !== UserStatus.ACTIVE) {
      throw new ApiError('FORBIDDEN', '账号已暂停使用', HttpStatus.FORBIDDEN);
    }

    const refreshToken = randomToken();
    const expiresAt = new Date(Date.now() + config.REFRESH_TOKEN_DAYS * 86_400_000);
    const session = await this.prisma.session.create({
      data: {
        userId: user.id,
        refreshTokenHash: hashToken(refreshToken),
        deviceName,
        expiresAt
      }
    });
    return this.issueTokens(user.id, session.id, refreshToken);
  }

  async refresh(refreshToken: string) {
    const tokenHash = hashToken(refreshToken);
    const session = await this.prisma.session.findUnique({ where: { refreshTokenHash: tokenHash } });
    if (!session || session.revokedAt || session.expiresAt <= new Date()) {
      throw new ApiError('UNAUTHORIZED', '刷新凭证已失效', HttpStatus.UNAUTHORIZED);
    }

    const nextRefreshToken = randomToken();
    const expiresAt = new Date(Date.now() + env().REFRESH_TOKEN_DAYS * 86_400_000);
    const rotated = await this.prisma.session.updateMany({
      where: { id: session.id, refreshTokenHash: tokenHash, revokedAt: null },
      data: { refreshTokenHash: hashToken(nextRefreshToken), expiresAt, lastUsedAt: new Date() }
    });
    if (rotated.count !== 1) {
      throw new ApiError('UNAUTHORIZED', '刷新凭证已失效', HttpStatus.UNAUTHORIZED);
    }
    return this.issueTokens(session.userId, session.id, nextRefreshToken);
  }

  async logout(refreshToken: string) {
    await this.prisma.session.updateMany({
      where: { refreshTokenHash: hashToken(refreshToken), revokedAt: null },
      data: { revokedAt: new Date() }
    });
    return { success: true };
  }

  async deleteAccount(userId: string) {
    const assets = await this.prisma.imageAsset.findMany({ where: { userId }, select: { objectKey: true } });
    await this.prisma.user.delete({ where: { id: userId } });
    if (assets.length) {
      await this.queues.add('cleanup', { keys: assets.map((asset) => asset.objectKey) });
    }
    return { success: true };
  }

  async account(userId: string) {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      include: {
        _count: {
          select: {
            collectibles: { where: { processingStatus: ProcessingStatus.READY } },
            shelves: true
          }
        }
      }
    });
    if (!user) throw new ApiError('NOT_FOUND', '用户不存在', HttpStatus.NOT_FOUND);
    return {
      collectibleCount: user._count.collectibles,
      shelfCount: user._count.shelves,
      storageUsedBytes: Number(user.storageUsedBytes),
      storageQuotaBytes: Number(user.storageQuotaBytes),
      whiteStrokeEnabled: user.whiteStrokeEnabled,
      createdAt: user.createdAt.toISOString()
    };
  }

  async updateAccount(userId: string, input: { whiteStrokeEnabled: boolean }) {
    const user = await this.prisma.user.update({
      where: { id: userId },
      data: { whiteStrokeEnabled: input.whiteStrokeEnabled }
    });
    return { whiteStrokeEnabled: user.whiteStrokeEnabled };
  }
}
