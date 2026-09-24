# BagCollect 腾讯云数据万象抠图实施方案

> 状态（2026-09-22 更新）：生产抠图使用腾讯云数据万象，**接口已从「商品抠图 GoodsMatting」切换为「通用抠图 AIPicMatting」**（0.02 元/次），代码、配置、部署与 CI 均已落地。
> **COS 桶、数据万象服务开通、CAM 权限三项已全部打通并完成真实样本验收**（链路 1:1 返回已确认，`1280x1707`，约 1.3–1.7s/张），详见第 7.1 节；两个接口的 A/B 实测见 7.2 节。
> 仍需完成：用**真实包袋商品图**（不是生活化照片，见 7.2）复核切换后的效果、更新微信小程序隐私声明、回填存量用户的每日配额（见第 2 节末）。这些是灰度前的前置条件，见第 10 节。

## 1. 决策摘要

原实现是自托管 rembg + BiRefNet（见 [开源抠图实施方案](OPEN_SOURCE_MATTING.md)，已不在主链路中使用，文件保留未删除）。现在改为调用腾讯云数据万象的云端抠图接口。

发生的变化：

| 维度 | 原方案（rembg / BiRefNet） | 现方案（数据万象） |
|---|---|---|
| 推理位置 | 自有服务器，Docker 内网常驻服务 | 腾讯云端 |
| 图片是否出网 | 否 | **是**，裁剪图会传给腾讯云 |
| 计费 | 自备算力，固定成本 | 按次计费：抠图 0.02 元/次（通用抠图）；请求流量只在 Worker 与桶不同地域时产生 |
| 需要维护 | Python 镜像、模型卷、推理服务健康检查 | 无，只需密钥与签名 URL |
| 输入分辨率 | 固定 1024 降采样，掩码再放大 | 原图分辨率 |
| 依赖 | onnxruntime 线程数、内存、CPU | COS、万象服务、网络 |
| 失败可降级 | 是（本机） | 否（远端，依赖网络与配额） |

成本口径（资源包买不买的判断见 [腾讯云凭据获取教程](TENCENT_CLOUD_SETUP.md) 第 8 节）：

计费公式只有一项变量：

```text
月费用 = 万象实际受理的抠图次数 × 0.02 元（通用抠图单价） + 流量费（当前为 0）
```

- **抠图处理费 0.02 元/次**，重试同样计费。
- **只按次数计，与图片无关**：分辨率、耗时、输出体积都不影响单价，同一接口下 800px 与 2048px 同价。
- **一次收藏 = 1 次调用**（当前链路）；点了「重新抠图」再算 1 次。
- **免费额度要按接口区分**：官方免费额度清单里只有「**商品抠图** 1000 次（2 个月有效，一次性发放）」，**通用抠图不在清单内**。所以切到通用抠图后是纯按量付费，没有免费次数兜底。（本文件早先写「抠图处理费无免费额度」，对商品抠图并不准确。）
- **重试会成倍计费**：`CI_MATTING_RETRY=1` 表示失败后最多再请求 1 次，即单张最坏 0.04 元。只有超时 / 5xx / 429 / 网络中断才重试，4xx 与「返回内容非法、缺透明通道」不重试，所以确定性错误不会反复计费。若线上失败率约 5%，实际成本约比理论值高 5%。
- **请求流量费**：抠图请求是「带 `ci-process` 参数访问 COS 域名」，这类访问产生的流量计为**万象外网出流量**（广州 0.6 元/GB）。但腾讯云**同地域产品之间自动走内网、不产生流量费**，所以只要把 Worker 部署在与桶相同的地域，这一项就是 0。这是唯一能省的一项——处理费按次收取，与部署位置无关。**反过来，把 Worker 换到别的地域会让每 GB 多花 0.6 元。**
- **C 端流量另算**：小程序拉展示图/缩略图不带万象处理参数，属于 COS 外网下行流量，不能用万象流量包抵扣。
- **结算方式**：后付费、按月结算，次月 3–7 日出账单；抵扣顺序为 免费额度 > 资源包 > 按量计费。通用抠图是**无阶梯的统一定价**，不存在「用量越大单价越低」。

按调用量线性估算（不含重试）：

