import { createHash, createHmac } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { loadEnvFile } from 'node:process';
import { resolve } from 'node:path';

loadEnvFile(resolve(process.cwd(), '.env'));

const { COS_SECRET_ID, COS_SECRET_KEY, COS_BUCKET, COS_REGION } = process.env;
const imgPath = resolve(process.cwd(), 'testIMG.jpg');
const img = readFileSync(imgPath);
const key = `users/test-post-object-${Date.now()}.jpg`;

const now = Math.floor(Date.now() / 1000);
const startTime = now - 60;
const expiredTime = now + 600;
const keyTime = `${startTime};${expiredTime}`;

const policyObj = {
  expiration: new Date(expiredTime * 1000).toISOString(),
  conditions: [
    { bucket: COS_BUCKET },
    { 'q-sign-algorithm': 'sha1' },
    { 'q-ak': COS_SECRET_ID },
    { 'q-sign-time': keyTime },
    ['eq', '$key', key],
    ['content-length-range', 1, img.length],
    ['starts-with', '$Content-Type', 'image/']
  ]
};
const policy = Buffer.from(JSON.stringify(policyObj)).toString('base64');
const signKey = createHmac('sha1', COS_SECRET_KEY).update(keyTime).digest('hex');
const stringToSign = createHash('sha1').update(Buffer.from(policy, 'base64')).digest('hex');
const signature = createHmac('sha1', signKey).update(stringToSign).digest('hex');

const form = new FormData();
form.append('key', key);
form.append('success_action_status', '200');
form.append('Content-Type', 'image/jpeg');
form.append('q-sign-algorithm', 'sha1');
form.append('q-ak', COS_SECRET_ID);
form.append('q-sign-time', keyTime);
form.append('q-key-time', keyTime);
form.append('q-signature', signature);
form.append('policy', policy);
form.append('file', new Blob([img], { type: 'image/jpeg' }), 'testIMG.jpg');

(async () => {
  const res = await fetch(`https://${COS_BUCKET}.cos.${COS_REGION}.myqcloud.com`, { method: 'POST', body: form });
  const text = await res.text();
  console.log('status:', res.status);
  console.log(text.slice(0, 800));
})();
