UPDATE "Shelf"
SET "isSystem" = false
WHERE "isSystem" = true;

ALTER TABLE "Shelf"
  DROP COLUMN "isSystem",
  ALTER COLUMN "theme" DROP DEFAULT;

ALTER TABLE "Collectible"
  ALTER COLUMN "name" DROP DEFAULT;
