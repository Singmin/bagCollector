import { mkdir, readFile, unlink, writeFile } from 'node:fs/promises';
import { dirname, resolve, sep } from 'node:path';
import COS from 'cos-nodejs-sdk-v5';
import { config } from './config.js';

const client = new COS({ SecretId: config.COS_SECRET_ID, SecretKey: config.COS_SECRET_KEY });
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

export function putObject(key: string, body: Buffer, contentType: string) {
  if (config.STORAGE_DRIVER === 'local') {
    const path = localPath(key);
    return mkdir(dirname(path), { recursive: true }).then(() => writeFile(path, body));
  }
  return new Promise<void>((resolve, reject) => {
    client.putObject(
      {
        Bucket: config.COS_BUCKET,
        Region: config.COS_REGION,
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
        (error) => (error ? reject(error) : resolve())
      );
    });
  }
}
