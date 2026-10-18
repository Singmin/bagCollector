-- 白边开关：新增「无白边」展示图/缩略图资产类型 + 用户级白边偏好。
-- 1) AssetKind 增加 DISPLAY_PLAIN / THUMBNAIL_PLAIN（无白边版展示图/缩略图）；
-- 2) User 增加 whiteStrokeEnabled（默认 false = 不显示白边）。
-- 注意：ALTER TYPE ... ADD VALUE 不能在同一事务里使用新值，
-- 这里只加枚举值、不读写数据，可安全地在迁移事务中执行（PG 12+）。

ALTER TYPE "AssetKind" ADD VALUE IF NOT EXISTS 'DISPLAY_PLAIN' AFTER 'THUMBNAIL';
ALTER TYPE "AssetKind" ADD VALUE IF NOT EXISTS 'THUMBNAIL_PLAIN' AFTER 'DISPLAY_PLAIN';

ALTER TABLE "User" ADD COLUMN "whiteStrokeEnabled" BOOLEAN NOT NULL DEFAULT false;
