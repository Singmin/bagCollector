-- 品牌展示图：存 COS objectKey（key 自带 v{n} 版本，替换时换 key 避免 CDN 缓存）。

ALTER TABLE "Brand" ADD COLUMN "displayImageKey" TEXT;
ALTER TABLE "Brand" ADD COLUMN "displayImageVersion" INTEGER NOT NULL DEFAULT 0;
