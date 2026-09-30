import { Worker } from 'bullmq';
import { Redis } from 'ioredis';
import { config } from './config.js';
import {
  claimOfficialBag,
  failOfficialClaim,
  failOfficialProcess,
  processOfficialImage,
  reconcileStuckOfficialProcessing,
  closeOfficialProcessor,
  type OfficialClaimJobData,
  type OfficialProcessJobData
} from './official-processor.js';
import {
  cleanup,
  closeProcessor,
  failProcessing,
  matImage,
  normalizeImage,
  reconcileStuckProcessing,
  type ProcessingJobData
} from './processor.js';

const IMAGE_QUEUE = 'bagcollect-images';
const connection = new Redis(config.REDIS_URL, { maxRetriesPerRequest: null });

const worker = new Worker(
  IMAGE_QUEUE,
  async (job) => {
    if (job.name === 'cleanup') {
      await cleanup((job.data as { keys: string[] }).keys);
      return;
    }
    if (job.name === 'official-process') {
      try {
        await processOfficialImage(job.data as OfficialProcessJobData);
      } catch (error) {
        await failOfficialProcess(job.data as OfficialProcessJobData, error);
        throw error;
      }
      return;
    }
    if (job.name === 'official-claim') {
      try {
        await claimOfficialBag(job.data as OfficialClaimJobData);
      } catch (error) {
        await failOfficialClaim(job.data as OfficialClaimJobData, error);
        throw error;
      }
      return;
    }
    const data = job.data as ProcessingJobData;
    try {
      if (job.name === 'normalize') await normalizeImage(data);
      else if (job.name === 'matting') await matImage(data);
      else throw new Error(`Unknown image job: ${job.name}`);
    } catch (error) {
      await failProcessing(data, error);
      throw error;
    }
  },
  { connection, concurrency: config.WORKER_CONCURRENCY }
);

worker.on('completed', (job) => console.info(JSON.stringify({ event: 'job_completed', id: job.id, name: job.name })));
worker.on('failed', (job, error) => {
  console.error(JSON.stringify({ event: 'job_failed', id: job?.id, name: job?.name, error: error.message }));
  // 处理器 catch 里的 fail* 已经覆盖了常规失败；这里兜的是 stalled：worker 进程在任务
  // 执行中途死掉时处理器 catch 不会执行，BullMQ 把任务移入 failed 后在这里补写状态。
  // 只在 attempts 耗尽时写，避免重试中的第一次失败就把业务状态翻成 FAILED。
  if (!job) return;
  const maxAttempts = job.opts?.attempts ?? 1;
  if (job.attemptsMade < maxAttempts) return;
  const markFailed = (task: Promise<unknown>) =>
    task.catch((markError) =>
      console.error(
        JSON.stringify({
          event: 'mark_failed_error',
          id: job.id,
          name: job.name,
          error: markError instanceof Error ? markError.message : String(markError)
        })
      )
    );
  if (job.name === 'official-process') {
    void markFailed(failOfficialProcess(job.data as OfficialProcessJobData, error));
  } else if (job.name === 'official-claim') {
    void markFailed(failOfficialClaim(job.data as OfficialClaimJobData, error));
  } else if (job.name === 'normalize' || job.name === 'matting') {
    void markFailed(failProcessing(job.data as ProcessingJobData, error));
  }
});

/**
 * 卡死对账：没有 worker 消费时任务会永远停在队列，业务状态永远「处理中」，
 * 前端也会无限轮询。定时把超时的 PROCESSING/NORMALIZING/MATTING 翻成 FAILED，
 * 让后台/用户看到失败原因并手动重试。worker 一旦恢复，排队的任务最终完成时
 * 仍会把状态写回 READY，不会被对账卡住。
 */
async function reconcileStuckJobs() {
  try {
    const stuckBefore = new Date(Date.now() - config.STUCK_PROCESSING_MS);
    await Promise.all([reconcileStuckOfficialProcessing(stuckBefore), reconcileStuckProcessing(stuckBefore)]);
  } catch (error) {
    console.error(
      JSON.stringify({
        event: 'reconcile_error',
        error: error instanceof Error ? error.message : String(error)
      })
    );
  }
}

const reconcileTimer = setInterval(() => void reconcileStuckJobs(), config.RECONCILE_INTERVAL_MS);
reconcileTimer.unref();
void reconcileStuckJobs();

async function shutdown() {
  clearInterval(reconcileTimer);
  await worker.close();
  await connection.quit();
  await closeProcessor();
  await closeOfficialProcessor();
}

process.on('SIGTERM', () => void shutdown());
process.on('SIGINT', () => void shutdown());

console.info(
  JSON.stringify({
    event: 'worker_started',
    concurrency: config.WORKER_CONCURRENCY,
    reconcileIntervalMs: config.RECONCILE_INTERVAL_MS,
    stuckProcessingMs: config.STUCK_PROCESSING_MS
  })
);
