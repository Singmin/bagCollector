// 列出当前 COS 密钥所属账号下的所有存储桶（名称 + 地域）
// =====================================================================
// 用途：COS 对「桶名写错」和「地域写错」返回的都是同一个 NoSuchBucket，
// 肉眼完全分不出来。这个脚本直接问腾讯云要真实清单，一次性消除这类歧义。
//
// 用法：
//   pnpm ci:list-buckets
//   node scripts/list-cos-buckets.mjs
//
// 需要环境变量（从仓库根目录 .env 读取）：
//   COS_SECRET_ID、COS_SECRET_KEY
//
// 需要密钥具备 cos:GetService 权限（列举自己名下的桶）。
// 这是「拉取存储桶列表」接口对应的 action，跟 cos:GetObject 等对象级权限是两码事，
// 默认的自定义策略里不含它，所以报 AccessDenied 是权限问题、不是密钥失效。
// 密钥失效报的是 InvalidAccessKeyId / SignatureDoesNotMatch，两者很好区分。
//
// 临时加上这条权限、跑完这次排查后再去掉，是安全的做法。

import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadEnvFile } from 'node:process';

// cos-nodejs-sdk-v5 声明在 apps/worker 与 apps/api 里，根 package.json 没有它，
// 仓库级脚本直接 import 会解析不到。这里借 worker 的依赖上下文 require。
const requireFromWorker = createRequire(new URL('../apps/worker/package.json', import.meta.url));
const cosModule = requireFromWorker('cos-nodejs-sdk-v5');
const COS = cosModule.default ?? cosModule;

try {
  loadEnvFile(resolve(fileURLToPath(new URL('..', import.meta.url)), '.env'));
} catch {
  // 直接注入环境变量时不需要 .env
}

const { COS_SECRET_ID, COS_SECRET_KEY } = process.env;
if (!COS_SECRET_ID || !COS_SECRET_KEY) {
  console.error('缺少 COS_SECRET_ID / COS_SECRET_KEY。请先在仓库根目录 .env 中配置。');
  process.exit(1);
}

const client = new COS({ SecretId: COS_SECRET_ID, SecretKey: COS_SECRET_KEY });

client.getService({}, (error, data) => {
  if (error) {
    const code = error.code ?? '';
    if (/AccessDenied|Forbidden/i.test(`${code} ${error.message}`)) {
      console.error(`列举存储桶失败：${code} ${error.message}
      → 密钥有效，但缺少 cos:GetService 权限。给子用户的策略里临时补一条：
        {
          "effect": "allow",
          "action": ["cos:GetService"],
          "resource": ["*"]
        }
        跑完这个脚本后再把这条删掉即可。
      → 如果你不想动策略，就直接去 COS 控制台「存储桶列表」，
        逐字抄「名称」列和「地域」列（名称必须是 <自定义名>-<APPID> 的完整形态）。`);
    } else if (/InvalidAccessKeyId|SignatureDoesNotMatch/i.test(`${code} ${error.message}`)) {
      console.error(`列举存储桶失败：${code} ${error.message}
      → 密钥本身有问题（复制时带了空格/换行，或已被禁用、删除）。`);
    } else {
      console.error(`列举存储桶失败：${code} ${error.message}`);
    }
    process.exit(1);
  }

  const buckets = data?.Buckets ?? [];
  console.log(`账号下共 ${buckets.length} 个存储桶：\n`);
  if (!buckets.length) {
    console.log('  （空）—— 这个账号还没有创建任何存储桶，去控制台建一个。');
  }
  for (const bucket of buckets) {
    console.log(`  名称=${bucket.Name}    地域=${bucket.Location}    创建时间=${bucket.CreationDate}`);
  }
  console.log('\n把「名称」原样填进 .env 的 COS_BUCKET，把「地域」填进 COS_REGION。');
});
