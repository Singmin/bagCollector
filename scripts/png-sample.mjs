#!/usr/bin/env node
/**
 * 截图取样器 —— 用来量「用户贴来的参考截图」，把像素换算回 rpx 去核对小程序。
 *
 * 为什么要它：本机既没有 PIL 也没有 ffmpeg（也没有 sharp），而核对样式时经常要
 * 「这张截图里标题高多少、距导航栏多远、卡片左边缘在 x=多少」。所以用 node 自带
 * 的 zlib 手解 PNG 扫描线，够用且零依赖。
 *
 * 用法（图片路径 + 模式）：
 *   node scripts/png-sample.mjs shot.png pt <x> <y>                    单点颜色
 *   node scripts/png-sample.mjs shot.png scan <y> [step] [from] [to]    横切一条线
 *   node scripts/png-sample.mjs shot.png vscan <x> [step] [from] [to]   竖切一条线
 *   node scripts/png-sample.mjs shot.png avg <x0> <y0> <x1> <y1>        区域均值（大块平色才准）
 *   node scripts/png-sample.mjs shot.png bands [x0] [x1] [y0]           暗字带（找文字行）
 *
 * bands 是最常用的一条：在 x∈[x0,x1] 的窗口里逐行数「暗像素」（亮度 < 120），
 * 把连续 ≥3 个暗像素的行并成一段打印出来 —— 于是标题、副文案、按钮图标在第几行
 * 一目了然。窗口要选在手机壳内部，否则会数到截图外侧的深色桌面背景。
 *
 * ⚠ 两张截图裁剪范围往往不同（宽度/高度都不一样），**不能直接比 y**。
 *   正确做法：各自先 anchor 到一个「两页都有、位置固定」的元素（导航栏标题最好用），
 *   再比「另一个元素距它多少行」，见 SKILL.md「量参考图的颜色」一节。
 */
import { readFileSync } from 'node:fs';
import { inflateSync } from 'node:zlib';

function decode(file) {
  const buf = readFileSync(file);
  let pos = 8, w = 0, h = 0, bitDepth = 8, colorType = 2;
  const idat = [];
  while (pos < buf.length) {
    const len = buf.readUInt32BE(pos);
    const type = buf.toString('ascii', pos + 4, pos + 8);
    const data = buf.subarray(pos + 8, pos + 8 + len);
    if (type === 'IHDR') {
      w = data.readUInt32BE(0); h = data.readUInt32BE(4); bitDepth = data[8]; colorType = data[9];
    }
    if (type === 'IDAT') idat.push(data);
    pos += 12 + len;
  }
  if (bitDepth !== 8) throw new Error(`只支持 8bit 位深（这张是 ${bitDepth}）`);
  const ch = { 0: 1, 2: 3, 4: 2, 6: 4 }[colorType];
  if (!ch) throw new Error(`只支持灰度/RGB/RGBA（这张 colorType=${colorType}）`);
  const raw = inflateSync(Buffer.concat(idat));
  const stride = w * ch;
  const out = Buffer.alloc(h * stride);
  let prev = Buffer.alloc(stride);
  for (let y = 0; y < h; y++) {
    const filter = raw[y * (stride + 1)];
    const line = raw.subarray(y * (stride + 1) + 1, y * (stride + 1) + 1 + stride);
    const cur = Buffer.alloc(stride);
    for (let i = 0; i < stride; i++) {
      const a = i >= ch ? cur[i - ch] : 0;
      const b = prev[i];
      const c = i >= ch ? prev[i - ch] : 0;
      const x = line[i];
      let v;
      if (filter === 0) v = x;
      else if (filter === 1) v = x + a;
      else if (filter === 2) v = x + b;
      else if (filter === 3) v = x + ((a + b) >> 1);
      else {
        const p = a + b - c;
        const pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
        v = x + (pa <= pb && pa <= pc ? a : pb <= pc ? b : c);
      }
      cur[i] = v & 255;
    }
    cur.copy(out, y * stride);
    prev = cur;
  }
  return { w, h, ch, px: out };
}

function makeReader(file) {
  const { w, h, ch, px } = decode(file);
  const rgb = (x, y) => {
    const i = (y * w + x) * ch;
    if (ch >= 3) return [px[i], px[i + 1], px[i + 2]];
    return [px[i], px[i], px[i]];
  };
  const lum = (x, y) => {
    const [r, g, b] = rgb(x, y);
    return (r * 299 + g * 587 + b * 114) / 1000;
  };
  const hex = (x, y) => {
    const [r, g, b] = rgb(x, y);
    return '#' + [r, g, b].map((v) => v.toString(16).padStart(2, '0')).join('');
  };
  return { w, h, rgb, lum, hex };
}

const [file, mode, ...rest] = process.argv.slice(2);
if (!file || !mode) {
  console.log('用法见文件头注释：pt | scan | vscan | avg | bands');
  process.exit(1);
}
const img = makeReader(file);
const n = (v, fallback) => (v === undefined ? fallback : Number(v));
console.log(`${file}  ${img.w}x${img.h}`);

if (mode === 'pt') {
  const [x, y] = rest.map(Number);
  console.log(`(${x},${y})  ${img.hex(x, y)}  rgb(${img.rgb(x, y).join(',')})  亮度 ${Math.round(img.lum(x, y))}`);
} else if (mode === 'scan' || mode === 'vscan') {
  const fixed = n(rest[0], 0);
  const step = n(rest[1], 4);
  const from = n(rest[2], 0);
  const to = n(rest[3], mode === 'scan' ? img.w - 1 : img.h - 1);
  for (let v = from; v <= to; v += step) {
    const x = mode === 'scan' ? v : fixed;
    const y = mode === 'scan' ? fixed : v;
    console.log(`  ${mode === 'scan' ? 'x' : 'y'}=${String(v).padStart(4)}  ${img.hex(x, y)}  亮度 ${String(Math.round(img.lum(x, y))).padStart(3)}`);
  }
} else if (mode === 'avg') {
  const [x0, y0, x1, y1] = rest.map(Number);
  let r = 0, g = 0, b = 0, count = 0;
  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) { const c = img.rgb(x, y); r += c[0]; g += c[1]; b += c[2]; count++; }
  }
  const hex = '#' + [r, g, b].map((v) => Math.round(v / count).toString(16).padStart(2, '0')).join('');
  console.log(`区域 (${x0},${y0})-(${x1},${y1})  均值 ${hex}  rgb(${Math.round(r / count)},${Math.round(g / count)},${Math.round(b / count)})`);
} else if (mode === 'bands') {
  const x0 = n(rest[0], 0);
  const x1 = n(rest[1], img.w - 1);
  const y0 = n(rest[2], 0);
  const threshold = n(rest[3], 120);
  let run = null;
  const flush = () => {
    if (!run) return;
    console.log(`  暗字带 y=${run.from}..${run.to}  (高 ${run.to - run.from + 1}px, 峰值 ${run.max}px)`);
    run = null;
  };
  for (let y = y0; y < img.h; y++) {
    let dark = 0;
    for (let x = x0; x <= x1; x++) if (img.lum(x, y) < threshold) dark++;
    if (dark >= 3) {
      if (!run) run = { from: y, to: y, max: dark };
      else { run.to = y; run.max = Math.max(run.max, dark); }
    } else flush();
  }
  flush();
} else {
  console.log(`未知模式 ${mode}`);
  process.exit(1);
}
