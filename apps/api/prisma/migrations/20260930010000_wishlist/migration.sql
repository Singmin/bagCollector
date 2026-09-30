-- 心愿袋：用户对官方袋子的「想要」标记（发现页 ♥ 按钮与收藏架「心愿袋」分段）。
-- 同一用户对同一袋子只能有一条记录（唯一约束兜底并发重复加入）。

CREATE TABLE "WishlistItem" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "officialBagId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "WishlistItem_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "WishlistItem_userId_officialBagId_key" ON "WishlistItem"("userId", "officialBagId");

CREATE INDEX "WishlistItem_userId_createdAt_idx" ON "WishlistItem"("userId", "createdAt");

ALTER TABLE "WishlistItem" ADD CONSTRAINT "WishlistItem_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "WishlistItem" ADD CONSTRAINT "WishlistItem_officialBagId_fkey" FOREIGN KEY ("officialBagId") REFERENCES "OfficialBag"("id") ON DELETE CASCADE ON UPDATE CASCADE;
