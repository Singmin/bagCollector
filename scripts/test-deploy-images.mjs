import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { gzipSync } from 'node:zlib';
import { createHash } from 'node:crypto';

// Exercise the production entry point without a live daemon or production host.
const root = process.cwd();
const base = fs.mkdtempSync(path.join(root, '.runtime/deploy-images-'));
const shell = process.platform === 'win32' ? 'C:/Program Files/Git/bin/bash.exe' : '/bin/bash';
const python = process.platform === 'win32' ? 'C:/Python312/python.exe' : '/usr/bin/python3';
const posix = p => p.replaceAll('\\', '/').replace(/^([A-Z]):/i, (_, drive) => '/' + drive.toLowerCase());
const q = p => "'" + p.replaceAll("'", "'\\''") + "'";
const sha = 'a'.repeat(40);
const id = 'sha256:' + '1'.repeat(64);
const fingerprint = 'sha256:' + createHash('sha256').update('fixture-layers-and-runtime-config\n').digest('hex');
const bin = path.join(base, 'bin');
fs.mkdirSync(bin);
function file(name, value) {
  fs.writeFileSync(path.join(bin, name), '#!/bin/sh\n' + value + '\n');
}
file('docker', `printf '%s\\n' "$*" >> "$TEST_CALLS"
case "$1 $2" in
  'info --format') echo "$TEST_DOCKER_ROOT" ;;
  'image inspect')
    [ -f "$TEST_LOADED" ] || [ "\${TEST_CACHED:-0}" = 1 ] || exit 1
    if [ "$4" = '{{.Id}}' ]; then
      if [ "\${TEST_ALT_ID:-0}" = 1 ]; then echo 'sha256:${'2'.repeat(64)}'; else echo '${id}'; fi
    else
      if [ "\${TEST_WRONG_ID:-0}" = 1 ]; then echo wrong-runtime-config; else echo fixture-layers-and-runtime-config; fi
    fi ;;
  'image load') [ "\${TEST_FAIL_LOAD:-0}" = 0 ] || exit 42; cat >/dev/null; touch "$TEST_LOADED" ;;
  'info ') ;;
  *) echo 'Unexpected Docker operation' >&2; exit 99 ;;
esac`);
file('uname', 'echo x86_64');
file('free', 'exit 0');
file('flock', '[ "${TEST_LOCK_BUSY:-0}" = 0 ]');
file('df', 'printf "Filesystem 1024-blocks Used Available Capacity Mounted\\nfixture 99999999 0 ${TEST_DISK_KB:-99999999} 0%% /\\n"');
file('nice', 'shift 2; exec "$@"');
file('ionice', 'shift 4; exec "$@"');
file('python3', 'exec ' + q(posix(python)) + ' -X utf8 "$@"');
const chmod = spawnSync(shell, ['-c', 'chmod +x ' + q(posix(bin)) + '/*'], { encoding: 'utf8' });
assert.equal(chmod.status, 0, chmod.stderr);

