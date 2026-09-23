# BagCollect 开源抠图实施方案

> ## ⚠️ 本文档已废弃（2026-09-21）
>
> 生产抠图已切换为**腾讯云数据万象**（当前接口：通用抠图 `AIPicMatting`，0.02 元/次），现行方案见
> [腾讯云数据万象抠图实施方案](TENCENT_CI_MATTING.md)。
>
> 本文描述的自托管 rembg + BiRefNet 方案**不在主链路上**：Worker 只调用万象实现，配置里
> 也没有 provider 开关与 `REMBG_*` 变量，因此没有降级到本方案的路径。相关代码与部署资产
> 全部保留未删除，仅作为模型推理性能实测数据的存档。完整文件清单见
> `apps/worker/src/matting.ts` 顶部注释。
>
> 下文只在需要单独研究或实验这套自托管推理时才有参考价值，且必须自己接线使用；
> 它不会在主链路里被自动调用。注意第 3、5、6 节里「不与 COS 绑定」「不按调用次数付费」
> 「生产环境没有腾讯数据万象请求」等表述都是切换前的决策，与现状相反，不要照此实施。

> 历史实现状态（2026-09-17）：Worker 已接入固定模型的 rembg HTTP 客户端，存储与抠图职责已拆分，并加入超时、响应大小、尺寸和有效 alpha 校验。生产 Compose 使用内网 rembg 服务；真实样本效果与实体微信端验收仍待完成。

## 1. 决策

BagCollect 不依赖腾讯数据万象完成自动抠图。图片裁剪完成后，由自托管 Worker 调用本地开源模型生成透明 PNG。

首选实现：

