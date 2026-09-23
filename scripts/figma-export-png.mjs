// 从 Figma 导出指定节点为 PNG（默认 3 倍图），用于人工核对图标形态
// 用法: FIGMA_API_KEY=xxx node scripts/figma-export-png.mjs <fileKey> <outDir> <scale> <id=name,...>
import fs from 'node:fs';
import path from 'node:path';

const FILE_KEY = process.argv[2];
const OUT_DIR = process.argv[3];
const SCALE = process.argv[4] ?? '3';
const MAP = process.argv[5];
const TOKEN = process.env.FIGMA_API_KEY;

if (!FILE_KEY || !OUT_DIR || !MAP || !TOKEN) {
  console.error('用法: FIGMA_API_KEY=xxx node scripts/figma-export-png.mjs <fileKey> <outDir> <scale> <id=name,...>');
  process.exit(1);
}

const entries = MAP.split(',').map((item) => {
  const [id, name] = item.split('=');
  return { id, name };
});

const ids = entries.map((e) => e.id).join(',');
const res = await fetch(
  `https://api.figma.com/v1/images/${FILE_KEY}?ids=${encodeURIComponent(ids)}&format=png&scale=${SCALE}`,
  { headers: { 'X-Figma-Token': TOKEN } }
);
if (!res.ok) {
  console.error(`Figma API ${res.status}: ${await res.text()}`);
  process.exit(1);
}
const data = await res.json();

fs.mkdirSync(OUT_DIR, { recursive: true });
for (const entry of entries) {
  const url = data.images?.[entry.id];
  if (!url) {
    console.log('MISS', entry.name, entry.id);
    continue;
  }
  const file = path.join(OUT_DIR, `${entry.name}@${SCALE}x.png`);
  fs.writeFileSync(file, Buffer.from(await (await fetch(url)).arrayBuffer()));
  console.log('OK', entry.name, '->', file);
}
