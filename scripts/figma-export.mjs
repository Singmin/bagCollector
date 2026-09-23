// 从 Figma 导出指定文件的画板 PNG，并生成 manifest 供后续对照实现使用
// 用法: node scripts/figma-export.mjs <fileKey> [outDir]
import fs from 'node:fs';
import path from 'node:path';

const FILE_KEY = process.argv[2] || 'eHfpfBOAY1TeXQV7DzVSmo';
const OUT_DIR = process.argv[3] || 'figma_shots';
const TOKEN = process.env.FIGMA_API_KEY;
if (!TOKEN) {
  console.error('缺少环境变量 FIGMA_API_KEY');
  process.exit(1);
}

const api = async (url) => {
  const res = await fetch(url, { headers: { 'X-Figma-Token': TOKEN } });
  if (!res.ok) throw new Error(`Figma API ${res.status}: ${await res.text()}`);
  return res.json();
};

const doc = await api(`https://api.figma.com/v1/files/${FILE_KEY}?depth=2`);
const frames = [];
for (const page of doc.document.children ?? []) {
  for (const node of page.children ?? []) {
    const bb = node.absoluteBoundingBox || {};
    if (node.type === 'FRAME' && bb.width === 375 && bb.height === 812) {
      frames.push({ id: node.id, name: node.name });
    }
  }
}
console.log(`找到 ${frames.length} 个手机页面画板`);

const ids = frames.map((f) => f.id).join(',');
const imgRes = await api(
  `https://api.figma.com/v1/images/${FILE_KEY}?ids=${encodeURIComponent(ids)}&format=png&scale=1`
);

fs.mkdirSync(OUT_DIR, { recursive: true });
const manifest = [];
for (const f of frames) {
  const url = imgRes.images?.[f.id];
  const safe = f.name.replace(/[^\p{L}\p{N}]/gu, '_');
  if (!url) {
    console.log('MISS', f.name, f.id);
    continue;
  }
  const file = path.join(OUT_DIR, `${safe}_${f.id.replace(':', '_')}.png`);
  const buf = Buffer.from(await (await fetch(url)).arrayBuffer());
  fs.writeFileSync(file, buf);
  manifest.push({ ...f, file });
  console.log('OK', f.name, '->', file);
}
fs.writeFileSync(
  path.join(OUT_DIR, 'manifest.json'),
  JSON.stringify(manifest, null, 2),
  'utf8'
);
console.log('完成，manifest:', path.join(OUT_DIR, 'manifest.json'));
