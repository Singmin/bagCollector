import { access, readFile, readdir, stat } from 'node:fs/promises';
import path from 'node:path';

const root = path.resolve('apps/miniapp/src');
const pages = JSON.parse(await readFile(path.join(root, 'pages.json'), 'utf8'));
const maxPackageBytes = 2 * 1024 * 1024;
const forbiddenBusinessFallbacks = ['keep-crop', '保留裁剪图', '未命名收藏', '当前离线', 'bagIcon.png', 'services/cache'];

async function assertPage(page) {
  await access(path.join(root, `${page}.vue`));
}

async function bytesIn(directory, excludedRoots = []) {
  let total = 0;
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const absolute = path.join(directory, entry.name);
    const relative = path.relative(root, absolute);
    if (excludedRoots.some((excluded) => relative === excluded || relative.startsWith(`${excluded}${path.sep}`))) continue;
    if (entry.isDirectory()) total += await bytesIn(absolute, excludedRoots);
    else total += (await stat(absolute)).size;
  }
  return total;
}

async function assertNoBusinessFallbacks(directory) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const absolute = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      await assertNoBusinessFallbacks(absolute);
      continue;
    }
    if (!/\.(?:ts|js|vue|json|wxml|wxss|scss)$/.test(entry.name)) continue;
    const source = await readFile(absolute, 'utf8');
    const found = forbiddenBusinessFallbacks.find((value) => source.includes(value));
    if (found) throw new Error(`${path.relative(root, absolute)} still contains forbidden fallback marker: ${found}`);
  }
}

await Promise.all(pages.pages.map((entry) => assertPage(entry.path)));
for (const subPackage of pages.subPackages || []) {
  await Promise.all(subPackage.pages.map((entry) => assertPage(`${subPackage.root}/${entry.path}`)));
}

const subRoots = (pages.subPackages || []).map((entry) => entry.root);
const mainBytes = await bytesIn(root, subRoots);
if (mainBytes > maxPackageBytes) throw new Error(`Main source package is ${(mainBytes / 1024).toFixed(1)}KB, over 2MB`);
for (const subPackage of pages.subPackages || []) {
  const packageBytes = await bytesIn(path.join(root, subPackage.root));
  if (packageBytes > maxPackageBytes) throw new Error(`${subPackage.root} source is ${(packageBytes / 1024).toFixed(1)}KB, over 2MB`);
}
await assertNoBusinessFallbacks(root);

console.log(`uni-app page structure and fallback scan valid; main source package ${(mainBytes / 1024).toFixed(1)}KB`);
