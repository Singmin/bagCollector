import { createHash, createHmac } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { loadEnvFile } from 'node:process';
import { resolve } from 'node:path';

loadEnvFile(resolve(process.cwd(), '.env'));

const base = 'http://127.0.0.1:3001/api';
const imgPath = resolve(process.cwd(), 'testIMG.jpg');
const img = readFileSync(imgPath);

async function req(path, opts = {}) {
  const res = await fetch(`${base}${path}`, {
    ...opts,
    headers: {
      ...(opts.body ? { 'content-type': 'application/json' } : {}),
      ...opts.headers
    }
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    console.error(`❌ ${opts.method || 'GET'} ${path} -> ${res.status}`, JSON.stringify(data, null, 2));
    throw new Error(`${res.status}`);
  }
  return data;
}

(async () => {
  console.log('image bytes:', img.length);

  const login = await req('/auth/wechat/login', {
    method: 'POST',
    body: JSON.stringify({ code: 'test-upload-diag', deviceName: 'node-script' })
  });
  console.log('login ok');
  const auth = { Authorization: `Bearer ${login.accessToken}` };

  let shelves = await req('/shelves', { headers: auth });
  if (!shelves.length) {
    shelves = [await req('/shelves', { method: 'POST', headers: auth, body: JSON.stringify({ name: '未分类', theme: 'SAGE' }) })];
  }
  const collectible = await req('/collectibles', {
    method: 'POST',
    headers: auth,
    body: JSON.stringify({ name: 'test-upload', shelfId: shelves[0].id })
  });
  console.log('collectible:', collectible.id, collectible.processingStatus);

  const policy = await req('/uploads/policy', {
    method: 'POST',
    headers: auth,
    body: JSON.stringify({
      collectibleId: collectible.id,
      fileName: 'testIMG.jpg',
      contentType: 'image/jpeg',
      size: img.length
    })
  });
  console.log('policy:', JSON.stringify(policy, null, 2));

  const form = new FormData();
  for (const [k, v] of Object.entries(policy.formData)) {
    form.append(k, v);
  }
  form.append('file', new Blob([img], { type: 'image/jpeg' }), 'testIMG.jpg');

  console.log('POST ->', policy.uploadUrl);
  const decodedPolicy = Buffer.from(policy.formData.policy, 'base64').toString('utf8');
  console.log('local SHA1(policy base64):', createHash('sha1').update(policy.formData.policy).digest('hex'));
  console.log('local SHA1(policy decoded):', createHash('sha1').update(decodedPolicy).digest('hex'));
  console.log('decoded policy:', decodedPolicy);
  const uploadRes = await fetch(policy.uploadUrl, { method: 'POST', body: form });
  const uploadText = await uploadRes.text();
  console.log('COS response:', uploadRes.status, uploadText.slice(0, 500));

  if (uploadRes.ok) {
    const complete = await req('/uploads/complete', {
      method: 'POST',
      headers: auth,
      body: JSON.stringify({ assetId: policy.assetId, collectibleId: collectible.id, key: policy.key })
    });
    console.log('complete:', complete);
  }
})();
