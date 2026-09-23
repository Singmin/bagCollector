// 腾讯云数据万象抠图真实样本验收脚本
// =====================================================================
// 用途：在切换生产链路之后、正式灰度之前，用真实收藏品照片核对三件事：
//   1. 万象是否按原画布尺寸返回（即 center-layout=0 下输出与输入 1:1）。
//      这一点直接决定 CI_MATTING_SIZE_MODE 该设 strict 还是 rescale。
//   2. 抠图结果是否确实带透明背景、且保留了可见主体。
//   3. 单张耗时与 subject 像素占比，用于估算成本和判断边缘质量。
//
// 用法：
//   node scripts/verify-ci-matting.mjs /absolute/path/a.jpg /absolute/path/b.jpg ...
//   pnpm ci:verify-matting -- /absolute/path/a.jpg
//
// 需要环境变量（可从仓库根目录 .env 读取，也可直接注入）：
//   COS_SECRET_ID、COS_SECRET_KEY、COS_BUCKET、COS_REGION
//   CI_MATTING_PROCESS  默认 AIPicMatting（通用抠图，与 Worker 配置默认值一致），可设为 GoodsMatting（商品抠图）
//   CI_MATTING_SIZE_MODE 默认 strict（刻意比 Worker 的 rescale 更严，用于探测接口是否 1:1 返回）
//
// 前置条件：COS 桶已绑定数据万象并开通抠图服务，且所用密钥具备
// cos:PutObject、cos:GetObject，以及所用接口对应的 ci action
// （AIPicMatting → ci:CreateS3AIPicMattingJob，GoodsMatting → ci:CreateGoodsMattingJob）。
//
// 脚本会在 COS 上创建 ci-verify/<时间戳>/ 前缀存放临时对象，结束时自动清理。

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { loadEnvFile } from 'node:process';
import sharp from 'sharp';

// cos-nodejs-sdk-v5 声明在 apps/worker 与 apps/api 里，根 package.json 没有它，
// 仓库级脚本直接 import 会解析不到（Node 从脚本所在目录向上找 node_modules）。
// 这里借 worker 的依赖上下文 require，避免为了一个验收脚本去动根依赖与 lockfile。
const requireFromWorker = createRequire(new URL('../apps/worker/package.json', import.meta.url));
const cosModule = requireFromWorker('cos-nodejs-sdk-v5');
const COS = cosModule.default ?? cosModule;

const MAX_EDGE = 2048; // 与 Worker 生成的 display 图一致，代表真实送抠图的尺寸量级
// 单价随接口变化：商品抠图 0.01 元/次，通用抠图与人像抠图 0.02 元/次。
// 写死 0.01 时用 AIPicMatting 跑会低估一半，这里按 processName 取。
const UNIT_PRICE = { GoodsMatting: 0.01, AIPicMatting: 0.02, AIPortraitMatting: 0.02 };

try {
  loadEnvFile(resolve(process.cwd(), '.env'));
} catch {
  // 直接注入环境变量时不需要 .env
}

const paths = process.argv.slice(2).filter((value) => !value.startsWith('-'));
if (!paths.length) {
  console.error('用法：node scripts/verify-ci-matting.mjs /absolute/path/a.jpg [/absolute/path/b.jpg ...]');
  process.exit(1);
}

const { COS_SECRET_ID, COS_SECRET_KEY, COS_BUCKET, COS_REGION } = process.env;
for (const [name, value] of Object.entries({ COS_SECRET_ID, COS_SECRET_KEY, COS_BUCKET, COS_REGION })) {
  if (!value) {
    console.error(`缺少环境变量 ${name}，无法生成签名 URL。请先在仓库根目录 .env 中配置。`);
    process.exit(1);
  }
}

const processName = process.env.CI_MATTING_PROCESS || 'AIPicMatting';
const sizeMode = process.env.CI_MATTING_SIZE_MODE || 'strict';
const timeoutMs = Number(process.env.CI_MATTING_TIMEOUT_MS || 60_000);

const client = new COS({ SecretId: COS_SECRET_ID, SecretKey: COS_SECRET_KEY });
const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const prefix = `ci-verify/${stamp}`;
const outputDir = resolve(process.cwd(), 'data/ci-matting-verify', stamp);

function signedUrl(key) {
  // 与 Worker 中的实现保持一致：把 ci-process 一起签进签名，桶保持私有。
  return client.getObjectUrl({
    Bucket: COS_BUCKET,
    Region: COS_REGION,
    Key: key,
    Method: 'GET',
    Sign: true,
    Expires: 600,
    Query: { 'ci-process': processName, 'center-layout': '0' }
  });
}

function putObject(key, body) {
  return new Promise((resolvePromise, reject) => {
    client.putObject(
      { Bucket: COS_BUCKET, Region: COS_REGION, Key: key, Body: body, ContentType: 'image/jpeg', ContentLength: body.length },
      // 标上操作名：AccessDenied 出现在 PutObject 还是抠图请求，排查方向完全不同
      // （前者说明 cos:PutObject 没授权，后者说明 ci:CreateGoodsMattingJob 或 cos:GetObject 没授权）。
      (error) => (error ? reject(tagOperation(error, `PutObject ${key}`)) : resolvePromise())
    );
  });
}

