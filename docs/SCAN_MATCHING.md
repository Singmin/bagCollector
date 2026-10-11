# 扫描匹配升级：运行、校准和回滚

## 当前交付边界

实现了异步扫描、真实取景框坐标裁剪、逐条候选过滤、全部点击确认、腾讯增强独立额度、多参考图、诊断和离线 DINOv2 Small 推理。默认仍为共享新预处理的颜色模型；DINO 在后台标为试用，只有当前发布且图片就绪的所有款式都有有效主参考向量才允许切换。没有独立实拍验收数据时，不宣称 Recall@5 已达到 90%。

DINOv2 Small 输出 384 维 CLS 特征，支持直接最近邻检索，见 [官方模型卡](https://github.com/facebookresearch/dinov2/blob/main/MODEL_CARD.md)。本项目固定 facebook/dinov2-small revision `ed25f3a31f01632728cabb09d1542f84ab7b0056`，预处理 `rgb-contain224-v1`，排序初值为视觉 0.90、颜色 0.10。新旧模型用不同标识，绝不混算。旧 `BagEmbedding` 表与唯一键完整保留；升级迁移把旧向量复制成 `ScanEmbedding` 主参考记录，新模型在新表另算。

## 本地启动

1. 安装项目依赖，运行 `pnpm db:generate`、`pnpm db:deploy`，再运行 `pnpm build:server`。Windows 下 Prisma 引擎 DLL 被已启动进程占用时，在自行关闭相应开发进程后再生成；不要修改生产库来解决本地工具问题。
2. 在独立 Python 3.12 环境安装 `apps/vision/requirements.txt`，导出环境另安装 `torch==2.7.1`、`transformers==4.52.4`、`onnx==1.18.0`。
3. 部署前执行 `python scripts/prepare-vision-model.py --output data/vision-models`。下载受限时可设置 `HF_ENDPOINT=https://hf-mirror.com` 并加 `--download-direct`。下载只发生在准备脚本里。固定 revision、ONNX SHA-256、维度和导出对齐误差写入 `manifest.json`。
4. 设置 `VISION_MODEL_DIR` 为模型目录的绝对路径，运行 `python -m uvicorn server:app --app-dir apps/vision --host 127.0.0.1 --port 8000 --workers 1 --limit-concurrency 16`。服务启动验证版本和文件校验，不做运行时下载。`GET /health/ready` 返回当前模型和 SHA-256。
5. API 照常 `pnpm dev:api`，图片消费者 `pnpm dev:worker`，新增消费者 `pnpm dev:scan`。扫描消费者环境设置 `VISION_SERVICE_URL=http://127.0.0.1:8000`，数据库和 Redis 与 API 保持一致。本地存储支持基础检索，腾讯增强需要真实 COS 配置。
6. 后台“匹配设置”点击“补算新模型向量”，等待覆盖率完整后再切换 DINO。切换同时检查推理服务健康与版本。每轮最多补算一款，30 秒自动对账；扫描消费者默认单并发，ONNX 单计算线程。

补算失败会等待 5 分钟后再尝试对应图片/模型；每轮尝试的款式也限为一款，避免服务故障时遍历全库超时、占住扫描计算。

## 生产部署

先在准备环境导出并核对模型。把 `dinov2-small.onnx` 和 `manifest.json` 放入服务器持久目录 `/www/wwwroot/bagcollect/data/vision-models/`。模型和 Python 开发依赖不加入 Git、不打入 API 构建上下文，也不跟每次源码发布传输。

在 `infra/.env.deploy` 设置 `VISION_ENABLED=1` 和 `VISION_SERVICE_URL=http://vision:8000`；已有服务器构建脚本会构建独立 vision 镜像，先等待推理服务健康，再启动 API、原 worker 和 scan-worker。vision 仅在 Compose 内网，无宿主机端口，模型目录只读，CPU 限额 1，内存上限 768MB。实际服务器仍需 `docker stats --no-stream` 和实测 P95 来评估内存上限，不把本机测试当服务器性能结论。

首次只发布流程并保留颜色默认。完成全库 DINO 主向量后开启小范围试用；管理员上传额外同款参考图，每款数量不限，预览、删除或重算独立于主展示图。删除后重传即可换参考图。主图换版自动重算，旧版本向量在重算前不参与匹配。

## 接口与失败处理

- `POST /api/official-bags/match-scans`：`{collectibleId, source: "camera"|"album", requestId, crop?: {x,y,width,height,rotation?}}`；坐标为 EXIF 转正后、可选额外旋转后图片的归一化坐标。相同用户、requestId 和输入复用同一任务；不同输入返回 409。
- `GET /api/official-bags/match-scans/:id`：仅所属用户能读，阶段 `QUEUED / RECOGNIZING / ENHANCING / DONE / FAILED`，带候选、原因、增强状态、耗时。小程序一秒轮询，45 秒超时，隐藏/退出页面停止轮询，返回可恢复。超时保留已有基础候选。
- `POST /api/official-bags/match-scans/:id/feedback`：`{feedback:"SELECTED",bagId}` 或 `{feedback:"NONE"}`。选择必须在先调用原认领接口成功后记录；反馈不作为可靠训练标签。仅显式点击认领，旧接口也只返回 CANDIDATES/NONE。
- 后台 `GET/PUT /api/admin/settings/scan`、`GET /api/admin/settings/scan/coverage`、`GET /api/admin/match-scans?page=1`、`POST /api/admin/match-scans/reconcile`；参考图 CRUD 在 `/api/admin/official-bags/:id/references`，重算为其 `/recompute`。

原始上传不被扫描覆盖。拍照使用实测预览区域和框，通过居中 cover 反推裁剪；相册首轮整图。查询与参考统一转正、RGB、透明主体收边、白底、等比居中 224×224。增强只使用 `scans/:scanId/crop.png`，每次扫描最多一次腾讯调用，retry=0，不修改收藏图或手动抠图额度。

阈值初值 0.60、候选上限 5、增强跳过 0.80、领先分差 0.05。增强配额默认每人 5/日、全站 100/日，上海时区，0 可关闭；在事务中用按日 advisory lock 同时预占两个计数和任务标记，失败调用仍计次，重投不重复调用。调用前重读最新额度与增强开关，排队任务也遵守后台刚降低的上限；其余参数按任务创建时快照记录。

库为空、向量未就绪、无候选、无主体、源图删除、队列/服务故障各有独立原因。增强失败/限额耗尽保留基础结果，两轮取每款最高分再去重。下架和删除在读取结果时再次过滤，已收藏展示标记且禁止重复确认。

临时对象在满 24 小时后的下一次清理轮次删除（轮询周期 30 秒），诊断满 30 天清除；诊断删除前须成功清理临时对象。隐藏页面但未选择的上传草稿保留，供恢复或手动处理；成功确认后小程序删除扫描草稿。若客户端删除请求丢失，后台对已记录 SELECTED 的扫描再次清理仍停在 AWAITING_CROP、源图未变的草稿，并回减存储计数；不会删除后来已完成手动入库的照片或新认领收藏。

## 校准与验收

执行 `pnpm test:scan` 前先构建 API、worker 和包，在专用 `*_test` 数据库应用迁移。集成测试不调用付费腾讯接口，覆盖任务幂等、权限、真实图片检索、确认、下架与陈旧向量、并发 5 次额度、全站限额、超时及清理；设置 `VISION_SERVICE_URL` 可同时验证真实 DINO 补算。CI 自动运行它。

准备至少 30 款，每款两个独立批次各至少 3 张；一个批次只进校准集，另一个只进验收集。验收另含至少 40 张库外袋子。参考图不能从验收照片派生，不用旋转/加噪变体替代独立拍摄。JSON 清单格式如下（路径相对清单）：

```json
{
  "settings": {"engine":"dino", "candidateThreshold":0.60, "visualWeight":0.90},
  "references": [{"bagId":"bag-a", "path":"references/a.png"}],
  "samples": [
    {"bagId":"bag-a", "path":"capture-1/a-1.jpg", "batch":"capture-1", "split":"calibration", "independentCapture":true},
    {"bagId":"bag-a", "path":"capture-2/a-1.jpg", "batch":"capture-2", "split":"acceptance", "independentCapture":true},
    {"bagId":null, "path":"outside/x.jpg", "batch":"outside-2", "split":"acceptance", "independentCapture":true}
  ]
}
```

设置 `VISION_SERVICE_URL`，执行 `pnpm scan:benchmark dataset.json report.json`。工具检查图片 SHA-256 重复、批次跨集、参考缺失；分别报告两集合 Recall@5、库外候选比例和核心识别 P95。样本不足时 `sampleGate/targetReached=false`。哈希只能防原文件重复，独立拍摄声明需人工核实。工具不调用云增强，核心延迟排除上传、排队、云处理和轮询，不能替代完整链路目标。

上线前真机检查 iOS/Android 框和裁剪一致、方向/透明图、同图相册与相机一致、同色异款、多参考去重、已收藏、下架、双击、断网、返回页面、任务超时、增强失败、额度争抢与清理。使用后台诊断按是否 enhancementIssued 分组测完整基础 P95≤5秒、增强 P95≤15秒；测量从任务创建到结束，图片上传应已完成。实拍验收目标 Recall@5≥90%，同时报告库外候选比例，无默认通过结论。

在实际服务器的数据库执行以下只读查询，分别统计最近 7 天各模型的完成识别延迟；库为空、索引未就绪、超时和服务故障不混入正常识别样本，应另报告其数量。云调用失败但保留基础候选的任务仍属于增强尝试。

```sql
SELECT model, "enhancementIssued", COUNT(*) AS samples,
       percentile_disc(0.95) WITHIN GROUP (ORDER BY "elapsedMs") AS p95_ms
FROM "MatchScan"
WHERE "createdAt" >= NOW() - INTERVAL '7 days'
  AND stage = 'DONE' AND "elapsedMs" IS NOT NULL
  AND (reason IS NULL OR reason = 'NO_CANDIDATES')
GROUP BY model, "enhancementIssued";
```

## 2026-10-11 本地验证记录

- 93 项单元测试通过；API/worker 构建、后台构建、微信小程序构建、类型检查、lint、页面结构检查通过。专用 PostgreSQL 测试库迁移和已有 API 集成测试通过。
- 真实模型导出最大绝对误差 `3.427267074584961e-7`；本次 ONNX SHA-256 为 `168e03a5e7c8254f35abb111e4e1748efdb048b655278aa5ccf46b9675fcc89a`，实际部署以随文件生成的 manifest 校验。
- Windows 与 Linux Docker 均完成真实推理；HTTP → Redis → 独立消费者 → DINO → 轮询候选链路通过。并发参考图上限、模型切换/回滚、候选去重、独立额度、确认前无认领、遗漏客户端删除后的草稿清理均有集成覆盖。
- 本地 Linux 容器以 1 CPU、768MiB 上限运行，完成测试后的内存快照约 230.5MiB。仅为本地快照，不是线上峰值或服务器验收。
- 校准工具用明确标为非独立拍摄的合成图完成冒烟，正确输出 `sampleGate=false`、`targetReached=false`。暂无真实独立实拍验收集；iOS/Android 真机一致性、腾讯付费链路和线上性能仍需现场验证。

## 回滚

后台把默认模型切回颜色立即影响新任务，已排队任务按模型/参数快照完成；两种向量保留。服务器镜像回滚保留加法迁移，新表不需删。旧镜像没有 scan-main 时脚本停止 scan-worker，避免用旧镜像启动不存在的入口；曾有旧 scan-worker 时恢复它的独立镜像。恢复旧版小程序/服务后依旧应使用本次修复的候选确认兼容接口，避免重新启用历史自动认领行为。
