// 认领收藏「复制模式」→「引用模式」转换脚本（生产用）
//
// 背景：拥有官方袋子改为引用官方图，不复制图片、不占用户存储。
// 本脚本把「历史认领收藏」的复制图片清理掉，回填 sourceOfficialBagId 引用，
// 释放已占用的存储配额与 COS 对象。
//
// 安全设计：
//   1. 只处理「尚未回填引用」的认领收藏（WHERE sourceOfficialBagId IS NULL），幂等可重跑；
//   2. 只清理「纯复制」的资产（version <= 1 且无 CROPPED），编辑过的跳过并告警；
//   3. 先回填引用（收藏立即能读官方图）→ 再删资产 + 扣配额（同一事务）→ 最后删 COS；
//   4. 删除前把 objectKey 清单落盘 /tmp/claim-migration-manifest.json 供对账；
//   5. 默认 dry-run：只统计 + 写清单，不修改任何数据。
//
// 运行（在 api 容器内）：
//   node migrate-claims-to-reference.mjs             # dry-run
//   node migrate-claims-to-reference.mjs --execute   # 真正执行
import { Prisma, PrismaClient } from '@prisma/client';
import COS from 'cos-nodejs-sdk-v5';
import { writeFileSync } from 'node:fs';

const prisma = new PrismaClient();

const { COS_SECRET_ID, COS_SECRET_KEY, COS_BUCKET: Bucket, COS_REGION: Region } = process.env;
const cos = new COS({ SecretId: COS_SECRET_ID, SecretKey: COS_SECRET_KEY });

const EXECUTE = process.argv.includes('--execute');
const MANIFEST = process.env.MANIFEST_PATH || '/tmp/claim-migration-manifest.json';
const BATCH = 100;          // 每个数据库事务处理的收藏数
const COS_CHUNK = 1000;     // deleteMultipleObject 单次上限

function die(message) {
  console.error(message);
  process.exit(1);
}

function assertEnv() {
  if (!COS_SECRET_ID || !COS_SECRET_KEY || !Bucket || !Region) {
    die('缺少 COS 环境变量：COS_SECRET_ID / COS_SECRET_KEY / COS_BUCKET / COS_REGION');
  }
}

/** 查所有「尚未回填引用」的认领收藏概要。 */
async function loadTargets() {
  return prisma.$queryRaw`
    SELECT
      oc."collectibleId"                      AS cid,
      oc."officialBagId"                      AS bag_id,
      oc."userId"                             AS uid,
      c."processingStatus"                    AS pstatus,
      max(a.version)                          AS max_version,
      bool_or(a.kind = 'CROPPED')             AS has_cropped,
      count(a.id)                             AS asset_count
    FROM "OfficialClaim" oc
    JOIN "Collectible" c ON c.id = oc."collectibleId"
    LEFT JOIN "ImageAsset" a ON a."collectibleId" = c.id AND a.status = 'AVAILABLE'
    WHERE c."sourceOfficialBagId" IS NULL
    GROUP BY 1, 2, 3, 4
    ORDER BY 1
  `;
}

/** 查指定收藏的可用图片资产（objectKey / byteSize）。 */
async function loadAssets(cids) {
  if (!cids.length) return [];
  return prisma.$queryRaw`
    SELECT "collectibleId" AS cid, "objectKey" AS key, "byteSize" AS bytes
    FROM "ImageAsset"
    WHERE "collectibleId" IN (${Prisma.join(cids)}) AND status = 'AVAILABLE'
  `;
}

function classify(row) {
  const edited = (row.max_version != null && Number(row.max_version) > 1) || Boolean(row.has_cropped);
  if (edited) return 'edited';
  return 'convert'; // 纯复制（READY）或失败残留（无图/纯复制图）
}

