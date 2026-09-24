# BagCollect uni-app 重构与交付说明

> 整理日期：2026-09-17
> 当前阶段：代码架构与第一版业务流程已落地，可构建微信小程序开发版本；腾讯云、微信后台和生产服务器仍需使用正式配置完成联调与验收。
>
> **后续变更（2026-09-21，2026-09-22 修订）**：抠图已从自托管 rembg/BiRefNet 改为**腾讯云数据万象**，主链路只走万象；接口先从「商品抠图 GoodsMatting」切到当前的「通用抠图 AIPicMatting」（0.02 元/次，理由见方案文档 7.2 节）。本文中所有把 rembg 当作运行组件或部署前置条件的表述（第 2、6、9、10、11 节）都已过时，现行方案见 [腾讯云数据万象抠图实施方案](TENCENT_CI_MATTING.md)。以下历史描述保留原文以便对照。

## 1. 本次方向调整

BagCollect 用户端已从“直接编写微信原生 WXML/WXSS”调整为：

- 使用 uni-app、Vue 3、TypeScript 和 Vite 开发。
- 只构建微信小程序 `mp-weixin`，不构建用户端 H5。
- 保留微信原生能力，包括自定义 `tabBar`、`wx.login`、`wx.uploadFile` 和 Canvas 2D。
- 后端继续使用 NestJS + Fastify，不使用 Next.js 作为主后端。
- 原 SwiftUI 工程及原有未提交修改全部保留。
- `h5-prototype` 继续作为视觉参考，不作为发布入口。

## 2. 当前总体架构

项目已经整理为 pnpm workspace：

| 目录 | 技术栈 | 职责 |
| --- | --- | --- |
| `apps/miniapp` | uni-app、Vue 3、TypeScript、Vite | 微信小程序用户端 |
| `apps/api` | NestJS、Fastify、Prisma | 登录、收藏、展示架、上传和管理接口 |
| `apps/worker` | BullMQ、Sharp、COS、本地存储、rembg | 图片标准化、裁剪、抠图、缩略图和清理任务 |
| `apps/admin` | React、TypeScript、Vite | 最小运营管理后台 |
| `packages/contracts` | TypeScript、Zod | 公共类型、Schema、DTO 和错误码 |
| `infra` | Docker、Compose、Nginx、Shell | 容器构建、反向代理和服务器部署 |

主要基础设施：

- PostgreSQL：业务数据与会话。
- Redis：BullMQ 任务队列。
- 腾讯云 COS：私有图片对象存储。
- 自托管 rembg/BiRefNet：通用物品抠图。
- 腾讯云 TCR：API/Worker（同一镜像，见 `infra/Dockerfile`）、Admin 和小程序上传镜像。
- GitHub Actions：检查、构建、部署和微信开发版上传。

## 3. 小程序端修改

### 3.1 工程与构建

`apps/miniapp` 已改造成 uni-app Vue 3 工程，主要文件如下：

- `src/main.ts`：Vue 应用入口。
- `src/App.vue`：应用级启动、登录和全局样式入口。
- `src/pages.json`：主包、分包、自定义 tabBar 与页面配置。
- `src/manifest.json`：微信小程序能力和编译配置。
- `src/project.config.json`：微信开发者工具工程配置。
- `vite.config.ts`：uni-app Vite 插件配置。
- `src/uni.scss`：全局设计变量和通用样式。

当前命令：

```bash
# 开发模式
pnpm --filter @bagcollect/miniapp dev:mp-weixin

# 生产构建
VITE_API_BASE_URL=https://api.example.com/api \
  pnpm --filter @bagcollect/miniapp build:mp-weixin
```

微信开发者工具导入目录：

- 开发产物：`apps/miniapp/dist/dev/mp-weixin`
- 生产产物：`apps/miniapp/dist/build/mp-weixin`

### 3.2 页面与分包

主包只保留高频入口：

