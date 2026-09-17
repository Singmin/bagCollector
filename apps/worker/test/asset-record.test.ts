import { AssetKind, Prisma, type PrismaClient } from '@prisma/client';
import { describe, expect, it, vi } from 'vitest';
import { upsertAssetRecord } from '../src/asset-record.js';

describe('derived asset accounting', () => {
  it('retries an expired interactive transaction before failing the worker job', async () => {
    const transaction = vi
      .fn()
      .mockRejectedValueOnce(
        new Prisma.PrismaClientKnownRequestError('transaction expired', {
          code: 'P2028',
          clientVersion: 'test'
        })
      )
      .mockResolvedValueOnce(undefined);
    const prisma = { $transaction: transaction } as unknown as PrismaClient;

    await upsertAssetRecord(prisma, {
      userId: 'user-1',
      collectibleId: 'collectible-1',
      kind: AssetKind.DISPLAY,
      key: 'display.png',
      contentType: 'image/png',
      byteSize: 100,
      width: 10,
      height: 10,
      version: 1
    });

    expect(transaction).toHaveBeenCalledTimes(2);
  });
});
