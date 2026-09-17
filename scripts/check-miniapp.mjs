import { access, readFile, readdir, stat } from 'node:fs/promises';
import path from 'node:path';

const root = path.resolve('apps/miniapp/src');
const pages = JSON.parse(await readFile(path.join(root, 'pages.json'), 'utf8'));
const maxPackageBytes = 2 * 1024 * 1024;

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

console.log(`uni-app page structure valid; main source package ${(mainBytes / 1024).toFixed(1)}KB`);
