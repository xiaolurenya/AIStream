'use strict';
const $ = s => document.querySelector(s);
const TOKEN_KEY = 'aistream_token';
let TOKEN = localStorage.getItem(TOKEN_KEY) || '';
let ME = null;
let CUR_KIND = 'rec';
let PERM = null;        // 栏目权限映射（/api/config views）：{rec:true,movie:false,...}
let IV_ENABLED = false; // IPTV 总开关（后台）
let REC_POOL = [];   // 随机一部用
let LD_STATE = { done: 0 };   // 加载态：已完成路数（用于「已完成 x/y 路」真实进度）
let VIEW_GEN = 0;             // 视图世代号：切换视图后旧请求的回调一律作废，防止抢占当前界面
const VIEW_ABORT = { __abort: 1 };
function newView() { return ++VIEW_GEN; }
function ck(gen) { if (gen !== VIEW_GEN) throw VIEW_ABORT; }

const KINDNAME = { movie: '电影', series: '剧集', anime: '动漫', variety: '综艺', short: '短剧', doc: '纪录片' };

/* 登录后才注入页面骨架：未登录时查看网页源码只见登录框，不暴露栏目/功能结构 */
const SHELL_HTML = `
<aside class="snav hidden" id="snav">
  <div class="snav-brand" id="snavLogo">AIStream<small>AI STREAM</small></div>
  <div class="snav-cap">分类</div>
  <div class="snav-item active" data-kind="rec">🔥 推荐</div>
  <div class="snav-item" data-kind="movie">🎬 电影</div>
  <div class="snav-item" data-kind="series">📺 剧集</div>
  <div class="snav-item" data-kind="anime">🐣 动漫</div>
  <div class="snav-item" data-kind="variety">🎤 综艺</div>
  <div class="snav-item" data-kind="short">🎭 短剧</div>
  <div class="snav-sep"></div>
  <div class="snav-cap">直播</div>
  <div class="snav-item hidden" data-view="iptv" id="snavIptv">📡 IPTV</div>
  <div class="snav-sep"></div>
  <div class="snav-cap">我的</div>
  <div class="u-card" id="uCard">
    <div class="uc-top">
      <div class="uc-av" id="ucAv">U</div>
      <div class="uc-meta">
        <div class="uc-name" id="ucName">—</div>
        <div class="uc-sub" id="ucSub">账号使用中</div>
      </div>
    </div>
    <div class="uc-lvrow"><span class="uc-lvname" id="ucLvName">普通用户</span><span class="uc-pct" id="ucPct">0%</span></div>
    <div class="uc-bar"><i id="ucBar"></i></div>
    <div class="uc-hint" id="ucHint">签到 / 邀请 / 看片均可获得成长值</div>
    <div class="uc-btns">
      <button class="uc-checkin" id="ucCheckin">📅 签到领分</button>
      <button class="uc-invite" id="ucInvite">🤝 邀请好友得 <b id="ucInvPts">0</b> 分</button>
    </div>
  </div>
  <div class="snav-item" data-view="points">🎁 积分中心</div>
  <div class="snav-item" data-view="history">🕘 历史记录</div>
  <div class="snav-item" data-view="fav">⭐ 我的收藏</div>
</aside>
<header class="hidden" id="hdr">
  <div class="hrow">
    <div class="led-bar hidden" id="hdrLed"></div>
    <div class="user">
      <div class="avatar" id="uAvatar">U</div>
      <span id="uName" style="font-size:13px"></span>
      <button class="btn" id="uAdmin" style="display:none" onclick="location.href='/admin.html'">后台</button>
      <button class="btn" id="uLogout">退出</button>
    </div>
  </div>
</header>
<div class="wrap hidden" id="main">
  <section class="hero" id="hero">
    <div class="hero-glow"></div>
    <div class="hero-orb o1"></div>
    <div class="hero-orb o2"></div>
    <div class="hero-badge"><i></i>AI STREAM · ONLINE</div>
    <h1 class="hero-title" id="heroTitle">AI 智能影视聚合</h1>
    <p class="hero-sub" id="heroSub">海量资源 · 一键即播 · 全站免费</p>
    <div class="hero-actions">
      <button class="btn primary" id="heroRand">🎲 随机一部</button>
      <button class="btn" id="heroScroll">👇 浏览栏目</button>
    </div>
  </section>
  <div class="big-search">
    <input id="sInput" placeholder="搜索 电影 / 剧集 / 动漫，回车直达…">
    <button class="btn primary" id="sBtn">搜 索</button>
  </div>
  <div id="content"><div class="loader"><div class="spin"></div></div></div>
</div>
<div id="anno"><div class="anno-box">
  <h3 id="annoTitle"></h3><div class="ac" id="annoContent"></div>
  <label class="anno-nr" id="annoNrWrap"><input type="checkbox" id="annoNr"> 今天不再提示</label>
  <button class="btn primary" id="annoClose">我知道了</button>
</div></div>`;
function mountShell() {
  const r = document.getElementById('root');
  if (r && !r.dataset.mounted) { r.innerHTML = SHELL_HTML; r.dataset.mounted = '1'; }
}
if (TOKEN) mountShell();   /* 页面加载时已登录：立即挂骨架 */
else { /* 未登录：登录成功后再挂（修「登录后黑屏要刷新」） */ }

async function api(path, opts = {}) {
  opts.headers = Object.assign({ 'Authorization': 'Bearer ' + TOKEN }, opts.headers || {});
  if (opts.body && typeof opts.body !== 'string') opts.body = JSON.stringify(opts.body);
  const r = await fetch(path, opts);
  if (r.status === 401) { logout(); throw new Error('未登录'); }
  return r.json();
}
/* 上游海报走本站代理（防防盗链，且已做内网 SSRF 防护） */
/* TMDB 公共图床直链；其余第三方走代理 */
function pimg(u) {
  const s = u || '';
  if (/^https?:\/\/(image\.)?tmdb\.org\//i.test(s)) return s;
  return u ? '/api/dimg?u=' + encodeURIComponent(u) : '';
}
/* 上游部分海报本身就是站方占位图（placeholder-poster.svg 等），直接当无图处理（v30 修复动漫海报） */
function badPoster(u) { const s = String(u || ''); return !s || /placeholder(-poster)?[-_.]?\d*\.(svg|png|jpe?g|webp|gif)/i.test(s); }
/* 统一海报结构：ph 占位垫底 + 图片加载失败自动移除露出占位（防裂图/防无效小体积错误体） */
function posterHtml(pic, lazyAttr) {
  return '<div class="ph"></div>' + (pic ? `<img src="${pimg(pic)}" ${lazyAttr || 'loading="lazy"'} decoding="async" referrerpolicy="no-referrer" onerror="this.remove()">` : '');
}
function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }
function toast(title, content, ms = 4000) {
  const el = document.createElement('div'); el.className = 'toast';
  el.innerHTML = `<div class="tt">${title}</div>` + (content ? `<div class="tc">${content}</div>` : '');
  $('#toast').appendChild(el);
  setTimeout(() => el.remove(), ms);
}

