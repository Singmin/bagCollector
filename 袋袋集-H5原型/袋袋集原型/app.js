// ═══ 藏品数据 ═══
// image 指向 ./images/ 下的素材图；命名规则：品牌-款式.png
// 素材未就位时（图片加载失败）会自动兜底成 CSS 手绘纸袋，不会出现碎图。
const items = [
  // ── 霸王茶姬 ──
  {
    id: 'chagee-scenery', name: '山水风景手提袋', shelf: '霸王茶姬', type: 'image',
    image: 'images/chagee-scenery.png', tags: ['茶饮', '艺术'], date: '2026.09.15',
    size: '中号 · 260×320mm', material: '白卡纸覆哑膜',
    note: '袋身是层叠的蓝绿山水笔触，远处有两个人影。收进来时还留着茶的余温。'
  },
  {
    id: 'chagee-lime', name: '柠檬绿叶手提袋', shelf: '霸王茶姬', type: 'image',
    image: 'images/chagee-lime.png', tags: ['茶饮', '植物'], date: '2026.09.13',
    size: '中号 · 260×320mm', material: '白卡纸覆哑膜',
    note: '青柠与白花铺满整面，颜色很亮。夏天拎出去像带了一袋降温的绿。'
  },
  {
    id: 'chagee-blossom', name: '青花杏花手提袋', shelf: '霸王茶姬', type: 'image',
    image: 'images/chagee-blossom.png', tags: ['茶饮', '国风'], date: '2026.09.11',
    size: '中号 · 260×320mm', material: '白卡纸覆哑膜',
    note: '青底白杏花，枝干缠成一片。三只茶姬里留了这只，纹样最耐看。'
  },

  // ── 瑞幸咖啡 ──
  {
    id: 'luckin-crocs', name: 'CROCS 联名手提袋', shelf: '瑞幸咖啡', type: 'image',
    image: 'images/luckin-crocs.png', tags: ['咖啡', '联名'], date: '2026.09.14',
    size: '中号 · 250×310mm', material: '铜版纸覆膜',
    note: '桃粉底上堆满蓝绿立体字，每个字母里塞了热带小插画。联名款里最花的一只。'
  },
  {
    id: 'luckin-allin', name: 'ALL IN 拥抱手提袋', shelf: '瑞幸咖啡', type: 'image',
    image: 'images/luckin-allin.png', tags: ['咖啡', '插画'], date: '2026.09.14',
    size: '中号 · 250×310mm', material: '白卡纸覆哑膜',
    note: '满版拥抱的人，衣服颜色拼在一起像马赛克。下面一颗大心写着 ALL IN。'
  },
  {
    id: 'luckin-kitty', name: 'Hello Kitty 联名手提袋', shelf: '瑞幸咖啡', type: 'image',
    image: 'images/luckin-kitty.png', tags: ['咖啡', '联名'], date: '2026.09.12',
    size: '中号 · 250×310mm', material: '白卡纸覆亮膜',
    note: 'Hello Kitty 骑着小摩托，蝴蝶结是标志性的粉。袋底压了一排 HAPPY LUCKIN。'
  },
  {
    id: 'luckin-summer', name: 'SUMMER 夏日手提袋', shelf: '瑞幸咖啡', type: 'image',
    image: 'images/luckin-summer.png', tags: ['咖啡', '夏日'], date: '2026.09.10',
    size: '中号 · 250×310mm', material: '铜版纸覆膜',
    note: '深蓝底上撒满沙滩球、墨镜、棕榈树，SUMMER 用了两个颜色分色印。'
  },
  {
    id: 'luckin-hand', name: 'LUCK IN HAND 手提袋', shelf: '瑞幸咖啡', type: 'image',
    image: 'images/luckin-hand.png', tags: ['咖啡', '联名'], date: '2026.09.09',
    size: '中号 · 250×310mm', material: '白卡纸覆哑膜',
    note: '和 MINISO、Yoyo 三方联名。红斗篷小人在蓝底上举着手，配色很干净。'
  },
  {
    id: 'luckin-grid', name: '九宫格拼贴手提袋', shelf: '瑞幸咖啡', type: 'image',
    image: 'images/luckin-grid.png', tags: ['咖啡', '拼贴'], date: '2026.09.07',
    size: '窄版 · 220×300mm', material: '白卡纸覆哑膜',
    note: '被划成八格漫画，每格一个场景。窄长比例让格子排得很整齐。'
  },

  // ── Peet's Coffee ──
  {
    id: 'peets-flower', name: '手工之花手提袋', shelf: "Peet's Coffee", type: 'image',
    image: 'images/peets-flower.png', tags: ['咖啡', '艺术'], date: '2026.09.08',
    size: '中号 · 250×320mm', material: '白卡纸覆哑膜',
    note: '橙金色大理石纹拧成一朵花，THE FLOWER OF Handcraft 压在中间。纸面有点粗粝的手感。'
  },
  {
    id: 'peets-autumn', name: '秋日私语手提袋', shelf: "Peet's Coffee", type: 'image',
    image: 'images/peets-autumn.png', tags: ['咖啡', '植物'], date: '2026.09.06',
    size: '中号 · 250×320mm', material: '白卡纸覆哑膜',
    note: '奶油底上两朵大花，橙黄渐变像水彩刚洇开。Whispers OF AUTUMN。'
  },
  {
    id: 'peets-kraft', name: '经典牛皮纸手提袋', shelf: "Peet's Coffee", type: 'image',
    image: 'images/peets-kraft.png', tags: ['咖啡', '牛皮纸'], date: '2026.09.05',
    size: '中号 · 250×310mm', material: '牛皮纸（本色）',
    note: '最经典的一只，只印了 Peet\'s 大 logo。牛皮纸的褶痕留得很好看。'
  },
  {
    id: 'peets-slim', name: '窄版牛皮纸手提袋', shelf: "Peet's Coffee", type: 'image',
    image: 'images/peets-slim.png', tags: ['咖啡', '窄版'], date: '2026.09.03',
    size: '窄版 · 170×300mm', material: '牛皮纸（本色）',
    note: '尺寸偏窄，Peet\'s 是竖排的。适合装单杯，拎着不占手。'
  },

  // ── 城市纸袋 ──
  {
    id: 'more-crocs', name: 'CROCS 联名手提袋（复刻）', shelf: '城市纸袋', type: 'image',
    image: 'images/more-crocs.png', tags: ['联名', '复刻'], date: '2026.09.02',
    size: '中号 · 250×310mm', material: '铜版纸覆膜',
    note: '同款 CROCS 联名，这张是浅色版本。两只放一起看，底色差别挺明显。'
  },
  {
    id: 'more-allin', name: 'ALL IN 拥抱手提袋（复刻）', shelf: '城市纸袋', type: 'image',
    image: 'images/more-allin.png', tags: ['插画', '复刻'], date: '2026.08.31',
    size: '中号 · 250×310mm', material: '白卡纸覆哑膜',
    note: '和白底那张构图一样，这张裁切比例更方一些。'
  },
  {
    id: 'more-summer', name: 'SUMMER 夏日手提袋（复刻）', shelf: '城市纸袋', type: 'image',
    image: 'images/more-summer.png', tags: ['夏日', '复刻'], date: '2026.08.26',
    size: '中号 · 250×310mm', material: '铜版纸覆膜',
    note: '深蓝底那款的重印版，图案元素和配色完全一致。'
  }
];

