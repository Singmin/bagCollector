import { loadEnvFile } from 'node:process';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { readFileSync } from 'node:fs';

loadEnvFile(resolve(process.cwd(), '.env'));

const require = createRequire(resolve(process.cwd(), 'apps/api/package.json'));
const COS = require('cos-nodejs-sdk-v5');

const client = new COS({ SecretId: process.env.COS_SECRET_ID, SecretKey: process.env.COS_SECRET_KEY });
const Bucket = process.env.COS_BUCKET;
const Region = process.env.COS_REGION;

const put = (Key, Body, ContentType) =>
  new Promise((res, rej) => client.putObject({ Bucket, Region, Key, Body, ContentType }, (e, d) => (e ? rej(e) : res(d))));
const del = (Key) =>
  new Promise((res, rej) => client.deleteObject({ Bucket, Region, Key }, (e, d) => (e ? rej(e) : res(d))));
const sign = (Key) =>
  new Promise((res, rej) => client.getObjectUrl({ Bucket, Region, Key, Sign: true, Expires: 600 }, (e, d) => (e ? rej(e) : res(d.Url))));

const key = `diag/probe-${Date.now()}.jpg`;
const body = readFileSync('testIMG.jpg');

console.log(`PROBE -> ${key}  (${body.byteLength} bytes)`);

try {
  const r = await put(key, body, 'image/jpeg');
  console.log('  PutObject OK, etag =', r.ETag);
} catch (e) {
  console.log('  PutObject FAILED:', e.statusCode, e.code, e.message);
  process.exit(1);
}

const url = await sign(key);
const back = await fetch(url);
const buf = await back.arrayBuffer();
console.log('  GetObjectUrl ->', back.status, back.headers.get('content-type'), buf.byteLength, 'bytes');

await del(key);
console.log('  cleaned up (probe object deleted)');
