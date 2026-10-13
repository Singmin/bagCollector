import { bagFeatures } from '@bagcollect/bag-vision';
import { AssetKind, AssetStatus, OfficialProcessStatus, PrismaClient } from '@prisma/client';
import { config } from './config.js';
import { getObject } from './object-store.js';

/**
 * 官方袋子视觉向量的产出与维护。
 *
 * **只认一个对象：官方袋子。** 无论它是后台上传的、还是审核时从用户袋子纳入的，
 * 落进 OfficialBag 之后就没有区别 —— 这里从不关心来源，只看「这个官方袋子有没有
 * 可用的图、图有没有对应的向量」。
 *
 * **向量是派生数据。** 它由图片算出来，图片换了（version 递增）它就是过期的。
 * 因此任何入库路径漏算都不算致命错误：对账任务会发现并补齐（见 reconcileBagEmbeddings）。
 * 这也是为什么在 processOfficialImage 末尾的提取失败被刻意吞掉——图已经产好了，
 * 不该因为算不出向量就让整条图片处理链路标记失败。
 */

const prisma = new PrismaClient();

/** 提特征可用的图源，按优先级：CUTOUT 最干净（已去背景），DISPLAY 一定存在（兜底）。 */
const FEATURE_KINDS: AssetKind[] = [AssetKind.CUTOUT, AssetKind.DISPLAY];

interface FeatureSource {
  kind: AssetKind;
  version: number;
  objectKey: string;
}

/** 取指定 kind 中版本最高的一张；某 kind 一张都没有就退到下一个 kind。 */
function pickFeatureSource(images: FeatureSource[]): FeatureSource | null {
  for (const kind of FEATURE_KINDS) {
    let best: FeatureSource | null = null;
    for (const image of images) {
      if (image.kind !== kind) continue;
      if (!best || image.version > best.version) best = image;
    }
    if (best) return best;
  }
  return null;
}

/**
 * 为单个官方袋子重算并写入向量（幂等：同一袋子同一模型只保留一条）。
 * 返回 false 表示这个袋子当前没有可用于提特征的图（例如还没传图 / 图还没处理完）。
 */
export async function ensureBagEmbedding(officialBagId: string): Promise<boolean> {
  const images = await prisma.officialBagImage.findMany({
    where: {
      officialBagId, side: 'FRONT',
      status: AssetStatus.AVAILABLE,
      kind: { in: FEATURE_KINDS }
    },
    select: { kind: true, version: true, objectKey: true }
  });
  const bag = await prisma.officialBag.findUnique({ where: { id: officialBagId }, select: { version: true } });
  const source = pickFeatureSource(images.filter(image => image.version === bag?.version));
  if (!source) return false;

  const body = await getObject(source.objectKey);
  const vector = await bagFeatures.extract(body, { maxPixels: config.MAX_IMAGE_PIXELS });
  if (vector.length !== bagFeatures.dim) {
    throw new Error(`特征维度异常：期望 ${bagFeatures.dim}，实际 ${vector.length}`);
  }

  const payload = {
    vector: Array.from(vector),
    sourceKind: source.kind,
    sourceVersion: source.version
  };
  await prisma.bagEmbedding.upsert({
    where: { officialBagId_model: { officialBagId, model: bagFeatures.id } },
    create: { officialBagId, model: bagFeatures.id, ...payload },
    update: payload
  });
  return true;
}

/**
 * 找出「图片已就绪、但向量缺失或已过期」的官方袋子。
 *
 * 判据只有一条：**当前该用哪张图提特征（CUTOUT 优先，其次 DISPLAY），和现有向量
 * 记录的 sourceKind + sourceVersion 是否一致**。不一致就说明向量不对（缺少、或
 * 拿旧版本的图算的），需要重算。
 *
 * 这里刻意按 processStatus = READY 而不是 status = PUBLISHED 来过滤：草稿袋子的
 * 向量先算好，运营点「发布」的那一刻用户就能扫到，而不是等下一轮对账。
 *
 * 查询只取判定必需的字段（kind/version），不拉 objectKey —— 真正要用图时
 * 由 ensureBagEmbedding 再查一次，避免每轮对账把所有图记录都拖进内存。
 */
export async function findOfficialBagsMissingEmbedding(limit: number): Promise<string[]> {
  const bags = await prisma.officialBag.findMany({
    where: { processStatus: OfficialProcessStatus.READY },
    select: {
      id: true, version: true,
      images: {
        where: { side: 'FRONT', status: AssetStatus.AVAILABLE, kind: { in: FEATURE_KINDS } },
        select: { kind: true, version: true, objectKey: true }
      },
      embeddings: {
        where: { model: bagFeatures.id },
        select: { sourceKind: true, sourceVersion: true }
      }
    },
    orderBy: { updatedAt: 'asc' }
  });

  const missing: string[] = [];
  for (const bag of bags) {
    if (missing.length >= limit) break;
    const source = pickFeatureSource(bag.images.filter(image => image.version === bag.version));
    if (!source) continue; // 没有可用的图，谈不上算向量
    const embedding = bag.embeddings[0];
    if (embedding && embedding.sourceKind === source.kind && embedding.sourceVersion === source.version) {
      continue;
    }
    missing.push(bag.id);
  }
  return missing;
}

export interface EmbeddingReconcileResult {
  /** 本轮发现需要补算的袋子数（受 limit 截断） */
  missing: number;
  repaired: number;
  failed: number;
}

/**
 * 对账一轮：找出缺向量的官方袋子并补算，每轮最多处理 `limit` 个。
 *
 * 限量的意义在于：批量导入上百个袋子时，不该让它们一次性占满 worker ——
 * 用户那边的抠图任务还在排队。分摊到后续几轮跑完即可。
 *
 * 单个袋子失败不影响其余：记录日志后继续，下一轮还会再遇到它并重试。
 */
export async function reconcileBagEmbeddings(
  limit: number = config.EMBEDDING_RECONCILE_BATCH
): Promise<EmbeddingReconcileResult> {
  const missing = await findOfficialBagsMissingEmbedding(limit);
  let repaired = 0;
  let failed = 0;
  for (const officialBagId of missing) {
    try {
      if (await ensureBagEmbedding(officialBagId)) repaired += 1;
    } catch (error) {
      failed += 1;
      console.error(
        JSON.stringify({
          event: 'bag_embedding_failed',
          officialBagId,
          error: error instanceof Error ? error.message : String(error)
        })
      );
    }
  }
  if (missing.length > 0) {
    console.info(
      JSON.stringify({ event: 'bag_embedding_reconciled', missing: missing.length, repaired, failed })
    );
  }
  return { missing: missing.length, repaired, failed };
}

export async function closeBagEmbeddings() {
  await prisma.$disconnect();
}
