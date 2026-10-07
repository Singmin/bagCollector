-- 非 READY 的认领收藏详情（只读）
SELECT oc."collectibleId" AS cid,
       oc."officialBagId" AS bag_id,
       c."processingStatus" AS status,
       left(coalesce(c."processingError", ''), 100) AS err,
       (SELECT count(*) FROM "ImageAsset" a WHERE a."collectibleId" = c.id) AS asset_count,
       (SELECT coalesce(sum(a."byteSize"), 0) FROM "ImageAsset" a WHERE a."collectibleId" = c.id) AS bytes
FROM "OfficialClaim" oc
JOIN "Collectible" c ON c.id = oc."collectibleId"
WHERE c."processingStatus" <> 'READY';
