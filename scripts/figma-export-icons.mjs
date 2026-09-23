// 从 Figma 导出指定节点为 SVG，并清理图标底部的白色背景块
// 用法: FIGMA_API_KEY=xxx node scripts/figma-export-icons.mjs <fileKey> <outDir> <id:name,id:name,...>
const FILE_KEY = process.argv[2];
const OUT_DIR = process.argv[3];
const MAP = process.argv[4];
const TOKEN = process.env.FIGMA_API_KEY;

if (!FILE_KEY || !OUT_DIR || !MAP || !TOKEN) {
  console.error('用法: FIGMA_API_KEY=xxx node scripts/figma-export-icons.mjs <fileKey> <outDir> <id:name,...>');
  process.exit(1);
}

import fs from 'node:fs';
import path from 'node:path';

// 节点 id 本身含冒号，因此用 "=" 分隔 id 与输出文件名
const entries = MAP.split(',').map((item) => {
  const [id, name] = item.split('=');
  return { id, name };
});

const ids = entries.map((e) => e.id).join(',');
const res = await fetch(
  `https://api.figma.com/v1/images/${FILE_KEY}?ids=${encodeURIComponent(ids)}&format=svg`,
  { headers: { 'X-Figma-Token': TOKEN } }
);
if (!res.ok) {
  console.error(`Figma API ${res.status}: ${await res.text()}`);
  process.exit(1);
}
const data = await res.json();

fs.mkdirSync(OUT_DIR, { recursive: true });

/** 去掉铺满整个画布的纯白背景矩形，只保留图标图形本身 */
function stripBackground(svg) {
  return svg.replace(/<rect[^>]*fill="#(?:FFF|FFFFFF|fff|ffffff)"[^>]*\/>/g, '').replace(/\n{2,}/g, '\n');
}

for (const entry of entries) {
  const url = data.images?.[entry.id];
  if (!url) {
    console.log('MISS', entry.name, entry.id);
    continue;
  }
  const svg = stripBackground(await (await fetch(url)).text());
  const file = path.join(OUT_DIR, `${entry.name}.svg`);
  fs.writeFileSync(file, svg, 'utf8');
  const viewBox = /viewBox="([^"]+)"/.exec(svg)?.[1];
  console.log('OK', entry.name, '->', file, '| viewBox:', viewBox);
}
