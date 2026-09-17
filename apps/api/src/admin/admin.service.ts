import { HttpStatus, Injectable } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { JobStatus, JobType } from '@prisma/client';
import { ApiError } from '../common/api-error.js';
import { verifyPassword } from '../common/crypto.js';
import { QueueService } from '../common/queue.service.js';
import { PrismaService } from '../database/prisma.service.js';

@Injectable()
export class AdminService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly jwt: JwtService,
    private readonly queues: QueueService
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

  async retryJob(adminId: string, id: string) {
    const job = await this.prisma.processingJob.findUnique({
      where: { id },
      include: { collectible: true }
    });
    if (!job) throw new ApiError('NOT_FOUND', '任务不存在', HttpStatus.NOT_FOUND);
    if (job.status !== JobStatus.FAILED) {
      throw new ApiError('CONFLICT', '只有失败任务可以重试', HttpStatus.CONFLICT);
    }
    if (job.type === JobType.CLEANUP) {
      throw new ApiError('CONFLICT', '清理任务需从日志人工处理', HttpStatus.CONFLICT);
    }
    await this.prisma.processingJob.update({
      where: { id },
      data: { status: JobStatus.QUEUED, errorMessage: null }
    });
    await this.prisma.auditLog.create({
      data: { adminId, userId: job.userId, action: 'RETRY_PROCESSING_JOB', targetId: id }
    });
    const name = job.type === JobType.NORMALIZE ? 'normalize' : 'matting';
    await this.queues.add(
      name,
      {
        processingJobId: job.id,
        collectibleId: job.collectibleId,
        userId: job.userId,
        version: job.collectible.processingVersion
      },
      `admin-retry:${job.id}:${Date.now()}`
    );
    return { success: true };
  }
}
