import { HttpStatus, Injectable } from '@nestjs/common';
import { AssetStatus } from '@prisma/client';
import { imageData } from '../common/image-sides.js';
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
    const item = await this.prisma.collectible.findFirst({ where: { id: collectibleId, userId } });
    if (!item) return {};
    const data = await imageData(this.prisma, this.cos, item.sourceOfficialBagId ?? collectibleId, !!item.sourceOfficialBagId);
    const front = data.sides.FRONT;
    return { THUMBNAIL: front?.thumbnailUrl, DISPLAY: front?.displayImageUrl, STANDARD: front?.standardImageUrl, CUTOUT: front?.cutoutImageUrl };

  }

  signedUrlForObjectKey(objectKey: string) {
    return this.cos.signedUrl(objectKey);
  }
}
