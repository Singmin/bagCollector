# BagCollect

BagCollect 是一个私人视觉陈列柜。当前发布方向是基于 **uni-app（Vue 3 + TypeScript）的微信小程序**，只构建 `mp-weixin`，不开发用户端 H5；原有 SwiftUI 工程与 `h5-prototype` 完整保留，分别作为已有 iOS 实现和视觉参考。

新平台采用 pnpm workspace：

- `apps/miniapp`：uni-app、Vue 3、TypeScript、Vite 与微信 Canvas 2D，仅构建 `mp-weixin`。
- `apps/api`：NestJS + Fastify API。
- `apps/worker`：BullMQ 图片标准化、裁剪、抠图与清理任务。
- `apps/admin`：React + TypeScript + Vite 管理后台。
- `packages/contracts`：共享 Schema、DTO 与错误码。
- `infra`：Docker Compose、Nginx 和自动部署脚本。

完整的本次修改说明见 [uni-app 重构与交付说明](docs/UNIAPP_REFACTOR_SUMMARY.md)，环境变量、腾讯云、微信后台和 CI/CD 配置见 [uni-app 微信小程序运行与发布](docs/WECHAT_NATIVE.md)。抠图方案以 [腾讯云数据万象抠图实施方案](docs/TENCENT_CI_MATTING.md) 为准，主链路只有万象一条抠图路径。COS 桶名、地域与 CAM 密钥的获取步骤见 [腾讯云凭据获取教程](docs/TENCENT_CLOUD_SETUP.md)。自托管 rembg/BiRefNet 的代码保留未删除，但不在主链路上，其历史决策与性能实测见 [开源抠图实施方案](docs/OPEN_SOURCE_MATTING.md)。

## 本地验证

```bash
pnpm install
pnpm db:generate
pnpm infra:local:up
pnpm db:local:deploy
pnpm db:test:deploy
pnpm typecheck
pnpm test
pnpm test:integration:local
pnpm lint
pnpm build
```

本地基础设施与生产 Compose 分离：开发 PostgreSQL/Redis 使用 `5432/6379` 并持久化，测试 PostgreSQL/Redis 使用 `5433/6380` 和临时文件系统，避免测试重置误伤开发数据。详细边界见 [本地数据库与测试环境](docs/DATABASE_LOCAL.md)。

本地联调另开两个终端运行 `pnpm dev:api`、`pnpm dev:worker`。再运行 `pnpm build:miniapp:local`，用微信开发者工具导入 `apps/miniapp/dist/build/mp-weixin`。生产构建通过 `VITE_API_BASE_URL` 注入 API HTTPS 地址并使用私有 COS。

抠图走腾讯云数据万象「通用抠图 AIPicMatting」（0.02 元/次），万象读不到本地磁盘文件，因此本地联调必须使用 `STORAGE_DRIVER=cos` 加真实 COS 桶与密钥。没有腾讯云凭据时图片处理链路在本地跑不通，且没有替代路径 —— `pnpm dev:worker` 会在配置校验处被拦下。详见 [腾讯云数据万象抠图实施方案](docs/TENCENT_CI_MATTING.md)。

切换或验收万象抠图时，用真实样本核对画布尺寸与透明区域：

```bash
pnpm ci:verify-matting -- /absolute/path/a.jpg /absolute/path/b.jpg
```

可用指定图片跑完整本地上传与处理链路：

```bash
pnpm test:image-flow:local -- /absolute/path/to/image.png
```

该检查只有在展示图包含真实透明像素且保留可见主体时才会通过。

## 部署

生产环境跑在宝塔面板（aaPanel）服务器上，PostgreSQL、Redis、API、Worker 与运营后台都由 `infra/docker-compose.yml` 统一下发成 Docker 容器，全部只绑 `127.0.0.1`，公网流量经宝塔 Nginx 反代进入。CI/CD 由 GitHub Actions 驱动：往 `main` 推 commit 会自动验证，并在 Runner 构建 API/Worker、Admin 和可选视觉服务镜像。已验证镜像压缩后经 SCP 传到服务器；服务器检查 SHA、校验和、架构和镜像内容指纹 后只执行 `docker load`，不安装依赖或编译应用。导入成功前不切换线上容器，部署失败时回滚到上一组本地镜像。

完整的服务器准备、环境变量、镜像仓库授权、域名与 HTTPS、微信合法域名配置和排错表见 [部署到宝塔服务器](docs/DEPLOY_BAOTA.md)。

小程序不走服务器部署，它由 `Upload mini program development version` 手动工作流上传到微信平台，见 [uni-app 微信小程序运行与发布](docs/WECHAT_NATIVE.md)。

## 原有 iOS 工程

### 运行要求

- macOS 与 Xcode 26.6（当前机器已经安装）
- iOS 17.0 或更高版本的模拟器/设备
- 首次构建前需要接受 Xcode License：`sudo xcodebuild -license accept`

打开 `BagCollect.xcodeproj`，选择 iPhone 模拟器后运行即可。照片选择器在模拟器中可使用模拟器照片库；Vision 抠图建议同时在真机验证。

### iCloud 同步

工程默认以本地模式构建，确保未配置付费开发者账号时也可以运行。启用个人 iCloud 同步时：

1. 在 Target 的 Signing & Capabilities 中添加 iCloud，并勾选 CloudKit。
2. 添加 Background Modes，勾选 Remote notifications。
3. 创建或选择私有 CloudKit Container。
4. 在 Swift Compiler - Custom Flags 中为 Debug/Release 增加 `-D CLOUDKIT_ENABLED`。
5. 使用同一 iCloud 账号在两台设备验证新增、编辑、移动和删除同步。

数据模型没有唯一约束，关系保持可选，适配 SwiftData 管理的 CloudKit 同步约束。