let uploadedImage = '';

// ═══ 数据时间口径 ═══
// 需求：日期形如 '2026.09.15'，以此换算「距今多少天」，用于
//   ①「最近收藏」只统计最近 15 天  ② 卡片上的「最近」角标
const RECENT_WINDOW_DAYS = 15;

function parseItemDate(value) {
  if (!value) return null;
  const m = String(value).match(/(\d{4})\D+(\d{1,2})\D+(\d{1,2})/);
  if (!m) return null;
  const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  return Number.isNaN(d.getTime()) ? null : d;
}

// 收藏日期显示成 2026/08/08 —— 与原型图一致，月日补零两位
function formatDate(value) {
  const d = parseItemDate(value);
  if (!d) return String(value || '');
  const p = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}/${p(d.getMonth() + 1)}/${p(d.getDate())}`;
}

// 以「藏品里最新的那一天」作为今天，避免原型用的是固定日期而永远算成"很久以前"。
function latestItemDate() {  return items.reduce((acc, item) => {
    const d = parseItemDate(item.date);
    return d && (!acc || d > acc) ? d : acc;
  }, null);
}

function daysAgo(item) {
  const d = parseItemDate(item.date);
  const base = latestItemDate();
  if (!d || !base) return Infinity;
  return Math.round((base - d) / 86400000);
}

function isRecentItem(item) { return daysAgo(item) <= RECENT_WINDOW_DAYS; }

// 最近 15 天内的藏品，由新到旧，最多 6 张（挂袋吧台的展示上限）。
function recentItems(limit = 6) {
  return items.filter(isRecentItem).sort((a, b) => daysAgo(a) - daysAgo(b)).slice(0, limit);
}

function recentCount() { return items.filter(isRecentItem).length; }



const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];
const escapeHTML = value => String(value).replace(/[&<>'"]/g, character => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;'
}[character]));

// 纸袋占位图（纯 CSS 绘制）：当真实图片缺失时兜底，
// 保证原型在任何环境下都不会出现"碎图"图标。
function paperBagMarkup(item) {
  const style = item.style || bagColorClassFor(Math.max(0, items.indexOf(item)) % BAG_COLOR_CLASSES.length);
  return `<div class="paper-bag ${style}"><span class="bag-handle"></span><span class="bag-copy">PRIVATE<br/><b>OBJECT</b><br/>ARCHIVE</span><span class="bag-seal">${String(item.id).length}</span></div>`;
}

function objectMarkup(item) {
  if (item.image) {
    // 数据里带 image 字段就优先用真图；原型未附带 PNG 时由
    // repairBrokenImages() 在渲染后兜底替换成 CSS 纸袋。
    return `<img class="bag-photo" src="${item.image}" alt="${escapeHTML(item.name)}" data-fallback-id="${escapeHTML(item.id)}" />`;
  }
  return paperBagMarkup(item);
}

// 图片资源缺失时（原型只带代码、不带图），把破图就地换成 CSS 纸袋占位图。
function repairBrokenImages(root = document) {
  root.querySelectorAll('img.bag-photo').forEach(img => {
    img.addEventListener('error', () => {
      const item = items.find(i => i.id === img.dataset.fallbackId);
      const holder = document.createElement('div');
      holder.innerHTML = paperBagMarkup(item || { id: img.dataset.fallbackId || 'x' });
      img.replaceWith(holder.firstElementChild);
    }, { once: true });
  });
}

function itemButton(item) {
  // 网格卡片只展示图片、不展示文案，所以名字/展示架/日期靠 aria-label 传达，
  // 否则读屏用户面对的是一排没有标签的图片。
  // strong/small 仍留在 DOM 里（被 CSS 隐藏），供详情弹窗以外的场景复用。
  const label = `${escapeHTML(item.name)}，${escapeHTML(item.shelf)}，${escapeHTML(item.date)}`;
  return `<button class="grid-card js-item" data-item="${item.id}" aria-label="${label}"><div class="grid-art">${objectMarkup(item)}</div><strong>${escapeHTML(item.name)}</strong><small>${escapeHTML(item.shelf)} · ${escapeHTML(item.date.slice(5))}</small></button>`;
}

// ═══ 挂袋吧台：最近收集 ═══
// 用带回复力和阻尼的简易弹簧模型模拟悬挂卡片的物理摆动：
// 静止时角度归零，拨动松手后角度逐渐衰减回到基准角度。
let rackStates = [];
let rackAnimHandle = null;

function rackBaseAngle(i) {
  // 相邻卡片反向微倾，制造随手夹上去的错落感
  return i % 2 === 0 ? 2.5 : -2.5;
}

function rackTransform(base, swing) {
  return `rotate(${(base + swing).toFixed(2)}deg)`;
}

function rackTick() {
  let stillMoving = false;
  rackStates.forEach(state => {
    if (state.dragging) return; // 拖拽中角度由手势直接控制
    if (Math.abs(state.velocity) > 0.02 || Math.abs(state.angle) > 0.05) {
      state.velocity += -state.angle * 0.018; // 回复力：越偏离基准角越想弹回去
      state.velocity *= 0.952;                // 空气阻尼：让摆动逐渐停下来
      state.angle += state.velocity;
      if (state.angle > 26) { state.angle = 26; state.velocity *= -0.45; }
      if (state.angle < -26) { state.angle = -26; state.velocity *= -0.45; }
      state.el.style.transform = rackTransform(state.base, state.angle);
      stillMoving = true;
    } else if (state.angle !== 0 || state.velocity !== 0) {
      state.angle = 0;
      state.velocity = 0;
      state.el.style.transform = rackTransform(state.base, 0);
    }
  });
  rackAnimHandle = stillMoving ? requestAnimationFrame(rackTick) : null;
}

function rackKick() {
  if (rackAnimHandle == null) rackAnimHandle = requestAnimationFrame(rackTick);
}

// 用真实渲染后的屏幕坐标校正孔环位置，而不是预先用公式推算。
// 原理：在绳索的 SVG 路径上取很多采样点，转换成屏幕坐标；对每个孔环，
// 找到跟它水平位置最接近的采样点，取该点的屏幕 y 作为孔环应该在的 y，
// 再据此微调 top。多轮迭代，因为孔环本身带旋转，一次调整后位置还会
// 有细微变化，迭代几次即可收敛到亚像素级的精确对齐。
function alignClipsToRope(wrap) {
  const svg = wrap.querySelector('.rack-rope');
  const path = svg?.querySelector('.rope-core');
  if (!svg || !path) return;

  const totalLength = path.getTotalLength();
  const sampleCount = 60;
  const samples = [];
  for (let s = 0; s <= sampleCount; s++) {
    const point = path.getPointAtLength((s / sampleCount) * totalLength);
    samples.push(point); // SVG 用户坐标（viewBox 坐标系）
  }

  for (let pass = 0; pass < 3; pass++) {
    const svgRect = svg.getBoundingClientRect();
    const svgViewBox = svg.viewBox.baseVal;
    const scaleX = svgRect.width / svgViewBox.width;
    const scaleY = svgRect.height / svgViewBox.height;

    wrap.querySelectorAll('.rack-clip').forEach(clip => {
      const clipRect = clip.getBoundingClientRect();
      const clipCenterX = clipRect.left + clipRect.width / 2;

      // 在采样点里找横向最接近孔环中心的那个，取它换算到屏幕坐标的 y
      let closest = samples[0];
      let closestDist = Infinity;
      samples.forEach(point => {
        const screenX = svgRect.left + point.x * scaleX;
        const dist = Math.abs(screenX - clipCenterX);
        if (dist < closestDist) { closestDist = dist; closest = point; }
      });
      const targetScreenY = svgRect.top + closest.y * scaleY;
      const clipCenterY = clipRect.top + clipRect.height / 2;
      const delta = targetScreenY - clipCenterY;
      if (Math.abs(delta) < 0.3) return;

      const currentTop = parseFloat(clip.style.top || getComputedStyle(clip).top) || 0;
      clip.style.top = `${(currentTop + delta).toFixed(1)}px`;
    });
  }
}

// 6种复古配色循环使用：按这一批卡片的渲染顺序（索引）依次分配，
// 保证同一批展示出来的卡片两两颜色不同，超过6张才会重新从头循环。
const BAG_COLOR_CLASSES = ['bag-vermillion', 'bag-kraft', 'bag-blue', 'bag-black', 'bag-green', 'bag-yellow'];
function bagColorClassFor(index) {
  return BAG_COLOR_CLASSES[index % BAG_COLOR_CLASSES.length];
}

function renderRack() {
  const wrap = document.getElementById('rackBags');
  if (!wrap) return;
  // 「最近收集」只取最近 15 天内的藏品（默认收藏 / 卡片上的「最近」角标都按同一口径）。
  const recent = recentItems();

  // 空状态：撤掉绳索与提示，只留一句解释，避免一条空绳子晾在那里。
  const stage = document.getElementById('rackStage');
  const hint = document.querySelector('.rack-hint');
  if (!recent.length) {
    if (stage) stage.hidden = true;
    if (hint) hint.hidden = true;
    wrap.innerHTML = `<p class="rack-empty">最近 ${RECENT_WINDOW_DAYS} 天内还没有新收藏，从 ＋ 添加一只吧。</p>`;
    showRackHero(null);
    return;
  }
  if (stage) stage.hidden = false;
  if (hint) hint.hidden = false;

  // 绳索总宽跟随卡片总宽。卡片默认 110px、相邻重叠 20px（沿用原稿比例），
  // 但 6 张按原尺寸算需要 560px，超出 430px 的手机壳，会被裁掉最后一张。
  // 所以这里按容器实测宽度反推一个缩放比，让这一排卡片刚好铺满、不溢出，
  // 绳索宽度与卡片横向重叠同步跟着缩放，保证孔环仍然落在绳子上。
  const LAYOUT_W = 110, LAYOUT_OVERLAP = 20;
  const n = recent.length;
  const avail = (wrap.clientWidth || 430) - 24; // 减去 .rack-bags 左右 12px padding
  const naturalW = LAYOUT_W * n - LAYOUT_OVERLAP * (n - 1);
  const scale = Math.min(1, avail / naturalW);
  const CARD_W = LAYOUT_W * scale;
  const OVERLAP = LAYOUT_OVERLAP * scale;
  const ropeWidth = Math.max(CARD_W, CARD_W * n - OVERLAP * (n - 1));

  // 把缩放后的尺寸通过 CSS 变量交给样式，卡片本体仍用原稿的 .rack-item 结构
  wrap.style.setProperty('--rack-card-w', `${CARD_W.toFixed(2)}px`);
  wrap.style.setProperty('--rack-overlap', `${OVERLAP.toFixed(2)}px`);

  // 绳索铺满整个卡片排布宽度（scale 后即容器宽度），孔环再由
  // alignClipsToRope() 反查绳索真实坐标对齐，因此宽度精确与否都能对齐。
  const ropeHTML = `<div class="rack-rope-wrap" style="width:${ropeWidth.toFixed(2)}px">
      <svg class="rack-rope" viewBox="0 0 400 40" preserveAspectRatio="none" aria-hidden="true" style="width:${ropeWidth.toFixed(2)}px">
        <path class="rope-core" d="M3,6 Q 200,52 397,6"></path>
        <path class="rope-twist" d="M3,6 Q 200,52 397,6"></path>
      </svg>
    </div>`;

  wrap.innerHTML = ropeHTML + recent.map((item, i) => `
    <div class="rack-item" data-i="${i}" data-item-id="${escapeHTML(item.id)}">
      <div class="rack-hang">
        <div class="rack-clip"></div>
        <div class="rack-frame" style="--dy:${(i % 3) * 8}px">
          <div class="rack-photo ${bagColorClassFor(i)}">${objectMarkup(item)}</div>
        </div>
        <div class="rack-meta">
          <strong>${escapeHTML(item.name)}</strong>
          <small>${escapeHTML(item.shelf)} &middot; ${escapeHTML(item.date.slice(5))}</small>
        </div>
      </div>
    </div>`).join('');

  // 孔环对齐改成"渲染后测量真实坐标"，而不是提前用公式预测：
  // 公式预测要求准确还原每一层容器的 padding/margin 换算关系，一旦某个
  // 中间层的间距变了就会跑偏。测量法直接读取绳索路径和孔环在屏幕上的
  // 真实位置，用像素差直接纠正，不管中间套了多少层都保证准确对齐。
  repairBrokenImages(wrap);

  alignClipsToRope(wrap);

  // ── 主从联动：默认把最新的一张放进上方主卡位 ──
  const initial = recent[0] || null;
  showRackHero(initial);

  rackStates = [...wrap.querySelectorAll('.rack-item')].map((el, i) => {
    const hang = el.querySelector('.rack-hang');
    const state = { el: hang, base: rackBaseAngle(i), angle: 0, velocity: 0, dragging: false };
    hang.style.transform = rackTransform(state.base, 0);

    let startX = 0, startT = 0, moved = false;

    el.addEventListener('pointerdown', e => {
      startX = e.clientX; startT = Date.now(); moved = false;
      state.dragging = true; state.velocity = 0;
      try { el.setPointerCapture(e.pointerId); } catch (err) { /* 部分浏览器不支持，忽略 */ }
    });
    el.addEventListener('pointermove', e => {
      if (!state.dragging) return;
      const dx = e.clientX - startX;
      if (Math.abs(dx) > 6) moved = true;
      state.angle = Math.max(-75, Math.min(75, dx * 0.4));
      state.el.style.transform = rackTransform(state.base, state.angle);
    });
    el.addEventListener('pointerup', () => {
      if (!state.dragging) return;
      state.dragging = false;
      if (!moved && Date.now() - startT < 400) {
        // 轻点：先荡一下，再把这张卡片送到上方主卡位（主从联动），
        // 而不是直接弹详情——用户要的是"点下方、上方出现对应卡片"。
        state.angle = 0;
        state.el.style.transform = rackTransform(state.base, 0);
        state.velocity += 7;
        rackKick();
        showRackHero(recent[i]);
      } else {
        // 拨动松手：收进限位内，往反方向弹回
        state.angle = Math.max(-26, Math.min(26, state.angle * 0.3));
        state.velocity = -state.angle * 0.35;
        rackKick();
      }
    });
    el.addEventListener('pointercancel', () => {
      if (!state.dragging) return;
      state.dragging = false;
      state.angle = Math.max(-26, Math.min(26, state.angle * 0.3));
      state.velocity = -state.angle * 0.35;
      rackKick();
    });
    return state;
  });

  rackKick();
}

// ─── 上方主卡位（主从联动的"主"）───
// ─── 主展位：白色液态玻璃卡 + 3D 翻面 ───
// 正面只展示袋子，轻点卡片翻到背面看详细信息。
// 用户点下方挂袋 → 卡片自动翻回正面并换成那一只。
let hoveredRackId = null;
let heroFlipped = false;

// 正面 / 背面的切换。
// 只切一个类：CSS 靠 transform: rotateY(-180deg) 的 transition 旋转，
// 两个面的 opacity 与延时也全部由 CSS 决定。
//   · is-flipped：翻到背面（顺时针 -180deg）
function setHeroFlipped(flipped) {
  const hero = document.getElementById('rackHero');
  if (!hero) return;
  // 空状态没有内容可翻
  if (hero.classList.contains('is-empty') && flipped) return;
  // 已处于目标状态：不重复处理
  if (heroFlipped === flipped) return;

  const wasFlipped = heroFlipped;
  heroFlipped = flipped;
  hero.classList.toggle('is-flipped', flipped);

  const hit = document.getElementById('rackHeroHit');
  if (hit) hit.setAttribute('aria-pressed', flipped ? 'true' : 'false');
  // 翻到背面时把焦点移到"翻回正面"按钮，方便键盘操作
  if (flipped && !wasFlipped) {
    setTimeout(() => document.getElementById('rackHeroFlipBack')?.focus(), 420);
  }
}

// 背面键值对：把藏品的结构化字段逐行列出来
function heroFactsHTML(item) {
  const ago = daysAgo(item);
  const agoText = ago === 0 ? '今天' : ago === 1 ? '昨天' : `${ago} 天前`;
  const rows = [
    ['品牌 / 店铺', item.shelf],
    ['材质', item.material],
    ['收藏日期', item.date.replace(/\./g, '-')],
    ['入库时长', agoText],
    ['编号', `NO.${String(items.indexOf(item) + 1).padStart(3, '0')}`]
  ];
  return rows
    .filter(([, v]) => v !== undefined && v !== null && v !== '')
    .map(([k, v]) => `<div class="back-facts__row"><dt>${escapeHTML(k)}</dt><dd>${escapeHTML(String(v))}</dd></div>`)
    .join('');
}

function showRackHero(item) {
  const hero = document.getElementById('rackHero');
  if (!hero) return;
  hoveredRackId = item ? item.id : null;

  // 高亮：只保留当前这张的 is-active
  document.querySelectorAll('.rack-item').forEach(node => {
    const isCurrent = item && node.dataset.itemId === item.id;
    node.classList.toggle('is-active', !!isCurrent);
  });

  const pic = document.getElementById('rackHeroPic');
  const nameEl = document.getElementById('rackHeroName');
  const metaEl = document.getElementById('rackHeroMeta');
  const tagsEl = document.getElementById('rackHeroTags');
  const eyebrowEl = document.getElementById('rackHeroEyebrow');
  const openBtn = document.getElementById('rackHeroOpen');
  const tipEl = document.getElementById('rackHeroTip');
  const factsEl = document.getElementById('rackHeroFacts');
  const badgeEl = document.getElementById('rackHeroBadge');
  const noteEl = document.getElementById('rackHeroNote');
  // 正面文字信息（袋子下方）：品牌 / 名字 · 收藏日期
  const capBrandEl = document.getElementById('rackHeroCaptionBrand');
  const capNameEl = document.getElementById('rackHeroCaptionName');
  const capDateEl = document.getElementById('rackHeroCaptionDate');

  if (!item) {
    hero.classList.add('is-empty');
    setHeroFlipped(false);
    if (pic) pic.innerHTML = '';
    if (eyebrowEl) eyebrowEl.textContent = 'NO.000';
    if (nameEl) nameEl.textContent = '还没有最近收藏';
    if (metaEl) metaEl.textContent = `最近 ${RECENT_WINDOW_DAYS} 天内添加的藏品会出现在这里`;
    if (factsEl) factsEl.innerHTML = '';
    if (tagsEl) tagsEl.innerHTML = '';
    if (noteEl) { noteEl.textContent = ''; noteEl.hidden = true; }
    if (openBtn) openBtn.hidden = true;
    if (tipEl) tipEl.textContent = '从 ＋ 添加一只纸袋开始';
    if (badgeEl) badgeEl.hidden = true;
    if (capBrandEl) capBrandEl.textContent = '还没有最近收藏';
    if (capNameEl) capNameEl.textContent = '—';
    if (capDateEl) capDateEl.textContent = '';
    return;
  }

  hero.classList.remove('is-empty');
  if (badgeEl) badgeEl.hidden = false;

  // 换了一只袋子：先翻回正面，让用户看到新的袋子本体
  setHeroFlipped(false);

  if (pic) {
    pic.innerHTML = objectMarkup(item);
    repairBrokenImages(pic);
  }
  if (eyebrowEl) eyebrowEl.textContent = `NO.${String(items.indexOf(item) + 1).padStart(3, '0')}`;
  if (nameEl) nameEl.textContent = item.name;
  if (metaEl) metaEl.textContent = item.shelf;
  // 正面文字：品牌做主标题，名字与收藏日期并列一行
  if (capBrandEl) capBrandEl.textContent = item.shelf;
  if (capNameEl) capNameEl.textContent = item.name;
  if (capDateEl) capDateEl.textContent = formatDate(item.date);
  if (factsEl) factsEl.innerHTML = heroFactsHTML(item);
  if (tagsEl) tagsEl.innerHTML = item.tags.map(t => `<span># ${escapeHTML(t)}</span>`).join('');
  if (tipEl) tipEl.textContent = '轻点翻面 · 查看详情';
  if (noteEl) {
    noteEl.textContent = item.note || '暂未填写备注。';
    noteEl.hidden = !item.note;
  }
  if (openBtn) {
    openBtn.hidden = false;
    openBtn.onclick = e => { e.stopPropagation(); openDetail(item); };
  }
}

