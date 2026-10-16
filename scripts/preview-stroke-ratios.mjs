import { readFile, writeFile } from 'node:fs/promises';
import sharp from 'sharp';

const cutoutPath = process.argv[2];
const ratios = (process.argv[3] ?? '0.015,0.025,0.04').split(',').map(Number);

async function addWhiteStroke(source, strokeRatio) {
  const meta = await sharp(source).metadata();
  if (!meta.hasAlpha || !meta.width || !meta.height) return source;
  const strokePx = Math.max(2, Math.round(Math.min(meta.width, meta.height) * strokeRatio));
  // 主体贴边时给描边留出膨胀空间，否则贴边一侧白边会被画布裁掉
  const pad = Math.ceil(strokePx * 2);
  const padded = await sharp(source)
    .extend({ top: pad, bottom: pad, left: pad, right: pad, background: { r: 0, g: 0, b: 0, alpha: 0 } })
    .png().toBuffer();
  const pm = await sharp(padded).metadata();
  const sigma = Math.max(0.5, strokePx / 2);
  const alpha = await sharp(padded).extractChannel('alpha').toBuffer();
  const blurred = await sharp(alpha).blur(sigma).png().toBuffer();
  const blurredGray = await sharp(blurred).extractChannel('red').toBuffer();
  const dilated = await sharp(blurredGray).composite([{ input: alpha, blend: 'lighten' }]).linear(2.5, 0).toBuffer();
  const silhouette = await sharp({
    create: { width: pm.width, height: pm.height, channels: 3, background: { r: 255, g: 255, b: 255 } }
  }).joinChannel(dilated).png().toBuffer();
  return sharp(silhouette).composite([{ input: padded }]).png().toBuffer();
}

const src = await readFile(cutoutPath);
const H = 720;
const variants = [];
for (const r of ratios) {
  const out = await addWhiteStroke(src, r);
  const resized = await sharp(out).resize({ height: H, fit: 'inside' }).png().toBuffer();
  variants.push({ r, img: resized, meta: await sharp(resized).metadata() });
}

const pad = 80;
const W = pad * (variants.length + 1) + variants.reduce((s, v) => s + v.meta.width, 0);
const HH = H + pad * 2;
const dark = { r: 40, g: 46, b: 54 };
const layers = [];
let x = pad;
for (const v of variants) {
  layers.push({ input: v.img, left: x, top: pad });
  x += v.meta.width + pad;
}
const canvas = await sharp({ create: { width: W, height: HH, channels: 3, background: dark } })
  .composite(layers).png().toBuffer();
const outPath = 'generated-images/stroke-preview-ratios.png';
await writeFile(outPath, canvas);
console.log('已生成三档粗细对比图:', outPath, '(比例', ratios.join('/'), ')');
