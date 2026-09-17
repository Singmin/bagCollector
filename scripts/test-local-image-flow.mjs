import { readFile } from 'node:fs/promises';
import { basename, extname } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import sharp from 'sharp';

const origin = process.env.API_URL || 'http://127.0.0.1:3001/api';
const suppliedPath = process.argv.slice(2).find((argument) => argument !== '--');
const fallbackPng = await sharp({
  create: { width: 512, height: 512, channels: 3, background: { r: 245, g: 245, b: 240 } }
})
  .composite([
    {
      input: Buffer.from('<svg width="512" height="512"><rect x="116" y="76" width="280" height="360" rx="48" fill="#6b4932"/></svg>')
    }
  ])
  .png()
  .toBuffer();
const body = suppliedPath ? await readFile(suppliedPath) : fallbackPng;
const fileName = suppliedPath ? basename(suppliedPath) : 'local-flow.png';
const contentType = ({
  '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.webp': 'image/webp',
  '.heic': 'image/heic', '.heif': 'image/heif'
})[extname(fileName).toLowerCase()] || 'image/jpeg';

let accessToken = '';
let collectibleId = '';

async function request(path, init = {}, expected = [200, 201]) {
  const response = await fetch(`${origin}${path}`, {
    ...init,
    headers: {
      ...(init.body !== undefined && !(init.body instanceof FormData) ? { 'content-type': 'application/json' } : {}),
      ...(accessToken ? { Authorization: `Bearer ${accessToken}` } : {}),
      ...(init.headers || {})
    }
  });
  const data = await response.json().catch(() => null);
  if (!expected.includes(response.status)) {
    throw new Error(`${init.method || 'GET'} ${path}: ${response.status} ${JSON.stringify(data)}`);
  }
  return data;
}

async function waitForStatus(status, attempts = 360) {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const item = await request(`/collectibles/${collectibleId}`);
    if (item.processingStatus === status) return item;
    if (item.processingStatus === 'FAILED') throw new Error(item.processingError || 'Image processing failed');
    await delay(500);
  }
  throw new Error(`Timed out waiting for ${status}`);
}

try {
  const tokens = await request('/auth/wechat/login', {
    method: 'POST', body: JSON.stringify({ code: `local-image-${Date.now()}` })
  });
  accessToken = tokens.accessToken;
  const collectible = await request('/collectibles', {
    method: 'POST', body: JSON.stringify({ name: '本地图片链路验证' })
  });
  collectibleId = collectible.id;
  const policy = await request('/uploads/policy', {
    method: 'POST',
    body: JSON.stringify({ collectibleId, fileName, contentType, size: body.length })
  });
  const form = new FormData();
  form.append('file', new Blob([body], { type: contentType }), fileName);
  const uploaded = await fetch(policy.uploadUrl, {
    method: 'POST', headers: { Authorization: `Bearer ${accessToken}` }, body: form
  });
  if (!uploaded.ok) throw new Error(`Upload failed: ${uploaded.status} ${await uploaded.text()}`);
  await request('/uploads/complete', {
    method: 'POST', body: JSON.stringify({ assetId: policy.assetId, collectibleId, key: policy.key })
  });
  const normalized = await waitForStatus('AWAITING_CROP');
  const standard = await fetch(normalized.standardImageUrl);
  if (!standard.ok || !(standard.headers.get('content-type') || '').startsWith('image/')) {
    throw new Error(`Standard image URL failed: ${standard.status}`);
  }
  await request(`/collectibles/${collectibleId}/crop`, {
    method: 'POST', body: JSON.stringify({ x: 0, y: 0, width: 1, height: 1, rotation: 0 })
  });
  const ready = await waitForStatus('READY');
  const display = await fetch(ready.displayImageUrl);
  if (!display.ok || !(display.headers.get('content-type') || '').startsWith('image/')) {
    throw new Error(`Display image URL failed: ${display.status}`);
  }
  const displayBody = Buffer.from(await display.arrayBuffer());
  const metadata = await sharp(displayBody).metadata();
  const statistics = await sharp(displayBody).stats();
  const alpha = statistics.channels[3];
  if (!metadata.hasAlpha || !alpha || alpha.min >= 255 || alpha.max <= 0) {
    throw new Error('Display image does not contain a valid transparent background');
  }
  console.log(`Local image flow passed: ${fileName} -> ${ready.processingStatus}`);
} finally {
  if (accessToken && collectibleId) {
    await request(`/collectibles/${collectibleId}`, { method: 'DELETE' }).catch(() => undefined);
  }
}
