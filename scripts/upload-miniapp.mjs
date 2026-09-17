import ci from 'miniprogram-ci';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const appid = process.env.WECHAT_APP_ID;
const privateKeyPath = process.env.WECHAT_PRIVATE_KEY_PATH;
const version = process.env.MINIAPP_VERSION;
const desc = process.env.MINIAPP_DESC || 'BagCollect automated development upload';
const apiBaseUrl = process.env.VITE_API_BASE_URL;

if (!appid || !privateKeyPath || !version || !apiBaseUrl) {
  throw new Error('WECHAT_APP_ID, WECHAT_PRIVATE_KEY_PATH, MINIAPP_VERSION and VITE_API_BASE_URL are required');
}

const build = spawnSync('pnpm', ['--filter', '@bagcollect/miniapp', 'build:mp-weixin'], {
  stdio: 'inherit',
  env: { ...process.env, VITE_API_BASE_URL: apiBaseUrl }
});
if (build.status !== 0) throw new Error(`uni-app mp-weixin build failed with exit code ${build.status}`);

const project = new ci.Project({
  appid,
  type: 'miniProgram',
  projectPath: path.resolve('apps/miniapp/dist/build/mp-weixin'),
  privateKeyPath,
  ignores: ['node_modules/**/*', 'project.private.config.json']
});

await ci.upload({
  project,
  version,
  desc,
  setting: { es6: true, es7: true, minify: true, codeProtect: true, autoPrefixWXSS: true },
  onProgressUpdate: console.info
});
