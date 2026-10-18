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

## 九、CDN 直连（ASSET_URL_MODE=public，2026-10-03）

### 为什么要切

默认 `proxy` 模式下图片 URL 是 `API_PUBLIC_URL/api/assets/file?token=...`：每张图都要
API 服务器向 COS 拉流再转发（多一跳）；小程序端 `needsDownload()` 发现是明文 http 就只能
走 `uni.downloadFile` 限流队列（services/images.ts），真机实测整页出图 9s。
`public` 模式返回 `https://<COS/CDN 域名>/<key>` 直链：`<image>` 由渲染层并发加载、
URL 永不变化（key 自带 `v{n}` 版本号）可长期命中缓存，下载队列彻底不进图片。

### 代码侧（已完成）

- `apps/api/src/common/env.ts`：新增 `ASSET_URL_MODE`（`proxy` | `public`，默认 `proxy`，不改配置行为不变）。
- `apps/api/src/assets/cos.service.ts`：`signedUrl()` 在 public 模式返回
  `publicObjectUrl(key)`（`COS_PUBLIC_HOST` 优先，留空用桶默认域名）；API 侧与 worker 侧的
  `putObject` 均带上 `Cache-Control: public, max-age=31536000, immutable`。
- 小程序端无需改：`needsDownload()` 对 https 直链自动返回 false。

### 控制台操作单（切 public 前按序做完）

1. **桶改公有读**：COS 控制台 → 存储桶 → 权限管理 → 公有读私有写。
   key 含 userId / cuid 且桶禁止列举（默认即禁止），拿不到 key 无法遍历，泄露面可控。
   不接受公有读就别切（public 模式无签名 URL，私有桶会全部 403）。
2. **选图片域名**：
   - 图省事：不配 `COS_PUBLIC_HOST`，直接用桶默认域名
     `https://<bucket-appid>.cos.<region>.myqcloud.com`（自带 HTTPS，无需备案）；
   - 要加速：已备案域名在 COS 控制台 → 域名与传输管理 → 添加自定义 CDN 加速域名，
     配 HTTPS 证书（免费证书即可），DNS 按提示 CNAME 到腾讯云 CDN，然后
     `COS_PUBLIC_HOST=https://<cdn 域名>`。CDN 缓存配置遵循源站 Cache-Control 即可。
3. **小程序后台**（mp.weixin.qq.com → 开发管理 → 开发设置 → 服务器域名）：
   `downloadFile 合法域名` 加上图片域名（裁剪页 canvas 2d 加载网络图受此白名单限制）。
   `<image>` 组件本身不受白名单校验，但真机要求 https —— 两种域名方案都满足。
4. **生产配置**：`infra/.env.deploy` 里 `ASSET_URL_MODE=public`（+ 可选 `COS_PUBLIC_HOST`），
   重跑 `infra/deploy.sh`。
5. **验证**：
   - `curl -I https://<图片域名>/users/<userId>/collectibles/<id>/thumbnail/v1.webp`
     → 200、`cache-control: public, max-age=31536000, immutable`；
   - 小程序真机进「我的」页，Network 里图片请求应直连 COS/CDN 域名而非 `/api/assets/file`。

### 注意事项

- **存量对象**没有 Cache-Control 元数据（上传时才写入）。桶默认域名会按元数据回 200 无缓存头；
  CDN 方案可在 CDN 上配「忽略源站、按后缀缓存」（.webp/.png/.jpg 30 天）。要给存量补元数据
  需按对象 copy-in-place（`x-cos-metadata-directive: Replaced`），量大时用 COS 批量处理。
- **万象抠图不受影响**：worker 的签名 URL（`object-store.getSignedObjectUrl`）走 COS 私有
  接口签名，与对外的 public URL 无关，桶公有读不影响其可用性。
- **回滚**：`ASSET_URL_MODE` 改回 `proxy` 重部署即可，代理链路原样保留。

## 十、白边开关与「无白边版」（2026-10-18）

给透明抠图加的白描边（贴纸效果，见 `docs/CHANGES-2026-10-17.md`）做成**用户可切换**：
设置页一个开关，开 = 有白边，关 = 无白边。开关存服务端（换设备一致）。

### 核心机制：白边只在最后一层画上去

