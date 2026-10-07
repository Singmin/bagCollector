import { HttpStatus, Injectable } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { JobStatus, Prisma } from '@prisma/client';
import type { AuditLogPageDto } from '@bagcollect/contracts';
import { ApiError } from '../common/api-error.js';
import { verifyPassword } from '../common/crypto.js';
import { PrismaService } from '../database/prisma.service.js';

/** 把「YYYY-MM-DD」按服务器本地时区解析成当天起止时刻；非法输入返回 undefined。 */
function parseDayBoundary(raw: string | undefined, endOfDay: boolean): Date | undefined {
  if (!raw) return undefined;
  const date = new Date(`${raw}T${endOfDay ? '23:59:59.999' : '00:00:00'}`);
  return Number.isNaN(date.getTime()) ? undefined : date;
}

@Injectable()
export class AdminService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly jwt: JwtService
  ) {}

  async login(username: string, password: string) {
    const admin = await this.prisma.admin.findUnique({ where: { username } });
    if (!admin?.isActive || !(await verifyPassword(password, admin.passwordHash))) {
      throw new ApiError('UNAUTHORIZED', '用户名或密码不正确', HttpStatus.UNAUTHORIZED);
    }
    await this.prisma.auditLog.create({ data: { adminId: admin.id, action: 'ADMIN_LOGIN' } });
    return {
      accessToken: await this.jwt.signAsync({ sub: admin.id, typ: 'admin' }, { expiresIn: '8h' }),
      expiresIn: 28_800
    };
  }

  async overview() {
    const [users, collectibles, failedJobs, assets] = await Promise.all([
      this.prisma.user.count(),
      this.prisma.collectible.count(),
      this.prisma.processingJob.count({ where: { status: JobStatus.FAILED } }),
      this.prisma.imageAsset.aggregate({ _sum: { byteSize: true } })
    ]);
    return {
      users,
      collectibles,
      failedJobs,
      storageBytes: Number(assets._sum.byteSize ?? 0n)
    };
  }

  jobs(status?: JobStatus) {
    return this.prisma.processingJob.findMany({
      where: status ? { status } : undefined,
      include: { collectible: { select: { name: true } } },
      orderBy: { createdAt: 'desc' },
      take: 100
    });
  }

  async auditLogs(query: {
    action?: string;
    from?: string;
    to?: string;
    cursor?: string;
    limit?: number;
  }): Promise<AuditLogPageDto> {
    const limit = Math.min(Math.max(query.limit ?? 30, 1), 2000);
    const action = query.action?.trim();
    const fromDate = parseDayBoundary(query.from, false);
    const toDate = parseDayBoundary(query.to, true);
    const where = {
      ...(action ? { action: { contains: action, mode: 'insensitive' as const } } : {}),
      ...(fromDate || toDate
        ? {
            createdAt: {
              ...(fromDate ? { gte: fromDate } : {}),
              ...(toDate ? { lte: toDate } : {})
            }
          }
        : {})
    } satisfies Prisma.AuditLogWhereInput;

    const [items, totalCount] = await Promise.all([
      this.prisma.auditLog.findMany({
        where,
        ...(query.cursor ? { cursor: { id: query.cursor }, skip: 1 } : {}),
        orderBy: { createdAt: 'desc' },
        take: limit + 1,
        include: { admin: { select: { username: true } } }
      }),
      this.prisma.auditLog.count({ where })
    ]);

    const hasMore = items.length > limit;
    const page = hasMore ? items.slice(0, limit) : items;
    return {
      items: page.map((log) => ({
        id: log.id,
        action: log.action,
        ...(log.targetId ? { targetId: log.targetId } : {}),
        ...(log.adminId ? { adminId: log.adminId } : {}),
        ...(log.admin ? { adminUsername: log.admin.username } : {}),
        ...(log.userId ? { userId: log.userId } : {}),
        ...(log.metadata !== null && log.metadata !== undefined ? { metadata: log.metadata } : {}),
        createdAt: log.createdAt.toISOString()
      })),
      nextCursor: hasMore ? page.at(-1)?.id ?? null : null,
      totalCount
    };
  }
}
