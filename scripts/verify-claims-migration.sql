-- 转换后验证（只读）：三项都应等于 0
SELECT
  (SELECT count(*) FROM "OfficialClaim" oc JOIN "Collectible" c ON c.id = oc."collectibleId"
    WHERE c."sourceOfficialBagId" IS NULL)                                   AS unlinked_claims,
  (SELECT count(*) FROM "OfficialClaim" oc JOIN "Collectible" c ON c.id = oc."collectibleId"
    WHERE c."processingStatus" <> 'READY')                                   AS non_ready_claims,
  (SELECT count(*) FROM "ImageAsset" a JOIN "OfficialClaim" oc ON oc."collectibleId" = a."collectibleId") AS claim_assets_left;
