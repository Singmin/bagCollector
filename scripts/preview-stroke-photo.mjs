import { readFile, writeFile } from 'node:fs/promises';
import sharp from 'sharp';

const inputPath = process.argv[2];
const ratio = Number(process.argv[3] ?? 0.035);
if (!inputPath) { console.error('用法: node scripts/preview-stroke-photo.mjs <黑底照片> [描边比例]'); process.exit(1); }

// 裁掉截图外围的白色边框：按「暗像素(亮度<150)在每行/列占比>5%」框出内容区，排除零星噪声
async function cropWhiteFrame(src) {
  const meta = await sharp(src).metadata();
  const { data, info } = await sharp(src).greyscale().raw().toBuffer({ resolveWithObject: true });
  const colC = new Array(info.width).fill(0);
  const rowC = new Array(info.height).fill(0);
  for (let y = 0; y < info.height; y++) {
    for (let x = 0; x < info.width; x++) {
      if (data[y * info.width + x] < 150) { colC[x]++; rowC[y]++; }
    }
  }
  const cTh = info.height * 0.05, rTh = info.width * 0.05;
  let minX = -1, minY = -1, maxX = -1, maxY = -1;
  for (let x = 0; x < info.width; x++) if (colC[x] > cTh) { if (minX < 0) minX = x; maxX = x; }
  for (let y = 0; y < info.height; y++) if (rowC[y] > rTh) { if (minY < 0) minY = y; maxY = y; }
  if (minX < 0) return src;
  const pad = 4;
  const left = Math.max(0, minX - pad), top = Math.max(0, minY - pad);
  const width = Math.min(info.width, maxX + 1 + pad) - left;
  const height = Math.min(info.height, maxY + 1 + pad) - top;
  console.log(`裁剪到 ${width}x${height}`);
  return sharp(src).extract({ left, top, width, height }).toBuffer();
}

// 黑底照片 → 透明抠图：亮度阈值出粗 mask，闭运算填补袋子内部的深色区域（提手等）
async function blackToAlpha(src) {
  const meta = await sharp(src).metadata();
  const gray = await sharp(src).greyscale().toBuffer();
  const mask0 = await sharp(gray).threshold(70).extractChannel('red').toBuffer();
  const closeSigma = Math.max(3, Math.round(Math.min(meta.width, meta.height) * 0.025));
  const closed = await sharp(mask0).blur(closeSigma).threshold(8).extractChannel('red').png().toBuffer();
  return sharp(src).ensureAlpha().joinChannel(closed).png().toBuffer();
}

async function trimTransparent(source) {
  try {
    const trimmed = await sharp(source).trim().png().toBuffer();
    const m = await sharp(trimmed).metadata();
    return m.width && m.height ? trimmed : source;
  } catch { return source; }
}

// 手绘描边（与 preview-stroke.mjs 同参数：硬边实心 + feDisplacementMap 抖动，down=8）
async function addWhiteStroke(source, strokeRatio) {
  const meta = await sharp(source).metadata();
  if (!meta.hasAlpha || !meta.width || !meta.height) return source;
  const shortSide = Math.min(meta.width, meta.height);
  const strokePx = Math.max(2, Math.round(shortSide * strokeRatio));
  // 主体贴边时给描边留出膨胀空间（描边宽度 + 抖动位移余量），否则贴边一侧白边会被画布裁掉
  const pad = Math.ceil(strokePx * 2);
  const padded = await sharp(source)
    .extend({ top: pad, bottom: pad, left: pad, right: pad, background: { r: 0, g: 0, b: 0, alpha: 0 } })
    .png().toBuffer();
  const W = meta.width + pad * 2, H = meta.height + pad * 2;
  const down = 8;
  const w = Math.max(64, Math.round(W / down));
  const h = Math.max(64, Math.round(H / down));
  const sigma = Math.max(0.5, (strokePx / down) / 2);

  const alpha = await sharp(padded).resize(w, h).extractChannel('alpha').toBuffer();
  const blurred = await sharp(alpha).blur(sigma).png().toBuffer();
  const blurredGray = await sharp(blurred).extractChannel('red').toBuffer();
  const soft = await sharp(blurredGray).composite([{ input: alpha, blend: 'lighten' }]).toBuffer();
  const maskLow = await sharp(soft).threshold(8).extractChannel('red').toBuffer();
  const silLow = await sharp({ create: { width: w, height: h, channels: 3, background: { r: 255, g: 255, b: 255 } } })
    .joinChannel(maskLow).png().toBuffer();

  const scale = Math.max(2, Math.round((strokePx * 0.55) / down));
  const b64 = silLow.toString('base64');
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}">
    <defs>
      <filter id="hand" x="-40%" y="-40%" width="180%" height="180%">
        <feTurbulence type="fractalNoise" baseFrequency="0.04" numOctaves="3" seed="7" result="noise"/>
        <feDisplacementMap in="SourceGraphic" in2="noise" scale="${scale}" xChannelSelector="R" yChannelSelector="G"/>
      </filter>
    </defs>
    <image href="data:image/png;base64,${b64}" x="0" y="0" width="${w}" height="${h}" filter="url(#hand)"/>
  </svg>`;
  const wobbledLow = await sharp(Buffer.from(svg)).png().toBuffer();
  const wobbled = await sharp(wobbledLow).resize(W, H).png().toBuffer();
  return sharp(wobbled).composite([{ input: padded }]).png().toBuffer();
}

const src = await readFile(inputPath);
const meta = await sharp(src).metadata();
console.log('输入:', inputPath, `(${meta.width}x${meta.height} ${meta.format})`);

const framed = await cropWhiteFrame(src);
const fm = await sharp(framed).metadata();
console.log('裁剪后:', `${fm.width}x${fm.height}`);

// 直接给照片加一圈白色描边（贴纸边框）：白边宽度按短边比例
const bw = Math.max(6, Math.round(Math.min(fm.width, fm.height) * ratio));
const bordered = await sharp(framed)
  .extend({ top: bw, bottom: bw, left: bw, right: bw, background: { r: 255, g: 255, b: 255, alpha: 1 } })
  .png().toBuffer();

const H = 700;
const left = await sharp(framed).resize({ height: H, fit: 'inside' }).png().toBuffer();
const right = await sharp(bordered).resize({ height: H, fit: 'inside' }).png().toBuffer();
const lm = await sharp(left).metadata();
const rm = await sharp(right).metadata();
const pad = 90;
const W = pad * 3 + lm.width + rm.width;
const HH = H + pad * 2;
const compare = await sharp({ create: { width: W, height: HH, channels: 3, background: { r: 240, g: 170, b: 80 } } })
  .composite([{ input: left, left: pad, top: pad }, { input: right, left: pad * 2 + lm.width, top: pad }])
  .png().toBuffer();
await writeFile('generated-images/stroke-photo-compare.png', compare);
const dark = await sharp({ create: { width: rm.width + pad * 2, height: HH, channels: 3, background: { r: 40, g: 46, b: 54 } } })
  .composite([{ input: right, left: pad, top: pad }]).png().toBuffer();
await writeFile('generated-images/stroke-photo-dark.png', dark);
console.log('已生成: generated-images/stroke-photo-compare.png / stroke-photo-dark.png');