// 点击遮罩：切换翻面。用事件委托绑定一次，不随渲染重复挂载。
function initHeroFlip() {
  const hit = document.getElementById('rackHeroHit');
  const back = document.getElementById('rackHeroFlipBack');
  // 正面、背面都点整块卡片可翻。回正面时用 stopPropagation 挡掉冒泡，
  // 避免"返回按钮 + 卡片"被当成两次点击又翻回背面。
  if (hit) {
    hit.addEventListener('click', () => setHeroFlipped(!heroFlipped));
  }
  if (back) {
    back.addEventListener('click', e => { e.stopPropagation(); setHeroFlipped(false); });
  }
  // 背面内容区（文字、标签、备注）也支持点击翻转；
  // 但按钮类元素要放行，交给它们自己的处理。
  document.querySelectorAll('.flip-face--back').forEach(face => {
    face.addEventListener('click', e => {
      if (!heroFlipped) return;
      if (e.target.closest('button, a, [role="button"]')) return;
      setHeroFlipped(false);
    });
  });
}

function renderShowcase() {
  renderRack();
  updateStats();
  const recentCountEl = document.getElementById('recentCountText');
  if (recentCountEl) {
    const n = recentCount();
    recentCountEl.textContent = n
      ? `最近 ${RECENT_WINDOW_DAYS} 天 · ${n} 件`
      : `最近 ${RECENT_WINDOW_DAYS} 天内还没有新收藏`;
  }
  $('#settingsCount').textContent = items.length;
  bindItemButtons();
  bindRecentPill();
}

