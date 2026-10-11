-- 版本记录增加状态：PLANNED（计划中 / 下期改动）、DONE（已完成）。
-- 存量记录统一回填为 DONE？不 —— 回填成 PLANNED 会把以前已上线的改动标成计划中，
-- 但该表刚上线、尚无存量语义负担，默认 PLANNED 由运营在后台自行标记即可。
CREATE TYPE "ReleaseNoteStatus" AS ENUM ('PLANNED', 'DONE');

ALTER TABLE "ReleaseNote" ADD COLUMN "status" "ReleaseNoteStatus" NOT NULL DEFAULT 'PLANNED';

-- CreateIndex
CREATE INDEX "ReleaseNote_status_createdAt_idx" ON "ReleaseNote"("status", "createdAt");