- `pages/showcase/index`：首页陈列与最近加入。
- `pages/library/index`：全部收藏、搜索、筛选和分页。
- `components/CollectibleCard.vue`：收藏品卡片。
- `components/EmptyState.vue`：空状态。
- `custom-tab-bar`：陈列、中央添加按钮、全部收藏。

图片编辑分包 `package-editor`：

- `pages/add/index`：相册/相机选图、创建收藏、申请上传凭证并直传 COS。
- `pages/crop/index`：Canvas 2D 缩放、拖动、旋转和裁剪。
- `pages/processing/index`：轮询标准化/抠图状态、失败恢复。
- `pages/metadata/index`：名称、展示架、标签和备注。

收藏详情分包 `package-library`：

- `pages/detail/index`：查看、编辑、移动和删除。

设置分包 `package-settings`：

- `pages/settings/index`：存储用量、隐私说明、退出登录和注销账号。
- `pages/shelves/index`：展示架创建、改名、换色、排序和删除。

### 3.3 登录与请求层

小程序启动流程：

1. 调用 `uni.login({ provider: 'weixin' })` 获取临时 code。
2. 请求 `POST /api/auth/wechat/login`。
3. 后端使用 AppID/AppSecret 换取微信身份。
4. 客户端只保存访问令牌和刷新令牌，不接收 AppSecret、`session_key` 或 OpenID。
5. 请求层自动携带 `Authorization: Bearer <token>`。
6. 访问令牌失效时尝试刷新并轮换刷新令牌。

相关文件：

- `src/services/http.ts`：请求、登录、刷新和错误处理。
- `src/services/data.ts`：展示架、收藏、上传和任务 API。
- `src/services/auth-storage.ts`：仅持久化登录令牌。
- `src/config.ts`：通过 `VITE_API_BASE_URL` 注入 API 地址。

### 3.4 图片流程

已接入的流程为：

1. 使用 `uni.chooseMedia` 选择照片或拍照。
2. 向 API 申请仅允许单个 COS Key 的短期上传凭证。
3. 使用 `uni.uploadFile` 直传 COS，图片不经过 API 服务器中转。
4. Worker 纠正方向、限制像素并生成标准 JPEG。
5. 小程序使用标准图在 Canvas 2D 中完成裁剪。
6. Worker 生成裁剪图并调用内网 rembg/BiRefNet，校验透明结果。
7. 生成展示图和缩略图，数据库只保存 COS Key。

处理状态：

```text
UPLOADING → NORMALIZING → AWAITING_CROP → MATTING → READY / FAILED
```

图片处理只执行一次。失败时记录真实错误，不生成备用展示图；小程序只允许删除失败记录并退出当前创建流程。

## 4. API 与身份隔离

### 4.1 已实现接口

身份与账户：

```text
POST   /api/auth/wechat/login
POST   /api/auth/refresh
POST   /api/auth/logout
GET    /api/account
DELETE /api/account
```

展示架：

```text
GET    /api/shelves
POST   /api/shelves
PATCH  /api/shelves/:id
POST   /api/shelves/reorder
DELETE /api/shelves/:id
```

收藏品：

```text
GET    /api/collectibles
POST   /api/collectibles
GET    /api/collectibles/:id
PATCH  /api/collectibles/:id
POST   /api/collectibles/:id/crop
DELETE /api/collectibles/:id
```

上传、图片和任务：

```text
POST /api/uploads/policy
POST /api/uploads/complete
GET  /api/assets/:id/url
GET  /api/processing-jobs/:id
```

管理后台：

```text
POST /api/admin/login
GET  /api/admin/overview
GET  /api/admin/jobs
```

健康检查：

```text
GET /api/health/live
GET /api/health/ready
```

### 4.2 安全边界