| 月抠图调用次数 | 通用抠图 0.02 元/次 | 商品抠图 0.01 元/次（切换前） |
|---|---|---|
| 1,000 | 20 元 | 10 元 |
| 10,000 | 200 元 | 100 元 |
| 100,000 | 2,000 元 | 1,000 元 |
| 1,000,000 | 20,000 元 | 10,000 元 |

**换接口的直接代价就是这张表整体翻倍。** 真实账单可在控制台的用量明细里按计费项核对，建议同时配置万象用量告警。

代码层面，主链路只引用万象实现：`processor.ts` 不再 import `matting.ts`，配置里没有 provider 开关，也没有任何 `REMBG_*` 变量，因此主链路上不存在可切回的兜底分支。旧的 rembg 实现及其脚本、容器定义保留未删除，但主链路不会调用它，说明见 `apps/worker/src/matting.ts` 顶部注释。

## 2. 选哪个万象接口

数据万象的「智能抠图」下有三个接口，请求方式一致，只有主体识别策略和单价不同：

| 接口 | 参数值 | 单价 | 适用 |
|---|---|---|---|
| 通用抠图 | `AIPicMatting` | 0.02 元/次 | **当前选择**。检测「画面中的主体」，对杂乱背景宽容得多；代价是单价翻倍，且会**侵蚀细结构**（细绳、细带）。两个样本的对比见 7.2 |
| 商品抠图 | `GoodsMatting` | 0.01 元/次 | 备用。检测「商品」主体，期待影棚白底的商品广告图；背景干净时细结构保留更完整，且单价便宜一半 |
| 人像抠图 | — | 0.02 元/次 | 不适用，收藏品里没有人像 |

接口名由 `CI_MATTING_PROCESS` 配置，**切换不需要改代码**。两个接口的胜负取决于**照片背景**，不是取决于拍的是什么物品 —— 实测数据见 7.2。

**为什么最终选通用抠图（2026-09-22 决定）**：真实输入是用户随手拍、再手工裁剪的照片，背景是桌面、床铺、地板，不是影棚白底。7.2 的样本 A 显示 `GoodsMatting` 面对这类照片会把**整块前景当成一个商品**返回（主体占比 0.8387，几乎原样返回），`AIPicMatting` 则只保留主体（0.3672）——这是量级差异。样本 B 说明商品抠图在「背景干净但有细结构」时更优，但按真实用户分布，**杂乱背景是常态、影棚级照片是例外**，所以宁可承受单价翻倍与细结构被侵蚀的风险。若后续真实样本显示细结构侵蚀明显（细带给包、丝巾提手一类），需要重新评估。

换接口必须同步改的两处：CAM 策略里的 `ci` action（见第 3 节）与 `MAX_DAILY_MATTING` 配额（见本节末）。

> **一个曾经的错误推理，记下来避免重犯**：本文件早期按「纸袋、书、唱片都属**物品类**，字面最匹配 `GoodsMatting`」来选型。这个推理只看了「主体是什么」，没看「背景长什么样」。`GoodsMatting` 期待的是**影棚白底的商品广告图**，而真实输入是用户随手拍、手工裁剪的照片（背景是桌面、床铺、地板），两者的差距是决定性的。

按当前 `MAX_DAILY_MATTING`（每用户每天 25 次）× 0.02 元估算，单用户跑满一天最多花费 **0.50 元**，与切换前（50 次 × 0.01 元）持平——**单价翻倍，所以配额减半，成本天花板保持不变**。若配额不动，天花板会直接变成 1.00 元/人/天、约 30 元/人/月（重试最坏再翻一倍）。

> **改这个默认值不会影响已注册用户。** 配额是**建档快照**：`dailyMattingQuota` 只在首次登录时按 `MAX_DAILY_MATTING` 写入 `User` 行，之后校验读的是行上的值（见 `apps/api/src/collectibles/collectibles.service.ts`）。存量用户仍是 50，需要单独回填：
>
> ```sql
> -- 先确认没有人工调过的特殊值
> SELECT "dailyMattingQuota", count(*) FROM "User" GROUP BY 1;
> -- 再回填
> UPDATE "User" SET "dailyMattingQuota" = 25 WHERE "dailyMattingQuota" > 25;
> ```

