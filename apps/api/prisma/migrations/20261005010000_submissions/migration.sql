-- 审核后台：用户上传袋子纳入官方袋子。给 Collectible 增加审核状态与「纳入」回链。
CREATE TYPE "SubmissionStatus" AS ENUM ('PENDING', 'APPROVED', 'REJECTED');

-- AlterTable
ALTER TABLE "Collectible"
ADD COLUMN "submissionStatus" "SubmissionStatus" NOT NULL DEFAULT 'PENDING',
ADD COLUMN "reviewNote" TEXT,
ADD COLUMN "reviewedById" TEXT,
ADD COLUMN "reviewedAt" TIMESTAMP(3),
ADD COLUMN "promotedBagId" TEXT;

-- CreateIndex
CREATE UNIQUE INDEX "Collectible_promotedBagId_key" ON "Collectible"("promotedBagId");

-- CreateIndex
CREATE INDEX "Collectible_submissionStatus_addedAt_idx" ON "Collectible"("submissionStatus", "addedAt");

-- AddForeignKey
ALTER TABLE "Collectible" ADD CONSTRAINT "Collectible_reviewedById_fkey" FOREIGN KEY ("reviewedById") REFERENCES "Admin"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Collectible" ADD CONSTRAINT "Collectible_promotedBagId_fkey" FOREIGN KEY ("promotedBagId") REFERENCES "OfficialBag"("id") ON DELETE SET NULL ON UPDATE CASCADE;
