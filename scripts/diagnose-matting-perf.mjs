// 抠图性能诊断：按真实链路尺寸测量 rembg 各阶段耗时与常驻内存变化。
// 用法: node scripts/diagnose-matting-perf.mjs
import { execSync } from 'node:child_process';
import sharp from 'sharp';

const baseUrl = (process.env.REMBG_URL || 'http://127.0.0.1:7000').replace(/\/$/, '');
const model = process.env.REMBG_MODEL || 'birefnet-general-lite';
const timeoutMs = Number(process.env.REMBG_TIMEOUT_MS || 120_000);

function rembgProcessRssMb() {
  try {
    const out = execSync(
      'tasklist /FO CSV /NH /FI "IMAGENAME eq python.exe"',
      { encoding: 'utf8', windowsHide: true }
    );
    let total = 0;
    for (const line of out.split(/\r?\n/)) {
      if (!line.includes('python.exe')) continue;
      const cols = line.split('","').map((c) => c.replace(/"/g, ''));
      const kb = Number((cols[4] || '').replace(/[^0-9]/g, ''));
      if (kb) total += kb;
    }
    return total / 1024;
  } catch {
    return -1;
  }
}

// 造一张贴近手机照片的图（高频细节，避免纯色被编码器过度压缩）。
function photoRaw(width, height) {
  const raw = Buffer.alloc(width * height * 3);
  let seed = 12345;
  for (let i = 0; i < raw.length; i += 3) {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    const base = (seed >>> 16) & 0xff;
    const y = Math.floor(i / 3 / width);
    const x = Math.floor(i / 3) % width;
    // 中心一个亮色"主体"，四周稍暗，模拟纸袋照片
    const cx = x - width / 2;
    const cy = y - height / 2;
    const inSubject = cx * cx / (0.35 * width) ** 2 + cy * cy / (0.45 * height) ** 2 < 1;
    const v = inSubject ? 150 + (base % 90) : 200 + (base % 40);
    raw[i] = v;
    raw[i + 1] = Math.min(255, v + ((base % 17) - 8));
    raw[i + 2] = Math.min(255, v - 10 + (base % 9));
  }
  return raw;
}

async function callRembg(buf) {
  const form = new FormData();
  form.append('file', new Blob([buf], { type: 'image/jpeg' }), 'probe.jpg');
  form.append('model', model);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const t0 = Date.now();
  try {
    const res = await fetch(`${baseUrl}/api/remove`, { method: 'POST', body: form, signal: controller.signal });
    const body = Buffer.from(await res.arrayBuffer());
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return { ms: Date.now() - t0, body };
  } finally {
    clearTimeout(timer);
  }
}

async function measure(label, inputBuffer, inputMeta) {
  const rssBefore = rembgProcessRssMb();
  const { ms, body } = await callRembg(inputBuffer);
  const rssAfter = rembgProcessRssMb();
  const outMeta = await sharp(body).metadata();
  console.log(
    `${label.padEnd(34)} in=${inputMeta} 推断+传输=${String(ms).padStart(6)}ms  ` +
      `返回=${(body.length / 1048576).toFixed(2)}MB ${outMeta.width}x${outMeta.height}  ` +
      `rembgRSS=${rssBefore.toFixed(0)}→${rssAfter.toFixed(0)}MB`
  );
  return { ms, bytes: body.length };
}

console.log(`rembg=${baseUrl} model=${model}`);
console.log(`当前 rembg 常驻内存: ${rembgProcessRssMb().toFixed(0)}MB\n`);

// 1) 现有 warmup 的尺寸（256x256）——这是先前结论的来源
const tiny = await sharp(photoRaw(256, 256), { raw: { width: 256, height: 256, channels: 3 } })
  .jpeg({ quality: 90 })
  .toBuffer();
await measure('A. 256x256 (旧 warmup 尺寸)', tiny, '256x256');

// 2) 改造后 worker 真实送出的尺寸：3000x4000 裁剪图 -> 最长边 1024
const cropRaw = photoRaw(3000, 4000);
const cropFull = await sharp(cropRaw, { raw: { width: 3000, height: 4000, channels: 3 } })
  .jpeg({ quality: 90, mozjpeg: true })
  .toBuffer();
console.log(`\n(原始裁剪图 3000x4000 = ${(cropFull.length / 1048576).toFixed(2)}MB，即改造前直送 rembg 的输入)`);
const resized = await sharp(cropFull)
  .resize({ width: 1024, height: 1024, fit: 'inside', withoutEnlargement: true })
  .jpeg({ quality: 90, mozjpeg: true })
  .toBuffer();
const rm = await sharp(resized).metadata();
await measure(`B. ${rm.width}x${rm.height} (改造后实际输入)`, resized, `${rm.width}x${rm.height}`);

// 3) 稳定态重复 3 次，看耗时与内存是否收敛
console.log('\n--- 稳态重复（同一输入）---');
for (let i = 1; i <= 3; i += 1) {
  await measure(`C${i}. 稳态第 ${i} 次`, resized, `${rm.width}x${rm.height}`);
}

console.log(`\n结束时常驻内存: ${rembgProcessRssMb().toFixed(0)}MB`);
