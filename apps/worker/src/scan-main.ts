import { Queue, Worker } from 'bullmq';
import { Redis } from 'ioredis';
import { config } from './config.js';
import { processScan, reconcileScanEmbeddings, cleanupScans, scanPrisma } from './scan-processor.js';
import { cleanupLearningSamples, computeLearningSample } from './learning-processor.js';

const connection = new Redis(config.REDIS_URL, { maxRetriesPerRequest: null });
const queue = new Queue('bagcollect-scans', { connection });
const worker = new Worker('bagcollect-scans', async job => {
    if (job.name === 'scan') await processScan(job.data.scanId);
    else if (job.name === 'reconcile') {
      const result = await reconcileScanEmbeddings(1, 1);
      if (result.more) await queue.add('reconcile', {}, { priority: 20, attempts: 1, removeOnComplete: 20, removeOnFail: 20 });
    }
    else if (job.name === 'learning') await computeLearningSample(job.data.sampleId);
    else throw new Error('Unknown scan job');
}, { connection, concurrency: 1, maxStalledCount: 0 });
worker.on('error', error => console.error(JSON.stringify({ event: 'scan_worker_error', error: String(error) })));
worker.on('failed', (job, error) => console.error(JSON.stringify({ event: 'scan_job_failed', id: job?.id, error: String(error) })));
let sweeping = false;
async function sweep() {
  if (sweeping) return;
  sweeping = true;
  try {
    await cleanupScans(); await cleanupLearningSamples();
    // All inference runs through one consumer; never infer directly from the timer.
    if (!await worker.isPaused()) {
      await queue.add('reconcile', {}, { jobId: 'background-reconcile', priority: 20, attempts: 1, removeOnComplete: true, removeOnFail: true });
      const samples = await scanPrisma.learningSample.findMany({ where: { state: 'PENDING', featureState: { in: ['QUEUED', 'FAILED'] },
        OR: [{ retryAt: null }, { retryAt: { lte: new Date() } }] }, orderBy: { createdAt: 'asc' }, take: 20 });
      for (const sample of samples) await queue.add('learning', { sampleId: sample.id }, { jobId: `learning-${sample.id}`, priority: 10, attempts: 1, removeOnComplete: true, removeOnFail: true });
    }
  }
  catch (error) { console.warn(JSON.stringify({ event: 'scan_sweep_error', error: String(error) })); }
  finally { sweeping = false; }
}
const timer = setInterval(() => void sweep(), 30_000); timer.unref();
void sweep();
async function close() { clearInterval(timer); await worker.close(); await queue.close(); await connection.quit(); await scanPrisma.$disconnect(); }
process.once('SIGTERM', () => void close()); process.once('SIGINT', () => void close());
