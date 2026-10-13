import { createHash, createHmac } from 'node:crypto';
import { HttpStatus, Injectable } from '@nestjs/common';
import { AssetKind, AssetStatus, ImageSide, JobStatus, JobType, Prisma, ProcessingStatus } from '@prisma/client';
import STS from 'qcloud-cos-sts';
import { assertImageWritable, lockImageOwner, failImageSubmission } from '../common/image-sides.js';
import { ApiError } from '../common/api-error.js';
import { env } from '../common/env.js';
import { QueueService } from '../common/queue.service.js';
import { PrismaService } from '../database/prisma.service.js';
import { CosService } from '../assets/cos.service.js';

interface StsCredential {
  credentials: {
    tmpSecretId: string;
    tmpSecretKey: string;
    sessionToken: string;
  };
  expiredTime: number;
  startTime: number;
}

@Injectable()
export class UploadsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly cos: CosService,
    private readonly queues: QueueService
  ) {}

  private extension(contentType: string) {
    return ({
      'image/jpeg': 'jpg',
      'image/png': 'png',
      'image/webp': 'webp',
      'image/heic': 'heic',
      'image/heif': 'heif'
    } as Record<string, string>)[contentType] ?? 'bin';
  }

  private resourceFor(key: string) {
    const config = env();
    const appId = config.COS_BUCKET.match(/-(\d+)$/)?.[1];
    if (!appId) throw new ApiError('UPLOAD_INVALID', 'COS_BUCKET 必须包含 APPID 后缀', HttpStatus.SERVICE_UNAVAILABLE);
    return `qcs::cos:${config.COS_REGION}:uid/${appId}:${config.COS_BUCKET}/${key}`;
  }

  private sts(key: string): Promise<StsCredential> {
    const config = env();
    this.cos.assertConfigured();
    return new Promise((resolve, reject) => {
      STS.getCredential(
        {
          secretId: config.COS_SECRET_ID,
          secretKey: config.COS_SECRET_KEY,
          durationSeconds: config.COS_STS_DURATION_SECONDS,
          policy: {
            version: '2.0',
            statement: [
              {
                action: ['name/cos:PutObject', 'name/cos:PostObject'],
                effect: 'allow',
                principal: { qcs: ['*'] },
                resource: [this.resourceFor(key)]
              }
            ]
          }
        } as any,
        (error: Error | null, credential: StsCredential) => {
          if (error) reject(error);
          else resolve(credential);
        }
      );
    });
  }

  async policy(
    userId: string,
    input: { collectibleId: string; fileName: string; contentType: string; size: number; side?: ImageSide }
  ) {
    const config = env();
    if (input.size > config.MAX_UPLOAD_BYTES) {
      throw new ApiError('UPLOAD_INVALID', '图片不能超过 30MB', HttpStatus.PAYLOAD_TOO_LARGE);
    }
    const [user, collectible] = await Promise.all([
      this.prisma.user.findUnique({ where: { id: userId } }),
      this.prisma.collectible.findFirst({ where: { id: input.collectibleId, userId } })
    ]);
    if (!user || !collectible) throw new ApiError('NOT_FOUND', '收藏不存在', HttpStatus.NOT_FOUND);
    assertImageWritable(collectible);
    const side = input.side ?? ImageSide.FRONT;
    const asset = await this.prisma.$transaction(async tx => {
      await lockImageOwner(tx, collectible.id, userId);
      const current = await tx.collectible.findFirstOrThrow({ where: { id: collectible.id, userId } });
      assertImageWritable(current);
      const state = await tx.collectibleImageSide.findUnique({ where: { collectibleId_side: { collectibleId: current.id, side } } });
      if (state && ['NORMALIZING', 'CROPPING', 'MATTING'].includes(state.processingStatus)) throw new ApiError('CONFLICT', '这一面的图片正在处理中', HttpStatus.CONFLICT);
      if (state?.processingStatus === ProcessingStatus.UPLOADING && state.sourceVersion) {
        const reserved = await tx.imageAsset.findFirst({ where: { collectibleId: current.id, side, version: state.sourceVersion, kind: AssetKind.ORIGINAL, status: AssetStatus.RESERVED } });
        if (reserved && reserved.reservationExpiresAt && reserved.reservationExpiresAt > new Date()) return reserved;
      }
      const version = (state?.processingVersion ?? 0) + 1;
      const key = `users/${userId}/collectibles/${current.id}/${side.toLowerCase()}/original/v${version}.${this.extension(input.contentType)}`;
      const row = await tx.imageAsset.create({ data: { userId, collectibleId: current.id, side, kind: AssetKind.ORIGINAL, status: AssetStatus.RESERVED,
        objectKey: key, contentType: input.contentType, declaredByteSize: BigInt(input.size), byteSize: 0n,
        reservationExpiresAt: new Date(Date.now() + config.COS_STS_DURATION_SECONDS * 1000), version } });
      await tx.collectibleImageSide.upsert({ where: { collectibleId_side: { collectibleId: current.id, side } },
        create: { collectibleId: current.id, side, sourceVersion: version, processingVersion: version },
        update: { sourceVersion: version, processingVersion: version, processingStatus: ProcessingStatus.UPLOADING, processingError: null, crop: Prisma.DbNull } });
      if (side === ImageSide.FRONT) await tx.collectible.update({ where: { id: current.id }, data: { processingVersion: version,
        processingStatus: state?.publishedVersion ? ProcessingStatus.READY : ProcessingStatus.UPLOADING, processingError: null } });
      return row;
    });
    const key = asset.objectKey;
    const temporary = this.cos.isLocal() ? undefined : await this.sts(key);
    const expiresAt = temporary ? new Date(temporary.expiredTime * 1000) : new Date(Date.now() + config.COS_STS_DURATION_SECONDS * 1000);
    await this.prisma.imageAsset.update({ where: { id: asset.id }, data: { declaredByteSize: BigInt(input.size), reservationExpiresAt: expiresAt } });
    if (this.cos.isLocal()) {
      return {
        assetId: asset.id,
        key,
        uploadUrl: `${config.API_PUBLIC_URL}/api/uploads/local/${asset.id}`,
        expiresAt: expiresAt.toISOString(),
        formData: {}
      };
    }
    if (!temporary) throw new ApiError('UPLOAD_INVALID', '对象存储尚未配置', HttpStatus.SERVICE_UNAVAILABLE);
    const now = Math.floor(Date.now() / 1000);
    const keyTime = `${Math.max(now - 60, temporary.startTime)};${temporary.expiredTime}`;
    const policy = Buffer.from(
      JSON.stringify({
        expiration: new Date(temporary.expiredTime * 1000).toISOString(),
        conditions: [
          { bucket: config.COS_BUCKET },
          { 'q-sign-algorithm': 'sha1' },
          { 'q-ak': temporary.credentials.tmpSecretId },
          { 'q-sign-time': keyTime },
          { 'x-cos-security-token': temporary.credentials.sessionToken },
          ['eq', '$key', key],
          ['content-length-range', 1, input.size],
          ['starts-with', '$Content-Type', 'image/']
        ]
      })
    ).toString('base64');
    const signKey = createHmac('sha1', temporary.credentials.tmpSecretKey).update(keyTime).digest('hex');
    const stringToSign = createHash('sha1').update(Buffer.from(policy, 'base64')).digest('hex');
    const signature = createHmac('sha1', signKey).update(stringToSign).digest('hex');

    return {
      assetId: asset.id,
      key,
      uploadUrl: `https://${config.COS_BUCKET}.cos.${config.COS_REGION}.myqcloud.com`,
      expiresAt: expiresAt.toISOString(),
      formData: {
        key,
        success_action_status: '200',
        'Content-Type': input.contentType,
        'q-sign-algorithm': 'sha1',
        'q-ak': temporary.credentials.tmpSecretId,
        'q-sign-time': keyTime,
        'q-key-time': keyTime,
        'q-signature': signature,
        policy,
        'x-cos-security-token': temporary.credentials.sessionToken
      }
    };
  }

  async localUpload(userId: string, assetId: string, body: Buffer, contentType: string) {
    if (!this.cos.isLocal()) throw new ApiError('NOT_FOUND', '本地上传未启用', HttpStatus.NOT_FOUND);
    const asset = await this.prisma.imageAsset.findFirst({
      where: { id: assetId, userId, kind: AssetKind.ORIGINAL, status: AssetStatus.RESERVED }
    });
    if (!asset) throw new ApiError('UPLOAD_INVALID', '上传记录不存在或已完成', HttpStatus.BAD_REQUEST);
    const item = await this.prisma.collectible.findFirstOrThrow({ where: { id: asset.collectibleId, userId } });
    assertImageWritable(item);
    if (!contentType.startsWith('image/')) {
      throw new ApiError('UPLOAD_INVALID', '只允许上传图片', HttpStatus.BAD_REQUEST);
    }
    if (body.length <= 0 || BigInt(body.length) > asset.declaredByteSize || body.length > env().MAX_UPLOAD_BYTES) {
      throw new ApiError('UPLOAD_INVALID', '上传图片大小不正确', HttpStatus.PAYLOAD_TOO_LARGE);
    }
    await this.cos.putLocalObject(asset.objectKey, body);
    return { success: true };
  }

  async complete(userId: string, input: { assetId: string; collectibleId: string; key: string }) {
    const asset = await this.prisma.imageAsset.findFirst({
      where: {
        id: input.assetId,
        collectibleId: input.collectibleId,
        userId,
        objectKey: input.key,
        kind: AssetKind.ORIGINAL
      }
    });
    if (!asset) throw new ApiError('UPLOAD_INVALID', '上传记录不存在', HttpStatus.BAD_REQUEST);

    const item = await this.prisma.collectible.findFirst({ where: { id: asset.collectibleId, userId } });
    if (!item) throw new ApiError('NOT_FOUND', '收藏不存在', HttpStatus.NOT_FOUND);
    assertImageWritable(item);
    const state = await this.prisma.collectibleImageSide.findUnique({ where: { collectibleId_side: { collectibleId: asset.collectibleId, side: asset.side } } });
    if (!state || state.sourceVersion !== asset.version || state.processingVersion !== asset.version) throw new ApiError('CONFLICT', '上传已过期，请重新选择图片', HttpStatus.CONFLICT);

    if (asset.status === AssetStatus.AVAILABLE) {
      const existingJob = await this.prisma.processingJob.findUnique({
        where: { idempotencyKey: `normalize:${input.collectibleId}:${asset.side}:v${asset.version}` }
      });
      return { jobId: existingJob?.id, processingStatus: ProcessingStatus.NORMALIZING };
    }

    let remote: { contentLength: number; contentType?: string };
    try {
      remote = await this.cos.headObject(asset.objectKey);
    } catch {
      throw new ApiError('UPLOAD_INVALID', 'COS 中未找到已上传图片', HttpStatus.BAD_REQUEST);
    }
    if (remote.contentLength <= 0 || remote.contentLength > env().MAX_UPLOAD_BYTES) {
      throw new ApiError('UPLOAD_INVALID', '上传图片大小不正确', HttpStatus.BAD_REQUEST);
    }
    if (BigInt(remote.contentLength) > asset.declaredByteSize) {
      throw new ApiError('UPLOAD_INVALID', '上传图片超过申请大小', HttpStatus.BAD_REQUEST);
    }

    const idempotencyKey = `normalize:${input.collectibleId}:${asset.side}:v${asset.version}`;
    const result = await this.prisma.$transaction(async (transaction) => {
      await lockImageOwner(transaction, asset.collectibleId, userId);
      const active = await transaction.collectibleImageSide.findUniqueOrThrow({ where: { collectibleId_side: { collectibleId: asset.collectibleId, side: asset.side } } });
      if (active.sourceVersion !== asset.version) throw new ApiError('CONFLICT', '上传已过期', HttpStatus.CONFLICT);
      const claimed = await transaction.imageAsset.updateMany({
        where: { id: asset.id, status: AssetStatus.RESERVED },
        data: {
          status: AssetStatus.AVAILABLE,
          byteSize: BigInt(remote.contentLength),
          reservationExpiresAt: null,
          ...(remote.contentType ? { contentType: remote.contentType } : {})
        }
      });
      if (claimed.count !== 1) return { claimed: false, jobId: undefined as string | undefined };
      const quotaReserved = await transaction.$executeRaw`
        UPDATE "User"
        SET "storageUsedBytes" = "storageUsedBytes" + ${BigInt(remote.contentLength)}
        WHERE "id" = ${userId}
          AND "storageUsedBytes" + ${BigInt(remote.contentLength)} <= "storageQuotaBytes"
      `;
      if (quotaReserved !== 1) {
        throw new ApiError('QUOTA_EXCEEDED', '云端存储空间不足', HttpStatus.PAYLOAD_TOO_LARGE);
      }
      await transaction.collectibleImageSide.update({ where: { collectibleId_side: { collectibleId: asset.collectibleId, side: asset.side } }, data: { processingStatus: ProcessingStatus.NORMALIZING, processingError: null } });
      if (asset.side === ImageSide.FRONT) await transaction.collectible.update({ where: { id: input.collectibleId }, data: { processingStatus: active.publishedVersion ? ProcessingStatus.READY : ProcessingStatus.NORMALIZING, processingError: null } });
      const job = await transaction.processingJob.upsert({
        where: { idempotencyKey },
        create: {
          userId,
          collectibleId: input.collectibleId,
          side: asset.side, version: asset.version, sourceVersion: asset.version,
          type: JobType.NORMALIZE,
          status: JobStatus.QUEUED,
          idempotencyKey
        },
        update: { status: JobStatus.QUEUED, errorMessage: null }
      });
      return { claimed: true, jobId: job.id };
    });
    if (!result.claimed) {
      const existingJob = await this.prisma.processingJob.findUnique({ where: { idempotencyKey } });
      return { jobId: existingJob?.id, processingStatus: ProcessingStatus.NORMALIZING };
    }
    try { await this.queues.add(
      'normalize',
      {
        processingJobId: result.jobId,
        collectibleId: input.collectibleId,
        userId,
        side: asset.side, sourceVersion: asset.version, version: asset.version
      },
      idempotencyKey
    ); } catch (error) {
      await failImageSubmission(this.prisma, { collectibleId: input.collectibleId, userId, side: asset.side, version: asset.version, processingJobId: result.jobId });
      throw error;
    }
    return { jobId: result.jobId, processingStatus: ProcessingStatus.NORMALIZING };
  }
}
