# 图片处理流水线 · 状态机与接口语义（2026-09-30）

> 面向后端同事的接手说明：裁剪与抠图是**两条独立流水线**，端点、任务类型、进行中状态一一对应，请勿再合并回一个端点。

## 一、状态机

```
UPLOADING → NORMALIZING → AWAITING_CROP ─┬─ POST /crop   → CROPPING → READY
                                         └─ POST /matte  → MATTING  → READY
READY / FAILED ─（可再次发起 /crop 或 /matte，processingVersion +1）
任一步失败 → FAILED（processingError 带原因）
```

| ProcessingStatus | 含义 | 由谁置入 |
|---|---|---|
| `UPLOADING` | 原图上传中 | 创建收藏 |
| `NORMALIZING` | 标准化任务进行中 | `POST /uploads/complete`（JobType.NORMALIZE） |
| `AWAITING_CROP` | 标准图就绪，等用户操作 | worker `normalizeImage` 完成 |
| `CROPPING` | **裁剪**任务进行中 | `POST /collectibles/:id/crop`（JobType.CROP） |
| `MATTING` | **抠图**任务进行中 | `POST /collectibles/:id/matte`（JobType.MATTING） |
| `READY` | 完成，可陈列 | worker `cropImage` / `matImage` 完成 |
| `FAILED` | 失败（带 `processingError`） | worker `failProcessing` |

## 二、两个端点的语义

### `POST /collectibles/:id/crop` —— 裁剪（可能顺带重抠）
- 请求体：`{ x, y, width, height, rotation, brightness?, contrast?, saturation? }`（`cropSchema`，全量必填）
- 行为：按参数 旋转 → 裁剪 → 调色，产出 **CROPPED / DISPLAY / THUMBNAIL**
  - **常规（该图无 CUTOUT）**：不调万象、不产 CUTOUT
  - **已抠图再裁（该图已有可用 CUTOUT）**：置 `rematte` 标志，worker 走 `cropImage` 的 rematte 分支，**重新调万象抠图**并重写 CUTOUT，
    否则新展示图与旧透明图会在构图上失配。这是「抠图后也能裁剪」的实现，前端无需改端点
- 状态：`CROPPING` → `READY`；**不计入抠图配额**（同一张图只计一次万象扣费，见成本闸门）
- 参数全量必填：worker 只读 Collectible 上保存的 `cropX/cropY/...`，请求体即唯一来源，缺字段会 `throw`

### `POST /collectibles/:id/matte` —— 只抠图
- 请求体：`matteSchema`，**全部字段可省**：
  - 省略 → 沿用上次保存的裁剪参数；从来没有裁剪记录 → 全幅
  - 也可只覆盖部分字段（例如只改 rotation 再抠一次）
- 行为：裁剪（同上）+ 万象抠图，额外产出 **CUTOUT**，展示图/缩略图由抠图结果（trim 透明边）派生
- 状态：`MATTING` → `READY`；**计入每日抠图配额**（`dailyMattingQuota`，按 JobType.MATTING 当日计数，且仅成功/进行中计入，见成本闸门）

### 通用规则
- 入口校验：仅 `AWAITING_CROP / READY / FAILED` 可发起；处理中（UPLOADING/NORMALIZING/CROPPING/MATTING）返回 `CONFLICT`
- 重跑（READY/FAILED 之后）**递增 `processingVersion`**：产物写到新版本目录（`.../display/v2.png`），
  避免同名对象被覆盖、签名 URL 不变导致前端读到旧图
- 幂等键：`crop:{id}:v{version}` / `matting:{id}:v{version}`

### 成本闸门（Important）
抠图走万象、**按次计费**，因此：

| 规则 | 实现 |
|---|---|
| **每张图只允许成功抠一次（via `/matte`）** | 状态为 `READY` 且已存在可用 `CUTOUT` 资产 → `/matte` 直接 `CONFLICT`「每张图片仅支持抠图一次」，不再扣费。这是防呆：**重新抠图请走 `/crop`（rematte）**，不要走 `/matte` |
| **已抠图仍可再裁剪（rematte）** | 已存在 CUTOUT 时调 `/crop` **不拦截**，`enqueueCrop` 检测 `hasCutout()` 置 `rematte`，worker 重新抠图并重写 CUTOUT，保持透明图与新展示图对齐。**不消耗每日配额**（同一张图只计一次万象扣费，配额在 `/matte` 入口计） |
| 配额只计成功 + 进行中 | 当日 `MATTING` 任务仅 `QUEUED / RUNNING / SUCCEEDED` 计入 `dailyMattingQuota`，**`FAILED` 不计入** —— 否则一次万象抖动就吃掉当日名额、还挡住重试 |
| 允许失败重试 | `FAILED` 状态不查 CUTOUT，可重新提交（一次网络抖动不至于废掉整张图）；重试走原端点即可 |