- 推理服务：[`rembg`](https://github.com/danielgatis/rembg)。
- 默认模型：`birefnet-general-lite`。
- 低配备选模型：`u2net` 或 `u2netp`。
- 开发环境文件存储：现有 `STORAGE_DRIVER=local`。
- 生产文件存储：可以继续使用兼容的对象存储，或改为自托管 MinIO；抠图实现不应再和 COS 绑定。

选择该方案的原因：

- 模型在自己的电脑或服务器运行，图片不发送给第三方抠图服务。
- 不按调用次数付费，也不需要腾讯云密钥。
- 支持普通物品，不局限于人物肖像，适合包、鞋、玩具等收藏品。
- rembg 提供 Python 库、HTTP 服务和 Docker 运行方式，容易接入现有 Node Worker。
- BiRefNet 官方模型卡标注 MIT；rembg 代码使用 MIT。正式商用前仍需保存精确模型来源、版本、校验值和许可证副本。

不要使用 rembg 未指定模型时的默认模型。当前 rembg 默认可能选择 `bria-rmbg`，其模型有单独的商业使用限制。代码和部署配置必须显式指定 `birefnet-general-lite` 或经过审核的其他模型。

## 2. 与 Apple Vision 的关系

iOS 版可以直接调用 Apple Vision 的前景实例蒙版接口，因为模型能力随 iOS/macOS 系统提供。微信小程序无法调用 Swift/Apple Vision，也不适合把数十至数百 MB 的 ONNX 模型塞入小程序包。

跨平台实现采用相同的产品边界：客户端只提交图片，受信任的本机或服务器负责前景分割。区别只是把 Apple 系统模型替换为自托管的 ONNX 模型。

## 3. 目标架构

```text
微信小程序
  -> API 创建收藏和上传记录
  -> 本地磁盘或对象存储保存原图
  -> BullMQ normalize 任务
  -> Worker 纠正方向并生成标准图
  -> 用户确认裁剪
  -> BullMQ matting 任务
  -> Worker 生成裁剪图
  -> 内网 rembg 服务生成透明 PNG
  -> Worker 生成 2048px 展示图和 512px 缩略图
  -> 收藏状态变为 READY
```

rembg 服务只允许 API/Worker 所在的 Docker 网络访问，不直接暴露到公网，也不允许小程序直接调用。

## 4. 配置设计

在根目录 `.env.example`、Worker 配置和生产部署示例中增加：

```env
REMBG_URL=http://127.0.0.1:7000
REMBG_MODEL=birefnet-general-lite
REMBG_TIMEOUT_MS=120000
REMBG_MAX_RESPONSE_BYTES=83886080
REMBG_MAX_CONCURRENCY=1
REMBG_SERVER_CONCURRENCY=1
REMBG_OMP_NUM_THREADS=
MATTING_INFERENCE_MAX_EDGE=1024
```

三个新增项都是性能相关，改错只会影响速度或边缘质量，不会改变处理流程：

- `REMBG_SERVER_CONCURRENCY` / `REMBG_OMP_NUM_THREADS`：**这两个开关作用完全不同，别混为一谈**
  （rembg 2.0.84 实测）：
  - `--threads`（由 `REMBG_SERVER_CONCURRENCY` 驱动）只设置 anyio 的并发请求上限
    （`CapacityLimiter`），**不影响单次推理速度**。
  - `OMP_NUM_THREADS`（由 `REMBG_OMP_NUM_THREADS` 驱动）才是真正决定 onnxruntime
    intra/inter-op 线程数的开关，见 `rembg/session_factory.py`。
  - 实测数据（16 核，`birefnet-general-lite`，模型输入固定 1024x1024，同一张 256px 图）：
    不设 `OMP_NUM_THREADS` → 10.4~12.5s；设 4 → 11.3~31.2s；设 1 → 约 21.5s；设 8 → 24.6~42.8s。
    线程数与耗时并非线性——该模型是访存带宽瓶颈，线程开多了互相抢带宽反而更慢。
  - 结论：**默认保持 `OMP_NUM_THREADS` 为空**，交给 onnxruntime 按可用核数自行决定。
    只有当容器被 `--cpus` 限流、onnxruntime 会误判可用核数时，才填配额内的数值。
    注意该值会被 rembg 直接 `int()` 解析，不能设成非数字。
  Docker 镜像通过 `infra/rembg-entrypoint.sh` 统一读取这两个变量，不要再在 Dockerfile 的 CMD 里硬编码线程数。
- `MATTING_INFERENCE_MAX_EDGE`：送抠图前的降采样上限，**必须对齐 `REMBG_MODEL` 的模型输入边长**
  （`birefnet-general-lite` 为 1024，已用 onnxruntime 读出模型输入 shape 确认为 `(1,3,1024,1024)`）。

Docker 内部使用：

```env
REMBG_URL=http://rembg:7000
```

Worker 只接入真实的 rembg 服务，开发、测试和生产使用同一条处理路径。

## 5. 代码改造点

### 5.1 拆分存储与抠图职责

Worker 已拆分对象存储与抠图：

- `apps/worker/src/object-store.ts`
  - `getObject(key)`
  - `putObject(key, body, contentType)`
  - `deleteObjects(keys)`
- `apps/worker/src/matting.ts`
  - `removeBackground(input: Buffer): Promise<Buffer>`
  - 调用显式配置的 `REMBG_URL`。

这样以后把 COS 换成 MinIO、本地磁盘或其他 S3 兼容存储时，不会影响抠图代码。

### 5.2 rembg 调用

Worker 使用 multipart 请求把已经裁剪的 JPEG 发送到 rembg 内网接口：

```text
POST {REMBG_URL}/api/remove
Content-Type: multipart/form-data
file=<cropped.jpg>
```

请求必须同时提交 `file=<cropped.jpg>` 与 multipart 表单字段 `model=birefnet-general-lite`。不要依赖 rembg 默认模型，也不要允许客户端传入任意模型名、文件路径或远程 URL。

响应必须满足：

- HTTP 状态为 2xx。
- `Content-Type` 是图片类型。
- 能被 Sharp 解码。
- 输出格式统一转换为 PNG。
- 输出尺寸合理，且至少包含一个 alpha 通道。
- 响应体和解码像素数受限，防止异常服务消耗过多内存。

### 5.3 Worker 状态

修改 `apps/worker/src/processor.ts`：

1. 保存 `CROPPED` JPEG。
2. 按 `MATTING_INFERENCE_MAX_EDGE` 把裁剪图降采样后调用 `removeBackground(...)`。
3. 验证透明 PNG（尺寸按降采样后的推理输入校验）。
4. 把掩码放大回裁剪图原始尺寸，保存 `CUTOUT` PNG。
5. 基于透明图生成 `DISPLAY` PNG 和 `THUMBNAIL` WebP。
6. 全部成功后才把收藏状态改为 `READY`。

图片处理任务只执行一次。rembg 失败时立即标记 `FAILED`，不生成展示图或缩略图，也不允许原图或裁剪图冒充成功结果。

## 6. Docker 接入

生产 Compose 已增加独立 `rembg` 服务；本机第一阶段使用 `pnpm dev:rembg` 通过 uv 启动固定版本服务。

容器要求：

- 固定 rembg 版本。
- 显式指定 `birefnet-general-lite`。
- 模型目录挂载到命名卷，避免每次启动重新下载。
- 健康检查通过后 Worker 才开始接收任务。
- CPU 部署先把并发设为 1，测量内存和耗时后再提高。
- **不要**在 Dockerfile 的 CMD 或入口脚本里硬编码 `--threads 1`，也不要随手设置
  `OMP_NUM_THREADS`：前者会让服务端并发退化（虽不影响单张速度），后者实测会让推理
  慢 1.6~2.2 倍。保持 `OMP_NUM_THREADS` 不设置即可。
- 仅加入内部 Docker 网络，不映射公网端口。

本机首次启动会下载模型，需要预留磁盘空间和启动时间；可用 `pnpm warmup:rembg` 提前完成模型初始化。生产镜像在构建阶段预下载模型，命名卷保留运行时模型目录。

## 7. 分阶段实施

### 阶段一：本机效果验证

1. 安装 CPU 版 rembg。
2. 下载并固定 `birefnet-general-lite`。
3. 选取至少 10 张真实收藏图片，覆盖：
   - 浅色物体配浅色背景。
   - 深色物体配深色背景。
   - 毛绒、透明、反光和细带物体。
   - 多主体和复杂背景。
4. 保存原图、裁剪图、蒙版和透明结果，人工比较边缘质量。
5. 记录单张耗时、峰值内存和模型占用空间。
6. 与 `u2net` 做一轮相同输入的对照测试。

真实样本效果通过后才能发布对应的 rembg 模型配置。

### 阶段二：接入 Worker

1. 新增配置 Schema 和 `matting.ts`。
2. 接入 rembg HTTP 服务。
3. 添加超时、响应大小、图片格式和 alpha 校验。
4. 验证单次失败状态和对象清理逻辑。
5. 更新本地完整图片链路测试。

### 阶段三：生产部署

1. 固定 rembg、Python依赖和模型版本。
2. 固定模型文件 SHA-256。
3. 保存第三方许可证和归属说明。
4. 建立模型卷备份或可重复下载流程。
5. 压测并限制 Worker 与 rembg 并发。
6. 监控处理耗时、失败率、队列积压、内存和磁盘空间。
7. 完成灰度验证后删除腾讯数据万象配置。

## 8. 测试要求

至少增加以下自动化测试：

- 缺少 `REMBG_URL` 时启动失败。
- rembg 正常返回透明 PNG 时任务进入 `READY`。
- rembg 超时、500、空响应和非图片响应会立即进入 `FAILED`。
- 不透明输出不能冒充成功抠图。
- 大响应和超大像素图片会被拒绝。
- 重复任务不会重复累计用户存储用量。
- 删除收藏会清理原图、标准图、裁剪图、透明图、展示图和缩略图。

本地端到端验收继续使用：

```bash
pnpm test:image-flow:local -- /absolute/path/to/image.png
```

测试脚本需要增加 alpha 通道检查，不能只检查状态为 `READY`。

## 9. 完成标准

满足以下条件后，才可以宣称开源抠图已接入：

- 至少 10 张真实样本通过人工效果检查。
- 自动化测试确认输出包含有效透明区域。
- 小程序完整走通上传、裁剪、等待处理、预览、归架和重新抠图。
- API、Worker、rembg 重启后任务能够恢复。
- 生产环境没有腾讯数据万象请求。
- 模型版本、下载地址、SHA-256 和许可证已经记录。
- 实体 iPhone 与 Android 微信各验证一次。

## 10. 参考项目

- rembg：<https://github.com/danielgatis/rembg>
- BiRefNet：<https://github.com/ZhengPeng7/BiRefNet>
- BiRefNet 模型卡：<https://huggingface.co/ZhengPeng7/BiRefNet>
- U²-Net：<https://github.com/xuebinqin/U-2-Net>
- Apple Vision 前景实例蒙版：<https://developer.apple.com/documentation/vision/generateforegroundinstancemaskrequest>
