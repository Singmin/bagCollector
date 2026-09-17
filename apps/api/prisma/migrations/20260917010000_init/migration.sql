-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "public";

-- CreateEnum
CREATE TYPE "UserStatus" AS ENUM ('ACTIVE', 'SUSPENDED');
CREATE TYPE "ShelfTheme" AS ENUM ('SAGE', 'AMBER', 'SKY', 'ROSE', 'GRAPHITE');
CREATE TYPE "ProcessingStatus" AS ENUM ('UPLOADING', 'NORMALIZING', 'AWAITING_CROP', 'MATTING', 'READY', 'FAILED');
CREATE TYPE "AssetKind" AS ENUM ('ORIGINAL', 'STANDARD', 'CROPPED', 'CUTOUT', 'DISPLAY', 'THUMBNAIL');
CREATE TYPE "AssetStatus" AS ENUM ('RESERVED', 'AVAILABLE', 'FAILED');
CREATE TYPE "JobType" AS ENUM ('NORMALIZE', 'MATTING', 'CLEANUP');
CREATE TYPE "JobStatus" AS ENUM ('QUEUED', 'RUNNING', 'SUCCEEDED', 'FAILED');

-- CreateTable
CREATE TABLE "User" (
    "id" TEXT NOT NULL,
    "openid" TEXT NOT NULL,
    "unionid" TEXT,
    "status" "UserStatus" NOT NULL DEFAULT 'ACTIVE',
    "storageUsedBytes" BIGINT NOT NULL DEFAULT 0,
    "storageQuotaBytes" BIGINT NOT NULL,
    "collectibleQuota" INTEGER NOT NULL,
    "dailyMattingQuota" INTEGER NOT NULL,
    "lastLoginAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "User_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "Session" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "refreshTokenHash" TEXT NOT NULL,
    "deviceName" TEXT,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "revokedAt" TIMESTAMP(3),
    "lastUsedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "Session_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "Shelf" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "theme" "ShelfTheme" NOT NULL DEFAULT 'SAGE',
    "sortOrder" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "isSystem" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "Shelf_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "Collectible" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "shelfId" TEXT NOT NULL,
    "name" TEXT NOT NULL DEFAULT '未命名收藏',
    "notes" TEXT NOT NULL DEFAULT '',
    "shelfOrder" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "processingStatus" "ProcessingStatus" NOT NULL DEFAULT 'UPLOADING',
    "processingError" TEXT,
    "processingVersion" INTEGER NOT NULL DEFAULT 1,
    "cropX" DOUBLE PRECISION,
    "cropY" DOUBLE PRECISION,
    "cropWidth" DOUBLE PRECISION,
    "cropHeight" DOUBLE PRECISION,
    "cropRotation" INTEGER,
    "addedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "Collectible_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "Tag" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "normalized" TEXT NOT NULL,
    "displayName" TEXT NOT NULL,
    CONSTRAINT "Tag_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "CollectibleTag" (
    "collectibleId" TEXT NOT NULL,
    "tagId" TEXT NOT NULL,
    CONSTRAINT "CollectibleTag_pkey" PRIMARY KEY ("collectibleId","tagId")
);