/* ---------- 登录 ---------- */
async function login() {
  const u = $('#gUser').value.trim(), p = $('#gPass').value;
  $('#gateErr').textContent = '';
  try {
    const r = await fetch('/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: u, password: p }) });
    const j = await r.json();
    if (!r.ok) { $('#gateErr').textContent = j.error || '登录失败'; return; }
    TOKEN = j.token; localStorage.setItem(TOKEN_KEY, TOKEN); ME = j.user;
    mountShell();   // 登录瞬间挂载骨架，否则 root 为空导致黑屏
    enterApp();
  } catch (e) { $('#gateErr').textContent = '网络错误'; }
}
function logout() {
  const t = TOKEN;
  TOKEN = ''; localStorage.removeItem(TOKEN_KEY); ME = null;
  try { fetch('/api/auth/logout', { method: 'POST', headers: { 'Authorization': 'Bearer ' + t } }); } catch (e) {}
  location.reload();
}

/* ---------- Hero 配置应用（init 与登录两条路径都要走，否则登出重登后大标题回退占位文案） ---------- */
function applyHero(pub) {
  const HG = pub.hero || {};
  const ht = $('#heroTitle');
  if (ht) {
    ht.textContent = HG.title || pub.siteName || 'AIStream';
    if (HG.titleSize) ht.style.fontSize = HG.titleSize + 'px';
    /* 标题 CSS 默认 background-clip:text + color:transparent（渐变字）。
       自定义颜色必须同时设 -webkit-text-fill-color，否则部分内核下不生效；清空时两个都要复位 */
    if (HG.titleColor) { ht.style.color = HG.titleColor; ht.style.webkitTextFillColor = HG.titleColor; }
    else { ht.style.color = ''; ht.style.webkitTextFillColor = ''; }
  }
  const hs = $('#heroSub');
  if (hs) {
    if (HG.sub) hs.textContent = HG.sub;
    if (HG.subSize) hs.style.fontSize = HG.subSize + 'px';
    hs.style.color = HG.subColor || '';
  }
}

/* ---------- 进入应用（每步独立容错） ---------- */
async function enterApp() {
  const bootGen = VIEW_GEN;   // 启动期基准：若用户在启动完成前已自行切换视图，启动导航不再覆盖
  $('#gate').classList.add('hidden');
  $('#hdr').classList.remove('hidden');
  $('#main').classList.remove('hidden');
  $('#snav').classList.remove('hidden');
  document.body.classList.add('hasnav');
  /* 1. 身份 */
  try {
    ME = (await api('/api/auth/me')).user;
    $('#uName').textContent = ME.username;
    $('#uAvatar').textContent = ME.username[0].toUpperCase();
    const ab = $('#uAdmin');
    if (ab && ME.role === 'admin') ab.style.display = '';
  } catch (e) { return; }
  renderUserCard();
  /* 2. 站名 + hero 配置 */
  try {
    const pub = await api('/api/public');
    document.title = (pub.hero && pub.hero.pageTitle) || (pub.siteName || 'AIStream') + ' · AI 影视';
    applyHero(pub);
    const logo = $('#hdrLogo');
    if (logo && logo.childNodes[0]) logo.childNodes[0].nodeValue = (pub.siteName || 'AIStream') + ' ';
    const sl = $('#snavLogo');
    if (sl && sl.childNodes[0]) sl.childNodes[0].nodeValue = pub.siteName || 'AIStream';
  } catch (e) {}
  /* 3. 配置：提示/公告/广播 */
  try {
    const cfg = await api('/api/config');
    /* 顶栏 LED 滚动条：文字/字号/速度/颜色后台「防上当」设置控制 */
    const led = $('#hdrLed');
    if (led && cfg.toggles && cfg.toggles.antiScam) {
      const tg = cfg.toggles;
      led.innerHTML = '<span class="as-track"></span>';
      const tr = led.querySelector('.as-track');
      tr.textContent = '\u3000' + (tg.antiScamText || '') + '\u3000';
      tr.style.animationDuration = (Number(tg.antiScamSpeed) || 15) + 's';
      tr.style.fontSize = (Number(tg.antiScamSize) || 13) + 'px';
      tr.style.setProperty('--as-from', (Number(tg.antiScamFrom) || 100) + '%');
      tr.style.setProperty('--as-to', (Number(tg.antiScamTo) || -100) + '%');
      if (tg.antiScamColor) tr.style.color = tg.antiScamColor;
      led.classList.remove('hidden');
      /* v65 手机端：顶栏 LED 窗口窄，默认 100%→-100% 的百分比是相对容器宽的，
         长文字大部分时间在窗口外 → 永远看不全。改成按实际文字宽度算 px 距离：
         从容器右侧外完整进入、左侧外完整出去，每个周期都能看完整句 */
      if (window.IS_MOBILE) requestAnimationFrame(() => {
        const tw = tr.scrollWidth || 600, cw = led.clientWidth || 320;
        tr.style.setProperty('--as-from', cw + 'px');
        tr.style.setProperty('--as-to', (-tw - 20) + 'px');
        tr.style.animationDuration = Math.max(10, Math.round((cw + tw) / 55)) + 's';
      });
    }
    /* 侧边栏按权限显示：IPTV 受总开关+个人权限双重控制，其余栏目按 viewPerm */
    PERM = cfg.views || null;
    IV_ENABLED = !!(cfg.iptv && cfg.iptv.enabled);
    applyPerm();
    if (cfg.announcement && cfg.announcement.enabled) maybeShowAnno(cfg.announcement);
    /* 广播推送：仅在推送处于「启用」状态时才补显末条（关推送后新用户不应再看到历史推送） */
    if (cfg.broadcast && cfg.broadcast.enabled && cfg.lastBroadcast) {
      const seen = localStorage.getItem('aistream_lastBc') || '0';
      if (cfg.lastBroadcast.time > +seen) {
        showBroadcast(cfg.lastBroadcast);
        localStorage.setItem('aistream_lastBc', String(cfg.lastBroadcast.time));
      }
    }
  } catch (e) {}
  connectSSE();
  /* v63：有 ?q= 就别先加载推荐页——直接搜，省一轮无效请求，也避免 newView 把搜索结果冲掉 */
  if (runPendingSearch()) return;
  /* 支持 /index.html?view=history|fav 直达对应视图（播放页「查看更多」跳转） */
  if (VIEW_GEN === bootGen) navTo(new URLSearchParams(location.search).get('view') || 'rec');
}

function showAnno(a) {
  $('#annoTitle').textContent = a.title || '公告';
  $('#annoContent').textContent = a.content || '';
  const box = $('#anno .anno-box');
  const close = $('#annoClose');
  const nr = $('#annoNr'), nrWrap = $('#annoNrWrap');
  if (a.mode === 'maintenance') {
    if (box) box.classList.add('anno-maint');
    if (close) close.style.display = 'none';        // 维护公告：前台无法关闭
    if (nrWrap) nrWrap.style.display = 'none';       // 维护公告无「不再提示」勾选
  } else {
    if (box) box.classList.remove('anno-maint');
    if (close) close.style.display = '';
    if (nrWrap) nrWrap.style.display = '';
    if (nr) nr.checked = false;
  }
  $('#anno').style.display = 'grid';
}
/* 维护公告每次强制弹；普通公告若用户当天已勾选「不再提示」则跳过（前台勾选决定，不在后台配） */
function maybeShowAnno(a) {
  if (!a || !a.enabled) return;
  if (a.mode === 'maintenance') { showAnno(a); return; }
  const today = new Date(Date.now() + 8 * 3600e3).toISOString().slice(0, 10);
  if (localStorage.getItem('aistream_anno_date') === today) return;
  showAnno(a);
}
/* 广播醒目横幅（替代小 toast）：右下方大卡片，可关闭；连续推送时服务端会反复触发再次弹出 */
function showBroadcast(msg) {
  let box = $('#bcBanner');
  if (!box) { box = document.createElement('div'); box.id = 'bcBanner'; box.className = 'bc-banner hidden'; document.body.appendChild(box); }
  const t = esc((msg && msg.title) || '系统通知');
  const c = esc((msg && msg.content) || '');
  box.innerHTML = '<div class="bc-ic">📢</div><div class="bc-body"><div class="bc-t">' + t + '</div>' + (c ? '<div class="bc-c">' + c + '</div>' : '') + '</div><button class="bc-x" aria-label="关闭">×</button>';
  box.querySelector('.bc-x').onclick = () => box.classList.add('hidden');
  box.classList.remove('hidden');
}

/* ---------- SSE ---------- */
function connectSSE() {
  const es = new EventSource('/api/stream?token=' + encodeURIComponent(TOKEN));
  es.onmessage = e => {
    let m; try { m = JSON.parse(e.data); } catch (x) { return; }
    if (m.type === 'broadcast') { showBroadcast(m.data); localStorage.setItem('aistream_lastBc', String((m.data && m.data.time) || Date.now())); }
    else if (m.type === 'announcement') maybeShowAnno(m.data);
  };
  es.onerror = () => {};
}

/* ---------- 卡片 ---------- */
/* 上游资源卡片（hover 显示「立即播放」） */
function upCard(c, withPly) {
  const d = document.createElement('div'); d.className = 'card';
  const pic0 = c.poster_url || c.carousel_url || c.backdrop_url || '';
  const pic = badPoster(pic0) ? '' : pic0;
  const kind = KINDNAME[c.content_kind] || (c.content_kind || '');
  const poster = posterHtml(pic);
  d.innerHTML = `<div class="poster">${poster}${c.year ? `<div class="score">${c.year}</div>` : ''}
    <div class="meta"><div class="t">${esc(c.title || c.normalized_title || '')}</div><div class="yr">${[kind, c.area].filter(Boolean).join(' · ')}</div></div>
    ${withPly ? '<div class="ply">▶ 立即播放</div>' : ''}</div>`;
  d.onclick = () => {
    prefetchUpDetail(c.id);
    const q = new URLSearchParams({ src: 'up', id: c.id || '', title: c.title || c.normalized_title || '', year: c.year || '', poster: pic || '' });
    location.href = '/player.html?' + q.toString();
  };
  return d;
}

/* 上游 id 一律是 av_ 开头的 token；TMDB 榜单卡是纯数字 id，
   直接拿数字 id 去打 /api/up/detail 会被上游 500，必须走片名检索 */
function isUpId(v) { return /^av_/.test(String(v || '')); }
/* v53：点击卡片即预热——打服务端 /api/up/warm（立即返回，detail 后台拉齐进缓存）。
   不用浏览器端 fetch 预取：页面跳转会把在途请求取消掉，服务端 warm 不受影响 */
function prefetchUpDetail(id) {
  try {
    if (!isUpId(id)) return;
    fetch('/api/up/warm?id=' + encodeURIComponent(id), { headers: { 'Authorization': 'Bearer ' + (TOKEN || '') } }).catch(() => {});
  } catch (e) {}
}
async function playItem(it, pic) {
  if (isUpId(it.id)) { prefetchUpDetail(it.id); location.href = '/player.html?' + new URLSearchParams({ src: 'up', id: it.id, title: it.title || it.normalized_title || '', year: it.year || '', poster: pic || '' }).toString(); return; }
  /* TMDB 卡没有上游 id：在当前页原地检索正牌 av_ id 后直接进播放页。
     不再跳 /index.html?autosearch 重载整页 —— 那会让登录框闪一下再跳转 */
  const t = it.title || it.normalized_title || '';
  if (await findPlayable(it)) return;
  /* v72：带上「采集站 id + 站内 vod_id」——播放页据此精确取源，不靠站方搜索接口
     （很多采集站只开放列表，按名字搜会扑空，表现为首页有卡片但进播放页「暂无片源」）
     v73c：poster 也带上——以前不带，播放历史/收藏里这类条目全是无图灰块 */
  const q = { title: t, media: 'collect' };
  if (it.station) q.sid = it.station;
  if (it.id) q.vid = it.id;
  const pp = (pic || it.poster || '');
  if (pp) q.poster = pp;
  location.href = '/player.html?' + new URLSearchParams(q).toString();
}

/* 首页栏目卡片（/api/home：TMDB 榜单/采集站条目，点击走片名聚合播放） */
function homeCard(it) {
  const d = document.createElement('div'); d.className = 'card';
  const pic0 = it.poster || it.backdrop || '';
  const pic = badPoster(pic0) ? '' : pic0;
  const poster = posterHtml(pic);
  d.innerHTML = `<div class="poster">${poster}${it.year ? `<div class="score">${it.year}</div>` : ''}
    <div class="meta"><div class="t">${esc(it.title || '')}</div><div class="yr">${[it.media === 'movie' ? '电影' : '剧集', it.score ? '★' + it.score : ''].filter(Boolean).join(' · ')}</div></div>
    <div class="ply">▶ 立即播放</div></div>`;
  d.onclick = () => {
    playItem(it, pic);
  };
  return d;
}

/* 继续观看卡片（带进度条 + 移除） */
function histCard(it) {
  const d = document.createElement('div'); d.className = 'card rec';
  const prog = it.dur ? Math.min(100, Math.round(it.pos / it.dur * 100)) : 0;
  const epInfo = it.epTotal ? `第 ${it.ep + 1}/${it.epTotal} 集` : (it.year || '');
  const poster = posterHtml(badPoster(it.poster) ? '' : it.poster);
  d.innerHTML = `<div class="poster">${poster}
    <div class="meta"><div class="t">${esc(it.title)}</div><div class="yr">${esc(epInfo)}</div></div>
    <div class="pbar"><i style="width:${prog}%"></i></div>
    <div class="del" title="从记录移除">✕</div></div>`;
  d.onclick = (e) => {
    if (e.target.classList.contains('del')) { e.stopPropagation(); removeHist(it.id); return; }
    if (!isUpId(it.id)) { location.href = '/player.html?' + new URLSearchParams({ title: it.title || '', media: 'collect', ep: it.ep || 0, pos: it.pos || 0, poster: it.poster || '' }).toString(); return; }
    prefetchUpDetail(it.id);
    const q = new URLSearchParams({ src: 'up', id: it.id, title: it.title, year: it.year || '', poster: it.poster || '', ep: it.ep || 0, pos: it.pos || 0 });
    location.href = '/player.html?' + q.toString();
  };
  return d;
}

/* 收藏卡片（带取消收藏） */
function favCard(it) {
  const d = document.createElement('div'); d.className = 'card';
  const pic = badPoster(it.poster) ? '' : it.poster;
  const poster = posterHtml(pic);
  d.innerHTML = `<div class="poster">${poster}
    <div class="meta"><div class="t">${esc(it.title)}</div>${it.year ? `<div class="yr">${esc(it.year)}</div>` : ''}</div>
    <div class="del" title="取消收藏">✕</div></div>`;
  d.onclick = (e) => {
    if (e.target.classList.contains('del')) { e.stopPropagation(); removeFav(it.id); return; }
    if (isUpId(it.id)) prefetchUpDetail(it.id);
    const q = new URLSearchParams({ src: 'up', id: it.id, title: it.title, year: it.year || '', poster: it.poster || '' });
    location.href = '/player.html?' + q.toString();
  };
  return d;
}

/* ---------- 路由 ---------- */
function setActive(key) {
  document.querySelectorAll('.snav-item').forEach(x => x.classList.toggle('active', (x.dataset.kind || x.dataset.view) === key));
}
/* 侧边栏按权限显隐（登录/配置到达后调用） */
function applyPerm() {
  document.querySelectorAll('.snav-item').forEach(el => {
    const k = el.dataset.kind || el.dataset.view;
    if (!k) return;
    if (el.id === 'snavIptv') { el.classList.toggle('hidden', !(IV_ENABLED && (!PERM || PERM.iptv !== false))); return; }
    if (PERM) el.classList.toggle('hidden', PERM[k] === false);
  });
}
function navTo(key) {
  if (PERM && PERM[key] === false) { toast('🔒 管理员未对你的账号开放该栏目'); return; }
  setActive(key);
  /* IPTV 视图隐藏 hero 和大搜索框，让播放器顶上去 */
  document.body.classList.toggle('mode-iptv', key === 'iptv');
  if (key === 'history') return loadHistoryView();
  if (key === 'fav') return loadFavView();
  if (key === 'points') return loadPointsView();
  if (key === 'iptv') return loadIptvView();
  CUR_KIND = key;
  return key === 'rec' ? loadRec() : loadKind(key);
}

/* ---------- 首启引导卡片（分发版：空壳还没接任何采集站时显示） ---------- */
function setupCard() {
  return '<div class="empty" style="max-width:600px;margin:26px auto;text-align:left;line-height:2">'
    + '<div style="font-size:17px;font-weight:600;margin-bottom:12px">🚀 站点已就绪，接下来接入你的采集站</div>'
    + '<div style="opacity:.8;font-size:13.5px">'
    + '这是一个影视聚合程序，内容由站长自己接入的采集站提供，程序本身不内置任何资源地址。<br>'
    + '<b>①</b> 打开后台 →「采集站」→ 粘贴苹果CMS 采集 API 地址 → 点「立即自检」<br>'
    + '<b>②</b> 保存后回到首页，该站点的最新内容会自动出现（也可在后台「首页栏目」里挑选栏目）'
    + '</div>'
    + '<div style="margin-top:16px;display:flex;gap:10px;flex-wrap:wrap">'
    + '<a class="btn" href="/admin.html">打开后台</a>'
    + '<button class="btn" onclick="navTo(\'rec\')">刷新首页</button>'
    + '</div></div>';
}

/* ---------- 首页推荐（继续观看置顶 + 上游 feed 分栏） ---------- */
async function loadRec() {
  const c = $('#content');
  const gen = newView();
  LD_STATE = { done: 0 };
  mountLoader(c, { icon: '✨', title: '正在为你挑选今日推荐',
    stages: ['正在读取观影历史…', '正在拉取首页栏目数据…', '正在获取海报与评分…', 'TMDB 出网偶有延迟，正在耐心等待…'],
    note: '首次加载需拉取海报资源，稍等片刻', skeleton: 12 });
  REC_POOL = [];
  /* loader 保持到第一块真实内容就绪再清：/api/home 慢（TMDB 出网可达 8s）时不许白屏 */
  let cleared = false;
  const ensureClear = () => { if (!cleared) { c.innerHTML = ''; cleared = true; } };
  try {
    const hist = await api('/api/history').catch(() => ({ items: [] }));
    ck(gen);
    const hi = (hist.items || []).filter(x => x && x.id);
    if (hi.length) {
      ensureClear();
      const sec = document.createElement('section'); sec.className = 'col';
      sec.innerHTML = `<h2>🕘 历史记录 <a id="histClr" class="clr-link">清空记录</a></h2>`;
      const clrA = sec.querySelector('#histClr');
      if (clrA) clrA.onclick = async () => {
        if (!confirm('确定清空全部观看记录？此操作不可恢复')) return;
        try {
          await fetch('/api/history', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + TOKEN }, body: JSON.stringify({ clear: true }) });
          toast('观看记录已清空'); loadRec();
        } catch (e) { toast('清空失败，请重试'); }
      };
      mountHistGrid(sec, hi);
      c.appendChild(sec);
    }
    loadWeekly(gen);   // 本周追剧：异步追加，不阻塞首页栏目
    /* 后台「首页栏目管理」配置优先（/api/home = 配置的 TMDB 榜单/采集站栏目），上游 feed 兜底 */
    let rendered = false, stations = -1, hasUp = false;
    try {
      const hj = await api('/api/home');
      ck(gen);
      if (hj && typeof hj.stations === 'number') stations = hj.stations;
      hasUp = !!(hj && hj.hasUpstream);
      ensureClear();
      /* v74：一条栏目把服务端给的条目全部渲染（服务端已按整行数给够），
         底部挂「显示更多」——按栏目序号向 /api/home/more 翻页，拉到的直接接在同一个网格里。
         v1.1 口径不变：没海报但有片名的条目照样渲染，由卡片里的 .ph 占位垫底 */
      (hj.columns || []).forEach((col, ci) => {
        const items = (col.items || []).filter(x => x && (x.title || x.name));
        if (!items.length) return;
        const sec = document.createElement('section'); sec.className = 'col';
        sec.innerHTML = `<h2>${esc(col.label || '精选推荐')}</h2><div class="results"></div>`;
        const grid = sec.querySelector('.results');
        for (const it of items) { grid.appendChild(homeCard(it)); REC_POOL.push(it); }
        const srvIdx = typeof col.idx === 'number' ? col.idx : ci;
        let pg = 1, busy = false;
        const more = document.createElement('button');
        more.className = 'hist-more';
        more.textContent = '显示更多';
        more.onclick = async () => {
          if (busy) return; busy = true;
          more.textContent = '加载中…';
          try {
            const j2 = await api('/api/home/more?idx=' + srvIdx + '&page=' + (pg + 1));
            const add = (j2.items || []).filter(x => x && (x.title || x.name));
            if (!add.length) { more.textContent = '已加载全部'; more.disabled = true; }
            else {
              pg++;
              for (const it of add) { grid.appendChild(homeCard(it)); REC_POOL.push(it); }
              more.textContent = '显示更多';
            }
          } catch (e) { more.textContent = '加载失败，点此重试'; }
          busy = false;
        };
        sec.appendChild(more);
        c.appendChild(sec); rendered = true;
      });
    } catch (e) {}
    if (!rendered) {
      /* 空壳没接上游时 /api/up/feed 必然 401/500，别再白打一次（省 1 次请求也省日志噪音） */
      if (!hasUp) {
        ensureClear();
        if (stations === 0 && !hi.length) { c.innerHTML = setupCard(); return; }
        if (!hi.length) { c.innerHTML = '<div class="empty">采集站已接入 ' + stations + ' 个，但没拉到内容：到后台「采集站管理」点一下「测通」，确认站源地址可用（苹果CMS 地址通常长这样 https://站点/api.php/provide/vod）</div>'; return; }
      } else {
        ensureClear();
        try {
          const j = await api('/api/up/feed');
          ck(gen);
          for (const s of (j.sections || [])) {
            const cards = (s.cards || s.items || []).filter(x => x && (x.poster_url || x.carousel_url || x.backdrop_url || x.title || x.name));
            if (!cards.length) continue;
            const sec = document.createElement('section'); sec.className = 'col';
            sec.innerHTML = `<h2>${esc(s.title || s.name || '精选推荐')}</h2><div class="row"></div>`;
            const row = sec.querySelector('.row');
            for (const it of cards.slice(0, 20)) { row.appendChild(upCard(it, true)); REC_POOL.push(it); }
            c.appendChild(sec);
          }
        } catch (e) {}
      }
    }
    if (!c.children.length) { ensureClear(); c.innerHTML = '<div class="empty">暂无内容</div>'; }
  } catch (e) { if (e === VIEW_ABORT) return; ensureClear(); c.innerHTML = '<div class="empty">首页加载失败 &nbsp;<button class="btn" onclick="navTo(\'rec\')">重试</button></div>'; }
}