function deleteObject(key) {
  return new Promise((resolvePromise, reject) => {
    client.deleteObject({ Bucket: COS_BUCKET, Region: COS_REGION, Key: key }, (error) =>
      error ? reject(tagOperation(error, `DeleteObject ${key}`)) : resolvePromise()
    );
  });
}

function tagOperation(error, operation) {
  if (error && typeof error === 'object') error.failedOperation = operation;
  return error;
}

/**
 * 把 SDK 报错翻译成能直接照做的排查提示。
 *
 * 这几类错误在首次配置凭据时出现频率最高，而原始报文（尤其是万象返回的
 * 200 + XML）本身看不出该改哪里，所以在这里一次性补上。
 */
function describeError(error) {
  const message = error instanceof Error ? error.message : String(error);
  const code = error && typeof error === 'object' && 'code' in error ? String(error.code) : '';
  const raw = `${code} ${message}`;
  const operation = error && typeof error === 'object' && 'failedOperation' in error ? String(error.failedOperation) : '';
  const prefix = operation ? `[${operation}] ` : '';

  if (/NoSuchBucket|bucket does not exist/i.test(raw)) {
    return `${prefix}${message}
      → 桶名或地域对不上。COS 对「桶不存在」和「地域写错」返回同一个 NoSuchBucket，所以两者都要核。
        去 COS 控制台「存储桶列表」逐字抄「名称」列与「地域」列；名称必须是 <自定义名>-<APPID> 的完整形态。
        可用无密钥探测快速区分：访问 https://<桶名>.cos.<地域>.myqcloud.com/ ——
        返回 403 AccessDenied 说明桶存在且地域正确，返回 404 NoSuchBucket 说明桶名或地域不对。`;
  }
  if (/InvalidAccessKeyId|SecretId is invalid|SignatureDoesNotMatch/i.test(raw)) {
    return `${prefix}${message}
      → 密钥本身有问题：SecretId/SecretKey 复制时带了空格或换行，或密钥已被删除/禁用。
        子用户详情页「API 密钥」重新复制，必要时删除重建。`;
  }
  if (/AccessDenied|Forbidden/i.test(raw)) {
    // 桶名实际存在但仍被拒，只剩两种可能：策略里的桶名与真实值不一致，或缺了当前 ci-process
    // 对应的 action。COS 对「资源不在策略里」和「资源不存在于该账号」都回 AccessDenied，看不出差别。
    return `${prefix}${message}
      → 密钥有效但权限不足，两种可能：
        (1) 策略里的桶名与 .env 不一致（含 APPID 后缀，一个数字都不能差）。resource 形如：
              COS：qcs::cos:<地域>:uid/<APPID>:<桶名>/*
              CI ：qcs::ci:<地域>:uid/<APPID>:bucket/<桶名>/*   （注意有 bucket/ 前缀）
        (2) 缺了当前接口对应的 ci action。**每个抠图能力对应各自的 action，互不通用**：
              AIPicMatting（通用抠图） → ci:CreateS3AIPicMattingJob   ← 本项目当前使用
              GoodsMatting（商品抠图） → ci:CreateGoodsMattingJob
              AIPortraitMatting（人像抠图） → ci:CreateS3AIPicPortraitMattingJob
            另需确认策略已关联到该子用户，且填的是 uid/<APPID> 而非 <APPID>。
        排查捷径：pnpm ci:list-buckets 能列出真实桶名（需临时授予 cos:GetService）。`;
  }
  return `${prefix}${message}`;
}

async function inspect(input) {
  const metadata = await sharp(input).metadata();
  if (!metadata.width || !metadata.height) throw new Error('无法读取结果尺寸');
  // 复用 Worker 的通道统计方式：PNG 的最后一个通道就是 alpha。
  const statistics = await sharp(input).stats();
  const alpha = statistics.channels[(metadata.channels ?? 4) - 1];
  const totalPixels = metadata.width * metadata.height;
  const opaquePixels = alpha ? Math.round((alpha.mean / 255) * totalPixels) : 0;
  return {
    width: metadata.width,
    height: metadata.height,
    hasAlpha: Boolean(metadata.hasAlpha),
    alphaMin: alpha?.min ?? null,
    alphaMax: alpha?.max ?? null,
    subjectPixelRatio: Number((opaquePixels / totalPixels).toFixed(4))
  };
}

await mkdir(outputDir, { recursive: true });

const uploadedKeys = [];
const rows = [];
let passed = 0;

