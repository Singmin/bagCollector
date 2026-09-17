# BagCollect uni-app 微信小程序运行与发布

## 1. 当前实现

代码已经按 uni-app Vue 3 微信小程序、独立 API、独立 Worker 和运营后台拆分。uni-app 只构建 `mp-weixin`，中央按钮使用微信原生 `custom-tab-bar`。用户身份只由服务端根据微信登录临时 code 建立；客户端不会获得 AppSecret、session_key 或 OpenID。所有收藏、展示架、任务和图片查询都从访问令牌解析 `userId`，不接受客户端提交用户归属。

图片原图通过单对象、短时 STS 权限直传私有 COS。Worker 负责纠正方向、限制 60MP、生成最长边 4096px 且不超过 10MB 的标准 JPEG，再根据归一化裁剪坐标生成裁剪图、调用内网 rembg/BiRefNet、生成透明 PNG、2048px 展示图与 512px WebP 缩略图。数据库仅保存对象 Key。

## 2. 本地启动

要求 Node.js 22、pnpm 10.18.3、Docker 与微信开发者工具。

```bash
pnpm install
pnpm db:generate
pnpm infra:local:up
pnpm db:local:deploy
pnpm db:test:deploy
pnpm test:integration:local
pnpm dev:rembg
pnpm warmup:rembg
pnpm dev:api
pnpm dev:worker
pnpm build:miniapp:local
```

本地 API 使用 `127.0.0.1:5432/6379` 的持久化开发服务；集成测试使用 `127.0.0.1:5433/6380` 的临时隔离服务。API 与 Worker 分别保持运行，然后用微信开发者工具导入 `apps/miniapp/dist/build/mp-weixin`。需要运营后台时另开终端运行 `pnpm dev:admin`。

仓库根目录 `.env` 的本地配置使用 `STORAGE_DRIVER=local`，图片保存在 `data/local-storage`，因此不需要 COS 密钥。微信开发者工具中的 HTTP 图片会先下载成小程序临时文件再展示。`MATTING_DRIVER=rembg` 使用监听在 `127.0.0.1:7000` 的本机模型服务，输出必须通过尺寸、格式和透明像素校验后才会进入 `READY`。

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
- API、Worker、Admin、rembg 四个 GHCR 镜像地址。
- rembg 固定使用 `birefnet-general-lite`，服务只在 Docker 内网开放，不能映射公网端口。
- 收藏数量、存储、每日抠图、上传大小和像素限制。

建议为 API/Worker 使用只允许目标桶所需动作的 CAM 子账号密钥，不使用主账号永久密钥。COS 桶保持私有，并配置生命周期清理未完成上传和历史处理版本。

## 4. 微信与腾讯云后台

1. 把 `apps/miniapp/src/manifest.json` 和 `apps/miniapp/src/project.config.json` 的测试 AppID 改成正式 AppID；自动上传时由 `miniprogram-ci` 使用 Secret 中的 AppID。
2. 开发或构建时设置 `VITE_API_BASE_URL` 为实际 HTTPS API 地址（包含 `/api`）。微信开发者工具导入 `apps/miniapp/dist/dev/mp-weixin`，正式产物位于 `dist/build/mp-weixin`。
3. 微信后台把 API 域名加入 `request` 合法域名，把 COS 上传域名加入 `uploadFile`，把 COS/CDN 访问域名加入 `downloadFile` 与必要的 `request` 白名单。
4. COS 配置允许小程序域名执行 `POST` 上传的 CORS 规则；只开放必要 Header。
5. 按个人主体后台实时可选项选择“工具 / 图片处理”等匹配类目。隐私保护指引说明相册、相机、云存储、自动抠图和注销用途。
6. 代码上传私钥只放在固定出口 IP 的服务器，微信后台只放行该 IP。

## 5. GitHub Actions Secrets

生产环境 `production`：

- `DEPLOY_HOST`、`DEPLOY_USER`、`DEPLOY_SSH_KEY`、`DEPLOY_PATH`。

小程序开发版环境 `miniapp-development`：

- 上述 SSH 配置。
- `WECHAT_APP_ID`。
- `WECHAT_PRIVATE_KEY_PATH`：服务器上上传私钥的绝对路径。
- GitHub Environment Variable `MINIAPP_API_BASE_URL`：小程序访问的 HTTPS API 地址，包含 `/api`。

PR 与 main 推送运行类型检查、Lint、单测、数据库迁移、应用构建和四个 Docker target 构建。main 合并后镜像使用 commit SHA 推送 GHCR，部署脚本先备份 PostgreSQL、执行 migration、启动内网 rembg、切换应用容器并检查 ready；失败时恢复上一组应用镜像。migration 必须保持向前兼容，因为镜像回滚不会反向修改数据库。

小程序通过 `Upload mini program development version` 手动工作流上传开发版本。审核与正式发布仍在微信后台人工确认。

## 6. 上线前验收边界

仓库内验证不代表腾讯云或微信生产环境已经配置完成。正式发布前还必须：

- 用两个微信测试账号验证数据与签名 URL 隔离，并验证同一微信换机恢复。
- 在实体 iPhone 与 Android 微信各完成一次登录、上传、裁剪、抠图、归架和保存。
- 覆盖 JPEG、PNG、WebP、HEIC、透明图、旋转照片、60MP 边界、损坏文件和中断上传。
- 验证抠图两次自动重试、保留裁剪图、重新抠图、删除后的异步 COS 清理。
- 在 500 件数据下验证分页、缓存、缩略图懒加载、低内存恢复、主包和分包体积。
- 实际核对服务类目、隐私声明、授权提示、合法域名与注销入口。
