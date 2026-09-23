// 抠图接口效果对比脚本
// =====================================================================
// 用途：把「同一张原图 + 两个抠图接口的结果」并排渲染成一张对比图，铺棋盘底
// 让透明区域可见，并自动计算各结果的主体像素占比与 alpha 分档。
//
// 除图之外还会打印 alpha 三档占比（全透明 / 半透明 / 完全不透明）：
//   半透明占比高 = 边缘过渡带宽，可能更柔，也可能更糊、更容易带背景残留色；
//   完全不透明占比 = 主体的实际面积。
// 两者合起来才能分清「多出来的像素是边缘光晕」还是「真的多留了背景」。
// 另外要留意细结构（提手绳、带子）：被侵蚀变细时占比只差零点几个百分点，
// 单看数字发现不了，必须把图放大看。
//
// 典型场景：判断该用 GoodsMatting（商品抠图，0.01 元）还是 AIPicMatting
// （通用抠图，0.02 元）。两者单价不同、适用背景不同，靠肉眼看单张结果很难
// 下判断，并排看差异会非常直观。
//
// 用法：
//   node scripts/compare-matting-models.mjs \
//     --source testIMG.jpg \
//     --a data/ci-matting-verify/<ts>/cutout-01.png --label-a "GoodsMatting 商品抠图" \
//     --b data/ci-matting-verify/<ts>/cutout-01.png --label-b "AIPicMatting 通用抠图" \
//     --out data/ci-matting-verify/compare-models.png
//
// 其中 --source / --a / --b 支持绝对路径与相对仓库根目录的路径。
// --label-a / --label-b 省略时用「结果文件名 + 主体占比」作标签。
// 主体占比的算法与 verify-ci-matting.mjs 完全一致（alpha 通道均值 / 255），
// 因此这里的数字可以直接和验收脚本的输出对照。
// =====================================================================

import { mkdir } from 'node:fs/promises';
import { dirname, isAbsolute, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const abs = (p) => (isAbsolute(p) ? p : resolve(REPO_ROOT, p));

/**
 * 按 alpha 分三档统计，这是判断边缘质量的量化依据。
 *
 * 只看「主体占比」会漏掉一个关键区别：两个接口完全可能主体面积几乎一样，
 * 但一个边缘是柔和过渡、另一个是锯齿硬切；也可能是细结构（提手绳、带子）
 * 被侵蚀变细 —— 后者在占比上只差零点几个百分点，肉眼也几乎看不出，
 * 却直接影响成图观感。半透明像素比例能把这个差异放大出来。
 */
async function alphaBreakdown(input) {
  const { data, info } = await sharp(input).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const channels = info.channels;
  let transparent = 0;
  let soft = 0;
  let opaque = 0;
  for (let i = 0; i < data.length; i += channels) {
    const alpha = data[i + channels - 1];
    if (alpha === 0) transparent += 1;
    else if (alpha === 255) opaque += 1;
    else soft += 1;
  }
  const total = info.width * info.height;
  return {
    transparent: transparent / total,
    soft: soft / total,
    opaque: opaque / total,
    // 半透明占「非全透明」的比例越高，说明边缘过渡带越宽（可能意味着更柔，也可能意味着更糊）
    softShare: soft + opaque ? soft / (soft + opaque) : 0,
  };
}

const args = process.argv.slice(2);
if (args.includes('--help') || args.includes('-h') || args.length === 0) {
  console.log(`用法：
  node scripts/compare-matting-models.mjs --source <原图> --a <抠图A> --b <抠图B> [选项]

选项：
  --label-a <文字>   A 面板标题（默认取文件名）
  --label-b <文字>   B 面板标题（默认取文件名）
  --out <路径>       输出 PNG 路径
                     （默认 data/ci-matting-verify/compare-models.png）`);
  process.exit(args.length === 0 ? 1 : 0);
}

function readFlag(name) {
  const index = args.indexOf(`--${name}`);
  return index >= 0 ? args[index + 1] : undefined;
}

const sourcePath = readFlag('source');
const aPath = readFlag('a');
const bPath = readFlag('b');
if (!sourcePath || !aPath || !bPath) {
  console.error('缺少必填参数：--source / --a / --b 三者都要给。用 --help 看用法。');
  process.exit(1);
}

const outPath = abs(readFlag('out') ?? 'data/ci-matting-verify/compare-models.png');

// 与 verify-ci-matting.mjs 保持同一口径：PNG 最后一个通道是 alpha，
// 主体占比 = alpha 均值 / 255。注意它统计的是「平均不透明度」，
// 半透明像素会按比例计入，所以残留的半透明背景也会抬高这个数字。
async function subjectRatio(input) {
  const metadata = await sharp(input).metadata();
  if (!metadata.width || !metadata.height) throw new Error(`无法读取尺寸：${input}`);
  const statistics = await sharp(input).stats();
  const alpha = statistics.channels[(metadata.channels ?? 4) - 1];
  const total = metadata.width * metadata.height;
  return {
    width: metadata.width,
    height: metadata.height,
    ratio: alpha ? Number(((alpha.mean / 255) * 1).toFixed(4)) : 0,
  };
}

const checkerboard = (width, height, tile = 14) =>
  Buffer.from(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}">` +
      `<defs><pattern id="c" width="${tile * 2}" height="${tile * 2}" patternUnits="userSpaceOnUse">` +
      `<rect width="${tile * 2}" height="${tile * 2}" fill="#ffffff"/>` +
      `<rect width="${tile}" height="${tile}" fill="#dde3ea"/>` +
      `<rect x="${tile}" y="${tile}" width="${tile}" height="${tile}" fill="#dde3ea"/>` +
      `</pattern></defs><rect width="100%" height="100%" fill="url(#c)"/></svg>`
  );

