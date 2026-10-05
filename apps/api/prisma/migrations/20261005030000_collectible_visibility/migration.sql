-- 收藏可见性：私密收藏 / 公开展示。
-- 存量数据默认公开（DEFAULT 'PUBLIC' 直接补齐存量行）。
CREATE TYPE "Visibility" AS ENUM ('PRIVATE', 'PUBLIC');
ALTER TABLE "Collectible" ADD COLUMN "visibility" "Visibility" NOT NULL DEFAULT 'PUBLIC';
