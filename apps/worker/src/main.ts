import { Worker } from 'bullmq';
import { Redis } from 'ioredis';
import { config } from './config.js';
import { cleanup, closeProcessor, failProcessing, matImage, normalizeImage, type ProcessingJobData } from './processor.js';

const IMAGE_QUEUE = 'bagcollect-images';
const connection = new Redis(config.REDIS_URL, { maxRetriesPerRequest: null });

const worker = new Worker(
  IMAGE_QUEUE,
  async (job) => {
    if (job.name === 'cleanup') {
      await cleanup((job.data as { keys: string[] }).keys);
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
worker.on('failed', (job, error) =>
  console.error(JSON.stringify({ event: 'job_failed', id: job?.id, name: job?.name, error: error.message }))
);

async function shutdown() {
  await worker.close();
  await connection.quit();
  await closeProcessor();
}

process.on('SIGTERM', () => void shutdown());
process.on('SIGINT', () => void shutdown());

console.info(JSON.stringify({ event: 'worker_started', concurrency: config.WORKER_CONCURRENCY }));