CREATE TABLE "ImageAsset" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "collectibleId" TEXT NOT NULL,
    "kind" "AssetKind" NOT NULL,
    "status" "AssetStatus" NOT NULL DEFAULT 'RESERVED',
    "objectKey" TEXT NOT NULL,
    "contentType" TEXT NOT NULL,
    "declaredByteSize" BIGINT NOT NULL DEFAULT 0,
    "byteSize" BIGINT NOT NULL DEFAULT 0,
    "reservationExpiresAt" TIMESTAMP(3),
    "width" INTEGER,
    "height" INTEGER,
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "ImageAsset_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "ProcessingJob" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "collectibleId" TEXT NOT NULL,
    "type" "JobType" NOT NULL,
    "status" "JobStatus" NOT NULL DEFAULT 'QUEUED',
    "idempotencyKey" TEXT NOT NULL,
    "attemptCount" INTEGER NOT NULL DEFAULT 0,
    "errorMessage" TEXT,
    "startedAt" TIMESTAMP(3),
    "finishedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "ProcessingJob_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "Admin" (
    "id" TEXT NOT NULL,
    "username" TEXT NOT NULL,
    "passwordHash" TEXT NOT NULL,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "Admin_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "AuditLog" (
    "id" TEXT NOT NULL,
    "adminId" TEXT,
    "userId" TEXT,
    "action" TEXT NOT NULL,
    "targetId" TEXT,
    "metadata" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "AuditLog_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "User_openid_key" ON "User"("openid");
CREATE UNIQUE INDEX "Session_refreshTokenHash_key" ON "Session"("refreshTokenHash");
CREATE INDEX "Session_userId_expiresAt_idx" ON "Session"("userId", "expiresAt");
CREATE INDEX "Shelf_userId_sortOrder_idx" ON "Shelf"("userId", "sortOrder");
CREATE UNIQUE INDEX "Shelf_userId_name_key" ON "Shelf"("userId", "name");
CREATE UNIQUE INDEX "Shelf_id_userId_key" ON "Shelf"("id", "userId");
CREATE INDEX "Collectible_userId_addedAt_idx" ON "Collectible"("userId", "addedAt");
CREATE INDEX "Collectible_userId_shelfId_shelfOrder_idx" ON "Collectible"("userId", "shelfId", "shelfOrder");
CREATE INDEX "Collectible_userId_processingStatus_idx" ON "Collectible"("userId", "processingStatus");
CREATE UNIQUE INDEX "Collectible_id_userId_key" ON "Collectible"("id", "userId");
CREATE UNIQUE INDEX "Tag_userId_normalized_key" ON "Tag"("userId", "normalized");
CREATE INDEX "Tag_userId_idx" ON "Tag"("userId");
CREATE INDEX "CollectibleTag_tagId_idx" ON "CollectibleTag"("tagId");
CREATE UNIQUE INDEX "ImageAsset_objectKey_key" ON "ImageAsset"("objectKey");
CREATE INDEX "ImageAsset_userId_collectibleId_kind_idx" ON "ImageAsset"("userId", "collectibleId", "kind");
CREATE UNIQUE INDEX "ImageAsset_collectibleId_kind_version_key" ON "ImageAsset"("collectibleId", "kind", "version");
CREATE UNIQUE INDEX "ProcessingJob_idempotencyKey_key" ON "ProcessingJob"("idempotencyKey");
CREATE INDEX "ProcessingJob_userId_status_createdAt_idx" ON "ProcessingJob"("userId", "status", "createdAt");
CREATE UNIQUE INDEX "Admin_username_key" ON "Admin"("username");
CREATE INDEX "AuditLog_createdAt_idx" ON "AuditLog"("createdAt");
CREATE INDEX "AuditLog_userId_createdAt_idx" ON "AuditLog"("userId", "createdAt");

-- AddForeignKey
ALTER TABLE "Session" ADD CONSTRAINT "Session_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "Shelf" ADD CONSTRAINT "Shelf_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "Collectible" ADD CONSTRAINT "Collectible_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "Collectible" ADD CONSTRAINT "Collectible_shelfId_userId_fkey" FOREIGN KEY ("shelfId", "userId") REFERENCES "Shelf"("id", "userId") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "Tag" ADD CONSTRAINT "Tag_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "CollectibleTag" ADD CONSTRAINT "CollectibleTag_collectibleId_fkey" FOREIGN KEY ("collectibleId") REFERENCES "Collectible"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "CollectibleTag" ADD CONSTRAINT "CollectibleTag_tagId_fkey" FOREIGN KEY ("tagId") REFERENCES "Tag"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ImageAsset" ADD CONSTRAINT "ImageAsset_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ImageAsset" ADD CONSTRAINT "ImageAsset_collectibleId_userId_fkey" FOREIGN KEY ("collectibleId", "userId") REFERENCES "Collectible"("id", "userId") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ProcessingJob" ADD CONSTRAINT "ProcessingJob_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ProcessingJob" ADD CONSTRAINT "ProcessingJob_collectibleId_userId_fkey" FOREIGN KEY ("collectibleId", "userId") REFERENCES "Collectible"("id", "userId") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "AuditLog" ADD CONSTRAINT "AuditLog_adminId_fkey" FOREIGN KEY ("adminId") REFERENCES "Admin"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "AuditLog" ADD CONSTRAINT "AuditLog_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
