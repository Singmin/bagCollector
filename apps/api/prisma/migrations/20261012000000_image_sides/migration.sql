BEGIN;
-- CreateEnum
CREATE TYPE "ImageSide" AS ENUM ('FRONT', 'BACK');

-- Claimed collections now share official assets; deleting their source would lose images.
ALTER TABLE "Collectible" DROP CONSTRAINT "Collectible_sourceOfficialBagId_fkey";
ALTER TABLE "Collectible" ADD CONSTRAINT "Collectible_sourceOfficialBagId_fkey"
FOREIGN KEY ("sourceOfficialBagId") REFERENCES "OfficialBag"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- DropIndex
DROP INDEX "ImageAsset_collectibleId_kind_version_key";

-- DropIndex
DROP INDEX "OfficialBagImage_officialBagId_kind_version_key";

-- AlterTable
ALTER TABLE "ImageAsset" ADD COLUMN     "side" "ImageSide" NOT NULL DEFAULT 'FRONT';

-- AlterTable
ALTER TABLE "ProcessingJob" ADD COLUMN     "side" "ImageSide" NOT NULL DEFAULT 'FRONT',
ADD COLUMN     "sourceVersion" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "version" INTEGER NOT NULL DEFAULT 0;

-- AlterTable
ALTER TABLE "OfficialBagImage" ADD COLUMN     "side" "ImageSide" NOT NULL DEFAULT 'FRONT';

-- CreateTable
CREATE TABLE "CollectibleImageSide" (
    "collectibleId" TEXT NOT NULL,
    "side" "ImageSide" NOT NULL DEFAULT 'FRONT',
    "sourceVersion" INTEGER NOT NULL DEFAULT 0,
    "processingVersion" INTEGER NOT NULL DEFAULT 0,
    "publishedVersion" INTEGER,
    "publishedSourceVersion" INTEGER,
    "mattedSourceVersion" INTEGER,
    "processingStatus" "ProcessingStatus" NOT NULL DEFAULT 'UPLOADING',
    "processingError" TEXT,
    "crop" JSONB,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CollectibleImageSide_pkey" PRIMARY KEY ("collectibleId","side")
);

-- CreateTable
CREATE TABLE "OfficialBagImageSide" (
    "officialBagId" TEXT NOT NULL,
    "side" "ImageSide" NOT NULL DEFAULT 'FRONT',
    "sourceVersion" INTEGER NOT NULL DEFAULT 0,
    "processingVersion" INTEGER NOT NULL DEFAULT 0,
    "publishedVersion" INTEGER,
    "publishedSourceVersion" INTEGER,
    "processingStatus" "OfficialProcessStatus" NOT NULL DEFAULT 'PENDING',
    "processingError" TEXT,
    "matting" BOOLEAN NOT NULL DEFAULT false,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "OfficialBagImageSide_pkey" PRIMARY KEY ("officialBagId","side")
);

-- CreateIndex
CREATE INDEX "CollectibleImageSide_processingStatus_updatedAt_idx" ON "CollectibleImageSide"("processingStatus", "updatedAt");

-- CreateIndex
CREATE INDEX "OfficialBagImageSide_processingStatus_updatedAt_idx" ON "OfficialBagImageSide"("processingStatus", "updatedAt");

-- CreateIndex
CREATE UNIQUE INDEX "ImageAsset_collectibleId_kind_side_version_key" ON "ImageAsset"("collectibleId", "kind", "side", "version");

-- CreateIndex
CREATE UNIQUE INDEX "OfficialBagImage_officialBagId_kind_side_version_key" ON "OfficialBagImage"("officialBagId", "kind", "side", "version");

-- AddForeignKey
ALTER TABLE "CollectibleImageSide" ADD CONSTRAINT "CollectibleImageSide_collectibleId_fkey" FOREIGN KEY ("collectibleId") REFERENCES "Collectible"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OfficialBagImageSide" ADD CONSTRAINT "OfficialBagImageSide_officialBagId_fkey" FOREIGN KEY ("officialBagId") REFERENCES "OfficialBag"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Restore only genuine claims; promotion alone must never make an upload read-only.
UPDATE "Collectible" c SET "sourceOfficialBagId" = oc."officialBagId"
FROM "OfficialClaim" oc JOIN "OfficialBag" b ON b.id = oc."officialBagId"
WHERE oc."collectibleId" = c.id AND oc."userId" = c."userId"
  AND c."sourceOfficialBagId" IS NULL AND c."promotedBagId" IS NULL;