// 首页右上角「最近收藏 N」胶囊：滚到「最近收集」区，并让该区短暂高亮一下，
// 否则用户点了会一脸茫然 —— 页面滚过去了，但不知道看哪儿。
function bindRecentPill() {
  const pill = document.getElementById('recentPill');
  if (!pill || pill.dataset.bound) return;
  pill.dataset.bound = '1';
  pill.addEventListener('click', () => {
    const target = document.querySelector('.rack-section') || document.getElementById('rackHero');
    if (target) target.scrollIntoView({ behavior: 'smooth', block: 'start' });
    const label = document.getElementById('recentCountText');
    if (label) {
      label.classList.add('is-flash');
      setTimeout(() => label.classList.remove('is-flash'), 1200);
    }
  });
}

// 全部收藏卡片：跟今日推荐/挂袋吧台一样复用 objectMarkup 渲染真实图片或纸袋占位图
function collectionCardHTML(item) {
  return `<button class="collection-group-card js-item" data-item="${item.id}">${objectMarkup(item)}</button>`;
}

// 收藏页顶部的三个统计数字随搜索结果实时变化
// （首页原来也有同样三个 chip，已按需求去掉，只在右上角留「最近收藏 N」）
function updateLibraryStats(list) {
  const set = (id, value) => {
    const node = document.getElementById(id);
    if (node) node.textContent = value;
  };
  set('libCount', list.length);
  set('libShelfCount', new Set(list.map(item => item.shelf)).size);
  set('libTagCount', new Set(list.flatMap(item => item.tags)).size);
}

