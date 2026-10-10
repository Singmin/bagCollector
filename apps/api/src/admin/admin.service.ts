import { HttpStatus, Injectable } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { JobStatus, Prisma } from '@prisma/client';
import type { AuditLogPageDto, JobPageDto } from '@bagcollect/contracts';
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

  /**
   * 图片处理任务列表。
   *
   * 原先硬编码 take: 100 —— 任务超过 100 条之后的部分永远看不到，与「有多少条就能
   * 看多少条」相悖。改为页码分页，由前端翻页取，每次只取一屏。
   */
  async jobs(query: { status?: JobStatus; page?: number; pageSize?: number }): Promise<JobPageDto> {
    const pageSize = Math.min(Math.max(query.pageSize ?? 20, 1), 200);
    const currentPage = Math.max(query.page ?? 1, 1);
    const where = query.status ? { status: query.status } : undefined;
    const [items, totalCount] = await Promise.all([
      this.prisma.processingJob.findMany({
        where,
        include: { collectible: { select: { name: true } } },
        orderBy: { createdAt: 'desc' },
        skip: (currentPage - 1) * pageSize,
        take: pageSize
      }),
      this.prisma.processingJob.count({ where })
    ]);
    return {
      items: items.map((job) => ({
        id: job.id,
        type: job.type,
        status: job.status,
        attemptCount: job.attemptCount,
        ...(job.errorMessage ? { errorMessage: job.errorMessage } : {}),
        collectible: job.collectible ? { name: job.collectible.name } : null,
        createdAt: job.createdAt.toISOString(),
        ...(job.finishedAt ? { finishedAt: job.finishedAt.toISOString() } : {})
      })),
      totalCount
    };
  }

  async auditLogs(query: {
    action?: string;
    from?: string;
    to?: string;
    page?: number;
    pageSize?: number;
  }): Promise<AuditLogPageDto> {
    const pageSize = Math.min(Math.max(query.pageSize ?? 30, 1), 500);
    const currentPage = Math.max(query.page ?? 1, 1);
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
        orderBy: { createdAt: 'desc' },
        skip: (currentPage - 1) * pageSize,
        take: pageSize,
        include: { admin: { select: { username: true } } }
      }),
      this.prisma.auditLog.count({ where })
    ]);

    return {
      items: items.map((log) => ({
        id: log.id,
        action: log.action,
        ...(log.targetId ? { targetId: log.targetId } : {}),
        ...(log.adminId ? { adminId: log.adminId } : {}),
        ...(log.admin ? { adminUsername: log.admin.username } : {}),
        ...(log.userId ? { userId: log.userId } : {}),
        ...(log.metadata !== null && log.metadata !== undefined ? { metadata: log.metadata } : {}),
        createdAt: log.createdAt.toISOString()
      })),
      totalCount
    };
  }
}
