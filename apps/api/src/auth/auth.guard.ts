import { CanActivate, ExecutionContext, HttpStatus, Injectable } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import type { FastifyRequest } from 'fastify';
import { ApiError } from '../common/api-error.js';
import type { AuthUser } from '../common/current-user.js';

interface AccessPayload {
  sub: string;
  sid: string;
  typ: 'access';
}

@Injectable()
export class AuthGuard implements CanActivate {
  constructor(private readonly jwt: JwtService) {}

  async canActivate(context: ExecutionContext) {
    const request = context.switchToHttp().getRequest<FastifyRequest & { authUser?: AuthUser }>();
    const authorization = request.headers.authorization;
    if (!authorization?.startsWith('Bearer ')) {
      throw new ApiError('UNAUTHORIZED', '请先登录', HttpStatus.UNAUTHORIZED);
    }
    try {
      const payload = await this.jwt.verifyAsync<AccessPayload>(authorization.slice(7));
      if (payload.typ !== 'access') throw new Error('invalid token type');
      request.authUser = { userId: payload.sub, sessionId: payload.sid };
      return true;
    } catch {
      throw new ApiError('UNAUTHORIZED', '登录已过期，请重新登录', HttpStatus.UNAUTHORIZED);
    }
  }
}
