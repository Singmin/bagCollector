const items = [
  { id: 'vermillion', name: '朱红纸品袋', shelf: '城市纸袋', type: 'bag', style: 'bag-vermillion', tags: ['红色', '深圳', '设计'], date: '2026.09.13', note: '路过南头古城时留下的纸袋。颜色很直接，放在架上也很醒目。' },
  { id: 'kraft', name: '街角咖啡袋', shelf: '城市纸袋', type: 'bag', style: 'bag-kraft', tags: ['咖啡', '牛皮纸'], date: '2026.09.11', note: '周末早晨买咖啡时拿到的纸袋，保留了自然的折痕。' },
  { id: 'blue', name: '蓝色书店纸袋', shelf: '城市纸袋', type: 'bag', style: 'bag-blue', tags: ['蓝色', '书店'], date: '2026.09.08', note: '来自独立书店的深蓝纸袋，手感厚实。' },
  { id: 'black', name: '黑色唱片袋', shelf: '城市纸袋', type: 'bag', style: 'bag-black', tags: ['黑色', '唱片'], date: '2026.09.01', note: '买下一张旧唱片时带回来的黑色纸袋。' },
  { id: 'green', name: '植物店手提袋', shelf: '城市纸袋', type: 'bag', style: 'bag-green', tags: ['绿色', '植物'], date: '2026.08.28', note: '小植物店的纸袋，柔和的绿色很适合这个展示架。' },
  { id: 'archive', name: '日常物件图鉴', shelf: '书与刊物', type: 'book', style: 'book-blue', tags: ['书', '设计'], date: '2026.08.22', note: '一本关于日常物件与平面设计的小书。' },
  { id: 'redbook', name: '城市字体', shelf: '书与刊物', type: 'book', style: 'book-red', tags: ['书', '字体'], date: '2026.08.14', note: '记录城市招牌与字体的一本图册。' },
  { id: 'gridbook', name: '收藏的秩序', shelf: '书与刊物', type: 'book', style: 'book-grid', tags: ['书', '整理'], date: '2026.08.02', note: '关于分类、归档与个人收藏方式的读物。' },
  { id: 'cream', name: '画廊场刊', shelf: '书与刊物', type: 'bag', style: 'bag-cream', tags: ['刊物', '展览'], date: '2026.07.30', note: '一次周末展览留下的小型场刊。' },
  { id: 'ticket1', name: '海边列车票', shelf: '票根留念', type: 'ticket', style: '', tags: ['车票', '旅行'], date: '2026.07.20', note: '靠海行驶的一段短途列车，车票保留了那天的时间。' },
  { id: 'ticket2', name: '午夜电影票', shelf: '票根留念', type: 'ticket', style: '', tags: ['电影', '夜晚'], date: '2026.07.12', note: '临时决定去看的午夜场电影。' },
  { id: 'wine', name: '音乐节手环', shelf: '票根留念', type: 'bag', style: 'bag-wine', tags: ['音乐', '纪念'], date: '2026.06.28', note: '用纸袋的方式保存一段音乐节记忆。' }
];

let activeFilter = '全部';
let uploadedImage = '';

const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];
const escapeHTML = value => String(value).replace(/[&<>'"]/g, character => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;'
}[character]));

function objectMarkup(item) {
  if (item.image) return `<img class="uploaded-object" src="${item.image}" alt="" />`;
  if (item.type === 'book') return `<div class="book-object ${item.style}"></div>`;
  if (item.type === 'ticket') return `<div class="ticket-object"><span>ADMIT ONE · 09:41</span><strong>KEEP<br/>THIS</strong><span>NO. ${item.id.slice(-1).padStart(3, '0')}</span></div>`;
  return `<div class="paper-bag ${item.style}"><span class="bag-handle"></span><span class="bag-copy">PRIVATE<br/><b>OBJECT</b><br/>ARCHIVE</span><span class="bag-seal">${item.id.length}</span></div>`;
}

function itemButton(item, kind) {
  if (kind === 'recent') return `<button class="recent-card js-item" data-item="${item.id}"><div class="recent-art">${objectMarkup(item)}</div><strong>${escapeHTML(item.name)}</strong><small>${escapeHTML(item.shelf)}</small></button>`;
  if (kind === 'shelf') return `<button class="shelf-card js-item" data-item="${item.id}">${objectMarkup(item)}<span>${escapeHTML(item.name)}</span></button>`;
  return `<button class="grid-card js-item" data-item="${item.id}"><div class="grid-art">${objectMarkup(item)}</div><strong>${escapeHTML(item.name)}</strong><small>${escapeHTML(item.shelf)} · ${escapeHTML(item.date.slice(5))}</small></button>`;
}

function renderShowcase() {
  $('#recentStrip').innerHTML = items.slice(0, 5).map(item => itemButton(item, 'recent')).join('');
  $$('.shelf-scroll').forEach(row => {
    row.innerHTML = items.filter(item => item.shelf === row.dataset.shelf).map(item => itemButton(item, 'shelf')).join('');
  });
  $('#collectionCount').textContent = items.length;
  $('#settingsCount').textContent = items.length;
  bindItemButtons();
}

function renderLibrary() {
  const query = $('#searchInput').value.trim().toLowerCase();
  const filtered = items.filter(item => {
    const shelfMatch = activeFilter === '全部' || item.shelf === activeFilter;
    const queryMatch = !query || item.name.toLowerCase().includes(query) || item.tags.some(tag => tag.toLowerCase().includes(query));
    return shelfMatch && queryMatch;
  });
  $('#collectionGrid').innerHTML = filtered.map(item => itemButton(item, 'grid')).join('');
  $('#resultCount').textContent = `共 ${filtered.length} 件`;
  $('#emptyState').hidden = filtered.length > 0;
  bindItemButtons();
}

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
  setTimeout(() => $('[data-close]', sheet)?.focus(), 380);
}

function closeSheets() {
  $$('.bottom-sheet').forEach(sheet => {
    sheet.classList.remove('is-open');
    sheet.setAttribute('aria-hidden', 'true');
  });
  $('#sheetBackdrop').hidden = true;
  document.body.style.overflow = '';
}

function openDetail(item) {
  if (!item) return;
  $('#detailArtwork').innerHTML = objectMarkup(item);
  $('#detailNumber').textContent = `OBJECT · ${String(items.indexOf(item) + 1).padStart(3, '0')}`;
  $('#detailName').textContent = item.name;
  $('#detailMeta').textContent = `${item.shelf} · 加入于 ${item.date}`;
  $('#detailTags').innerHTML = item.tags.map(tag => `<span># ${escapeHTML(tag)}</span>`).join('');
  $('#detailNote').textContent = item.note;
  openSheet($('#detailSheet'));
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
$$('.filter-chip').forEach(button => button.addEventListener('click', () => {
  activeFilter = button.dataset.filter;
  $$('.filter-chip').forEach(chip => chip.classList.toggle('is-active', chip === button));
  renderLibrary();
}));

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

document.addEventListener('keydown', event => {
  if (event.key === 'Escape') closeSheets();
});

renderShowcase();
renderLibrary();
