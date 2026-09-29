-- 官方袋子库：管理后台维护的公共藏品，供发现页展示并允许用户「拥有」到自己的收藏夹。
CREATE TYPE "OfficialBagStatus" AS ENUM ('DRAFT', 'PUBLISHED', 'OFFLINE');
CREATE TYPE "OfficialProcessStatus" AS ENUM ('PENDING', 'PROCESSING', 'READY', 'FAILED');

-- CreateTable
CREATE TABLE "OfficialBag" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "brand" TEXT,
    "notes" TEXT NOT NULL DEFAULT '',
    "tags" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
    "matting" BOOLEAN NOT NULL DEFAULT false,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "status" "OfficialBagStatus" NOT NULL DEFAULT 'DRAFT',
    "processStatus" "OfficialProcessStatus" NOT NULL DEFAULT 'PENDING',
    "processError" TEXT,
    "version" INTEGER NOT NULL DEFAULT 0,
    "claimedCount" INTEGER NOT NULL DEFAULT 0,
    "publishedAt" TIMESTAMP(3),
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "OfficialBag_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "OfficialBagImage" (
    "id" TEXT NOT NULL,
    "officialBagId" TEXT NOT NULL,
    "kind" "AssetKind" NOT NULL,
    "status" "AssetStatus" NOT NULL DEFAULT 'AVAILABLE',
    "objectKey" TEXT NOT NULL,
    "contentType" TEXT NOT NULL,
    "declaredByteSize" BIGINT NOT NULL DEFAULT 0,
    "byteSize" BIGINT NOT NULL DEFAULT 0,
    "width" INTEGER,
    "height" INTEGER,
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "OfficialBagImage_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "OfficialClaim" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "officialBagId" TEXT NOT NULL,
    "collectibleId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "OfficialClaim_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "OfficialBag_status_sortOrder_idx" ON "OfficialBag"("status", "sortOrder");

-- CreateIndex
CREATE UNIQUE INDEX "OfficialBagImage_objectKey_key" ON "OfficialBagImage"("objectKey");

-- CreateIndex
CREATE UNIQUE INDEX "OfficialBagImage_officialBagId_kind_version_key" ON "OfficialBagImage"("officialBagId", "kind", "version");

-- CreateIndex
CREATE INDEX "OfficialBagImage_officialBagId_kind_idx" ON "OfficialBagImage"("officialBagId", "kind");

-- CreateIndex
CREATE UNIQUE INDEX "OfficialClaim_userId_officialBagId_key" ON "OfficialClaim"("userId", "officialBagId");

-- CreateIndex
CREATE INDEX "OfficialClaim_userId_createdAt_idx" ON "OfficialClaim"("userId", "createdAt");

-- AddForeignKey
ALTER TABLE "OfficialBag" ADD CONSTRAINT "OfficialBag_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "Admin"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OfficialBagImage" ADD CONSTRAINT "OfficialBagImage_officialBagId_fkey" FOREIGN KEY ("officialBagId") REFERENCES "OfficialBag"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OfficialClaim" ADD CONSTRAINT "OfficialClaim_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OfficialClaim" ADD CONSTRAINT "OfficialClaim_officialBagId_fkey" FOREIGN KEY ("officialBagId") REFERENCES "OfficialBag"("id") ON DELETE CASCADE ON UPDATE CASCADE;
