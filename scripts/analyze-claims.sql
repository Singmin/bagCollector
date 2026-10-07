-- 认领收藏「引用模式」转换前只读分析（纯 SELECT，不写不删任何数据）
\echo '===== 1. 总量 ====='
SELECT
  (SELECT count(*) FROM "OfficialClaim")   AS claim_total,
  (SELECT count(*) FROM "Collectible")      AS collectible_total,
  (SELECT count(*) FROM "ImageAsset")       AS asset_total;

\echo '===== 2. 认领收藏按处理状态分布 ====='
SELECT c."processingStatus" AS status, count(*) AS cnt
FROM "OfficialClaim" oc
JOIN "Collectible" c ON c.id = oc."collectibleId"
GROUP BY c."processingStatus"
ORDER BY cnt DESC;

\echo '===== 3. 可安全转换(纯复制) vs 需保留(编辑过/异常) ====='
WITH claim_assets AS (
  SELECT
    oc."collectibleId"                                  AS cid,
    c."processingStatus"                                AS pstatus,
    max(a.version)                                      AS max_version,
    bool_or(a.kind = 'CROPPED')                         AS has_cropped,
    sum(a."byteSize") FILTER (WHERE a.status = 'AVAILABLE') AS bytes,
    count(a.id) FILTER (WHERE a.status = 'AVAILABLE')       AS asset_count
  FROM "OfficialClaim" oc
  JOIN "Collectible" c ON c.id = oc."collectibleId"
  LEFT JOIN "ImageAsset" a ON a."collectibleId" = c.id
  GROUP BY oc."collectibleId", c."processingStatus"
)
SELECT
  CASE
    WHEN pstatus = 'READY'
         AND (max_version IS NULL OR max_version <= 1)
         AND (has_cropped IS FALSE OR has_cropped IS NULL)
      THEN 'pure-copy (safe to convert)'
    ELSE 'edited-or-abnormal (keep)'
  END                         AS category,
  count(*)                    AS claim_count,
  coalesce(sum(bytes), 0)     AS total_bytes,
  sum(asset_count)            AS asset_count
FROM claim_assets
GROUP BY 1
ORDER BY 1;

\echo '===== 4. 纯复制收藏可释放对象清单（仅列出，不删） ====='
SELECT a."objectKey", a.kind, a."byteSize"
FROM "OfficialClaim" oc
JOIN "Collectible" c ON c.id = oc."collectibleId"
JOIN "ImageAsset" a ON a."collectibleId" = c.id AND a.status = 'AVAILABLE'
WHERE c."processingStatus" = 'READY'
  AND NOT EXISTS (SELECT 1 FROM "ImageAsset" x WHERE x."collectibleId" = c.id AND x.version > 1)
  AND NOT EXISTS (SELECT 1 FROM "ImageAsset" x WHERE x."collectibleId" = c.id AND x.kind = 'CROPPED')
ORDER BY a."objectKey";