// ═══ 网格缩放：一个变量驱动全部尺寸 ═══
// 卡片宽从 82（大档）到 41（小档）连续变化，其余尺寸全部由 CSS 里的
// --grid-ratio 派生（见 styles.css 的 .library-body 区块）。
// JS 只负责写 --grid-card-w 和列数，不碰任何一个具体尺寸。
const GRID_W_MAX = 82;
const GRID_W_MIN = 41;
const MAX_GRID_RENDER = 240;
const GRID_W_KEY = 'ddj.gridW';
const GRID_SCROLL_KEY = 'ddj.gridScrollLeft';

let gridWidth = GRID_W_MAX;
let lastGridScroll = 0;
let gridGestureBound = false;
let pinchAnchor = null;

const clampGridW = w => Math.min(GRID_W_MAX, Math.max(GRID_W_MIN, w));

function gridGap() {
  // 与 CSS 里 --grid-gap = card-w / 9.1111 保持一致
  return gridWidth / 9.1111;
}

function gridPadX() {
  return gridWidth / 6.8333;
}

function applyGridVars(w) {
  gridWidth = clampGridW(w);
  const body = $('#libraryBody');
  // 写的是「无单位数字」而不是 px 字符串：CSS 侧用 @property 声明成 <number>，
  // 再由它派生 --grid-ratio 与所有尺寸。写成 px 会让 calc 里出现
  // 「数字 − 长度」的非法表达式，整条变量链静默失效。
  if (body) body.style.setProperty('--grid-w-num', gridWidth.toFixed(3));
}

// 记录当前内容宽度，供 anchorTo 算缩放比例。在每次缩放动作开始时调用。
function markGridWidth() {
  const win = $('#gridWindow');
  if (win) win.__prevW = gridWidth;
}

// 列数取「一屏放得下的列数 + 1」。
// 多渲染一列是为了保证任何缩放级别下 .grid-stage 都比 .grid-window 宽，
// 否则缩到最小时卡片全塞得下，scrollLeft 会被浏览器夹回 0，拖动突然失灵。
function relayoutGrid() {
  const grid = $('#libraryGrid');
  const win = $('#gridWindow');
  if (!grid || !win) return;
  const gap = gridGap();
  const avail = (win.clientWidth || 430) - gridPadX() * 2;
  const k = Math.max(1, Math.ceil((avail + gap) / (gridWidth + gap)));
  grid.style.setProperty('--grid-cols', String(k + 1));
  return k;
}

function restoreGridScroll() {
  const win = $('#gridWindow');
  if (!win) return;
  if (lastGridScroll > 0) win.scrollLeft = lastGridScroll;
}

function saveGridW() {
  try { localStorage.setItem(GRID_W_KEY, String(gridWidth)); } catch (e) { /* 隐私模式 */ }
}

// 读取持久化状态。两端都要 clamp，防止旧数据越界。
function loadGridState() {
  try {
    const saved = parseFloat(localStorage.getItem(GRID_W_KEY));
    if (Number.isFinite(saved)) gridWidth = clampGridW(saved);
  } catch (e) { /* 忽略 */ }
  try {
    const scroll = parseFloat(sessionStorage.getItem(GRID_SCROLL_KEY));
    if (Number.isFinite(scroll) && scroll > 0) lastGridScroll = scroll;
  } catch (e) { /* 忽略 */ }
}

