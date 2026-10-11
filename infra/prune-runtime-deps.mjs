import fs from 'node:fs';
import path from 'node:path';

// This image runs generated Node/Rust Prisma clients and SQL migrations only.
// Abort if Prisma changes its generated entry point; never prune an edge/JS client.
const store = path.resolve('node_modules/.pnpm');
let generated = 0;
for (const name of fs.readdirSync(store)) {
  if (!name.startsWith('@prisma+client@')) continue;
  const entry = path.join(store, name, 'node_modules/.prisma/client/index.js');
  if (!fs.existsSync(entry)) continue;
  const source = fs.readFileSync(entry, 'utf8');
  if (!source.includes("require('@prisma/client/runtime/library.js')")) {
    throw new Error('Unsupported Prisma client runtime; keep all engine files');
  }
  generated++;
}
if (!generated) throw new Error('Generated Prisma client not found');

const removals = [];
function remove(file) {
  removals.push(file);
  fs.rmSync(file, { recursive: true, force: true });
}
const alpine = fs.existsSync('/etc/alpine-release');
const glibcSharp = new RegExp(`^@img\\+sharp(?:-libvips)?-linux-${process.arch}@`);
for (const name of fs.readdirSync(store)) {
  // TypeScript is an optional peer installed for Prisma tooling. Production has
  // no prisma.config.ts and never generates clients or compiles TypeScript.
  if (name.startsWith('typescript@') || (alpine && glibcSharp.test(name))) {
    remove(path.join(store, name));
  }
}
function walk(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const file = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(file);
    else if (entry.isFile()) {
      const inPrismaRuntime = file.includes(`${path.sep}@prisma${path.sep}client${path.sep}runtime${path.sep}`);
      if (/\.(?:js|mjs|cjs)\.map$/.test(entry.name)
        || (inPrismaRuntime && /^(query_engine_bg\.|query_compiler_bg\.)/.test(entry.name))) {
        remove(file);
      }
    }
  }
}
walk(store);
console.log(`Removed ${removals.length} unused runtime files/directories (source maps, optional TypeScript, edge WASM and incompatible sharp binaries)`);