## 3. 前置条件

> **桶名、地域与 CAM 密钥怎么拿到手，见 [腾讯云凭据获取教程](TENCENT_CLOUD_SETUP.md)** —— 那份文档按控制台顺序写全了从注册实名到验证通过的每一步，包括可直接粘贴的权限策略 JSON 和报错对照表。本节只列条件本身。

1. **COS 桶已绑定数据万象并开通服务。** 万象只能处理已绑定桶里的对象，或公网可访问的 `detect-url`。未开通时接口通常不返回 4xx，而是返回 `200` + XML 错误体，本实现会把它识别成失败并带上错误码，不会静默产出错图。
2. **CAM 权限。** 本方案使用「下载时处理」，密钥需要：
   - `cos:GetObject`（源对象）
   - `ci:CreateS3AIPicMattingJob`（万象**通用抠图**任务，注意名字里有 `S3`）
   
   **每个抠图接口对应各自的 `ci` action，互不通用。** 只授权了商品抠图就把 `CI_MATTING_PROCESS` 改成 `AIPicMatting`，会直接收到 403 `AccessDenied`——和「桶名写错」报的是同一个错，容易误判。当前策略 `docs/cam-policy-cos-ci.json` 两条 action 都保留，是为了支持 A/B 对比和随时切回。
   
   完整权限清单见教程第 6 节。注意：API 侧签发小程序直传临时密钥**不需要**额外 action —— `GetFederationToken` 只验签名不鉴权，写 `sts:GetFederationToken` 反而会被策略分析器判为无效。
   建议沿用现有的 Worker 子账号密钥，只补上这两个 action，不要使用主账号永久密钥。
3. **地域限制。** 数据万象的图片处理能力**仅支持公有云地域**，`COS_REGION` 必须是公有云地域（当前为 `ap-guangzhou`），且该桶不能是多 AZ 存储桶。
4. **存储驱动必须是 `cos`，且 `COS_SECRET_ID`/`COS_SECRET_KEY`/`COS_BUCKET`/`COS_REGION` 必填。** 万象读不到本地磁盘文件，裁剪图必须先在 COS 上存在。配置校验会在启动阶段直接拦下 `STORAGE_DRIVER=local`，而不是等第一张图处理失败。

由此产生一个必须知道的副作用：**本地开发不再能离线跑通抠图链路**，必须指向一个真实的 COS 桶。没有腾讯云凭据时图片处理链路（标准化 → 裁剪 → 抠图）在本地跑不通，且没有替代路径。`STORAGE_DRIVER=local` 下 API 仍可正常启动以开发其它功能，但 `pnpm dev:worker` 会被配置校验拦下，这是预期行为。

## 4. 调用方式

万象提供三种触发方式，本方案选择**下载时处理**：

| 方式 | 触发 | 为什么不用 / 用 |
|---|---|---|
| **下载时处理** | `GET /<ObjectKey>?ci-process=AIPicMatting` + 签名 | **采用**。一次请求直接拿到 PNG 响应体，桶保持私有 |
| 上传时处理 | `PUT` + `Pic-Operations` 请求头 | 只作用于刚 PUT 上去的原图，而我们要抠的是用户裁剪之后的图，时机对不上 |
| 云上数据处理 | `POST /<ObjectKey>?image_process` | 会把结果另存成 COS 对象，Worker 还要再下载一次，多一次往返和一个需清理的中间对象，没有收益 |

请求固定带上 `center-layout=0`：让万象保持原画布、只把背景透明化，这样输出才能与裁剪图逐像素对位。默认值虽然是 0，但代码里写死，避免以后被改默认值影响。

实现位于 `apps/worker/src/matting-tencent-ci.ts`，对外只暴露一个函数：

```ts
createTencentCiBackgroundRemover(options, resolveSignedUrl, fetchImpl?)
// 返回 (target: { objectKey, width, height }) => Promise<Buffer>
```

签名 URL 由 `apps/worker/src/object-store.ts` 的 `getSignedObjectUrl(key, { query, expiresSeconds })` 生成，走 COS SDK 的 `getObjectUrl`，把 `ci-process` 一起签进签名。

## 5. 处理流程

