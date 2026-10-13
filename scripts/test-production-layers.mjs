import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'production-layers-'));
try {
  const stable = [];
  for (const [version, generated] of [['before', 'old-schema'], ['after', 'new-schema']]) {
    const dir = path.join(root, version);
    const client = path.join(dir, 'node_modules/.pnpm/@prisma+client@6/node_modules/.prisma/client');
    fs.mkdirSync(client, { recursive: true });
    const engine = path.join(client, 'libquery_engine-linux-musl.so.node');
    fs.writeFileSync(engine, 'identical-native-engine');
    fs.linkSync(engine, path.join(dir, 'node_modules/cli-engine.so.node'));
    fs.writeFileSync(path.join(client, 'index.js'), generated);
    fs.writeFileSync(path.join(client, 'schema.prisma'), generated);
    execFileSync(process.execPath, ['infra/split-prisma-client.mjs', dir, path.join(dir, 'overlay')]);
    assert.equal(fs.statSync(engine).ino, fs.statSync(path.join(dir, 'node_modules/cli-engine.so.node')).ino);
    assert.equal(fs.existsSync(path.join(client, 'index.js')), false);
    const hash = createHash('sha256');
    for (const file of ['node_modules/cli-engine.so.node', 'node_modules/.pnpm/@prisma+client@6/node_modules/.prisma/client/libquery_engine-linux-musl.so.node']) {
      hash.update(file); hash.update(fs.readFileSync(path.join(dir, file)));
    }
    stable.push(hash.digest('hex'));
    fs.cpSync(path.join(dir, 'overlay/node_modules'), path.join(dir, 'node_modules'), { recursive: true });
    assert.equal(fs.readFileSync(path.join(client, 'index.js'), 'utf8'), generated);
    assert.equal(fs.statSync(engine).ino, fs.statSync(path.join(dir, 'node_modules/cli-engine.so.node')).ino);
  }
  assert.equal(stable[0], stable[1]);
  const manifests = [];
  for (const task of ['old-task', 'new-task']) {
    const file = path.join(root, `${task}.json`);
    fs.writeFileSync(file, JSON.stringify({ name: 'fixture', dependencies: { prisma: '6' }, scripts: { test: task, postinstall: 'required-hook' } }));
    execFileSync(process.execPath, ['infra/normalize-production-manifest.mjs', file]);
    manifests.push(fs.readFileSync(file, 'utf8'));
  }
  assert.equal(manifests[0], manifests[1]);
  assert.equal(JSON.parse(manifests[0]).scripts.postinstall, 'required-hook');
  console.log('PASS: schema overlay preserves stable engines and hardlinks; development scripts do not change install inputs');
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}
