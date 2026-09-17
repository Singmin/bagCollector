import { Controller, Get, HttpStatus, Param, UseGuards } from '@nestjs/common';
import { AuthGuard } from '../auth/auth.guard.js';
import { ApiError } from '../common/api-error.js';
import { CurrentUser, type AuthUser } from '../common/current-user.js';
import { PrismaService } from '../database/prisma.service.js';

@Controller('processing-jobs')
@UseGuards(AuthGuard)
export class JobsController {
  constructor(private readonly prisma: PrismaService) {}

  @Get(':id')
  async detail(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    const job = await this.prisma.processingJob.findFirst({
      where: { id, userId: user.userId },
      select: {
        id: true,
        collectibleId: true,
        type: true,
        status: true,
        attemptCount: true,
        errorMessage: true,
        createdAt: true,
        updatedAt: true
      }
    });
    if (!job) throw new ApiError('NOT_FOUND', '处理任务不存在', HttpStatus.NOT_FOUND);
    return job;
  }
}