```text
用户确认裁剪
  -> API 入队 matting 任务
  -> Worker 用 Sharp 生成裁剪 JPEG（rect 尺寸）
  -> 写入 COS：cropped/v{n}.jpg
  -> 等裁剪图写入成功（万象要从 COS 读它，早发请求会 404）
  -> 生成带 ci-process=AIPicMatting 的私有读签名 URL
  -> GET 拉取 —— 万象在这一步完成抠图，响应体即透明 PNG
  -> 校验：HTTP 2xx、Content-Type 为图片、
          PNG 可解码、尺寸与裁剪图一致、带 alpha、有透明区且主体可见
  -> 存为 CUTOUT PNG（沿用裁剪图原始尺寸）
  -> 生成 DISPLAY 2048px PNG 与 THUMBNAIL 512px WebP
  -> 收藏状态改为 READY
```

相比原先的自托管推理，**不需要「降采样送推理，再把掩码放大回裁剪图尺寸」两步**。万象按原图分辨率抠图，没有模型输入边长限制，代码与配置里也不再有降采样上限这个开关。少一次重采样也意味着边缘质量理论上更好，但需要真实样本确认。

任何一步失败都会立即把任务与收藏标记为 `FAILED`，不会生成展示图或缩略图，也不允许裁剪图冒充成功结果。

## 6. 配置

新增配置项（`apps/worker/src/config.ts`）：

| 变量 | 默认值 | 说明 |
|---|---|---|
| `CI_MATTING_PROCESS` | `AIPicMatting` | 万象抠图接口名，可改为 `GoodsMatting`（商品抠图，0.01 元/次）。切换不需要改代码，但要确认 CAM 里有对应的 `ci` action |
| `CI_MATTING_TIMEOUT_MS` | `60000` | 单次请求超时 |
| `CI_MATTING_MAX_RESPONSE_BYTES` | `83886080` | 响应体上限，防御异常服务耗尽 Worker 内存 |
| `CI_MATTING_MAX_CONCURRENCY` | `4` | 并发上限。远端接口不是本机进程，可以比本机推理服务放开 |
| `CI_MATTING_SIGN_EXPIRES_SECONDS` | `600` | 签名有效期 |
| `CI_MATTING_RETRY` | `1` | 可重试失败的额外尝试次数。**每次重试都会重新计费**，不要调大 |
| `CI_MATTING_SIZE_MODE` | `rescale` | 画布尺寸不一致时的策略，见第 7 节 |

生产 Compose 已经在 `worker` 服务里注入这些变量，日常不需要改 `infra/.env.deploy`。只有在需要覆盖时，把对应变量写进 `infra/.env.deploy`（该文件禁止提交）。

需要在 `infra/.env.deploy` 里确认存在的（原本就有，无需新增）：

```env
COS_SECRET_ID=...
COS_SECRET_KEY=...
COS_BUCKET=bagcollect-1250000000
COS_REGION=ap-guangzhou
```

## 7. 一个必须先验证的技术假设

万象在 `center-layout=0` 下应当**原画布尺寸返回**，这是本实现尺寸校验的前提。这一点无法在本地推导，必须在真实桶上用真实样本确认，因此提供了 `CI_MATTING_SIZE_MODE` 作为安全阀：

- `strict`：尺寸与裁剪图不一致直接判失败，用于确认接口行为。
- `rescale`（默认）：宽高比一致时把结果缩放回裁剪图尺寸，并打出 `matting_tencent_ci_rescaled` 警告日志；**宽高比不一致仍然判失败**，因为那必然意味着主体位置发生偏移，缩放只会产出错图。

### 7.1 验收结论：已确认 1:1 返回（2026-09-22）

首次真实样本验收通过，实测数据：

| 项 | 值 |
|---|---|
| 结果 | `1/1` 通过 |
| 输入裁剪图尺寸 | `1280x1707` |
| 万象返回尺寸 | `1280x1707`（**完全一致**） |
| 单张耗时 | `1676ms` |
| 主体像素占比 | `0.8387` |
| 费用 | 0.01 元（商品抠图 1 次） |

**结论：`center-layout=0` 确实按原画布 1:1 返回，尺寸校验的前提成立。**

