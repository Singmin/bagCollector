-- 版本改动记录 + 留言 + 下期计划（管理后台「版本改动」菜单）。
-- ReleaseNote：每次发版一条；ReleaseComment：挂在其下的留言；PlanItem：下期待办。
CREATE TABLE "ReleaseNote" (
    "id" TEXT NOT NULL,
    "version" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "content" TEXT NOT NULL DEFAULT '',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "createdById" TEXT,
    CONSTRAINT "ReleaseNote_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "ReleaseComment" (
    "id" TEXT NOT NULL,
    "releaseNoteId" TEXT NOT NULL,
    "authorName" TEXT NOT NULL,
    "content" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "ReleaseComment_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "PlanItem" (
    "id" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "done" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "createdById" TEXT,
    CONSTRAINT "PlanItem_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ReleaseNote_createdAt_idx" ON "ReleaseNote"("createdAt");

-- CreateIndex
CREATE INDEX "ReleaseComment_releaseNoteId_createdAt_idx" ON "ReleaseComment"("releaseNoteId", "createdAt");

-- CreateIndex
CREATE INDEX "PlanItem_done_createdAt_idx" ON "PlanItem"("done", "createdAt");

-- AddForeignKey
ALTER TABLE "ReleaseNote" ADD CONSTRAINT "ReleaseNote_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "Admin"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ReleaseComment" ADD CONSTRAINT "ReleaseComment_releaseNoteId_fkey" FOREIGN KEY ("releaseNoteId") REFERENCES "ReleaseNote"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PlanItem" ADD CONSTRAINT "PlanItem_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "Admin"("id") ON DELETE SET NULL ON UPDATE CASCADE;
