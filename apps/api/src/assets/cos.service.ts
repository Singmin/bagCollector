import { createHmac, timingSafeEqual } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdir, stat, writeFile } from 'node:fs/promises';
import { dirname, extname, resolve, sep } from 'node:path';
import { HttpStatus, Injectable } from '@nestjs/common';
import COS from 'cos-nodejs-sdk-v5';
import { ApiError } from '../common/api-error.js';
import { env } from '../common/env.js';

@Injectable()
export class CosService {
  private readonly config = env();
  private readonly localRoot = resolve(process.cwd(), this.config.LOCAL_STORAGE_PATH);
  private readonly client = new COS({
    SecretId: this.config.COS_SECRET_ID,
    SecretKey: this.config.COS_SECRET_KEY
  });

  assertConfigured() {
    if (this.config.STORAGE_DRIVER === 'local') return;
    if (!this.config.COS_SECRET_ID || !this.config.COS_SECRET_KEY || !this.config.COS_BUCKET) {
      throw new ApiError('UPLOAD_INVALID', '对象存储尚未配置', HttpStatus.SERVICE_UNAVAILABLE);
    }
  }

  isLocal() {
    return this.config.STORAGE_DRIVER === 'local';
  }

  private localPath(key: string) {
    const path = resolve(this.localRoot, key);
    if (path !== this.localRoot && !path.startsWith(`${this.localRoot}${sep}`)) {
      throw new ApiError('UPLOAD_INVALID', '图片路径无效', HttpStatus.BAD_REQUEST);
    }
    return path;
  }

  async putLocalObject(key: string, body: Buffer) {
    if (!this.isLocal()) throw new ApiError('NOT_FOUND', '本地上传未启用', HttpStatus.NOT_FOUND);
    const path = this.localPath(key);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, body);
  }

  /**
   * 服务端直写对象，供管理后台的官方袋子原图上传使用（管理员不经 STS 直传 COS，
   * 统一走 API 服务器中转，本地/COS 两种驱动行为一致）。
   */
  async putObject(key: string, body: Buffer, contentType: string) {
    if (this.isLocal()) {
      await this.putLocalObject(key, body);
      return;
    }
    await new Promise<void>((resolve, reject) => {
      this.client.putObject(
        {
          Bucket: this.config.COS_BUCKET,
          Region: this.config.COS_REGION,
          Key: key,
          Body: body,
          ContentType: contentType,
          ContentLength: body.length,
          ServerSideEncryption: 'AES256'
        },
        (error) => (error ? reject(error) : resolve())
      );
    });
  }

  private localToken(key: string, expires: number) {
    const payload = Buffer.from(JSON.stringify({ key, expires })).toString('base64url');
    const signature = createHmac('sha256', this.config.JWT_SECRET).update(payload).digest('base64url');
    return `${payload}.${signature}`;
  }

  localStream(token: string) {
    if (!this.isLocal()) throw new ApiError('NOT_FOUND', '图片不存在', HttpStatus.NOT_FOUND);
    const [payload, provided] = token.split('.');
    if (!payload || !provided) throw new ApiError('FORBIDDEN', '图片链接无效', HttpStatus.FORBIDDEN);
    const expected = createHmac('sha256', this.config.JWT_SECRET).update(payload).digest();
    const actual = Buffer.from(provided, 'base64url');
    if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) {
      throw new ApiError('FORBIDDEN', '图片链接无效', HttpStatus.FORBIDDEN);
    }
    let decoded: { key?: string; expires?: number };
    try {
      decoded = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    } catch {
      throw new ApiError('FORBIDDEN', '图片链接无效', HttpStatus.FORBIDDEN);
    }
    if (!decoded.key || !decoded.expires || decoded.expires < Date.now()) {
      throw new ApiError('FORBIDDEN', '图片链接已过期', HttpStatus.FORBIDDEN);
    }
    const type = ({
      '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.webp': 'image/webp',
      '.heic': 'image/heic', '.heif': 'image/heif'
    } as Record<string, string>)[extname(decoded.key).toLowerCase()] ?? 'application/octet-stream';
    return { stream: createReadStream(this.localPath(decoded.key)), type };
  }

  signedUrl(key: string, expires = 600): Promise<string> {
    this.assertConfigured();
    if (this.isLocal()) {
      const token = this.localToken(key, Date.now() + expires * 1_000);
      return Promise.resolve(`${this.config.API_PUBLIC_URL}/api/assets/local?token=${encodeURIComponent(token)}`);
    }
    return new Promise((resolve, reject) => {
      this.client.getObjectUrl(
        {
          Bucket: this.config.COS_BUCKET,
          Region: this.config.COS_REGION,
          Key: key,
          Sign: true,
          Expires: expires,
          ...(this.config.COS_PUBLIC_HOST ? { Domain: this.config.COS_PUBLIC_HOST } : {})
        },
        (error, data) => {
          if (error) reject(error);
          else resolve(data.Url);
        }
      );
    });
  }

  headObject(key: string): Promise<{ contentLength: number; contentType?: string }> {
    this.assertConfigured();
    if (this.isLocal()) {
      return stat(this.localPath(key)).then((file) => ({ contentLength: file.size }));
    }
    return new Promise((resolve, reject) => {
      this.client.headObject(
        { Bucket: this.config.COS_BUCKET, Region: this.config.COS_REGION, Key: key },
        (error, data) => {
          if (error) reject(error);
          else resolve({
            contentLength: Number(data.headers?.['content-length'] ?? 0),
            contentType: data.headers?.['content-type']
          });
        }
      );
    });
  }
}
