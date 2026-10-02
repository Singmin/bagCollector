import { createHmac, timingSafeEqual } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdir, stat, writeFile } from 'node:fs/promises';
import type { Readable } from 'node:stream';
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

  private verifyToken(token: string): { key: string } {
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
    return { key: decoded.key };
  }

  private contentTypeFor(key: string) {
    return ({
      '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.webp': 'image/webp',
      '.heic': 'image/heic', '.heif': 'image/heif'
    } as Record<string, string>)[extname(key).toLowerCase()] ?? 'application/octet-stream';
  }

  localStream(token: string) {
    if (!this.isLocal()) throw new ApiError('NOT_FOUND', '图片不存在', HttpStatus.NOT_FOUND);
    const { key } = this.verifyToken(token);
    return { stream: createReadStream(this.localPath(key)), type: this.contentTypeFor(key) };
  }

  /** COS 对象读取流（代理输出用，不经过万象/签名 URL）。OutputType:'stream' 让 SDK 返回流而非整体缓冲。 */
  private cosStream(key: string): Promise<Readable> {
    return new Promise((resolve, reject) => {
      this.client.getObject(
        {
          Bucket: this.config.COS_BUCKET,
          Region: this.config.COS_REGION,
          Key: key,
          OutputType: 'stream'
        } as never,
        (error, data) => (error ? reject(error) : resolve(data.Body as unknown as Readable))
      );
    });
  }

  /**
   * 带签名 token 的对象流：local 与 cos 两种驱动统一从 API 域名输出。
   * 小程序的 <image> 组件不受合法域名校验，但 canvas 2d 加载网络图受
   * downloadFile 域名白名单限制 —— 若把 COS 签名 URL 直接给前端，
   * 真机裁剪页会因 COS 域名不在白名单而加载失败；统一代理后
   * 只需把 API 域名加进白名单即可。
   */
  async streamByToken(token: string) {
    const { key } = this.verifyToken(token);
    const type = this.contentTypeFor(key);
    const stream = this.isLocal() ? createReadStream(this.localPath(key)) : await this.cosStream(key);
    return { stream, type };
  }

  signedUrl(key: string, expires = 600): Promise<string> {
    this.assertConfigured();
    const token = this.localToken(key, Date.now() + expires * 1_000);
    /* local 与 cos 统一走 API 域名代理（canvas 合法域名只需配 API 一个）；
       万象抠图所需的 COS 签名 URL 在 worker 的 object-store 里单独生成，不经此处 */
    return Promise.resolve(`${this.config.API_PUBLIC_URL}/api/assets/file?token=${encodeURIComponent(token)}`);
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
