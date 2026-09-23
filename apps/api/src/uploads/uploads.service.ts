import { createHash, createHmac } from 'node:crypto';
import { HttpStatus, Injectable } from '@nestjs/common';
import { AssetKind, AssetStatus, JobStatus, JobType, Prisma, ProcessingStatus } from '@prisma/client';
import STS from 'qcloud-cos-sts';
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
    input: { collectibleId: string; fileName: string; contentType: string; size: number }
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
    if (collectible.processingStatus !== ProcessingStatus.UPLOADING) {
      throw new ApiError('CONFLICT', '该收藏已经上传过图片', HttpStatus.CONFLICT);
    }
    if (user.storageUsedBytes + BigInt(input.size) > user.storageQuotaBytes) {
      throw new ApiError('QUOTA_EXCEEDED', '云端存储空间不足', HttpStatus.PAYLOAD_TOO_LARGE);
    }

    const key = `users/${userId}/collectibles/${collectible.id}/original/v${collectible.processingVersion}.${this.extension(input.contentType)}`;
    const temporary = this.cos.isLocal() ? undefined : await this.sts(key);
    const expiresAt = temporary
      ? new Date(temporary.expiredTime * 1000)
      : new Date(Date.now() + config.COS_STS_DURATION_SECONDS * 1_000);
    const identity = {
      collectibleId_kind_version: {
        collectibleId: collectible.id,
        kind: AssetKind.ORIGINAL,
        version: collectible.processingVersion
      }
    };
    let asset = await this.prisma.imageAsset.findUnique({ where: identity });
    if (asset?.status === AssetStatus.AVAILABLE) {
      throw new ApiError('CONFLICT', '该收藏已经上传过图片', HttpStatus.CONFLICT);
    }
    if (!asset) {
      try {
        asset = await this.prisma.imageAsset.create({
          data: {
            userId,
            collectibleId: collectible.id,
            kind: AssetKind.ORIGINAL,
            status: AssetStatus.RESERVED,
            objectKey: key,
            contentType: input.contentType,
            declaredByteSize: BigInt(input.size),
            byteSize: 0n,
            reservationExpiresAt: expiresAt,
            version: collectible.processingVersion
          }
        });
      } catch (error) {
        if (!(error instanceof Prisma.PrismaClientKnownRequestError) || error.code !== 'P2002') throw error;
        asset = await this.prisma.imageAsset.findUnique({ where: identity });
      }
    }
    if (!asset || asset.status !== AssetStatus.RESERVED) {
      throw new ApiError('CONFLICT', '该收藏已经上传过图片', HttpStatus.CONFLICT);
    }
    const renewed = await this.prisma.imageAsset.updateMany({
      where: { id: asset.id, status: AssetStatus.RESERVED },
      data: {
        objectKey: key,
        contentType: input.contentType,
        declaredByteSize: BigInt(input.size),
        byteSize: 0n,
        reservationExpiresAt: expiresAt
      }
    });
    if (renewed.count !== 1) {
      throw new ApiError('CONFLICT', '该收藏已经上传过图片', HttpStatus.CONFLICT);
    }
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

    if (asset.status === AssetStatus.AVAILABLE) {
      const existingJob = await this.prisma.processingJob.findUnique({
        where: { idempotencyKey: `normalize:${input.collectibleId}:v${asset.version}` }
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

    const idempotencyKey = `normalize:${input.collectibleId}:v${asset.version}`;
    const result = await this.prisma.$transaction(async (transaction) => {
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
      await transaction.collectible.update({
        where: { id: input.collectibleId },
        data: { processingStatus: ProcessingStatus.NORMALIZING, processingError: null }
      });
      const job = await transaction.processingJob.upsert({
        where: { idempotencyKey },
        create: {
          userId,
          collectibleId: input.collectibleId,
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
    await this.queues.add(
      'normalize',
      {
        processingJobId: result.jobId,
        collectibleId: input.collectibleId,
        userId,
        version: asset.version
      },
      idempotencyKey
    );
    return { jobId: result.jobId, processingStatus: ProcessingStatus.NORMALIZING };
  }
}
