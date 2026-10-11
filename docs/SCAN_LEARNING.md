# 用户扫描反馈积累：部署、审核和验收

本次增加 API、后台、小程序和现有 scan-worker 的代码，以及增量迁移 `20261011010000_scan_learning`。复用现有 `http://vision:8000`，模型文件和推理容器不需要重新配置。没有新增服务器服务，也没有训练模型。

## 上线顺序

1. 按现有发布流程部署此版本：合并 main 后 GitHub Actions 先验证，再运行 `infra/build-and-deploy.sh` / `infra/deploy.sh`。迁移在应用切换前执行，保留旧客户端、旧模型和原参考图。手动部署也应使用这些脚本，避免跳过备份和迁移。
2. 上传这一版小程序，开发工具导入 `apps/miniapp/dist/build/mp-weixin`。后台和 API 更新不会自动让已发布小程序出现搜索纠错入口。旧客户端的 SELECTED / NONE 仍兼容。
3. 后台打开「扫描样本」。初始采集关闭，COS 预算为 1GiB。确认已有 DINO 服务能计算特征，再按下述流程验证；开启和关闭只需保存后台设置，无需重启。
4. 开启采集后做一组拍照与相册扫描，标记候选或搜索正确款式。在待审列表核对裁剪图、款式、分数、模型和计算状态。待特征 READY 后通过；再扫描、撤回、恢复，检查检索结果随参考图变化。
5. 用服务器真实扫描测量内存和耗时，再决定持续开启。资源异常时关闭采集；有效参考继续参与匹配。关闭不会中断已标记样本的计算、审核和到期清理。

当前代码交付的本地测试不能代替生产 COS、iOS/Android 真机、服务器资源和独立实拍验收。没有这些实测时不要宣称准确率或性能已达标。

## 图片与容量

实际扫描裁剪 → 最长边 512、白底 JPEG（80 / 70 / 60）→ 不超过 200KiB → 私有 COS 对象 `learning-samples/<sampleId>/image.jpg`。生产路径只处理内存 Buffer，不写服务器磁盘；local 驱动仅用于测试。独立样本先保存，随后才返回可确认的扫描结果；扫描和收藏原图不变。

预占实际字节数时使用数据库全局事务锁。STAGING 预占、待审、有效、删除失败的图片都计费；只有 COS 删除确认成功后才释放预算。容量不足时先清理过期图片，再回收最早未标记图片。仍不足就保存标记、跳过照片；不会删除有效参考或阻止收藏。不设置每日、每用户或待审数量限制。

未标记 24 小时；待审 14 天；驳回、撤回、替换 7 天；有效参考持续保留；照片删除后元数据再保留 30 天。清理每 30 秒执行，批量上限仅限制一次维护工作量，不限制可提交样本总数。删除失败保留对象 key 和容量，下轮重试。进程中断的上传预占在 10 分钟后回收，计算中断在 2 分钟后重排。不要给整个 COS 前缀设置统一过期规则。

