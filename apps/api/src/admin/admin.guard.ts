import { CanActivate, ExecutionContext, HttpStatus, Injectable } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import type { FastifyRequest } from 'fastify';
import { ApiError } from '../common/api-error.js';

export interface AdminAuth {
  adminId: string;
}

@Injectable()
export class AdminGuard implements CanActivate {
  constructor(private readonly jwt: JwtService) {}

  async canActivate(context: ExecutionContext) {
    const request = context.switchToHttp().getRequest<FastifyRequest & { adminAuth?: AdminAuth }>();
    const authorization = request.headers.authorization;
    if (!authorization?.startsWith('Bearer ')) {
      throw new ApiError('UNAUTHORIZED', '管理员未登录', HttpStatus.UNAUTHORIZED);
    }
    try {
      const payload = await this.jwt.verifyAsync<{ sub: string; typ: string }>(authorization.slice(7));
      if (payload.typ !== 'admin') throw new Error('invalid token type');
      request.adminAuth = { adminId: payload.sub };
      return true;
    } catch {
      throw new ApiError('UNAUTHORIZED', '管理员登录已过期', HttpStatus.UNAUTHORIZED);
    }
  }
}