/* ---------- 分类网格（v54：分页 + 「显示更多」） ---------- */
async function loadKind(kind) {
  const c = $('#content');
  const gen = newView();
  LD_STATE = { done: 0 };
  mountLoader(c, { icon: '🗂️', title: '正在加载「' + (KINDNAME[kind] || kind) + '」榜单',
    stages: ['正在向资源库拉取分类榜单…', '正在并行扫描多个采集站…', '正在去重并按热度排序…'],
    skeleton: 12 });
  let page = 1, sec = null, grid = null, moreBtn = null, busy = false;
  /* v55：短剧上游每页固定 12 条（pageSize 服务端回传），其他分类 48；
     按真实页大小判断「还有没有下一页」，别再拿 48 一刀切（短剧因此从来没出过按钮） */
  const PS0 = kind === 'short' ? 12 : 48;
  let PS = PS0;
  const ensureMore = () => {
    if (!sec || moreBtn) return;
    moreBtn = document.createElement('button');
    moreBtn.className = 'hist-more';
    moreBtn.textContent = '显示更多';
    moreBtn.onclick = async () => {
      if (busy) return; busy = true;
      moreBtn.textContent = '加载中…';
      try {
        const j2 = await api('/api/up/catalog?kind=' + encodeURIComponent(kind) + '&limit=' + PS + '&page=' + (page + 1));
        ck(gen);
        const more = (j2.items || []).filter(x => x && x.id);
        if (!more.length) { moreBtn.textContent = '已加载全部'; moreBtn.disabled = true; busy = false; return; }
        page++;
        for (const it of more) grid.appendChild(upCard(it, true));
        if (more.length < PS) { moreBtn.textContent = '已加载全部'; moreBtn.disabled = true; }
        else moreBtn.textContent = '显示更多';
      } catch (e) { moreBtn.textContent = '加载失败，点此重试'; }
      busy = false;
    };
    sec.appendChild(moreBtn);
  };
  try {
    const j = await api('/api/up/catalog?kind=' + encodeURIComponent(kind) + '&limit=' + PS + '&page=1');
    ck(gen);
    if (j.pageSize) PS = j.pageSize;
    const items = (j.items || []).filter(x => x && x.id);
    if (!items.length) { c.innerHTML = '<div class="empty">该分类暂无内容</div>'; return; }
    c.innerHTML = '';
    sec = document.createElement('section'); sec.className = 'col';
    sec.innerHTML = `<h2>${KINDNAME[kind] || kind} · 热门推荐</h2><div class="results"></div>`;
    grid = sec.querySelector('.results');
    for (const it of items) grid.appendChild(upCard(it, true));
    c.appendChild(sec);
    if (items.length >= PS) ensureMore();   /* 满页才有可能有下一页，不满就是全部了 */
  } catch (e) { if (e === VIEW_ABORT) return; c.innerHTML = '<div class="empty">加载失败 &nbsp;<button class="btn" onclick="navTo(\'' + kind + '\')">重试</button></div>'; }
}

/* ---------- 继续观看 ---------- */
/* ---------- 历史记录网格：PC 一行 7 个 / 手机一行 2 个，其余折叠进「显示更多」 ---------- */
function HIST_ROW() { return window.IS_MOBILE ? 2 : 7; }
function mountHistGrid(sec, items) {
  const grid = document.createElement('div');
  grid.className = 'results hist-grid';
  items.forEach(it => grid.appendChild(histCard(it)));
  sec.appendChild(grid);
  const one = HIST_ROW();
  if (items.length > one) {
    Array.from(grid.children).forEach((el, i) => { if (i >= one) el.style.display = 'none'; });
    const more = document.createElement('button');
    more.className = 'hist-more';
    more.setAttribute('data-open', '0');
    more.textContent = '显示更多（共 ' + items.length + ' 条）';
    more.onclick = () => {
      const open = more.getAttribute('data-open') === '1';
      Array.from(grid.children).forEach((el, i) => { if (i >= one) el.style.display = open ? 'none' : ''; });
      more.setAttribute('data-open', open ? '0' : '1');
      more.textContent = open ? ('显示更多（共 ' + items.length + ' 条）') : '收起 ▴';
      if (!open) more.scrollIntoView({ block: 'nearest' });
    };
    sec.appendChild(more);
  }
  return grid;
}

