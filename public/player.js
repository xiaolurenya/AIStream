'use strict';
const $ = s => document.querySelector(s);
const TOKEN = localStorage.getItem('aistream_token') || '';
const Q = new URLSearchParams(location.search);
const TITLE = Q.get('title') || '', YEAR = Q.get('year') || '', POSTER = Q.get('poster') || '';
const SRC = Q.get('src') || '', UPID = Q.get('id') || '';
/* v72：采集站 id + 站内 vod_id，用来精确取源（站点没开搜索接口也能播） */
const SID = Q.get('sid') || '', VID = Q.get('vid') || '';
/* v32：顶栏「返回首页」右侧显示当前播放影片名 */
(function () {
  const el = document.getElementById('pTopTitle');
  if (el && TITLE) el.innerHTML = '<b>' + TITLE.replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])) + '</b>' + (YEAR ? '<i>' + YEAR + '</i>' : '');
})();
const Q_EP = parseInt(Q.get('ep') || '0', 10) || 0;       // 断点续播：上次集数
let Q_POS = parseInt(Q.get('pos') || '0', 10) || 0;       // 断点续播：进度秒（v37：let，续播后要清零）
let Q_POS_LAST = 0;   /* v69c：记下这次续播的目标点，2.5s 后复查有没有被钳到片尾 */
/* v70：续播位置「属于哪一集」。起播失败/起播卡住时 loadedmetadata 根本不触发，
   Q_POS 就一直留在那儿，下一集起播时会被拿来当续播点（09:59 手机 ep2 一上来 t=2707s 的由来）。
   带上集号后，位置只对它自己的那一集生效，跨集一律作废 */
let Q_POS_EP = Q_POS > 0 ? Q_EP : -1;
let ART = null, CFG = null, PLAY = null;

/* v63：加载等待框文案可自定义（后台「其他设置」）。pt(key, 默认) —— 后台留空/没配就回落默认文案。
   %s 是占位符：倒计时提示里替换成剩余秒数、超时提示里替换成已等待秒数、第 N 条线路替换成序号。 */
function pt(k, def) {
  const t = (CFG && CFG.misc && CFG.misc.text) || {};
  const v = t[k];
  return (v != null && String(v).trim()) ? String(v) : def;
}
function ptFmt(k, def, arg) { return pt(k, def).replace(/%s/g, String(arg)); }

/* 播放诊断上报：把前端才能感知的「音频出错 / 解码重置 / 卡顿 / 无声」汇进后台同一套日志，
   便于事后总结插播广告特征（拼接源常导致解码器反复重置→声音异常）并改进拦截规则 */
let _diagReported = {}, _audioBase = 0, _audioLast = 0, _audioMark = 0, _audioReported = false, _stallMark = 0, _tLast = 0;
/* v50：「根本没播起来」探测。手机上常见现象是进度永远停在 0.0，旧逻辑把它当成"卡顿"反复微跳
   （0.0→4.0 又被打回 0），视觉上就是「播 3 秒又重新开始」的死循环。
   未真正起播时禁止任何 seek，只做软重启 + 换线。 */
let _started = false;        // 进度是否推进过（真正起播）
let _mediaSeen = false;      // v52：缓冲区里是否出现过数据（区分「网络没数据」和「有数据起不来」）
let _gapFix = false;         // v52b：缓冲起点空洞已修复（数据从中间开始、0 处无数据 → 进度永远停在 0）
let _noplaySince = 0;        // 首次发现"未起播"的时间戳
let _noplayTried = 0;        // 已尝试软重启次数
let _wdTimer = null;         // 起播看门狗（不依赖 timeupdate，缓冲无事件时也能兜住）
function resetPlayDiag() {
  _diagReported = {}; _audioBase = 0; _audioLast = 0; _audioMark = 0; _audioReported = false;
  _stallMark = 0; _tLast = 0; _lastT = 0;
  _started = false; _mediaSeen = false; _gapFix = false; _noplaySince = 0; _noplayTried = 0;
}
function reportLog(level, tag, msg, extra) {
  try {
    const k = tag + '|' + msg.slice(0, 60);
    const now = Date.now();
    if (_diagReported[k] && now - _diagReported[k] < 30000) return;   // 同内容 30s 内只报一次
    _diagReported[k] = now;
    fetch('/api/log', { method: 'POST', headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + (TOKEN || '') }, body: JSON.stringify({ level, tag, msg, extra: extra || '' }) }).catch(() => {});
  } catch (e) {}
}
const SPEEDS = [0.75, 1, 1.25, 1.5, 2];

/* 统一播放模型 */
let MODE = null;            // 'up' | 'collect'
let EP_LIST = [];           // [{name, url?, token?, idx}]
let EP_IDX = 0;
let LINE_SKIP = 0;          // 手动换线：跳过前 N 条可用线路
let CUR_TOKEN = '';         // 当前集的上游令牌（供换线重解析）
let AUTO_SW = 0;            // 本集自动换线次数（上限 3，防死循环）
/* v68：本集起播失败总预算（自动换线次数）——8:20 日志实测手机端「无媒体数据→软重启→换线→又是 0 秒」
   可以无限循环下去（用户看到的就是电视剧反复从头播）。预算用完立即出终局 UI，不再自动折腾 */
let EP_FAIL_BUDGET = 5;
function artPoster() { return (typeof META !== 'undefined' && META && (META.backdrop || META.poster)) || POSTER || ''; }
let CUR_LABEL = '';         // 当前播放源名称（显示在倍速条末尾）
let CUR_OFFICIAL = true;    // 当前线路是否官方（决定换源面板的徽标与默认页签）
let histExpanded = false, favExpanded = false;   // 左栏历史/收藏折叠态
function updateLineLabel() {
  const el = $('#pLine');
  if (!el) return;
  /* v68：手机端影片名跟在线路名后面，且保留原 h1 的炫彩渐变字（大哥点名要的）；
     META 在下方才 let 声明，这里全是运行时调用，不会踩 TDZ */
  const hasT = window.IS_MOBILE && META && META.title;
  el.innerHTML = '当前播放线路源: ' + esc(CUR_LABEL || '--')
    + (hasT ? '　<span class="pl-tt">' + esc(META.title) + '</span>' : '');
  el.title = (CUR_LABEL || '') + (META && META.title ? ' · ' + META.title : '');
}
let META = { id: '', title: '', poster: '', year: '', epTotal: 0 };
let favOn = false;
let lastHistPush = 0;
let RESUMING = false;   // 断点续播缓冲期：续播后的最初几秒不触发自动跳过片头

/* ---------- v47：在途请求统一登记，离开播放页时一键取消 ----------
   现象：「还在寻找播放线路」那会儿点「← 返回首页」要愣好几秒才跳。
   原因：那一段时间页面上同时挂着 up/resolve（最长 22s）、全线路扫描 ad-scan-all
   （服务端要逐条解析+拉清单，几十秒很常见）、详情/推荐/海报代理一大堆请求，
   而浏览器 HTTP/1.1 每域名只有 6 条连接，全被占满 → 跳转 index.html 的文档请求
   只能排在队尾，看起来就是「点了没反应 / 卡一下」。
   离开前主动 abort 掉所有在途请求 + 关 SSE + 掐掉还没下完的海报，
   连接池立刻还回去，跳转就秒开了。 */
const _CTRLS = new Set();
let _LEAVING = false;
function trackCtrl(c) { if (c) _CTRLS.add(c); return c; }
function untrackCtrl(c) { if (c) _CTRLS.delete(c); }
function abortAllRequests() {
  try { _CTRLS.forEach(c => { try { c.abort(); } catch (e) {} }); } catch (e) {}
  _CTRLS.clear();
}
async function api(path, opts) {
  const o = opts || {};
  o.headers = Object.assign({ 'Authorization': 'Bearer ' + TOKEN }, o.headers || {});
  if (o.body && typeof o.body !== 'string') o.body = JSON.stringify(o.body);
  let ctrl = null;
  if (!o.signal && typeof AbortController === 'function') { ctrl = trackCtrl(new AbortController()); o.signal = ctrl.signal; }
  try {
    if (_LEAVING) throw new Error('leaving');
    const r = await fetch(path, o);
    if (r.status === 401) { localStorage.removeItem('aistream_token'); location.href = '/index.html'; throw new Error('no auth'); }
    return await r.json();
  } finally { untrackCtrl(ctrl); }
}
function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }
function isM3u8(u) { return /\.m3u8(\?|$)/i.test(u) || u.includes('/hls'); }
/* 视频直链：mp4/mkv/webm/ts/flv 等。官方解析线路返回的常常不是 m3u8 而是 mp4，
   绝不能再塞进 iframe（那样会变成浏览器原生播放器，主题/倍速/设置全丢） */
