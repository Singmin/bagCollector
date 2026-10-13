import fs from 'node:fs';
import path from 'node:path';

// Run after pruning/hardlink deduplication. Every native engine stays in the
// original dependency tree, including its generated-client path and hardlinks.
// Only schema-specific files move into the separately copied overlay.
const root = path.resolve(process.argv[2] || '.');
const overlay = path.resolve(process.argv[3] || 'generated-client');
const store = path.join(root, 'node_modules/.pnpm');
let clients = 0;
for (const name of fs.readdirSync(store).sort()) {
  if (!name.startsWith('@prisma+client@')) continue;
  const client = path.join(store, name, 'node_modules/.prisma/client');
  if (!fs.existsSync(path.join(client, 'index.js'))) continue;
  const target = path.join(overlay, path.relative(root, client));
  fs.mkdirSync(target, { recursive: true });
  for (const entry of fs.readdirSync(client, { withFileTypes: true })) {
    if (/^libquery_engine-.*\.so\.node$/.test(entry.name)) continue;
    if (!entry.isFile()) throw new Error(`Unexpected generated client entry: ${entry.name}`);
    fs.renameSync(path.join(client, entry.name), path.join(target, entry.name));
  }
  clients++;
}
if (!clients) throw new Error('Generated Prisma client not found for layer split');
console.log(`Separated ${clients} generated Prisma client(s); native engine paths and hardlinks retained`);
