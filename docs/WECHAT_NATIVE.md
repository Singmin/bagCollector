# BagCollect uni-app 微信小程序运行与发布

## 1. 当前实现

代码已经按 uni-app Vue 3 微信小程序、独立 API、独立 Worker 和运营后台拆分。uni-app 只构建 `mp-weixin`，中央按钮使用微信原生 `custom-tab-bar`。用户身份只由服务端根据微信登录临时 code 建立；客户端不会获得 AppSecret、session_key 或 OpenID。所有收藏、展示架、任务和图片查询都从访问令牌解析 `userId`，不接受客户端提交用户归属。

图片原图通过单对象、短时 STS 权限直传私有 COS。Worker 负责纠正方向、限制 60MP、生成最长边 4096px 且不超过 10MB 的标准 JPEG，再根据归一化裁剪坐标生成裁剪图、调用腾讯云数据万象「通用抠图 AIPicMatting」生成透明 PNG、2048px 展示图与 512px WebP 缩略图。数据库仅保存对象 Key。主链路只有万象一条抠图路径；接口选择、配置与隐私合规见 [腾讯云数据万象抠图实施方案](TENCENT_CI_MATTING.md)，自托管 rembg/BiRefNet 的代码保留未删除但不在主链路上。

## 2. 本地启动

要求 Node.js 22、pnpm 10.18.3、Docker 与微信开发者工具。

```bash
pnpm install
pnpm db:generate
pnpm infra:local:up
pnpm db:local:deploy
pnpm db:test:deploy
pnpm test:integration:local
pnpm dev:api
pnpm dev:worker
pnpm build:miniapp:local
```

本地 API 使用 `127.0.0.1:5432/6379` 的持久化开发服务；集成测试使用 `127.0.0.1:5433/6380` 的临时隔离服务。API 与 Worker 分别保持运行，然后用微信开发者工具导入 `apps/miniapp/dist/build/mp-weixin`。需要运营后台时另开终端运行 `pnpm dev:admin`。

仓库根目录 `.env` 的本地配置使用 `STORAGE_DRIVER=local`，图片保存在 `data/local-storage`。微信开发者工具中的 HTTP 图片会先下载成小程序临时文件再展示。Worker 输出必须通过尺寸、格式和透明像素校验后才会进入 `READY`。

**注意**：抠图走腾讯云数据万象，而万象读不到本地磁盘文件，因此本地 `.env` 必须改成 `STORAGE_DRIVER=cos` 并填入真实的 COS 桶与密钥；这份 `.env` 目前是 `local`，所以 `pnpm dev:worker` 会在配置校验处直接失败（预期行为）。抠图没有替代路径，没有腾讯云凭据时本地跑不通图片处理链路，详见 [腾讯云数据万象抠图实施方案](TENCENT_CI_MATTING.md)。

本地无微信 AppID 时保持 `WECHAT_AUTH_MOCK=true`；生产环境必须改为 `false`。默认 `127.0.0.1` 地址仅适用于开发者工具，真机联调需要改为同一局域网可访问的 API 地址，并处理微信合法域名限制。

管理账号首次创建：

```bash
ADMIN_USERNAME=admin ADMIN_PASSWORD='使用强密码' pnpm db:seed
```

## 3. 必填配置

服务器在项目的 `infra/.env.deploy` 保存配置，禁止提交该文件。至少设置：

- PostgreSQL 密码、Redis 地址、32 字符以上随机 JWT 密钥。
- 微信小程序 AppID 与 AppSecret，并关闭 `WECHAT_AUTH_MOCK`。
- COS `SecretId`、`SecretKey`、带 APPID 后缀的私有桶名、地域和 CDN/访问域名。
  这些值怎么拿到手见 [腾讯云凭据获取教程](TENCENT_CLOUD_SETUP.md)。
- 该密钥对应的 CAM 策略需额外包含 `ci:CreateS3AIPicMattingJob`，否则万象通用抠图会失败。
  **每个抠图接口对应各自的 `ci` action，互不通用**：想切回商品抠图就要补 `ci:CreateGoodsMattingJob`，漏授权时的报错是 `AccessDenied`，和桶名写错长得一样。
  小程序直传临时密钥**不需要**额外授权（`GetFederationToken` 只验签名不鉴权，子账号具备 COS 读写权限即可）。
  完整策略 JSON 见教程第 6 节。
- COS 桶需已绑定数据万象并开通抠图服务；地域必须是公有云地域（图片处理不支持多 AZ 存储桶）。
- API、Worker、Admin 三个 GHCR 镜像地址。抠图走万象后不再需要 rembg 镜像。
- 收藏数量、存储、每日抠图、上传大小和像素限制。每日抠图配额直接决定万象账单，需按用户量复核。

