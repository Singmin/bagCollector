-- 裁剪与抠图拆成两条流水线：
--   1) 新增处理中状态 CROPPING（裁剪任务进行中），不再借用 MATTING 表达「在裁剪」
--   2) 新增任务类型 CROP（对应 POST /collectibles/:id/crop），MATTING 只服务 POST /collectibles/:id/matte
-- 注意：Postgres 的 ALTER TYPE ... ADD VALUE 不能在同一事务里使用新值，
-- 这两条语句只加枚举值、不读写数据，可以安全地在迁移事务中执行（PG 12+）。

ALTER TYPE "ProcessingStatus" ADD VALUE IF NOT EXISTS 'CROPPING' AFTER 'AWAITING_CROP';

ALTER TYPE "JobType" ADD VALUE IF NOT EXISTS 'CROP' AFTER 'NORMALIZE';
