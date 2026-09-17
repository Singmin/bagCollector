# BagCollect 本地数据库与测试环境

## 环境边界

`infra/docker-compose.local.yml` 只运行本地基础设施，不依赖生产镜像或腾讯云配置。

| 用途 | PostgreSQL | Redis | 数据生命周期 |
| --- | --- | --- | --- |
| 本地开发 | `127.0.0.1:5432/bagcollect` | `127.0.0.1:6379` | Docker 命名卷持久化 |
| 自动化测试 | `127.0.0.1:5433/bagcollect_test` | `127.0.0.1:6380` | 容器临时文件系统，可独立重建 |

测试脚本不得连接开发库。生产部署继续使用 `infra/docker-compose.yml`，不能复用本地固定密码。

本地开发默认使用 `STORAGE_DRIVER=local`，图片写入仓库忽略目录 `data/local-storage`，不需要腾讯云密钥。生产环境被强制要求使用 `STORAGE_DRIVER=cos`。

## 启动与验证

```bash
pnpm infra:local:up
pnpm db:local:deploy
pnpm db:test:deploy
pnpm test:integration:local
pnpm dev:rembg
pnpm warmup:rembg
pnpm dev:api
pnpm dev:worker
pnpm build:miniapp:local
pnpm infra:local:status
```

Docker Desktop 退出后容器会停止；再次执行 `pnpm infra:local:up` 即可。开发库保留数据，测试库随测试容器重建而清空。

微信开发者工具导入 `apps/miniapp/dist/build/mp-weixin`。本地图片链路可用任意测试图片验证：

```bash
pnpm test:image-flow:local -- /absolute/path/to/image.png
```

本地模式会完成上传、标准化、裁剪、BiRefNet 抠图、展示图和缩略图处理。`STORAGE_DRIVER=local` 只决定文件存储位置，不再改变抠图行为；`MATTING_DRIVER=rembg` 才表示使用真实自托管抠图。`passthrough` 只允许开发或测试使用，并会进入可恢复的失败状态，不能冒充成功抠图。

## 数据模型约束

- 微信身份与刷新会话保存在 `User`、`Session`。
- 展示架和收藏品都带 `userId`，数据库组合外键保证收藏品不能引用其他用户的展示架。
- 标签按用户隔离，唯一键为 `(userId, normalized)`，不同用户可以独立保留标签显示形式。
- 图片资产按 `(collectibleId, kind, version)` 唯一；预留上传只记录声明大小，完成 COS 校验后才计入 `storageUsedBytes`。
- 图片资产、处理任务与收藏品使用组合外键，数据库层拒绝跨用户归属。
- 上传完成通过状态条件更新和数据库原子配额更新，重复完成请求不会重复累计容量。
- Worker 派生资产在可串行化事务中计算容量差额，队列重投不会重复累计容量。

## 测试覆盖重点

本地 API 集成测试覆盖：

- 微信模拟登录、刷新令牌轮换与退出。
- 两个用户之间的接口和数据库租户隔离。
- 用户级标签隔离。
- 删除尚未完成的上传预留时，存储计数保持不变。
- 展示架和收藏品基础创建流程。

本地集成测试还覆盖真实 multipart 图片上传和派生资产并发幂等计费。COS STS 与腾讯云侧对象存储仍需要腾讯云测试配置后单独验收；抠图模型本身由本机 rembg 链路验收。