建议为 API/Worker 使用只允许目标桶所需动作的 CAM 子账号密钥，不使用主账号永久密钥。COS 桶保持私有，并配置生命周期清理未完成上传和历史处理版本。

## 4. 微信与腾讯云后台

1. 把 `apps/miniapp/src/manifest.json` 和 `apps/miniapp/src/project.config.json` 的测试 AppID 改成正式 AppID；自动上传时由 `miniprogram-ci` 使用 Secret 中的 AppID。
2. 开发或构建时设置 `VITE_API_BASE_URL` 为实际 HTTPS API 地址（包含 `/api`）。微信开发者工具导入 `apps/miniapp/dist/dev/mp-weixin`，正式产物位于 `dist/build/mp-weixin`。
3. 微信后台把 API 域名加入 `request` 合法域名，把 COS 上传域名加入 `uploadFile`，把 COS/CDN 访问域名加入 `downloadFile` 与必要的 `request` 白名单。
4. COS 配置允许小程序域名执行 `POST` 上传的 CORS 规则；只开放必要 Header。
5. 按个人主体后台实时可选项选择“工具 / 图片处理”等匹配类目。隐私保护指引说明相册、相机、云存储、自动抠图和注销用途。**抠图已改为调用腾讯云数据万象，裁剪图会传给第三方云服务处理，隐私保护指引里必须把「第三方处理」这一层写清楚**，并同步检查用户协议中是否存在「图片仅在本地处理」之类的表述。
6. 代码上传私钥只放在固定出口 IP 的服务器，微信后台只放行该 IP。

## 5. GitHub Actions Secrets

完整步骤（宝塔 + Docker 部署）见 [部署到宝塔服务器](DEPLOY_BAOTA.md)。

生产环境 `production`：

- `DEPLOY_HOST`、`DEPLOY_USER`、`DEPLOY_SSH_KEY`、`DEPLOY_PATH`。
- `GHCR_USER`、`GHCR_TOKEN`（可选但推荐）：GHCR 的 package 默认私有，服务器不登录就拉不到镜像。不配则沿用服务器上手工 `docker login ghcr.io` 留下的持久凭据。

小程序开发版环境 `miniapp-development`：

- 上述 SSH 配置。
- `WECHAT_APP_ID`。
- `WECHAT_PRIVATE_KEY_PATH`：服务器上上传私钥的绝对路径。
- GitHub Environment Variable `MINIAPP_API_BASE_URL`：小程序访问的 HTTPS API 地址，包含 `/api`。

PR 跑 `ci.yml`（类型检查、Lint、单测、数据库迁移、应用构建和三个 Docker target）。main 推送跑 `deploy.yml`，它先用 `workflow_call` 复用同一个 `ci.yml`，通过之后才构建镜像 —— **部署的一定是通过验证的那份代码**。镜像用 commit SHA 打标签推 GHCR（便于回滚和排障），随后 SSH 到服务器执行 `infra/deploy.sh`：备份 PostgreSQL → 拉镜像 → 启动 postgres/redis 并等健康 → 执行 migration → 切换 api/worker/admin → 等 API 健康检查，任一步失败则恢复上一组应用镜像。部署带 `concurrency` 串行锁，两个部署不会同时在服务器上执行迁移。抠图改走万象后不再构建或启动 rembg，旧容器由 `--remove-orphans` 清理。migration 必须保持向前兼容，因为镜像回滚不会反向修改数据库。

小程序通过 `Upload mini program development version` 手动工作流上传开发版本。审核与正式发布仍在微信后台人工确认。

## 6. 上线前验收边界

仓库内验证不代表腾讯云或微信生产环境已经配置完成。正式发布前还必须：

- 用两个微信测试账号验证数据与签名 URL 隔离，并验证同一微信换机恢复。
- 在实体 iPhone 与 Android 微信各完成一次登录、上传、裁剪、抠图、归架和保存。
- 覆盖 JPEG、PNG、WebP、HEIC、透明图、旋转照片、60MP 边界、损坏文件和中断上传。
- 验证抠图失败立即终止、失败记录删除退出，以及删除后的异步 COS 清理。
- 用至少 10 张真实收藏品照片跑 `pnpm ci:verify-matting -- <图片路径>`，确认万象返回的画布尺寸、透明区域与主体完整度，并据实确定 `CI_MATTING_PROCESS` 与 `CI_MATTING_SIZE_MODE`。
- 验证万象侧异常（密钥缺 `ci:CreateS3AIPicMattingJob`、服务未开通、配额耗尽）时收藏正确进入 `FAILED` 而不是产出错图。
- 在 500 件数据下验证分页、缩略图懒加载、低内存恢复、主包和分包体积。
- 实际核对服务类目、隐私声明、授权提示、合法域名与注销入口。
