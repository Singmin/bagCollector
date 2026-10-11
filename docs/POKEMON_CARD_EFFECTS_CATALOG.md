# Pokémon Cards CSS：功能特效目录与独立调用方案

研究日期：2026-10-11。上游：[simeydotme/pokemon-cards-css](https://github.com/simeydotme/pokemon-cards-css)，演示：[poke-holo.simey.me](https://poke-holo.simey.me/)。

源码核对版本：`acb1197633e749a1fba4412231db2f6581586d00`。本分支从 BagCollect 最新 `origin/main`（`a7cc8ea9903de1b91040f260d9a2f04f5069a3a0`）建立，仅新增本文档。

## 1. 先说明它是什么，以及“分别调用”的边界

这个仓库是 **Svelte 3 + Vite 的网页卡牌特效演示**，不是微信小程序，也不是安装后即可使用的通用特效 SDK。核心做法是：JS 接收指针或设备方向，把位置、角度、透明度等写入 CSS 变量；CSS 用 3D 变换、渐变、纹理、混合模式和蒙版模拟反光。

可以拆成三部分使用：

| 部分 | 能独立使用的能力 | 调用/实现方式 |
| --- | --- | --- |
| 交互 | 倾斜、回弹、放大居中、首次翻转、自动展示、设备方向跟随 | 抽出状态计算与动画控制器，再接对应平台输入 |
| 光效 | 跟随光斑、彩虹条纹、边缘辉光、纹理闪烁、局部遮罩 | 保留需要的渲染层，用共享位置状态驱动 |
| 材质预设 | 普通闪、反闪、星空闪、V/VMAX/VSTAR、彩虹、金色、银色等 | 选择一个材质配方；部分预设需要先加载基础材质，再加载修饰样式 |

**上游真实入口**是 `Card.svelte` / `CardProxy.svelte` 的组件属性，以及 CSS 的 `data-rarity` 等选择器。`interact()`、`popover()` 等是组件内部函数，未作为外部方法导出；上游也没有 `tilt=false`、`glare=false` 这样的逐项开关。本文第 5 节的统一接口属于**建议新增的封装**。

本文基于源码研究，不表示这些效果已在本分支接入或完成真机验证。工作时另一个分支 `feat/holo-card-effect` 已有 `docs/HOLO_CARD_EFFECT.md` 和部分组件；这些内容不在本次 `main` 基线中，也未合并进来。

## 2. 交互与基础光效：哪些可以单独做

下表的实现位置对应上游 [Card.svelte][card]、[base.css][base]、[cards.css][variables] 和 [orientation.js][orientation]。

| 功能 | 用户看到的效果 | 上游实现位置/驱动 | 如何单独实现或关闭 |
| --- | --- | --- | --- |
| 3D 倾斜 | 鼠标或手指移动时卡片左右、上下倾斜 | `interact()` → `springRotate`；rotator 的 `rotateY / rotateX` | 只保留旋转层和位置计算；角度固定为 0 即关闭，光效仍可移动 |
| 弹簧跟随 | 倾斜与光斑有柔和的滞后和回弹 | Svelte `spring`；`updateSprings()`、`interactEnd()` | 独立成动画控制器；所有渲染层共享平滑后的状态 |
| 光斑跟随（glare） | 光亮中心跟随指针移动 | `.card__glare` 径向渐变，圆心为 `--pointer-x/y` | 只保留 glare 层；不需要彩虹纹理或 3D 倾斜 |
| 彩虹/全息反射（shine） | 不同颜色的光带随角度移动 | `.card__shine` 及伪元素；`--background-x/y` | 选一个材质预设；不渲染 glare 层即可只显示全息纹理 |
| 边缘辉光与阴影 | 选中卡片出现彩色边光和浮起阴影 | `.card.active .card__rotator` 的 `box-shadow`；类型类设置 `--card-glow` | 可独立作为选中态；不需要跟随光斑或贴图 |
| 点击放大、居中 | 卡片从列表位置移动到视口中央 | `activate()`、`setCenter()`、`popover()`；translate、scale 两组 spring | 只保留外层位移/缩放；倾斜和材质可关闭 |
| 首次打开 360° 翻转 | 第一次放大时旋转一圈，途中看到背面 | `firstPop`、`springRotateDelta.x = 360`；正反面样式 | 保留正反面层和一次性角度动画；上游不是一个切换正反面的按钮 |
| 自动展示 | 首页示例卡无需操作也会摇摆、反光 | `showcase=true`；正弦/余弦更新旋转与光斑 | 单独接一个定时输入源；用户交互时停止自动输入 |
| 设备方向跟随 | 晃动手机改变卡片角度与反光位置 | `deviceorientation` → `orientate()`，仅对当前激活卡生效 | 独立成输入适配器；与手指输入复用同一状态计算 |
| 区域裁剪/蒙版 | 只让插画、背景或指定图案反光 | `clip-path`、`.masked`、`--mask` | 蒙版是渲染范围，能够配任一光效；需按 BagCollect 图形重做 |
| 正面加载过渡 | 图像未加载时显示背面，加载后出现正面 | `loading` 类、`imageLoader()`、`loading="lazy"` | 独立为加载态；与全息效果无关 |
| 单卡激活互斥 | 一张卡放大后，其余卡不响应跟随交互 | [activeCard.js][active] 的全局 store；`interact()` 检查 | 移植为活动卡 ID 状态，避免多个浮层同时展开 |
| 列表布局 | 宽屏三列，窄屏每组三张错位叠放 | [Cards.svelte][grid] 的媒体查询和 `nth-child` | 可单独采用；不必迁移到 BagCollect 现有列表 |

注意：上游普通悬停不会自动平移卡片到鼠标位置；XY 平移主要用于点击后居中。它也没有按主体深度自动分割的立体出框效果，`translateZ()` 主要用于正面、背面、shine、glare 的叠层。

### 2.1 共享状态与真实数值

以卡片区域内的指针位置 `px / py`（0～100）为输入：

```text
centerX = px - 50                 centerY = py - 50
rotateXVariable = -centerX / 3.5  → rotateY()，约 ±14.286°
rotateYVariable =  centerY / 3.5  → rotateX()，约 ±14.286°
backgroundX = 37 + px × 0.26      → 37%～63%
backgroundY = 33 + py × 0.34      → 33%～67%
distance = clamp(hypot(px - 50, py - 50) / 50, 0, 1)
```

上游变量名 `--rotate-x` 实际传给 `rotateY()`，`--rotate-y` 传给 `rotateX()`。移植时可以重新命名，但状态与渲染端必须一起改。

| CSS 变量组 | 用途 | 独立调用时的约定 |
| --- | --- | --- |
| `--pointer-x/y` | 径向高光位置 | 不做倾斜也要更新，才能让光斑移动 |
| `--pointer-from-center/top/left` | 控制亮度和不同方向纹理 | 不只是位置，可改变材质的强度与方向 |
| `--background-x/y` | 渐变与纹理偏移 | 各材质的偏移倍率不同，不统一改成 0～100% |
| `--rotate-x/y` | 3D 旋转 | 关闭倾斜时固定为 0° |
| `--card-opacity` | shine/glare 总体显隐 | 上游两层共用；要分别控制需拆成两个强度变量或移除对应层 |
| `--translate-x/y`、`--card-scale` | 弹出、退回 | 固定为 0px、1 即关闭放大位移 |
| `--mask`、`--foil` | 遮罩范围、蚀刻图案 | mask 控制哪里可见，foil 控制可见区域的纹理，二者不能互换 |
| `--seedx/y`、`--cosmosbg` | 随机种子与星空位置 | 每张卡初始化一次，避免每帧重新随机导致闪跳 |

跟随参数为 `stiffness=0.066, damping=0.25`；放大/位移为 `0.033 / 0.45`。移出后默认延迟 500ms，再以 `0.01 / 0.06` 回正。它们是 Svelte spring 的参数，不能不经换算就作为其他弹簧库的物理参数。

点击放大比例取 `min(视口宽/卡宽×0.9, 视口高/卡高×0.9, 1.75)`。首次打开把附加 Y 轴角度设到 360°，不是让卡片永久停在背面。`showcase` 在挂载约 2 秒后开始，每 20ms 更新目标，约 4 秒后停止；不是无限循环动画。

## 3. 材质特效目录：普通反光、20 种通用预设与专属覆盖

上游 `public/css/cards/` 共 23 个 CSS 文件：`base.css` 是骨架，`basic.css` 当前只有注释，另外 21 份包括 20 份通用材质/修饰样式和 1 份卡片专属覆盖。目录外的 `cards.css` 定义公共变量。**这 21 份不是彼此独立、可以任意同时叠加的插件**。下表先列普通反光入口，再列 20 个通用材质预设；普通反光实际来自 `base.css`。

下表“触发条件”是组件最终输出的 DOM 属性值，统一为小写。所有预设都需要骨架、公共变量和输入状态；“额外依赖”列只列素材及其他材质。

| # | 特效 / 文件 | 主要触发条件 | 视觉特点与实现 | 额外依赖 / 拆分要点 |
| --- | --- | --- | --- | --- |
| 1 | 普通卡 [basic.css][basic] | 不匹配其他材质，如 `common` | 普通表面光斑 + 3D 倾斜，无彩虹闪纹 | 文件为空壳；实际用 `base.css` 的 glare，适合独立做轻反光 |
| 2 | 普通全息 [regular-holo.css][regular] | `rarity="rare holo"` | 插画窗口内彩虹斜纹、扫描线、竖向亮条和径向光 | 主配方可由渐变构成；使用卡面布局裁剪，需重做区域 |
| 3 | 反向全息 [reverse-holo.css][reverse] | `rarity` 以 `reverse holo` 结尾 | 插画之外的背景/信息区闪，foil 图案随光改变 | 精细效果用 foil + mask；无 mask 分支用反向裁剪，取消 foil |
| 4 | 星空全息 [cosmos-holo.css][cosmos] | `rarity="rare holo cosmos"` | 三层星空与不同偏移的彩色光形成层次 | `cosmos-bottom.png`、`cosmos-middle-trans.png`、`cosmos-top-trans.png`；固定随机偏移 |
| 5 | Amazing Rare [amazing-rare.css][amazing] | `rarity="amazing rare"` | 双闪粉、彩色反射、局部图案亮度变化 | glitter + foil；mask 决定精细区域，无 mask 有插画窗口降级 |
| 6 | Radiant 菱格闪 [radiant-holo.css][radiant] | `rarity="radiant rare"` | 正反 45° 细纹构成交叉格纹，叠彩虹与闪粉 | glitter + foil；无 mask 时回退 `trainerbg.png` |
| 7 | V 斜向全息 [v-regular.css][v] | `rarity="rare holo v"`，或 `subtypes="v-union"` | 多组渐变向不同方向移动，叠颗粒，金属感较强 | `grain.webp`；可以不依赖卡片专用 foil |
| 8 | V Full Art [v-full-art.css][full] | `rarity="rare ultra"` + `supertype="pokémon"`；也覆盖 supporter 与 Gallery V | 彩虹光柱、斜向反射、蚀刻纹理，全画面质感 | foil + 可选 mask；无 mask 回退 `illusion.png` |
| 9 | VMAX [v-max.css][vmax] | `rarity="rare holo vmax"` | 较大、较缓的色带与明显底纹 | foil + 可选 mask；无 mask 回退 `vmaxbg.jpg` |
| 10 | VSTAR [v-star.css][vstar] | `rarity="rare holo vstar"` | 光柱与蚀刻叠加，亮度随指针到中心距离变化 | foil + 可选 mask；无 mask 回退 `ancient.png`；有 mask 使用多层蒙版 |
| 11 | Trainer Full Art [trainer-full-art.css][trainer] | `rarity="rare ultra"` + `subtypes` 包含 `supporter` | 调整全幅材质的亮度/饱和度，加柔光 | **先加载 `v-full-art.css`**；无 mask 回退 `trainerbg.png` |
| 12 | Rainbow Rare [rainbow-holo.css][rainbow] | `rarity="rare rainbow"` | 柔和彩虹底色、闪粉、多层亮暗混合 | glitter + foil；无 mask 回退 `illusion-mask.png` |
| 13 | Rainbow Alternate [rainbow-alt.css][rainbowalt] | `rarity="rare rainbow alt"`；或 Gallery VMAX | 更鲜艳的彩虹、闪粉与纹理，反光强度随位置变化 | glitter + foil；无 mask 时 foil 设为 none，保留彩虹闪粉 |
| 14 | Secret Rare 金闪 [secret-rare.css][gold] | `rarity="rare secret"`；另有指定 promo 例外 | 两层闪粉反向移动，形成金属闪烁 | glitter + foil；无 mask 回退 `geometric.png` |
| 15 | Trainer Gallery Holo [trainer-gallery-holo.css][gallery] | `rarity="rare holo"` + `trainer-gallery=true`；也有完整 Gallery 名称与 promo 例外 | 全幅彩虹及特殊高光，区别于普通插画窗口闪 | 用卡边范围裁剪；不等同于普通 `regular-holo` |
| 16 | Trainer Gallery V [trainer-gallery-v-regular.css][galleryv] | `rarity="rare holo v"` + `trainer-gallery=true` | Gallery V 全幅纹理，减弱 glare | **先加载 `v-full-art.css`**；本文件主要把 glare 强度降到 0.4 倍 |
| 17 | Trainer Gallery VMAX [trainer-gallery-v-max.css][galleryvmax] | `rarity="rare holo vmax"` + `trainer-gallery=true` | 彩虹闪粉底上调整径向高光，边缘位置反光更明显 | **先加载 `rainbow-alt.css`**；本文件主要改 glare |
| 18 | Trainer Gallery Secret [trainer-gallery-secret-rare.css][gallerygold] | `rarity="rare secret"` + `trainer-gallery=true` | 黑金色底、闪粉、foil 蚀刻对比 | glitter + foil；样式显式清除 shine 各层 mask，不能假设它沿用普通蒙版 |
| 19 | Shiny Rare 银闪 [shiny-rare.css][shiny] | `rarity="rare shiny"` | 插画窗口内银色感与彩色反射，差值/排除混合 | foil + 可选 mask；无 mask 回退 `illusion.png` |
| 20 | Shiny V [shiny-v.css][shinyv] | `rarity="rare shiny v"` | 全幅银色蚀刻与亮暗反射 | foil + 可选 mask；无 mask 回退 `illusion.png`，glare 配方不同 |
| 21 | Shiny VMAX [shiny-vmax.css][shinyvmax] | `rarity="rare shiny vmax"` | 双闪粉和彩色/银色反射，局部 foil | glitter + foil；没有同类明确的 `NO MASK` 回退配方，需提供素材或自定降级 |

还有一份卡片专属覆盖 [swsh-pikachu.css][pikachu]：`rarity="rare secret"`、`set="swsh12pt5"`、`number="160"` 同时满足时，改成特殊彩虹闪粉反射。它是 `secret-rare` 家族中的指定卡片覆盖，**不额外作为通用材质计数**。选用该覆盖时按上游顺序置于 `secret-rare.css` 之后。

Alternate Art V 不对应一个单独 CSS 文件：`CardProxy.svelte` 识别卡片 ID，主要调整 foil/mask 素材，视觉配方沿用全幅材质；Alternate VMAX 则可能映射为 `rare rainbow alt`。

### 3.1 为什么有些 CSS 不能只引一份

上游 [index.html][entry] 按固定顺序导入全部材质，依靠选择器范围和后续覆盖组合。独立调用时应保留依赖关系：

```text
基础：base.css → cards.css（公共变量）→ 选定材质
Trainer Full Art：v-full-art.css → trainer-full-art.css
Trainer Gallery V：v-regular.css → v-full-art.css → trainer-gallery-v-regular.css
Trainer Gallery VMAX：v-max.css → rainbow-alt.css → trainer-gallery-v-max.css
Trainer Gallery Secret：secret-rare.css → trainer-gallery-secret-rare.css
指定 Pikachu：secret-rare.css → swsh-pikachu.css
```

前两组 Gallery 中普通 V/VMAX 的基础规则仍可能贡献伪元素或高光，保留上游顺序更稳妥。若想最终只保留一个文件，需要把它的有效规则合并成新的材质配方，再对照演示验证。

BagCollect 的业务数据不应塞入宝可梦 `rarity / set / number` 字段。建议把上表转成 `material="cosmos"`、`material="gold"` 等独立视觉枚举，每张卡选一个材质，再选择是否启用 tilt/glare/glow/popover。多个材质直接同时套 class 会互相覆盖 background、filter 和伪元素。

## 4. 上游已有的调用方式

### 4.1 Svelte：直接调用 Card，显式传素材

以下示例用于**上游 Svelte 工程**，不是 BagCollect Vue 小程序可直接粘贴的代码。前提是按上一节加载基础 CSS 与所选材质。

```svelte
<script>
  import Card from './lib/components/Card.svelte';
</script>

<!-- 普通卡：只有基础光斑和倾斜 -->
<Card id="plain-demo" name="Plain" rarity="common" img="https://example.com/card.png" />

<!-- 普通全息：采用渐变配方，无需自动拼接宝可梦 CDN 素材 -->
<Card id="holo-demo" name="Holo" rarity="rare holo" img="https://example.com/card.png" />

<!-- 金闪：显式提供纹理与蒙版，避免绑定宝可梦卡号 -->
<Card
  id="gold-demo" name="Gold" rarity="rare secret"
  img="https://example.com/card.png"
  foil="https://example.com/foil.webp"
  mask="https://example.com/mask.webp"
  showcase={true}
/>
```

`Card` 提供的属性包括：`id / name / number / set / types / subtypes / supertype / rarity / img / back / foil / mask / showcase`。`types` 与 `subtypes` 可为数组，会转换为小写、空格分隔的字符串；`rarity` 等也会转成小写。

如果需要完整宝可梦卡数据映射，则使用 [CardProxy.svelte][proxy]：它提供相同的数据/图片属性，额外提供 `isReverse`，并识别 Gallery、Shiny、Alternate Art 和 Promo。设置 `isReverse=true` 会把稀有度追加成 `… Reverse Holo`。

Proxy 未显式传 foil/mask 时，会根据卡号和 `VITE_CDN` 自动拼接外部素材路径。传 `foil={false}` 或 `mask={false}` 可禁止相应自动素材。**BagCollect 单张袋子图的接入优先采用显式素材和独立材质枚举，避免依赖这套自动映射。** 示例域名仅作占位，不能作为可运行素材。

### 4.2 原生网页：只复用结构、样式和状态

可将 Svelte 换为 Vue/React 或原生 JS：保留 `card → translater → rotator → back/front → image/shine/glare` 分层，把输入计算结果写到根元素的 style。位移缩放和旋转分层，方便分别动画，也避免多个控制器覆盖同一个 transform。

最小光效组合的实现方法：

| 想单独调用什么 | 要保留的层 | 要更新的状态 |
| --- | --- | --- |
| 只有 3D 倾斜 | rotator + image | rotate 两个角度；无须 shine/glare |
| 只有光斑 | image + glare | pointer、glare 强度；rotate 固定为 0 |
| 只有彩虹全息 | image + shine（含该材质需要的子层） | background、pointer 派生值、shine 强度 |
| 只有边缘发光 | image + 外框 | glow 色与选中状态 |
| 只有放大翻转 | translater + rotator + 正反面 | translate、scale、附加翻转角度 |
| 倾斜 + 光斑 + 某个材质 | 完整渲染结构 | 全部共享状态，所有层接收同一帧结果 |

`base.css` 还提供非 `.interactive` 卡片的固定 hover 姿态（固定光斑、角度、1.1 倍缩放），适合简单网页展示；这是定点悬停过渡，不是连续跟随指针。独立于框架使用时还需自行初始化动态 CSS 变量默认值。

## 5. 建议在 BagCollect 新增的可组合接口

本节是接口设计草案，**本分支尚未创建这些文件、组件或方法**。

建议分成四层：`input` 接输入，`controller` 计算/平滑状态，`material` 选择配方，`renderer` 绘制图像和光效。这样同一个 controller 可接微信触摸、设备方向或自动展示，也可分别驱动管理后台 CSS 与小程序渲染。

```ts
// 建议接口，尚未实现
interface CardEffectsOptions {
  material: 'none' | 'holo' | 'reverse' | 'cosmos' | 'amazing' | 'radiant'
    | 'v' | 'full-art' | 'vmax' | 'vstar' | 'trainer-full-art'
    | 'rainbow' | 'rainbow-alt' | 'gold' | 'gallery-holo' | 'gallery-v'
    | 'gallery-vmax' | 'gallery-gold' | 'shiny' | 'shiny-v' | 'shiny-vmax';
  tilt?: boolean;
  glare?: boolean;
  glow?: boolean;
  popover?: boolean;
  flipOnFirstOpen?: boolean;
  input?: 'touch' | 'pointer' | 'orientation' | 'showcase' | 'none';
  maxTiltDeg?: number;
  shineOpacity?: number;
  glareOpacity?: number;
  maskSrc?: string;
  foilSrc?: string;
}

// 建议控制器：x/y 为卡片区域的归一化位置 [0,1]
interface CardEffectsController {
  setPointer(x: number, y: number): void;
  setOrientation(betaDeg: number, gammaDeg: number): void;
  setMaterial(material: CardEffectsOptions['material']): void;
  open(): void;
  close(): void;
  reset(): void;
  pause(): void;
  resume(): void;
  destroy(): void;
}
```

| 调用目标 | 建议配置 | 需要实现的内容 |
| --- | --- | --- |
| 只倾斜 | `material:'none', tilt:true, glare:false, glow:false` | touch/pointer → 角度 → transform |
| 只光斑 | `material:'none', tilt:false, glare:true` | touch/pointer → 径向渐变圆心 |
| 只彩虹闪 | `material:'holo', tilt:false, glare:false` | 独立 shine 配方；移除上游专用插画裁剪 |
| 星空闪 | `material:'cosmos', tilt:true, glare:true` | 星空素材、三层偏移与共享位置状态 |
| 金色闪粉 | `material:'gold', tilt:true, glare:true` | 双闪粉、foil、需要时的 mask |
| 点击居中翻转 | `material:'none', popover:true, flipOnFirstOpen:true` | 位移缩放、正反面、首次状态、关闭退回 |
| 静态纹理展示 | `input:'none', material:'rainbow', shineOpacity:0.5` | 固定中心位置与非零 shine 强度；不得依赖交互才显现 |

`material:'none'` 仅关闭材质层，独立 glare 仍可启用；`input` 决定谁供给位置，不决定用哪种材质。`flipOnFirstOpen` 需要 `popover`，普通细节浮层可完全关闭翻转。

对透明袋子图，优先提供“图像 + 光效覆盖”版本，不强制添加宝可梦比例的矩形卡底。光效的 mask、图像的 `aspectFit` 留白和外层变换必须对齐；图像与光效层共用同一个盒子和变换，避免袋子动了、反光留在原处。

## 6. 微信小程序如何实现

BagCollect 的 `main` 是 uni-app Vue 3 + TypeScript，只构建 `mp-weixin`。网页的 DOM 事件、Svelte store 和整份 CSS 都需要适配。

| 上游网页机制 | 微信小程序方案 | 核对边界 |
| --- | --- | --- |
| `pointermove`、`getBoundingClientRect()` | `touchstart/move/end/cancel` + `uni.createSelectorQuery().in(instance).boundingClientRect()` | 统一坐标系；缓存未旋转的稳定容器尺寸，在布局变化/展开后重测 |
| CSS 属性选择器与类型类 | 输出明确的 `.material-holo`、`.tone-*` 类 | 不依赖网页选择器原样通过编译 |
| `:root` 和元素/通配选择器 | 公共变量移到组件根 class，改为组件类选择器 | DCloud 文档说明自定义组件的选择器限制；不能整份照搬 |
| `::before/after` 多层反光 | 支持时保留；复杂叠层优先显式 `<view>` | 显式层便于绑定每层样式、禁用和排查 |
| CSS 变量里的 `calc()` | 可保留经验证的变量；复杂偏移在 TS 内算好，绑定完整 style 值 | 未做真机验证前，不承诺变量、混合和 calc 的跨设备表现 |
| `mix-blend-mode`、`background-blend-mode`、filter | 先做选定渲染环境的小样；表现不一致时减层，或用 Canvas 2D 合成近似配方 | 混合模式依赖底图、隔离和渲染器，不能保证同网页逐像素一致 |
| `clip-path / mask-image` | 简单范围裁剪；复杂透明轮廓可用预制 alpha 遮罩或 Canvas 合成 | 宝可梦插画窗口坐标不能套到袋子图；透明素材不是整张矩形蒙版 |
| `/img/*.png` CSS 本地背景 | 小纹理转 base64，或使用合规 HTTPS 地址；Canvas/独立 image 层另行加载 | 小程序 CSS 的本地图片限制见 DCloud 文档；不能只凭开发工具显示判断真机可用 |
| `deviceorientation` | 通过 `startDeviceMotionListening / onDeviceMotionChange` 接平台方向数据 | 本项目安装的 DCloud 类型声明已确认 API 存在；事件单位、符号和横竖屏需校准，不直接套网页值 |
| 浏览器 `requestAnimationFrame` | 选择目标环境的帧调度能力；Canvas 2D 可用其帧调度，普通组件需单一合并更新调度器 | 不直接依赖浏览器全局；30fps 可作为初始调优目标，不是实测结果 |
| `document.visibilitychange` | 页面 `onHide/onShow` + 组件卸载 | 停动画/设备监听，清定时器与回弹任务；再次进入重新校准 |

DCloud 的[样式与布局文档](https://uniapp.dcloud.net.cn/tutorial/syntax-css)支持动态 style 绑定，并说明选择器及背景图片的适配限制。以上高级 CSS 项仍需在项目实际渲染环境中逐项验证；当前 `manifest.json / pages.json` 未显式选择 Skyline，本文也没有把它当成已确认启用的渲染器。

方向跟随建议只用于放大后的当前卡：记录首次采样为基准，计算相对方向，转换为度再 clamp；若平台数据已经是度则不要重复转换。上游网页对 gamma/beta 限制为 ±16°/±18°。这里只确认了 API 类型，微信官方方向文档本次访问失败，未验证目标真机的数据单位，必须在适配器中落实后再使用这些阈值。

若走 Canvas，先合成袋子底图、foil/闪粉、色带，再用 alpha mask 限定反光范围，最后合成 glare。把复杂颜色混合放到离屏画布，最终图层放回稳定展示盒；Canvas 绘制不自动提供 DOM 卡片翻转，需要另做容器变换或相应渲染。

## 7. 演示应用里的其他功能

这些功能可单独借鉴，但不属于材质引擎：

| 功能 | 源码与现状 | 可复用的方式 |
| --- | --- | --- |
| 卡片分类浏览 | `App.svelte` 读 `/data/cards.json`，按固定数组切片分组 | 改为 BagCollect 数据和材质分组；不要照抄数组切片当业务分类 |
| 搜索 | `Search.svelte` 用 `pokemontcgsdk` 查询，长度 >2 才启动，防抖 666ms，最多取 36 条 | 可以借鉴防抖/加载/空态，数据源改成现有 BagCollect API |
| 搜索演示变体 | Common/Uncommon 搜索结果可能随机标记 Reverse Holo | 这是演示选择，不应据此随机改变 BagCollect 用户收藏材质 |
| 加载/错误态 | 正面图片 lazy loading；搜索错误显示提示与示例卡 | 小程序用 image load/error 事件；保留真实错误，避免示例卡冒充用户数据 |
| 分类锚点/回到顶部 | 标题链接与页面 hash，移动布局叠卡 | 按本项目导航/滚动方式重做 |

源码提供搜索逻辑不代表本次验证了外部 Pokémon API、CDN 素材或线上演示交互可用。Google Analytics 埋点也不是视觉效果的一部分，无须随组件迁移。

## 8. 面向 BagCollect 的推荐组合与实现顺序

以下是产品/工程建议，不是本分支已完成的改动。

| 页面或场景 | 推荐组合 | 原因 |
| --- | --- | --- |
| 收藏列表 | 静态图片，最多一次轻选中辉光 | 列表卡多，优先保证滚动；不让每张卡常驻动画和传感器 |
| 收藏详情中的透明袋子 | 独立光效覆盖 + alpha mask，默认轻 glare，可选 holo | 保留现有袋子形状和图片比例，避免把透明边缘染成矩形 |
| 单卡放大预览 | 小角度 tilt + glare + 一个材质；popover 单独开启 | 交互集中在一张卡，材质可按需切换 |
| 特别收藏展示 | gold / cosmos / rainbow 三选一，触摸时启用 | 视觉辨识度高，素材和层数也更高 |
| 管理后台材质演示 | 各材质并排样本，鼠标移动驱动，独立开关 glare/tilt | 浏览器适合作为配方对照与素材预览 |

建议按这个顺序实现：

1. **基础状态与开关**：静态图、触摸坐标归一化、tilt/glare 独立、释放后回正，先确保普通交互可靠。
2. **单个 holo 配方**：shine/glare 分开控制，适配透明袋子 mask，解决位置与缩放对齐。
3. **popover/翻转**：独立状态机，退出退回；首次翻转可关闭，避免与详情点击冲突。
4. **扩展材质**：先 V，再 cosmos、rainbow、gold；每个预设记录素材依赖与无素材降级。
5. **方向与自动展示**：同一共享输入源、基准校准、优先级（触摸暂时接管方向/展示）、页面隐藏时清理。

实现后的验收应至少覆盖：单开倾斜、单开 glare、单开 shine、材质切换、透明区域不溢光、卡片缩放与光效对齐、touchcancel 回正、滚动不被误拦、页面隐藏后无动画/方向监听、iOS/Android 真机和素材失败降级。本次只有文档，不以构建或开发工具截图代替这些运行验收。

## 9. 源码定位与素材说明

| 源码 | 研究内容 |
| --- | --- |
| [Card.svelte][card] | 属性、交互坐标、spring、弹出/退回、翻转、自动展示、动态样式 |
| [CardProxy.svelte][proxy] | 稀有度映射、Gallery/Promo/Alternate/Shiny、foil/mask 路径 |
| [base.css][base] + [cards.css][variables] | DOM 叠层、背面、基础光斑、边缘光、公共色彩与裁剪变量 |
| [index.html][entry] | 全部材质的实际加载顺序 |
| [orientation.js][orientation] + [activeCard.js][active] | 相对设备方向、激活卡互斥 |
| [Math.js][math] | clamp、round、区间映射 |
| [App.svelte][app]、[Search.svelte][search]、[Cards.svelte][grid] | 演示分组、搜索、列表布局 |
| [public/img][assets] | grain、glitter、cosmos、illusion、geometric 等本地纹理 |

上游 [LICENSE][license] 标为 GPL-3.0；[README][readme] 另列了部分背景/星空素材来源。正式引入源码或素材时应保留相应来源和许可记录。本文没有复制上游组件或素材，也没有对 BagCollect 现有分支的许可状态作整体结论。

以下源码链接固定在本次核对提交，便于后续复查：

[card]: https://github.com/simeydotme/pokemon-cards-css/blob/acb1197633e749a1fba4412231db2f6581586d00/src/lib/components/Card.svelte
[proxy]: https://github.com/simeydotme/pokemon-cards-css/blob/acb1197633e749a1fba4412231db2f6581586d00/src/lib/components/CardProxy.svelte
[base]: https://github.com/simeydotme/pokemon-cards-css/blob/acb1197633e749a1fba4412231db2f6581586d00/public/css/cards/base.css
[variables]: https://github.com/simeydotme/pokemon-cards-css/blob/acb1197633e749a1fba4412231db2f6581586d00/public/css/cards.css
[entry]: https://github.com/simeydotme/pokemon-cards-css/blob/acb1197633e749a1fba4412231db2f6581586d00/index.html
[orientation]: https://github.com/simeydotme/pokemon-cards-css/blob/acb1197633e749a1fba4412231db2f6581586d00/src/lib/stores/orientation.js
[active]: https://github.com/simeydotme/pokemon-cards-css/blob/acb1197633e749a1fba4412231db2f6581586d00/src/lib/stores/activeCard.js
[math]: https://github.com/simeydotme/pokemon-cards-css/blob/acb1197633e749a1fba4412231db2f6581586d00/src/lib/helpers/Math.js
[app]: https://github.com/simeydotme/pokemon-cards-css/blob/acb1197633e749a1fba4412231db2f6581586d00/src/App.svelte
[search]: https://github.com/simeydotme/pokemon-cards-css/blob/acb1197633e749a1fba4412231db2f6581586d00/src/Search.svelte
[grid]: https://github.com/simeydotme/pokemon-cards-css/blob/acb1197633e749a1fba4412231db2f6581586d00/src/Cards.svelte
[assets]: https://github.com/simeydotme/pokemon-cards-css/tree/acb1197633e749a1fba4412231db2f6581586d00/public/img
[license]: https://github.com/simeydotme/pokemon-cards-css/blob/acb1197633e749a1fba4412231db2f6581586d00/LICENSE
[readme]: https://github.com/simeydotme/pokemon-cards-css/blob/acb1197633e749a1fba4412231db2f6581586d00/README.md
[basic]: https://github.com/simeydotme/pokemon-cards-css/blob/acb1197633e749a1fba4412231db2f6581586d00/public/css/cards/basic.css
[regular]: https://github.com/simeydotme/pokemon-cards-css/blob/acb1197633e749a1fba4412231db2f6581586d00/public/css/cards/regular-holo.css
[reverse]: https://github.com/simeydotme/pokemon-cards-css/blob/acb1197633e749a1fba4412231db2f6581586d00/public/css/cards/reverse-holo.css
[cosmos]: https://github.com/simeydotme/pokemon-cards-css/blob/acb1197633e749a1fba4412231db2f6581586d00/public/css/cards/cosmos-holo.css
[amazing]: https://github.com/simeydotme/pokemon-cards-css/blob/acb1197633e749a1fba4412231db2f6581586d00/public/css/cards/amazing-rare.css
[radiant]: https://github.com/simeydotme/pokemon-cards-css/blob/acb1197633e749a1fba4412231db2f6581586d00/public/css/cards/radiant-holo.css
[v]: https://github.com/simeydotme/pokemon-cards-css/blob/acb1197633e749a1fba4412231db2f6581586d00/public/css/cards/v-regular.css
[full]: https://github.com/simeydotme/pokemon-cards-css/blob/acb1197633e749a1fba4412231db2f6581586d00/public/css/cards/v-full-art.css
[vmax]: https://github.com/simeydotme/pokemon-cards-css/blob/acb1197633e749a1fba4412231db2f6581586d00/public/css/cards/v-max.css
[vstar]: https://github.com/simeydotme/pokemon-cards-css/blob/acb1197633e749a1fba4412231db2f6581586d00/public/css/cards/v-star.css
[trainer]: https://github.com/simeydotme/pokemon-cards-css/blob/acb1197633e749a1fba4412231db2f6581586d00/public/css/cards/trainer-full-art.css
[rainbow]: https://github.com/simeydotme/pokemon-cards-css/blob/acb1197633e749a1fba4412231db2f6581586d00/public/css/cards/rainbow-holo.css
[rainbowalt]: https://github.com/simeydotme/pokemon-cards-css/blob/acb1197633e749a1fba4412231db2f6581586d00/public/css/cards/rainbow-alt.css
[gold]: https://github.com/simeydotme/pokemon-cards-css/blob/acb1197633e749a1fba4412231db2f6581586d00/public/css/cards/secret-rare.css
[gallery]: https://github.com/simeydotme/pokemon-cards-css/blob/acb1197633e749a1fba4412231db2f6581586d00/public/css/cards/trainer-gallery-holo.css
[galleryv]: https://github.com/simeydotme/pokemon-cards-css/blob/acb1197633e749a1fba4412231db2f6581586d00/public/css/cards/trainer-gallery-v-regular.css
[galleryvmax]: https://github.com/simeydotme/pokemon-cards-css/blob/acb1197633e749a1fba4412231db2f6581586d00/public/css/cards/trainer-gallery-v-max.css
[gallerygold]: https://github.com/simeydotme/pokemon-cards-css/blob/acb1197633e749a1fba4412231db2f6581586d00/public/css/cards/trainer-gallery-secret-rare.css
[shiny]: https://github.com/simeydotme/pokemon-cards-css/blob/acb1197633e749a1fba4412231db2f6581586d00/public/css/cards/shiny-rare.css
[shinyv]: https://github.com/simeydotme/pokemon-cards-css/blob/acb1197633e749a1fba4412231db2f6581586d00/public/css/cards/shiny-v.css
[shinyvmax]: https://github.com/simeydotme/pokemon-cards-css/blob/acb1197633e749a1fba4412231db2f6581586d00/public/css/cards/shiny-vmax.css
[pikachu]: https://github.com/simeydotme/pokemon-cards-css/blob/acb1197633e749a1fba4412231db2f6581586d00/public/css/cards/swsh-pikachu.css