function isVideoFile(u) { return /\.(mp4|m4v|mkv|webm|ts|flv|mov|avi|m3u8)(\?|$|#)/i.test(String(u || '').trim()); }
/* 明确是网页才走 iframe：官方/采集直链大多没有扩展名（字节系 CDN），
   一律按视频处理，交给 Artplayer；真播不出来由 error 事件自动换线兜底 */
function isWebPage(u) {
  const x = String(u || '').trim().split('?')[0].split('#')[0];
  if (!x) return false;
  if (/\.(html|htm|shtml|php|asp|aspx|jsp|do)(\/|$)/i.test(x)) return true;
  if (/^https?:\/\/[^/]+\/?$/i.test(x)) return true;          // 纯域名
  if (/\/(share|player|play|video|v)\/?$/.test(x)) return true; // 明显的播放页路径
  return false;
}
/* 图片代理：TMDB 等公共图床 CDN 直链（浏览器并行加载+边缘缓存，比过服务端代理快很多）；
   其余可能有防盗链的第三方图片仍走 /api/dimg */
function img(u) {
  const s = u || '';
  if (/^https?:\/\/(image\.)?tmdb\.org\//i.test(s)) return s;
  return u ? '/api/dimg?u=' + encodeURIComponent(u) : '';
}
/* 海报专用：浏览器直连优先（比过服务端代理更快），直连失败（防盗链/被墙）再回落 /api/dimg，
   再失败才显示占位，绝不空白。用于详情右侧/左侧海报，避免「图片加载不出来」 */
function posterImg(url) {
  const s = (url || '').replace(/"/g, '%22');
  if (!s) return '<div class="ph">暂无海报</div>';
  return '<img class="ph-img" loading="eager" decoding="async" src="' + esc(s) + '" data-u="' + esc(s) + '" onerror="window.__posterFallback&&window.__posterFallback(this)" alt="">';
}
window.__posterFallback = function (el) {
  try {
    const u = el.getAttribute('data-u') || el.getAttribute('src') || '';
    const cur = el.getAttribute('src') || '';
    if (cur.indexOf('/api/dimg') >= 0) {   // 已回落到代理仍失败 → 占位
      const ph = document.createElement('div'); ph.className = 'ph'; ph.textContent = '暂无海报';
      if (el.parentNode) el.parentNode.replaceChild(ph, el);
      return;
    }
    if (u) { el.setAttribute('src', '/api/dimg?u=' + encodeURIComponent(u)); }   // 直连失败 → 服务端代理
  } catch (e) {}
};
function toast(title, content, ms = 3000) {
  const el = document.createElement('div'); el.className = 'toast';
  el.innerHTML = `<div class="tt">${esc(title)}</div>` + (content ? `<div class="tc">${esc(content)}</div>` : '');
  $('#toast').appendChild(el);
  setTimeout(() => el.remove(), ms);
}
/* 播放器内置通知：显示在进度条上方居中（Artplayer notice），播放器不可用时退回右下角 toast */
function artNotice(msg) {
  try { if (ART && ART.notice) { ART.notice.show = msg; return; } } catch (e) {}
  toast(msg);
}

/* ---------- 播放器页广播横幅 + SSE（公告只在首页显示，播放页只收广播） ---------- */
function showBroadcastP(msg) {
  let box = $('#bcBanner');
  if (!box) { box = document.createElement('div'); box.id = 'bcBanner'; box.className = 'bc-banner hidden'; document.body.appendChild(box); }
  const t = esc((msg && msg.title) || '系统通知');
  const c = esc((msg && msg.content) || '');
  box.innerHTML = '<div class="bc-ic">📢</div><div class="bc-body"><div class="bc-t">' + t + '</div>' + (c ? '<div class="bc-c">' + c + '</div>' : '') + '</div><button class="bc-x" aria-label="关闭">×</button>';
  box.querySelector('.bc-x').onclick = () => box.classList.add('hidden');
  box.classList.remove('hidden');
}
let SSE = null;
function connectSSEP() {
  if (!TOKEN || typeof EventSource === 'undefined') return;
  try {
    if (SSE) { try { SSE.close(); } catch (e) {} SSE = null; }
    const es = new EventSource('/api/stream?token=' + encodeURIComponent(TOKEN));
    SSE = es;   /* 长连接占一条 HTTP/1.1 名额，离开页面必须显式 close */
    es.onmessage = e => {
      let m; try { m = JSON.parse(e.data); } catch (x) { return; }
      if (m.type === 'broadcast') showBroadcastP(m.data);
    };
    es.onerror = () => {};
  } catch (e) {}
}
/* ---------- v47：返回首页——先清场，再跳转 ---------- */
function stopPendingImages() {
  /* 图片请求不走 fetch，abort 管不到；把还没下完的换成 1px 占位，浏览器会自己取消 */
  try {
    document.querySelectorAll('img').forEach(im => {
      if (im.complete) return;
      if (!im.getAttribute('src')) return;
      im.src = 'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7';
    });
  } catch (e) {}
}
function goHome() {
  if (_LEAVING) return;
  _LEAVING = true;
  try { const b = document.querySelector('.back'); if (b) b.textContent = '返回中…'; } catch (e) {}
  try { if (SSE) { SSE.close(); SSE = null; } } catch (e) {}
  try { hideStageLoading(); } catch (e) {}
  try { destroyArt(); } catch (e) {}   /* 掐掉 HLS 分片加载，别跟跳转抢连接 */
  stopPendingImages();
  abortAllRequests();
  location.href = '/index.html';
}
window.goHome = goHome;
/* 浏览器后退 / 关标签页也要清场：否则在途请求会继续打上游，白占连接和配额 */
window.addEventListener('pagehide', () => {
  _LEAVING = true;
  try { if (SSE) { SSE.close(); SSE = null; } } catch (e) {}
  abortAllRequests();
});
/* 从「前进/后退缓存」回到播放页时必须解除离开态，否则 api() 会一路抛 leaving，页面全废 */
window.addEventListener('pageshow', (e) => {
  if (e.persisted) { _LEAVING = false; try { connectSSEP(); } catch (x) {} }
});
/* ---------- v50/v52 起播看门狗：把「从未起播」和「播到一半卡住」彻底分开 ----------
   v52 教训（18:14 大哥手机日志）：手机端首帧渲染本来就慢（实测 >24s，rs=3 net=2 buf=0），
   v50 的 8s 阈值太激进——软重启 hls.startLoad 还会打断在途的缓冲，越弄越慢，
   最后连环换线，把本来能播的线路全换掉了（大哥看到「播放好好的就这样自动换线」）。
   现在：① 20s 无任何媒体数据才软重启（一次）；② 40s 仍无画面才换线；
   ③ 只要缓冲区出现过数据（_mediaSeen）就绝不换线——数据都到了，起不来是终端问题。 */
function stopNoplayWatchdog() { try { if (_wdTimer) { clearInterval(_wdTimer); _wdTimer = null; } } catch (e) {} }
function bufEndOf(v) { try { return v.buffered && v.buffered.length ? v.buffered.end(v.buffered.length - 1) : 0; } catch (e) { return 0; } }
/* v69：起播兜底——手机浏览器（全屏里自动切下一集时没有用户手势）常拒绝带声自动播放，
   画面就停在黑屏/暂停。这里先静音起播保证有画面，用户第一次触摸屏幕再自动开声 */
function ensurePlaying() {
  const v = (ART && ART.video) ? ART.video : null;
  if (!v || !v.paused) return;
  const go = () => { try { const p = v.play(); if (p && p.catch) p.catch(() => {}); } catch (e) {} };
  try {
    const p = v.play();
    if (p && p.catch) p.catch(() => {
      try { v.muted = true; v.__autoMuted = true; } catch (e) {}
      go();
      reportLog('warn', 'play', '自动播放被拦截 → 已静音起播（触摸屏幕自动恢复声音）线路=' + (CUR_LABEL || ''));
      try { artNotice('🔇 浏览器拦了带声自动播放 · 先静音起播，点一下屏幕就恢复声音'); } catch (e) {}
      wireAutoUnmute();
    });
  } catch (e) {}
}
function wireAutoUnmute() {
  const h = () => {
    try {
      const v = (ART && ART.video) ? ART.video : null;
      if (v && v.__autoMuted) { v.muted = false; v.__autoMuted = false; }
    } catch (e) {}
    try { document.removeEventListener('touchstart', h); document.removeEventListener('click', h); } catch (e) {}
  };
  try { document.addEventListener('touchstart', h, { passive: true }); document.addEventListener('click', h); } catch (e) {}
}
function startNoplayWatchdog() {
  stopNoplayWatchdog();
  _wdTimer = setInterval(() => {
    try {
      const v = (ART && ART.video) ? ART.video : null; if (!v) return;
      if (bufEndOf(v) > 0.1) _mediaSeen = true;
      if (v.currentTime > 0.35) { _started = true; _noplaySince = 0; _noplayTried = 0; stopNoplayWatchdog(); return; }
      if (_started) { stopNoplayWatchdog(); return; }
      if (v.paused || v.seeking) { _noplaySince = 0; return; }   /* 主动暂停/自动播放被拦截，不算故障 */
      if (!_noplaySince) { _noplaySince = Date.now(); return; }
      /* v52b：缓冲起点空洞——18:42 美人余日志 rs=3 buf>0 但进度永远停在 0：
         数据有，但首块缓冲不是从 0 开始（上游切片时间轴/广告过滤的映射偏移），
         播放头在 0 上无数据可播 → 转圈卡住。6s 后直接跳到首块缓冲起点。
         上游不过滤清单所以看不到这问题；这一跳就是「上游丝滑、我们卡死」的主因之一 */
      if (!_gapFix && _mediaSeen && !v.seeking && Date.now() - _noplaySince >= 6000) {
        const bs = (() => { try { return v.buffered.length ? v.buffered.start(0) : 0; } catch (e) { return 0; } })();
        if (bs > 0.5) {
          _gapFix = true;
          try { v.currentTime = bs + 0.05; } catch (e) {}
          reportLog('warn', 'noplay', '起播位置无数据（缓冲起点 ' + bs.toFixed(1) + 's，0 处是空洞）→ 跳到首块缓冲起点 线路=' + (CUR_LABEL || ''), 't=0→' + bs.toFixed(1));
          _noplaySince = Date.now(); _noplayTried = 0;
          artNotice('已自动定位到可播放位置 ▶');
          return;
        }
      }
      const waited = Date.now() - _noplaySince;
      if (waited < 20000) return;                                /* 首帧给足 20s（手机网络+代理清单） */
      _noplaySince = 0; _noplayTried++;
      const bx = bufEndOf(v);
      const st = 'rs=' + v.readyState + ' net=' + v.networkState + ' buf=' + bx.toFixed(1) + ' err=' + (v.error ? v.error.code : '-');
      if (_noplayTried === 1) {
        reportLog('warn', 'noplay', '起播等待 20s 无画面（' + (_mediaSeen ? '有媒体数据' : '始终无媒体数据') + '）→ 软重启 线路=' + (CUR_LABEL || ''), st);
        try { if (ART.hls && ART.hls.stopLoad) ART.hls.stopLoad(); } catch (e) {}
        try { if (ART.hls && ART.hls.startLoad) ART.hls.startLoad(0); } catch (e) {}
        if (!ART.hls && (v.readyState === 0 || v.error)) { try { v.load(); } catch (e) {} }
        try { v.play(); } catch (e) {}
        artNotice('线路加载较慢，正在重试起播…');
        return;
      }
      /* 40s 仍无画面：有过媒体数据的再给最后一轮软重启，彻底没有的才换线 */
      if (_mediaSeen && _noplayTried === 2) {
        reportLog('warn', 'noplay', '起播 40s 仍有媒体数据但无画面 → 最后一次软重启 线路=' + (CUR_LABEL || ''), st);
        try { if (ART.hls && ART.hls.stopLoad) ART.hls.stopLoad(); } catch (e) {}
        try { if (ART.hls && ART.hls.startLoad) ART.hls.startLoad(0); } catch (e) {}
        try { v.play(); } catch (e) {}
        return;
      }
      if (_noplayTried >= 3 || (!_mediaSeen && _noplayTried >= 2)) {
        reportLog('error', 'noplay', '起播失败（40s+ 无画面' + (_mediaSeen ? '、曾有数据' : '、始终无数据') + '）→ 自动换线 线路=' + (CUR_LABEL || ''), st);
        stopNoplayWatchdog();
        autoNextLine('起播失败（一直无画面）');
      }
    } catch (e) {}
  }, 1000);
}
/* v59：全屏状态下换集/换线不退出全屏。
   Artplayer 的全屏元素是它自己生成的 $player，换集要 destroy 重建播放器，
   全屏元素一被移出 DOM 浏览器立刻退全屏（用户报的「跳过片尾自动下一集后不全屏」）。
   利用规范行为「文档已处于全屏时切换全屏元素不需要用户手势」：
   销毁前先把全屏挪到持久的 .stage-inner 上（它不参与重建），销毁重建后全屏就不断了。 */
function keepFullscreenAcrossRebuild() {
  try {
    const cur = document.fullscreenElement || document.webkitFullscreenElement;
    if (!cur) return;
    const stage = document.querySelector('#stage');
    if (!stage || !stage.contains(cur)) return;   /* 全屏的不是播放器内部元素，本就安全 */
    const keep = stage.closest('.stage-inner') || stage.parentElement;
    if (keep && keep !== cur) {
      const pr = keep.requestFullscreen ? keep.requestFullscreen() : (keep.webkitRequestFullscreen ? keep.webkitRequestFullscreen() : null);
      if (pr && pr.catch) pr.catch(() => {});
    }
  } catch (e) {}
}
/* v70：切集/换线后把全屏补回来。
   自动切下一集时没有用户手势，浏览器可能直接把全屏退掉，
   用户看到的就是「切完集画面缩回小窗，得退出去重新点全屏」。
   优先恢复真全屏（文档已在全屏时切元素不需要手势）；万一被拒，
   退回 Artplayer 的网页全屏（铺满视口），至少不会缩回小窗 */
let _fsKeep = false;
function restoreFullscreen() {
  if (!_fsKeep) return;
  _fsKeep = false;
  try {
    if (document.fullscreenElement || document.webkitFullscreenElement) return;   /* 本来就没丢 */
    const el = document.querySelector('.stage-inner');
    let pr = null;
    if (el && el.requestFullscreen) { try { pr = el.requestFullscreen(); } catch (e) {} }
    if (pr && pr.catch) pr.catch(() => { try { if (ART) ART.fullscreenWeb = true; } catch (e) {} });
    else if (ART) ART.fullscreenWeb = true;
  } catch (e) { try { if (ART) ART.fullscreenWeb = true; } catch (e2) {} }
}
/* v59：全屏宿主重定向——换集/换线不退出全屏。
   Artplayer 把全屏请求打在它自建的 $player 上（实例属性 non-configurable，覆写不了），
   而换集要销毁重建播放器，$player 一被移出 DOM 浏览器立刻退全屏。
   在 API 层接管：播放器内部的元素请求全屏时，一律重定向到持久的 .stage-inner
   （它不参与重建）。发起时机永远是用户手势（点按钮/双击/按 F），必然成功。
   Artplayer 的 fullscreen 状态只看 document.fullscreenElement（screenfull），
   fullscreenchange 也是 document 级监听，换宿主后状态/事件照常，无副作用。 */
(function () {
  try {
    if (Element.prototype.__fsHostRedirect) return;
    const orig = Element.prototype.requestFullscreen;
    if (!orig) return;
    Element.prototype.__fsHostRedirect = true;
    Element.prototype.requestFullscreen = function () {
      try {
        const target = document.querySelector('.stage-inner');
        if (target && this && target.contains(this) && this !== target) return orig.apply(target, arguments);
      } catch (e) {}
      return orig.apply(this, arguments);
    };
    /* webkit 前缀（旧 Safari）同样处理，回调式无返回值 */
    const ow = Element.prototype.webkitRequestFullscreen;
    if (ow) Element.prototype.webkitRequestFullscreen = function () {
      try {
        const target = document.querySelector('.stage-inner');
        if (target && this && target.contains(this) && this !== target) return ow.apply(target, arguments);
      } catch (e) {}
      return ow.apply(this, arguments);
    };
    /* art-fullscreen 样式类按真实全屏状态同步（原来按「全屏元素=== $player」判定，换宿主后不会自己加） */
    const syncCls = () => {
      try {
        const fe = document.fullscreenElement || document.webkitFullscreenElement;
        const $p = (typeof ART !== 'undefined') && ART && ART.template && ART.template.$player;
        if (!$p) return;
        const inFs = !!(fe && (fe === $p || (fe.contains && fe.contains($p))));
        $p.classList.toggle('art-fullscreen', inFs);
        /* v69：全屏态同步到 <html>——进全屏就停掉流光/跑马灯这类每帧重绘动画，
           手机端横屏全屏时才有余力解码；同时兜一次起播（全屏切换常被浏览器暂停） */
        document.documentElement.classList.toggle('is-fullscreen', inFs);
        if (inFs) setTimeout(() => { try { ensurePlaying(); } catch (e) {} }, 250);
      } catch (e) {}
    };
    document.addEventListener('fullscreenchange', syncCls);
    document.addEventListener('webkitfullscreenchange', syncCls);
  } catch (e) {}
})();
function destroyArt() {
  keepFullscreenAcrossRebuild();   /* v59：兜底——万一全屏目标仍是播放器内部元素，销毁前先挪走 */
  /* v70：记下销毁前是不是在全屏，重建后好把全屏补回去 */
  _fsKeep = !!(document.fullscreenElement || document.webkitFullscreenElement);
  stopNoplayWatchdog();   // v50：销毁播放器时撤掉起播看门狗，避免对已销毁实例出手
  if (ART) {
    try { if (ART.hls) { ART.hls.destroy(); ART.hls = null; } } catch (e) {}
    /* v53：destroy(true) 连 DOM 一起清——传 false 时旧实例的 DOM 残留，
       新实例初始化把 container 清空后，旧实例迟到的内部事件再访问 $parent 就是 null（竞态报错源）。
       #stage 内容本来就要重建，清掉无副作用；playFrame/iframe 场景会自己重设 innerHTML */
    try { ART.destroy(true); } catch (e) {}
    ART = null;
  }
  hidePauseAd();   // 换集/换线路时撤掉暂停广告
  resetAutoSkip();   // 新一轮播放（换集/换线路）重置自动跳过状态
  resetPlayDiag();   // 重置播放诊断去重/状态
  const sb = $('#speedbar'); if (sb) sb.classList.add('hidden');
  const sp = $('#skipPill'); if (sp) sp.classList.add('hidden');
}
function wireArt() {
  if (!ART) return;
  ensureSkipPill();   /* v65：新实例就绪时兜底补建胶囊（手机端归位到倍速条） */
  /* v53：Artplayer setting 插件竞态防御——插件 mounted/ playbackRate 事件回调里
     setting.check(option) 可能拿到 $parent 为 null 的 option（实例切换/树未就绪时序），
     库内直接 `e.$parent.tooltip=` 会抛 TypeError。给每个实例的 check 包一层空值保护。 */
  try {
    const st = ART.setting;
    if (st && typeof st.check === 'function' && !st.__guarded) {
      st.__guarded = true;
      const orig = st.check.bind(st);
      st.check = (opt) => { try { if (!opt || opt.$parent == null) return; orig(opt); } catch (e) {} };
    }
  } catch (e) {}
  $('#speedbar').classList.remove('hidden');
  ART.on('video:loadedmetadata', () => {
    /* v53：Q_POS 续播前先确认还是当前实例（防止换线竞态里操作已销毁的播放器 → $parent null） */
    /* v70：只有「位置所属集 === 当前集」才续播，跨集的位置一律丢弃 */
    const posOk = Q_POS > 0 && Q_POS_EP === EP_IDX;
    if (!posOk) { Q_POS = 0; Q_POS_EP = -1; }
    if (posOk && ART && ART.video) {
      const dur = isFinite(ART.video.duration) ? ART.video.duration : 0;
      /* 新线路时长可能不同：目标点太靠后（接近/超过结尾）就放弃 seek，从开头播，
         避免 seek 越界报错又触发一连串换线（竞态源头） */
      if (dur > 0 && Q_POS < dur - 5) {
        RESUMING = true;
        try { ART.video.currentTime = Q_POS; } catch (e) {}
        /* v69c：此刻报的时长可能还不准（hls.js 边解析边长），目标点其实越过了真实片尾 →
           浏览器会把 currentTime 直接钳到片尾，新集一上来就「播完了」→ 连锁跳集。
           seek 后复查一次，发现被钳到片尾就从开头播 */
        setTimeout(() => {
          try {
            if (!ART || !ART.video) return;
            const d2 = isFinite(ART.video.duration) ? ART.video.duration : 0;
            if (d2 > 0 && (ART.video.currentTime || 0) >= d2 - 4) {
              ART.video.currentTime = 0;
              reportLog('warn', 'play', '续播位置越界被钳到片尾，已改为从头播放', 'pos=' + Q_POS_LAST);
            }
          } catch (e) {}
        }, 2500);
        setTimeout(() => { RESUMING = false; }, 2500);   /* 续播缓冲期：避免落回片头区被自动跳过 */
      }
      Q_POS_LAST = Q_POS; Q_POS = 0; Q_POS_EP = -1;
    }
    /* v37：起播即落一条历史并刷新侧栏——刚点开的这部要立刻出现在「播放历史」里 */
    if (ART && ART.video) pushHist(true);
  });
  ART.on('video:timeupdate', () => { maybePushHist(); updateSkipPill(); });
  /* v69：记录用户拖动进度——快进落地后 6s 内不判定片尾/播完，防止乱跳下一集；
     拖到后半段的，本集直接交还控制权（不再自动跳片尾） */
  ART.on('video:seeked', () => {
    try {
      const v = ART.video;
      markUserSeek(v.currentTime || 0, isFinite(v.duration) ? v.duration : 0);
    } catch (e) { _lastSeekAt = Date.now(); }
  });
  /* v69：手机浏览器（尤其全屏里自动切下一集，没有用户手势）会拒绝带声自动播放 →
     先静音起播保证有画面，用户第一次触摸屏幕时自动把声音开回来 */
  setTimeout(ensurePlaying, 300);
  /* v51：加载卡要等「第一帧真的画出来」才撤——手机端浏览器经常 canplay/play 早于首帧渲染，
     提前撤卡就会闪一瞬黑屏 + 大播放键。统一走 maybeReveal：首帧渲染（currentTime>0.15）才收 */
  ART.on('video:playing', maybeReveal);
  ART.on('video:playing', () => { try { if (ART.video && ART.video.currentTime > 0.35) _started = true; } catch (e) {} });
  startNoplayWatchdog();   /* v50：不依赖 timeupdate 的起播看门狗 */
  ART.on('video:error', hideStageLoading);
  /* 广告联盟：暂停弹广告、继续播放即消失 */
  ART.on('video:pause', () => { showPauseAd(); });
  ART.on('video:play', () => { hidePauseAd(); });
  /* 只靠 playing 不够：浏览器拦截自动播放 / 上游只缓冲不出帧时 playing 永不触发。
     canplay/play 只做 reveal 探测（首帧没画出来就继续盖着加载卡），不再直接撤卡 */
  ART.on('video:canplay', maybeReveal);
  ART.on('video:play', maybeReveal);
  ART.on('video:timeupdate', maybeReveal);
  ART.on('video:ended', () => onEnded());
  setTimeout(restoreFullscreen, 800);   /* v70：切集/换线后把全屏补回来 */
  /* 音频/解码诊断上报（v38）：前端才能感知的异常汇进后台日志 */
  ART.on('video:error', () => {
    const ve = ART.video && ART.video.error;
    if (ve) reportLog('error', 'audio', '媒体错误 code=' + ve.code + ' ' + (ve.message || '') + ' 线路=' + (CUR_LABEL || ''), 'ns=' + (ART.video && ART.video.networkState));
  });
  /* 卡顿自愈（v40/v46d）：进度长时间无推进才出手。
     v46d 修正：① 前进判定阈值 0.25→0.02（原来恰好卡在阈值上，正常播放也会被误判卡顿 → 乱 seek → 声音浑厚）；
     ② 缓冲未耗尽绝不 seek（还有数据却"卡"是解码问题，交给下面的音频自愈）；
     ③ 缓冲真耗尽时先软重启分片加载（hls.startLoad，不打断解码），仍卡才微跳。 */
  let _stallSince = 0, _stallHealCooldown = 0, _stallReported = false, _stallTriedReload = false;
  ART.on('video:timeupdate', () => {
    const v = ART.video; if (!v) return;
    /* 音频无声/解码停滞探测（Chromium 系）：播放推进但音频解码字节不增长 → 重建解码器自愈（v46d） */
    const ab = v.webkitAudioDecodedByteCount;
    if (typeof ab === 'number' && !_audioReported && v.currentTime > 5) {
      if (ab - _audioBase < 2000 && (v.currentTime - _audioLast) > 3) {
        _audioMark++;
        if (_audioMark >= 8) {
          _audioReported = true;
          const t = Math.floor(v.currentTime);
          reportLog('warn', 'audio', '音频解码停滞/无声(已播' + v.currentTime.toFixed(0) + 's 音频字节未增长) → 重建解码器自愈 线路=' + (CUR_LABEL || ''), 't=' + t);
          try {
            if (ART.hls && ART.hls.detachMedia) {
              const src = ART.hls;
              src.stopLoad && src.stopLoad();
              src.detachMedia();
              src.attachMedia(v);
              setTimeout(() => { try { v.currentTime = t; v.play(); } catch (e) {} }, 400);
              artNotice('检测到声音异常，已自动修复');
            }
          } catch (e) {}
        }
      } else { _audioMark = 0; }
      _audioBase = ab; _audioLast = v.currentTime;
    }
    /* 暂停/拖动/正在 seek 时进度不动是正常的，不计入卡顿 */
    if (v.paused || v.seeking) { _tLast = v.currentTime; _stallSince = 0; _stallReported = false; _stallTriedReload = false; return; }
    /* v50：还没真正起播（进度停在 0）不是"卡顿"，禁止任何 seek——
       seek 只会被打回开头，正是「播 3 秒又重新开始」的死循环来源。交给看门狗软重启/换线。 */
    if (!_started && v.currentTime < 0.35) { _tLast = v.currentTime; return; }
    const advancing = v.currentTime > _tLast + 0.02;
    if (advancing) { _started = true; _tLast = v.currentTime; _stallSince = 0; _stallReported = false; _stallTriedReload = false; return; }
    if (!_stallSince) _stallSince = Date.now();
    const stuck = Date.now() - _stallSince;
    if (stuck >= 4000 && !_stallReported) {
      _stallReported = true;
      reportLog('warn', 'stall', '播放卡顿/进度无推进(疑似解码器重置或切片断流) 线路=' + (CUR_LABEL || ''), 't=' + v.currentTime.toFixed(1));
    }
    /* 自愈：卡满 4s。先看缓冲——没耗尽不 seek（交给音频自愈/软重启）；耗尽了先 startLoad 软重启，再卡才微跳 */
    if (stuck >= 4000 && Date.now() >= _stallHealCooldown) {
      const bufEnd = (() => { try { return v.buffered.length ? v.buffered.end(v.buffered.length - 1) : 0; } catch (e) { return 0; } })();
      if (bufEnd - v.currentTime >= 0.4) { _stallSince = 0; _stallReported = false; return; }
      if (ART.hls && !_stallTriedReload) {
        _stallTriedReload = true; _stallHealCooldown = Date.now() + 5000;
        try { ART.hls.startLoad(Math.floor(v.currentTime)); } catch (e) {}
        reportLog('info', 'stall-heal', '缓冲耗尽，软重启分片加载(不seek) 线路=' + (CUR_LABEL || '') + ' t=' + v.currentTime.toFixed(1));
        return;
      }
      const dur = v.duration || 0;
      const nudge = Math.min(8, Math.max(2, dur ? (dur - v.currentTime) * 0.02 : 4));
      const target = dur ? Math.min(dur - 0.5, v.currentTime + nudge) : v.currentTime + nudge;
      if (target > v.currentTime + 1) {
        try { v.currentTime = target; } catch (e) {}
        reportLog('warn', 'stall-heal', '自动微跳越过卡死点 线路=' + (CUR_LABEL || '') + ' ' + v.currentTime.toFixed(1) + '→' + target.toFixed(1) + 's', 'nudge=' + nudge.toFixed(1));
        artNotice('检测到卡顿，已自动跳过故障片段');
        _stallSince = 0; _stallReported = false; _stallTriedReload = false; _stallHealCooldown = Date.now() + 3000;
      }
    }
  });
}

/* 剧照背景 + 居中状态卡：独立覆盖层，盖在播放器上直到真正开始播放 */
function stageBackdrop() { return META.backdrop || META.poster || POSTER || ''; }
function ensureStageLoad() {
  let el = $('#stageLoad');
  if (el) return el;
  const si = document.querySelector('.stage-inner'); if (!si) return null;
  el = document.createElement('div');
  el.id = 'stageLoad';
  el.innerHTML = '<div class="stage-load"><img class="sl-bg" alt="" onerror="this.style.display=\'none\'">'
    + '<div class="sl-card">'
    + '<div class="sl-head"><span class="sl-hl"></span><span class="sl-badge" id="slBadge"></span></div>'
    + '<div class="sl-big"></div>'
    + '<div class="sl-line" id="slLine"><i class="dot"></i></div>'
    + '<div class="sl-feats"></div>'
    + '<div class="sl-bar"><i></i></div>'
    + '<div class="sl-foot"><span class="sl-tick" id="slTick"></span><button class="sl-btn" id="slSwitch"></button></div>'
    + '</div></div>';
  /* v63：静态文案（顶部小标题 / 卖点 / 换源按钮）按后台自定义填充 */
  applyCardTexts(el);
  el.querySelector('.sl-big').textContent = pt('slBig', '正在准备播放');
  el.querySelector('#slLine').innerHTML = '<i class="dot"></i>' + esc(pt('slLine', '正在优选播放线路…'));
  el.querySelector('#slBadge').textContent = pt('badgeInit', '线路识别中');
  el.onclick = () => {
    try { if (ART && !ART.playing) ART.play(); } catch (e) {}
    /* v51：点卡也是等首帧渲染再撤（轮询兜底，最多 5s），避免点了又闪黑屏 */
    const iv = setInterval(() => {
      const st = $('#stageLoad');
      if (!st || st.classList.contains('hidden')) { clearInterval(iv); return; }
      maybeReveal();
    }, 200);
    setTimeout(() => clearInterval(iv), 5000);
  };
  si.appendChild(el);
  const sw = el.querySelector('#slSwitch');
  sw.onclick = (ev) => {
    ev.stopPropagation();
    if (MODE !== 'up' || !CUR_TOKEN) { hideStageLoading(); return; }
    LINE_SKIP++;
    /* v53：延后到事件栈外，规避旧实例回调竞态（$parent null） */
    setTimeout(() => playUpToken(CUR_TOKEN), 0);
  };
  return el;
}
/* v63：后台「其他设置」可改的加载卡静态文案（顶部小标题 / 三行卖点 / 换源按钮） */
function applyCardTexts(el) {
  if (!el) el = $('#stageLoad');
  if (!el) return;
  const hl = el.querySelector('.sl-hl');
  if (hl) hl.textContent = pt('slHead', '⚡ 正在准备播放');
  const ft = el.querySelector('.sl-feats');
  if (ft) ft.innerHTML = String(pt('slFeats', '✓ 自动优选|✓ 清晰画面|✓ 秒换线路')).split('|').map(x => `<span>${esc(x.trim())}</span>`).join('');
  const sw = el.querySelector('#slSwitch');
  if (sw) sw.textContent = pt('slSwitch', '⇄ 立即换源');
}
function showStageLoading(title, sub) {
  const el = ensureStageLoad(); if (!el) return;
  applyCardTexts(el);
  const bg = stageBackdrop();
  const im = el.querySelector('.sl-bg');
  if (bg) { im.style.display = ''; im.src = img(bg); } else { im.style.display = 'none'; }
  el.querySelector('.sl-big').textContent = title || pt('slBig', '正在准备播放');
  /* 注意：这里不复位徽章 —— playM3u8/playMp4 内部还会再调 showStageLoading，
     复位会覆盖 resolve/initCollect 刚设置的「官方线路/采集线路」 */
  const line = el.querySelector('#slLine');
  if (line) line.innerHTML = '<i class="dot"></i>' + esc(sub || pt('slLine', '正在优选播放线路…'));
  applySlBadge();   /* 回放徽章（官方线路/采集线路），别被卡片重建冲掉 */
  const sw = el.querySelector('#slSwitch');
  if (sw) sw.style.display = (MODE === 'up' && CUR_TOKEN) ? '' : 'none';
  el.classList.remove('hidden');
  /* 进度条 6 秒走完，超时转「线路较慢可换源」 */
  let n = 0;
  const tick = el.querySelector('#slTick');
  clearInterval(el._tick);
  if (tick) tick.textContent = ptFmt('slTickSoon', '预计 %s 秒内完成', 6);
  el._tick = setInterval(() => {
    n++;
    if (tick) tick.textContent = n <= 6 ? ptFmt('slTickSoon', '预计 %s 秒内完成', 6 - n) : ptFmt('slTickWait', '已等待 %s 秒 · 线路较慢，可立即换源', n);
  }, 1000);
  /* 硬兜底：覆盖层是 absolute+z-index 的独立层，任何分支漏掉 hideStageLoading 都会永久挡住播放器。
     v52：撤卡时间与起播看门狗对齐（20s 软重启 → 40s 再试 → 60s 换线），65s 才强撤，
     不然手机起播慢时 25s 就提前撤卡又露出黑屏，前功尽弃 */
  clearTimeout(el._to);
  el._to = setTimeout(() => {
    if (el.classList.contains('hidden')) return;
    hideStageLoading();
    if (ART) artNotice('迟迟未开始播放，可点播放器内「⇄ 立即换源」或刷新重试');
  }, 65000);
}
/* 加载卡徽章：自动识别当前线路是官方还是采集。
   徽章值先存 SL_BADGE（加载卡 DOM 可能还没建，比如采集模式 initCollect 先于首次 showStageLoading），
   卡片每次显示时用 applySlBadge 回放，保证不丢 */
/* 加载卡徽章：自动识别当前用户会员等级（拿不到等级信息时回落「线路识别中」） */
let VIP_NAME = '', _vipLoading = null;
function loadVipName() {
  if (VIP_NAME) return Promise.resolve(VIP_NAME);
  if (_vipLoading) return _vipLoading;
  _vipLoading = api('/api/points/me').then(pm => { VIP_NAME = (pm && pm.vip && pm.vip.level > 0) ? pm.vip.name : '普通用户'; return VIP_NAME; }).catch(() => '');
  return _vipLoading;
}
let SL_BADGE = { txt: '线路识别中', off: false };
function vipBadgeTxt() { return VIP_NAME || pt('badgeInit', '线路识别中'); }
function setSlBadge(txt, collect) {
  SL_BADGE = { txt: txt || vipBadgeTxt(), off: !!collect };
  applySlBadge();
}
function applySlBadge() {
  const el = $('#stageLoad'); if (!el) return;
  const bd = el.querySelector('#slBadge');
  if (bd) { bd.textContent = SL_BADGE.txt; bd.classList.toggle('off', SL_BADGE.off); }
}
/* 播放链路更新加载卡的线路行 */
function updateSlLine(txt) {
  const el = $('#stageLoad'); if (!el || el.classList.contains('hidden')) return;
  const line = el.querySelector('#slLine');
  if (line) line.innerHTML = '<i class="dot"></i>' + esc(txt);
}
function hideStageLoading() {
  const el = $('#stageLoad'); if (!el) return;
  clearInterval(el._tick);
  clearTimeout(el._to);
  el.classList.add('hidden');
}
/* v51：撤加载卡的统一闸门——第一帧真的渲染出来（currentTime>0.15）或出错才放行。
   canplay/play/playing 都可能早于首帧（手机端尤其明显），提前撤卡就是那一下黑屏+大播放键 */
function maybeReveal() {
  try {
    const v = ART && ART.video; if (!v) return;
    if ((v.currentTime && v.currentTime > 0.15) || v.error) hideStageLoading();
  } catch (e) {}
}
/* 失败收尾：写错误内容到 #stage 的同时必须撤掉加载卡。
   #stageLoad 是盖在 .stage-inner 上的独立层，只改 #stage.innerHTML 不会让它消失 */
function failStage(html) {
  hideStageLoading();
  const st = $('#stage');
  if (st) st.innerHTML = html;
}

/* 跳过片头 / 片尾 胶囊：仅电视剧（剧集/动漫/综艺/短剧）启用，电影不跳片头 */
const SKIP_INTRO_TO = 100;  // 点「跳过片头」跳到第 100 秒（原 90 +10s）
/* 自动跳片头的固定触发秒（v48d）：倒计时和真实跳点严格一致——胶囊数到 0 就跳 */
const SKIP_INTRO_AT = 20;
/* 跳过片头/片尾已纳入会员权限（后台：会员等级 → 访问权限 / 用户权限 / 积分兑换）。
   CFG.views.skipIntro / skipOutro 由服务端按「会员等级 + 用户单独设置 + 兑换时限」算好；
   无权限时不自动跳、胶囊变成金色「会员专享」引导，点击只提示不跳转。 */
const SKIP_VIP_TIP = '跳过片头/片尾为会员特权，可在「积分中心」用积分兑换';
function skipCan(k) { const v = (CFG && CFG.views) || {}; return v[k] !== false; }
/* v47：栏目权限统一入口。/api/config 的 views 由服务端按
   「管理员 → 兑换限时授权 → 会员等级 → 用户单独设置」算好，前端只认 !== false。
   没拿到配置前按「允许」处理，避免首屏把按钮全藏了又闪出来 */
function viewCan(k) { const v = (CFG && CFG.views) || {}; return v[k] !== false; }
/* 自动跳过开关（后台「首页配置 → 自动跳过片头片尾」）：
   开启 = 自然播放进入片头/片尾区自动跳（拖动进度不误触发）；关闭 = 手动点胶囊；
   两种模式都保留弹窗提示 */
let skipIntroDone = false, skipOutDone = false, _lastT = 0;
/* v69：用户自己拖动进度的记录——快进刚落地时不许判定「到片尾/播完了」去自动跳下一集
   （大哥 8:50「快进到最后就狂跳好多集」，源头就是没区分「自然播到片尾」和「手拖到片尾」） */
let _lastSeekAt = 0;
function seekJustHappened() { return Date.now() - _lastSeekAt < 6000; }
/* v69：本集「控制权交还」标记——用户自己把进度拖到后半段/片尾时，
   说明他在自己挑位置，本集就不再自动跳片尾（8:50「快进到最后 → 又自动跳了好多集」的根因：
   老的自动跳片尾不区分自然播放与手拖，一进片尾区就跳）。
   胶囊照样保留，改成手动态，想跳点一下就行 */
let _outBlocked = false, _epStartAt = 0;
function markUserSeek(t, dur) {
  _lastSeekAt = Date.now();
  if (dur > 60 && t > dur * 0.8) _outBlocked = true;
}
/* v69：新集刚起的 8s 内不许自动跳片尾——防止「新集一上来时长/进度异常就立刻又被跳走」的连锁 */
function epJustStarted() { return Date.now() - _epStartAt < 8000; }
function resetAutoSkip() {
  skipIntroDone = false; skipOutDone = false; _lastT = 0;
  _outBlocked = false; _epStartAt = Date.now();
}
function buildSkipPill() {
  if ($('#skipPill')) return true;
  /* v65：手机端直接挂进倍速条（speedbar 在 #stage 外，换集/换线重建播放器不会丢）；
     PC 端挂 .stage-inner（浮在视频右下角）。找不到宿主就返回 false，由 ensureSkipPill 稍后重试 */
  const host = (window.IS_MOBILE && $('#speedbar')) || document.querySelector('.stage-inner');
  if (!host) return false;
  const b = document.createElement('div');
  b.id = 'skipPill'; b.className = 'skip-pill hidden';
  b.onclick = () => {
    if (!ART || !ART.video) return;
    if (b.dataset.act === 'intro') { try { ART.video.currentTime = SKIP_INTRO_TO; } catch (e) {} artNotice('已跳过片头'); }
    else if (b.dataset.act === 'next') { artNotice('自动播放下一集 ▶'); selectEp(EP_IDX + 1); }
    else if (b.dataset.act === 'vip') { artNotice(SKIP_VIP_TIP); }
    b.classList.add('hidden');
  };
  host.appendChild(b);
  return true;
}
/* v65：胶囊只在 init 时建一次，而 .stage-inner 会被加载卡/换线重建覆盖——
   一旦 buildSkipPill 那一刻宿主不存在，胶囊就永远消失（手机端「偶发显示一次，大部分不显示」的根因）。
   updateSkipPill / wireArt 时兜底补建，并把手机端胶囊归位到倍速条 */
function ensureSkipPill() {
  if ($('#skipPill')) return;
  if (!buildSkipPill()) return;
  if (window.IS_MOBILE) { const p = $('#skipPill'), sb = $('#speedbar'); if (p && sb && p.parentNode !== sb) sb.appendChild(p); }
}
function updateSkipPill() {
  const b = ($('#skipPill') || (buildSkipPill(), $('#skipPill'))); if (!b) return;   /* v65：胶囊丢了就地补建 */
  /* v66：手机端胶囊必须住在倍速条里（视频独立合成层会盖住 stage 内绝对定位元素——
     华为等浏览器「不显示跳过片头」的头号嫌疑）。任何时刻发现它不在就搬回去 */
  if (window.IS_MOBILE) { const sbh = $('#speedbar'); if (sbh && b.parentNode !== sbh) sbh.appendChild(b); }
  if (!ART || !ART.video) { b.classList.add('hidden'); return; }
  const v = ART.video, t = v.currentTime || 0, dur = v.duration || 0;
  const auto = !!(CFG && CFG.toggles && CFG.toggles.autoSkip);
  /* 电影不【自动】跳片头：① 上游 content_kind=movie/film；② 采集模式无 kind 时单集即电影。
     v51：电影开场可能直接是正片，固定跳 100s 有吃掉剧情的风险 → 自动跳仍仅剧集；
     但胶囊照样显示（手动「跳过片头 ⏭」，点了才跳）——之前手机端看电影整个胶囊都没有，被当成 BUG */
  const isMovie = META.kind === 'movie' || META.kind === 'film' || (!META.kind && (EP_LIST.length || 0) <= 1);
  const autoIn = auto && !isMovie;
  const introZone = t >= 3 && t < SKIP_INTRO_TO - 5;
  /* v49：片尾区判定加可信度门槛——总时长不到 2 分钟、或还没播到 30 秒，
     一律不认为是片尾（异常清单常把 duration 报成几秒，会误触发「自动跳过片尾·下一集」，
     表现同样是播几秒就重开） */
  /* v69：片尾区改为按片长自适应——固定「剩 100s 内」对短剧（单集 1~2 分钟）永远够不着，
     对长片又太早。现在：剩 max(12, 片长10%) 秒内算片尾，且不早于 30s；
     快进（seek）刚落地时不触发连播——大哥 8:50「快进到最后就狂跳好多集」就是这条路打的 */
  const outGuard = Math.min(100, Math.max(12, dur * 0.10));
  const outZone = dur > 60 && t > 30 && dur - t <= outGuard && dur - t > 3
    && EP_IDX < EP_LIST.length - 1;
  /* 自动跳片尾的门槛：自然播放进片尾区 + 本集没被用户手拖接管 + 不是刚起的新集 */
  const outAuto = outZone && !_outBlocked && !epJustStarted() && !v.seeking;
  /* 会员权限：没权限不自动跳、胶囊改为金色引导 */
  const canIn = skipCan('skipIntro'), canOut = skipCan('skipOutro');
  /* v70：进度大跳就直接认定「用户在自己拖」——不能等 seeked 事件。
     浏览器一接到 seek 就把 currentTime 变成目标位置，而 seeked 要等缓冲落地才派发
     （慢源上几秒到十几秒）。这中间的轮询会把「目标位置」当成自然播放，
     于是拖到片尾 → 立刻又被跳下一集（8:50 / 9:41 连环跳集的真正开关） */
  if (dur > 60 && Math.abs(t - _lastT) > 2 && t > dur * 0.8) {
    _outBlocked = true;
    _lastSeekAt = Date.now();
  }
  /* 自动模式：自然播放（非拖动）进入区间才触发，每集各一次 */
  const natural = t - _lastT >= 0 && t - _lastT < 2;
  _lastT = t;
  /* v46c：跳过时机对齐上游——不要一进区间（3 秒）就 seek。
     太早 seek 会打断刚初始化的音频解码管线，切片 AAC 参数不一致时声音变浑厚；
     等目标位置（100s）已缓冲好再跳最稳，兜底 20 秒必跳（源太慢也不错过跳过） */
  /* v48d：自动跳片头固定在第 20 秒触发（v46c 的「缓冲好就提前跳」废弃——
     那会让倒计时和真实跳点对不上，还冒出「缓冲中」这种不确定状态）。
     20 秒时解码器早已稳定，seek 不会再触发声音浑厚；万一卡住由 stall-heal 兜底 */
  const skipNow = t >= SKIP_INTRO_AT;
  if (autoIn && canIn && !skipIntroDone && natural && introZone && !RESUMING && skipNow) {
    skipIntroDone = true;
    try { v.currentTime = SKIP_INTRO_TO; } catch (e) {}
    _lastT = SKIP_INTRO_TO;
    b.classList.add('hidden');   /* 跳完立刻收起胶囊，别残留「跳过片头」字样 */
    artNotice('已自动跳过片头 ▶');
    return;
  }
  if (auto && canOut && !skipOutDone && natural && outAuto) {
    skipOutDone = true;
    b.classList.add('hidden');
    reportLog('info', 'play', '自动跳过片尾·连播 ep=' + (EP_IDX + 1) + '（t=' + t.toFixed(1) + '/' + dur.toFixed(1) + 's）线路=' + (CUR_LABEL || ''));
    artNotice('已自动跳过片尾 · 播放下一集 ▶');
    selectEp(EP_IDX + 1);
    return;
  }
  /* v48：开了自动跳过后，胶囊不再是「跳过片头」手动按钮（自动跳已经接管），
     改成预告「即将自动跳过片头 Ns」——倒计时数到 0 就真的跳，秒秒对得上；
     仍然可以点它立刻跳，不等自动时机。预告态加 is-auto，配色与播放器通知条同一套青紫渐变；
     自动跳关闭时保持原深色手动胶囊 */
  if (introZone) {
    b.classList.toggle('is-vip', !canIn);
    b.classList.toggle('is-auto', autoIn && canIn);
    if (!canIn) b.textContent = '👑 会员专享 · 跳过片头';
    else if (autoIn) b.textContent = '即将自动跳过片头 ' + Math.max(1, Math.ceil(SKIP_INTRO_AT - t)) + 's ⏭';
    else b.textContent = '跳过片头 ⏭';
    b.dataset.act = canIn ? 'intro' : 'vip';
    b.classList.remove('hidden');
    /* v68：首次真正可见才上报（v66 版在 t=0 就报，误导排查——手机端日志全是 t=0）。
       若真机仍反馈不显示：日志里没有这条=胶囊没进可见分支（视频没播到 3s）；
       有这条但看不到=遮挡/样式问题，两条路一查便知 */
    if (!window.__pillShownLog) {
      window.__pillShownLog = true;
      reportLog('info', 'skipPill', 'pill visible', 't=' + t.toFixed(1) + ' auto=' + autoIn + ' canIn=' + canIn + ' parent=' + (b.parentNode && (b.parentNode.id || b.parentNode.className)));
    }
  } else if (outZone) {
    /* v69：用户自己拖过来的（_outBlocked）→ 胶囊降级为手动，不再自动跳 */
    const showAuto = auto && canOut && !_outBlocked && !epJustStarted();
    b.classList.toggle('is-vip', !canOut);
    b.classList.toggle('is-auto', showAuto);
    b.textContent = !canOut ? '👑 会员专享 · 跳过片尾' : (showAuto ? '即将自动跳过片尾 · 下一集 ⏭' : '跳过片尾 · 下一集 ⏭');
    b.dataset.act = canOut ? 'next' : 'vip';
    b.classList.remove('hidden');
  } else {
    b.classList.add('hidden');
  }
}
/* v66：华为等部分手机浏览器 timeupdate 触发不可靠（省流模式/后台节流），胶囊会不动或不出现——
   加 1s 兜底轮询。自动跳有 skipIntroDone/skipOutDone 闸，重复调用无副作用。
   v68b：同一轮询里补「ended 侦测」——部分手机浏览器全屏播放时 ended 事件不派发
   （视频被浏览器自带播放层接管），表现为「全屏看完不自动跳下一集」；
   onEnded 内部有 3s 去重，事件+轮询双路径不会重复切集 */
setInterval(() => {
  try {
    if (!ART || !ART.video) return;
    updateSkipPill();
    const v = ART.video;
    if (v.ended && !v.seeking && isFinite(v.duration) && v.duration > 30) onEnded();
    else if (window.IS_MOBILE) tailStallCheck();   /* v70：手机小画面常常不抛 ended */
  } catch (e) {}
}, 1000);
/* v70：手机浏览器（尤其小画面）经常压根不派发 ended——省流/后台节流把视频卡在片尾，
   进度停着不动，看着就是「小画面怎么都不自动下一集」（全屏有系统播放层接管反而正常）。
   不依赖 ended 事件：进度进到片尾 30s 内 + 连续 6s 没再前进 + 不是用户主动暂停 → 按播完处理 */
let _tailSince = 0, _tailT = -1;
function tailStallCheck() {
  const v = (ART && ART.video) ? ART.video : null; if (!v) return;
  const dur = isFinite(v.duration) ? v.duration : 0;
  const t = v.currentTime || 0;
  if (dur < 60 || v.ended || v.paused || v.seeking) { _tailSince = 0; _tailT = -1; return; }
  if (t < dur - 30) { _tailSince = 0; _tailT = -1; return; }
  if (_tailT < 0 || Math.abs(t - _tailT) > 1.5) { _tailT = t; _tailSince = Date.now(); return; }
  if (!_tailSince || Date.now() - _tailSince < 6000) return;
  _tailSince = 0; _tailT = -1;
  reportLog('info', 'play', '小画面停在片尾不动（浏览器未抛 ended）→ 按播完处理 t=' + t.toFixed(1) + '/' + dur.toFixed(1) + 's 线路=' + (CUR_LABEL || ''), 'ep=' + EP_IDX);
  onEnded();
}
async function playM3u8(url, manifest) {
  CUR_PLAY_URL = url || '';   /* v36：投屏用原始直链（过滤地址带 token，设备访问不了） */
  let myArt = null;           /* v53：实例代次，旧实例迟到的回调直接忽略 */
  showStageLoading(pt('stTitle', '精彩即将开始'), pt('stSub', '正在加载视频 · 如未自动播放请点击画面'));
  destroyArt();
  /* 广告过滤：开启时统一走 /api/m3u8filter（服务端鉴权 + 改写清单，切片仍直连源站） */
  const adOn = CFG && CFG.adFilter && CFG.adFilter.enabled;
  let playUrl, blocked = 0, isMaster = false;
  if (manifest != null) {
    /* 方案C：resolve 已合并过滤好清单，直接用 blob 喂 HLS（切片仍直连源站），省一次浏览器→服务端往返 */
    const m = manifest.match(/# X-AD-BLOCKED:\s*(\d+)/);
    blocked = m ? parseInt(m[1], 10) : 0;
    isMaster = /#EXT-X-STREAM-INF/i.test(manifest);
    const blob = new Blob([manifest], { type: 'application/vnd.apple.mpegurl' });
    playUrl = URL.createObjectURL(blob);
    window.__aistreamBlob && URL.revokeObjectURL(window.__aistreamBlob);
    window.__aistreamBlob = playUrl;
  } else if (adOn) {
    playUrl = '/api/m3u8filter?url=' + encodeURIComponent(url) + (TOKEN ? ('&token=' + encodeURIComponent(TOKEN)) : '');
    try {
      const r = await fetch(playUrl, { headers: { 'Authorization': 'Bearer ' + TOKEN } });
      if (r.ok) {
        const txt = await r.text();
        const m = txt.match(/# X-AD-BLOCKED:\s*(\d+)/);
        blocked = m ? parseInt(m[1], 10) : 0;
        /* 主清单的计数是各码率变体之和，需等 HLS 选定具体码率后读该变体清单才是真实拦截数 */
        isMaster = /#EXT-X-STREAM-INF/i.test(txt);
      }
    } catch (e) { console.warn('[adfilter] 预取失败', e); }
  } else {
    playUrl = url;
  }
  /* 只提示一次：主清单路径由 MANIFEST_PARSED 读变体清单后补提示 */
  let adShown = false;
  const showAdNotice = n => { if (adShown || !n) return; adShown = true; artNotice('已拦截 ' + n + ' 个插播广告'); };
  const readBlocked = async (u) => {
    try {
      /* 只有同源(/api/...)才带 Authorization：跨域带自定义头会触发预检，多数采集站不允许 → CORS 失败 */
      const sameOrigin = /^\//.test(u) || u.indexOf(location.origin) === 0;
      const r = await fetch(u, sameOrigin ? { headers: { 'Authorization': 'Bearer ' + TOKEN } } : {});
      if (!r.ok) return 0;
      const txt = await r.text();
      const m = txt.match(/# X-AD-BLOCKED:\s*(\d+)/);
      return m ? parseInt(m[1], 10) : 0;
    } catch (e) { return 0; }
  };
  let hlsPath = false;
  if (window.Hls && Hls.isSupported()) {
    hlsPath = true;
    ART = new Artplayer({
      container: '#stage', url: playUrl, type: 'm3u8', autoplay: true, mutex: true,
      theme: '#00e5ff', lang: 'zh-cn',
      poster: artPoster(),   /* v68：起播前垫海报，不再黑屏干等 */
      setting: true, hotkey: true, flip: true, playbackRate: true, aspectRatio: true,
      fullscreen: true, fullscreenWeb: true, miniProgressBar: true,
      pip: true, screenshot: true, lock: true,
      customType: {
        m3u8: function (video, u) {
          try { if (ART.hls) { ART.hls.destroy(); ART.hls = null; } } catch (e) {}
          const hls = new Hls({
            maxBufferLength: 30, manifestLoadingTimeOut: 20000,
            /* 仅给同源代理请求带鉴权头；采集站 ts 直连不带，避免触发跨域预检 */
            xhrSetup: function (xhr, reqUrl) {
              if (reqUrl && reqUrl.indexOf('/api/m3u8filter') !== -1) {
                try { xhr.setRequestHeader('Authorization', 'Bearer ' + TOKEN); } catch (e) {}
              }
            }
          });
          hls.loadSource(u);
          hls.attachMedia(video);
          ART.hls = hls;
          /* 主清单：HLS 选定码率后，读该变体清单（服务端已缓存，开销极小）拿准确拦截数 */
          hls.on(Hls.Events.MANIFEST_PARSED, async () => {
            if (!isMaster) return;
            try {
              const idx = hls.loadLevel >= 0 ? hls.loadLevel : (hls.currentLevel >= 0 ? hls.currentLevel : 0);
              const lv = hls.levels[idx] || hls.levels[0];
              if (lv && lv.url) showAdNotice(await readBlocked(lv.url));
            } catch (e) { /* 读不到就不提示，绝不影响播放 */ }
          });
          hls.on(Hls.Events.ERROR, (ev, data) => {
            /* v53：实例代次防御——ART 已被换掉（换线/换集）时，旧实例迟到的 fatal error
               不许再触发换线，否则会操作已销毁的播放器（$parent null 竞态） */
            if (ART !== myArt) return;
            if (data && data.fatal) {
              try { if (ART.hls) { ART.hls.destroy(); ART.hls = null; } } catch (e) {}
              if (!autoNextLine('播放失败')) {
                failStage('<div class="empty" style="height:100%;display:grid;place-items:center">视频加载失败，请换一集或换线路重试</div>');
              }
            } else if (data && /mediaError|demuxerError|bufferAppendError|fragParsingError|audioTracks|decoding|noAudioTrack|noVideoTrack/i.test(data.details || '')) {
              /* 非致命的解码/媒体类错误累计上报：拼接广告源常导致解码器反复重置 → 声音异常的前兆 */
              reportLog('warn', 'audio', 'HLS非致命解码/媒体错误: ' + (data.details || '') + ' 线路=' + (CUR_LABEL || ''), 'frag=' + (data.frag ? data.frag.sn : ''));
            }
          });
        }
      }
    });
    myArt = ART;
    wireArt();
  } else if (window.Artplayer && document.createElement('video').canPlayType('application/vnd.apple.mpegurl')) {
    /* v49：iOS Safari / 微信内置浏览器走原生 HLS。
       blob: URL 没有 base，Safari 也不接受它当 HLS 源 → 播几秒就断/假 ended。
       这里必须喂真实 http(s) 地址：开了广告过滤就走同源代理（服务端会把分片绝对化），
       没开就用上游直链。 */
    let nativeUrl = url || playUrl;
    if (adOn && url) nativeUrl = '/api/m3u8filter?url=' + encodeURIComponent(url) + (TOKEN ? ('&token=' + encodeURIComponent(TOKEN)) : '');
    ART = new Artplayer({ container: '#stage', url: nativeUrl, autoplay: true, theme: '#00e5ff', lang: 'zh-cn', setting: true, fullscreen: true, miniProgressBar: true, poster: artPoster() });
    myArt = ART;
    wireArt();
  } else {
    hideStageLoading(); $('#stage').innerHTML = `<iframe src="${esc(playUrl)}"></iframe>`;
  }
  /* 移动端（尤其 iOS Safari / 微信内置浏览器）必须 playsinline，否则点播放会被强制拉起原生全屏，
     App 内的进度条/拖动条直接消失 → 无法快进拖动。playMp4 路径已在内部设过，这里补 m3u8/原生 HLS 两条路径 */
  if (ART && ART.video) {
    try { ART.video.setAttribute('playsinline', ''); ART.video.setAttribute('webkit-playsinline', ''); } catch (e) {}
  }
  /* 非主清单：预取计数即真实值；主清单走 HLS 的由 MANIFEST_PARSED 补提示，其余降级路径用预取值兜底 */
  if (!isMaster || !hlsPath) showAdNotice(blocked);
}
/* 视频直链播放：同样用 Artplayer，保留主题皮肤 / 倍速 / 设置 / 上一集下一集 / 跳过片头 */
function playMp4(url) {
  CUR_PLAY_URL = url || '';   /* v36：投屏用原始直链 */
  showStageLoading(pt('stTitle', '精彩即将开始'), pt('stSub', '正在加载视频 · 如未自动播放请点击画面'));
  destroyArt();
  if (!window.Artplayer) { playFrame(url); return; }
  /* v53：CDN 连接预热——先发一个 1 字节 Range 请求把 TCP+TLS 建好（不阻塞），
     video 元素随后复用这条连接，冷起播省一个 RTT（实测连接建立 ~200ms） */
  try { fetch(url, { headers: { Range: 'bytes=0-1' } }).then(r => { try { r.body && r.body.cancel && r.body.cancel(); } catch (e) {} }).catch(() => {}); } catch (e) {}
  ART = new Artplayer({
    container: '#stage', url: url, autoplay: true, mutex: true,
    theme: '#00e5ff', lang: 'zh-cn',
    poster: artPoster(),   /* v68：起播前垫海报，不再黑屏干等 */
    setting: true, hotkey: true, flip: true, playbackRate: true, aspectRatio: true,
    fullscreen: true, fullscreenWeb: true, miniProgressBar: true,
    pip: true, screenshot: true, lock: true,
    airplay: true,
  });
  const myArt = ART;
  wireArt();
  let failed = false;
  const onFail = () => {
    /* v53：实例代次防御——ART 已被换掉时忽略旧实例迟到的 error */
    if (ART !== myArt) return;
    if (failed) return; failed = true;
    if (MODE === 'up' && CUR_TOKEN) { autoNextLine('该线路播放失败'); return; }
    hideStageLoading();
  };
  ART.on('video:error', onFail);
  ART.on('error', onFail);
  if (ART.video) {
    try { ART.video.setAttribute('playsinline', ''); ART.video.setAttribute('webkit-playsinline', ''); } catch (e) {}
  }
}
function playFrame(url) {
  destroyArt();
  $('#stage').innerHTML = `<iframe src="${esc(url)}" allow="autoplay; fullscreen" referrerpolicy="no-referrer"></iframe>`;
  setTimeout(hideStageLoading, 3000);   // iframe 拿不到播放事件，兜底 3s 撤掉覆盖层
}

/* 倍速 / 播放暂停 快捷条 */
function buildSpeedBar() {
  const bar = $('#speedbar');
  bar.innerHTML = '<span class="lab">倍速</span>';
  const pp = document.createElement('div');
  pp.className = 'spd'; pp.textContent = '⏯ 播放/暂停';
  pp.onclick = () => { if (ART) { ART.playing ? ART.pause() : ART.play(); } };
  bar.appendChild(pp);
  SPEEDS.forEach(v => {
    const b = document.createElement('div');
    b.className = 'spd' + (v === 1 ? ' active' : '');
    b.textContent = v + 'x';
    b.onclick = () => {
      if (!ART) return;
      ART.playbackRate = v;
      bar.querySelectorAll('.spd').forEach(x => { if (x !== pp) x.classList.remove('active'); });
      b.classList.add('active');
    };
    bar.appendChild(b);
  });
}

/* 上一集 / 下一集 控制条（并到倍速条后面） */
function buildCtrls() {
  const c = $('#speedbar'); if (!c) return;
  if (c.querySelector('.pnav')) return;
  const prev = document.createElement('button'); prev.className = 'pnav prev'; prev.textContent = '⏮ 上一集';
  prev.onclick = () => stepEp(-1);
  const nx = document.createElement('button'); nx.className = 'pnav next'; nx.textContent = '下一集 ⏭';
  nx.onclick = () => stepEp(1);
  c.appendChild(prev); c.appendChild(nx);
  const ln = document.createElement('span');
  ln.className = 'p-line'; ln.id = 'pLine';
  ln.textContent = '当前播放线路源: --';
  ln.style.cursor = 'pointer';
  ln.title = '点击打开换源面板';
  ln.onclick = () => openLinePanel();
  c.appendChild(ln);
  updateLineLabel();
  updateEpNav();
}

/* ---------- 换源面板：点倍速条末尾的线路标签弹出，像上游一样分组选线 ---------- */
let LP_DATA = null, LP_TAB = 'smart';
/* 全线路插播自动识别（v40）：进入影片/剧集后后台扫描一次所有线路，落 'play-ad' 日志；
   结果按 url 缓存，换源面板直接复用，免去重复打上游 */
let ALL_LINE_AD = {}, SCAN_TOKEN = '', SCAN_P = null;
async function scanAllLinesBg(token, title) {
  if (!token || SCAN_TOKEN === token) return SCAN_P;
  SCAN_TOKEN = token;
  SCAN_P = (async () => {
    try {
      const r = await api('/api/ad-scan-all?token=' + encodeURIComponent(token));
      const lines = (r && r.lines) || [];
      ALL_LINE_AD = {};
      lines.forEach(x => { if (x.url) ALL_LINE_AD[x.url] = x; });
      const ad = lines.filter(x => x.verdict === 'ad').length;
      console.log('[ad-scan] 全线路识别完成：' + lines.length + ' 条，' + ad + ' 条含插播');
    } catch (e) { console.warn('[ad-scan] 失败', e); }
  })();
  return SCAN_P;
}
/* 漏网广告反馈（v40）：个别遗漏可在换源面板点「⚠漏报」提交，后台写 /data/ad-reports.json 并落日志，事后升级规则 */
async function reportMissedAd(label, url, title) {
  const ts = (ART && ART.video) ? Math.round(ART.video.currentTime || 0) : 0;
  const note = prompt('补充信息（可选）：如「此处插播了某广告，约在 ' + ts + ' 秒」', '');
  if (note === null) return;
  try {
    await fetch('/api/ad-report', { method: 'POST', headers: { 'Authorization': 'Bearer ' + TOKEN, 'Content-Type': 'application/json' }, body: JSON.stringify({ title: META.title || title || TITLE, label, url, ts, note }) });
    toast('已提交漏网广告反馈，稍后将优化拦截规则 ✓');
  } catch (e) { toast('提交失败，请重试'); }
}
function openLinePanel() {
  /* v73c：采集模式也能换源了——列出所有采集站的线路 + 后台配的解析线路（解析在前）。
     以前写死 MODE!=='up' 就弹「当前播放模式不支持换源」，采集站只有第一条线可看，
     大哥在后台加了解析线路却完全用不上。 */
  if (MODE === 'collect') {
    const hasLines = PLAY && (PLAY.results || []).some(st => (st.sources || []).length);
    const hasParse = (CFG && (CFG.parseList || []).length) || (PLAY && (PLAY.parseList || []).length);
    if (!hasLines && !hasParse) { artNotice('暂无可切换的线路，请回后台添加采集站或解析线路'); return; }
    openCollectPanel();
    return;
  }
  if (MODE !== 'up' || !CUR_TOKEN) { artNotice('当前播放模式不支持换源'); return; }
  let el = $('#linePanel');
  if (!el) {
    el = document.createElement('div');
    el.id = 'linePanel';
    el.innerHTML = '<div class="lp-box">'
      + '<div class="lp-head"><div><h3>换源</h3><div class="lp-sub">自动选择 · 当前 <b id="lpCur">--</b></div></div>'
      + '<button class="lp-x" id="lpClose">✕</button></div>'
      + '<div class="lp-tabs"><button class="lp-tab" data-t="smart">智能选择</button>'
      + '<button class="lp-tab" data-t="official">官方线路 <i id="lpNOff"></i></button>'
      + '<button class="lp-tab" data-t="normal">普通线路 <i id="lpNNor"></i></button></div>'
      + '<div class="lp-body" id="lpBody"><div class="empty" style="padding:24px 0">加载中…</div></div>'
      + '<div class="lp-foot">词元用量以各线路标注及播放时的提示为准</div></div>';
    document.body.appendChild(el);
    $('#lpClose').onclick = closeLinePanel;
    el.onclick = e => { if (e.target === el) closeLinePanel(); };
    el.querySelectorAll('.lp-tab').forEach(t => t.onclick = () => { LP_TAB = t.dataset.t; renderLinePanel(); });
  }
  el.classList.remove('hidden');
  /* v59：手机端部分浏览器（华为等）把 <video> 画在独立合成层，永远压住 fixed 弹层，
     换源面板上半截（标题/页签/线路列表）会被视频盖住。弹层打开期间把视频藏起来（声音照常），关闭即恢复 */
  document.documentElement.classList.add('modal-open');
  if (!LP_DATA) loadLinePanel(); else renderLinePanel();
}
function closeLinePanel() {
  const el = $('#linePanel'); if (el) el.classList.add('hidden');
  document.documentElement.classList.remove('modal-open');
  swallowGhostTap();   /* v68b：面板关掉瞬间视频层恢复，收尾触摸会落到视频上——
                          华为等浏览器把它当视频点击/双击 → 点 X 自动进全屏。500ms 内吞掉幽灵点击 */
}
/* v68b：吞掉关闭弹层后紧跟的一次幽灵 tap（touchend+click 都拦） */
function swallowGhostTap() {
  if (window.__tapSwallow) return;
  window.__tapSwallow = true;
  const kill = e => { try { e.stopPropagation(); e.preventDefault(); } catch (x) {} };
  const opts = { capture: true, passive: false };
  document.addEventListener('touchend', kill, opts);
  document.addEventListener('click', kill, opts);
  setTimeout(() => {
    document.removeEventListener('touchend', kill, opts);
    document.removeEventListener('click', kill, opts);
    window.__tapSwallow = false;
  }, 500);
}
/* 秒 → mm:ss / h:mm:ss */
function fmtTime(s) {
  s = Math.max(0, Math.floor(s || 0));
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), x = s % 60;
  const mm = (h ? (m < 10 ? '0' + m : m) : m), ss = x < 10 ? '0' + x : x;
  return (h ? h + ':' : '') + mm + ':' + ss;
}
/* ---------- 选线面板插播标注（Task A）：每条线路异步跑 /api/ad-preview，标注「插播·约拦N段 / 无插播」 ---------- */
let ADQ = [], ADRUN = 0;
function adQueue(url) { return new Promise((res) => { ADQ.push({ url, res }); pumpAd(); }); }
function pumpAd() {
  if (ADRUN >= 4 || !ADQ.length) return;   // v55：3→4 并发，点开面板时标注更快出来
  ADRUN++;
  const job = ADQ.shift();
  (async () => {
    try { const r = await api('/api/ad-preview?url=' + encodeURIComponent(job.url)); job.res(r || {}); }
    catch (e) { job.res({ error: 1 }); }
    finally { ADRUN--; pumpAd(); }
  })();
}
function applyAdAnno(span, r) {
  const disc = (r && r.discAd) || 0;
  if (r && r.verdict === 'ad' && disc > 0) {
    const blocks = (r.adBlocks || []).map(b => fmtTime(b.startSec) + ' 约' + b.dur + 's').join('、');
    span.className = 'lp-ad bad'; span.textContent = '插播·约拦' + disc + '段';
    span.title = '检测到断点插播广告：' + blocks + (r.enabled ? '' : '（过滤当前关闭，开启后生效）');
  } else if (r && (r.verdict === 'clean' || r.verdict === 'notm3u')) {
    span.className = 'lp-ad ok'; span.textContent = '无插播'; span.title = '未检测到断点插播广告';
  } else {
    span.className = 'lp-ad'; span.textContent = '—'; span.title = '';
  }
}
async function annotateLine(el, url) {
  if (!el || !url) return;
  const span = el.querySelector('.lp-ad');
  if (!span) return;
  /* 全线路扫描已缓存结果则直接复用，避免重复打上游 */
  if (ALL_LINE_AD[url]) { applyAdAnno(span, ALL_LINE_AD[url]); return; }
  /* v55：扫描在途就等等它——最多 1.5s（warm 预扫描命中的话 300ms 内就回；
     冷门片首次扫描要 20s+，等它没意义，超时立刻走单条分析） */
  if (SCAN_P) {
    await Promise.race([SCAN_P, new Promise(r => setTimeout(r, 1500))]);
    if (ALL_LINE_AD[url]) { applyAdAnno(span, ALL_LINE_AD[url]); return; }
  }
  /* v65：单条分析 5s 超时兜底——上游/服务端忙时 ad-preview 可能长时间不回，
     手机换源面板整屏「分析中…」看起来像假死；超时显示「—」，不再无限等 */
  const r = await Promise.race([adQueue(url), new Promise(res => setTimeout(() => res({ error: 1 }), 5000))]);
  if (r && r.error) { span.className = 'lp-ad'; span.textContent = '—'; span.title = ''; return; }
  applyAdAnno(span, r);
}
async function loadLinePanel() {
  try {
    /* v55：打开面板就主动拉一次全线路标注（服务端有 5min 扫描缓存；
       warm 预扫描过的基本秒回）——以前只靠起播后 2s 的异步扫描，
       用户快速点开面板时满屏「分析中…」 */
    if (MODE === 'up' && CUR_TOKEN) scanAllLinesBg(CUR_TOKEN, TITLE);
    /* debug=1：服务端已做拉黑过滤+官方优先排序，lines 顺序即 skip 索引；
       且 resolve 本身有缓存，此请求近零开销 */
    const r = await api('/api/up/resolve?token=' + encodeURIComponent(CUR_TOKEN) + '&debug=1');
    LP_DATA = (r && r.lines) ? r : { lines: [] };
  } catch (e) { LP_DATA = { lines: [] }; }
  renderLinePanel();
}
function switchLine(idx) {
  closeLinePanel();
  if (MODE !== 'up' || !CUR_TOKEN) return;
  LINE_SKIP = idx; AUTO_SW = 0;
  /* v53：同 autoNextLine——延后到事件栈外再重建播放器，规避旧实例回调竞态 */
  setTimeout(() => playUpToken(CUR_TOKEN), 0);
}
function renderLinePanel() {
  if (!$('#linePanel')) return;
  $('#lpCur').textContent = CUR_LABEL || '--';
  const L = (LP_DATA && LP_DATA.lines) || [];
  const offs = L.map((x, i) => ({ ...x, i })).filter(x => x.official);
  const nors = L.map((x, i) => ({ ...x, i })).filter(x => !x.official);
  $('#lpNOff').textContent = '(' + offs.length + ')';
  $('#lpNNor').textContent = '(' + nors.length + ')';
  document.querySelectorAll('#linePanel .lp-tab').forEach(t => t.classList.toggle('active', t.dataset.t === LP_TAB));
  const body = $('#lpBody');
  if (LP_TAB === 'smart') {
    body.innerHTML = '<div class="lp-cur"><div class="lp-name">' + esc(CUR_LABEL || '--') + '</div>'
      + '<div class="lp-tag' + (CUR_OFFICIAL ? '' : ' off') + '">' + (CUR_OFFICIAL ? '官方线路' : '普通线路') + '</div>'
      + '<span class="lp-ad">分析中…</span></div>'
      + '<div class="lp-desc">智能选择：官方线路优先，播放失败自动顺延下一条（最多 3 次）。<br>声音 / 画面异常时，切一条其他线路通常立即恢复。</div>'
      + '<button class="btn primary" id="lpRe" style="width:100%;margin-top:14px">重新选择</button>'
      + '<button class="btn" id="lpRepCur" style="width:100%;margin-top:10px">⚠ 反馈当前线路漏网广告</button>';
    $('#lpRe').onclick = () => switchLine(0);
    $('#lpRepCur').onclick = () => reportMissedAd(CUR_LABEL, CUR_PLAY_URL || '', '');
    const curLine = L.find(x => x.label === CUR_LABEL);
    if (curLine) annotateLine(body.querySelector('.lp-cur'), curLine.url);
    return;
  }
  const list = LP_TAB === 'official' ? offs : nors;
  if (!list.length) { body.innerHTML = '<div class="empty" style="padding:24px 0">无该类线路</div>'; return; }
  body.innerHTML = '<div class="lp-grid">' + list.map(x =>
    '<div class="lp-cell" data-i="' + x.i + '">'
    + '<button class="lp-item' + (x.label === CUR_LABEL ? ' cur' : '') + (x.selected ? ' rec' : '') + '" data-i="' + x.i + '">'
    + esc(x.label) + (x.selected ? '<em class="rc">推荐</em>' : (x.official ? '<em>官方</em>' : '')) + '<span class="lp-ad">分析中…</span></button>'
    + '<button class="lp-rep" title="反馈漏网广告" data-label="' + esc(x.label) + '" data-url="' + esc(x.url || '') + '">⚠漏报</button>'
    + '</div>').join('') + '</div>';
  body.querySelectorAll('.lp-item').forEach(b => { b.onclick = () => switchLine(+b.dataset.i); });
  body.querySelectorAll('.lp-rep').forEach(b => { b.onclick = (ev) => { ev.stopPropagation(); reportMissedAd(b.dataset.label, b.dataset.url, ''); }; });
  /* x.i 是全量数组 L 的下标（供 switchLine 用），这里用 x 本身拿 url，避免按 L 下标错取过滤数组 */
  list.forEach(x => { const b = body.querySelector('.lp-item[data-i="' + x.i + '"]'); if (b) annotateLine(b, x.url); });
}

/* ========== v73c：采集模式换源面板（解析线路优先） ==========
   大哥的需求：后台配的解析线路要能用，且「优先走解析线路，播放失效再换采集线路」。
   面板两个页签：解析线路（有配置时默认选中）/ 采集线路（各站 × 各 from，可跨站切换）。 */
let LP_C = null, LP_C_TAB = '';
function collectPanelData() {
  const parse = (((CFG && CFG.parseList) || (PLAY && PLAY.parseList) || []))
    .map(p => ({ label: (p && p.name) || '解析线路', url: (p && p.url) || '' })).filter(p => p.url);
  const lines = [];
  ((PLAY && PLAY.results) || []).forEach(st => (st.sources || []).forEach(src => {
    const eps = (src.episodes || []).filter(e => e && e.url);
    if (eps.length) lines.push({ label: (st.station || '采集站') + ' · ' + (src.from || '线路'), episodes: eps });
  }));
  return { parse: parse, lines: lines };
}
function openCollectPanel() {
  LP_C = collectPanelData();
  LP_C_TAB = LP_C.parse.length ? 'parse' : 'collect';
  let el = $('#linePanel');
  if (!el) {
    el = document.createElement('div');
    el.id = 'linePanel';
    document.body.appendChild(el);
  }
  el.innerHTML = '<div class="lp-box">'
    + '<div class="lp-head"><div><h3>换源</h3><div class="lp-sub">当前 <b id="lpCur">' + esc(CUR_LABEL || '采集线路') + '</b></div></div>'
    + '<button class="lp-x" id="lpClose">✕</button></div>'
    + '<div class="lp-tabs">'
    + (LP_C.parse.length ? '<button class="lp-tab" data-t="parse">解析线路 <i>(' + LP_C.parse.length + ')</i></button>' : '')
    + '<button class="lp-tab" data-t="collect">采集线路 <i>(' + LP_C.lines.length + ')</i></button></div>'
    + '<div class="lp-body" id="lpBody"></div>'
    + '<div class="lp-foot">' + (LP_C.parse.length
        ? '解析线路优先：先走网页解析，失效或弹广告时换「采集线路」直连'
        : '采集线路为站方直连；在后台配置解析线路后可优先走解析') + '</div></div>';
  el.classList.remove('hidden');
  document.documentElement.classList.add('modal-open');
  $('#lpClose').onclick = closeLinePanel;
  el.onclick = e => { if (e.target === el) closeLinePanel(); };
  el.querySelectorAll('.lp-tab').forEach(t => t.onclick = () => { LP_C_TAB = t.dataset.t; renderCollectPanel(); });
  renderCollectPanel();
}
function renderCollectPanel() {
  document.querySelectorAll('#linePanel .lp-tab').forEach(t => t.classList.toggle('active', t.dataset.t === LP_C_TAB));
  const body = $('#lpBody'); if (!body) return;
  if (LP_C_TAB === 'parse') {
    if (!LP_C.parse.length) { body.innerHTML = '<div class="empty" style="padding:24px 0">未配置解析线路</div>'; return; }
    body.innerHTML = '<div class="lp-desc" style="padding:0 2px 10px">用网页解析器播放当前这一集。解析失效/弹广告时，请换「采集线路」直连 m3u8。</div>'
      + '<div class="lp-grid">' + LP_C.parse.map((p, i) =>
        '<div class="lp-cell"><button class="lp-item" data-pi="' + i + '">' + esc(p.label) + '<em>解析</em></button></div>').join('') + '</div>';
    body.querySelectorAll('.lp-item').forEach(b => { b.onclick = () => useCollectParse(+b.dataset.pi); });
    return;
  }
  if (!LP_C.lines.length) { body.innerHTML = '<div class="empty" style="padding:24px 0">无采集线路（回后台添加采集站）</div>'; return; }
  body.innerHTML = '<div class="lp-grid">' + LP_C.lines.map((x, i) =>
    '<div class="lp-cell"><button class="lp-item' + (x.label === CUR_LABEL ? ' cur' : '') + '" data-i="' + i + '">'
    + esc(x.label) + '<span class="lp-ad">' + x.episodes.length + ' 集</span></button></div>').join('') + '</div>';
  body.querySelectorAll('.lp-item').forEach(b => { b.onclick = () => switchCollectLine(+b.dataset.i); });
}
/* 跨站换线：整条 EP_LIST 换成目标站的分集，当前集序号就近对齐后继续播 */
function switchCollectLine(i) {
  const ln = LP_C && LP_C.lines[i]; if (!ln) return;
  closeLinePanel();
  if (ln.label === CUR_LABEL) { toast('已在当前线路'); return; }
  CUR_LABEL = ln.label; updateLineLabel();
  EP_LIST = ln.episodes.map((ep, i2) => ({ name: ep.name || ('第 ' + (i2 + 1) + ' 集'), url: ep.url, idx: i2 }));
  META.epTotal = EP_LIST.length;
  paintEps(EP_LIST.map((ep, i2) => ({ ep: ep, i: i2 })));
  const keep = Math.min(Math.max(EP_IDX, 0), EP_LIST.length - 1);
  if (EP_LIST.length) selectEp(keep);
  toast('已切换到 ' + CUR_LABEL);
}
/* 用解析线路播放当前集（包一层网页解析器） */
function useCollectParse(pi) {
  const p = LP_C && LP_C.parse[pi]; if (!p) return;
  closeLinePanel();
  const ep = EP_LIST[EP_IDX] || EP_LIST[0];
  if (!ep) { artNotice('当前没有可播放的集'); return; }
  CUR_LABEL = p.label; updateLineLabel();
  playFrame(wrapParse(p.url, ep.url));
  toast('已用解析线路播放：' + p.label);
}
function stepEp(d) {
  const i = EP_IDX + d;
  if (i < 0) { artNotice('已经是第一集'); return; }
  if (i >= EP_LIST.length) { artNotice('已经是最后一集'); return; }
  selectEp(i);
}
function selectEp(i) {
  if (i < 0 || i >= EP_LIST.length) return;
  EP_IDX = i;
  /* 当前集若不在本页，跳到所在页再高亮 */
  if (epsPageOf(i) !== epsPage) { epsPage = epsPageOf(i); repaintEps(); }
  else document.querySelectorAll('#eps .ep').forEach(x => x.classList.toggle('active', +x.dataset.i === i));
  const ep = EP_LIST[i];
  META.epTotal = EP_LIST.length;
  pushHist(true);                       // 切集即落一次「继续观看」
  /* v69c：第二个参数 1 = 这是「换集」不是「换线路」。
     老代码里 selectEp 先把 CUR_TOKEN 改成新集 token 再调 playUpToken，
     导致 playUpToken 里「token===CUR_TOKEN → 记住当前进度续播」被误判成换线，
     把上一集的播放进度当成续播位置带进新集 —— 你快进到第二集结尾，
     第三集一上来就被播到自己的片尾，连锁跳集就是这么来的 */
  if (MODE === 'up') { CUR_TOKEN = ep.token; LINE_SKIP = 0; AUTO_SW = 0; EP_FAIL_BUDGET = 5; playUpToken(ep.token, 1); }
  else playEpisode(ep.url);
  updateEpNav();
}
function updateEpNav() {
  const ps = document.querySelector('#speedbar .pnav.prev'), nx = document.querySelector('#speedbar .pnav.next');
  if (ps) ps.disabled = EP_IDX <= 0;
  if (nx) nx.disabled = EP_IDX >= EP_LIST.length - 1;
}
/* v49：ended 事件不一定是真的播完了——线路异常/清单被截断/解码器重置时，
   浏览器会在播了几秒后抛一个「假 ended」。老逻辑一收到 ended 就自动连播下一集，
   于是每一集都只播 3 秒就被切走，看起来就是「反复重新开始」（手机端尤其明显）。
   这里加合理性校验：播不满 30 秒（或总时长明显不对）就当异常中断，
   改为换线路重试当前集，绝不连播下一集。 */
let _endAbn = { n: 0, at: 0, ep: -1 };
let _lastEndedAt = 0;   /* v68b：事件+轮询双路径去重 */
function onEnded() {
  if (Date.now() - _lastEndedAt < 3000) return;
  _lastEndedAt = Date.now();
  const v = (ART && ART.video) ? ART.video : null;
  const t = v ? (v.currentTime || 0) : 0;
  const dur = (v && isFinite(v.duration)) ? v.duration : 0;
  /* v68c：真·结尾判定——必须播到总时长附近才算播完。
     08:35 大哥反馈「一到最后就自动跳下一集、没法正常看」：ad 过滤过的超长清单
     （实测红牛资源 line 切片 3971）会让 hls.js 提前抛 ended——t 才几百秒、dur 两千多秒，
     旧判定「t>=30 就算播完」把每一集都误判成播完 → 一路狂切下一集。
     现在：dur 不可信（0）或没播到 dur-15s 以内，一律按异常中断处理（换线路重试本集，不连播） */
  const nearEnd = dur > 0 && t >= dur - 45;
  const suspicious = !nearEnd;
  if (nearEnd && seekJustHappened()) {
    /* 用户自己拖到结尾 —— 不是自然看完，不自动连播，给出按钮交给用户 */
    reportLog('info', 'play', '快进到结尾，停在末尾等待操作（不自动连播）t=' + t.toFixed(1) + '/' + (dur ? dur.toFixed(1) : '?'), 'ep=' + EP_IDX);
    endStopUI();
    return;
  }
  if (suspicious && t < 30) {
    /* 刚起播就停 = 真故障（线路/清单坏了）→ 换线路重试本集 */
    const now = Date.now();
    if (_endAbn.ep === EP_IDX && now - _endAbn.at < 60000) _endAbn.n++; else { _endAbn.n = 1; _endAbn.ep = EP_IDX; }
    _endAbn.at = now;
    reportLog('warn', 'play', '异常中断：仅播放 ' + t.toFixed(1) + 's / 总长 ' + (dur ? dur.toFixed(1) : '?') + 's（第 ' + _endAbn.n + ' 次）线路=' + (CUR_LABEL || ''), 'ep=' + EP_IDX);
    /* 用「同一集异常中断次数」当上限（<=3），不靠 AUTO_SW——换线路径里它会被清零，
       否则源本身有问题时会无限重试，又变成新的死循环 */
    if (_endAbn.n <= 3) { autoNextLine('播放异常中断（仅播了 ' + Math.round(t) + ' 秒）'); return; }
    finalFailUI('播放异常中断，已试多条线路');
    return;
  }
  if (suspicious) {
    /* 播了一段时间后「提前停」但远没到片尾：多半是片源清单不完整/被过滤，
       此时既不该自动跳下一集（用户还没看完），也不该自动换线（新一轮又从头折腾）。
       停下来给明确按钮，交给用户决定 */
    reportLog('warn', 'play', '播放提前停止（疑似片源不完整）：t=' + t.toFixed(1) + ' / dur=' + (dur ? dur.toFixed(1) : '?') + ' 线路=' + (CUR_LABEL || ''), 'ep=' + EP_IDX);
    midStopUI(t, dur);
    return;
  }
  /* v69c：新集刚起就「已在片尾」＝进度/时长被异常拉满（续播位置越界被钳、清单时长串了）。
     这种绝不是真的看完，绝不能连播，否则就是一集接一集空跳（9:41 ep2→ep3→ep4 连环） */
  if (nearEnd && Date.now() - _epStartAt < 10000) {
    reportLog('warn', 'play', '新集一上来就在片尾（进度/时长异常）→ 停手不连播 t=' + t.toFixed(1) + '/' + (dur ? dur.toFixed(1) : '?') + 's 线路=' + (CUR_LABEL || ''), 'ep=' + EP_IDX);
    endStopUI();
    return;
  }
  _endAbn = { n: 0, at: 0, ep: -1 };
  if (EP_IDX < EP_LIST.length - 1) {
    reportLog('info', 'play', '自动连播下一集 ep=' + (EP_IDX + 1) + '（上一集播到 ' + t.toFixed(1) + '/' + (dur ? dur.toFixed(1) : '?') + 's）线路=' + (CUR_LABEL || ''));
    toast('自动连播下一集 ▶'); selectEp(EP_IDX + 1);
  }
  else { toast('播放结束 🎉'); pushHist(true); }
}

/* 继续观看 / 收藏 同步 */
function maybePushHist() {
  const now = Date.now();
  if (now - lastHistPush < 10000) return;
  pushHist(false);
}
/* v37：「播放历史」写成功后回头刷新侧栏，不必刷新页面才看到（节流 8s，切集/首播立即刷新） */
let lastSideSync = 0, histPushedOnce = false;
function syncSideThrottled(force) {
  const now = Date.now();
  if (!force && now - lastSideSync < 8000) return;
  lastSideSync = now;
  loadSideWidgets();
}
function pushHist(force) {
  if (!TOKEN || !META.id) return;
  if (!viewCan('history')) return;   /* v47：没开「历史记录」就别白跑一趟，服务端也会忽略 */
  const now = Date.now();
  if (!force && now - lastHistPush < 10000) return;
  lastHistPush = now;
  const first = !histPushedOnce; histPushedOnce = true;
  const pos = (ART && ART.video) ? Math.round(ART.video.currentTime || 0) : 0;
  const dur = (ART && ART.video && ART.video.duration) ? Math.round(ART.video.duration || 0) : 0;
  fetch('/api/history', {
    method: 'POST', headers: { 'Authorization': 'Bearer ' + TOKEN, 'Content-Type': 'application/json' },
    body: JSON.stringify({ id: META.id, title: META.title || TITLE, poster: META.poster || POSTER, year: META.year || YEAR, ep: EP_IDX, epTotal: EP_LIST.length, pos, dur })
  }).then(() => { syncSideThrottled(force || first); }).catch(() => {});
}
async function syncFavState() {
  if (!TOKEN || !META.id) return;
  applyFavPermUI();
  if (!viewCan('fav')) { favOn = false; updateFavBtn(); return; }
  try { const j = await api('/api/fav'); favOn = (j.items || []).some(x => x.id === META.id); updateFavBtn(); } catch (e) {}
}
/* v47：没开放「我的收藏」就把顶栏收藏按钮 + 手机端快捷栏那一项直接藏掉，
   别让用户点完了才发现用不了（服务端写入也已经一并 403 拦截） */
function applyFavPermUI() {
  const ok = viewCan('fav');
  const b = $('#pFav'); if (b) b.style.display = ok ? '' : 'none';
  const f = $('#mQkFav'); if (f) f.style.display = ok ? '' : 'none';
}
function updateFavBtn() {
  applyFavPermUI();
  const b = $('#pFav'); if (!b) return;
  b.classList.toggle('on', favOn);
  b.textContent = favOn ? '★ 已收藏' : '☆ 收藏';
  if (typeof updateQuickFav === 'function') updateQuickFav();   /* 手机端快捷栏同步 */
}
async function toggleFav() {
  if (!TOKEN) { toast('请先登录'); return; }
  if (!META.id) { toast('信息不足，无法收藏'); return; }
  if (!viewCan('fav')) { applyFavPermUI(); toast('🔒 管理员未对你的账号开放「我的收藏」'); return; }
  try {
    const r = await fetch('/api/fav', {
      method: 'POST', headers: { 'Authorization': 'Bearer ' + TOKEN, 'Content-Type': 'application/json' },
      body: JSON.stringify(favOn ? { del: META.id } : { add: { id: META.id, title: META.title || TITLE, poster: META.poster || POSTER, year: META.year || YEAR } })
    });
    const j = await r.json().catch(() => ({}));
    if (r.status === 403) { toast('🔒 ' + (j.error || '管理员未对你的账号开放「我的收藏」')); applyFavPermUI(); return; }
    favOn = !!j.on; updateFavBtn();
    loadSideWidgets();   /* 侧栏「我的收藏」即时增减，不用刷新 */
    toast(favOn ? '已加入收藏 ★' : '已取消收藏');
  } catch (e) { toast('操作失败'); }
}

/* 左上角品牌位：动态显示当前播放片名 */
function setBrandTitle(t) {
  const b = $('#pBrand');
  if (b && b.childNodes[0]) b.childNodes[0].nodeValue = t || '';
}

/* ========== 详情渲染 ========== */
function renderDetail(d) {
  const title = d.title || d.normalized_title || TITLE;
  META.title = title; $('#ptitle').textContent = title;
  updateLineLabel();   /* v67：片名就位后刷新「当前播放线路源: 线路 片名」 */
  META.kind = String(d.content_kind || '').toLowerCase();   // movie=电影（不启用跳片头）
  setBrandTitle(title);
  META.backdrop = d.backdrop_url || d.poster_url || META.backdrop || '';
  const meta = [];
  const KIND_CN = { series: '剧集', movie: '电影', variety: '综艺', anime: '动漫', documentary: '纪录片', tv: '剧集', film: '电影' };
  if (d.content_kind) meta.push(KIND_CN[String(d.content_kind).toLowerCase()] || d.content_kind);
  if (d.year) meta.push(d.year);
  if (d.area) meta.push(d.area);
  if (d.language) meta.push(d.language);
  /* v62：类型长标签不再放标题下（太占地方）；类型仍在右侧信息卡「类型」一行 */
  $('#pmeta').innerHTML = meta.map(x => `<span class="mt">${esc(x)}</span>`).join('');
  const desc = d.description || '';
  const rmk = d.remarks || '';
  $('#pDesc').innerHTML = desc ? `<p>${esc(desc)}</p>` : '<p class="muted">暂无简介</p>';
  bindDescToggle();
  /* 更新进度（如「更新至288集 / 共338集」）单独展示在右栏「选集」标题上方，不挤在简介里 */
  const er = $('#epRmk');
  if (er) {
    if (rmk && rmk !== desc) { er.textContent = rmk; er.classList.remove('hidden'); }
    else { er.textContent = ''; er.classList.add('hidden'); }
  }
  const dirs = Array.isArray(d.directors) ? d.directors : [];
  const acts = Array.isArray(d.actors) ? d.actors : [];
  let ph = '';
  if (dirs.length) ph += `<div class="pl"><b>导演</b>${dirs.map(x => `<span class="pc">${esc(x)}</span>`).join('')}</div>`;
  if (acts.length) ph += `<div class="pl"><b>主演</b>${acts.slice(0, 16).map(x => `<span class="pc">${esc(x)}</span>`).join('')}</div>`;
  $('#pActors').innerHTML = ph || '<div class="pl muted">暂无演职员信息</div>';
  buildDiscover(d);
  // 侧栏海报  $('#sidePoster').innerHTML = posterImg(d.backdrop_url || d.poster_url || POSTER);
  // 侧栏信息卡
  const rows = [];
  if (d.rating != null || d.score != null) rows.push(['评分', `<span class="sc-rate">${esc(d.rating != null ? d.rating : d.score)}</span>`]);
  if (d.year) rows.push(['年份', esc(d.year)]);
  if (d.area) rows.push(['地区', esc(d.area)]);
  if (d.language) rows.push(['语言', esc(d.language)]);
  if (Array.isArray(d.genres) && d.genres.length) rows.push(['类型', esc(d.genres.join(' / '))]);
  if (d.episode_count) rows.push(['集数', esc(d.episode_count + (d.season_count ? '（' + d.season_count + '季）' : ''))]);
  $('#sideDetail').innerHTML = rows.length
    ? rows.map(([k, v]) => `<div class="sc-row"><span class="sc-k">${k}</span><span class="sc-v">${v}</span></div>`).join('')
    : '<div class="muted" style="font-size:13px">暂无更多信息</div>';
}

/* v62：简介超长折叠（默认最多 7 行），只有真溢出才出现「展开全部/收起」。
   手机端不启用——手机已有「剧情简介/演职员」整段折叠，两套折叠叠一起反而乱 */
function bindDescToggle() {
  const box = $('#pDesc'); if (!box) return;
  const p = box.querySelector('p');
  let btn = box.querySelector('.desc-more');
  if (window.IS_MOBILE) { box.classList.remove('clamped'); if (btn) { btn.style.display = 'none'; btn.onclick = null; } return; }
  if (!p) { box.classList.remove('clamped'); if (btn) btn.style.display = 'none'; return; }
  if (!btn) { btn = document.createElement('button'); btn.className = 'desc-more'; btn.type = 'button'; box.appendChild(btn); }
  const setClamp = (on) => {
    box.classList.toggle('clamped', on);
    btn.textContent = on ? '展开全部 ▾' : '收起 ▴';
  };
  setClamp(true);
  const need = p.scrollHeight > p.clientHeight + 4;   /* clamp 状态下量溢出 */
  if (!need) { box.classList.remove('clamped'); btn.style.display = 'none'; btn.onclick = null; return; }
  btn.style.display = '';
  btn.onclick = () => {
    const willOpen = box.classList.contains('clamped');
    setClamp(!willOpen);
  };
}

/* ========== v61：继续发现（照上游的样子）+ 简介/发现 同位轮播 ==========   - 芯片完全由当前播放内容的 演员/导演/类型 自动生成，点击跳 /index.html?q= 直达搜索
   - 电脑端：简介块 和 继续发现 每 10 秒轮换，鼠标悬停暂停、移开继续
   - 手机端：不做轮播，保持原来的简介常驻 */
let ROT_MS = 10000;    /* v63：后台「其他设置」可改（秒 → ms），3~120 秒 */
let rotTimer = null, rotIdx = 0, ROT_SLIDES = 2;
/* 应用后台「其他设置」：轮播间隔 + 加载卡文案（文案是每次渲染时按 pt() 现取的，这里只重刷已存在的卡） */
function applyMisc() {
  const m = (CFG && CFG.misc) || {};
  const sec = Math.min(120, Math.max(3, parseInt(m.rotMs, 10) || 10));
  ROT_MS = sec * 1000;
  applyCardTexts();
  if (rotTimer) startDiscoverRotate();   /* 间隔变了就用新间隔重新起表 */
}
function stopDiscoverRotate() { if (rotTimer) { clearInterval(rotTimer); rotTimer = null; } }
function showRotSlide(i) {
  const a = $('#pSlideInfo'), b = $('#pSlideDiscover'), dots = $('#pRotDots');
  if (!a || !b) return;
  rotIdx = ((i % ROT_SLIDES) + ROT_SLIDES) % ROT_SLIDES;
  a.classList.toggle('hidden', rotIdx !== 0);
  b.classList.toggle('hidden', rotIdx !== 1);
  if (dots) Array.from(dots.children).forEach((d, k) => d.classList.toggle('on', k === rotIdx));
}
function startDiscoverRotate() {
  stopDiscoverRotate();
  const box = $('#pRot');
  if (!box || window.IS_MOBILE) return;
  if (ROT_SLIDES < 2) { showRotSlide(0); return; }
  rotTimer = setInterval(() => showRotSlide(rotIdx + 1), ROT_MS);
}
function buildDiscover(d) {
  const box = $('#discChips'), slide = $('#pSlideDiscover'), dots = $('#pRotDots');
  if (!box || !slide) return;
  const dirs = Array.isArray(d.directors) ? d.directors.filter(Boolean) : [];
  const acts = Array.isArray(d.actors) ? d.actors.filter(Boolean) : [];
  const gen = Array.isArray(d.genres) ? d.genres.filter(Boolean) : [];
  const chips = [];
  const simQ = gen.slice(0, 2).join(' ') || (d.area || '') + ' ' + (d.year || '');
  if (simQ.trim()) chips.push({ ico: '🔎', txt: '找类似这部', q: simQ.trim() });
  acts.slice(0, 4).forEach(a => chips.push({ ico: '👤', txt: a + '作品', q: a }));
  dirs.slice(0, 2).forEach(x => chips.push({ ico: '🎬', txt: x + '导演作品', q: x }));
  gen.slice(0, 2).forEach(g => chips.push({ ico: '🔥', txt: g + '热播', q: g }));
  const list = chips.slice(0, 8);
  if (!list.length) {           /* 没有任何可用信息就不轮播，只显示简介 */
    slide.classList.add('hidden');
    if (dots) dots.classList.add('hidden');
    ROT_SLIDES = 1; stopDiscoverRotate(); showRotSlide(0);
    return;
  }
  ROT_SLIDES = 2;
  if (dots) dots.classList.remove('hidden');
  box.innerHTML = list.map(c =>
    `<button class="disc-chip" data-q="${esc(c.q)}"><span class="di">${c.ico}</span><span class="dl">${esc(c.txt)}</span></button>`).join('');
  box.querySelectorAll('.disc-chip').forEach(b => {
    b.onclick = () => { stopDiscoverRotate(); location.href = '/index.html?q=' + encodeURIComponent(b.dataset.q); };
  });
  /* 重新渲染后从简介那页重新开始计时，避免刚换到发现页又被定时器切走 */
  if (window.IS_MOBILE) { slide.classList.add('hidden'); if (dots) dots.classList.add('hidden'); showRotSlide(0); return; }
  showRotSlide(0);
  startDiscoverRotate();
}
(function bindRotHover() {
  const box = $('#pRot');
  if (!box) return;
  box.addEventListener('mouseenter', () => { if (window.IS_MOBILE) return; stopDiscoverRotate(); });
  box.addEventListener('mouseleave', () => { if (window.IS_MOBILE) return; if (ROT_SLIDES > 1) startDiscoverRotate(); });
})();

/* ========== 选集网格 + 分季切换 + 分页 + 收纳 ========== */
/* 上游每页 48 集的历史问题已在服务端合并全部页，这里分页浏览。
   v33：工具条（上一页/页码/下一页/收纳）常驻选集区顶部——原来在按钮堆的底部根本看不见
   v34：每页 48 → 20（5 列 × 4 行），长剧集默认收纳感更强 */
let epsPage = 0;
let epsFolded = false;
/* v35：手机 12 集（4 列 × 3 行，格子更大好点），电脑维持 20 集（5 列 × 4 行）。
   分页/收纳/页码逻辑两端完全一致，只是每页数量不同。 */
let EPS_PAGE_N = (window.IS_MOBILE ? 12 : 20);
/* 旋屏或判定切换时按新的每页数量重绘选集 */
window.addEventListener('mobchange', () => {
  EPS_PAGE_N = window.IS_MOBILE ? 12 : 20;
  epsPage = 0;
  repaintEps();
});
let CUR_EPS_LIST = [];
function epsPageOf(i) { return Math.floor(i / EPS_PAGE_N); }
function repaintEps() { if (CUR_EPS_LIST.length) paintEps(CUR_EPS_LIST); }
function paintEps(list) {
  CUR_EPS_LIST = list;
  const box = $('#eps'), bar = $('#epsBar');
  if (!bar || !box) return;
  box.innerHTML = '';
  if (!list.length) { bar.innerHTML = ''; box.innerHTML = '<div class="empty">暂无分集数据</div>'; return; }
  const pages = Math.max(1, Math.ceil(list.length / EPS_PAGE_N));
  if (epsPage < 0) epsPage = 0;
  if (epsPage >= pages) epsPage = pages - 1;
  /* 顶部工具条：上一页 / 页码 / 下一页 / 收纳（收纳只藏网格，页码条保持可见） */
  bar.innerHTML = '<button class="ep-pn" data-d="-1"' + (epsPage <= 0 ? ' disabled' : '') + '>‹ 上一页</button>'
    + '<span class="ep-pg">第 ' + (epsPage + 1) + ' / ' + pages + ' 页 · 共 ' + list.length + ' 集</span>'
    + '<button class="ep-pn" data-d="1"' + (epsPage >= pages - 1 ? ' disabled' : '') + '>下一页 ›</button>'
    + '<button class="ep-fold" id="epsFold">' + (epsFolded ? '展开 ▾' : '收纳 ▴') + '</button>';
  bar.querySelectorAll('.ep-pn').forEach(b => {
    b.onclick = () => { if (b.disabled) return; epsPage += Number(b.dataset.d); paintEps(list); };
  });
  const fold = bar.querySelector('#epsFold');
  if (fold) fold.onclick = () => { epsFolded = !epsFolded; paintEps(list); };
  box.style.display = epsFolded ? 'none' : '';
  if (epsFolded) return;
  const start = epsPage * EPS_PAGE_N;
  list.slice(start, start + EPS_PAGE_N).forEach(({ ep, i }) => {
    const e = document.createElement('button');
    e.className = 'ep' + (i === EP_IDX ? ' active' : '');
    e.dataset.i = i;
    e.title = ep.name || ep.title || ('第 ' + (i + 1) + ' 集');
    e.textContent = (i + 1);
    e.onclick = () => selectEp(i);
    box.appendChild(e);
  });
}
function buildSeasons(eps) {
  const groups = {};
  eps.forEach((ep, i) => {
    const s = (ep.season != null) ? ep.season : (ep.season_index != null ? ep.season_index : 1);
    (groups[s] = groups[s] || []).push({ ep, i });
  });
  const keys = Object.keys(groups).map(Number).sort((a, b) => a - b);
  const se = $('#seasons'); se.innerHTML = '';
  /* v33：定位到当前集所在页（续播到第 60 集时直接落在第 2 页） */
  epsPage = epsPageOf(Math.max(0, Math.min(EP_IDX, eps.length - 1)));
  if (keys.length > 1) {
    se.style.display = 'flex';
    keys.forEach((k, ki) => {
      const b = document.createElement('button');
      b.className = 'season' + (ki === 0 ? ' active' : '');
      b.textContent = '第 ' + k + ' 季';
      b.onclick = () => {
        se.querySelectorAll('.season').forEach(x => x.classList.remove('active'));
        b.classList.add('active');
        epsPage = 0;
        paintEps(groups[k]);
      };
      se.appendChild(b);
    });
    paintEps(groups[keys[0]]);
  } else {
    se.style.display = 'none';
    paintEps(eps.map((ep, i) => ({ ep, i })));
  }
}

/* ========== 猜你喜欢 ========== */
/* 读取 grid 实际列数（响应式：宽屏 8 列 / 中屏 4 列 / 窄屏 2 列） */
function recCols() {
  const g = $('#rec'); if (!g) return 4;
  try { const t = getComputedStyle(g).gridTemplateColumns || ''; const n = t.split(' ').filter(Boolean).length; return n > 0 ? n : 4; } catch (e) { return 4; }
}
/* 播放页左侧广告位是否正处于展示状态 */
function sideAdOn() { const el = $('#sideAd'); return !!el && !el.classList.contains('hidden'); }
/* 开广告时左栏变高、中列多出空白 → 猜你喜欢多排(16张/2排)填满；关广告保持原有 1 排(8张) */
function recLimit() { return sideAdOn() ? 16 : 8; }
let REC_SHOWN = 0;
/* 补齐/撤销占位海报：检测到左侧广告开启时把最后一行不满的空位补上，保证底部左右对齐；
   关闭广告时撤掉占位，恢复原有样式。loadRec 渲染后与 loadSideAd 状态变化时都会调用 */
function repadRec() {
  const box = $('#rec'); if (!box) return;
  box.querySelectorAll('.rec-ph').forEach(x => x.remove());
  if (!REC_SHOWN || !sideAdOn()) return;
  const cols = recCols();
  const pad = (cols - (REC_SHOWN % cols)) % cols;
  for (let i = 0; i < pad; i++) {
    const d = document.createElement('div');
    d.className = 'rec-card rec-ph';
    d.innerHTML = '<span class="rp-wrap"><i class="rp-ph">🎬</i></span><div class="rt muted">更多影片<br>敬请期待</div>';
    box.appendChild(d);
  }
}
async function loadRec() {
  const box = $('#rec'); if (!box) return;
  box.innerHTML = '<div class="empty" style="padding:16px 0">加载中…</div>';
  try {
    const j = await api('/api/up/feed');
    const cards = [];
    (j.sections || []).forEach(s => (s.cards || s.items || []).forEach(c => cards.push(c)));
    if (!cards.length) { box.innerHTML = '<div class="empty" style="padding:16px 0">暂无推荐</div>'; REC_SHOWN = 0; return; }
    box.innerHTML = '';
    const show = cards.slice(0, recLimit());
    show.forEach(c => {
      const id = c.id || '';
      const poster = c.poster_url || c.poster || '';
      const t = c.title || c.name || '';
      const a = document.createElement('a');
      a.className = 'rec-card';
      a.href = `player.html?src=up&id=${encodeURIComponent(id)}&title=${encodeURIComponent(t)}&poster=${encodeURIComponent(poster)}`;
      /* 海报先垫占位层，加载失败只隐藏 img → 露出占位，绝不留空白；标题靠底对齐 */
      a.innerHTML = `<span class="rp-wrap"><i class="rp-ph">🎬</i><img class="rp" loading="lazy" decoding="async" src="${img(poster)}" onerror="this.style.display='none'" alt=""></span><div class="rt">${esc(t)}</div>`;
      box.appendChild(a);
    });
    REC_SHOWN = show.length;
    repadRec();
  } catch (e) { box.innerHTML = '<div class="empty" style="padding:16px 0">推荐获取失败</div>'; }
}

/* ========== 上游资源库模式 (src=up) ========== */
function epToken(ep) { return ep.token || ep.playback_token || ''; }
function epName(ep, i) { return ep.title || ep.name || ep.episode_title || ('第 ' + (i + 1) + ' 集'); }
function withTimeout(p, ms) { return Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), ms))]); }
/* 自动换线：解析失败/超时/播放错误时跳下一条，最多 3 次，用完提示手动换 */
let SWAP_LOCK = 0;    /* v52：4s 换线互斥锁——18:08 日志里同一秒连出 1/3、2/3、3/3 三条换线，
                         是超时/看门狗/体检多路同时触发 autoNextLine 叠加，把 LINE_SKIP 一口气推满 */
function autoNextLine(reason) {
  if (Date.now() < SWAP_LOCK) { console.warn('[swap] 锁内忽略重复换线: ' + reason); return false; }
  SWAP_LOCK = Date.now() + 4000;
  if (MODE === 'up' && CUR_TOKEN && AUTO_SW < 3) {
    if (--EP_FAIL_BUDGET <= 0) { finalFailUI(reason); return false; }   /* v68：预算用完出终局 UI，不再无限循环 */
    AUTO_SW++; LINE_SKIP++;
    reportLog('warn', 'lineswap', '自动换线 ' + AUTO_SW + '/3 原因=' + reason + ' 旧线路=' + (CUR_LABEL || ''));
    artNotice(reason + '，自动换线 ' + AUTO_SW + '/3');
    /* v53：延后到当前事件栈外再换线——hls 的 error 是在 emit 栈里同步回调的，
       在栈内直接 new Artplayer 会让旧实例的迟到回调访问已销毁 DOM（$parent null 竞态） */
    setTimeout(() => playUpToken(CUR_TOKEN), 0);
    return true;
  }
  finalFailUI(reason);
  return false;
}
/* v68：起播反复失败的终局画面——给出明确出路（重试/换线路/回首页），绝不无限转圈 */
function finalFailUI(reason) {
  reportLog('error', 'lineswap', '起播反复失败，停止自动重试 原因=' + reason + ' 线路=' + (CUR_LABEL || ''));
  failStage('<div class="ff-box"><div class="ff-t">😢 这个线路一直起不来</div>'
    + '<div class="ff-s">' + esc(reason) + ' · 已自动换过 ' + AUTO_SW + ' 条线路</div>'
    + '<div class="ff-btns"><button class="btn primary" onclick="retryThisLine()">↻ 再试一次</button>'
    + '<button class="btn" onclick="openLinePanel()">⇄ 换其他线路</button>'
    + '<button class="btn" onclick="goHome()">🏠 返回首页</button></div></div>');
}
window.retryThisLine = function () { AUTO_SW = 0; LINE_SKIP = 0; EP_FAIL_BUDGET = 5; if (CUR_TOKEN) playUpToken(CUR_TOKEN); };
/* v68c：播放提前停止（片源清单不完整）的停手画面——不自动跳集、不自动换线 */
window.playNextEp = function () { if (EP_IDX < EP_LIST.length - 1) selectEp(EP_IDX + 1); else toast('已经是最后一集 🎉'); };
window.replayThisEp = function () { selectEp(EP_IDX); };
/* 这一集播完了（用户拖到末尾/最后一集）：给操作按钮，但不自动连播 */
function endStopUI() {
  const hasNext = EP_IDX < EP_LIST.length - 1;
  failStage('<div class="ff-box"><div class="ff-t">✅ 这一集播完了</div>'
    + '<div class="ff-s">没有自动跳下一集，需要的话点下面的按钮</div>'
    + '<div class="ff-btns">' + (hasNext ? '<button class="btn primary" onclick="playNextEp()">⏭ 播放下一集</button>' : '')
    + '<button class="btn" onclick="replayThisEp()">↻ 重播本集</button>'
    + '<button class="btn" onclick="openLinePanel()">⇄ 换线路</button></div></div>');
}
function midStopUI(t, dur) {
  const hasNext = EP_IDX < EP_LIST.length - 1;
  failStage('<div class="ff-box"><div class="ff-t">⏸ 播放到这里停了</div>'
    + '<div class="ff-s">已播 ' + fmtTime(t) + ' / 片长 ' + (dur ? fmtTime(dur) : '未知')
    + '（片源清单可能不完整），没有自动跳下一集</div>'
    + '<div class="ff-btns">' + (hasNext ? '<button class="btn primary" onclick="playNextEp()">⏭ 播放下一集</button>' : '')
    + '<button class="btn" onclick="replayThisEp()">↻ 重播本集</button>'
    + '<button class="btn" onclick="openLinePanel()">⇄ 换线路</button></div></div>');
}
let PLAY_GEN = 0;     /* v52：播放代次——并发/超时的旧解析链直接作废，不许回头改 UI 或再触发换线 */
async function playUpToken(token, newEp) {
  const gen = ++PLAY_GEN;
  /* v53：换线续播——同一部片换线路（手动/自动）记住当前进度，新线路起播后接着放，
     不再从头开始。
     v69c：换集（newEp=1）绝不沿用进度——否则上一集的进度会被当成新集的续播位置 */
  try {
    if (!newEp && token === CUR_TOKEN && ART && ART.video && isFinite(ART.video.currentTime) && ART.video.currentTime > 5) {
      Q_POS = ART.video.currentTime;
      Q_POS_EP = EP_IDX;   /* v70：续播位置绑定当前集 */
    }
  } catch (e) {}
  showStageLoading(pt('stTitle', '精彩即将开始'), LINE_SKIP ? ptFmt('stLineN', '第 %s 条线路连接中…', LINE_SKIP + 1) : pt('stLineOne', '正在连接播放线路…'));
  loadVipName().then(() => setSlBadge(''));   /* 徽章先显示当前会员等级 */
  setSlBadge('');
  destroyArt();
  try {
    /* v69：沿用当前播放源——自动下一集/手动选集都继续用正在播的这条（起播更快、体验一致）；
       只有主动/自动换线（LINE_SKIP>0）才不传 keep，让服务端另挑一条。
       源失效时服务端内部顺延下一条，前端无感知，无需再打一次上游 */
    const keepArg = (!LINE_SKIP && CUR_LABEL) ? '&keep=' + encodeURIComponent(CUR_LABEL) : '';
    const r = await withTimeout(api('/api/up/resolve?token=' + encodeURIComponent(token)
      + (LINE_SKIP ? '&skip=' + LINE_SKIP : '') + keepArg), 22000);
    if (gen !== PLAY_GEN) { console.warn('[play] 过期解析结果丢弃（已有更新的播放指令）'); return; }
    if (r.label) { CUR_LABEL = r.label; updateLineLabel(); updateSlLine('正在连接 ' + r.label); }
    /* 官方/采集以服务端 official 字段为准（label 只是线路名，采集线也可能有 label） */
    CUR_OFFICIAL = r.official !== false;
    setSlBadge(r.official === false ? pt('badgeCollect', '采集线路') : pt('badgeOfficial', '官方线路'), r.official === false);
    if (!r.url) { autoNextLine('该线路暂不可用'); return; }
    if (isM3u8(r.url)) playM3u8(r.url, r.manifest);
    else if (isWebPage(r.url)) { hideStageLoading(); playFrame(r.url); }
    else playMp4(r.url);
  } catch (e) {
    if (gen === PLAY_GEN) {
      /* v52b：把真实失败原因落日志（超时/网络/中断），别再都写成「线路连接超时」，
         18:42 那次 resolve 明明 402ms 成功却 16s 后报超时，就是查不出真因 */
      reportLog('warn', 'lineswap', '线路连接异常(' + ((e && e.message) || e) + ') 旧线路=' + (CUR_LABEL || ''), 'skip=' + LINE_SKIP);
      autoNextLine('线路连接超时');
    }
  }
}
/* 取详情偶发失败（上游限流/超时），这里超时 15s + 最多重试 3 次 */
/* mode: 'quick'（仅第 1 页分集，秒回）→ 立即渲染+起播；'fill'（确保全量，复用后台合并）；
   'full'（默认，直接拉全）。首屏用 quick，长剧剩余分页后台补拉，集数不再干等 */
async function upDetail(id, tries = 2, mode = 'quick') {
  let last = null;
  const q = mode === 'quick' ? '&phase=1' : (mode === 'fill' ? '&fill=1' : '');
  const to = mode === 'quick' ? 15000 : (mode === 'fill' ? 30000 : 15000);
  for (let i = 0; i < tries; i++) {
    try {
      const j = await withTimeout(api('/api/up/detail?id=' + encodeURIComponent(id) + q), to);
      if (j && (j.detail || j.episodes)) return j;
      last = new Error('empty detail');
    } catch (e) { last = e; }
    await new Promise(r => setTimeout(r, 700 * (i + 1)));
  }
  throw last || new Error('detail failed');
}
async function initUp() {
  MODE = 'up';
  loadRec();   /* 推荐与详情并行加载，不再等播放链路 */
  /* 先用 URL 里的标题/海报立即渲染头部，详情到了再覆盖——详情慢也不空白 */
  META = { id: UPID, title: TITLE, poster: POSTER, year: YEAR, epTotal: 0, kind: '' };
  if (TITLE) { $('#ptitle').textContent = TITLE; setBrandTitle(TITLE); }
  const meta0 = [];
  if (YEAR) meta0.push(YEAR);
  $('#pmeta').innerHTML = meta0.map(x => `<span class="mt">${esc(x)}</span>`).join('');
  if (POSTER) $('#sidePoster').innerHTML = posterImg(POSTER);
  /* v73：只要 id 不是上游正牌 av_ token，就不能直接拿去打 /api/up/detail——
     上游只认 av_（纯数字 TMDB id 会 500；v73 内置豆瓣卡是 db_ 前缀）。
     一律先按片名在上游检索一次换正牌 id；检索不到（没配上游/上游没这片）就降级采集线路。
     ⚠️ 这里的判断必须是「非 av_」，不能是「纯数字」：豆瓣卡是 db_ 前缀，
     写死纯数字会让豆瓣卡绕过降级、直接打出空分集，表现为整页「暂无分集」。 */
  let uid = UPID;
  if (!/^av_/.test(String(uid)) && TITLE) {
    try {
      showStageLoading(pt('matchTitle', '正在匹配片源'), pt('matchSub', '该片来自榜单库，正在上游检索…'));
      const bare0 = String(TITLE || '').replace(/\s*[（(]?第[一二三四五六七八九十0-9]+季[）)]?\s*$/, '').replace(/\s*Season\s*\d+\s*$/i, '').trim() || TITLE;
      const sj = await api('/api/up/search?q=' + encodeURIComponent(bare0) + '&limit=8');
      let hit = (sj.items || []).find(x => x && /^av_/.test(String(x.id || '')));
      if (!hit && bare0 !== TITLE) {
        const sj2 = await api('/api/up/search?q=' + encodeURIComponent(TITLE) + '&limit=8');
        hit = (sj2.items || []).find(x => x && /^av_/.test(String(x.id || '')));
      }
      if (hit) uid = hit.id;
    } catch (e) { console.warn('[initUp] 片名检索失败', e); }
    if (!/^av_/.test(String(uid))) { await initCollect(); return; }
    try { history.replaceState(null, '', location.pathname + '?src=up&id=' + encodeURIComponent(uid) + '&title=' + encodeURIComponent(TITLE)); } catch (e) {}
  }
  try {
    showStageLoading(pt('infoTitle', '正在获取影片信息'), pt('infoSub', '如长时间无响应请刷新页面重试'));
    const j = await upDetail(uid, 2, 'quick');   // 快速模式：第 1 页分集秒回，先渲染+起播
    const d = j.detail || {};
    META = { id: uid, title: d.title || d.normalized_title || TITLE, poster: d.poster_url || POSTER, year: d.year || YEAR, epTotal: 0 };
    renderDetail(d);
    const ej = j.episodes || {};
    const eps = ej.episodes || ej.items || ej.list || [];
    if (!eps.length) {
      $('#eps').innerHTML = '<div class="empty">暂无分集</div>';
      failStage('<div class="empty" style="height:100%;display:grid;place-items:center">暂无分集</div>');
      $('#seasons').style.display = 'none';
    } else {
      EP_LIST = eps.filter(ep => epToken(ep)).map((ep, i) => ({ name: epName(ep, i), token: epToken(ep), idx: i }));
      META.epTotal = EP_LIST.length;
      buildSeasons(EP_LIST);
    }
    buildCtrls();
    let start = 0;
    if (Q_EP > 0 && Q_EP < EP_LIST.length) start = Q_EP;   // 断点续播：跳到上次那集
    /* 长剧还有更多分页：续播点已超出第 1 页则先等全量再选集；否则先起播，剩余页后台补拉后重绘 */
    const more = !!(j.quick && j.pagination && j.pagination.has_more);
    if (more && Q_EP >= EP_LIST.length) {
      try {
        const full = await upDetail(uid, 1, 'fill');
        const fe = ((full.episodes || {}).episodes || (full.episodes || {}).items || (full.episodes || {}).list) || [];
        if (fe.length > EP_LIST.length) {
          EP_LIST = fe.filter(ep => epToken(ep)).map((ep, i) => ({ name: epName(ep, i), token: epToken(ep), idx: i }));
          META.epTotal = EP_LIST.length; buildSeasons(EP_LIST); updateEpNav();
          start = (Q_EP < EP_LIST.length) ? Q_EP : 0;
        }
      } catch (e) { if (start >= EP_LIST.length) start = 0; }
    } else if (more) {
      upDetail(uid, 1, 'fill').then(full => {
        try {
          const fe = ((full.episodes || {}).episodes || (full.episodes || {}).items || (full.episodes || {}).list) || [];
          if (fe.length > EP_LIST.length) {
            EP_LIST = fe.filter(ep => epToken(ep)).map((ep, i) => ({ name: epName(ep, i), token: epToken(ep), idx: i }));
            META.epTotal = EP_LIST.length; buildSeasons(EP_LIST); updateEpNav();
          }
        } catch (e) {}
      }).catch(() => {});
    }
    if (EP_LIST.length) selectEp(start);
    /* 全线路插播自动识别：进入影片/剧集后后台扫描一次所有线路（落 'play-ad' 日志 + 缓存供换源面板复用）
       v47：这条请求服务端要逐条解析线路再拉清单分析，动辄几十秒，早期它和起播抢连接，
       会让「返回首页」「换源」都变慢。这里推迟 6 秒等起播链路走完再开跑，
       并且走 api() 统一登记，一离开页面就被 abortAllRequests 掐断 */
    /* v70：手机端索性不后台扫——实测手机上一进片就扫 20+ 条线路，
       把上游打到 429 并发限流，真要用的那条反而转不正（10:02~10:03 手机上
       连续「20s 无画面 / 仅播放 0.0s / 起播失败」就是这么来的）。
       手机端改成「打开换源面板时才扫」（renderLinePanel 里已有），平时把连接让给正片 */
    if (MODE === 'up' && CUR_TOKEN && !window.IS_MOBILE) {
      /* v50：不再固定 6s 就开扫——手机端起播慢，服务端这条扫描实测 95s，
         会长时间占住一条连接跟首片抢带宽。改成「真正起播后再扫」，最晚 45s 兜底。 */
      let waited = 0;
      const sc = setInterval(() => {
        waited += 1000;
        if (_LEAVING || MODE !== 'up') { clearInterval(sc); return; }
        if ((_started && waited >= 2000) || waited >= 45000) {
          clearInterval(sc);
          if (!_LEAVING && MODE === 'up' && CUR_TOKEN) scanAllLinesBg(CUR_TOKEN, TITLE);
        }
      }, 1000);
    }
    syncFavState();
  } catch (e) {
    console.error('[initUp] 失败:', e && (e.stack || e.message || e));
    /* 上游详情挂了（如 500）：有片名就自动降级到采集线路，不再死路 */
    if (TITLE) {
      console.warn('[initUp] 上游详情不可用，自动切换采集线路');
      artNotice('上游详情不可用，已切换采集线路');
      await initCollect();
      return;
    }
    $('#eps').innerHTML = '<div class="empty">获取详情失败，<a href="javascript:location.reload()" style="color:var(--cyan);cursor:pointer">点此重试</a></div>';
    failStage('<div class="empty" style="height:100%;display:grid;place-items:center;text-align:center">加载失败，上游可能开小差了<br>'
      + '<button class="sl-btn" style="margin-top:14px;cursor:pointer" onclick="location.reload()">🔄 重试</button></div>');
  }
}

/* ========== 采集站 / 解析模式 ========== */
/* v73c：解析包装统一走这里。原逻辑在解析地址以「url=」结尾时会再硬拼一个 'url='，
   实测拼出 https://<解析站>/index.php?url=url=https%3A%2F%2F... —— 解析器拿到
   「url=https://…」当参数值，必然解析失败黑屏。红牛这类站给的就是播放页地址，一播就踩中 */
function wrapParse(purl, vurl) {
  if (/(\?|&)url=$/.test(purl) || purl.endsWith('=url') || purl.endsWith('=')) {
    /* 地址已自带参数名（…?url= / …&url= / …=）：直接接编码后的值 */
    return purl + encodeURIComponent(vurl);
  }
  return purl + (purl.includes('?') ? '&' : '?') + 'url=' + encodeURIComponent(vurl);
}
function playEpisode(url) {
  if (!url) return;
  if (isM3u8(url)) { playM3u8(url); return; }
  if (isVideoFile(url)) { playMp4(url); return; }
  if (CFG && CFG.hasParse && (CFG.parseList || []).length) {
    const p = (CFG.parseList[0] || {}).url;
    if (!p) { playFrame(url); return; }
    playFrame(wrapParse(p, url));
    return;
  }
  playFrame(url);
}
/* 采集资源没有正牌 id：用 片名|年份 哈希出稳定合成 id（c_ 前缀），收藏/历史才有主键 */
function synthId(t, y) { let h = 5381; const str = (t || '') + '|' + (y || ''); for (let i = 0; i < str.length; i++) h = ((h << 5) + h + str.charCodeAt(i)) | 0; return 'c_' + (h >>> 0).toString(36); }
async function initCollect() {
  MODE = 'collect';
  META = { id: synthId(TITLE, YEAR), title: TITLE, poster: POSTER, year: YEAR, epTotal: 0, kind: '' };
  $('#ptitle').textContent = TITLE || '播放';
  setBrandTitle(TITLE || '播放');
  const meta = [];
  if (YEAR) meta.push(YEAR);
  meta.push('采集资源');
  $('#pmeta').innerHTML = meta.map(x => `<span class="mt">${esc(x)}</span>`).join('');
  $('#pDesc').innerHTML = '<p class="muted">该资源来自采集站，详情以播放源为准。</p>';
  $('#pActors').innerHTML = '';
  bindDescToggle();
  buildDiscover({});   /* 采集源没有演员/导演/类型 → 不生成芯片，轮播退化为只显示简介 */
  $('#sidePoster').innerHTML = POSTER ? posterImg(POSTER) : '';
  $('#sideDetail').innerHTML = '<div class="muted" style="font-size:13px">暂无更多信息</div>';
  $('#seasons').style.display = 'none';
  /* TMDB 标题常带「第x季/Season n」尾缀，采集站按正名收录：去尾缀多试一次 */
  const bare = (t) => String(t || '').replace(/\s*[（(]?第[一二三四五六七八九十0-9]+季[）)]?\s*$/, '').replace(/\s*Season\s*\d+\s*$/i, '').trim();
  const qTitle = bare(TITLE) || TITLE;
  try {
    /* v72：优先用「采集站 id + 站内 id」精确取 —— 很多采集站（360zy 这类）只开放列表接口，
       wd 搜索是关的，按名字搜必然扑空，点进来就是「暂无片源」。 */
    if (SID && VID) {
      try {
        const byId = await api('/api/play?sid=' + encodeURIComponent(SID) + '&vid=' + encodeURIComponent(VID));
        if (byId && (byId.results || []).some(st => (st.sources || []).length)) PLAY = byId;
      } catch (e) {}
    }
    if (!PLAY) {
      PLAY = await api('/api/play?name=' + encodeURIComponent(qTitle) + '&year=' + encodeURIComponent(YEAR));
    }
    if (!PLAY || !(PLAY.results || []).some(st => (st.sources || []).length)) {
      if (bare(TITLE) !== TITLE) {
        PLAY = await api('/api/play?name=' + encodeURIComponent(TITLE) + '&year=' + encodeURIComponent(YEAR));
      }
    }
    CFG = Object.assign(CFG || {}, { hasParse: PLAY.hasParse, parseList: PLAY.parseList });
    /* v73c：详情优先取「第一个有内容的站」——多个采集站聚合时第一个站常常啥都不填，
       第二个站却有完整简介/演员，以前只看 results[0] 就白瞎了 */
    const R0 = PLAY.results || [];
    const stDet = R0.find(s => s.detail && (s.detail.plot || s.detail.actors || s.detail.type)) || R0.find(s => s.detail) || {};
    const dt = stDet.detail;
    /* v73c：海报兜底——降级进来（豆瓣卡/搜索）URL 常不带 poster 参数，
       采集站条目里其实有 vod_pic，补进 META 后「播放历史/收藏」就有图了 */
    const pst0 = (R0.find(s => s.poster) || {}).poster || '';
    if (!POSTER && pst0) META.poster = pst0;
    if (dt && (dt.plot || dt.actors || dt.type)) {
      /* 综艺/连载类站方常常不填简介，但会填「更新至xxxx期」——有这个就别摆占位文案了 */
      if (dt.plot) $('#pDesc').innerHTML = `<p>${esc(dt.plot)}</p>`;
      else if (dt.remark) $('#pDesc').innerHTML = `<p class="muted">${esc(dt.remark)}</p>`;
      const acts = String(dt.actors || '').split(/[,，]/).map(s => s.trim()).filter(Boolean);
      let ph = '';
      if (dt.director) ph += `<div class="pl"><b>导演</b><span class="pc">${esc(dt.director)}</span></div>`;
      if (acts.length) ph += `<div class="pl"><b>主演</b>${acts.slice(0, 16).map(x => `<span class="pc">${esc(x)}</span>`).join('')}</div>`;
      if (ph) $('#pActors').innerHTML = ph;
      const rows = [];
      if (YEAR) rows.push(['年份', esc(YEAR)]);
      if (dt.area) rows.push(['地区', esc(dt.area)]);
      if (dt.lang) rows.push(['语言', esc(dt.lang)]);
      if (dt.type) rows.push(['类型', esc(dt.type)]);
      if (dt.remark) rows.push(['备注', esc(dt.remark)]);
      if (rows.length) {
        $('#sideDetail').innerHTML = rows.map(r => `<div class="sc-row"><span class="sc-k">${r[0]}</span><span class="sc-v">${r[1]}</span></div>`).join('');
      }
      const mt = [];
      if (YEAR) mt.push(YEAR);
      if (dt.type) mt.push(dt.type);
      if (dt.area) mt.push(dt.area);
      mt.push('采集资源');
      $('#pmeta').innerHTML = mt.map(x => `<span class="mt">${esc(x)}</span>`).join('');
      buildDiscover({ directors: dt.director ? [dt.director] : [], actors: acts.slice(0, 4), genres: dt.type ? [dt.type] : [], area: dt.area || '', year: YEAR });
      bindDescToggle();
      const pst = stDet.poster || '';
      if (pst && !POSTER) $('#sidePoster').innerHTML = posterImg(pst);
    }
    const stations = PLAY.results || [];
    const tabs = [];
    let idx = 0;
    stations.forEach(st => { (st.sources || []).forEach(src => { tabs.push({ label: `${st.station} · ${src.from}`, episodes: src.episodes }); idx++; }); });
    if (!tabs.length) {
      $('#eps').innerHTML = '<div class="empty">未找到播放源，请回后台添加采集站</div>';
      failStage('<div class="empty" style="height:100%;display:grid;place-items:center;padding:0 24px;text-align:center">「' + esc(TITLE || '') + '」暂无片源<br><span style="font-size:12px;opacity:.6">可点顶部搜索换一部，或回首页重新随机</span></div>');
      syncFavState(); loadRec();
      return;
    }
    const chosen = tabs[0];
    CUR_LABEL = chosen.label || '采集资源';
    updateLineLabel();
    updateSlLine('正在连接 ' + CUR_LABEL);
    setSlBadge(pt('badgeCollect', '采集线路'), true);
    EP_LIST = (chosen.episodes || []).map((ep, i) => ({ name: ep.name || ('第 ' + (i + 1) + ' 集'), url: ep.url, idx: i })).filter(ep => ep.url);
    META.epTotal = EP_LIST.length;
    paintEps(EP_LIST.map((ep, i) => ({ ep, i })));
    buildCtrls();
    if (EP_LIST.length) selectEp(Math.min(Q_EP, EP_LIST.length - 1));   /* 续播：跳到上次那集 */
  } catch (e) {
    $('#eps').innerHTML = '<div class="empty">获取播放源失败</div>';
    failStage('<div class="empty" style="height:100%;display:grid;place-items:center">获取播放源失败，请刷新重试</div>');
  }
  syncFavState();
  loadRec();   /* 采集模式也要加载「猜你喜欢」，否则永远停在「加载中…」 */
}

/* ========== 广告联盟：播放页左侧广告位 + 播放器暂停广告 ========== */
/* 联盟代码用沙箱 iframe 加载：能执行 script，又与主站隔离（不给 same-origin，防读取登录 token） */
function injectAdCode(box, code) {
  box.innerHTML = '';
  if (!code) return;
  const f = document.createElement('iframe');
  f.className = 'ad-frame';
  f.setAttribute('sandbox', 'allow-scripts allow-popups allow-popups-to-escape-sandbox');
  f.setAttribute('loading', 'lazy');
  f.setAttribute('referrerpolicy', 'no-referrer');
  f.srcdoc = '<!DOCTYPE html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">'
    + '<style>html,body{margin:0;padding:0;background:transparent;overflow:hidden}img{max-width:100%;display:block}a{display:block}</style></head><body>'
    + code + '</body></html>';
  box.appendChild(f);
}
/* 左侧广告位：后台关闭时本容器直接隐藏，左栏显示原有参数（信息卡/历史/收藏），与现在完全一致 */
async function loadSideAd() {
  const host = $('.p-media'); if (!host) return;
  let box = $('#sideAd');
  if (!box) { box = document.createElement('div'); box.id = 'sideAd'; box.className = 'side-ad hidden'; }
  let cfg = null;
  try { cfg = await api('/api/ads?slot=sidebar'); } catch (e) { return; }
  if (!cfg || !cfg.enabled) { box.classList.add('hidden'); repadRec(); return; }
  const sb = (CFG && CFG.ads && CFG.ads.sidebar) || {};
  box.style.width = sb.width || '100%';
  box.style.height = (sb.height && sb.height !== 'auto') ? sb.height : '';
  if (cfg.network === 'code') {
    if (!cfg.code) { box.classList.add('hidden'); return; }
    injectAdCode(box, cfg.code);
  } else {
    if (!cfg.items || !cfg.items.length) { box.classList.add('hidden'); return; }
    box.innerHTML = cfg.items.map(it =>
      '<a class="side-ad-item" href="' + esc(it.link || 'javascript:void(0)') + '" target="_blank" rel="noopener nofollow" title="' + esc(it.title || '') + '">'
      + '<img src="' + esc(it.img) + '" alt="' + esc(it.title || '广告') + '" loading="lazy" onerror="this.parentNode.classList.add(\'ad-broken\')">'
      + (it.title ? '<span class="side-ad-t">' + esc(it.title) + '</span>' : '') + '</a>').join('');
  }
  box.classList.remove('hidden');
  repadRec();   /* 广告位展示状态变化 → 重新计算猜你喜欢的占位补齐 */
  /* 开广告后要填满中列空白：已渲染的不足多排数量就按新上限重渲一次（feed 有服务端缓存，开销极小） */
  if (REC_SHOWN > 0 && REC_SHOWN < recLimit()) loadRec();
  if (!box.parentNode) {
    const anchor = $('#sidePoints') || $('#sideDetail');
    const pos = sb.position || 'belowDetail';
    if (pos === 'topOfSide') host.insertBefore(box, host.firstChild);
    else if (pos === 'belowPoster') { const a = $('#sidePoster'); if (a) host.insertBefore(box, a.nextSibling); else host.insertBefore(box, host.firstChild); }
    else if (pos === 'aboveHistory') { const a = host.querySelector('.side-rec'); if (a) host.insertBefore(box, a); else host.appendChild(box); }
    else { if (anchor) host.insertBefore(box, anchor.nextSibling); else host.insertBefore(box, host.firstChild); }
  }
}
/* 暂停广告：点暂停弹出（可配延迟/关闭按钮/自动关闭），继续播放即消失 */
let _pauseAdTimer = null, _pauseAdAuto = null;
function ensurePauseAd() {
  let el = $('#pauseAd');
  if (el) return el;
  const si = document.querySelector('.stage-inner'); if (!si) return null;
  el = document.createElement('div');
  el.id = 'pauseAd'; el.className = 'pause-ad hidden';
  el.innerHTML = '<div class="pa-box"><button class="pa-x" id="paClose" title="关闭广告">✕</button><div class="pa-body" id="paBody"></div></div>';
  si.appendChild(el);
  el.querySelector('#paClose').onclick = (ev) => { ev.stopPropagation(); hidePauseAd(); };
  return el;
}
async function showPauseAd() {
  if (!CFG || !CFG.ads || !CFG.ads.enabled) return;
  const pa = CFG.ads.pause || {};
  if (!pa.enabled) return;
  const el = ensurePauseAd(); if (!el) return;
  let cfg = null;
  try { cfg = await api('/api/ads?slot=pause'); } catch (e) { return; }
  if (!cfg || !cfg.enabled) return;
  const body = el.querySelector('#paBody');
  if (cfg.network === 'code') { if (!cfg.code) return; injectAdCode(body, cfg.code); }
  else {
    if (!cfg.items || !cfg.items.length) return;
    const it = cfg.items[0];
    body.innerHTML = '<a class="pa-link" href="' + esc(it.link || 'javascript:void(0)') + '" target="_blank" rel="noopener nofollow">'
      + '<img src="' + esc(it.img) + '" alt="' + esc(it.title || '广告') + '" onerror="this.parentNode.classList.add(\'ad-broken\')">'
      + (it.title ? '<span class="pa-t">' + esc(it.title) + '</span>' : '') + '</a>';
  }
  const x = el.querySelector('#paClose'); if (x) x.style.display = pa.closeable === false ? 'none' : '';
  clearTimeout(_pauseAdTimer); clearTimeout(_pauseAdAuto);
  _pauseAdTimer = setTimeout(() => {
    el.classList.remove('hidden');
    if (Number(pa.autoClose) > 0) _pauseAdAuto = setTimeout(hidePauseAd, Number(pa.autoClose) * 1000);
  }, Math.max(0, Math.min(10000, Number(pa.delay) || 0)));
}
function hidePauseAd() { const el = $('#pauseAd'); if (el) el.classList.add('hidden'); clearTimeout(_pauseAdTimer); clearTimeout(_pauseAdAuto); }

/* ========== 积分 / 签到 / 邀请（播放页左栏卡片） ========== */
async function buildSidePoints() {
  const host = $('.p-media'); if (!host) return;
  let box = $('#sidePoints');
  if (!box) {
    box = document.createElement('div');
    box.id = 'sidePoints'; box.className = 'side-rec side-points';
    box.innerHTML = '<h3>我的积分</h3><div id="ptsBody"><div class="empty" style="padding:10px 0">加载中…</div></div>';
    const a = $('#sideDetail');
    if (a) host.insertBefore(box, a.nextSibling); else host.insertBefore(box, host.firstChild);
  }
  let j = null;
  try { j = await api('/api/points/me'); } catch (e) { return; }
  if (!j) return;
  const vipTag = (j.vip && j.vip.level > 0) ? '<span class="pt-vip">' + esc(j.vip.name) + (j.vip.days > 0 ? ' · 剩' + j.vip.days + '天' : ' · 永久') + '</span>' : '';
  const ck = j.checkin || {}, inv = j.invite || {};
  box.querySelector('#ptsBody').innerHTML =
    '<div class="pt-num"><b>' + (j.points || 0) + '</b> 积分' + vipTag + '</div>'
    + '<div class="pt-row"><button class="btn primary" id="ptCkBtn"' + (ck.today ? ' disabled' : '') + '>' + (ck.today ? '今日已签到' : '签到领 ' + ((j.cfg.checkin || {}).base || 0) + ' 分') + '</button>'
    + '<span class="pt-streak">连签 ' + (ck.streak || 0) + ' 天</span></div>'
    + '<div class="pt-row"><button class="btn" id="ptInvBtn">邀请好友</button><span class="pt-streak">已邀 ' + (inv.invited || 0) + ' 人 · 每邀 +' + (inv.perInvite || 0) + '</span></div>'
    + '<div class="pt-tip">观看影视每满 1 分钟 +' + ((j.cfg.watch || {}).pointsPerMin || 0) + ' 分（每日上限 ' + ((j.cfg.watch || {}).dailyCapMin || 0) + ' 分钟）</div>';
  const ckb = box.querySelector('#ptCkBtn');
  if (ckb) ckb.onclick = async () => {
    ckb.disabled = true;
    try {
      const r = await api('/api/checkin', { method: 'POST', body: {} });
      if (r && r.ok) { toast('签到成功 +' + r.gained + ' 分' + (r.streak > 1 ? '（连签 ' + r.streak + ' 天）' : '')); buildSidePoints(); }
      else toast((r && r.error) || '签到失败');
    } catch (e) { toast('签到失败'); }
  };
  const ivb = box.querySelector('#ptInvBtn');
  if (ivb) ivb.onclick = () => openInviteModal(j);
}
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
function openInviteModal(j) {
  const inv = j.invite || {}, code = inv.code || '';
  const link = location.origin + '/index.html?invite=' + encodeURIComponent(code);
  let m = $('#inviteModal');
  if (!m) {
    m = document.createElement('div'); m.id = 'inviteModal'; m.className = 'cast-modal hidden';
    m.innerHTML = '<div class="cm-box"><div class="cm-head"><h3>邀请好友</h3><button class="cm-x" id="invClose">✕</button></div>'
      + '<div class="cm-tip">好友通过你的链接注册，你每邀请 1 人得 <b id="invPer"></b> 积分</div>'
      + '<div style="display:flex;gap:8px;margin:12px 0"><input id="invLink" readonly style="flex:1;min-width:0;background:rgba(5,6,10,.5);border:1px solid var(--line);color:var(--txt);padding:10px;border-radius:10px;font-size:12px">'
      + '<button class="btn primary" id="invCopy">复制</button></div>'
      + '<div class="cm-tip">邀请码：<b id="invCode"></b>　已邀请 <b id="invCount"></b> 人</div>'
      + '<div class="cm-foot"><button class="btn" id="invDone">完成</button></div></div>';
    document.body.appendChild(m);
    m.querySelector('#invClose').onclick = () => m.classList.add('hidden');
    m.querySelector('#invDone').onclick = () => m.classList.add('hidden');
    m.addEventListener('click', e => { if (e.target === m) m.classList.add('hidden'); });
    m.querySelector('#invCopy').onclick = async () => {
      const inp = m.querySelector('#invLink');
      const okc = await copyText(inp.value);
      toast(okc ? '邀请链接已复制，发给好友即可' : '复制失败，请手动复制：' + inp.value);
    };
  }
  m.querySelector('#invPer').textContent = inv.perInvite || 0;
  m.querySelector('#invLink').value = link;
  m.querySelector('#invCode').textContent = code;
  m.querySelector('#invCount').textContent = inv.invited || 0;
  m.classList.remove('hidden');
}

/* ========== 启动 ========== */
async function init() {
  buildSpeedBar();
  buildSkipPill();
  try {
    const pub = await fetch('/api/public').then(r => r.json());
    document.title = (pub.siteName || 'AIStream') + ' · 播放';
    const b = $('#pBrand');
    if (b && b.childNodes[0]) b.childNodes[0].nodeValue = (pub.siteName || 'AIStream');
  } catch (e) {}
  try { CFG = await api('/api/config'); } catch (e) {}
  applyMisc();   /* v63：读后台「其他设置」（轮播间隔 / 加载卡文案） */
  applyFavPermUI();   /* v47：拿到权限就先把收藏按钮收/放好，别等 syncFavState（采集模式没有 id 不会走到那） */
  /* 播放器页只显示广播（公告固定在首页打开时显示，见 app.js） */
  try {
    if (CFG && CFG.lastBroadcast && CFG.lastBroadcast.time > (+localStorage.getItem('aistream_lastBc') || 0)) {
      showBroadcastP(CFG.lastBroadcast); localStorage.setItem('aistream_lastBc', String(CFG.lastBroadcast.time));
    }
  } catch (e) {}
  connectSSEP();   // 播放器页接入 SSE：实时接收广播（公告仅在首页显示）
  /* LED 滚动条：顶栏（原搜索框位置），文字/字号/速度/颜色全部后台可设 */
  const led = $('#ledBar');
  if (led && CFG && CFG.toggles && CFG.toggles.antiScam) {
    const tg = CFG.toggles;
    led.innerHTML = '<span class="as-track"></span>';
    const tr = led.querySelector('.as-track');
    tr.textContent = '\u3000' + (tg.antiScamText || '') + '\u3000';
    tr.style.animationDuration = (Number(tg.antiScamSpeed) || 15) + 's';
    tr.style.fontSize = (Number(tg.antiScamSize) || 13) + 'px';
    tr.style.setProperty('--as-from', (Number(tg.antiScamFrom) || 100) + '%');
    tr.style.setProperty('--as-to', (Number(tg.antiScamTo) || -100) + '%');
    if (tg.antiScamColor) tr.style.color = tg.antiScamColor;
    led.classList.remove('hidden');
    /* v65 手机端：LED 滚动改 px 距离，保证长文字每个周期能完整看一遍（同 app.js 首页顶栏） */
    if (window.IS_MOBILE) requestAnimationFrame(() => {
      const tw = tr.scrollWidth || 600, cw = led.clientWidth || 320;
      tr.style.setProperty('--as-from', cw + 'px');
      tr.style.setProperty('--as-to', (-tw - 20) + 'px');
      tr.style.animationDuration = Math.max(10, Math.round((cw + tw) / 55)) + 's';
    });
  }

  /* 大搜索框：播放页内联搜索结果面板（不再跳转首页） */
  const doBigQ = () => {
    const q = ($('#bigQ').value || '').trim();
    if (!q) return;
    let panel = $('#bigQRes');
    if (!panel) {
      panel = document.createElement('div');
      panel.id = 'bigQRes';
      panel.className = 'bq-res';
      const bs = document.querySelector('.big-search');
      if (bs && bs.parentNode) bs.parentNode.insertBefore(panel, bs.nextSibling);
    }
    panel.classList.remove('hidden');
    panel.innerHTML = '<div class="bqr-tip">🔍 正在搜索「' + esc(q) + '」…</div>';
    let left = 2;
    const finish = () => { if (--left <= 0 && !panel.querySelector('.bqr-item')) panel.innerHTML = '<div class="bqr-tip">未找到「' + esc(q) + '」相关内容</div>'; };
    api('/api/up/search?q=' + encodeURIComponent(q) + '&limit=8').then(r => {
      const items = (r.items || []).filter(x => x && x.id).slice(0, 8);
      if (items.length) {
        panel.innerHTML = '<div class="bqr-h">资源库</div>' + items.map(it => {
          const href = '/player.html?' + new URLSearchParams({ src: 'up', id: it.id, title: it.title || it.normalized_title || '', year: it.year || '' }).toString();
          return `<div class="bqr-item" data-href="${href}"><span>${esc(it.title || '')}</span><i>${esc(it.year || '')}</i></div>`;
        }).join('');
      }
      finish();
    }).catch(() => finish());
    api('/api/search?q=' + encodeURIComponent(q)).then(r => {
      const col = (r.collect || []).slice(0, 6);
      if (col.length) {
        const div = document.createElement('div');
        div.innerHTML = '<div class="bqr-h">采集站</div>' + col.map(v => {
          /* v73c：带上 sid/vid/poster —— 精确取源 + 历史/收藏有图 */
          const qq = { title: v.name, year: v.year || '', media: 'collect' };
          if (v.stationId) qq.sid = v.stationId;
          if (v.id) qq.vid = v.id;
          if (v.poster) qq.poster = v.poster;
          const href = '/player.html?' + new URLSearchParams(qq).toString();
          return `<div class="bqr-item" data-href="${href}"><span>${esc(v.name)}</span><i>${esc(v.year || '')}</i></div>`;
        }).join('');
        panel.appendChild(div);
      }
      finish();
    }).catch(() => finish());
  };
  $('#bigQBtn').onclick = doBigQ;
  $('#bigQ').addEventListener('keydown', e => {
    if (e.key === 'Enter') doBigQ();
    if (e.key === 'Escape') { const pn = $('#bigQRes'); if (pn) pn.classList.add('hidden'); }
  });
  /* 点击结果跳转对应播放页；点击面板外收起 */
  document.addEventListener('click', e => {
    const pn = $('#bigQRes');
    if (!pn || pn.classList.contains('hidden')) return;
    const it = e.target.closest('.bqr-item');
    if (it && it.dataset.href) { location.href = it.dataset.href; return; }
    if (!pn.contains(e.target) && e.target !== $('#bigQ') && !e.target.closest('.big-search')) pn.classList.add('hidden');
  });

  /* 历史记录/收藏/键盘不等影片详情：详情慢时左栏也是满的，不空白转圈 */
  applyMobileLayout();
  bindKeys();
  loadSideWidgets();
  /* 积分卡片 + 左侧广告位：与详情并行加载，互不阻塞 */
  buildSidePoints();
  loadSideAd();

  if (SRC === 'up' && UPID) { await initUp(); }
  else { await initCollect(); }
}

/* ========== 左栏：播放历史 + 收藏（默认各显示 3 条，可折叠） ========== */
function fmtT(s) {
  s = Math.max(0, Math.round(s || 0));
  const h = Math.floor(s / 3600), m = Math.floor(s % 3600 / 60), ss = s % 60;
  return h ? h + ':' + String(m).padStart(2, '0') + ':' + String(ss).padStart(2, '0') : m + ':' + String(ss).padStart(2, '0');
}
const SIDE_N = 3;
function renderSideList(box, items, mkRow, expanded) {
  box.innerHTML = '';
  if (!items.length) { box.innerHTML = '<div class="empty" style="padding:10px 0">暂无内容</div>'; return; }
  const shown = expanded ? items : items.slice(0, SIDE_N);
  shown.forEach(it => box.appendChild(mkRow(it)));
  if (items.length > SIDE_N) {
    const b = document.createElement('button');
    b.className = 'hf-more';
    b.textContent = expanded ? '收起 ▴' : '展开全部 ' + items.length + ' 条 ▾';
    b.onclick = () => { if (box.id === 'pHist') histExpanded = !histExpanded; else favExpanded = !favExpanded; loadSideWidgets(); };
    box.appendChild(b);
  }
}
async function loadSideWidgets() {
  const hb = $('#pHist'), fb = $('#pFavList');
  if (!hb || !fb) return;
  /* v47：栏目权限关掉时整块隐藏。服务端 GET 本来就返回空，但留个「暂无内容」空块没意义，
     而且没权限的用户根本不该看到这个入口 */
  const canH = viewCan('history'), canF = viewCan('fav');
  const hBox = hb.closest ? hb.closest('.side-rec') : null;
  const fBox = fb.closest ? fb.closest('.side-rec') : null;
  if (hBox) hBox.style.display = canH ? '' : 'none';
  if (fBox) fBox.style.display = canF ? '' : 'none';
  if (!canH && !canF) return;
  const clr = $('#pHistClr');
  /* v34：「查看更多」不再跳首页，原地展开/收起（与「展开全部 N 条」同一状态） */
  const hm = $('#pHistMore'), fm = $('#pFavMore');
  if (hm && !hm._bound) { hm._bound = true; hm.onclick = (e) => { e.preventDefault(); histExpanded = !histExpanded; loadSideWidgets(); }; }
  if (fm && !fm._bound) { fm._bound = true; fm.onclick = (e) => { e.preventDefault(); favExpanded = !favExpanded; loadSideWidgets(); }; }
  if (hm) hm.textContent = histExpanded ? '收起 ▴' : '查看更多';
  if (fm) fm.textContent = favExpanded ? '收起 ▴' : '查看更多';
  if (clr && !clr._bound) {
    clr._bound = true;
    clr.onclick = async (e) => {
      e.preventDefault();
      if (!confirm('确定清空全部观看记录？此操作不可恢复')) return;
      try {
        await fetch('/api/history', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + TOKEN }, body: JSON.stringify({ clear: true }) });
        toast('观看记录已清空'); loadSideWidgets();
      } catch (err) { toast('清空失败，请重试'); }
    };
  }
  if (!TOKEN) { hb.innerHTML = '<div class="empty" style="padding:10px 0">登录后可见</div>'; fb.innerHTML = '<div class="empty" style="padding:10px 0">登录后可见</div>'; return; }
  if (!canH) hb.innerHTML = '';
  else try {
    const h = await api('/api/history');
    renderSideList(hb, (h.items || []).filter(x => x && x.id), (it) => {
      const pct = it.dur ? Math.min(100, Math.round((it.pos || 0) / it.dur * 100)) : 0;
      const a = document.createElement('a');
      a.className = 'hf-row';
      a.href = 'player.html?src=up&id=' + encodeURIComponent(it.id) + '&title=' + encodeURIComponent(it.title || '') + '&poster=' + encodeURIComponent(it.poster || '') + '&ep=' + (it.ep || 0) + '&pos=' + (it.pos || 0);
      a.innerHTML = `<img class="hf-p" loading="lazy" decoding="async" src="${img(it.poster)}" onerror="this.style.visibility='hidden'" alt="">`
        + `<div class="hf-m"><div class="hf-t">${esc(it.title || '未知')}</div>`
        + `<div class="hf-s">第${(it.ep || 0) + 1}集${it.pos ? ' · ' + fmtT(it.pos) + ' · ' + pct + '%' : ''}</div>`
        + `<div class="hf-bar"><i style="width:${pct}%"></i></div></div>`;
      return a;
    }, histExpanded);
  } catch (e) { hb.innerHTML = '<div class="empty" style="padding:10px 0">加载失败</div>'; }
  if (!canF) fb.innerHTML = '';
  else try {
    const f = await api('/api/fav');
    renderSideList(fb, (f.items || []).slice(0, favExpanded ? 50 : 12), (it) => {
      const a = document.createElement('a');
      a.className = 'hf-row';
      a.href = 'player.html?src=up&id=' + encodeURIComponent(it.id) + '&title=' + encodeURIComponent(it.title || '') + '&poster=' + encodeURIComponent(it.poster || '');
      a.innerHTML = `<img class="hf-p" loading="lazy" decoding="async" src="${img(it.poster)}" onerror="this.style.visibility='hidden'" alt="">`
        + `<div class="hf-m"><div class="hf-t">${esc(it.title || '未知')}</div><div class="hf-s">${esc(it.year || '')}</div></div>`;
      return a;
    }, favExpanded);
  } catch (e) { fb.innerHTML = '<div class="empty" style="padding:10px 0">加载失败</div>'; }
}

