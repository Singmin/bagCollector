// ---------------------------------------------------------------------------
// 已废弃（DEPRECATED）：预热自托管 rembg 模型
//
// 2026-09-21 起抠图已切换为腾讯云数据万象（2026-09-22 接口定为通用抠图 AIPicMatting），本脚本不在主链路上，
// 主链路没有任何地方会用到它预热出来的服务。
// 真实样本验收请用 `pnpm ci:verify-matting -- <图片路径>`，说明见 docs/TENCENT_CI_MATTING.md。
// 完整清单见 apps/worker/src/matting.ts 顶部注释。
// ---------------------------------------------------------------------------
import sharp from 'sharp';

const baseUrl = (process.env.REMBG_URL || 'http://127.0.0.1:7000').replace(/\/$/, '');
const model = process.env.REMBG_MODEL || 'birefnet-general-lite';
const timeoutMs = Number(process.env.REMBG_TIMEOUT_MS || 120_000);
const sample = await sharp({
  create: { width: 256, height: 256, channels: 3, background: { r: 250, g: 250, b: 250 } }
})
  .composite([
    {
      input: Buffer.from('<svg width="256" height="256"><circle cx="128" cy="128" r="72" fill="#202020"/></svg>')
    }
  ])
  .jpeg({ quality: 90 })
  .toBuffer();

const form = new FormData();
form.append('file', new Blob([sample], { type: 'image/jpeg' }), 'warmup.jpg');
form.append('model', model);
const controller = new AbortController();
const timeout = setTimeout(() => controller.abort(), timeoutMs);

try {
  const startedAt = Date.now();
  const response = await fetch(`${baseUrl}/api/remove`, { method: 'POST', body: form, signal: controller.signal });
  if (!response.ok) throw new Error(`rembg warm-up failed with HTTP ${response.status}`);
  const output = Buffer.from(await response.arrayBuffer());
  const metadata = await sharp(output).metadata();
  if (metadata.format !== 'png' || !metadata.hasAlpha) throw new Error('rembg warm-up did not return an alpha PNG');
  console.log(`rembg warm-up passed: model=${model}, ${metadata.width}x${metadata.height}, ${Date.now() - startedAt}ms`);
} finally {
  clearTimeout(timeout);
}