async function loadHistoryView() {
  /* v47：兜底——?view=history 直达也要过权限（同 loadFavView） */
  if (PERM && PERM.history === false) { toast('🔒 管理员未对你的账号开放该栏目'); return navTo('rec'); }
  const c = $('#content');
  const gen = newView();
  LD_STATE = { done: 0 };
  mountLoader(c, { icon: '🕘', title: '正在读取观看记录',
    stages: ['正在同步本机观看进度…', '正在拉取最新封面…'], skeleton: 10 });
  try {
    const j = await api('/api/history');
    ck(gen);
    const items = (j.items || []).filter(x => x && x.id);
    if (!items.length) { c.innerHTML = '<div class="empty">还没有观看记录，去首页挑一部吧 🎬</div>'; return; }
    c.innerHTML = '';
    const sec = document.createElement('section'); sec.className = 'col';
    sec.innerHTML = `<h2>🕘 历史记录 <a id="histClr2" class="clr-link">清空记录</a></h2>`;
    const clr2 = sec.querySelector('#histClr2');
    if (clr2) clr2.onclick = async () => {
      if (!confirm('确定清空全部观看记录？此操作不可恢复')) return;
      try {
        await fetch('/api/history', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + TOKEN }, body: JSON.stringify({ clear: true }) });
        toast('观看记录已清空'); loadHistoryView();
      } catch (e) { toast('清空失败，请重试'); }
    };
    mountHistGrid(sec, items);
    c.appendChild(sec);
  } catch (e) { if (e === VIEW_ABORT) return; c.innerHTML = '<div class="empty">加载失败</div>'; }
}

/* ---------- 侧栏「我的」区用户卡：头像 + 会员等级 + 成长进度 + 签到/邀请 ---------- */
/* 复制文本：navigator.clipboard 仅在 HTTPS/localhost 可用，http 访问会抛异常 → 必须用 execCommand 兜底 */
async function copyText(t) {
  try { if (navigator.clipboard && navigator.clipboard.writeText) { await navigator.clipboard.writeText(t); return true; } } catch (e) {}
  try {
    const ta = document.createElement('textarea');
    ta.value = t;
    ta.setAttribute('readonly', '');
    ta.style.cssText = 'position:fixed;left:-9999px;top:0;opacity:0';
    document.body.appendChild(ta);
    ta.select(); ta.setSelectionRange(0, ta.value.length);
    const ok = document.execCommand('copy');
    document.body.removeChild(ta);
    if (ok) return true;
  } catch (e) {}
  return false;
}
async function renderUserCard() {
  const card = $('#uCard'); if (!card) return;
  try {
    const j = await api('/api/points/me');
    const g = j.growth || {}, vip = j.vip || {}, inv = j.invite || {}, ck = j.checkin || {};
    const ckBase = ((j.cfg || {}).checkin || {}).base || 0;
    $('#ucAv').textContent = (ME && ME.username ? ME.username[0] : 'U').toUpperCase();
    $('#ucName').textContent = ME ? ME.username : '';
    $('#ucSub').textContent = vip.level > 0 ? (vip.days > 0 ? '会员生效中 · 剩 ' + vip.days + ' 天' : '会员生效中 · 永久') : '账号使用中';
    $('#ucLvName').textContent = vip.name || '普通用户';
    $('#ucLvName').classList.toggle('on', vip.level > 0);
    $('#ucPct').textContent = (g.progress != null ? g.progress : 0) + '%';
    $('#ucBar').style.width = Math.max(3, Math.min(100, g.progress != null ? g.progress : 0)) + '%';
    $('#ucInvPts').textContent = inv.perInvite || 0;
    $('#ucHint').innerHTML = g.next
      ? ('还差 <b>' + g.need + '</b> 分升级「' + esc(g.next.name) + '」<br>可邀 <b>' + (g.inviteNeed || 0) + '</b> 位好友，或签到看片积累')
      : ('成长值 <b>' + (g.points || 0) + '</b>，已是最高等级 🎉');
    /* 签到按钮：未签到显示可领分数，已签到显示连签天数 */
    const ckb = $('#ucCheckin');
    if (ckb) {
      ckb.disabled = !!ck.today;
      ckb.innerHTML = ck.today ? '✅ 已签到 <b>' + (ck.streak || 0) + '</b> 天' : '📅 签到领 <b>' + ckBase + '</b> 分';
      ckb.onclick = async () => {
        ckb.disabled = true;
        try {
          const r = await api('/api/checkin', { method: 'POST', body: {} });
          if (r && r.ok) {
            toast('签到成功 +' + r.gained + ' 分' + (r.streak > 1 ? '（连签 ' + r.streak + ' 天）' : ''));
            ckb.innerHTML = '✅ 已签到 <b>' + (r.streak || 0) + '</b> 天';
            renderUserCard();
          } else { toast((r && r.error) || '签到失败'); ckb.disabled = false; }
        } catch (e) { toast('签到失败'); ckb.disabled = false; }
      };
    }
  } catch (e) {}
  const ib = $('#ucInvite');
  if (ib) ib.onclick = async () => {
    let code = '';
    try { code = (await api('/api/points/me')).invite.code || ''; } catch (e) {}
    const link = location.origin + '/index.html?invite=' + encodeURIComponent(code);
    const okc = await copyText(link);
    toast(okc ? '邀请链接已复制，发给好友即可' : '复制失败，请手动复制：' + link);
  };
}

/* ---------- 我的收藏 ---------- */
async function loadFavView() {
  /* v47：兜底——?view=fav 直达也要过权限，别绕过侧栏隐藏直接进 */
  if (PERM && PERM.fav === false) { toast('🔒 管理员未对你的账号开放该栏目'); return navTo('rec'); }
  const c = $('#content');
  const gen = newView();
  LD_STATE = { done: 0 };
  mountLoader(c, { icon: '⭐', title: '正在读取收藏夹',
    stages: ['正在拉取收藏列表…', '正在更新封面与状态…'], skeleton: 10 });
  try {
    const j = await api('/api/fav');
    ck(gen);
    const items = (j.items || []).filter(x => x && x.id);
    if (!items.length) { c.innerHTML = '<div class="empty">还没有收藏，看到喜欢的点击 ⭐ 收藏吧</div>'; return; }
    c.innerHTML = '';
    const sec = document.createElement('section'); sec.className = 'col';
    sec.innerHTML = `<h2>⭐ 我的收藏</h2><div class="results"></div>`;
    const grid = sec.querySelector('.results');
    items.forEach(it => grid.appendChild(favCard(it)));
    c.appendChild(sec);
  } catch (e) { if (e === VIEW_ABORT) return; c.innerHTML = '<div class="empty">加载失败</div>'; }
}

/* ---------- 积分兑换列表（会员时长 / 限时权限） ---------- */
const REDEEM_KIND = { iptv: '📡 IPTV', rec: '🔥 推荐', movie: '🎬 电影', series: '📺 剧集', anime: '🐣 动漫', variety: '🎤 综艺', short: '🎭 短剧', history: '🕘 历史记录', fav: '⭐ 我的收藏', skipIntro: '⏭ 跳过片头', skipOutro: '⏭ 跳过片尾' };
async function loadRedeemList(box) {
  if (!box) return;
  let j = null;
  try { j = await api('/api/redeem'); } catch (e) { box.innerHTML = '<div class="pts-tip">兑换列表加载失败</div>'; return; }
  if (!j || j.enabled === false) { box.innerHTML = '<div class="pts-tip">兑换功能暂未开启</div>'; return; }
  const items = j.items || [], me = j.me || {};
  if (!items.length) { box.innerHTML = '<div class="pts-tip">暂无兑换项，敬请期待</div>'; return; }
  box.innerHTML = '<div class="rd-list">' + items.map(it => {
    const what = it.kind === 'perm' ? (REDEEM_KIND[it.permKey] || it.permKey) + ' 权限' : ((it.level === 0 ? '取消会员' : 'Lv' + it.level + ' 会员'));
    const dur = it.days > 0 ? it.days + ' 天' : '永久';
    const can = (me.points || 0) >= it.cost && !it.soldOut;
    return `<div class="rd-item">
      <div class="rd-main"><div class="rd-t">${esc(it.title)}</div>
        <div class="rd-d">${esc(it.desc || (what + ' · ' + dur))}</div>
        <div class="rd-meta">${what} · ${dur}${it.stock > 0 ? ' · 剩 ' + it.stock + ' 份' : ''}</div></div>
      <div class="rd-side"><div class="rd-cost"><b>${it.cost}</b> 分</div>
        <button class="btn ${can ? 'primary' : ''}" data-rd="${esc(it.id)}" ${can ? '' : 'disabled'}>${it.soldOut ? '已兑完' : ((me.points || 0) < it.cost ? '积分不足' : '兑换')}</button></div>
    </div>`;
  }).join('') + '</div><div class="pts-tip">当前积分 <b>' + (me.points || 0) + '</b>，兑换后实时到账。</div>';
  box.querySelectorAll('[data-rd]').forEach(b => {
    b.onclick = async () => {
      b.disabled = true;
      try {
        const r = await api('/api/redeem', { method: 'POST', body: { id: b.dataset.rd } });
        if (r && r.ok) { toast(r.msg || '兑换成功'); renderUserCard(); loadPointsView(); }
        else { toast((r && r.error) || '兑换失败'); b.disabled = false; }
      } catch (e) { toast('兑换失败'); b.disabled = false; }
    };
  });
}

async function removeHist(id) { await api('/api/history', { method: 'DELETE', headers: { 'Content-Type': 'application/json' }, body: { id } }).catch(() => {}); loadHistoryView(); }
async function removeFav(id) { await api('/api/fav', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: { del: id } }).catch(() => {}); loadFavView(); }