```
ORIGINAL → STANDARD → CROPPED → CUTOUT(透明 PNG，无白边) → [加白边] → DISPLAY / THUMBNAIL
                                                              ↑
                                                    白边只在这一步画上去
```

- `CUTOUT`（抠图结果）本身**没有白边**，是干净的透明 PNG，一直保留。
- 白边是在从 `CUTOUT` 派生展示图/缩略图时才 `addWhiteStroke` 上去的，所以源图没被污染、随时能补无白边版。

### 两套资产

| 资产 | 含义 |
|---|---|
| `DISPLAY` / `THUMBNAIL` | 有白边版（原字段，向后兼容） |
| `DISPLAY_PLAIN` / `THUMBNAIL_PLAIN` | 无白边版，尺寸/裁剪与有白边版**完全一致**，只是跳过 `addWhiteStroke` |

`AssetKind` 枚举新增 `DISPLAY_PLAIN`、`THUMBNAIL_PLAIN`（`20261018010000_white_stroke_toggle` 迁移）。

### 什么时候有两套、什么时候只有一套

**不是所有图都有两套 URL。只有「实际加了白边」的透明口径才派生无白边版：**

- **抠过图的照片**（用户 `/matte`、官方开了抠图）→ 有白边 + 无白边两套 ✅
- **保留透明度的标准 PNG**（官方直接上传透明素材）→ 有白边 + 无白边两套 ✅
- **白底实拍 JPEG**（只裁剪、没抠图）→ 本来就不加白边，只有一套（开关切了图不变）✅

worker 在 `writeRenditions()` / `writeOfficialRenditions()` 里判断 `hasStroke`（描边参数 `ratio>0` 且透明口径），
为 true 才额外编码一份无白边版；为 false 则不产，省存储。

### 用户偏好存哪

- `User.whiteStrokeEnabled Boolean @default(false)`（默认关 = 默认不显示白边）。
- `GET /account` 返回该字段；`PUT /account`（body `{ whiteStrokeEnabled: boolean }`）更新。
- 用 `PUT` 不用 `PATCH`：微信小程序 `wx.request` 的 method 白名单不含 `PATCH`。

### 默认关 = 默认展示无白边版

开关默认**关**（`@default(false)`，且小程序端偏好未加载/加载失败时也回退 `false`）。
此时 `applyStrokePreference()` 会把 `*Plain` 字段覆盖到主字段：

- 抠图/透明图：展示无白边版（`DISPLAY_PLAIN` / `THUMBNAIL_PLAIN`）；
- 白底实拍图：没有 `*Plain` 字段，覆盖逻辑不生效，仍展示原图（本来就没白边）。

用户主动打开开关后，`applyStrokePreference()` 原样返回数据，展示有白边版（`DISPLAY` / `THUMBNAIL`）。

### API 返回两套 URL（前端按偏好覆盖）

后端**同时返回两套**，字段名：

- 有白边：`thumbnailUrl` / `displayImageUrl` / `backThumbnailUrl`
- 无白边：`thumbnailUrlPlain` / `displayImageUrlPlain` / `backThumbnailUrlPlain`

小程序 `services/stroke-preference.ts` 的 `applyStrokePreference()` 在**数据层**按开关把无白边值
覆盖到主字段（`displayImageUrl` 等），下游所有展示页面读的还是原字段、**零改动**。
切换开关后偏好版本号 `strokeRevision()` +1，纳入图片缓存 key，让旧缓存失效、重新下载无白边版。

### 无白边版写入失败的降级（重要）

无白边版是「可选增强产物」：主图 `DISPLAY`/`THUMBNAIL` 写成功后，无白边版写库失败
（最常见是用户存储配额不足——`upsertAssetRecord` 有硬配额检查）**不会让整张图失败**，
worker 吞掉异常、只打日志，前端拿不到 plain 字段自动回退到有白边版。

### 存量回填

上线前已存在的透明资产还没有无白边版，跑 `scripts/backfill-stroke-plain.mjs`
（与 `backfill-stroke.mjs` 的区别：后者是**覆盖**有白边版、前者是**新增**无白边版）：
默认 dry-run，`--execute` 才写，幂等可重跑，输出 CDN 刷新清单。