/* 键盘快捷键：空格 播放/暂停，← → 快退/快进 10s，↑ ↓ 上/下一集，F 全屏 */
function bindKeys() {
  document.addEventListener('keydown', e => {
    if (e.target && /INPUT|TEXTAREA/.test(e.target.tagName)) return;
    if (!ART || !ART.video) return;
    if (e.key === ' ') { e.preventDefault(); ART.playing ? ART.pause() : ART.play(); }
    else if (e.key === 'ArrowRight') { e.preventDefault(); ART.video.currentTime = Math.min((ART.video.duration || 0), ART.video.currentTime + 10); }
    else if (e.key === 'ArrowLeft') { e.preventDefault(); ART.video.currentTime = Math.max(0, ART.video.currentTime - 10); }
    else if (e.key === 'f' || e.key === 'F') { ART.fullscreen = !ART.fullscreen; }
    else if (e.key === 'ArrowUp') { e.preventDefault(); stepEp(-1); }
    else if (e.key === 'ArrowDown') { e.preventDefault(); stepEp(1); }
  });
}
/* ========== v36：手机端播放页重排 + 折叠（PC 端一行都不执行） ==========
   手机端顺序：播放器 → 片名/年份/类型 → 选集 → 简介·演职员(折叠) → 猜你喜欢(折叠) → 海报/历史/收藏 → 搜索(最底)
   折叠按钮只切换显示，绝不跳转、不滚动。 */
