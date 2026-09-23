import { HttpStatus, Injectable } from '@nestjs/common';
import { AssetKind, AssetStatus } from '@prisma/client';
import { ApiError } from '../common/api-error.js';
import { PrismaService } from '../database/prisma.service.js';
import { CosService } from './cos.service.js';

@Injectable()
export class AssetsService {
  constructor(private readonly prisma: PrismaService, private readonly cos: CosService) {}

  async urlFor(userId: string, assetId: string) {
    const asset = await this.prisma.imageAsset.findFirst({
      where: { id: assetId, userId, status: AssetStatus.AVAILABLE }
    });
    if (!asset) throw new ApiError('NOT_FOUND', '图片不存在', HttpStatus.NOT_FOUND);
    return { url: await this.cos.signedUrl(asset.objectKey), expiresIn: 600 };
  }

  async urlsByKind(collectibleId: string, userId: string) {
    const assets = await this.prisma.imageAsset.findMany({
      where: { collectibleId, userId, status: AssetStatus.AVAILABLE },
      orderBy: { version: 'desc' }
    });
    const first = (kind: AssetKind) => assets.find((asset) => asset.kind === kind);
    const entries = await Promise.all(
      [AssetKind.THUMBNAIL, AssetKind.DISPLAY, AssetKind.STANDARD].map(async (kind) => {
        const asset = first(kind);
        return [kind, asset ? await this.cos.signedUrl(asset.objectKey) : undefined] as const;
      })
    );
    return Object.fromEntries(entries) as Partial<Record<AssetKind, string>>;
  }

  signedUrlForObjectKey(objectKey: string) {
    return this.cos.signedUrl(objectKey);
  }
}
