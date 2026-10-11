import { Worker } from 'bullmq';
import { Redis } from 'ioredis';
import { config } from './config.js';
import { processScan, reconcileScanEmbeddings, cleanupScans, scanPrisma } from './scan-processor.js';

const connection = new Redis(config.REDIS_URL, { maxRetriesPerRequest: null });
let activeJobs = 0;
const worker = new Worker('bagcollect-scans', async job => {
  activeJobs++;
  try {
    if (job.name === 'scan') await processScan(job.data.scanId);
    else if (job.name === 'reconcile') await reconcileScanEmbeddings(1);
    else throw new Error('Unknown scan job');
  } finally { activeJobs--; }
}, { connection, concurrency: 1, maxStalledCount: 0 });
worker.on('error', error => console.error(JSON.stringify({ event: 'scan_worker_error', error: String(error) })));
worker.on('failed', (job, error) => console.error(JSON.stringify({ event: 'scan_job_failed', id: job?.id, error: String(error) })));
let sweeping = false;
async function sweep() {
  if (sweeping) return;
  sweeping = true;
  try { await cleanupScans(); if (!await worker.isPaused() && activeJobs === 0) await reconcileScanEmbeddings(); }
  catch (error) { console.warn(JSON.stringify({ event: 'scan_sweep_error', error: String(error) })); }
  finally { sweeping = false; }
}
const timer = setInterval(() => void sweep(), 30_000); timer.unref();
void sweep();
async function close() { clearInterval(timer); await worker.close(); await connection.quit(); await scanPrisma.$disconnect(); }
process.once('SIGTERM', () => void close()); process.once('SIGINT', () => void close());
