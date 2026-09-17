import { AssetKind, AssetStatus, Prisma, type PrismaClient } from '@prisma/client';

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
  for (let attempt = 0; attempt < 4; attempt += 1) {
    try {
      await prisma.$transaction(
        async (transaction) => {
          const existing = await transaction.imageAsset.findUnique({ where: { objectKey: input.key } });
          if (
            existing &&
            (existing.userId !== input.userId ||
              existing.collectibleId !== input.collectibleId ||
              existing.kind !== input.kind ||
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
      if (!isRetryableTransactionError(error) || attempt === 3) throw error;
      await new Promise((resolve) => setTimeout(resolve, 10 * (attempt + 1)));
    }
  }
}