**最终取值：保留默认的 `rescale`，不改成 `strict`。** 理由是 `strict` 只增加失败模式、不增加安全性：

- 输出 1:1 时，`rescale` 是**空操作**，两者行为完全相同；
- 万一万象将来改成返回 2 倍超采样画布，`rescale` 会缩放回去并正常出图，而 `strict` 会**直接判失败**；
- `rescale` 也**不存在静默产出错图的风险** —— 宽高比一旦不一致它同样判失败，这正是主体错位的特征。

也就是说 `rescale` 严格优于 `strict`。把 `strict` 留给「接口行为变了、需要立刻发现」的场景（例如换 `CI_MATTING_PROCESS` 后重新探测）。

验收脚本：

```bash
pnpm ci:verify-matting -- /absolute/path/a.jpg /absolute/path/b.jpg
```

它会按真实链路量级（最长边 2048）逐张上传、调用万象、校验尺寸与 alpha 分布，把结果 PNG 写到 `data/ci-matting-verify/<时间戳>/`，结束前清理 COS 上的临时对象，并打印单张耗时、主体像素占比和费用估算。

- 如果全部通过且尺寸一致：保持 `rescale`（推荐）或改成 `strict` 都可以。
- 如果出现尺寸不一致：日志会直接显示实际尺寸，据实决定。若宽高比也不一致，说明接口行为与预期不同，此时不要上线，需要先查明原因。

### 7.2 A/B 实测：两个接口各有胜负，选型取决于照片类型（2026-09-22）

用同一张图分别跑两个接口，共两个样本。

**样本 A：`testIMG.jpg` —— 生活化照片（手拿金色饮料杯，背景有豹纹包、毛巾、地板）**

| 项 | `GoodsMatting` | `AIPicMatting` |
|---|---|---|
| 主体像素占比 | `0.8387` | **`0.3672`** |
| 单张耗时 | 1676ms | 1601ms |
| 返回尺寸 | `1280x1707`（与输入一致） | `1280x1707`（与输入一致） |
| 实际效果 | 几乎保留整幅画面，只削掉四角 | 主体（手 + 杯子）完整抠出，背景全去 |

→ **`AIPicMatting` 大幅胜出，是量级差异。** `GoodsMatting` 期待「整张图即一张商品广告」，面对「手 + 杯 + 背景杂物」的多主体生活照，它把整块前景当成一个商品处理了。

**样本 B：`lelecha-bag.jpg` —— 真实包袋照片（纸袋放在木地板上，红色绳提手，旁边 3 张车贴）**

| 项 | `GoodsMatting` | `AIPicMatting` |
|---|---|---|
| 主体像素占比 | `0.1816` | `0.1714` |
| **完全不透明**（主体实面积） | `17.43%` | `16.93%` |
| **半透明**（边缘过渡带） | `1.04%`（占主体 5.6%） | `0.42%`（占主体 2.4%） |
| 单张耗时 | 1275ms | 1309ms |
| 单价 | 0.01 元 | 0.02 元 |
| 效果 | 木地板完全去除 | 木地板完全去除 |

→ **两者都干净去掉了背景，主体实面积几乎相同（差 0.5%）。真正的差异在边缘。**

`GoodsMatting` 的半透明像素是 `AIPicMatting` 的 **2.5 倍**。只看这个数字会以为它「糊」，但放大到白底上看正好相反：

- **`AIPicMatting` 把红色绳提手侵蚀变细了** —— 绳股出现断续、粗细不均；
- `GoodsMatting` 的提手粗细完整、形状连贯。

也就是说：`GoodsMatting` 多出来的半透明像素是**更柔的边缘过渡**，不是多留了背景；而 `AIPicMatting` 的「锐利」在**细结构上过头成了侵蚀**。细节对比：`detail-lelecha-handle-white.png`、`detail-lelecha-edge-white.png`。

**综合结论（注意：这推翻了本节早先的判断）**

| 照片类型 | 更优 | 量级 |
|---|---|---|
| 背景杂乱、多个显著物体（生活化照片） | **`AIPicMatting`** | 量级差异 |
| 物品为主、背景相对干净，但有细绳/细带等细结构 | `GoodsMatting` | 细结构完整度差异，且单价便宜一半 |

