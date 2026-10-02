-- DropIndex
DROP INDEX "OfficialBag_brandId_idx";

-- AlterTable
ALTER TABLE "Collectible" ADD COLUMN     "cropBrightness" DOUBLE PRECISION,
ADD COLUMN     "cropContrast" DOUBLE PRECISION,
ADD COLUMN     "cropSaturation" DOUBLE PRECISION,
ALTER COLUMN "cropRotation" SET DATA TYPE DOUBLE PRECISION;
