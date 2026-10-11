import { Injectable, OnModuleDestroy } from '@nestjs/common';
import { Queue } from 'bullmq';
import { Redis } from 'ioredis';
import { env } from './env.js';
import { IMAGE_QUEUE, type ImageJobName } from './queue.js';

@Injectable()
export class QueueService implements OnModuleDestroy {
  private readonly connection = new Redis(env().REDIS_URL, { maxRetriesPerRequest: null });
  readonly images = new Queue(IMAGE_QUEUE, { connection: this.connection });
  readonly scans = new Queue('bagcollect-scans', { connection: this.connection });

  async addScan(scanId: string) {
    return this.scans.add('scan', { scanId }, { jobId: scanId, attempts: 1, removeOnComplete: 500, removeOnFail: 1000 });
  }

  async add(name: ImageJobName, data: object, jobId?: string) {
    // cleanup 与 official-claim 是纯复制/删除操作，可安全重试；
    // normalize/matting/official-process 涉及万象抠图按次计费，失败不自动重跑，
    // 由管理后台或用户手动重新触发。
    const retryable = name === 'cleanup' || name === 'official-claim';
    return this.images.add(name, data, {
      ...(jobId ? { jobId } : {}),
      attempts: retryable ? 3 : 1,
      ...(retryable ? { backoff: { type: 'exponential' as const, delay: 2_000 } } : {}),
      removeOnComplete: 500,
      removeOnFail: 1_000
    });
  }

  async onModuleDestroy() {
    await this.images.close();
    await this.scans.close();
    await this.connection.quit();
  }
}