- 用户归属全部从服务端访问令牌解析，不接受客户端传入 `userId`。
- 刷新令牌在数据库中只保存哈希，刷新后轮换。
- 图片签名 URL 按当前用户和对象归属生成。
- COS 永久密钥、微信 AppSecret 和代码上传私钥不进入客户端。
- 数据库只保存图片对象 Key，不保存图片二进制。
- 管理员操作记录进入审计日志。

## 5. 数据库结构

Prisma 当前包含：

- `User`：微信身份、状态、配额和存储用量。
- `Session`：刷新令牌哈希、设备、过期和撤销时间。
- `Shelf`：名称、主题、排序和系统展示架标记。
- `Collectible`：资料、展示架、排序、处理状态、版本和裁剪参数。
- `Tag`、`CollectibleTag`：标签与多对多关联。
- `ImageAsset`：图片类型、COS Key、格式、尺寸、大小和版本。
- `ProcessingJob`：任务类型、状态、幂等键、次数和错误信息。
- `Admin`、`AuditLog`：管理账号和操作审计。

处理任务使用“收藏品 ID + 处理版本”作为幂等依据，避免重复消息生成多套结果。

## 6. 配额与限制

默认配置：

| 配置 | 默认值 |
| --- | ---: |
| 每用户收藏数量 | 500 件 |
| 每用户存储空间 | 5 GB |
| 每日抠图次数 | 50 次 |
| 单文件上传大小 | 30 MB |
| 单图片像素 | 60 MP |
| 标准图最长边 | 4096 px |
| 标准图目标大小 | 10 MB 以下 |
| 访问令牌有效期 | 2 小时 |
| 刷新令牌有效期 | 30 天 |

以上限制均可通过服务器环境变量调整。

## 7. CI/CD 修改

### 7.1 Pull Request 与 main 检查

`.github/workflows/ci.yml` 会执行：

1. 安装锁定依赖。
2. 生成 Prisma Client 并执行 migration。
3. ESLint。
4. 全仓 TypeScript 检查。
5. 小程序页面和包体结构检查。
6. 单元测试。
7. API、Worker、Admin 和 uni-app 微信小程序构建。
8. API 集成测试。
9. API、Worker、Admin Docker target 构建。

### 7.2 后端部署

`.github/workflows/deploy.yml` 在 `main` 更新后：

1. 构建 API/Worker（同一镜像，compose 用 `command` 区分角色）与 Admin 镜像。
2. 使用 commit SHA 和 `latest` 推送腾讯云 TCR（服务器同地域走内网拉取）。
3. 通过 SSH 将部署文件同步到服务器。
4. 服务器备份 PostgreSQL。
5. 执行 Prisma migration。
6. 拉取并切换到指定 SHA 镜像。
7. 检查 `/api/health/live` 与 `/api/health/ready`。
8. 应用健康检查失败时恢复上一组应用镜像。

数据库 migration 不会在镜像回滚时自动反向回滚，因此生产 migration 必须保持向前兼容。

### 7.3 微信开发版上传

`.github/workflows/upload-miniapp.yml` 使用 `workflow_dispatch` 手动触发：

1. 构建 `miniapp-uploader` 镜像。
2. 将镜像推送腾讯云 TCR。
3. 通过 SSH 在固定出口 IP 的服务器运行容器。
4. 容器执行 uni-app `mp-weixin` 生产构建。
5. `miniprogram-ci` 上传微信开发版本。

自动化只上传开发版本；提交审核和正式发布继续在微信后台人工确认。

## 8. 环境配置

本地可从 `.env.example` 创建 `.env`。生产配置保存在服务器 `infra/.env.deploy`，不得提交 Git。

关键变量分类：