// ═══ 手势：双指缩放 + 单指横向拖动（原生滚动）═══
// 监听器必须挂在 #libraryBody 而不是网格内部：renderLibrary() 会整体重写
// #collectionGroups.innerHTML，网格内部的监听器活不过一次重渲染。
function bindGridGestures() {
  const body = $('#libraryBody');
  if (!body || gridGestureBound) return;
  gridGestureBound = true;

  const pointers = new Map();   // pointerId → { x, y }
  let pinchStartDist = 0;
  let pinchStartW = 0;
  let pinching = false;
  let touchScrolling = false;
  let touchScrollingTimer = 0;

  // 幽灵点击抑制：拖动/捏合结束后浏览器仍会补一个 click，
  // 若不拦掉，松手瞬间就会误开详情面板。拦截必须放在捕获阶段。
  // 注意只针对触摸——鼠标的 click 是用户本意，不能吞掉，
  // 否则桌面上点卡片永远打不开详情（pointerdown 对鼠标同样会触发）。
  let swallowUntil = 0;
  const swallowClicks = (ms = 400) => { swallowUntil = Date.now() + ms; };
  document.addEventListener('click', event => {
    if (Date.now() < swallowUntil) {
      event.stopPropagation();
      event.preventDefault();
    }
  }, true);

  const isTouch = event => event.pointerType !== 'mouse';

  const dist = () => {
    const [a, b] = [...pointers.values()];
    return Math.hypot(a.x - b.x, a.y - b.y);
  };
  const mid = () => {
    const [a, b] = [...pointers.values()];
    return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
  };

  body.addEventListener('pointerdown', event => {
    if (libraryView !== 'grid') return;
    pointers.set(event.pointerId, { x: event.clientX, y: event.clientY });

    if (pointers.size === 2) {
      const win = $('#gridWindow');
      pinching = true;
      swallowClicks();
      if (win) win.classList.add('is-pinching');   // touch-action: none
      pinchStartDist = dist();
      pinchStartW = gridWidth;
      // 焦点锚定：记住两指中点此刻在内容坐标系里的位置，缩放后补偿 scrollLeft，
      // 让手指按住的那个点视觉上不动。
      markGridWidth();
      pinchAnchor = anchorOf(mid());
    } else if (pointers.size === 1 && isTouch(event)) {
      swallowClicks(200);
    }
  }, { passive: true });

  body.addEventListener('pointermove', event => {
    if (!pointers.has(event.pointerId)) return;
    pointers.set(event.pointerId, { x: event.clientX, y: event.clientY });

    if (pinching && pointers.size >= 2) {
      // 非 passive + preventDefault：单指时绝不能拦，否则横向滚动会失效。
      event.preventDefault();
      if (pinchStartDist > 0) {
        applyGridVars(pinchStartW * (dist() / pinchStartDist));
        relayoutGrid();
        anchorTo(pinchAnchor);
      }
      return;
    }
    // 单指横向滑动走浏览器原生滚动，不给它 preventDefault
  }, { passive: false });

  const endPointer = event => {
    if (!pointers.has(event.pointerId)) return;
    pointers.delete(event.pointerId);
    if (pointers.size < 2 && pinching) {
      pinching = false;
      pinchAnchor = null;
      const win = $('#gridWindow');
      if (win) win.classList.remove('is-pinching');
      saveGridW();
      swallowClicks();
    } else if (isTouch(event) && !pinching) {
      // 单指触摸抬手：原生惯性滚动还在继续，随后的合成 click 必须吞掉。
      // 用一个标志限制在后继 scroll 事件里也继续吞，滚停后再放开。
      touchScrolling = true;
      swallowClicks(300);
      clearTimeout(touchScrollingTimer);
      touchScrollingTimer = setTimeout(() => { touchScrolling = false; }, 400);
    }
  };
  body.addEventListener('pointerup', endPointer);
  body.addEventListener('pointercancel', endPointer);

  // 原生横向滚动期间继续吃掉 click（横向拖动手势结束时浏览器会补 click）。
  // 只在触摸引起的滚动后吞：鼠标滚轮不补 click，若一并吞掉，
  // 用户滚完轮子立刻点卡片就会没反应。
  body.addEventListener('scroll', event => {
    const win = event.target;
    if (!win || win.id !== 'gridWindow') return;
    lastGridScroll = win.scrollLeft;
    try { sessionStorage.setItem(GRID_SCROLL_KEY, String(win.scrollLeft)); } catch (e) { /* 忽略 */ }
    if (pinching) return;
    if (touchScrolling) {
      swallowClicks(300);
      clearTimeout(touchScrollingTimer);
      touchScrollingTimer = setTimeout(() => { touchScrolling = false; }, 400);
    }
  }, { passive: true });

  // Ctrl + 滚轮：桌面降级（触控板的捏合也会带 ctrlKey）。
  // 普通滚轮不拦，页面正常滚动。
  body.addEventListener('wheel', event => {
    if (libraryView !== 'grid' || !event.ctrlKey) return;
    if (!event.target.closest || !event.target.closest('.grid-window')) return;
    event.preventDefault();
    const anchor = anchorOf({ x: event.clientX, y: event.clientY });
    applyGridVars(gridWidth * Math.exp(-event.deltaY * 0.01));
    relayoutGrid();
    anchorTo(anchor);
    saveGridW();
  }, { passive: false });

  // 窗口尺寸变化要重算列数（横竖屏切换、桌面缩放窗口）
  window.addEventListener('resize', () => {
    if (libraryView === 'grid') relayoutGrid();
  });
}

// 把视口坐标换算成「内容坐标系」的横向偏移，用于焦点锚定
function anchorOf(point) {
  const win = $('#gridWindow');
  if (!win) return null;
  const rect = win.getBoundingClientRect();
  return { dx: point.x - rect.left, contentX: (point.x - rect.left) + win.scrollLeft };
}

function anchorTo(anchor) {
  const win = $('#gridWindow');
  if (!win || !anchor) return;
  // contentX 是缩放前那个内容点在「内容坐标系」里的位置。
  // 内容整体按 gridWidth / prevGridWidth 缩放，所以它现在跑到了 contentX * ratio 处。
  // 反解 scrollLeft，让它仍然落在屏幕上的同一个 dx。
  const ratio = gridWidth / (win.__prevW || gridWidth);
  win.scrollLeft = Math.max(0, anchor.contentX * ratio - anchor.dx);
  win.__prevW = gridWidth;
}

