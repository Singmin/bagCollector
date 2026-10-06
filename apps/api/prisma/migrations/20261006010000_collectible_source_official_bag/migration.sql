-- 「拥有」官方袋子改为引用模式：收藏只存官方袋子的引用，图片直接读官方库，
-- 不再复制到用户名下，因此不占用户存储配额。
ALTER TABLE "Collectible" ADD COLUMN "sourceOfficialBagId" TEXT;
CREATE INDEX "Collectible_sourceOfficialBagId_idx" ON "Collectible"("sourceOfficialBagId");
ALTER TABLE "Collectible" ADD CONSTRAINT "Collectible_sourceOfficialBagId_fkey"
  FOREIGN KEY ("sourceOfficialBagId") REFERENCES "OfficialBag"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;
