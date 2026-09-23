import { Injectable, OnModuleDestroy } from '@nestjs/common';
import { Queue } from 'bullmq';
import { Redis } from 'ioredis';
import { env } from './env.js';
import { IMAGE_QUEUE, type ImageJobName } from './queue.js';

@Injectable()
export class QueueService implements OnModuleDestroy {
  private readonly connection = new Redis(env().REDIS_URL, { maxRetriesPerRequest: null });
  readonly images = new Queue(IMAGE_QUEUE, { connection: this.connection });

  async add(name: ImageJobName, data: object, jobId?: string) {
    const isCleanup = name === 'cleanup';
    return this.images.add(name, data, {
      ...(jobId ? { jobId } : {}),
      attempts: isCleanup ? 3 : 1,
      ...(isCleanup ? { backoff: { type: 'exponential' as const, delay: 2_000 } } : {}),
      removeOnComplete: 500,
      removeOnFail: 1_000
    });
  }

  async onModuleDestroy() {
    await this.images.close();
    await this.connection.quit();
  }
}