/* ---------- 积分中心：签到 / 邀请 / 积分规则 ---------- */
async function loadPointsView() {
  const c = $('#content');
  const gen = newView();
  LD_STATE = { done: 0 };
  mountLoader(c, { icon: '🎁', title: '正在打开积分中心', stages: ['正在读取积分与签到状态…'], skeleton: 4 });
  try {
    const j = await api('/api/points/me');
    ck(gen);
    const cfg = j.cfg || {};
    const vip = j.vip || {};
    const ck1 = j.checkin || {}, inv = j.invite || {};
    const link = location.origin + '/index.html?invite=' + encodeURIComponent(inv.code || '');
    c.innerHTML = '';
    const sec = document.createElement('section'); sec.className = 'col';
    sec.innerHTML = `<h2>🎁 积分中心</h2>
      <div class="pts-wrap">
        <div class="pts-card">
          <div class="pts-num"><b>${j.points || 0}</b><span>我的积分</span></div>
          <div class="pts-vip">${vip.level > 0 ? '当前身份：<b>' + esc(vip.name) + '</b>（积分 x' + (vip.pointMul || 1) + (vip.days > 0 ? '，剩 ' + vip.days + ' 天' : '，永久') + '）' : '当前身份：普通用户（升级会员享积分倍率与去广告特权）'}</div>
          <div class="pts-btns">
            <button class="btn primary" id="ptsCk" ${ck1.today ? 'disabled' : ''}>${ck1.today ? '今日已签到' : '每日签到 +' + ((cfg.checkin || {}).base || 0)}</button>
            <button class="btn" id="ptsInv">邀请好友</button>
            <button class="btn" id="ptsCopy">复制邀请链接</button>
          </div>
          <div class="pts-sub">连续签到 <b>${ck1.streak || 0}</b> 天${((cfg.checkin || {}).streakBonus || 0) > 0 ? '（每连签 1 天额外 +' + (cfg.checkin || {}).streakBonus + '，上限 ' + ((cfg.checkin || {}).streakMax || 0) + ' 天）' : ''}　·　已邀请 <b>${inv.invited || 0}</b> 人</div>
        </div>
        <div class="pts-card">
          <h3>积分规则</h3>
          <div class="pts-rule"><span>📅 每日签到</span><b>+${(cfg.checkin || {}).base || 0} 分/天</b></div>
          <div class="pts-rule"><span>🤝 邀请注册</span><b>+${(cfg.invite || {}).perInvite || 0} 分/人${(cfg.invite || {}).requireRegister ? '（本站需邀请码注册）' : ''}</b></div>
          <div class="pts-rule"><span>🎬 观看影视</span><b>+${(cfg.watch || {}).pointsPerMin || 0} 分/分钟（每日上限 ${(cfg.watch || {}).dailyCapMin || 0} 分钟）</b></div>
          <div class="pts-rule"><span>👑 会员倍率</span><b>积分 x${vip.pointMul || 1}</b></div>
          <div class="pts-tip">今日已观看计 ${(j.daily || {}).watchMin || 0} 分钟。积分由系统自动累计，无需手动领取。</div>
        </div>
        <div class="pts-card">
          <h3>我的邀请码</h3>
          <div class="pts-code">${esc(inv.code || '')}</div>
          <div class="pts-linkbox"><input id="ptsLink" readonly value="${esc(link)}"><button class="btn primary" id="ptsCopy2">复制</button></div>
          <div class="pts-tip">把链接发给好友，对方注册成功后你自动获得积分。</div>
        </div>
        <div class="pts-card">
          <h3>积分兑换 <span style="color:var(--muted);font-size:12px;font-weight:400">— 用积分兑换会员时长或限时权限</span></h3>
          <div id="rdList"><div class="pts-tip">加载中…</div></div>
        </div>
      </div>`;
    c.appendChild(sec);
    loadRedeemList(sec.querySelector('#rdList'));
    const ckB = sec.querySelector('#ptsCk');
    if (ckB) ckB.onclick = async () => {
      ckB.disabled = true;
      try {
        const r = await api('/api/checkin', { method: 'POST', body: {} });
        if (r && r.ok) { toast('签到成功 +' + r.gained + ' 分' + (r.streak > 1 ? '（连签 ' + r.streak + ' 天）' : '')); loadPointsView(); }
        else { toast((r && r.error) || '签到失败'); ckB.disabled = false; }
      } catch (e) { toast('签到失败'); ckB.disabled = false; }
    };
    const copy = async () => { const inp = sec.querySelector('#ptsLink'); const okc = await copyText(inp.value); toast(okc ? '邀请链接已复制，发给好友即可' : '复制失败，请手动复制：' + inp.value); };
    const c1 = sec.querySelector('#ptsCopy'); if (c1) c1.onclick = copy;
    const c2 = sec.querySelector('#ptsCopy2'); if (c2) c2.onclick = copy;
    const iv = sec.querySelector('#ptsInv'); if (iv) iv.onclick = copy;
  } catch (e) { if (e === VIEW_ABORT) return; c.innerHTML = '<div class="empty">加载失败</div>'; }
}

/* ---------- 富加载态：双层光环 + 阶段提示 + 计时 + 真实完成路数 + 骨架屏 ---------- */
const LD_TIMERS = [];
function stopLoaders() { while (LD_TIMERS.length) clearInterval(LD_TIMERS.pop()); }
/* 说明：计时器会自检 DOM 是否被替换，内容一旦上屏（或节点被移除）自动停表，不残留定时器 */
function mountLoader(c, o) {
  o = o || {};
  const stages = o.stages || ['正在连接资源节点…', '正在拉取海报与元数据…', '正在整理结果…'];
  const sk = o.skeleton || 0;
  stopLoaders();
  const cell = '<div class="ldcard"><div class="ldph"></div><div class="ldl l1"></div><div class="ldl l2"></div></div>';
  c.innerHTML = `<div class="ldbox">
    <div class="ldring"><i></i><i></i><span class="ldico">${o.icon || '◍'}</span></div>
    <div class="ldtitle">${esc(o.title || '加载中')}</div>
    <div class="ldtip" id="ldTip">${esc(stages[0])}</div>
    <div class="ldbar"><i id="ldBar"></i></div>
    <div class="ldmeta">
      <span id="ldTime">已用时 0.0s</span>
      ${o.total ? `<span class="lddot">·</span><span id="ldCnt">已完成 0 / ${o.total} 路</span>` : ''}
    </div>
    ${o.note ? `<div class="ldnote">${esc(o.note)}</div>` : ''}
    ${sk ? `<div class="results ldskeleton">${cell.repeat(sk)}</div>` : ''}
  </div>`;
  const box = c.querySelector('.ldbox');
  const t0 = Date.now();
  let si = 0;
  const tip = $('#ldTip'), tm = $('#ldTime'), bar = $('#ldBar'), cnt = $('#ldCnt');
  LD_TIMERS.push(setInterval(() => {
    if (!box || !box.isConnected) { stopLoaders(); return; }
    if (tip) tip.textContent = stages[(si = (si + 1) % stages.length)];
  }, 1700));
  LD_TIMERS.push(setInterval(() => {
    if (!box || !box.isConnected) { stopLoaders(); return; }
    const sec = (Date.now() - t0) / 1000;
    if (tm) tm.textContent = '已用时 ' + sec.toFixed(1) + 's';
    /* 进度 = 真实完成路数占比（70%）+ 时间爬升（最多 25%），永远不到 100% */
    const pReal = o.total ? (Math.min(LD_STATE.done, o.total) / o.total) * 70 : 0;
    const pTime = Math.min(25, sec / 8 * 25);
    if (bar) bar.style.width = Math.min(96, o.total ? pReal + pTime : Math.min(70, sec / 6 * 70)) + '%';
    if (cnt && o.total) cnt.textContent = '已完成 ' + Math.min(LD_STATE.done, o.total) + ' / ' + o.total + ' 路';
  }, 120));
}

/* ---------- 搜索（上游优先 + 采集站兜底）：两路并发，先到先渲染 ---------- */
async function doSearch() {
  const q = $('#sInput').value.trim();
  if (!q) return;
  const c = $('#content');
  const gen = newView();
  LD_STATE = { done: 0 };
  mountLoader(c, {
    icon: '🔍',
    title: '正在搜索「' + q + '」',
    stages: ['正在向官方资源库发起检索…', '正在并行扫描多个采集站…', '正在匹配年份与清晰度…', '正在剔除广告拼接源…', '正在整理海报与详情…'],
    total: 2,
    note: '资源库 + 采集站双路并行，首次搜索需要预热缓存，请稍候',
    skeleton: 12
  });
  let cleared = false;
  const ensure = () => { if (!cleared) { c.innerHTML = ''; cleared = true; } };
  let got = 0;
  let upCount = 0;   /* v56：上游资源库命中数——有结果就不显示采集站（兜底只在无上游结果时出现） */
  /* v56：两路都空时，加载卡会永远转下去（cleared 还是 false）→ 改成按「有没有结果区块」判定，
     没有就统一替换成「未找到」，别留加载卡 */
  const done = () => {
    if (gen !== VIEW_GEN) return;
    got++;
    if (got < 2) return;
    if (c.querySelectorAll('section.col').length) return;
    c.innerHTML = '<div class="empty">未找到「' + esc(q) + '」相关内容</div>';
  };
  const paintUp = items => {
    ck(gen);
    LD_STATE.done++;
    upCount = items.length;
    if (!items.length) return done();
    ensure();
    /* v56：采集站可能比上游先返回先渲染——上游有结果了就把它撤掉 */
    c.querySelectorAll('[data-colsec]').forEach(x => x.remove());
    const sec = document.createElement('section'); sec.className = 'col';
    sec.innerHTML = `<h2>资源库匹配 (${items.length})</h2><div class="results"></div>`;
    const grid = sec.querySelector('.results');
    for (const it of items) grid.appendChild(upCard(it, true));
    c.appendChild(sec); done();
  };
  const paintCol = collect => {
    ck(gen);
    LD_STATE.done++;
    /* v56：上游资源库已有结果 → 采集站不渲染（大哥反馈：搜索时多出「采集站资源」一坨，
       且采集站卡片多数没海报。兜底只留在上游无结果/挂掉时） */
    if (upCount > 0) return done();
    if (!collect.length) return done();
    ensure();
    const sec = document.createElement('section'); sec.className = 'col';
    sec.setAttribute('data-colsec', '1');   /* v56：打标记，上游有结果时可整块撤掉 */
    sec.innerHTML = `<h2>采集站资源 (${collect.length})</h2><div class="results"></div>`;
    const grid = sec.querySelector('.results');
    for (const v of collect) {
      const d = document.createElement('div'); d.className = 'card';
      const poster = v.poster ? `<img src="${v.poster}" loading="lazy" onerror="this.style.opacity=.15">` : '<div class="ph"></div>';
      d.innerHTML = `<div class="poster">${poster}<div class="meta"><div class="t">${esc(v.name)}</div>${v.year ? `<div class="yr">${esc(v.year)}</div>` : ''}</div></div>`;
      d.onclick = () => {
        /* v72：搜索结果同样带上 采集站id + 站内id；v73c：poster 也要带（历史/收藏有图） */
        const qq = { title: v.name, year: v.year || '', media: 'collect' };
        if (v.stationId) qq.sid = v.stationId;
        if (v.id) qq.vid = v.id;
        if (v.poster) qq.poster = v.poster;
        location.href = '/player.html?' + new URLSearchParams(qq).toString();
      };
      grid.appendChild(d);
    }
    c.appendChild(sec); done();
  };
  api('/api/up/search?q=' + encodeURIComponent(q) + '&limit=48')
    .then(r => paintUp((r.items || []).filter(x => x && x.id)))
    .catch(e => { if (e === VIEW_ABORT) return; LD_STATE.done++; done(); });
  api('/api/search?q=' + encodeURIComponent(q))
    .then(r => paintCol(r.collect || []))
    .catch(e => { if (e === VIEW_ABORT) return; LD_STATE.done++; done(); });
}

/* ---------- 事件 ---------- */
/* 未登录时骨架未注入，部分节点不存在 → 全部做空值防护，避免控制台报错 */
$('#gLogin').onclick = login;
$('#gPass').addEventListener('keydown', e => { if (e.key === 'Enter') login(); });

