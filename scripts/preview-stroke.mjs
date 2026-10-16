import { readFile, writeFile } from 'node:fs/promises';
import sharp from 'sharp';

const cutoutPath = process.argv[2];
const ratio = Number(process.argv[3] ?? 0.08);
const DOWN = Number(process.argv[4] ?? 2); // 降采样倍数（越大越平滑，越小越锐利）

async function addWhiteStroke(source, strokeRatio, down) {
  const meta = await sharp(source).metadata();
  if (!meta.hasAlpha || !meta.width || !meta.height) return source;
  const shortSide = Math.min(meta.width, meta.height);
  const strokePx = Math.max(2, Math.round(shortSide * strokeRatio));
  // 主体贴边时给描边留出膨胀空间，否则贴边一侧白边会被画布裁掉
  const pad = Math.ceil(strokePx * 2);
  const padded = await sharp(source)
    .extend({ top: pad, bottom: pad, left: pad, right: pad, background: { r: 0, g: 0, b: 0, alpha: 0 } })
    .png().toBuffer();
  const W = meta.width + pad * 2, H = meta.height + pad * 2;

  // 低分辨率：膨胀出「软 alpha」（带渐变过渡），先位移再锐化，而不是先硬化再位移。
  // 位移作用在渐变上 → 轮廓不规则但边缘平滑；最后在原尺寸硬化成 1px 硬边，不羽化也不锯齿。
  const w = Math.max(64, Math.round(W / down));
  const h = Math.max(64, Math.round(H / down));
  const sigma = Math.max(0.5, (strokePx / down) / 2);
  const alpha = await sharp(padded).resize(w, h).extractChannel('alpha').toBuffer();
  const blurred = await sharp(alpha).blur(sigma).png().toBuffer();
  const blurredGray = await sharp(blurred).extractChannel('red').toBuffer();
  const soft = await sharp(blurredGray).composite([{ input: alpha, blend: 'lighten' }]).toBuffer();
  // 白色剪影 + 软 alpha，交给 feDisplacementMap 抖动出「手绘不规则」轮廓（保持渐变）
  const softSil = await sharp({ create: { width: w, height: h, channels: 3, background: { r: 255, g: 255, b: 255 } } })
    .joinChannel(soft).png().toBuffer();

  // 抖动幅度取描边宽度的约 55%，在低分辨率图上按比例缩小
  const scale = Math.max(2, Math.round((strokePx * 0.3) / down));
  const b64 = softSil.toString('base64');
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}">
    <defs>
      <filter id="hand" x="-40%" y="-40%" width="180%" height="180%">
        <feTurbulence type="fractalNoise" baseFrequency="0.02" numOctaves="3" seed="7" result="noise"/>
        <feDisplacementMap in="SourceGraphic" in2="noise" scale="${scale}" xChannelSelector="R" yChannelSelector="G"/>
      </filter>
    </defs>
    <image href="data:image/png;base64,${b64}" x="0" y="0" width="${w}" height="${h}" filter="url(#hand)"/>
  </svg>`;
  const displacedLow = await sharp(Buffer.from(svg)).png().toBuffer();

  // 放大回原尺寸：插值让位移后的软 alpha 边缘平滑（抗锯齿）
  const displaced = await sharp(displacedLow).resize(W, H).png().toBuffer();
  const displacedAlpha = await sharp(displaced).extractChannel('alpha').toBuffer();
  // 原尺寸硬阈值：轮廓保持不规则（手绘感），但边界落在平滑渐变上 → 1px 锐边，不羽化不锯齿
  const mask = await sharp(displacedAlpha).threshold(8).extractChannel('red').toBuffer();
  const silhouette = await sharp({ create: { width: W, height: H, channels: 3, background: { r: 255, g: 255, b: 255 } } })
    .joinChannel(mask).png().toBuffer();
  return sharp(silhouette).composite([{ input: padded }]).png().toBuffer();
}

const src = await readFile(cutoutPath);
const meta = await sharp(src).metadata();
console.log('输入:', cutoutPath, `(${meta.width}x${meta.height}), down=${DOWN}`);

const t0 = Date.now();
const stroked = await addWhiteStroke(src, ratio, DOWN);
console.log(`描边耗时: ${Date.now() - t0}ms`);

const H = 760;
const left = await sharp(src).resize({ height: H, fit: 'inside' }).png().toBuffer();
const right = await sharp(stroked).resize({ height: H, fit: 'inside' }).png().toBuffer();
const lm = await sharp(left).metadata();
const rm = await sharp(right).metadata();
const pad = 90;
const W = pad * 3 + lm.width + rm.width;
const HH = H + pad * 2;
const compare = await sharp({ create: { width: W, height: HH, channels: 3, background: { r: 240, g: 170, b: 80 } } })
  .composite([{ input: left, left: pad, top: pad }, { input: right, left: pad * 2 + lm.width, top: pad }]).png().toBuffer();
await writeFile('generated-images/stroke-preview-compare.png', compare);
const darkCanvas = await sharp({ create: { width: rm.width + pad * 2, height: HH, channels: 3, background: { r: 40, g: 46, b: 54 } } })
  .composite([{ input: right, left: pad, top: pad }]).png().toBuffer();
await writeFile('generated-images/stroke-preview-dark.png', darkCanvas);
console.log('已生成: stroke-preview-compare.png / stroke-preview-dark.png');