function renderLibrary() {
  const query = $('#searchInput').value.trim().toLowerCase();
  const filtered = items.filter(item => {
    return !query || item.name.toLowerCase().includes(query) || item.tags.some(tag => tag.toLowerCase().includes(query));
  });

  // 按展示架分组，保持 items 数组里原有的先后顺序（先出现的展示架排在前面）
  const groups = [];
  const groupIndex = new Map();
  filtered.forEach(item => {
    if (!groupIndex.has(item.shelf)) {
      groupIndex.set(item.shelf, groups.length);
      groups.push({ shelf: item.shelf, items: [] });
    }
    groups[groupIndex.get(item.shelf)].items.push(item);
  });

  // 两种视图的结构差别是真实差别，不只是 CSS 差别：
  //  · 分组视图 —— 每组一个区块，横向滑动，卡片下面压着亚克力层板
  //  · 网格视图 —— 打散分组，全部卡片连成一片网格，可双指缩放、可横向拖动
  //    若沿用「每组一个 grid 容器」，每组末尾会落下孤零零一张卡、右边空一大块，
  //    所以网格视图必须走另一条 DOM 分支。
  const shelves = groups.map(group => group.shelf);

  if (libraryView === 'grid') {
    // 小档位列数会翻倍，收藏量大时 DOM 会膨胀。先硬性封顶，
    // 这是虚拟滚动的临时替代，把风险按住。
    const shown = filtered.slice(0, MAX_GRID_RENDER);
    const overflow = filtered.length - shown.length;
    $('#collectionGroups').innerHTML = `
      <div class="grid-window" id="gridWindow">
        <div class="grid-stage">
          <div class="collection-grid" id="libraryGrid">
            ${shown.map(item => `
              <button class="grid-card js-item" data-item="${item.id}"
                      aria-label="${escapeHTML(item.name)}，${escapeHTML(item.shelf)}，${escapeHTML(item.date)}">
                <div class="grid-art">${objectMarkup(item)}</div>
                <strong>${escapeHTML(item.name)}</strong>
                <small>${escapeHTML(item.shelf)} &middot; ${escapeHTML(item.date.slice(5))}</small>
              </button>`).join('')}
          </div>
        </div>
      </div>
      ${overflow > 0 ? `<p class="grid-overflow-note">仅显示前 ${MAX_GRID_RENDER} 件</p>` : ''}`;
  } else {
    $('#collectionGroups').innerHTML = groups.map((group, i) => `
        <section class="collection-group${i === groups.length - 1 ? ' collection-group--last' : ''}"
                 data-shelf="${escapeHTML(group.shelf)}" aria-label="展示架">
          <div class="collection-group-title">
            <h2>${escapeHTML(group.shelf)}</h2>
            <span>${group.items.length} 件</span>
          </div>
          <div class="collection-group-scroll">
            ${group.items.map(collectionCardHTML).join('')}
          </div>
          <div class="acrylic-shelf"><i></i><i></i></div>
        </section>`).join('');
  }

  repairBrokenImages($('#collectionGroups'));
  $('#resultCount').textContent = libraryView === 'grid'
    ? `共 ${filtered.length} 件 · 点击查看`   // 网格卡片只有图，没有名字，提示可点
    : `共 ${filtered.length} 件 · ${shelves.length} 个展示架`;
  $('#emptyState').hidden = filtered.length > 0;
  updateLibraryStats(filtered);
  bindItemButtons();

  // 网格的缩放/滚动状态要在 DOM 就位之后恢复
  if (libraryView === 'grid') {
    applyGridVars(gridWidth);
    relayoutGrid();
    restoreGridScroll();
  } else {
    lastGridScroll = 0;
  }
}

// ═══ 视图切换：分组（按展示架横滑）⇄ 网格（2 列平铺）═══
let libraryView = 'group';

function setLibraryView(view, animate = true) {
  libraryView = view === 'grid' ? 'grid' : 'group';
  const body = $('#libraryBody');
  if (!body) return;
  body.dataset.view = libraryView;

  // 两种视图的 DOM 结构不同（分组区块 vs 扁平网格），必须重渲染而不只是改 class
  renderLibrary();

  // 换布局时轻微淡入，避免同一批卡片直接跳位
  if (animate) {
    body.classList.remove('is-switching');
    void body.offsetWidth;          // 强制重排，让动画能重新触发
    body.classList.add('is-switching');
  }

  const button = $('#layoutToggle');
  if (button) {
    const toGrid = libraryView === 'group';
    button.setAttribute('aria-label', toGrid ? '切换为网格视图' : '切换为分组视图');
    button.setAttribute('aria-pressed', String(libraryView === 'grid'));
    button.title = toGrid ? '切换为网格视图' : '切换为分组视图';
  }
  // 图标同步：分组视图显示「网格」图标（点了能切过去），反之亦然
  const icon = $('#layoutIcon');
  if (icon) icon.innerHTML = libraryView === 'group'
    ? '<rect x="3" y="3" width="7.5" height="7.5" rx="1.6"/><rect x="13.5" y="3" width="7.5" height="7.5" rx="1.6"/><rect x="3" y="13.5" width="7.5" height="7.5" rx="1.6"/><rect x="13.5" y="13.5" width="7.5" height="7.5" rx="1.6"/>'
    : '<rect x="3" y="5" width="18" height="5.5" rx="1.6"/><rect x="3" y="13.5" width="18" height="5.5" rx="1.6"/>';
}

$('#layoutToggle').addEventListener('click', () => {
  setLibraryView(libraryView === 'group' ? 'grid' : 'group');
});

function bindItemButtons() {
  $$('.js-item').forEach(button => {
    button.onclick = () => openDetail(items.find(item => item.id === button.dataset.item));
  });
}

function navigate(screen) {
  $$('.screen').forEach(node => node.classList.toggle('screen--active', node.dataset.screen === screen));
  $$('.nav-item').forEach(node => node.classList.toggle('is-active', node.dataset.nav === screen));
  $('#appScroll').scrollTo({ top: 0, behavior: 'smooth' });
  if (screen === 'library') renderLibrary();
}

function openSheet(sheet) {
  $('#sheetBackdrop').hidden = false;
  sheet.classList.add('is-open');
  sheet.setAttribute('aria-hidden', 'false');
  document.body.style.overflow = 'hidden';
  // 详情卡是"原地放大淡入"(300ms)，另两个半窗是滑入(380ms)，
  // 焦点要在动效停下之后再移，否则会打断过渡。
  const settle = sheet.classList.contains('detail-card') ? 300 : 380;
  setTimeout(() => $('[data-close]', sheet)?.focus(), settle);
}

function closeSheets() {
  // ⚠ 必须同时包含 .detail-card：它不再带 .bottom-sheet 基类，
  // 漏掉就会导致 ESC / 点遮罩 / 点关闭按钮三条路径全部失效，卡片永久卡屏。
  $$('.bottom-sheet, .detail-card').forEach(sheet => {
    sheet.classList.remove('is-open');
    sheet.setAttribute('aria-hidden', 'true');
  });
  $('#sheetBackdrop').hidden = true;
  document.body.style.overflow = '';
}

function openDetail(item) {
  if (!item) return;
  $('#detailArtwork').innerHTML = objectMarkup(item);
  repairBrokenImages($('#detailArtwork'));
  $('#detailNumber').textContent = `NO.${String(items.indexOf(item) + 1).padStart(3, '0')}`;
  $('#detailName').textContent = item.name;
  $('#detailBrand').textContent = item.shelf;
  // 键值对直接复用首页卡片背面的生成函数：它输出的就是 .back-facts__row，
  // 正是详情卡里 <dl class="back-facts"> 的子结构。
  $('#detailFacts').innerHTML = heroFactsHTML(item);
  $('#detailTags').innerHTML = item.tags.map(tag => `<span># ${escapeHTML(tag)}</span>`).join('');
  const note = $('#detailNote');
  note.textContent = item.note || '';
  note.hidden = !item.note;          // 没写备注就整块收起，不留空白
  // 换一只藏品时内容区回到顶部，否则会停在上一次滚到的位置
  const scroller = $('#detailSheet').querySelector('.detail-scroll');
  if (scroller) {
    scroller.scrollTop = 0;
    // 底部渐隐遮罩只在「下面还有内容」时该出现；滚到底就撤掉，
    // 否则最后一行备注会永远糊着（见 styles.css 的 .detail-scroll 遮罩）
    syncDetailFade(scroller);
  }
  openSheet($('#detailSheet'));
}

/** 根据滚动位置切换详情内容区的底部渐隐 */
function syncDetailFade(scroller) {
  if (!scroller) return;
  const atEnd = scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight <= 2;
  scroller.classList.toggle('is-at-end', atEnd);
}