for (const [index, inputPath] of paths.entries()) {
  const label = `${index + 1}/${paths.length} ${inputPath}`;
  const key = `${prefix}/${index + 1}.jpg`;
  try {
    // 与 Worker 一样先把输入限制在 2048px 内再送抠图，保证测的是真实链路量级。
    const normalized = await sharp(await readFile(inputPath))
      .rotate()
      .resize({ width: MAX_EDGE, height: MAX_EDGE, fit: 'inside', withoutEnlargement: true })
      .jpeg({ quality: 90, mozjpeg: true })
      .toBuffer({ resolveWithObject: true });
    const expected = { width: normalized.info.width, height: normalized.info.height };

    await putObject(key, normalized.data);
    uploadedKeys.push(key);

    const startedAt = Date.now();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    let response;
    try {
      response = await fetch(signedUrl(key), { method: 'GET', signal: controller.signal });
    } finally {
      clearTimeout(timer);
    }
    const elapsedMs = Date.now() - startedAt;

    if (!response.ok) {
      // 抠图请求被拒时，响应体里才有真正的 Code（AccessDenied / InvalidArgument 等），
      // 只报 HTTP 状态码会丢掉最有用的信息。
      const detail = (await response.text()).slice(0, 300);
      const error = new Error(`抠图请求失败 HTTP ${response.status}：${detail}`);
      error.failedOperation = `GET ?ci-process=${processName}（抠图）`;
      throw error;
    }
    const contentType = response.headers.get('content-type') ?? '';
    if (!contentType.startsWith('image/')) {
      // 万象在服务未开通或权限不足时会返回 200 + XML，这里必须显式暴露出来。
      const error = new Error(
        `未返回图片（content-type=${contentType}）：${(await response.text()).slice(0, 200)}`
      );
      error.failedOperation = `GET ?ci-process=${processName}（抠图）`;
      throw error;
    }

    const body = Buffer.from(await response.arrayBuffer());
    const base = `cutout-${String(index + 1).padStart(2, '0')}.png`;
    await writeFile(resolve(outputDir, base), body);

    const result = await inspect(body);
    const sizeExact = result.width === expected.width && result.height === expected.height;
    const problems = [];
    if (!result.hasAlpha) problems.push('缺少透明通道');
    if (result.alphaMin === null || result.alphaMin >= 255) problems.push('没有透明背景');
    if (result.alphaMax === null || result.alphaMax <= 0) problems.push('没有可见主体');
    if (result.subjectPixelRatio < 0.02) problems.push('主体占比过低，可能只抠出了碎片');
    if (!sizeExact) {
      if (sizeMode === 'strict') problems.push(`画布尺寸不一致：${result.width}x${result.height} ≠ ${expected.width}x${expected.height}`);
      else problems.push(`画布尺寸不一致（rescale 模式下 Worker 会缩放回来）：${result.width}x${result.height} ≠ ${expected.width}x${expected.height}`);
    }

    const ok = problems.length === 0;
    if (ok) passed += 1;
    rows.push({ label, ok, elapsedMs, expected, result, file: base, problems });
  } catch (error) {
    rows.push({ label, ok: false, problems: [describeError(error)] });
  }
}

await writeFile(
  resolve(outputDir, 'result.json'),
  JSON.stringify({ processName, sizeMode, cosBucket: COS_BUCKET, cosRegion: COS_REGION, rows }, null, 2)
);

console.log(`\n抠图接口：${processName}    画布校验模式：${sizeMode}`);
console.log(`COS：${COS_BUCKET} @ ${COS_REGION}`);
console.log('-'.repeat(96));
for (const row of rows) {
  const size = row.result
    ? `${row.result.width}x${row.result.height}（期望 ${row.expected.width}x${row.expected.height}）`
    : '-';
  console.log(
    `${row.ok ? '✓' : '✗'} ${row.label}\n    ${row.result ? `${row.elapsedMs}ms  尺寸 ${size}  主体占比 ${row.result.subjectPixelRatio}` : '未取得结果'}${
      row.problems.length ? `\n    问题：${row.problems.join('；')}` : ''
    }`
  );
}
console.log('-'.repeat(96));
console.log(`通过 ${passed}/${rows.length}，结果已写入 ${outputDir}`);
// 只有真正拿到抠图结果的那些才产生调用，失败在请求前的（如桶名错）不计费。
const billedCalls = rows.filter((row) => row.result).length;
const unitPrice = UNIT_PRICE[processName] ?? 0.01;
console.log(
  `实际发起抠图调用 ${billedCalls} 次，费用约 ${(billedCalls * unitPrice).toFixed(2)} 元（按 ${processName} ${unitPrice} 元/次估算）`
);
console.log(
  sizeMode === 'rescale'
    ? '提示：rescale 模式下 Worker 会把画布整体缩放回裁剪图尺寸，宽高比不一致仍会失败。'
    : '提示：strict 模式下只要画布尺寸与裁剪图不一致就会失败。若上面出现尺寸不一致，请把 CI_MATTING_SIZE_MODE 设为 rescale。'
);

// 清理临时对象，避免把验证样本长期留在生产桶里。
let cleanupFailed = 0;
for (const key of uploadedKeys) {
  try {
    await deleteObject(key);
  } catch {
    cleanupFailed += 1;
  }
}
if (cleanupFailed) {
  console.warn(`警告：有 ${cleanupFailed} 个临时对象删除失败，请手动清理 COS 上的 ${prefix}/ 前缀。`);
}

process.exit(passed === rows.length ? 0 : 1);
