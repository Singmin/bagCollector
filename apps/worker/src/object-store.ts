import { mkdir, readFile, unlink, writeFile } from 'node:fs/promises';
import { dirname, resolve, sep } from 'node:path';
import COS from 'cos-nodejs-sdk-v5';
import { config } from './config.js';

const client = new COS({ SecretId: config.COS_SECRET_ID, SecretKey: config.COS_SECRET_KEY });
// A sample copy is optional; bound its upload so it cannot hold live recognition indefinitely.
const sampleClient = new COS({ SecretId: config.COS_SECRET_ID, SecretKey: config.COS_SECRET_KEY, Timeout: 3000 });
const localRoot = resolve(process.cwd(), config.LOCAL_STORAGE_PATH);

function localPath(key: string) {
  const path = resolve(localRoot, key);
  if (path !== localRoot && !path.startsWith(`${localRoot}${sep}`)) throw new Error('Invalid local object key');
  return path;
}

export function getObject(key: string): Promise<Buffer> {
  if (config.STORAGE_DRIVER === 'local') return readFile(localPath(key));
  return new Promise((resolve, reject) => {
    client.getObject(
      { Bucket: config.COS_BUCKET, Region: config.COS_REGION, Key: key },
      (error, data) => {
        if (error) reject(error);
        else resolve(Buffer.isBuffer(data.Body) ? data.Body : Buffer.from(data.Body as any));
      }
    );
  });
}

export interface SignedObjectUrlOptions {
  /** 需要签进 URL 的查询参数，例如数据万象的 `ci-process`。 */
  query?: Record<string, string>;
  /** 签名有效期（秒）。 */
  expiresSeconds?: number;
}

/**
 * 生成带签名的 COS 对象 GET URL。
 *
 * 数据万象的「下载时处理」就是靠这个 URL 触发的：把 `ci-process=AIPicMatting`（接口名由
 * `CI_MATTING_PROCESS` 决定）一起签进签名，
 * 万象就会在返回响应体时执行抠图。桶可以保持私有，不需要开放读权限。
 *
 * 仅 COS 存储驱动可用：本地磁盘存储没有可签名的对象地址，调用会直接抛错。
 */
export function getSignedObjectUrl(key: string, options: SignedObjectUrlOptions = {}): string {
  if (config.STORAGE_DRIVER !== 'cos') {
    throw new Error('签名 URL 仅支持 COS 存储驱动：数据万象无法读取本地磁盘上的图片');
  }
  return client.getObjectUrl({
    Bucket: config.COS_BUCKET,
    Region: config.COS_REGION,
    Key: key,
    Method: 'GET',
    Sign: true,
    Expires: options.expiresSeconds ?? 600,
    Query: options.query
  });
}

export function putObject(key: string, body: Buffer, contentType: string, privateObject = false) {
  if (config.STORAGE_DRIVER === 'local') {
    const path = localPath(key);
    return mkdir(dirname(path), { recursive: true }).then(() => writeFile(path, body));
  }
  return new Promise<void>((resolve, reject) => {
    (privateObject ? sampleClient : client).putObject(
      {
        Bucket: config.COS_BUCKET,
        Region: config.COS_REGION,
        Key: key,
        Body: body,
        ContentType: contentType,
        ContentLength: body.length,
        /* 处理产物的 key 都带 v{n} 版本号，对象内容永不变化 —— 允许 CDN/浏览器缓存一年 */
        CacheControl: privateObject ? 'private, no-store' : 'public, max-age=31536000, immutable',
        ...(privateObject ? { ACL: 'private' as const } : {}),
        ServerSideEncryption: 'AES256'
      },
      (error) => (error ? reject(error) : resolve())
    );
  });
}

export async function deleteObjects(keys: string[]) {
  if (config.STORAGE_DRIVER === 'local') {
    await Promise.all(
      keys.map((key) =>
        unlink(localPath(key)).catch((error: NodeJS.ErrnoException) => {
          if (error.code !== 'ENOENT') throw error;
        })
      )
    );
    return;
  }
  for (let offset = 0; offset < keys.length; offset += 1_000) {
    const chunk = keys.slice(offset, offset + 1_000);
    await new Promise<void>((resolve, reject) => {
      client.deleteMultipleObject(
        {
          Bucket: config.COS_BUCKET,
          Region: config.COS_REGION,
          Objects: chunk.map((Key) => ({ Key })),
          Quiet: true
        },
        (error, data) => (error ? reject(error) : data.Error?.length ? reject(new Error('COS partial deletion failed')) : resolve())
      );
    });
  }
}