function showToast(message) {
  const toast = $('#toast');
  toast.textContent = message;
  toast.classList.add('is-showing');
  clearTimeout(showToast.timer);
  showToast.timer = setTimeout(() => toast.classList.remove('is-showing'), 2100);
}

$$('[data-nav]').forEach(button => button.addEventListener('click', () => navigate(button.dataset.nav)));
$('#addButton').addEventListener('click', () => {
  $('[data-add-step="1"]').hidden = false;
  $('[data-add-step="2"]').hidden = true;
  $('#stepLabel').textContent = '1 / 2';
  openSheet($('#addSheet'));
});
$$('[data-close]').forEach(button => button.addEventListener('click', closeSheets));
$('#sheetBackdrop').addEventListener('click', closeSheets);
// 详情内容区滚动时同步底部渐隐（放在 document 上委托，避免等详情卡被渲染出来）
document.addEventListener('scroll', event => {
  if (event.target instanceof Element && event.target.classList.contains('detail-scroll')) {
    syncDetailFade(event.target);
  }
}, true);
$$('[data-open="settings"]').forEach(button => button.addEventListener('click', () => openSheet($('#settingsSheet'))));

$('#searchInput').addEventListener('input', event => {
  $('#clearSearch').hidden = !event.target.value;
  renderLibrary();
});
$('#clearSearch').addEventListener('click', () => {
  $('#searchInput').value = '';
  $('#clearSearch').hidden = true;
  renderLibrary();
  $('#searchInput').focus();
});

$('#fileInput').addEventListener('change', event => {
  const file = event.target.files?.[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = () => {
    uploadedImage = reader.result;
    $('#uploadPreview').src = uploadedImage;
    $('#uploadPreview').hidden = false;
    $('#toDetails').disabled = false;
  };
  reader.readAsDataURL(file);
});

$('#toDetails').addEventListener('click', () => {
  $('[data-add-step="1"]').hidden = true;
  $('[data-add-step="2"]').hidden = false;
  $('#stepLabel').textContent = '2 / 2';
  $('#miniPreview').src = uploadedImage;
  $('#nameInput').focus();
});

$('#backUpload').addEventListener('click', () => {
  $('[data-add-step="1"]').hidden = false;
  $('[data-add-step="2"]').hidden = true;
  $('#stepLabel').textContent = '1 / 2';
});

$('[data-add-step="2"]').addEventListener('submit', event => {
  event.preventDefault();
  const name = $('#nameInput').value.trim() || '未命名收藏';
  const tags = $('#tagInput').value.trim().split(/\s+/).filter(Boolean);
  items.unshift({
    id: `upload-${Date.now()}`,
    name,
    shelf: $('#shelfSelect').value,
    type: 'image',
    image: uploadedImage,
    tags,
    date: '2026.09.13',
    note: '从本机相册添加到 BagCollect 的新收藏。'
  });
  closeSheets();
  renderShowcase();
  renderLibrary();
  $('#fileInput').value = '';
  $('#uploadPreview').hidden = true;
  $('#toDetails').disabled = true;
  $('#nameInput').value = '';
  $('#tagInput').value = '';
  showToast(`“${name}”已加入陈列柜`);
});

// 摇一摇互动：把手机晃动的力度转换成挂钩卡片的摆动冲量。
// iOS 13+ 要求 DeviceMotionEvent 权限必须在用户手势（点击）里请求，
// 所以设计成一个开关按钮触发，而不是页面加载时自动弹权限框。
let motionEnabled = false;
let lastMotionTime = 0;

function handleDeviceMotion(event) {
  const now = Date.now();
  if (now - lastMotionTime < 60) return; // 简单节流，避免过于频繁地触发摆动
  lastMotionTime = now;

  const acc = event.accelerationIncludingGravity || event.acceleration;
  if (!acc) return;
  // 只关心水平方向（x 轴）的晃动，这样左右摇手机时纸袋才会跟着左右摆
  const shakeForce = (acc.x || 0) * 0.9;
  if (Math.abs(shakeForce) < 1.2) return; // 低于阈值视为日常手持的细微抖动，忽略

  rackStates.forEach((state, i) => {
    if (state.dragging) return;
    // 相邻卡片摆动方向略有交错，避免所有卡片完全同步显得呆板
    const dir = i % 2 === 0 ? 1 : -1;
    state.velocity += shakeForce * 0.3 * dir;
  });
  rackKick();
}

async function enableMotion() {
  const toggle = document.getElementById('motionToggle');
  const hint = document.getElementById('motionHint');
  if (typeof DeviceMotionEvent === 'undefined') {
    if (hint) hint.textContent = '当前设备或浏览器不支持摇一摇互动。';
    return;
  }

  // iOS 13+ 需要显式请求权限；其他平台（如安卓 Chrome）没有这个 API，直接监听即可。
  if (typeof DeviceMotionEvent.requestPermission === 'function') {
    try {
      const result = await DeviceMotionEvent.requestPermission();
      if (result !== 'granted') {
        if (hint) hint.textContent = '未获得动作与方向权限，摇一摇互动暂时无法使用。';
        return;
      }
    } catch (err) {
      if (hint) hint.textContent = '请求权限失败，可以在系统设置里检查浏览器的运动感应权限。';
      return;
    }
  }

  window.addEventListener('devicemotion', handleDeviceMotion);
  motionEnabled = true;
  if (toggle) toggle.setAttribute('aria-checked', 'true');
  if (hint) hint.textContent = '已开启摇一摇互动，轻轻晃动手机试试看。';
}

function disableMotion() {
  window.removeEventListener('devicemotion', handleDeviceMotion);
  motionEnabled = false;
  const toggle = document.getElementById('motionToggle');
  const hint = document.getElementById('motionHint');
  if (toggle) toggle.setAttribute('aria-checked', 'false');
  if (hint) hint.textContent = '开启后，轻轻晃动手机会让"最近收集"的挂袋跟着摆动。仅在本机读取设备运动数据，不会上传。';
}

document.getElementById('motionToggle')?.addEventListener('click', () => {
  if (motionEnabled) disableMotion(); else enableMotion();
});

document.addEventListener('keydown', event => {
  if (event.key === 'Escape') closeSheets();
});

loadGridState();      // 先恢复缩放宽度，下面第一次 renderLibrary() 才会用对尺寸
bindGridGestures();
renderShowcase();
renderLibrary();
initHeroFlip();

// 调试/自动化测试用的缩放入口。手势、Ctrl+滚轮、持久化恢复全都走这里，
// 保证外部调用测到的就是产品代码本身，而不是另写一套。
window.__setGridW = (w) => {
  applyGridVars(w);
  relayoutGrid();
  saveGridW();
};
window.__gridW = () => gridWidth;

// 首页头部原本有三枚统计 chip（件收藏 / 件最近 / 个标签），已按需求去掉，
// 只在右上角留「最近收藏 N」一个数字。其余统计仍在「全部收藏」页与设置面板里。
function updateStats() {
  const pillNum = document.getElementById('recentPillNum');
  if (pillNum) pillNum.textContent = recentCount();
}
