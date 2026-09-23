import { HttpStatus, Injectable } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { JobStatus } from '@prisma/client';
import { ApiError } from '../common/api-error.js';
import { verifyPassword } from '../common/crypto.js';
import { PrismaService } from '../database/prisma.service.js';

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
}
