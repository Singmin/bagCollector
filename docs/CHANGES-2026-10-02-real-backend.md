# 改动记录 · 真实后端联调与标记链路修复（2026-10-02 第二轮）

> 承接 `docs/CHANGES-2026-10-02.md`（编辑器改造与 main 合并）。本轮目标：**去掉全部模拟数据，完整跑通真实后端**，并修复联调中暴露的链路缺陷。
> 分支：`feature/editor-polish`，涉及提交 `38aed88..19a5853`。

---

## 一、本地运行环境搭建（配合 Docker Desktop 首次安装）

| 步骤 | 说明 |
|---|---|
| `.env` 生成 | 从 `.env.example` 复制；**修正开发库密码**为 `bagcollect_local`（模板里的 `bagcollect` 与 compose 实际设置不符，直接照抄会认证失败）；`JWT_SECRET` 随机 32 位 |
| `pnpm infra:local:up` | 4 容器：postgres-dev(5432) / redis-dev(6379) / postgres-test(5433) / redis-test(6380) |
| `pnpm db:generate + db:local:deploy` | 迁移全部应用（含 `split_crop_and_matting`） |
| `pnpm dev:api / dev:worker` | API 监听 3001；worker 消费队列 |

⚠️ 两个环境坑（已记录）：
- **Docker CLI 未进 PATH**：Docker Desktop 首启没写 `/usr/local/bin/docker`，需 `sudo ln -sf /Applications/Docker.app/Contents/Resources/bin/docker /usr/local/bin/docker`。
- **Prisma Client 过期**：`pnpm install` / 重装依赖后运行时可能报 `does not provide an export named 'PrismaClient'`，执行 `pnpm db:generate` 即可，非代码问题。

## 二、worker 放行 local 存储（`38aed88`）

**原状**：`worker/src/config.ts` 启动期硬性要求 `STORAGE_DRIVER=cos` 且 COS 四项凭据必填，无凭据时 worker 起不来——整条图片链路（包括与 COS 无关的上传/规范化/裁剪）全部瘫痪。

**改动**：仅 `STORAGE_DRIVER=cos` 时校验 COS 凭据；local 放行启动。`object-store` 读写本就支持本地磁盘，真正依赖 COS 的只有给万象抠图用的签名 URL——抠图任务在 local 下于 `getSignedObjectObjectUrl` 明确失败，由 `failProcessing` 标记 FAILED（不静默出错图、不拖垮 worker）。

**效果**：本地无 COS 也能真实跑通 上传 → 规范化 → 裁剪/调色；官方袋子录入（不勾抠图）也能处理到 READY（本轮灌库 10 条全部验证）。

## 三、模拟数据全部移除（`c9c21ad` + `d4f9cc0`）

后端接口经逐一核对（method+path）**100% 覆盖**原 mock 路由，且 `mockRequest` 已是零调用的死代码，故整体移除：

- 删 `services/mock-data.ts`（USE_MOCK 开关、种子数据、mockRequest）
- `http.ts` logout 移除 USE_MOCK 分支（该引用未 import，本就是 typecheck 报错源）
- 拍照页 `add/index.vue` 移除 mock 跳过上传分支，恒走 policy → upload → complete
- 删 `.env.mock`、`VITE_USE_MOCK` 类型声明、miniapp 与根 package.json 的 mock 构建脚本
- 删 `static/figma/bags/`（bag-01~10 演示图）及 5 处引用：设置页场景图改冷调渐变光斑、两页分享封面交由微信默认截图
- **`vue-tsc` 首次全仓清零**（连同 mock-data 的 21 处历史错误）

保留：后端 `WECHAT_AUTH_MOCK`（登录换 openid 的后端开关，无微信 appid/secret 时本地联调必需，与数据 mock 无关）。

## 四、真实数据灌库

通过管理后台 API 走**完整真实链路**录入 10 条官方袋子（瑞幸 / 霸王茶姬 / Peet's 等联名袋图）：

```
管理员登录 → 创建袋子 → 上传原图(matting=false) → worker 处理至 READY → 发布
```

踩坑：发布被拒 `图片尚未上传或处理完成`——worker 异步处理，脚本改为「先全部上传 → 轮询 READY → 再发布」。10 条全部 READY、0 失败，同时证明 worker 在 local 模式的图片处理真实有效。

## 五、精选上新展示数量放开（`8ba0d30` → `8ac22c5`/`c700e44`（同事 oillx）→ `a277efd`）

演进过程：
1. `8ba0d30`：`limit=9` 写死 → 游标翻页（`scrolltolower` 触发 `loadMore`，只追加不清空，id 去重兜底）
2. oillx：一次取到后端上限 + 挂袋区**虚拟列表渲染**（只渲染可视区卡片，两侧占位撑住滚动条）
3. `a277efd`：**后端 limit 上限 100 → 1000**，前端一次取 1000 全量；超 1000 游标翻页兜底保留

