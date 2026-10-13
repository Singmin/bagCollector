import { Queue } from 'bullmq';
import { Redis } from 'ioredis';

// Run only after stopping the old API, while the old workers still consume jobs.
const connection = new Redis(process.env.REDIS_URL!, { maxRetriesPerRequest: null });
const queue = new Queue('bagcollect-images', { connection });
try {
  const deadline = Date.now() + 120_000;
  while (true) {
    const counts = await queue.getJobCounts('wait', 'active', 'delayed', 'prioritized', 'waiting-children');
    if (Object.values(counts).every(count => count === 0)) break;
    if (Date.now() >= deadline) throw new Error('旧图片队列未排空，停止迁移；请检查 worker 后重新部署');
    console.info('等待旧图片任务完成', counts);
    await new Promise(resolve => setTimeout(resolve, 2000));
  }
} finally {
  await queue.close();
  await connection.quit();
}
