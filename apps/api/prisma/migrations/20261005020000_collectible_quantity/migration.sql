-- 同款袋子拥有数量：>1 时前端卡片显示 ×N 角标。
-- NOT NULL DEFAULT 1：存量行由数据库默认值直接补成 1，无需回填脚本。
ALTER TABLE "Collectible" ADD COLUMN "quantity" INTEGER NOT NULL DEFAULT 1;