const M_MOVED = [];
function mMove(el, parent, before) {
  if (!el || !parent) return;
  if (!el._mOrig) el._mOrig = { p: el.parentNode, n: el.nextSibling };
  if (M_MOVED.indexOf(el) < 0) M_MOVED.push(el);
  if (el.parentNode === parent && el.nextElementSibling === (before || null)) return;
  parent.insertBefore(el, before || null);
}
function mRestore() {
  M_MOVED.forEach(el => {
    const o = el._mOrig; if (!o) return;
    if (el.parentNode !== o.p) o.p.insertBefore(el, o.n);
    el.style.order = '';
  });
  M_MOVED.length = 0;
  document.querySelectorAll('.m-fold-bar').forEach(b => b.remove());
  document.querySelectorAll('.fold-btn').forEach(b => b.remove());
  const q = $('#mQuick'); if (q) q.remove();   /* 快捷栏是手机端专属，回 PC 撤掉 */
  /* v59：跳过胶囊搬回 stage 内（手机端才挪去倍速条，PC 保持悬浮在播放器右下角） */
  const pill = $('#skipPill'), si = document.querySelector('.stage-inner');
  if (pill && si && pill.parentNode !== si) si.appendChild(pill);
  ['#pDesc', '#pActors', '#rec'].forEach(s => { const e = $(s); if (e) e.style.display = ''; });
}
/* 折叠开关：host=按钮挂载处，bodies=被折叠的元素数组 */
function addFold(host, bodies, txtClosed, txtOpen, open) {
  if (!host) return;
  const list = (Array.isArray(bodies) ? bodies : [bodies]).filter(Boolean);
  if (!list.length) return;
  let b = host.querySelector('.fold-btn');
  if (!b) { b = document.createElement('button'); b.className = 'fold-btn'; host.appendChild(b); }
  const set = o => {
    list.forEach(e => { e.style.display = o ? '' : 'none'; });
    b.textContent = o ? (txtOpen || '收起 ▴') : (txtClosed || '展开 ▾');
    b.setAttribute('data-open', o ? '1' : '0');
  };
  b.onclick = e => { e.preventDefault(); e.stopPropagation(); set(b.getAttribute('data-open') !== '1'); };
  set(!!open);
  return b;
}
function applyMobileLayout() {
  const main = $('.p-main'), stage = $('.p-stagecol'), media = $('.p-media'), aside = $('.p-side');
  if (!main || !stage || !media || !aside) return;
  if (!window.IS_MOBILE) { mRestore(); return; }
  const eps = $('.p-eps'), info = $('.p-info');
  /* 跨容器重排：信息区、选集提到 main 里（大搜索框手机端由 CSS 隐藏，不再挪动） */
  mMove(info, main, media);
  mMove(eps, main, media);
  /* v66：手机端「选集」紧跟播放器，「猜你喜欢」挪到选集/简介之后（大哥要求互换位置） */
  const recSec = Array.from(document.querySelectorAll('.side-rec')).find(s => s.querySelector('#rec'));
  if (recSec) mMove(recSec, main, media);
  /* 海报不再孤零零居中挂一块 → 缩略图并入信息行左侧（标题/年份环绕，主流 App 的样式） */
  const poster = $('#sidePoster');
  if (poster) mMove(poster, info, info.firstChild);
  stage.style.order = '1';
  eps.style.order = '2';
  info.style.order = '3';
  recSec.style.order = '4';
  media.style.order = '5';
  /* 快捷操作栏：贴着倍速条放，替代原大搜索框 */
  buildQuickBar(stage);
  /* v59：跳过片头/片尾胶囊挪进倍速条——视频独立层会盖住 stage 里的绝对定位元素，
     手机上胶囊被视频压住看不见也点不到（「不显示自动跳过片头」）。挪出来永远可见可点 */
  const pill = $('#skipPill'), sbp = $('#speedbar');
  if (pill && sbp && pill.parentNode !== sbp) sbp.appendChild(pill);
  /* 简介 / 演职员：折叠，默认收起
     v61：简介块已挪进轮播容器 #pSlideInfo，折叠条要插到它的实际父节点里（原 info.insertBefore 会抛 NotFoundError） */
  if (info) {
    let bar = info.querySelector('.m-fold-bar');
    if (!bar) {
      bar = document.createElement('div');
      bar.className = 'm-fold-bar';
      bar.innerHTML = '<span>剧情简介 / 演职员</span>';
      const anchor = $('#pDesc') || $('#pActors');
      if (anchor && anchor.parentNode) anchor.parentNode.insertBefore(bar, anchor);
      else info.appendChild(bar);
    }
    addFold(bar, [$('#pDesc'), $('#pActors')], '展开 ▾', '收起 ▴', false);
  }
  /* 猜你喜欢：折叠，默认收起（v66：区块已挪进 main，排在简介之后） */
  if (recSec) addFold(recSec.querySelector('h3'), $('#rec'), '展开 ▾', '收起 ▴', false);
  /* v66：手机端布局就绪后再兜底建一次胶囊（宿主 #speedbar 一定存在） */
  ensureSkipPill();
}
/* 手机端快捷操作栏：换线路 / 收藏 / 投屏 / 搜影片（原底部大搜索框的位置） */
function buildQuickBar(stage) {
  let bar = $('#mQuick');
  if (!bar) {
    bar = document.createElement('div');
    bar.id = 'mQuick'; bar.className = 'm-quickbar';
    bar.innerHTML = '<span class="qk" data-act="line">⇄ 换线路</span>'
      + '<span class="qk" data-act="fav" id="mQkFav">☆ 收藏</span>'
      + '<span class="qk" data-act="cast">📺 投屏</span>'
      + '<span class="qk" data-act="search">🔍 搜影片</span>';
    bar.addEventListener('click', e => {
      const t = e.target.closest('.qk'); if (!t) return;
      const a = t.dataset.act;
      if (a === 'line') openLinePanel();
      else if (a === 'fav') toggleFav();
      else if (a === 'cast') { if (typeof castOpen === 'function') castOpen(); }
      else if (a === 'search') goHome();
    });
  }
  const sb = $('#speedbar');
  if (sb) { if (sb.nextSibling !== bar) sb.parentNode.insertBefore(bar, sb.nextSibling); }
  else if (bar.parentNode !== stage) stage.appendChild(bar);
  updateQuickFav();
}
function updateQuickFav() {
  applyFavPermUI();
  const f = $('#mQkFav'); if (!f) return;
  f.classList.toggle('on', !!favOn);
  f.textContent = favOn ? '★ 已收藏' : '☆ 收藏';
}
window.addEventListener('mobchange', applyMobileLayout);