/* ---------- 注册（后台开关控制；关闭时隐藏入口） ---------- */
async function doRegister() {
  const u = $('#gRegUser').value.trim(), p1 = $('#gRegPass').value, p2 = $('#gRegPass2').value;
  $('#gateErr').textContent = '';
  if (p1 !== p2) { $('#gateErr').textContent = '两次输入的密码不一致'; return; }
  try {
    const r = await fetch('/api/auth/register', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: u, password: p1 }) });
    const j = await r.json();
    if (!r.ok) { $('#gateErr').textContent = j.error || '注册失败'; return; }
    TOKEN = j.token; localStorage.setItem(TOKEN_KEY, TOKEN); ME = j.user;
    mountShell();
    enterApp();
  } catch (e) { $('#gateErr').textContent = '网络错误'; }
}
function toggleReg(show) {
  $('#gReg').classList.toggle('hidden', !show);
  $('#gateFoot').classList.toggle('hidden', show);
  $('#gateErr').textContent = '';
}
if ($('#gRegLink')) $('#gRegLink').onclick = () => toggleReg(true);
if ($('#gBackLogin')) $('#gBackLogin').onclick = () => toggleReg(false);
if ($('#gRegBtn')) $('#gRegBtn').onclick = doRegister;
if ($('#gRegPass2')) $('#gRegPass2').addEventListener('keydown', e => { if (e.key === 'Enter') doRegister(); });
/* 未登录才探测注册开关（登录状态下入口反正看不见） */
if (!TOKEN) {
  fetch('/api/public').then(r => r.json()).then(pub => {
    if (pub && pub.regEnabled === false && $('#gateFoot')) $('#gateFoot').classList.add('hidden');
  }).catch(() => {});
}
if ($('#uLogout')) $('#uLogout').onclick = logout;
/* uLogout 在 SHELL_HTML 里也是登录后才注入 → 一并走委托 */
document.addEventListener('click', e => { if (e.target.closest('#uLogout')) logout(); });
/* v39：搜索框在登录后才由 mountShell() 注入，脚本加载时直接绑定会绑到 null（走「开门→登录→注入」流程的用户点击/回车无反应）。
   改用事件委托，无论元素何时出现都能命中（同 v31 的 nav/hero 委托思路） */
document.addEventListener('click', e => { if (e.target.closest('#sBtn')) doSearch(); });
document.addEventListener('keydown', e => { if (e.key === 'Enter' && e.target && e.target.id === 'sInput') doSearch(); });
/* 支持 /index.html?q=关键词 直达搜索结果（播放页「继续发现」芯片 / 顶栏搜索跳转过来）
   v63 修复：原来这段在脚本加载时立即 doSearch()，但随后 init()→enterApp()→navTo('rec')
   会 newView() 让世代号 +1，搜索回调里的 ck(gen) 全部判为过期 → 结果被丢弃、界面退回推荐页，
   表现就是「点了芯片跳过去却什么都没搜」。改成等 enterApp() 跑完再触发。 */
const _q0 = new URLSearchParams(location.search).get('q');
let _q0Done = false;
function runPendingSearch() {
  if (_q0Done || !_q0) return false;
  const el = $('#sInput');
  if (!el) return false;
  _q0Done = true;
  el.value = _q0;
  doSearch();
  return true;
}
if ($('#annoClose')) $('#annoClose').onclick = () => {
  $('#anno').style.display = 'none';
  if ($('#annoNr') && $('#annoNr').checked) {
    const today = new Date(Date.now() + 8 * 3600e3).toISOString().slice(0, 10);
    localStorage.setItem('aistream_anno_date', today);   // 用户勾选：当天不再提示
  }
};
/* v31 修复：侧边栏/hero 按钮改「事件委托」——未登录时骨架未挂载，旧写法直接 querySelectorAll 绑 onclick
   会导致登录后新注入的元素全部没有处理器（点什么都不响应，刷新一次才正常） */
document.addEventListener('click', e => {
  const nav = e.target.closest('.snav-item');
  if (nav) { const k = nav.dataset.kind || nav.dataset.view; if (k) navTo(k); return; }
  if (e.target.closest('#heroRand')) { heroRandGo(); return; }
  if (e.target.closest('#heroScroll')) { const c = $('#content'); if (c) c.scrollIntoView({ behavior: 'smooth' }); }
});

/* ---------- Hero 随机一部 / 滚动 ---------- */
/* 随机一部：摇到没有片源的（如欧美脱口秀上游/采集站都没收录）就自动换下一部，
   最多试 6 部，找到能播的才跳播放页，不再让用户撞见「未找到播放源」 */
function bareTitle(t) {
  return String(t || '').replace(/\s*[（(]?第[一二三四五六七八九十0-9]+季[）)]?\s*$/, '').replace(/\s*Season\s*\d+\s*$/i, '').trim();
}
async function findPlayable(it) {
  const pic = it.poster_url || it.carousel_url || it.backdrop_url || it.poster || it.backdrop || '';
  if (isUpId(it.id)) { prefetchUpDetail(it.id); location.href = '/player.html?' + new URLSearchParams({ src: 'up', id: it.id, title: it.title || it.normalized_title || '', year: it.year || '', poster: pic || '' }).toString(); return true; }
  const t0 = (it.title || it.normalized_title || '').trim();
  if (!t0) return false;
  const hit = await findUpHit(t0, pic);
  if (hit) { prefetchUpDetail(hit.id); location.href = '/player.html?' + new URLSearchParams({ src: 'up', id: hit.id, title: hit.title, year: hit.year, poster: hit.poster }).toString(); return true; }
  return false;
}
/* v32：检索命中但不跳转（供随机一部并行预检用） */
async function findUpHit(t0, pic) {
  for (const q of [bareTitle(t0), t0]) {
    if (!q) continue;
    try {
      const j = await api('/api/up/search?q=' + encodeURIComponent(q) + '&limit=8');
      const hit = (j.items || []).find(x => x && /^av_/.test(String(x.id || '')));
      if (hit) return { id: hit.id, title: hit.title || t0, year: hit.year || '', poster: hit.poster_url || pic || '' };
    } catch (e) {}
    if (bareTitle(t0) === t0) break;   /* 没有季数尾缀就不用搜第二次 */
  }
  return null;
}
async function heroRandGo() {
  /* v54：REC_POOL 为空（在分类页直接点随机一部）时先拉 feed 填充，别再喊「暂无可推荐内容」 */
  if (!REC_POOL.length) {
    toast('正在准备片单…');
    try {
      const j = await api('/api/up/feed');
      for (const s of (j.sections || [])) for (const it of (s.cards || s.items || [])) if (it && it.id) REC_POOL.push(it);
    } catch (e) {}
  }
  const pool = REC_POOL;
  if (!pool.length) { toast('暂无可推荐内容'); return; }
  const shuffle = [...pool].sort(() => Math.random() - 0.5).slice(0, 9);
  /* 自带上游 id 的直接播 */
  const direct = shuffle.find(it => isUpId(it.id));
  if (direct) { findPlayable(direct); return; }
  /* v32 提速：3 部一批并行检索（原来 1 部部串行试，最坏 6 次串行搜索） */
  for (let i = 0; i < shuffle.length; i += 3) {
    const batch = shuffle.slice(i, i + 3)
      .map(it => ({ t: (it.title || it.normalized_title || '').trim(), pic: it.poster_url || it.carousel_url || it.backdrop_url || it.poster || it.backdrop || '' }))
      .filter(x => x.t);
    if (!batch.length) continue;
    toast('正在找片源：' + batch.map(x => x.t).join(' / '));
    const hits = await Promise.all(batch.map(x => findUpHit(x.t, x.pic).catch(() => null)));
    const hit = hits.find(Boolean);
    if (hit) { prefetchUpDetail(hit.id); location.href = '/player.html?' + new URLSearchParams({ src: 'up', id: hit.id, title: hit.title, year: hit.year, poster: hit.poster }).toString(); return; }
  }
  toast('连试一轮都暂无片源，再点一次换一批');
};

/* ---------- 启动 ---------- */
(async function init() {
  const pub = await fetch('/api/public').then(r => r.json());
  document.title = (pub.hero && pub.hero.pageTitle) || (pub.siteName || 'AIStream') + ' · AI 影视';
  $('#gateLogo').textContent = pub.siteName || 'AIStream';
  applyHero(pub);   /* hero 文字/字号/颜色统一走 applyHero（登录/刷新两条路径共用） */
  if (!TOKEN) return;
  /* ?autosearch=片名：TMDB 卡/随机一部没有上游 id 时，先在上游检索，命中直接进播放页；未命中回退采集模式 */
  const _as = new URLSearchParams(location.search).get('autosearch');
  if (_as) {
    $('#gate').classList.add('hidden');   /* 已登录直连 autosearch：别让登录框闪现 */
    const c = $('#content'); if (c) c.innerHTML = '<div class="loader"><div class="spin"></div></div>';
    document.title = '正在检索片源…';
    try {
      const j = await api('/api/up/search?q=' + encodeURIComponent(_as) + '&limit=12');
      const hit = (j.items || []).find(x => x && x.id);
      if (hit) { prefetchUpDetail(hit.id); location.replace('/player.html?' + new URLSearchParams({ src: 'up', id: hit.id, title: hit.title || _as, poster: hit.poster_url || '' }).toString()); return; }
    } catch (e) {}
    location.replace('/player.html?' + new URLSearchParams({ title: _as, media: 'collect' }).toString());
    return;
  }
  try { await enterApp(); } catch (e) {}
})();