function scenario(name, options = {}) {
  const deploy = path.join(base, name);
  const release = path.join(deploy, 'releases/test');
  fs.mkdirSync(path.join(deploy, 'infra'), { recursive: true });
  fs.mkdirSync(path.join(release, 'infra'), { recursive: true });
  fs.writeFileSync(path.join(deploy, 'infra/.env.deploy'), `VISION_ENABLED=${options.vision ? 1 : 0}\n`);
  fs.writeFileSync(path.join(deploy, 'infra/deploy.sh'), 'stable definition\n');
  fs.writeFileSync(path.join(release, 'infra/deploy.sh'), `#!/bin/sh
set -eu
test "$SKIP_IMAGE_PULL" = 1
test "$API_IMAGE" = 'bagcollect-api:${sha}'
test "$ADMIN_IMAGE" = 'bagcollect-admin:${sha}'
touch "$BAGCOLLECT_DEPLOY_DIR/deployed"
`);
  for (const filename of ['docker-compose.yml', '.env.deploy.example']) {
    fs.writeFileSync(path.join(release, 'infra', filename), 'fixture\n');
  }
  fs.copyFileSync(path.join(root, 'infra/image-fingerprint.sh'), path.join(release, 'infra/image-fingerprint.sh'));
  if (options.vision) {
    fs.mkdirSync(path.join(deploy, 'data/vision-models'), { recursive: true });
    for (const filename of ['dinov2-small.onnx', 'manifest.json']) fs.writeFileSync(path.join(deploy, 'data/vision-models', filename), 'model');
  }
  const bundle = path.join(release, 'production-images');
  fs.mkdirSync(bundle);
  fs.writeFileSync(path.join(bundle, 'source-sha'), (options.wrongSha ? 'b'.repeat(40) : sha) + '\n');
  fs.writeFileSync(path.join(bundle, 'architecture'), options.wrongArch ? 'arm64\n' : 'amd64\n');
  fs.writeFileSync(path.join(bundle, 'images.ids'), `${id} bagcollect-api:${sha}\n${id} bagcollect-admin:${sha}\n`);
  fs.writeFileSync(path.join(bundle, 'images.fingerprints'), `${fingerprint} bagcollect-api:${sha}\n${fingerprint} bagcollect-admin:${sha}\n`);
  fs.writeFileSync(path.join(bundle, 'images.tar.gz'), gzipSync('fixture archive'));
  const sum = spawnSync(shell, ['-c', 'cd ' + q(posix(bundle)) + ' && sha256sum images.tar.gz images.ids images.fingerprints source-sha architecture > SHA256SUMS'], { encoding: 'utf8' });
  assert.equal(sum.status, 0, sum.stderr);
  if (options.corrupt) fs.appendFileSync(path.join(bundle, 'images.tar.gz'), 'corrupt');
  if (options.v2) {
    fs.copyFileSync(path.join(root, 'infra/image-bundle.py'), path.join(release, 'infra/image-bundle.py'));
    fs.writeFileSync(path.join(release, 'infra/release-retention.py'), 'print("retention fixture")\n');
    const tar = spawnSync(shell, ['-c', 'cd ' + q(posix(bundle)) + '; tar -cf fixture.tar images.ids; gzip -c fixture.tar > images.tar.gz'], { encoding: 'utf8' });
    assert.equal(tar.status, 0, tar.stderr);
    const packed = spawnSync(python, ['-X', 'utf8', path.join(root, 'infra/image-bundle.py'), 'pack', '--archive', path.join(bundle, 'images.tar.gz'), '--bundle', bundle, '--objects', path.join(deploy, '.image-cache/v2/objects')], { encoding: 'utf8' });
    assert.equal(packed.status, 0, packed.stderr);
    if (options.prepared) fs.writeFileSync(path.join(release, '.prepared'), sha + '\n');
  }
  const calls = path.join(deploy, 'calls');
  const env = {
    ...process.env,
    BAGCOLLECT_DEPLOY_DIR: posix(deploy), BAGCOLLECT_RELEASE_DIR: posix(options.outside ? base : release), BAGCOLLECT_IMAGE_TAG: sha,
    TEST_CALLS: posix(calls), TEST_DOCKER_ROOT: posix(deploy), TEST_LOADED: posix(path.join(deploy, 'loaded')),
    TEST_FAIL_LOAD: options.failLoad ? '1' : '0', TEST_WRONG_ID: options.wrongId ? '1' : '0',
    TEST_CACHED: options.cached ? '1' : '0', TEST_ALT_ID: options.altId ? '1' : '0', TEST_LOCK_BUSY: options.busy ? '1' : '0', TEST_DISK_KB: options.diskFull ? '1' : '99999999'
  };
  const flags = options.prepareOnly ? ' --prepare-only' : options.v2 ? ' --apply' : ' --apply --legacy-bundle';
  const result = spawnSync(shell, ['-c', 'export PATH=' + q(posix(bin)) + ':"$PATH"; sh ' + q(posix(path.join(root, 'infra/load-and-deploy.sh'))) + flags], { env, encoding: 'utf8' });
  assert.ifError(result.error);
  const success = name === 'success' || name === 'cached' || name === 'different-store-id' || name === 'v2-prepare-only' || name === 'v2-prepared-apply';
  assert.equal(result.status === 0, success, result.stdout + result.stderr);
  assert.equal(fs.existsSync(path.join(deploy, 'deployed')), success && !options.prepareOnly);
  if (options.prepareOnly) assert.equal(fs.readFileSync(path.join(release, '.prepared'), 'utf8').trim(), sha);
  const log = fs.existsSync(calls) ? fs.readFileSync(calls, 'utf8') : '';
  assert.doesNotMatch(log, /(^|\n)(build|compose|pull|run|exec) /);
  if (!success || options.prepareOnly) assert.equal(fs.readFileSync(path.join(deploy, 'infra/deploy.sh'), 'utf8'), 'stable definition\n');
  if (options.cached || options.wrongSha || options.wrongArch || options.corrupt || options.vision || options.busy || options.diskFull || options.outside) assert.doesNotMatch(log, /image load/);
  if (name === 'success') assert.match(log, /image load/);
  const expectedError = {
    'wrong-sha': /SHA 不一致/, 'wrong-architecture': /架构与服务器不一致/,
    'corrupt-archive': /FAILED/, 'wrong-loaded-id': /镜像层\/运行配置与 CI 不一致/,
    'missing-vision-artifact': /vision-images/, 'busy-deployment': /已有服务器部署任务/,
    'disk-full': /磁盘空间不足/, 'outside-release': /发布目录不在 releases 下/,
    'v2-apply-without-prepare': /尚未完成 prepare-only/
  }[name];
  if (expectedError) assert.match(result.stdout + result.stderr, expectedError);
  if (options.failLoad || options.wrongId) assert.match(log, /image load/);
  console.log(`PASS ${name}`);
}
scenario('wrong-sha', { wrongSha: true });
scenario('wrong-architecture', { wrongArch: true });
scenario('corrupt-archive', { corrupt: true });
scenario('load-failure', { failLoad: true });
scenario('wrong-loaded-id', { wrongId: true });
scenario('missing-vision-artifact', { vision: true });
scenario('busy-deployment', { busy: true });
scenario('disk-full', { diskFull: true });
scenario('outside-release', { outside: true });
scenario('success');
scenario('cached', { cached: true });
scenario('different-store-id', { altId: true });
scenario('v2-prepare-only', { v2: true, prepareOnly: true });
scenario('v2-apply-without-prepare', { v2: true });
scenario('v2-prepared-apply', { v2: true, prepared: true, cached: true });
