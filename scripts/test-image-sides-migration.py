"""Exercise legacy-data backfill in an isolated schema of the disposable test DB."""
from pathlib import Path
import re
import subprocess
import uuid

root = Path(__file__).resolve().parents[1]
migrations = root / "apps/api/prisma/migrations"
target = migrations / "20261012000000_image_sides/migration.sql"
schema = "bag_sides_migration_" + uuid.uuid4().hex
assert re.fullmatch(r"bag_sides_migration_[0-9a-f]{32}", schema)
command = ["docker", "compose", "-f", "infra/docker-compose.local.yml", "exec", "-T", "postgres-test", "psql", "-U", "bagcollect", "-d", "bagcollect_test", "-v", "ON_ERROR_STOP=1"]
legacy = "\n".join(path.read_text(encoding="utf-8") for path in sorted(migrations.glob("*/migration.sql")) if path.parent.name < target.parent.name)
fixture = """
INSERT INTO "User" (id, openid, "storageQuotaBytes", "collectibleQuota", "dailyMattingQuota", "updatedAt") VALUES ('u', 'test-u', 1000000, 100, 25, NOW());
INSERT INTO "Shelf" (id, "userId", name, theme, "updatedAt") VALUES ('s', 'u', 'test', 'SAGE', NOW());
INSERT INTO "Admin" (id, username, "passwordHash", "updatedAt") VALUES ('a', 'test-admin', 'test-only', NOW());
INSERT INTO "OfficialBag" (id, name, "createdById", version, "processStatus", "updatedAt") VALUES ('o', 'official', 'a', 2, 'FAILED', NOW());
INSERT INTO "Collectible" (id, "userId", "shelfId", name, "processingStatus", "processingVersion", "promotedBagId", "cropX", "cropY", "cropWidth", "cropHeight", "cropRotation", "updatedAt")
VALUES ('upload', 'u', 's', 'original-upload', 'READY', 3, 'o', 0, 0, 1, 1, 90, NOW());
INSERT INTO "Collectible" (id, "userId", "shelfId", name, "processingStatus", "updatedAt") VALUES ('claim', 'u', 's', 'claimed', 'READY', NOW());
INSERT INTO "OfficialClaim" (id, "userId", "officialBagId", "collectibleId") VALUES ('oc', 'u', 'o', 'claim');
INSERT INTO "ImageAsset" (id, "userId", "collectibleId", kind, status, "objectKey", "contentType", version, "updatedAt") VALUES
('u1', 'u', 'upload', 'STANDARD', 'AVAILABLE', 'unchanged/standard/v1.jpg', 'image/jpeg', 1, NOW()),
('u2', 'u', 'upload', 'DISPLAY', 'AVAILABLE', 'unchanged/display/v3.png', 'image/png', 3, NOW()),
('u3', 'u', 'upload', 'THUMBNAIL', 'AVAILABLE', 'unchanged/thumbnail/v3.webp', 'image/webp', 3, NOW()),
('u4', 'u', 'upload', 'CUTOUT', 'AVAILABLE', 'unchanged/cutout/v3.png', 'image/png', 3, NOW());
INSERT INTO "ImageAsset" (id, "userId", "collectibleId", kind, status, "objectKey", "contentType", "byteSize", version, "updatedAt") VALUES
('claim-copy', 'u', 'claim', 'DISPLAY', 'AVAILABLE', 'unchanged/legacy-claim.png', 'image/png', 100, 1, NOW());
UPDATE "User" SET "storageUsedBytes" = 100 WHERE id = 'u';
INSERT INTO "OfficialBagImage" (id, "officialBagId", kind, status, "objectKey", "contentType", version, "updatedAt") VALUES
('o1', 'o', 'STANDARD', 'AVAILABLE', 'official/standard/v1.jpg', 'image/jpeg', 1, NOW()),
('o2', 'o', 'DISPLAY', 'AVAILABLE', 'official/display/v1.png', 'image/png', 1, NOW()),
('o3', 'o', 'THUMBNAIL', 'AVAILABLE', 'official/thumbnail/v1.webp', 'image/webp', 1, NOW()),
('o4', 'o', 'DISPLAY', 'AVAILABLE', 'official/unfinished/v2.png', 'image/png', 2, NOW());
"""
assertions = """
DO $$ BEGIN
  IF (SELECT "sourceOfficialBagId" FROM "Collectible" WHERE id = 'claim') IS DISTINCT FROM 'o' THEN RAISE EXCEPTION 'claim reference not restored'; END IF;
  IF (SELECT "sourceOfficialBagId" FROM "Collectible" WHERE id = 'upload') IS NOT NULL THEN RAISE EXCEPTION 'promoted upload made read-only'; END IF;
  IF NOT EXISTS (SELECT 1 FROM "CollectibleImageSide" WHERE "collectibleId" = 'upload' AND side = 'FRONT' AND "publishedVersion" = 3 AND "sourceVersion" = 1 AND "mattedSourceVersion" = 1 AND crop->>'rotation' = '90') THEN RAISE EXCEPTION 'upload backfill incorrect'; END IF;
  IF NOT EXISTS (SELECT 1 FROM "OfficialBagImageSide" WHERE "officialBagId" = 'o' AND "publishedVersion" = 1 AND "publishedSourceVersion" = 1) THEN RAISE EXCEPTION 'unfinished rendition published'; END IF;
  IF (SELECT "storageUsedBytes" FROM "User" WHERE id = 'u') <> 0 THEN RAISE EXCEPTION 'legacy claim copies still charged'; END IF;
  IF NOT EXISTS (SELECT 1 FROM "ImageAsset" WHERE id = 'claim-copy' AND status = 'FAILED' AND "objectKey" = 'unchanged/legacy-claim.png') THEN RAISE EXCEPTION 'claim copy not archived'; END IF;
  IF EXISTS (SELECT 1 FROM "ImageAsset" WHERE side <> 'FRONT') THEN RAISE EXCEPTION 'legacy side incorrect'; END IF;
  IF NOT EXISTS (SELECT 1 FROM "ImageAsset" WHERE "objectKey" = 'unchanged/display/v3.png') THEN RAISE EXCEPTION 'legacy path changed'; END IF;
END $$;
"""
sql = f'CREATE SCHEMA "{schema}"; SET search_path TO "{schema}";\n' + legacy + fixture + target.read_text(encoding="utf-8") + assertions
try:
    result = subprocess.run(command, cwd=root, input=sql, encoding="utf-8", capture_output=True)
    if result.returncode:
        raise RuntimeError(result.stderr)
    print("PASS: legacy FRONT backfill, completed-version selection, claim linkage, promoted upload ownership and unchanged paths")
finally:
    # Generated schema only, never public or a caller-specified name.
    subprocess.run(command, cwd=root, input=f'DROP SCHEMA IF EXISTS "{schema}" CASCADE;', encoding="utf-8", capture_output=True, check=True)
