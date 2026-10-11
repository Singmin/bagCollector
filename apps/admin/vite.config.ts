import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { execSync } from 'node:child_process';

// 构建时注入版本号与时间戳，后台右上角据此核对线上运行的是哪份代码。
// 生产构建在 CI Runner 读取 BUILD_VERSION（git commit SHA）/ BUILD_TIME；
// 本地开发回退到当前 git HEAD 短哈希与本地时间。
function resolveVersion(): string {
  const fromEnv = process.env.BUILD_VERSION;
  if (fromEnv) return fromEnv;
  try {
    return execSync('git rev-parse --short HEAD', { encoding: 'utf8' }).trim();
  } catch {
    return 'dev';
  }
}

const buildTime = process.env.BUILD_TIME ?? new Date().toISOString();

export default defineConfig({
  plugins: [react()],
  define: {
    __VERSION__: JSON.stringify(resolveVersion()),
    __BUILD_TIME__: JSON.stringify(buildTime)
  },
  server: {
    port: 4173,
    proxy: { '/api': 'http://localhost:3001' }
  }
});