-- Referenced claims no longer consume user image quota. Preserve object paths
-- as archived records; deletion still cleans their keys, without a second refund.
UPDATE "User" u SET "storageUsedBytes" = GREATEST(0, u."storageUsedBytes" - copied.bytes)
FROM (SELECT a."userId", SUM(a."byteSize") bytes FROM "ImageAsset" a
      JOIN "Collectible" c ON c.id = a."collectibleId"
      WHERE c."sourceOfficialBagId" IS NOT NULL AND a.status = 'AVAILABLE'
      GROUP BY a."userId") copied WHERE copied."userId" = u.id;
UPDATE "ImageAsset" a SET status = 'FAILED'
FROM "Collectible" c WHERE c.id = a."collectibleId" AND c."sourceOfficialBagId" IS NOT NULL;

INSERT INTO "CollectibleImageSide" ("collectibleId", side, "sourceVersion", "processingVersion", "publishedVersion", "mattedSourceVersion", "processingStatus", "processingError", crop, "updatedAt")
SELECT c.id, 'FRONT', COALESCE(src.v, 0), GREATEST(c."processingVersion", COALESCE(src.v, 0)), pub.v,
  CASE WHEN EXISTS (SELECT 1 FROM "ImageAsset" a WHERE a."collectibleId" = c.id AND a.kind = 'CUTOUT' AND a.status = 'AVAILABLE') THEN src.v END,
  c."processingStatus", c."processingError",
  CASE WHEN c."cropX" IS NOT NULL THEN jsonb_build_object('x', c."cropX", 'y', COALESCE(c."cropY", 0), 'width', COALESCE(c."cropWidth", 1), 'height', COALESCE(c."cropHeight", 1), 'rotation', COALESCE(c."cropRotation", 0), 'brightness', COALESCE(c."cropBrightness", 1), 'contrast', COALESCE(c."cropContrast", 1), 'saturation', COALESCE(c."cropSaturation", 1)) END,
  c."updatedAt"
FROM "Collectible" c
LEFT JOIN LATERAL (SELECT MAX(version) v FROM "ImageAsset" WHERE "collectibleId" = c.id AND kind IN ('ORIGINAL', 'STANDARD') AND status = 'AVAILABLE') src ON true
LEFT JOIN LATERAL (SELECT MAX(d.version) v FROM "ImageAsset" d JOIN "ImageAsset" t ON t."collectibleId" = d."collectibleId" AND t.version = d.version AND t.kind = 'THUMBNAIL' AND t.status = 'AVAILABLE' WHERE d."collectibleId" = c.id AND d.kind = 'DISPLAY' AND d.status = 'AVAILABLE') pub ON true
WHERE c."sourceOfficialBagId" IS NULL;

INSERT INTO "OfficialBagImageSide" ("officialBagId", side, "sourceVersion", "processingVersion", "publishedVersion", "processingStatus", "processingError", matting, "updatedAt")
SELECT b.id, 'FRONT', COALESCE(src.v, 0), b.version, pub.v, b."processStatus", b."processError", b.matting, b."updatedAt"
FROM "OfficialBag" b
LEFT JOIN LATERAL (SELECT MAX(version) v FROM "OfficialBagImage" WHERE "officialBagId" = b.id AND kind IN ('ORIGINAL', 'STANDARD') AND status = 'AVAILABLE') src ON true
LEFT JOIN LATERAL (SELECT MAX(d.version) v FROM "OfficialBagImage" d JOIN "OfficialBagImage" t ON t."officialBagId" = d."officialBagId" AND t.version = d.version AND t.kind = 'THUMBNAIL' AND t.status = 'AVAILABLE' WHERE d."officialBagId" = b.id AND d.kind = 'DISPLAY' AND d.status = 'AVAILABLE') pub ON true;

UPDATE "Collectible" c SET "processingStatus" = 'READY'
WHERE c."sourceOfficialBagId" IS NOT NULL OR EXISTS (SELECT 1 FROM "CollectibleImageSide" s WHERE s."collectibleId" = c.id AND s.side = 'FRONT' AND s."publishedVersion" IS NOT NULL);
UPDATE "OfficialBag" b SET "processStatus" = 'READY'
WHERE EXISTS (SELECT 1 FROM "OfficialBagImageSide" s WHERE s."officialBagId" = b.id AND s.side = 'FRONT' AND s."publishedVersion" IS NOT NULL);

UPDATE "CollectibleImageSide" SET "publishedSourceVersion" = "sourceVersion" WHERE "publishedVersion" IS NOT NULL;
UPDATE "OfficialBagImageSide" SET "publishedSourceVersion" = "sourceVersion" WHERE "publishedVersion" IS NOT NULL;

COMMIT;
