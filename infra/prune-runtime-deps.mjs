import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';

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
const nativeEngines = [];
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
      if (/^libquery_engine-.*\.so\.node$/.test(entry.name)) nativeEngines.push(file);
      const inPrismaRuntime = file.includes(`${path.sep}@prisma${path.sep}client${path.sep}runtime${path.sep}`);
      if (/\.(?:js|mjs|cjs)\.map$/.test(entry.name)
        || (inPrismaRuntime && /^(query_engine_bg\.|query_compiler_bg\.)/.test(entry.name))) {
        remove(file);
      }
    }
  }
}
walk(store);
// CLI, engines package and generated client contain byte-identical native engines.
// Keep every expected path, using hardlinks so the Docker layer stores bytes once.
const enginesByHash = new Map();
let deduplicatedBytes = 0;
for (const file of nativeEngines) {
  const hash = createHash('sha256');
  for await (const chunk of fs.createReadStream(file)) hash.update(chunk);
  const digest = hash.digest('hex');
  const existing = enginesByHash.get(digest);
  if (existing) {
    deduplicatedBytes += fs.statSync(file).size;
    fs.unlinkSync(file);
    fs.linkSync(existing, file);
  } else enginesByHash.set(digest, file);
}
console.log(`Removed ${removals.length} unused runtime files/directories (source maps, optional TypeScript, edge WASM and incompatible sharp binaries)`);
console.log(`Deduplicated ${deduplicatedBytes} native Prisma engine bytes without removing runtime paths`);

// pnpm's installation bookkeeping contains wall-clock dates and is not used by Node.
// Keep dependency layers reproducible even when a fresh Runner misses the build cache.
const installMetadata = path.resolve('node_modules/.modules.yaml');
if (fs.existsSync(installMetadata)) fs.rmSync(installMetadata);
