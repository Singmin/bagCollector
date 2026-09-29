-- 品牌独立成表：管理后台可增删改查品牌，袋子通过 brandId 关联。
-- 存量袋子的 brand 文本自动建为品牌记录并关联；brandId 置空（SetNull）删除品牌时袋子保留。

CREATE TABLE "Brand" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "Brand_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "Brand_name_key" ON "Brand"("name");

ALTER TABLE "OfficialBag" ADD COLUMN "brandId" TEXT;

-- 回填：把现有非空 brand 文本逐个建为品牌。
INSERT INTO "Brand" ("id", "name", "sortOrder", "createdAt", "updatedAt")
SELECT gen_random_uuid()::text, "name", 0, now(), now()
FROM (
    SELECT DISTINCT btrim("brand") AS "name"
    FROM "OfficialBag"
    WHERE "brand" IS NOT NULL AND btrim("brand") <> ''
) AS distinct_brands;

UPDATE "OfficialBag"
SET "brandId" = "Brand"."id"
FROM "Brand"
WHERE "OfficialBag"."brand" = "Brand"."name";

ALTER TABLE "OfficialBag" DROP COLUMN "brand";

CREATE INDEX "OfficialBag_brandId_idx" ON "OfficialBag"("brandId");

ALTER TABLE "OfficialBag" ADD CONSTRAINT "OfficialBag_brandId_fkey" FOREIGN KEY ("brandId") REFERENCES "Brand"("id") ON DELETE SET NULL ON UPDATE CASCADE;