**2026-09-22 的最终取向：切 `AIPicMatting`。** 理由是真实用户拍的是「随手拍 + 手工裁剪」的照片，杂乱背景是常态而不是例外。样本 A 那种量级差距一旦出现，用户看到的就是一张没抠干净的图；而细结构被侵蚀属于「放大才看得出」的次要问题。代价明确且已落地：**单价翻倍（0.02 元/次）、无免费额度、`MAX_DAILY_MATTING` 已同步减半到 25** 以保持单用户成本天花板不变（见第 2 节末）。

**这不等于细结构问题已被判定可忽略** —— 样本 B 毕竟只是一个样本，7.3 节要求的 10 张真实包袋图仍未跑完。跑完后如果细结构侵蚀反复出现（细带给包、丝巾、编织提手一类），应当重新评估，必要时按照片类型分流。

两个样本从不同方向指向同一个结论：**拍照引导比模型选型更影响最终效果。**

另外一个必须知道的行为：`AIPicMatting` 检测的「主体」是**整块显著前景**，它会把**手和杯子一起留下**，不会只留杯子。**它解决「去背景」，不解决「挑对象」。**

复现方式（脚本会按接口自动计费估算）：

```bash
CI_MATTING_PROCESS=AIPicMatting pnpm ci:verify-matting -- <原图路径>
```

对比图生成（`pnpm ci:compare-models -- ...`）：

```bash
node scripts/compare-matting-models.mjs \
  --source data/ci-matting-verify/samples/lelecha-bag.jpg \
  --a data/ci-matting-verify/<商品抠图时间戳>/cutout-01.png --label-a "GoodsMatting 商品抠图" \
  --b data/ci-matting-verify/<通用抠图时间戳>/cutout-01.png --label-b "AIPicMatting 通用抠图"
```

脚本会用与验收脚本完全相同的口径计算主体占比并标在图上，并额外打印 alpha 三档占比（全透明 / 半透明 / 完全不透明）—— **判断边缘质量必须看这三档，只看主体占比会漏掉「细结构被侵蚀」这类问题**。

### 7.3 样本选择的注意点

**链路正确 ≠ 效果达标。** 灰度前应按第 10 节用**至少 10 张真实包袋商品图**（浅色配浅色背景、毛绒、透明、反光、细带、复杂背景各覆盖）重新评估。目前只有 2 张样本（1 张生活化 + 1 张真实包袋），仍不足以定稿。

## 8. 隐私与合规（必改，不是可选项）

原方案的核心卖点是「图片不发送给第三方抠图服务」，**这个属性现在反转了**。裁剪后的收藏品图片会离开自有服务器传给腾讯云。因此上线前必须：

1. **更新微信小程序隐私保护指引**，明确说明图片会用于自动抠图并传输给第三方云服务处理。`docs/WECHAT_NATIVE.md` 第 4 节第 5 条已经提到要说明「云存储、自动抠图」用途，现在需要把「第三方处理」这一层补上。
2. **复核服务类目**是否仍然匹配（工具 / 图片处理）。
3. **复核《用户服务协议》与隐私政策**里是否有「图片仅在本地处理」之类的表述，有则必须删改。
4. 数据万象的费用计费与数据处理条款需要留存一份，作为第三方处理者的依据。

## 9. 可观测性与失败语义

失败分类决定了重试行为，日志是 JSON 行，便于采集：

| 情况 | 处理 | 是否重试 |
|---|---|---|
| 超时、5xx、429、网络中断 | 判失败 | 是，最多 `CI_MATTING_RETRY` 次 |
| 4xx（如 403 未授权、404 对象不存在） | 判失败 | 否。重试只会再付一次费，结果不会变 |
| `200` + XML/JSON 错误体（服务未开通、权限不足） | 判失败，错误信息带上万象返回的 Code/Message | 否 |
| 响应不是有效图片、缺少 alpha、无透明区、无可见主体 | 判失败 | 否 |
| 画布尺寸/宽高比不一致 | 判失败（或 rescale） | 否 |

关键日志事件：

