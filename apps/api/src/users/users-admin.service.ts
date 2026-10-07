import { HttpStatus, Injectable } from '@nestjs/common';
import { Prisma, UserStatus } from '@prisma/client';
import type {
  AdminUserDetailDto,
  AdminUserPageDto,
  AdminUserSummaryDto,
  UpdateUserQuotaInput,
  UserStatus as UserStatusContract
} from '@bagcollect/contracts';
import { ApiError } from '../common/api-error.js';
import { PrismaService } from '../database/prisma.service.js';

type UserRow = Prisma.UserGetPayload<{
  include: { _count: { select: { collectibles: true; shelves: true } } };
}>;

const USER_INCLUDE = {
  _count: { select: { collectibles: true, shelves: true } }
} as const;

@Injectable()
export class UsersAdminService {
  constructor(private readonly prisma: PrismaService) {}

  /** openid 脱敏：保留首 4 尾 4，中间打码；过短则收窄到首 2 尾 2。 */
  private maskOpenid(openid: string) {
    const head = openid.length <= 8 ? 2 : 4;
    const tail = openid.length <= 8 ? 2 : 4;
    return `${openid.slice(0, head)}***${openid.slice(-tail)}`;
  }

  private toSummary(user: UserRow): AdminUserSummaryDto {
    return {
      id: user.id,
      openidMasked: this.maskOpenid(user.openid),
      hasUnionid: Boolean(user.unionid),
      status: user.status,
      collectibleCount: user._count.collectibles,
      shelfCount: user._count.shelves,
      storageUsedBytes: Number(user.storageUsedBytes),
      storageQuotaBytes: Number(user.storageQuotaBytes),
      lastLoginAt: user.lastLoginAt.toISOString(),
      createdAt: user.createdAt.toISOString()
    };
  }

  private async audit(adminId: string, action: string, targetId: string, metadata?: Prisma.InputJsonValue) {
    await this.prisma.auditLog.create({
      data: { adminId, action, targetId, ...(metadata !== undefined ? { metadata } : {}) }
    });
  }

  private async findUser(id: string) {
    const user = await this.prisma.user.findUnique({ where: { id } });
    if (!user) throw new ApiError('NOT_FOUND', '用户不存在', HttpStatus.NOT_FOUND);
    return user;
  }

  async list(query: {
    status?: UserStatusContract;
    search?: string;
    page?: number;
    pageSize?: number;
  }): Promise<AdminUserPageDto> {
    const pageSize = Math.min(Math.max(query.pageSize ?? 20, 1), 200);
    const page = Math.max(query.page ?? 1, 1);
    const search = query.search?.trim();
    const where = {
      ...(query.status ? { status: query.status } : {}),
      ...(search
        ? {
            OR: [
              { openid: { contains: search, mode: 'insensitive' as const } },
              { unionid: { contains: search, mode: 'insensitive' as const } }
            ]
          }
        : {})
    } satisfies Prisma.UserWhereInput;

    const [items, totalCount] = await Promise.all([
      this.prisma.user.findMany({
        where,
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        skip: (page - 1) * pageSize,
        take: pageSize,
        include: USER_INCLUDE
      }),
      this.prisma.user.count({ where })
    ]);

    return {
      items: items.map((user) => this.toSummary(user)),
      nextCursor: null,
      totalCount
    };
  }

  async detail(id: string): Promise<AdminUserDetailDto> {
    const user = await this.prisma.user.findUnique({
      where: { id },
      include: {
        ...USER_INCLUDE,
        collectibles: {
          orderBy: { addedAt: 'desc' },
          take: 20,
          include: { shelf: { select: { name: true } } }
        }
      }
    });
    if (!user) throw new ApiError('NOT_FOUND', '用户不存在', HttpStatus.NOT_FOUND);
    return {
      ...this.toSummary(user),
      ...(user.unionid ? { unionid: user.unionid } : {}),
      collectibleQuota: user.collectibleQuota,
      dailyMattingQuota: user.dailyMattingQuota,
      recentCollectibles: user.collectibles.map((collectible) => ({
        id: collectible.id,
        name: collectible.name,
        shelfName: collectible.shelf.name,
        processingStatus: collectible.processingStatus,
        addedAt: collectible.addedAt.toISOString()
      }))
    };
  }

  /** 封禁：置 SUSPENDED 并撤销其全部会话（refresh token 立即失效，access token 最迟 2 小时自然过期）。 */
  async suspend(adminId: string, id: string) {
    const user = await this.findUser(id);
    if (user.status === UserStatus.SUSPENDED) {
      throw new ApiError('CONFLICT', '该用户已处于封禁状态', HttpStatus.CONFLICT);
    }
    await this.prisma.$transaction([
      this.prisma.user.update({ where: { id }, data: { status: UserStatus.SUSPENDED } }),
      this.prisma.session.updateMany({
        where: { userId: id, revokedAt: null },
        data: { revokedAt: new Date() }
      })
    ]);
    await this.audit(adminId, 'USER_SUSPEND', id);
    return this.detail(id);
  }

  /** 解封：恢复 ACTIVE。 */
  async activate(adminId: string, id: string) {
    const user = await this.findUser(id);
    if (user.status === UserStatus.ACTIVE) {
      throw new ApiError('CONFLICT', '该用户已是正常状态', HttpStatus.CONFLICT);
    }
    await this.prisma.user.update({ where: { id }, data: { status: UserStatus.ACTIVE } });
    await this.audit(adminId, 'USER_ACTIVATE', id);
    return this.detail(id);
  }

  async updateQuota(adminId: string, id: string, input: UpdateUserQuotaInput) {
    await this.findUser(id);
    const data: Prisma.UserUpdateInput = {};
    if (input.storageQuotaBytes !== undefined) data.storageQuotaBytes = BigInt(input.storageQuotaBytes);
    if (input.collectibleQuota !== undefined) data.collectibleQuota = input.collectibleQuota;
    if (input.dailyMattingQuota !== undefined) data.dailyMattingQuota = input.dailyMattingQuota;
    await this.prisma.user.update({ where: { id }, data });
    await this.audit(adminId, 'USER_QUOTA_UPDATE', id, {
      ...(input.storageQuotaBytes !== undefined ? { storageQuotaBytes: input.storageQuotaBytes } : {}),
      ...(input.collectibleQuota !== undefined ? { collectibleQuota: input.collectibleQuota } : {}),
      ...(input.dailyMattingQuota !== undefined ? { dailyMattingQuota: input.dailyMattingQuota } : {})
    });
    return this.detail(id);
  }
}
