import fs from 'node:fs';

// Build tasks do not participate in production dependency resolution. Keep real
// lifecycle hooks: removing them would change how a future dependency is installed.
const file = process.argv[2] || 'package.json';
const manifest = JSON.parse(fs.readFileSync(file, 'utf8'));
const hooks = new Set(['preinstall', 'install', 'postinstall', 'prepare', 'prepublish', 'prepublishOnly', 'postprepare', 'preprepare']);
manifest.scripts = Object.fromEntries(Object.entries(manifest.scripts || {}).filter(([name]) => hooks.has(name)));
fs.writeFileSync(file, `${JSON.stringify(manifest, null, 2)}\n`);