最终形态：官方袋子录入多少展示多少，渲染开销恒定。

## 六、缺陷修复

### 6.1 完善信息页「收藏缺少展示图」（`85bf154`）

**main 上既有的流程缺陷**：normalize 只产出 ORIGINAL+STANDARD（展示图要等首次裁剪才生成），而处理页在 `AWAITING_CROP` 就把用户送进完善信息页，页面守卫硬性要求 `displayImageUrl` → 首次上传永远进不了该页。

**修复**：守卫回退用 `standardImageUrl` 占位（接口本就返回），仅连标准图都没有才报错。

### 6.2 下拉刷新拽动顶部标题栏（`c4114de`）

两页均已改用 scroll-view 内置刷新器，但 `pages.json` 残留页面级 `enablePullDownRefresh: true`——原生下拉把整页（含自定义标题栏）一起拽下。

**修复**：移除 `enablePullDownRefresh`；补 `disableScroll: true`（页面为 100vh 弹性列 + 内部 scroll-view，页面级滚动/回弹整体禁掉，iOS 橡皮筋也不再带标题）。

### 6.3 标记已有状态丢失 → 再点 409（`9f5403a`）

**根因**：标记状态（`markedMap`）是页面内存态，刷新/重编译即丢；再点会重新走认领，被后端 409「你已经拥有过这个袋子」挡下。

**修复（状态上移服务端，feed 为唯一真值源）**：

| 层 | 改动 |
|---|---|
| contracts | `CollectibleSummaryDto` 增 `myCollectibleId?`（我认领过 → 认领生成的收藏 id） |
| api | feed controller 注入当前用户；feed / wishlist 批量查 `OfficialClaim`（N+1 防护）带回 |
| miniapp | showcase 加载/翻页后 `syncClaimState()` 以服务端为准恢复标记状态（反向也清残留） |

### 6.4 标记 → 删除 → 再标记，收藏卡死 NORMALIZING（`19a5853`）⭐ 本轮最关键

三个缺陷叠加：

```
标记已有 → 认领任务入队（jobId = userId+bagId）
   ↓ 删除（收藏 A 没了）
旧任务留在 BullMQ 失败保留区（removeOnFail:1000），指向已删除的收藏
   ↓ 再标记（收藏 B）
新任务与旧任务【同 jobId】→ 被 BullMQ 去重静默吞掉
   ↓
收藏 B 永远等不到图片复制 → 卡死 NORMALIZING → 收藏架不显示
```

| # | 缺陷 | 修复 |
|---|---|---|
| 1 | jobId 不含 collectible，重复认领被去重吞掉 | jobId 改 `official-claim:${collectibleId}:${bagId}`（每次认领唯一） |
| 2 | worker `findFirstOrThrow`：收藏被撤回时任务必抛错 | `findFirst` + 缺失即静默完成（认领已撤回，无事可做） |
| 3 | `failOfficialClaim` 用 `update` 对已删记录再写 → 失败处理本身崩，任务反复重试 | 改 `updateMany` 容忍缺失 |

**数据修复**：为卡死的既有收藏手动补投认领任务（BullMQ 直加），确认走到 READY。

## 七、交互优化（`0c7da1a`）

标记半窗「分类」→「品牌/名称」：
- 自动填充官方袋子原有品牌（`ownerName`，如「瑞幸咖啡」）
- 与展架同名自动选中；不同名/修改后不传 `shelfId`，后端归入默认展架（`shelfId` 本就可选）
- 移除「请选择分类」硬拦截，品牌文字自由填写；下拉建议仍列用户展架

## 八、端到端验证（真实请求模拟完整用户路径）

```
0. 登录（mock auth）                          ✓
1. feed 加载（10 条，一次取全）                ✓
2. 标记已有（认领 → 建收藏 + 任务入队）        ✓
3. 删除（撤回标记）                           ✓
4. 再次标记（此前必坏路径）                    ✓ 新任务未被去重吞掉
5. worker 复制图片                            ✓ READY，不再卡 NORMALIZING
6. 收藏架列表可见 + 缩略图                     ✓
7. 首页红靶心状态与认领收藏一致                 ✓
```

另有认领状态专项：认领 → feed 返回 `myCollectibleId` 与认领收藏一致；删除 → feed 状态同步清除。

## 九、当前遗留

1. **真机验证**：背面 3D 翻转层内的 scroll-view 手势、下拉刷新观感需真机确认。
2. **抠图链路**仍需腾讯云 COS + 数据万象凭据（`STORAGE_DRIVER=cos` + `COS_*` 四项），配好即通，代码无需改动。
3. **首次上传 → 完善信息**的展示图为标准图占位，裁剪后才换成正式展示图——交互上是否符合预期待用户反馈。
4. 收藏记录没有独立品牌字段，「品牌」展示走展架名；若要自由填写品牌文字并单独存储，需后端加字段。
5. 正式版构建连 `127.0.0.1`（`.env.localbuild`），上线时改为真实域名重新构建即可。
