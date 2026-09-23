// 并发吞吐测试：回答"线上一堆人同时上传会怎样"。
// 用法: node scripts/measure-matting-throughput.mjs
import sharp from 'sharp';

const baseUrl = (process.env.REMBG_URL || 'http://127.0.0.1:7000').replace(/\/$/, '');
const model = process.env.REMBG_MODEL || 'birefnet-general-lite';
const timeoutMs = Number(process.env.REMBG_TIMEOUT_MS || 120_000);
let INPUT;

function photoRaw(width, height) {
  const raw = Buffer.alloc(width * height * 3);
  let seed = 99991;
  for (let i = 0; i < raw.length; i += 3) {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    const base = (seed >>> 16) & 0xff;
    const px = i / 3;
    const x = px % width;
    const y = Math.floor(px / width);
    const cx = x - width / 2;
    const cy = y - height / 2;
    const inSubject = (cx * cx) / (0.35 * width) ** 2 + (cy * cy) / (0.45 * height) ** 2 < 1;
    const v = inSubject ? 150 + (base % 90) : 200 + (base % 40);
    raw[i] = v;
    raw[i + 1] = Math.min(255, v + ((base % 17) - 8));
    raw[i + 2] = Math.min(255, v - 10 + (base % 9));
  }
  return raw;
}

async function one(hashTag) {
  const form = new FormData();
  form.append('file', new Blob([INPUT], { type: 'image/jpeg' }), `${hashTag}.jpg`);
  form.append('model', model);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const t0 = Date.now();
  try {
    const res = await fetch(`${baseUrl}/api/remove`, { method: 'POST', body: form, signal: controller.signal });
    await res.arrayBuffer();
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return Date.now() - t0;
  } finally {
    clearTimeout(timer);
  }
}

console.log(`rembg=${baseUrl} model=${model}`);
const raw = photoRaw(768, 1024);
INPUT = await sharp(raw, { raw: { width: 768, height: 1024, channels: 3 } })
  .jpeg({ quality: 90, mozjpeg: true })
  .toBuffer();
console.log(`测试输入: 768x1024 JPEG ${(INPUT.length / 1024).toFixed(0)}KB（改造后 worker 的真实输入尺寸）\n`);

// 预热，确保模型已加载（否则第一次会混入冷启动时间）
console.log('预热中...');
await one('warm');
console.log('预热完成\n');

for (const n of [1, 2, 4]) {
  const t0 = Date.now();
  const times = await Promise.all(Array.from({ length: n }, (_, i) => one(`c${i}`)));
  const wall = Date.now() - t0;
  const min = Math.min(...times);
  const max = Math.max(...times);
  const perMin = (n / wall) * 60_000;
  console.log(
    `并发 ${String(n).padStart(2)} 张: 总耗时 ${String((wall / 1000).toFixed(1)).padStart(6)}s  ` +
      `单张 ${(min / 1000).toFixed(1)}–${(max / 1000).toFixed(1)}s  ` +
      `吞吐 ${perMin.toFixed(1)} 张/分 = ${(perMin * 60).toFixed(0)} 张/小时`
  );
}