- `matting_tencent_ci_retry`：触发重试，带 attempt 与错误信息。
- `matting_tencent_ci_rescaled`：发生画布缩放（`rescale` 模式下）。
- 原有 `job_completed` / `job_failed` 保持不变。

建议在控制台为万象抠图单独设置用量告警，避免配额被刷导致账单异常。

## 10. 上线与回退

### 上线前

- [x] COS 桶已绑定数据万象并开通抠图服务，地域为公有云地域。（2026-09-22：桶 `bagcollect-1313112155` @ `ap-guangzhou`，万象已随「基础图片处理」自动开通）
- [x] CAM 密钥已补上 `cos:GetObject`、`ci:CreateGoodsMattingJob` 与 `ci:CreateS3AIPicMattingJob`（两条 `ci` action 都留着，支持随时切换与 A/B）。（2026-09-22：策略见 `docs/cam-policy-cos-ci.json`）
      **注意：每个抠图接口对应各自的 `ci` action，互不通用。** 漏掉 `ci:CreateS3AIPicMattingJob` 时通用抠图会直接 403，报错是 `AccessDenied`，与「桶名写错」长得一样。
- [ ] `pnpm ci:verify-matting -- <10 张真实收藏品照片>` 全部通过，覆盖：浅色物体配浅色背景、深色物体配深色背景、毛绒、透明、反光和细带物体、多主体、复杂背景。
      **目前只跑了 1 张 `testIMG.jpg`（链路通过，但那是生活化照片，不能作为效果判据，见 7.2/7.3），这一项仍未完成。**
- [x] `CI_MATTING_SIZE_MODE` 已定稿为 `rescale`。（2026-09-22：1:1 返回已确认，理由见 7.1）
- [x] `CI_MATTING_PROCESS` 已定为 `AIPicMatting`（2026-09-22，理由见第 2 节与 7.2）。配置默认值、`infra/docker-compose.yml`、`.env.example` 与单测已同步。若效果复核不过关，改回 `GoodsMatting` 即可（无需改代码，成本同步减半）。
- [x] `MAX_DAILY_MATTING` 已按「单价翻倍、天花板不变」从 50 降到 25。（2026-09-22）
- [ ] **存量用户的 `dailyMattingQuota` 回填。** 配额是建档快照，改默认值不影响已注册用户，需执行第 2 节末的 `UPDATE`。
- [ ] 隐私保护指引、服务类目、用户协议已按第 8 节更新。
- [ ] 万象用量告警已配置（接口切换后单价翻倍，告警阈值要按 0.02 元/次重算）。
- [ ] 实体 iPhone 与 Android 微信各走通一次上传、裁剪、抠图、归架、重新抠图。

### 上线

部署脚本已移除 rembg 的启动与回滚，`--remove-orphans` 会自动清理旧的 rembg 容器与网络。

镜像构建矩阵也去掉了 rembg target，镜像仓库里不再推送 `bagcollect-rembg`。

### 万象不可用时

主链路没有备用抠图实现：万象超时、配额耗尽或被停用，图片处理会立即进入 `FAILED`，不会退回任何本机推理。可调整的只有接口本身 —— 把 `CI_MATTING_PROCESS` 改成 `GoodsMatting` 换一条识别策略（成本同步减半）；若万象整体不可用，任务只能失败并等接口恢复。

`apps/worker/src/matting.ts` 与其配套脚本、容器定义仍保留在仓库中，但它们不在主链路上，不会自动接管；要使用必须自己接线，见该文件顶部注释。

## 11. 已改动的文件

新增：

- `apps/worker/src/matting-tencent-ci.ts` — 万象抠图实现
- `apps/worker/test/matting-tencent-ci.test.ts` — 21 项单元测试
- `scripts/verify-ci-matting.mjs` — 真实样本验收脚本（`pnpm ci:verify-matting`）
- `scripts/compare-matting-models.mjs` — 抠图接口 A/B 并排对比图生成（`pnpm ci:compare-models`）
- `scripts/list-cos-buckets.mjs` — 列出账号下真实桶名与地域（`pnpm ci:list-buckets`，需临时授予 `cos:GetService`）
- `docs/cam-policy-cos-ci.json` — 可直接粘贴的 CAM 策略，已填真实桶名与 APPID
- `docs/TENCENT_CI_MATTING.md` — 本文档
- `docs/TENCENT_CLOUD_SETUP.md` — 桶名、地域与 CAM 密钥的获取教程

