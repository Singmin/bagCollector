# BagCollect

BagCollect 是一个私人视觉陈列柜。当前发布方向是基于 **uni-app（Vue 3 + TypeScript）的微信小程序**，只构建 `mp-weixin`，不开发用户端 H5；原有 SwiftUI 工程与 `h5-prototype` 完整保留，分别作为已有 iOS 实现和视觉参考。

新平台采用 pnpm workspace：

- `apps/miniapp`：uni-app、Vue 3、TypeScript、Vite 与微信 Canvas 2D，仅构建 `mp-weixin`。
- `apps/api`：NestJS + Fastify API。
- `apps/worker`：BullMQ 图片标准化、裁剪、抠图与清理任务。
- `apps/admin`：React + TypeScript + Vite 管理后台。
- `packages/contracts`：共享 Schema、DTO 与错误码。
- `infra`：Docker Compose、Nginx 和自动部署脚本。

完整的本次修改说明见 [uni-app 重构与交付说明](docs/UNIAPP_REFACTOR_SUMMARY.md)，环境变量、腾讯云、微信后台和 CI/CD 配置见 [uni-app 微信小程序运行与发布](docs/WECHAT_NATIVE.md)。自托管 rembg/BiRefNet 的实现与验收边界见 [开源抠图实施方案](docs/OPEN_SOURCE_MATTING.md)。

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

本地联调另开三个终端运行 `pnpm dev:rembg`、`pnpm dev:api`、`pnpm dev:worker`。rembg 首次运行会通过 `uv` 准备 Python 3.12、固定版 rembg 和 BiRefNet 模型；服务就绪后可执行 `pnpm warmup:rembg`。再运行 `pnpm build:miniapp:local`，用微信开发者工具导入 `apps/miniapp/dist/build/mp-weixin`。本地默认把图片存入 `data/local-storage`，不要求腾讯云密钥；生产构建仍通过 `VITE_API_BASE_URL` 注入 API HTTPS 地址并使用私有 COS。

可用指定图片跑完整本地上传与处理链路：

```bash
pnpm test:image-flow:local -- /absolute/path/to/image.png
```

该检查只有在展示图包含真实透明像素且保留可见主体时才会通过。

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
