// 打印指定 Figma 节点的子树结构（type / name / id / 位置尺寸），用于定位图标等资源节点
// 用法: node scripts/figma-node-tree.mjs <fileKey> <nodeId[,nodeId...]> [maxDepth]
const FILE_KEY = process.argv[2];
const IDS = process.argv[3];
const MAX_DEPTH = Number(process.argv[4] ?? 6);
const TOKEN = process.env.FIGMA_API_KEY;

if (!FILE_KEY || !IDS || !TOKEN) {
  console.error('用法: FIGMA_API_KEY=xxx node scripts/figma-node-tree.mjs <fileKey> <nodeId[,nodeId]> [maxDepth]');
  process.exit(1);
}

const res = await fetch(
  `https://api.figma.com/v1/files/${FILE_KEY}/nodes?ids=${encodeURIComponent(IDS)}`,
  { headers: { 'X-Figma-Token': TOKEN } }
);
if (!res.ok) {
  console.error(`Figma API ${res.status}: ${await res.text()}`);
  process.exit(1);
}
const data = await res.json();

const round = (n) => (typeof n === 'number' ? Math.round(n * 10) / 10 : n);
const hex = (c) => (c ? `#${[c.r, c.g, c.b].map((v) => Math.round(v * 255).toString(16).padStart(2, '0')).join('')}${c.a !== undefined && c.a < 1 ? `@${Math.round(c.a * 100) / 100}` : ''}` : '');
function walk(node, depth = 0) {
  const bb = node.absoluteBoundingBox || {};
  const rel = node.relativeTransform ? node.relativeTransform[0][2] : undefined;
  const relY = node.relativeTransform ? node.relativeTransform[1][2] : undefined;
  const pad = '  '.repeat(depth);
  const fills = (node.fills || []).filter((f) => f.visible !== false).map((f) => `${f.type}${hex(f.color)}${f.opacity !== undefined ? `@${Math.round(f.opacity * 100) / 100}` : ''}`).join(',');
  const strokes = (node.strokes || [])
    .filter((s) => s.visible !== false)
    .map((s) => `${s.type}${hex(s.color)}${s.opacity !== undefined ? `@${Math.round(s.opacity * 100) / 100}` : ''}`)
    .join(',');
  const dash = node.strokeDashes?.length ? ` dash:${node.strokeDashes.join('/')}` : '';
  const strokeInfo = node.strokes?.length ? ` stroke:[${strokes}] w:${node.strokeWeight}${dash}${node.strokeAlign ? ` align:${node.strokeAlign}` : ''}` : '';
  console.log(
    `${pad}${node.type} "${node.name}" id=${node.id} ${round(bb.width)}x${round(bb.height)} @(${round(bb.x)},${round(bb.y)})${rel !== undefined ? ` local(${round(rel)},${round(relY)})` : ''}` +
      `${fills ? ` fill:${fills}` : ''}${node.cornerRadius ? ` r:${node.cornerRadius}` : ''}${node.rectangleCornerRadii ? ` rr:${node.rectangleCornerRadii}` : ''}` +
      `${strokeInfo}` +
      `${node.characters !== undefined ? ` text:"${String(node.characters).replace(/\n/g, '\\n').slice(0, 40)}"` : ''}` +
      `${node.style ? ` font:${node.style.fontFamily}/${node.style.fontWeight}/${node.style.fontSize}` : ''}`
  );
  if (depth >= MAX_DEPTH) return;
  for (const child of node.children || []) walk(child, depth + 1);
}

for (const [id, entry] of Object.entries(data.nodes || {})) {
  console.log(`===== node ${id} : ${entry.document?.name}`);
  walk(entry.document);
}
