import { createParamDecorator, type ExecutionContext } from '@nestjs/common';
import type { FastifyRequest } from 'fastify';
import type { AdminAuth } from './admin.guard.js';

export const CurrentAdmin = createParamDecorator((_data: unknown, context: ExecutionContext): AdminAuth => {
  const request = context.switchToHttp().getRequest<FastifyRequest & { adminAuth: AdminAuth }>();
  return request.adminAuth;
});
