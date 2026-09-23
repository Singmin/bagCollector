#!/usr/bin/env node
// 生成「小程序收藏架页」的浏览器预览。
//
// 为什么要有它：收藏架页的视觉基准是 H5 原型（袋袋集原型_交付包/袋袋集原型.html），
// 而小程序只能在微信开发者工具里看。这个脚本把 index.vue 的 <style scoped> 原样抠出来、
// 按 1rpx = 0.5px 换算（750rpx 设计宽 ≈ 375px），配上手写的等价 DOM 与真实袋图，
// 产出一份双击就能看的 HTML —— 改完样式重新跑一次，预览永远和源码一致，不会两边走样。
//
// 用法：node scripts/preview-miniapp-library.mjs（或 pnpm preview:library）
// 产出：apps/miniapp/preview/library-shelf-preview.html

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const vuePath = join(root, 'apps/miniapp/src/pages/library/index.vue');
const h5Path = join(root, '袋袋集原型_交付包/袋袋集原型.html');
const staticDir = join(root, 'apps/miniapp/src/static/figma');
const outPath = join(root, 'apps/miniapp/preview/library-shelf-preview.html');

const vue = readFileSync(vuePath, 'utf8');
const styleMatch = vue.match(/<style scoped>([\s\S]*?)<\/style>/);
if (!styleMatch) throw new Error(`没在 ${vuePath} 里找到 <style scoped> 块`);
const css = styleMatch[1].replace(/(\d+(?:\.\d+)?)rpx/g, (_, value) => `${Math.round(Number(value) * 0.5 * 100) / 100}px`);

// 袋图直接从 H5 原型里借：它把图片内嵌成 data URI，取出来就能用，
// 省得预览里出现一堆灰方块看不出真实观感。
const h5 = readFileSync(h5Path, 'utf8');
const bags = [...h5.matchAll(/image: '(data:image\/(?:webp|png|jpeg);base64,[^']+)'/g)].map((match) => match[1]);
if (bags.length < 7) throw new Error(`只从 H5 原型里解析出 ${bags.length} 张图，不够铺两组展示架`);

const icon = (name) => `data:image/svg+xml;base64,${Buffer.from(readFileSync(join(staticDir, name), 'utf8')).toString('base64')}`;

const card = (src) => `<button class="shelf-item"><img class="shelf-image" src="${src}" alt=""></button>`;

const group = ({ name, theme, images }) => `
  <div class="shelf-group">
    <div class="shelf-heading">
      <span class="shelf-name">${name}</span>
      <div class="shelf-hint">
        <span class="shelf-hint__count">共${images.length}件</span>
        <span class="shelf-hint__arrows">&lsaquo; &rsaquo;</span>
      </div>
    </div>
    <div class="shelf-scroll scroll"><div class="shelf-items">${images.map(card).join('')}</div></div>
    <div class="acrylic-shelf acrylic-shelf--${theme}">
      <div class="shelf-fastener shelf-fastener--left"></div>
      <div class="shelf-fastener shelf-fastener--right"></div>
    </div>
  </div>`;

const html = `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8" />
<title>收藏架页 · 小程序样式预览（1rpx = 0.5px）</title>
<style>
/* 以下三块等价于 App.vue / pages.json 里对本页有影响的部分 */
:root { --wc-font-headline: 22px; --wc-font-em-title: 17px; --wc-font-title: 17px; --wc-font-group-title: 15px; --wc-font-description: 14px; --wc-font-footnote: 12px; }
* { box-sizing: border-box; }
body { margin: 0; width: 375px; min-height: 812px; background: #f2f3f7; color: #000; font-family: "PingFang SC", -apple-system, BlinkMacSystemFont, sans-serif; }
button { margin: 0; font: inherit; color: inherit; border: 0; background: none; }
input { border: 0; outline: 0; background: transparent; font: inherit; }
img { display: block; }
/* 小程序的 <image mode="aspectFit"> 等价 object-fit: contain。
   不补这条，<img> 会被拉成卡槽的宽高比，袋子看着比真机胖。 */
.shelf-image, .search-icon, .mode-button img { object-fit: contain; }
/* 小程序的 scroll-view(scroll-x) 等价物 */
.scroll { overflow-x: auto; overflow-y: hidden; scrollbar-width: none; }
.scroll::-webkit-scrollbar { display: none; }
/* 下面就是 index.vue 的 <style scoped>，只做了 rpx -> px */
${css}
</style>
</head>
<body>
<div class="library-page">
  <div class="library-header">
    <div class="library-copy">
      <span class="library-title">全部收藏</span>
      <span class="library-summary">16 件收藏 · 4 个展示架</span>
    </div>
    <button class="mode-button">
      <img src="${icon('grid.svg')}" alt="" />
      <span>宫格</span>
    </button>
  </div>
  <div class="search-box">
    <img class="search-icon" src="${icon('search.svg')}" alt="" />
    <input class="search-input" placeholder="搜索名称 / 品牌 / 标签" />
  </div>
  <div class="shelf-list">
    ${group({ name: '霸王茶姬', theme: 'AMBER', images: bags.slice(0, 3) })}
    ${group({ name: "Peet's Coffee", theme: 'SAGE', images: bags.slice(3, 7) })}
  </div>
  <span class="page-loading">正在加载更多…</span>
</div>
</body>
</html>
`;

mkdirSync(dirname(outPath), { recursive: true });
writeFileSync(outPath, html, 'utf8');
console.log(`已生成 ${outPath}（${Math.round(html.length / 1024)} KB）`);