/* ========== v36：DLNA 投屏（局域网设备，手机端入口） ========== */
let CUR_PLAY_URL = '';    // 当前播放源直链（投屏用它，不能用带 token 的过滤地址）
let CAST_DEV = null;      // 当前投屏设备
function castClose() { const m = $('#castModal'); if (m) m.classList.add('hidden'); document.documentElement.classList.remove('modal-open'); }
function castOpen() {
  const m = $('#castModal'); if (!m) return;
  m.classList.remove('hidden');
  document.documentElement.classList.add('modal-open');   /* v59：同换源面板，手机端藏视频保弹层 */
  castScan();
}
let CAST_LIST = [];
function renderCastList() {
  const list = $('#castList'); if (!list) return;
  if (!CAST_LIST.length) {
    list.innerHTML = '<div class="empty" style="padding:18px 0">没找到投屏设备<div style="font-size:12px;margin-top:6px">电视/盒子需开机且与 NAS 同一局域网，也可点「手动添加」</div></div>';
    return;
  }
  list.innerHTML = '';
  CAST_LIST.forEach(d => {
    const row = document.createElement('div');
    row.className = 'cm-dev' + (CAST_DEV && CAST_DEV.controlUrl === d.controlUrl ? ' on' : '');
    const host = String(d.location || '').replace(/^https?:\/\//, '').split('/')[0];
    row.innerHTML = '<span class="cm-n">' + esc(d.name || '未知设备') + '</span><span class="cm-u">' + esc(host) + '</span>';
    row.onclick = () => castTo(d);
    list.appendChild(row);
  });
}
async function castScan() {
  const tip = $('#castTip'), list = $('#castList');
  if (list) list.innerHTML = '<div class="empty" style="padding:18px 0">扫描中…（约 3 秒）</div>';
  if (tip) tip.textContent = '正在局域网内查找可投屏设备…';
  try {
    const j = await api('/api/dlna/scan');
    CAST_LIST = j.list || [];
    renderCastList();
    if (tip) tip.textContent = CAST_LIST.length ? ('找到 ' + CAST_LIST.length + ' 台设备，点击即可投屏') : '没找到设备；可点「重新扫描」或「手动添加」';
  } catch (e) {
    if (list) list.innerHTML = '<div class="empty" style="padding:18px 0">扫描失败<div style="font-size:12px;margin-top:6px">' + esc(String(e.message || e)) + '</div></div>';
  }
}
/* SSDP 被路由器隔离时的兜底：手填设备描述地址 */
async function castManual() {
  const loc = prompt('输入投屏设备的描述地址（路由器里看到的设备 IP）\n例：http://192.168.1.100:49152/description.xml');
  if (!loc || !loc.trim()) return;
  try {
    const j = await api('/api/dlna/probe', { method: 'POST', body: { location: loc.trim() } });
    if (j.ok && j.device) {
      CAST_LIST = CAST_LIST.filter(d => d.controlUrl !== j.device.controlUrl);
      CAST_LIST.push(j.device);
      renderCastList();
      toast('已添加：' + (j.device.name || '设备'));
      const tip = $('#castTip'); if (tip) tip.textContent = '已添加设备，点击即可投屏';
    } else toast('添加失败：' + (j.error || '该设备没有投屏服务'));
  } catch (e) { toast('添加失败：网络异常'); }
}
async function castTo(d) {
  if (!CUR_PLAY_URL) { toast('当前还没有可投屏的播放地址'); return; }
  const tip = $('#castTip');
  if (tip) tip.textContent = '正在推送到「' + (d.name || '设备') + '」…';
  try {
    const j = await api('/api/dlna/cast', { method: 'POST', body: { controlUrl: d.controlUrl, url: CUR_PLAY_URL, title: TITLE || 'AIStream' } });
    if (j.ok) {
      CAST_DEV = d;
      toast('已投屏到 ' + (d.name || '设备'));
      if (tip) tip.textContent = '已在「' + (d.name || '') + '」播放；换集会自动用新地址，可点停止结束投屏';
      castScan();
    } else {
      toast('投屏失败');
      if (tip) tip.textContent = '投屏失败：' + (j.error || '设备拒绝');
    }
  } catch (e) { toast('投屏失败：网络异常'); }
}
async function castStop() {
  if (!CAST_DEV) { toast('当前没有正在投屏的设备'); return; }
  try { await api('/api/dlna/stop', { method: 'POST', body: { controlUrl: CAST_DEV.controlUrl } }); toast('已停止投屏'); } catch (e) {}
  CAST_DEV = null;
  const tip = $('#castTip'); if (tip) tip.textContent = '已停止投屏';
  castScan();
}
(function bindCast() {
  const btn = document.getElementById('pCast'); if (btn) btn.onclick = castOpen;
  const x = document.getElementById('castClose'); if (x) x.onclick = castClose;
  const rs = document.getElementById('castRescan'); if (rs) rs.onclick = castScan;
  const cm = document.getElementById('castManual'); if (cm) cm.onclick = castManual;
  const st = document.getElementById('castStop'); if (st) st.onclick = castStop;
  const m = document.getElementById('castModal');
  if (m) m.addEventListener('click', e => { if (e.target === m) castClose(); });
})();

init();