样本对象显式使用 `ACL: private`，后台预览用 5 分钟原生 COS 签名，绕开公开展示图 CDN 配置。[腾讯云 ACL 说明](https://cloud.tencent.com/document/product/436/30583)介绍对象权限设置。上线时必须验证实际桶策略：从后台取一个样本的签名链接，签名 GET 应成功；去掉全部查询参数的匿名 GET 应拒绝（403），签名过期后也应拒绝。如果桶策略额外给匿名用户开放整个桶，应排除 `learning-samples/*`；不要更改现有展示图片权限。不要把样本前缀接入公开 CDN。

## 审核与纠错

- 用户标记默认提交，没有额外勾选步骤。已收藏款式也可点击标记，不创建第二条认领。
- 搜索纠错仅选择已发布且图片就绪的款式。API 校验扫描归属、候选（SELECTED）、款式有效性和当前收藏关系。
- 同一扫描只能提交一次标记，重复相同请求返回现有状态；相互矛盾的重放返回 409。断网记录绑定账号，本地保留最多 24 小时，下次进入小程序重试。
- 标记后才进入计算，提取保存 JPEG 本身的 DINO 与颜色特征，不复用原查询向量，不调用腾讯抠图。推理失败按退避重排，可在后台手动重算。扫描、样本计算、参考补算只通过单并发扫描队列；实时扫描优先，参考补算在每个特征之间让出队列。
- SHA-256 过滤同款完全重复；高相似只提示可能重复，不自动否定参考价值。管理员检查同款、主体清晰度和背景/光照/角度的参考价值。
- 通过时在同一事务内创建参考图与两种有效特征。每款最多 5 张额外图，和管理员原有上传共用；满额必须选择具体替换图，新图未就绪不会移除旧图。
- 撤回、替换和恢复均在后台操作并记审计。有效参考标错款式时，先撤回，再点击「纠正后待审」，重新审核到正确款式；纠正不会直接重新启用。原管理员图撤回后也在扫描样本页恢复，原图不计入新样本容量。旧参考缺少当前模型特征时，恢复先回到待审计算，审核后生效。

## 接口

| 接口 | 用途 |
| --- | --- |
| `POST /official-bags/match-scans/:id/feedback` | SELECTED / CORRECTED / NONE，返回原有 success 与 sampleId、sampleStatus、skipReason |
| `GET /admin/learning-samples?page=1&state=PENDING` | 分页、私有预览、快照、失败和重复提示 |
| `POST /admin/learning-samples/:id/review` | action: APPROVE / REJECT / CORRECT / WITHDRAW / RESTORE / RECOMPUTE；可选 bagId、replaceReferenceId |
| `GET /admin/settings/learning` | 采集设置、实际占用、各状态数量 |
| `PUT /admin/settings/learning` | enabled、budgetBytes（仅两项设置） |

接口仍有 `/api` 前缀；后台全部使用 AdminGuard，用户接口使用 AuthGuard。样本和特征记录独立于 MatchScan 与扫描草稿的删除。

## 验证命令与实际测量

本地隔离测试库先执行迁移，然后：

```sh
pnpm lint
pnpm typecheck
pnpm build
pnpm test
pnpm test:scan
pnpm test:learning
```

`test:learning` 默认使用确定性推理服务桩验证状态、实际 JPEG 特征流程和索引变化；设置 LEARNING_TEST_VISION_URL 可复用已有真实 DINO 服务执行同一套验证。`test:scan` 配置 VISION_SERVICE_URL 后也可以验证真实 DINO 服务。两者都不是独立实拍效果验收。

服务器在本次 release 的源码目录执行以下只读采样。关闭采集时连续扫同一组独立实拍，记录 baseline；开启时重复同一组且同时处理样本，记录 learning（操作和负载保持一致）：

```sh
sh scripts/measure-learning-resources.sh baseline 120
sh scripts/measure-learning-resources.sh learning 120
```

比较 `/tmp/bagcollect-learning-metrics/` 两份 CSV：worker 峰值增加 ≤100MiB、整机 MemAvailable 最低 ≥200MiB。后台「匹配设置 → 扫描诊断」分别统计未增强与已发起增强扫描的 elapsedMs P95，目标 ≤5 秒 / ≤15 秒。采样间隔 1 秒可能漏掉短峰值，需结合容器内存指标和 OOM 日志判断；local Windows 结果不能替代服务器测量。

独立实拍集至少 30 款、两批各 3 张，另加 40 张库外袋子。贡献参考和验收照片必须来自独立拍摄。参考更新前后保持查询照片、标签、拍摄批次、模型、阈值和权重相同，分别运行已有基准，再比较：

```sh
pnpm scan:benchmark before.dataset.json before.report.json
pnpm scan:benchmark after.dataset.json after.report.json
node scripts/compare-learning-retrieval.mjs before.report.json after.report.json learning-comparison.json
```

基准会拒绝完全相同图片泄漏、跨校准/验收拍摄批次；比较器核对同一验收集，报告前五命中率、增加/丢失命中以及库外返回候选比例。独立拍摄声明仍须人工核实。样本不足或没有实拍数据时报告未验证，不把参考图自身检索成功当作效果达标。
