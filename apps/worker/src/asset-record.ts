import { AssetKind, AssetStatus, ImageSide, Prisma, type PrismaClient } from '@prisma/client';

export interface AssetRecordInput {
  userId: string;
  collectibleId: string;
  kind: AssetKind;
  key: string;
  contentType: string;
  byteSize: number;
  width: number;
  height: number;
  version: number;
  side?: ImageSide;
  sourceVersion?: number;
}

function isRetryableTransactionError(error: unknown) {
  if (!(error instanceof Prisma.PrismaClientKnownRequestError)) return false;
  if (error.code === 'P2034' || error.code === 'P2002' || error.code === 'P2028') return true;
  const databaseCode =
    error.code === 'P2010' && typeof error.meta === 'object' && error.meta && 'code' in error.meta
      ? String(error.meta.code)
      : '';
  return databaseCode === '40001' || databaseCode === '40P01';
}

export async function upsertAssetRecord(prisma: PrismaClient, input: AssetRecordInput) {
  const newByteSize = BigInt(input.byteSize);
  /* Serializable 事务在等锁醒来时会抛 40001（could not serialize access due to
     concurrent update）——同收藏并行写资产时几乎必现。冲突是暂时性的，靠更多次数
     + 指数退避 + 抖动兜底（外部并发如 API 同步写同一收藏也走这里重试）。 */
  const MAX_ATTEMPTS = 6;
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt += 1) {
    try {
      await prisma.$transaction(
        async (transaction) => {
          if (input.sourceVersion !== undefined) {
            await transaction.$queryRaw`SELECT "id" FROM "User" WHERE "id" = ${input.userId} FOR UPDATE`;
            await transaction.$queryRaw`SELECT "id" FROM "Collectible" WHERE "id" = ${input.collectibleId} FOR UPDATE`;
            const state = await transaction.collectibleImageSide.findUnique({ where: { collectibleId_side: { collectibleId: input.collectibleId, side: input.side ?? ImageSide.FRONT } } });
            if (!state || state.sourceVersion !== input.sourceVersion || state.processingVersion !== input.version) throw new Error('STALE_IMAGE_JOB');
          }
          const existing = await transaction.imageAsset.findUnique({ where: { objectKey: input.key } });
          if (
            existing &&
            (existing.userId !== input.userId ||
              existing.collectibleId !== input.collectibleId ||
              existing.kind !== input.kind ||
              (existing.side ?? ImageSide.FRONT) !== (input.side ?? ImageSide.FRONT) ||
              existing.version !== input.version)
          ) {
            throw new Error('图片对象键与现有资产冲突');
          }

          const storageDelta = newByteSize - (existing?.byteSize ?? 0n);
          if (storageDelta > 0n) {
            const updated = await transaction.$executeRaw`
              UPDATE "User"
              SET "storageUsedBytes" = "storageUsedBytes" + ${storageDelta}
              WHERE "id" = ${input.userId}
                AND "storageUsedBytes" + ${storageDelta} <= "storageQuotaBytes"
            `;
            if (updated !== 1) throw new Error('云端存储空间不足');
          } else if (storageDelta < 0n) {
            await transaction.$executeRaw`
              UPDATE "User"
              SET "storageUsedBytes" = GREATEST(0, "storageUsedBytes" + ${storageDelta})
              WHERE "id" = ${input.userId}
            `;
          }

          await transaction.imageAsset.upsert({
            where: { objectKey: input.key },
            create: {
              userId: input.userId,
              collectibleId: input.collectibleId,
              kind: input.kind,
              side: input.side ?? ImageSide.FRONT,
              status: AssetStatus.AVAILABLE,
              objectKey: input.key,
              contentType: input.contentType,
              declaredByteSize: newByteSize,
              byteSize: newByteSize,
              width: input.width,
              height: input.height,
              version: input.version
            },
            update: {
              status: AssetStatus.AVAILABLE,
              contentType: input.contentType,
              declaredByteSize: newByteSize,
              byteSize: newByteSize,
              width: input.width,
              height: input.height
            }
          });
        },
        {
          isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
          maxWait: 5_000,
          timeout: 30_000
        }
      );
      return;
    } catch (error) {
      if (!isRetryableTransactionError(error) || attempt === MAX_ATTEMPTS - 1) throw error;
      await new Promise((resolve) => setTimeout(resolve, 25 * 2 ** attempt + Math.random() * 50));
    }
  }
}
