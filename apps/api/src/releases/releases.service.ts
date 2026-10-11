import { HttpStatus, Injectable } from '@nestjs/common';
import type {
  CreatePlanItemInput,
  CreateReleaseCommentInput,
  CreateReleaseInput,
  PlanItemDto,
  ReleaseCommentDto,
  ReleaseNoteDto,
  ReleaseNotePageDto,
  ReleaseNoteStatus,
  UpdatePlanItemInput,
  UpdateReleaseInput
} from '@bagcollect/contracts';
import { ApiError } from '../common/api-error.js';
import { PrismaService } from '../database/prisma.service.js';

const PAGE_MAX = 200;

/**
 * 「版本改动」功能：版本记录（ReleaseNote）+ 留言（ReleaseComment）+ 下期计划（PlanItem）。
 *
 * 这套东西只给运营/管理自己用，改动不会影响任何用户侧链路；
 * 唯一要留意的约定是留言作者存的是名字快照，管理员账号删除后历史留言仍然可读。
 */
@Injectable()
export class ReleasesService {
  constructor(private readonly prisma: PrismaService) {}

  /* ------------------------------ 版本记录 ------------------------------ */

  async listReleases(query: {
    status?: ReleaseNoteStatus;
    page?: number;
    pageSize?: number;
  }): Promise<ReleaseNotePageDto> {
    const pageSize = Math.min(Math.max(query.pageSize ?? 20, 1), PAGE_MAX);
    const currentPage = Math.max(query.page ?? 1, 1);
    const where = query.status ? { status: query.status } : undefined;
    const [items, totalCount] = await Promise.all([
      this.prisma.releaseNote.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip: (currentPage - 1) * pageSize,
        take: pageSize,
        include: { _count: { select: { comments: true } } }
      }),
      this.prisma.releaseNote.count({ where })
    ]);
    return {
      items: items.map((note) => ({
        id: note.id,
        version: note.version,
        title: note.title,
        content: note.content,
        status: note.status,
        commentCount: note._count.comments,
        createdAt: note.createdAt.toISOString(),
        updatedAt: note.updatedAt.toISOString()
      })),
      totalCount
    };
  }

  async createRelease(adminId: string, input: CreateReleaseInput): Promise<ReleaseNoteDto> {
    const note = await this.prisma.releaseNote.create({
      data: {
        version: input.version,
        title: input.title,
        content: input.content ?? '',
        status: input.status ?? 'PLANNED',
        createdById: adminId
      },
      include: { _count: { select: { comments: true } } }
    });
    return this.toReleaseNoteDto(note);
  }

  async updateRelease(id: string, input: UpdateReleaseInput): Promise<ReleaseNoteDto> {
    const existing = await this.prisma.releaseNote.findUnique({ where: { id } });
    if (!existing) throw new ApiError('NOT_FOUND', '版本记录不存在', HttpStatus.NOT_FOUND);
    const note = await this.prisma.releaseNote.update({
      where: { id },
      data: {
        ...(input.version !== undefined ? { version: input.version } : {}),
        ...(input.title !== undefined ? { title: input.title } : {}),
        ...(input.content !== undefined ? { content: input.content } : {}),
        ...(input.status !== undefined ? { status: input.status } : {})
      },
      include: { _count: { select: { comments: true } } }
    });
    return this.toReleaseNoteDto(note);
  }

  async deleteRelease(id: string): Promise<{ ok: true }> {
    const existing = await this.prisma.releaseNote.findUnique({ where: { id } });
    if (!existing) throw new ApiError('NOT_FOUND', '版本记录不存在', HttpStatus.NOT_FOUND);
    // 留言由外键级联删除。
    await this.prisma.releaseNote.delete({ where: { id } });
    return { ok: true };
  }

  /* -------------------------------- 留言 -------------------------------- */

  async listComments(releaseNoteId: string): Promise<ReleaseCommentDto[]> {
    const comments = await this.prisma.releaseComment.findMany({
      where: { releaseNoteId },
      orderBy: { createdAt: 'asc' }
    });
    return comments.map((comment) => ({
      id: comment.id,
      authorName: comment.authorName,
      content: comment.content,
      createdAt: comment.createdAt.toISOString()
    }));
  }

  async createComment(
    releaseNoteId: string,
    adminId: string,
    input: CreateReleaseCommentInput
  ): Promise<ReleaseCommentDto> {
    const [note, admin] = await Promise.all([
      this.prisma.releaseNote.findUnique({ where: { id: releaseNoteId } }),
      this.prisma.admin.findUnique({ where: { id: adminId } })
    ]);
    if (!note) throw new ApiError('NOT_FOUND', '版本记录不存在', HttpStatus.NOT_FOUND);
    const comment = await this.prisma.releaseComment.create({
      data: {
        releaseNoteId,
        authorName: admin?.username ?? '管理员',
        content: input.content
      }
    });
    return {
      id: comment.id,
      authorName: comment.authorName,
      content: comment.content,
      createdAt: comment.createdAt.toISOString()
    };
  }

  async deleteComment(releaseNoteId: string, commentId: string): Promise<{ ok: true }> {
    const existing = await this.prisma.releaseComment.findFirst({
      where: { id: commentId, releaseNoteId }
    });
    if (!existing) throw new ApiError('NOT_FOUND', '留言不存在', HttpStatus.NOT_FOUND);
    await this.prisma.releaseComment.delete({ where: { id: commentId } });
    return { ok: true };
  }

  /* ------------------------------ 下期计划 ------------------------------ */

  async listPlans(): Promise<PlanItemDto[]> {
    const items = await this.prisma.planItem.findMany({
      orderBy: [{ done: 'asc' }, { createdAt: 'desc' }]
    });
    return items.map((item) => ({
      id: item.id,
      title: item.title,
      done: item.done,
      createdAt: item.createdAt.toISOString(),
      updatedAt: item.updatedAt.toISOString()
    }));
  }

  async createPlan(adminId: string, input: CreatePlanItemInput): Promise<PlanItemDto> {
    const item = await this.prisma.planItem.create({
      data: { title: input.title, createdById: adminId }
    });
    return {
      id: item.id,
      title: item.title,
      done: item.done,
      createdAt: item.createdAt.toISOString(),
      updatedAt: item.updatedAt.toISOString()
    };
  }

  async updatePlan(id: string, input: UpdatePlanItemInput): Promise<PlanItemDto> {
    const existing = await this.prisma.planItem.findUnique({ where: { id } });
    if (!existing) throw new ApiError('NOT_FOUND', '计划项不存在', HttpStatus.NOT_FOUND);
    const item = await this.prisma.planItem.update({
      where: { id },
      data: {
        ...(input.title !== undefined ? { title: input.title } : {}),
        ...(input.done !== undefined ? { done: input.done } : {})
      }
    });
    return {
      id: item.id,
      title: item.title,
      done: item.done,
      createdAt: item.createdAt.toISOString(),
      updatedAt: item.updatedAt.toISOString()
    };
  }

  async deletePlan(id: string): Promise<{ ok: true }> {
    const existing = await this.prisma.planItem.findUnique({ where: { id } });
    if (!existing) throw new ApiError('NOT_FOUND', '计划项不存在', HttpStatus.NOT_FOUND);
    await this.prisma.planItem.delete({ where: { id } });
    return { ok: true };
  }

  private toReleaseNoteDto(note: {
    id: string;
    version: string;
    title: string;
    content: string;
    status: ReleaseNoteStatus;
    createdAt: Date;
    updatedAt: Date;
    _count: { comments: number };
  }): ReleaseNoteDto {
    return {
      id: note.id,
      version: note.version,
      title: note.title,
      content: note.content,
      status: note.status,
      commentCount: note._count.comments,
      createdAt: note.createdAt.toISOString(),
      updatedAt: note.updatedAt.toISOString()
    };
  }
}
