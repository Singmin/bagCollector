-- Preserve the original table/unique key so pre-upgrade server images can still roll back safely.
CREATE TABLE "ScanEmbedding" (
 "id" TEXT PRIMARY KEY, "officialBagId" TEXT NOT NULL REFERENCES "OfficialBag"("id") ON DELETE CASCADE ON UPDATE CASCADE,
 "model" TEXT NOT NULL, "referenceKey" TEXT NOT NULL DEFAULT 'primary', "vector" DOUBLE PRECISION[] NOT NULL,
 "colorVector" DOUBLE PRECISION[] NOT NULL DEFAULT ARRAY[]::DOUBLE PRECISION[], "sourceKind" "AssetKind" NOT NULL,
 "sourceVersion" INTEGER NOT NULL, "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, "updatedAt" TIMESTAMP(3) NOT NULL
);
CREATE UNIQUE INDEX "ScanEmbedding_officialBagId_model_referenceKey_key" ON "ScanEmbedding"("officialBagId", "model", "referenceKey");
CREATE INDEX "ScanEmbedding_model_idx" ON "ScanEmbedding"("model");
INSERT INTO "ScanEmbedding" ("id", "officialBagId", "model", "referenceKey", "vector", "colorVector", "sourceKind", "sourceVersion", "createdAt", "updatedAt")
 SELECT 'scan-' || "id", "officialBagId", "model", 'primary', "vector", "vector", "sourceKind", "sourceVersion", "createdAt", "updatedAt" FROM "BagEmbedding";
CREATE TABLE "BagReferenceImage" (
  "id" TEXT PRIMARY KEY, "officialBagId" TEXT NOT NULL REFERENCES "OfficialBag"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  "objectKey" TEXT NOT NULL UNIQUE, "contentType" TEXT NOT NULL, "version" INTEGER NOT NULL DEFAULT 1,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX "BagReferenceImage_officialBagId_idx" ON "BagReferenceImage"("officialBagId");
CREATE TABLE "MatchScan" (
  "id" TEXT PRIMARY KEY, "userId" TEXT NOT NULL REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  "collectibleId" TEXT NOT NULL, "requestId" TEXT NOT NULL, "source" TEXT NOT NULL, "sourceKey" TEXT NOT NULL,
  "sourceVersion" INTEGER NOT NULL, "crop" JSONB, "model" TEXT NOT NULL, "settings" JSONB NOT NULL,
  "stage" TEXT NOT NULL DEFAULT 'QUEUED', "reason" TEXT, "scores" JSONB NOT NULL DEFAULT '[]', "compared" INTEGER NOT NULL DEFAULT 0,
  "enhancement" TEXT NOT NULL DEFAULT 'NOT_NEEDED', "enhancementIssued" BOOLEAN NOT NULL DEFAULT false,
  "temporaryKeys" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[], "selectedBagId" TEXT, "feedback" TEXT,
  "elapsedMs" INTEGER, "finishedAt" TIMESTAMP(3), "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL
);
CREATE UNIQUE INDEX "MatchScan_userId_requestId_key" ON "MatchScan"("userId", "requestId");
CREATE INDEX "MatchScan_createdAt_idx" ON "MatchScan"("createdAt");
CREATE INDEX "MatchScan_userId_createdAt_idx" ON "MatchScan"("userId", "createdAt");
CREATE TABLE "ScanEnhancementUsage" ("day" TEXT NOT NULL, "scope" TEXT NOT NULL, "count" INTEGER NOT NULL DEFAULT 0, PRIMARY KEY("day", "scope"));