判据用「CUTOUT 资产是否存在」而非 `processingStatus`（状态会被后续裁剪改写）。前端据此隐藏编辑页「自动抠图」按钮，
但「裁剪与旋转」始终在空闲态显示（含已抠图之后）；抠图前弹二次确认。

## 三、前端的两条路径（避免多跑一次处理页）

| 用户在哪儿操作 | 调用 | 体验 |
|---|---|---|
| 编辑页「自动抠图」（先弹确认） | `/matte`（不带参 → 全幅或沿用已存裁剪参数） | 一次处理页 → 回编辑页，按钮收起 |
| 编辑页「裁剪与旋转」→ 裁剪页提交 | 未勾「同时自动抠图」→ `/crop` | 只裁剪，回编辑页后仍可点「自动抠图」 |
| 裁剪页勾了「同时自动抠图」 | `/matte` + 本次裁剪参数 | **裁剪与抠图一次跑完**，只等一次处理页，回编辑页时按钮已收起（省一次往返、不多花钱） |

抠图任务本身包含裁剪，所以「裁剪 + 抠图」不需要先 `/crop` 再 `/matte`。

## 四、前端如何判断「是否已抠图 / 能否裁剪」

**不要用 `processingStatus` 判断**（裁剪后也是 READY）。详情 DTO 暴露了 `cutoutImageUrl`
（CUTOUT 资产的签名 URL，来自 `urlsByKind`）：

- `cutoutImageUrl` 存在 → 已抠图，编辑页隐藏「自动抠图」按钮，但**仍显示「裁剪与旋转」**（点了会 rematte）
- 不存在 → 未抠图，「自动抠图」按钮显示（含「只裁剪」之后）

按钮显示判据（均为"空闲态" `AWAITING_CROP / READY / FAILED`）：
- `canMatte = !cutoutImageUrl && idle`
- `canCrop = idle`（始终允许，含已抠图之后 —— rematte 由 worker 兜住对齐）

裁剪参数也会回传（DTO 的 `crop` 字段），前端「自动抠图」调 `/matte` 时可不带参数；处理页「重试」也复用 `crop` 字段。

## 五、迁移

`apps/api/prisma/migrations/20260930010000_split_crop_and_matting/migration.sql`：
给 `ProcessingStatus` 加 `CROPPING`、给 `JobType` 加 `CROP`（均为追加枚举值，无数据改写）。
改了 schema 记得 `pnpm --filter @bagcollect/api exec prisma generate`。

## 六、Mock 对应行为（apps/miniapp/src/services/mock-data.ts）

- `POST /collectibles/:id/crop` → 记录裁剪参数、置 `READY`；常规**不写** `cutoutImageUrl`，但若该图已有 `cutoutImageUrl` 则**刷新**它（对齐真实 worker 的 `rematte` 分支），不再报错
- `POST /collectibles/:id/matte` → 写 `cutoutImageUrl`（用展示图兜底）、置 `READY`；参数缺省沿用已存裁剪参数；已抠图则报错
- 种子数据均带 `cutoutImageUrl`（视为已完成的收藏）

## 七、本地端到端验证

`node scripts/test-local-image-flow.mjs`：上传 → 标准化 → `/crop`（只裁剪）→ `/matte`（抠图）→
校验展示图含透明通道。需要本地 API + worker + Redis + COS 环境，见 `docs/DATABASE_LOCAL.md`。

## 八、接手前必读（踩坑清单）

1. **别再把裁剪和抠图合并回一个端点。** 两者任务类型（`CROP`/`MATTING`）、进行中状态（`CROPPING`/`MATTING`）、SLA 都不同；合并会让前端"只裁剪 vs 裁剪+抠图"二选一无法表达。
2. **重新抠图走 `/crop`，不是 `/matte`。** 已存在 CUTOUT 时 `/matte` 会 `CONFLICT`；要改构图请调 `/crop`，`rematte` 标志会让 worker 重新抠图并重写 CUTOUT。
3. **判据用 CUTOUT 资产，不用 `processingStatus`。** 裁剪之后状态是 `READY`，和"已抠图"同状态；用 `processingStatus` 判断"能不能抠"会导致按钮永久消失（这是最早的一个线上 Bug）。
4. **`version +1` 是必须的。** 重跑（READY/FAILED 后）必须把 `processingVersion` 递增，否则新资产覆盖旧对象、签名 URL 不变，前端读到旧图。
5. **配额只数成功 + 进行中，失败不数。** 否则万象抖动会吃掉当日名额并挡住重试。
6. **`/crop` 请求体参数全量必填。** worker 只读 `cropX/cropY/...`，请求体是唯一来源；`/matte` 才允许缺省（沿用已存参数或全幅）。
7. **处理页失败别只给"删除"。** 前端 `processing` 页失败态已有"重试 / 返回编辑 / 删除"三出口；后端若改失败文案，注意 `processingError` 字段会直接透给前端展示。