async function main() {
  const targets = await loadTargets();
  const convertRows = [];
  const skipped = [];

  for (const row of targets) {
    const kind = classify(row);
    if (kind === 'edited') skipped.push(row);
    else convertRows.push(row);
  }

  const cids = convertRows.map((row) => row.cid);
  const assets = await loadAssets(cids);

  // 资产按收藏归组
  const byCid = new Map();
  for (const asset of assets) {
    if (!byCid.has(asset.cid)) byCid.set(asset.cid, []);
    byCid.get(asset.cid).push(asset);
  }

  // 组装清单
  const manifest = convertRows.map((row) => {
    const list = byCid.get(row.cid) ?? [];
    return {
      cid: row.cid,
      uid: row.uid,
      bagId: row.bag_id,
      keys: list.map((a) => a.key),
      bytes: list.reduce((sum, a) => sum + BigInt(a.bytes), 0n).toString(),
      assetCount: list.length
    };
  });

  const totalBytes = manifest.reduce((sum, m) => sum + BigInt(m.bytes), 0n);
  const totalKeys = manifest.reduce((sum, m) => sum + m.keys.length, 0);
  const failedRows = convertRows.filter((r) => r.pstatus !== 'READY');

  console.log('=====================================================');
  console.log(`模式：${EXECUTE ? 'EXECUTE（真正执行）' : 'DRY-RUN（只统计，不修改）'}`);
  console.log('=====================================================');
  console.log(`认领收藏待转换（未回填引用）：${targets.length}`);
  console.log(`  可转换（纯复制/失败残留）：${convertRows.length}`);
  console.log(`  跳过（编辑过，需人工处理）：${skipped.length}`);
  console.log(`  其中失败态（将一并置 READY）：${failedRows.length}`);
  console.log(`  涉及图片对象：${totalKeys} 个`);
  console.log(`  可释放字节：${totalBytes}（约 ${(Number(totalBytes) / 1024 / 1024 / 1024).toFixed(2)} GiB）`);

  if (skipped.length) {
    console.log('\n-- 跳过的编辑过收藏（cid）--');
    for (const row of skipped) console.log(`  ${row.cid} (status=${row.pstatus}, max_version=${row.max_version}, cropped=${row.has_cropped})`);
  }

  // 落盘清单（dry-run 与 execute 都写，供对账）
  writeFileSync(MANIFEST, JSON.stringify({ generatedAt: new Date().toISOString(), totalBytes: totalBytes.toString(), items: manifest }, null, 2));
  console.log(`\n清单已写入 ${MANIFEST}`);

  if (!EXECUTE) {
    console.log('\n[dry-run] 未做任何修改。确认无误后加 --execute 执行。');
    await prisma.$disconnect();
    return;
  }

  assertEnv();
  console.log('\n开始执行转换……');

  // 1) 数据库转换（分批事务：回填引用 → 删资产 + 扣配额 → 失败态置 READY）
  let converted = 0;
  for (let i = 0; i < manifest.length; i += BATCH) {
    const batch = manifest.slice(i, i + BATCH);
    await prisma.$transaction(async (tx) => {
      for (const item of batch) {
        await tx.$executeRaw`
          UPDATE "Collectible"
          SET "sourceOfficialBagId" = ${item.bagId}
          WHERE "id" = ${item.cid} AND "sourceOfficialBagId" IS NULL
        `;
        // 删资产并用 RETURNING 精确扣减配额（幂等：资产已删则扣 0）
        await tx.$executeRaw`
          WITH deleted AS (
            DELETE FROM "ImageAsset"
            WHERE "collectibleId" = ${item.cid} AND "userId" = ${item.uid}
            RETURNING "byteSize"
          )
          UPDATE "User"
          SET "storageUsedBytes" = GREATEST(
            0::bigint,
            "storageUsedBytes" - COALESCE((SELECT SUM("byteSize")::bigint FROM deleted), 0::bigint)
          )
          WHERE "id" = ${item.uid}
        `;
        // 失败态残留：修复为 READY（它们本无图，回填引用后即可读官方图）
        await tx.$executeRaw`
          UPDATE "Collectible"
          SET "processingStatus" = 'READY', "processingError" = NULL
          WHERE "id" = ${item.cid} AND "processingStatus" <> 'READY'
        `;
      }
    });
    converted += batch.length;
    console.log(`  数据库批次完成 ${converted}/${manifest.length}`);
  }

  // 2) 删除 COS 对象（DB 已删、引用已回填，COS 删除失败无害，可重跑）
  const allKeys = manifest.flatMap((m) => m.keys);
  let deleted = 0;
  for (let i = 0; i < allKeys.length; i += COS_CHUNK) {
    const chunk = allKeys.slice(i, i + COS_CHUNK);
    await new Promise((resolve, reject) => {
      cos.deleteMultipleObject(
        { Bucket, Region, Objects: chunk.map((Key) => ({ Key })), Quiet: true },
        (error) => (error ? reject(error) : resolve())
      );
    });
    deleted += chunk.length;
    console.log(`  COS 删除进度 ${deleted}/${allKeys.length}`);
  }

  console.log('\n=====================================================');
  console.log(`转换完成：回填 ${converted} 条收藏引用，删除 ${deleted} 个 COS 对象，释放 ${totalBytes} 字节`);
  console.log('=====================================================');

  await prisma.$disconnect();
}

main().catch(async (error) => {
  console.error('转换脚本失败：', error);
  await prisma.$disconnect().catch(() => {});
  process.exit(1);
});