- API：`API_PORT`、`API_PUBLIC_URL`。
- 数据库与队列：`DATABASE_URL`、`REDIS_URL`。
- 会话：`JWT_SECRET`、`ACCESS_TOKEN_TTL`、`REFRESH_TOKEN_DAYS`。
- 微信：`WECHAT_APP_ID`、`WECHAT_APP_SECRET`、`WECHAT_AUTH_MOCK`。
- COS：`COS_SECRET_ID`、`COS_SECRET_KEY`、`COS_BUCKET`、`COS_REGION`、`COS_PUBLIC_HOST`。
- 配额：`MAX_COLLECTIBLES_PER_USER`、`MAX_STORAGE_BYTES`、`MAX_DAILY_MATTING`、`MAX_UPLOAD_BYTES`、`MAX_IMAGE_PIXELS`。
- 管理后台：`ADMIN_USERNAME`、`ADMIN_PASSWORD`。
- 小程序构建：`VITE_API_BASE_URL`。

生产环境必须：

- 将 `WECHAT_AUTH_MOCK` 设置为 `false`。
- 使用至少 32 字符的随机 `JWT_SECRET`。
- 替换默认管理员密码。
- 使用权限受限的腾讯云 CAM 子账号密钥。
- 将所有 Secret 保存在 GitHub Environment 或服务器环境文件中，不写入代码、镜像构建参数或日志。

## 9. 当前验证结果

本次已经实际执行并通过：

```text
ESLint                         通过
全仓 TypeScript 检查           通过
单元测试                       6 个测试文件、27 个测试全部通过
NestJS API 构建                通过
BullMQ Worker 构建             通过
React 管理后台构建             通过
uni-app mp-weixin 构建         通过
Prisma Schema 校验             通过
上传脚本 Node 语法检查          通过
部署脚本 Shell 语法检查         通过
git diff --check              通过
```

uni-app 编译器输出版本为 Vue 3，生产微信小程序产物约为 `364 KB`，已生成主包、三个分包和原生自定义 tabBar 文件。

Docker 镜像仍需由 GitHub Actions 或本机 Docker 完成实际构建验证；CI 已覆盖 API、Worker、Admin 和固定版 rembg 四个服务 target。

## 10. 尚未完成的外部配置与验收

以下内容不能仅靠仓库代码完成：

- 在 `manifest.json` 和 `project.config.json` 填写正式微信 AppID。
- 在微信后台配置 API、COS、CDN 合法域名。
- 上传微信代码上传私钥，并将服务器固定出口 IP 加入白名单。
- 在腾讯云创建私有 COS 桶、配置 CORS、生命周期和 CAM 权限。
- 在服务器完成固定版 rembg 镜像与 BiRefNet 模型的首次部署、预热和资源测量。
- 在服务器写入正式 `.env.deploy` 并完成首次部署。
- 在个人主体后台确认实际可选服务类目和隐私保护指引。
- 在实体 iPhone 与 Android 微信分别完成完整流程测试。
- 使用两个微信账号验证用户数据和图片签名 URL 隔离。
- 使用同一个微信账号在两台设备验证云端恢复。
- 在 500 件收藏下验证分页、首屏、低内存恢复和包体积。
- 人工提交微信审核并发布正式版本。

## 11. 推荐的下一步执行顺序

1. 恢复或安装 Docker Desktop，运行完整 Docker 构建。
2. 准备腾讯云 COS、CAM 子账号和服务器 rembg 运行资源。
3. 准备正式域名证书和 API HTTPS 反向代理。
4. 填写服务器生产环境变量并部署 API、Worker、Admin。
5. 配置微信 AppID、AppSecret、合法域名和上传私钥。
6. 用微信开发者工具导入 `apps/miniapp/dist/dev/mp-weixin` 联调。
7. 执行真机与双账号隔离验收。
8. 通过 GitHub Actions 上传开发版本。
9. 完成隐私、类目和功能审核后人工发布。

## 12. 相关文档

- `README.md`：项目入口和本地命令。
- `docs/WECHAT_NATIVE.md`：运行、腾讯云、微信后台和 CI/CD 配置说明。
- `docs/UNIAPP_REFACTOR_SUMMARY.md`：本次重构与交付内容汇总。
- `.env.example`：本地环境变量模板。
- `infra/.env.deploy.example`：服务器部署环境变量模板。