/* ---------- 本周追剧周历（TMDB 按日聚合，服务端缓存 6h）；完整日历为弹窗，支持上周/下周/指定日期 ---------- */
const WK_GROUPS = [['tv', '电视剧'], ['anime', '动漫'], ['variety', '综艺'], ['movie', '电影']];
const WK_STATE = { sel: null };
const WK_M = { weekStart: '', cache: {}, loading: 0 };
function wkPimg(q) {
  if (!q) return '';
  if (q.indexOf('//') === 0) q = 'https:' + q;   // 协议相对海报（//host/...）补成 https
  if (/^https?:\/\//.test(q)) return '/api/dimg?u=' + encodeURIComponent(q);   // 上游/外站全量海报直链（baipiaozhe 等）
  return '/api/dimg?u=' + encodeURIComponent('https://image.tmdb.org/t/p/w300' + q);
}
function wkCard(it) {
  const d = document.createElement('div'); d.className = 'card';
  const pic = wkPimg(it.poster);
  d.innerHTML = `<div class="poster">${pic ? `<img src="${pic}" loading="lazy" decoding="async" referrerpolicy="no-referrer" onerror="this.style.opacity=.15">` : '<div class="ph"></div>'}
    <div class="meta"><div class="t">${esc(it.title)}</div><div class="yr">${[it.year, it.ep ? '📺 ' + it.ep : ''].filter(Boolean).join(' · ')}</div></div>
    <div class="ply">▶ 立即播放</div></div>`;
  d.onclick = () => playItem(it, pic);
  return d;
}
function wkRenderDay(d, box) {
  for (const [k, label] of WK_GROUPS) {
    const items = d[k] || [];
    if (!items.length) continue;
    const g = document.createElement('div'); g.className = 'wk-g';
    g.innerHTML = `<h3>${label}<b>${d.counts[k] || items.length} 部</b></h3>`;
    const row = document.createElement('div'); row.className = 'row';
    items.forEach(it => row.appendChild(wkCard(it)));
    g.appendChild(row); box.appendChild(g);
  }
}
function wkMondayOf(dateStr) {
  const d = new Date(dateStr + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() - (d.getUTCDay() + 6) % 7);
  return d.toISOString().slice(0, 10);
}
function bjToday() { return new Date(Date.now() + 8 * 3600e3).toISOString().slice(0, 10); }
function wkModalEnsure() {
  if ($('#wkModal')) return;
  const el = document.createElement('div');
  el.id = 'wkModal'; el.className = 'modal hidden';
  el.innerHTML = `<div class="modal-box wk-modal">
    <div class="wm-head"><h3>📅 完整节目日历</h3><span class="wm-range" id="wmRange"></span><button class="wm-x" id="wmClose">✕</button></div>
    <div class="wm-nav">
      <button class="btn" id="wmPrev">← 上一周</button>
      <button class="btn" id="wmNext">下一周 →</button>
      <button class="btn" id="wmThis">回到本周</button>
      <span class="wm-datelabel">跳到指定日期 <input type="date" id="wmDate"></span>
    </div>
    <div class="wm-body" id="wmBody"><div class="empty">加载中…</div></div>
  </div>`;
  document.body.appendChild(el);
  $('#wmClose').onclick = () => $('#wkModal').classList.add('hidden');
  $('#wkModal').addEventListener('click', e => { if (e.target.id === 'wkModal') $('#wkModal').classList.add('hidden'); });
  document.addEventListener('keydown', e => { if (e.key === 'Escape') $('#wkModal').classList.add('hidden'); });
  $('#wmPrev').onclick = () => wkShiftWeek(-1);
  $('#wmNext').onclick = () => wkShiftWeek(1);
  $('#wmThis').onclick = () => wkLoadWeek('');
  $('#wmDate').addEventListener('change', () => { const v = $('#wmDate').value; if (v) wkLoadWeek(v); });
}
function wkShiftWeek(n) {
  if (!WK_M.weekStart) return;
  wkLoadWeek(wkShiftKey(WK_M.weekStart, n));
}
function wkShiftKey(k, n) {
  const d = new Date(k + 'T00:00:00Z'); d.setUTCDate(d.getUTCDate() + n * 7);
  return d.toISOString().slice(0, 10);
}
async function wkLoadWeek(dateStr) {
  wkModalEnsure();
  $('#wkModal').classList.remove('hidden');
  const key = wkMondayOf(dateStr || bjToday());
  WK_M.weekStart = key;
  $('#wmDate').value = key;
  const body = $('#wmBody');
  const paint = w => {
    const s = w.days[0], e2 = w.days[w.days.length - 1];
    $('#wmRange').textContent = Number(s.date.slice(5, 7)) + '月' + Number(s.date.slice(8, 10)) + '日 - ' + Number(e2.date.slice(5, 7)) + '月' + Number(e2.date.slice(8, 10)) + '日';
    body.innerHTML = '';
    w.days.forEach(d => {
      const box = document.createElement('div'); box.className = 'wk-day';
      box.innerHTML = `<div class="wk-day-h">${d.wd} ${d.day}日${d.isToday ? '<i>今天</i>' : ''}</div>`;
      wkRenderDay(d, box);
      body.appendChild(box);
    });
  };
  if (WK_M.cache[key]) { paint(WK_M.cache[key]); return; }
  body.innerHTML = '<div class="empty">📅 正在加载该周片单…</div>';
  const my = ++WK_M.loading;
  try {
    const w = await api('/api/weekly?date=' + key);
    if (my !== WK_M.loading) return;
    if (!w || !w.days || !w.days.length) { body.innerHTML = '<div class="empty">该周暂无数据</div>'; return; }
    if (Object.keys(WK_M.cache).length > 20) WK_M.cache = {};   // 预取会多占几周，阈值放宽
    WK_M.cache[key] = w;
    paint(w);
    /* v31 提速：后台静默预取上/下一周（服务端有 6h 缓存，点「下一周」即秒开） */
    [wkShiftKey(key, -1), wkShiftKey(key, 1)].forEach(k => {
      if (WK_M.cache[k]) return;
      api('/api/weekly?date=' + k).then(wk => { if (wk && wk.days && wk.days.length) WK_M.cache[k] = wk; }).catch(() => {});
    });
  } catch (e) { if (my === WK_M.loading) body.innerHTML = '<div class="empty">加载失败，请重试</div>'; }
}
async function loadWeekly(gen) {
  if (window.IS_MOBILE) return;   /* v35：手机端不显示追剧日历，也不发这个请求 */
  let w = null;
  try { w = await api('/api/weekly'); } catch (e) { return; }
  try { ck(gen); } catch (e) { return; }
  if (!w || !w.days || !w.days.length) return;
  const c = $('#content'); if (!c) return;
  /* v30 修复：清空历史/无历史时，周历可能抢在首页栏目渲染完成前插入到 loader 前面，
     随后被 loadRec 的 ensureClear（innerHTML=''）连带清掉 → 周历消失。
     这里等首页至少渲染出一个真实栏目区块再插入 */
  const wkWait = ms => new Promise(r => setTimeout(r, ms));
  for (let i = 0; i < 100; i++) {
    if (c.querySelector('.col:not(.weekly)')) break;
    try { ck(gen); } catch (e) { return; }
    await wkWait(200);
  }
  try { ck(gen); } catch (e) { return; }
  const sec = document.createElement('section'); sec.className = 'col weekly';
  const kids = Array.from(c.children);
  const histIdx = kids.findIndex(el => el.querySelector && el.querySelector('#histClr'));
  if (histIdx >= 0 && histIdx < kids.length - 1) c.insertBefore(sec, kids[histIdx + 1]);
  else if (histIdx < 0) c.insertBefore(sec, c.firstChild);
  else c.appendChild(sec);
  const start = w.days[0], end = w.days[w.days.length - 1];
  const range = (start.month || Number(start.date.slice(5, 7))) + '月' + start.day + '日 - ' + Number(end.date.slice(5, 7)) + '月' + end.day + '日';
  const dayTotal = d => WK_GROUPS.reduce((a, [k]) => a + (d.counts[k] || 0), 0);
  const paint = () => {
    sec.innerHTML = `<h2>📅 本周追剧<small>按日更新影片更新</small><span class="wk-range">${range}</span><a id="wkToggle" class="clr-link">查看完整日历 ▾</a></h2><div class="wk-tabs"></div><div class="wk-body"></div>`;
    const tabs = sec.querySelector('.wk-tabs'), body = sec.querySelector('.wk-body');
    w.days.forEach((d, i) => {
      const t = document.createElement('div');
      t.className = 'wk-tab' + (i === WK_STATE.sel ? ' on' : '') + (d.isToday ? ' today' : '');
      t.innerHTML = `<span class="wd">${d.wd}</span><span class="n">${d.day}日</span><span class="cnt">${dayTotal(d)}部</span>`;
      t.onclick = () => { WK_STATE.sel = i; paint(); };
      tabs.appendChild(t);
    });
    wkRenderDay(w.days[WK_STATE.sel] || w.days[0], body);
    sec.querySelector('#wkToggle').onclick = () => wkLoadWeek('');
  };
  paint();
}

/* ---------- IPTV 直播（后台开关/地址；流走服务端代理防 CORS） ---------- */
let IPTV_HLS = null;
function ensureHls() {
  if (window.Hls) return Promise.resolve();
  return new Promise(rsl => {
    const sc = document.createElement('script');
    sc.src = '/vendor/hls.min.js';
    sc.onload = rsl; sc.onerror = rsl;
    document.head.appendChild(sc);
  });
}
async function loadIptvView() {
  const c = $('#content');
  const gen = newView();
  LD_STATE = { done: 0 };
  mountLoader(c, { icon: '📡', title: '正在加载 IPTV 频道', stages: ['正在拉取播放清单…', '正在解析频道分组…', '正在匹配节目单 EPG…'] });
  /* hls.js 必须在这里动态载入：index.html 不引它（只有播放器页才需要），
     漏了这步 window.Hls 为 undefined → 走 v.src=m3u8 原生兜底 → Chrome 播不出画面（v28 实测 0x0） */
  await ensureHls().catch(() => {});
  let j;
  try { j = await api('/api/iptv'); } catch (e) { j = { enabled: true, error: '加载失败，请稍后重试' }; }
  try { ck(gen); } catch (e) { return; }
  c.innerHTML = '';
  if (!j.enabled) { c.innerHTML = '<div class="empty">IPTV 未开启，请管理员在后台「IPTV 直播」中打开开关</div>'; return; }
  if (j.denied) { c.innerHTML = '<div class="empty">🔒 管理员未对你的账号开放 IPTV，如需开通请联系管理员</div>'; return; }
  const chs = j.channels || [];
  if (!chs.length) { c.innerHTML = '<div class="empty">' + esc(j.error || '频道清单为空') + '</div>'; return; }
  const nowMap = j.now || {};
  const sec = document.createElement('section'); sec.className = 'col iptv-sec';
  sec.innerHTML = `<h2>📡 IPTV 直播<small>${chs.length} 个频道 · 服务端代理播放</small></h2>
    <div class="iptv">
      <div class="iptv-left">
        <div class="iptv-stage">
          <video id="iptvV" controls autoplay playsinline muted></video>
          <div class="iptv-ov">
            <div class="iptv-ov-l"><span class="iptv-live"><i></i>LIVE</span><span class="iptv-cname" id="iptvCname">—</span></div>
            <div class="iptv-ov-r">
              <button class="iptv-an" id="iptvAN" title="本集播完自动跳下一集">连播</button>
              <button class="iptv-nx hidden" id="iptvNext" title="下一集">⏭</button>
              <button class="iptv-mute" id="iptvMute" title="开启/关闭声音">🔇</button>
            </div>
          </div>
          <div class="iptv-snd hidden" id="iptvSnd">🔇 浏览器拦截了声音，点这里开声</div>
        </div>
        <div class="iptv-info" id="iptvInfo"><span class="ii-ph">节目单加载中…</span></div>
        <div class="iptv-now" id="iptvNow">正在连接频道…</div>
      </div>
      <div class="iptv-right">
        <input id="iptvQ" placeholder="搜索频道名…">
        <div class="iptv-tabs" id="iptvTabs"></div>
        <div class="iptv-list" id="iptvList"></div>
      </div>
    </div>`;
  c.appendChild(sec);
  const groups = {};
  chs.forEach(x => { (groups[x.group] = groups[x.group] || []).push(x); });
  /* v64：后台可设置分组排序 —— groupOrder 里的分组按后台顺序排前面，没排的按字典序跟后面 */
  const go = Array.isArray(j.groupOrder) ? j.groupOrder : [];
  const gNames = Object.keys(groups).sort((a, b) => {
    const ia = go.indexOf(a), ib = go.indexOf(b);
    if (ia >= 0 && ib >= 0) return ia - ib;
    if (ia >= 0) return -1;
    if (ib >= 0) return 1;
    return a.localeCompare(b, 'zh');
  });
  const listEl = sec.querySelector('#iptvList'), tabsEl = sec.querySelector('#iptvTabs');
  const v = sec.querySelector('#iptvV'), now = sec.querySelector('#iptvNow');
  const cname = sec.querySelector('#iptvCname'), infoBox = sec.querySelector('#iptvInfo'), muteBtn = sec.querySelector('#iptvMute');
  const sndHint = sec.querySelector('#iptvSnd');
  const flat = chs.slice();
  let curIdx = -1, autoSkip = 0, curGroup = '', kw = '';

  /* 分组页签：全部 + 各分组（带数量） */
  /* v65：全量 6993 频道一次性渲染成 DOM，手机端直接卡死。
     分组内分批渲染：「全部」每组先出 30 条，进分组先出 150 条，底部「显示更多」续载 */
  const IPTV_BATCH = 150, IPTV_BATCH_ALL = 30;
  const shownCnt = {};
  function paintTabs() {
    tabsEl.innerHTML = '';
    const mk = (label, g, n) => {
      const t = document.createElement('div');
      t.className = 'iptv-tab' + (curGroup === g ? ' on' : '');
      t.innerHTML = `${esc(label)}<b>${n}</b>`;
      t.onclick = () => { curGroup = (curGroup === g ? '' : g); Object.keys(shownCnt).forEach(k => delete shownCnt[k]); paintTabs(); paintList(); };
      tabsEl.appendChild(t);
    };
    mk('全部', '', chs.length);
    gNames.forEach(g => mk(g, g, groups[g].length));
  }
  function paintList(keepScroll) {
    const _sy = keepScroll ? (window.scrollY || 0) : 0;
    listEl.innerHTML = '';
    let n = 0;
    for (const g of gNames) {
      if (curGroup && g !== curGroup) continue;
      const items = groups[g].filter(x => !kw || x.name.toLowerCase().indexOf(kw) >= 0);
      if (!items.length) continue;
      const gh = document.createElement('div'); gh.className = 'iptv-g';
      gh.textContent = g + ' · ' + items.length;
      listEl.appendChild(gh);
      /* v65b：累积显示（0 → shown），而不是「挪起始下标 + 仍只渲染 batch 条」。
         旧写法在「全部」视图下点一次「显示更多」DOM 总数纹丝不动，用户以为点了没反应。
         keepScroll：续载后回到原滚动位置，不要跳回顶部 */
      const batch = curGroup === g ? IPTV_BATCH : IPTV_BATCH_ALL;
      const shown = Math.min(items.length, shownCnt[g] || batch);
      const slice = items.slice(0, shown);
      slice.forEach(x => {
        const np = nowMap[x.cid];
        const it = document.createElement('div'); it.className = 'iptv-c'; it.dataset.u = x.cid;
        it.innerHTML = (x.logo ? `<span class="iptv-lg"><img src="${esc(x.logo)}" loading="lazy" onerror="this.parentNode.remove()"></span>` : `<span class="iptv-ph">📺</span>`)
          + `<span class="iptv-cn"><b>${esc(x.name)}</b>${np ? `<i>${esc(np.t)}</i>` : ''}</span>`;
        it.onclick = () => playIptv(x, it, true);
        listEl.appendChild(it);
        n++;
      });
      if (items.length > shown) {
        const more = document.createElement('div');
        more.className = 'iptv-more';
        more.textContent = `显示更多（${g} 还剩 ${items.length - shown} 个）`;
        more.onclick = () => { shownCnt[g] = shown + batch; paintList(true); };
        listEl.appendChild(more);
      }
    }
    if (!n) listEl.innerHTML = '<div class="empty" style="padding:30px 0">没有匹配的频道</div>';
    if (keepScroll) window.scrollTo(0, _sy);
  }
  paintTabs(); paintList();
  sec.querySelector('#iptvQ').addEventListener('input', e => { kw = e.target.value.trim().toLowerCase(); Object.keys(shownCnt).forEach(k => delete shownCnt[k]); paintList(); });

  /* 静音修复：先尝试带声播放（点侧栏进 IPTV 已构成用户激活），
     只有被浏览器策略拒绝时才回落静音，并弹出「点我开声」提示 */
  let sndTimer = 0;
  function showSnd() { sndHint.classList.remove('hidden'); clearTimeout(sndTimer); sndTimer = setTimeout(hideSnd, 8000); }
  function hideSnd() { sndHint.classList.add('hidden'); }
  sndHint.onclick = () => { hideSnd(); setMute(false); v.play().catch(() => {}); };
  function setMute(m) {
    v.muted = m;
    muteBtn.textContent = m ? '🔇' : '🔊';
    muteBtn.classList.toggle('off', !m);
    if (m) showSnd(); else hideSnd();
  }
  async function tryPlay(wantSound) {
    if (wantSound) setMute(false); else setMute(true);
    try { await v.play(); return true; }
    catch (e) {
      if (wantSound) { setMute(true); try { await v.play(); } catch (_) {} }
      return false;
    }
  }
  muteBtn.onclick = () => { setMute(!v.muted); if (!v.muted) v.play().catch(() => {}); };
  v.addEventListener('volumechange', () => { muteBtn.textContent = v.muted ? '🔇' : '🔊'; muteBtn.classList.toggle('off', !v.muted); });

  /* —— v58 自动连播下一集 ——
     黄果这类源是「一集一个频道」，名字形如「剧名 第03集」、同剧集在清单里连续排列。
     本集 ended 后自动跳同组同剧名的「第 N+1 集」；直播频道永远不会 ended，不受影响。 */
  let autoNext = localStorage.getItem('iptvAutoNext') !== '0';
  const anBtn = sec.querySelector('#iptvAN'), nxBtn = sec.querySelector('#iptvNext');
  function paintAN() { anBtn.classList.toggle('on', autoNext); anBtn.textContent = autoNext ? '连播' : '连播关'; }
  anBtn.onclick = () => { autoNext = !autoNext; localStorage.setItem('iptvAutoNext', autoNext ? '1' : '0'); paintAN(); };
  paintAN();
  /* 从「剧名 第N集」拆出剧名 + 集号 */
  function parseEp(x) {
    const m = /第\s*(\d+)\s*集/.exec(String((x && x.name) || ''));
    if (!m) return null;
    return { n: parseInt(m[1], 10), base: String(x.name).slice(0, m.index).replace(/[\s·、]+$/, '') };
  }
  function nextEp(x) {
    const a = parseEp(x); if (!a) return null;
    const i = flat.indexOf(x);
    /* 先看紧邻的下一个（正常情况剧集连续），再全量兜底（顺序被打乱时） */
    if (i >= 0) {
      const c1 = flat[i + 1];
      if (c1 && c1 !== x && c1.group === x.group) { const b = parseEp(c1); if (b && b.base === a.base && b.n === a.n + 1) return c1; }
    }
    for (const c of flat) {
      if (c === x || c.group !== x.group) continue;
      const b = parseEp(c); if (b && b.base === a.base && b.n === a.n + 1) return c;
    }
    return null;
  }
  let curX = null, startedAt = 0;
  function refreshNx() {
    const nx = curX && nextEp(curX);
    nxBtn.classList.toggle('hidden', !nx);
    nxBtn.title = nx ? ('下一集：' + nx.name) : '下一集';
    return nx;
  }
  nxBtn.onclick = () => { const nx = curX && nextEp(curX); if (nx) playIptv(nx, null, !v.muted); };
  v.addEventListener('ended', () => {
    if (!autoNext || !curX) return;
    /* 起播 5 秒内就 ended 说明源是坏的，别连环跳，交给下面原有的自动切源逻辑处理 */
    if (Date.now() - startedAt < 5000) return;
    const nx = nextEp(curX);
    if (!nx) return;
    now.textContent = '▶ 本集播完，自动播放下一集：' + nx.name;
    setTimeout(() => playIptv(nx, null, !v.muted), 800);
  });

  async function playIptv(x, el, byUser) {
    const idx = flat.indexOf(x);
    if (idx >= 0) curIdx = idx;
    curX = x; startedAt = Date.now(); refreshNx();
    listEl.querySelectorAll('.iptv-c').forEach(z => z.classList.toggle('on', z.dataset.u === x.cid));
    cname.textContent = x.name;
    const np = nowMap[x.cid];
    const hhmm = ts => { if (!ts) return ''; const d = new Date(ts); return String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0'); };
    infoBox.innerHTML = np
      ? `<div class="ii-ch">📺 ${esc(x.name)}</div><div class="ii-row"><span class="ii-now">正在播</span><b>${esc(np.t)}</b>${np.ce ? `<span>${hhmm(np.ce)} 结束</span>` : ''}</div>${np.next ? `<div class="ii-row"><span class="ii-next">接下来</span><b>${esc(np.next)}</b>${np.ns ? `<span>${hhmm(np.ns)} 开播</span>` : ''}</div>` : ''}`
      : `<div class="ii-ch">📺 ${esc(x.name)}</div><div class="ii-row"><span class="ii-ph">暂无节目单信息</span></div>`;
    now.textContent = '正在连接：' + x.name;
    /* v31 防窥：只传不透明频道 id，F12 里看不到上游真实地址 */
    const proxied = '/api/iptv/stream?ch=' + encodeURIComponent(x.cid) + '&token=' + encodeURIComponent(TOKEN);
    if (IPTV_HLS) { try { IPTV_HLS.destroy(); } catch (e) {} IPTV_HLS = null; }
    /* byUser=true 或首次自动选台：都先尝试带声；被拦截才静音并给出开声提示 */
    const wantSound = !!byUser;
    if (x.direct) { v.src = proxied; tryPlay(wantSound); return; }
    if (window.Hls && Hls.isSupported()) {
      IPTV_HLS = new Hls({ maxBufferLength: 12, manifestLoadingTimeOut: 10000, manifestLoadingMaxRetry: 2, lowLatencyMode: true });
      IPTV_HLS.loadSource(proxied);
      IPTV_HLS.attachMedia(v);
      IPTV_HLS.on(Hls.Events.MANIFEST_PARSED, () => { autoSkip = 0; now.textContent = '正在播放：' + x.name; tryPlay(wantSound); });
      IPTV_HLS.on(Hls.Events.ERROR, (_, data) => {
        if (data && data.fatal && (data.type === Hls.ErrorTypes.NETWORK_ERROR || data.type === Hls.ErrorTypes.MEDIA_ERROR)) {
          if (++autoSkip <= 5 && curIdx >= 0) {
            now.textContent = '「' + x.name + '」源不可用，自动切换下一个…';
            const next = flat[(curIdx + 1) % flat.length];
            if (next && next !== x) playIptv(next, null, wantSound);
          } else now.textContent = '播放失败：' + x.name + '（源不可用）';
        }
      });
    } else { v.src = proxied; tryPlay(wantSound); }
  }
  /* 默认频道：优先央视组 CCTV1；自动开播保持静音，画面上给出「点我开声」提示 */
  const pref = chs.find(c => /央/.test(c.group) && /CCTV-?1(综合|$)/i.test(c.name))
    || chs.find(c => /央|CCTV/i.test(c.group + c.name)) || chs[0];
  if (pref) playIptv(pref, null, true);   /* 尝试带声开播；被浏览器拦截则由 tryPlay 回落静音 */
}