修改：

- `apps/worker/src/config.ts` — 新增 `CI_MATTING_*`；删除 `MATTING_PROVIDER` 与全部 `REMBG_*`，改为强制 `STORAGE_DRIVER=cos` 与 COS 凭据
- `apps/worker/src/object-store.ts` — 新增 `getSignedObjectUrl`
- `apps/worker/src/processor.ts` — 主链路只保留万象调用，删除 provider 分流与降采样/回放大逻辑
- `apps/worker/src/matting.ts` — 不再被主链路引用；仅更新顶部注释，实现未改动
- `apps/worker/test/config.test.ts`、`apps/worker/test/processor.test.ts` — 覆盖强制 cos 校验与万象路径
- `infra/docker-compose.yml` — worker 注入万象配置；rembg 服务定义保留未删除，且不在 worker 的 `depends_on` 里
- `infra/deploy.sh`、`.github/workflows/ci.yml`、`.github/workflows/deploy.yml` — 移除 rembg
- `infra/Dockerfile` — `rembg` stage 保留未删除，CI 不构建该 target
- `package.json` — 新增 `ci:verify-matting`；`dev:rembg` 与 `warmup:rembg` 保留
- `.env.example`、仓库根 `.env`（仅本地，不入库）— 删除 `MATTING_PROVIDER` 与 `REMBG_*`，补上 `CI_MATTING_*` 与 COS 必填说明
- `README.md`、`docs/WECHAT_NATIVE.md`、`docs/DATABASE_LOCAL.md`、`docs/UNIAPP_REFACTOR_SUMMARY.md`、`PROJECT_STATUS.md` — 抠图描述更新
- `docs/OPEN_SOURCE_MATTING.md` — 说明已不在主链路、文件保留未删除
- `scripts/diagnose-matting-perf.mjs`、`scripts/measure-matting-throughput.mjs` 等诊断脚本 — 保留未删除

### 2026-09-22 第二次变更：切换抠图接口 `GoodsMatting` → `AIPicMatting`

- `apps/worker/src/config.ts` — `CI_MATTING_PROCESS` 默认值改为 `AIPicMatting`，注释补上选型理由
- `apps/worker/src/matting-tencent-ci.ts`、`apps/worker/src/object-store.ts` — 注释里的示例接口名改为 `AIPicMatting`
- `infra/docker-compose.yml` — worker 的 `CI_MATTING_PROCESS` 默认值与注释
- `apps/api/src/common/env.ts` — `MAX_DAILY_MATTING` 50 → 25（保持成本天花板 0.50 元/人/天），并注明配额是建档快照
- `apps/worker/test/config.test.ts` — 默认值断言改为 `AIPicMatting`，原「备选接口」用例改测 `GoodsMatting`
- `.env.example` — `CI_MATTING_PROCESS` 与 `MAX_DAILY_MATTING` 需同步（见第 10 节待办）
- `PROJECT_STATUS.md`、`docs/WECHAT_NATIVE.md`、`docs/TENCENT_CLOUD_SETUP.md`、`docs/UNIAPP_REFACTOR_SUMMARY.md`、`docs/OPEN_SOURCE_MATTING.md` — 抠图接口描述更新

## 12. 参考

- 智能抠图总览：<https://cloud.tencent.com/document/product/460/80907>
- 商品抠图 GoodsMatting：<https://cloud.tencent.com/document/product/460/79735>
- 通用抠图 AIPicMatting：<https://cloud.tencent.com/document/product/876/123128>
- 内容识别费用（通用抠图 0.02 元/次、商品抠图 0.01 元/次）：<https://cloud.tencent.com/document/product/239/58118>
- 免费额度（**只有商品抠图有 1000 次，通用抠图不在清单内**）：<https://cloud.tencent.com/document/product/460/36381>
- 按量计费（后付费）与计费项说明：<https://cloud.tencent.com/document/product/460/73221>
- 数据万象 CI action 与权限：<https://cloud.tencent.com/document/product/598/98114>
- 请求签名：<https://cloud.tencent.com/document/product/436/7778>
