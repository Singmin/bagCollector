# UI 改动记录 · 第三轮（2026-09-28 晚）

接续 `docs/UI-CHANGES-2026-09-27.md`（第二轮，提交 b3937b4）。本轮为交互补充与多轮视觉微调。

> 分支：`feature/ui-revamp`（续）

---

## 一、长按删除收藏（新增，全部收藏页）

- 展架视图 / 宫格视图的收藏卡片均支持**长按**删除：确认弹窗（红色删除键）→ `DELETE /collectibles/:id`（Mock 模式同步支持）
- 删除后本地四处同步：列表移除、所属展架件数 −1、详情缓存清理、若该条详情卡开着则一并关闭
- `markCollectionDataStale()` 标记变更，切回首页时自动刷新
- 轻点查看详情行为不受影响

## 二、零数据空态（新增，修复「页面没有内容」）

- **根因**：页面条件链没有「无搜索词且列表为空」的分支——长按删除清空测试数据后，内容区域直接空白
- 新增零数据空态：插图 + 「还没有收藏」+ 引导语 + 黑色胶囊按钮「去添加收藏」（跳拍照页）
- 说明：Mock 数据在每次重新编译时重新生成，测试删除的数据重新编译即恢复

## 三、编辑半窗 · 点击外部收起（bug 修复）

- **根因**：上一轮回退「详情卡置顶简化」时误删了 `setTabBarHidden` 的 import，但 `startEdit` / `closeDetail` 仍在调用——点击半窗外触发的 `cancelEdit → closeDetail` 抛 `ReferenceError`，`detailItem` 未清空，半窗卡死收不起来
- 修复：import 恢复三者齐全；「取消 / 保存」按钮走的同一 `closeDetail` 一并修好

## 四、首页

- **「查看全部」箭头**：文本字符 `→` 换成展架「共 N 件」同款 SVG 图标（`arrow-right.svg`，`#77736d` 描边、27rpx），两处箭头完全一致
- **副行对齐**：「最近15天 · N 件」与「查看全部」由底部对齐改为**垂直居中**（flex center，修复图片基线对齐导致的箭头偏高）
- **大卡片右上角光斑重做（两条黄色细线的根因修复）**：
  - 细线来源 ①：`.light-beam` 射灯反光细线元素；②：`indexBg.svg` 的光带——微信 `<image>` 不支持 SVG 滤镜，30px 高斯模糊不生效，光带硬边渲染
  - 修复：删除 `.light-beam` 与 SVG 内光带/滤镜定义，改为 **CSS 径向光晕**（`corner-glow`，radial-gradient 锚定卡片右上角），渲染稳定、天然无线条
  - 光晕范围多轮调整：420 → 320 → **260rpx**（最终）
- 挂袋区：银夹块顶部「黑点」修复——原 `conic-gradient` 拉丝的最暗扇区指向顶部形成深斑，改平滑纵向金属渐变并两轮调浅；端件光学上提 4rpx 试验后按用户要求**完全回退**（最终为几何居中）

## 五、拍照页

- **手电筒常亮**：camera `flash` 从 `'on'`（仅拍照闪光）改为 **`'torch'`**（持续点亮），点按开/关
- **相册 icon 对齐**：手电筒图形渲染 39×51rpx、相册仅 48×41rpx（宽扁形占比小）；相册盒子 56 → **64rpx**，渲染高 ≈46.6rpx（等高口径的折中值）

## 六、回退说明

- 「详情卡置顶简化」（删除 masked 机制改全 hidden）已按用户要求**完整回退**到 b3937b4 的实现；回退过程中引入的 `setTabBarHidden` 缺失 import 问题已在本文第三节修复
- 当前状态：详情卡/半窗打开 = masked 机制（底栏自绘蒙层压暗）；编辑半窗额外走 hidden 整条让位

## 涉及文件

`pages/library/index.vue`、`pages/showcase/index.vue`、`package-editor/pages/add/index.vue`、`components/settings-sheet/settings-sheet.vue`、`custom-tab-bar/{js,wxml,wxss}`、`services/{tab-bar,overlay,tab-bar}.ts`、`static/figma/indexBg.svg`
