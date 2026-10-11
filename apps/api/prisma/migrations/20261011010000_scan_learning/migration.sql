CREATE TABLE "LearningSample" (
 "id" TEXT NOT NULL PRIMARY KEY, "scanId" TEXT, "userId" TEXT, "officialBagId" TEXT,
 "referenceId" TEXT, "origin" TEXT NOT NULL DEFAULT 'SCAN', "source" TEXT NOT NULL,
 "model" TEXT NOT NULL, "snapshot" JSONB NOT NULL, "objectKey" TEXT,
 "byteSize" BIGINT NOT NULL DEFAULT 0 CHECK ("byteSize" >= 0), "hash" TEXT,
 "state" TEXT NOT NULL DEFAULT 'STAGING', "featureState" TEXT NOT NULL DEFAULT 'WAITING_LABEL',
 "reason" TEXT, "possibleDuplicate" TEXT, "expiresAt" TIMESTAMP(3), "deletedAt" TIMESTAMP(3),
 "reviewedById" TEXT, "reviewedAt" TIMESTAMP(3), "attempts" INTEGER NOT NULL DEFAULT 0,
 "retryAt" TIMESTAMP(3), "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
 "updatedAt" TIMESTAMP(3) NOT NULL
);
CREATE UNIQUE INDEX "LearningSample_scanId_key" ON "LearningSample"("scanId");
CREATE UNIQUE INDEX "LearningSample_referenceId_key" ON "LearningSample"("referenceId");
CREATE UNIQUE INDEX "LearningSample_objectKey_key" ON "LearningSample"("objectKey");
CREATE INDEX "LearningSample_state_expiresAt_idx" ON "LearningSample"("state", "expiresAt");
CREATE INDEX "LearningSample_officialBagId_hash_idx" ON "LearningSample"("officialBagId", "hash");
CREATE INDEX "LearningSample_featureState_retryAt_idx" ON "LearningSample"("featureState", "retryAt");
CREATE TABLE "LearningSampleFeature" (
 "id" TEXT NOT NULL PRIMARY KEY, "sampleId" TEXT NOT NULL, "model" TEXT NOT NULL,
 "vector" DOUBLE PRECISION[] NOT NULL, "colorVector" DOUBLE PRECISION[] NOT NULL,
 CONSTRAINT "LearningSampleFeature_sampleId_fkey" FOREIGN KEY ("sampleId") REFERENCES "LearningSample"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "LearningSampleFeature_sampleId_model_key" ON "LearningSampleFeature"("sampleId", "model");
INSERT INTO "AppSetting" ("key", "value", "updatedAt") VALUES
 ('learning.settings', '{"enabled":false,"budgetBytes":1073741824}', CURRENT_TIMESTAMP) ON CONFLICT ("key") DO NOTHING;