const PANEL_W = 400;
const PANEL_GAP = 18;
const PADDING = 22;
const LABEL_H = 30;

/** 把一张图缩到统一宽度并铺上棋盘底，保证透明区域肉眼可见。 */
async function buildPanel(input) {
  const resized = await sharp(input).resize({ width: PANEL_W, fit: 'inside' }).png().toBuffer();
  const { width, height } = await sharp(resized).metadata();
  const background = await sharp(checkerboard(width, height)).png().toBuffer();
  return sharp(background).composite([{ input: resized }]).png().toBuffer();
}

const panels = [
  { path: abs(sourcePath), label: readFlag('label-source') ?? '原图' },
  { path: abs(aPath), label: readFlag('label-a') },
  { path: abs(bPath), label: readFlag('label-b') },
];

const built = [];
for (const panel of panels) {
  const image = await buildPanel(panel.path);
  // 原图是 JPEG、没有 alpha 通道，既不算主体占比也不做分档统计。
  const isSource = panel.path === panels[0].path && !/\.png$/i.test(panel.path);
  const meta = await sharp(image).metadata();
  built.push({
    ...panel,
    image,
    height: meta.height,
    stats: isSource ? null : await subjectRatio(panel.path),
    alpha: isSource ? null : await alphaBreakdown(panel.path),
  });
}

const panelHeight = Math.max(...built.map((p) => p.height));
const canvasWidth = PADDING * 2 + PANEL_W * built.length + PANEL_GAP * (built.length - 1);
const canvasHeight = PADDING * 2 + LABEL_H + panelHeight;

const composites = [];
const labels = [];
let x = PADDING;
for (const panel of built) {
  const label = panel.stats
    ? `${panel.label ?? '结果'} · ${(panel.stats.ratio * 100).toFixed(2)}%`
    : (panel.label ?? '原图');
  composites.push({
    // 统一给每块留出标题高度，避免各面板高度不同导致排版错位。
    input: await sharp(panel.image)
      .extend({ top: LABEL_H, bottom: 0, left: 0, right: 0, background: '#ffffff' })
      .toBuffer(),
    left: x,
    top: PADDING,
  });
  labels.push(
    `<text x="${x + PANEL_W / 2}" y="${PADDING + LABEL_H - 9}" text-anchor="middle" ` +
      `font-family="Segoe UI, Microsoft YaHei, sans-serif" font-size="15" font-weight="600" fill="#0f172a">` +
      `${label.replace(/&/g, '&amp;').replace(/</g, '&lt;')}</text>`
  );
  x += PANEL_W + PANEL_GAP;
}

await mkdir(dirname(outPath), { recursive: true });
await sharp({ create: { width: canvasWidth, height: canvasHeight, channels: 4, background: '#ffffff' } })
  .composite([
    ...composites,
    {
      input: Buffer.from(
        `<svg xmlns="http://www.w3.org/2000/svg" width="${canvasWidth}" height="${canvasHeight}">${labels.join('')}</svg>`
      ),
      left: 0,
      top: 0,
    },
  ])
  .png()
  .toFile(outPath);

for (const panel of built) {
  const size = panel.stats ? `${panel.stats.width}x${panel.stats.height}` : '-';
  const ratio = panel.stats ? panel.stats.ratio : '-';
  console.log(`${(panel.label ?? '').padEnd(30)} 主体占比 ${String(ratio).padEnd(8)} 尺寸 ${size}`);
  if (panel.alpha) {
    const pct = (v) => `${(v * 100).toFixed(2)}%`.padStart(7);
    console.log(
      `${''.padEnd(30)}   全透明 ${pct(panel.alpha.transparent)}   半透明 ${pct(panel.alpha.soft)}   ` +
        `完全不透明 ${pct(panel.alpha.opaque)}   半透明占主体 ${(panel.alpha.softShare * 100).toFixed(1)}%`
    );
  }
}
console.log(`\n对比图已写入 ${outPath}（${canvasWidth}x${canvasHeight}）`);
