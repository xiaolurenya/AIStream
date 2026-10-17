'use strict';
/*
 * AIStream · AI — 后端服务 (零依赖 Node 原生 http)
 * 功能：登录门禁 / TMDB 首页剧照 / 采集站搜索+解析聚合 / SSE 广播推送 /
 *       后台配置(解析地址·采集地址·用户·公告·全功能开关) / JSON 持久化
 * 端口 8890 · host 模式 · 持久化目录 /data
 */
const http = require('http');
const https = require('https');
const dgram = require('dgram');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const os = require('os');
const { URL } = require('url');
/* 注意：本网络 IPv6（CloudFront）可达而 IPv4 国际出口被墙，实测容器内 fetch 默认顺序
   （AAAA 优先）访问 TMDB 正常、ipv4first 反而 Connect Timeout——不要加 ipv4first！ */

const DATA_DIR = process.env.DATA_DIR || '/data';
const PORT = parseInt(process.env.PORT || '8890', 10);
const HOST = process.env.HOST || '0.0.0.0';
/* TMDB 凭据不内置。站长自己在容器环境变量 / .env 里填 TMDB_TOKEN 即可（可选）：
   不填则 TMDB 榜单类栏目不可用，采集站功能完全不受影响。
   申请：themoviedb.org 免费注册 → Settings → API → API Read Access Token (v4 auth) */
function tmdbToken() { return String(process.env.TMDB_TOKEN || ((config && config.tmdb && config.tmdb.token) || '')); }
const TMDB_API = 'https://api.themoviedb.org/3';
const IMG = 'https://image.tmdb.org/t/p/';
const PE = process.env.PEPPER || 'aistream_pepper_2026';
const PUBLIC_DIR = path.join(__dirname, 'public');

fs.mkdirSync(DATA_DIR, { recursive: true });
/* 图片代理磁盘缓存：海报/剧照等第三方图床 CDN 直链首次拉取后落盘，重复请求直接读盘返回，
   避免每次都打上游（海报在详情/feed/历史多处重复出现，缓存后秒回且省上行） */
const DIMGCACHE = path.join(DATA_DIR, 'dimg-cache');
try { fs.mkdirSync(DIMGCACHE, { recursive: true }); } catch (e) {}
const _dimgMem = new Map();   // md5 -> { t, cty }

/* ---------- 持久化 ---------- */
function jp(n) { return path.join(DATA_DIR, n); }
function load(n, d) { try { return JSON.parse(fs.readFileSync(jp(n), 'utf8')); } catch (e) { return d; } }
function save(n, o) {
  try {
    /* v73c：先写临时文件再 rename（同目录原子替换）。直接 writeFileSync 的后果实测见过：
       进程在写入中途崩溃 → config.json 截断 → 下次启动 load 失败回落默认配置
       → 站长在后台配的解析线/采集站/全部设置被默认值静默覆盖（18897 实丢 5 条解析线） */
    const tmp = jp(n + '.tmp');
    fs.writeFileSync(tmp, JSON.stringify(o, null, 2));
    fs.renameSync(tmp, jp(n));
  } catch (e) {}
}

let config = load('config.json', null);
if (!config) {
  config = {
    siteName: 'AIStream 影视',
    home: {
      tip: '本站为影视聚合程序演示，内容由站长自行接入的采集站提供。',
      /* 分发版：新装实例首页栏目留空。后台加了采集站后，buildHome 会自动把每个采集站
         当成一条栏目（见 buildHome 里 colsCfg 的兜底），不用先去配栏目就能看到内容 */
      columns: []
    },
    toggles: {
      antiScam: true,
      antiScamText: '⚠️ 防上当提示：本站全部免费，绝不要求充值 / 付费 / 加微信。凡以此为由索要钱财均为诈骗。'
    },
    announcement: { enabled: false, title: '', content: '' },
    lastBroadcast: null,
    parseList: [],
    collectList: []
  };
  save('config.json', config);
}
/* 旧配置(首页栏目为字符串数组)向前兼容 → 统一成对象模型（在 COLS 定义后调用） */
function normalizeConfig() {
  if (config.home && Array.isArray(config.home.columns)) {
    config.home.columns = config.home.columns.map(c => {
      if (typeof c === 'string') return { type: 'tmdb', key: c, label: (COLS[c] && COLS[c].label) || c };
      if (c && typeof c === 'object') return { type: c.type || 'tmdb', key: c.key, stationId: c.stationId, label: c.label || '' };
      return null;
    }).filter(Boolean);
  } else if (config.home) { config.home.columns = []; }
}
function saveConfig() { save('config.json', config); }

/* ================= v63：授权系统（GitHub 分发版用） =================
   设计目标：仓库里放的是「脱敏空壳 + 授权体系」，别人 clone 下来必须拿到授权码才能用。
   采用 RSA-2048 非对称签发——公钥随代码分发，私钥只保存在站长自己的 config.json 里
   （绝不进仓库）。所以拿到源码的人只能「验证」授权码，无法自己「签发」授权码。
   一个实例一个码：授权码里绑定了本机机器码，换机器/重装数据目录后需重新签发。 */
const LIC_PUB = `-----BEGIN PUBLIC KEY-----
MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEAynPbny3Ws7oINr6u+p0R
HF13r1O+4xhREhMYSMMwq84UItghBKaRAxVmTlvKPaw+Wnwz1WgAaey/CggJPdoU
yB66+LSKl86TKnkdaIgP7uONO1cObsEvb4Bh3QbgCfWcdXHiHLprBlQpV1BNWfpD
HOcPJVkx9Q2JSloPNIWcSGVMu3ToHc1YbcUCxP2DW7zzBcD3GoHdKSuhyJxq0aDc
38rIr+Io/ThmvwoyNVXsxm0DLd25dEuk9QSwBScwl8B51xthbd8qMUbpx9SCBzgc
EWTdb5epkKDAnWNTDItUg5MAkrZiTYDWltKWV5WYIq//H5Erti8S+E6/GsACVBYd
HwIDAQAB
-----END PUBLIC KEY-----`;
const LIC_PREFIX = 'AIST';
/* GitHub 分发前把这里改成你自己的联系方式 —— 它随代码走，别人装好的空壳激活页会显示它。
   自己在后台「授权管理 → ⑤ 前台联系方式」填的内容会覆盖这里。 */
const LIC_CONTACT = '进官方 TG 群 https://t.me/AIStreamTV 领取授权码（发机器码即可，永久码免费）。';
function b64u(buf) { return Buffer.from(buf).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, ''); }
function b64uDec(s) { return Buffer.from(String(s).replace(/-/g, '+').replace(/_/g, '/'), 'base64'); }
/* 机器码：由本机 MAC + 主机名 + 平台生成（确定性，同一台机器/同一个数据卷永远一致），
   首次运行写入 config.license.mid 后不再变化 */
function machineId() {
  const L = (config.license = config.license || {});
  if (L.mid && /^[0-9A-F]{16}$/.test(L.mid)) return L.mid;
  let mac = '';
  try {
    const ifs = os.networkInterfaces();
    for (const k of Object.keys(ifs)) {
      for (const it of (ifs[k] || [])) {
        if (it && !it.internal && it.mac && it.mac !== '00:00:00:00:00:00') { mac = it.mac; break; }
      }
      if (mac) break;
    }
  } catch (e) {}
  const raw = [mac || 'nomac', os.hostname(), os.platform(), os.arch(), os.cpus()[0] ? os.cpus()[0].model : ''].join('|');
  L.mid = crypto.createHash('sha1').update(raw).digest('hex').slice(0, 16).toUpperCase();
  saveConfig();
  return L.mid;
}
function fmtMid(m) { return String(m || '').replace(/(.{4})(?=.)/g, '$1-'); }
/* 解析授权码：只验格式/签名/停用/过期，【不比对机器码】。
   两个用途：① licVerify 在其上加本机 mid 比对；② 签发方收到激活回执时验码（回执来自别的机器）。
   返回 {ok, exp, mid, c, u, reason}：c=码里携带的联系方式，u=码里携带的激活回执上报地址 */
function licParseCode(code) {
  const s = String(code || '').trim().replace(/\s+/g, '');
  /* 分隔符用「.」：base64url 里可能有 - 和 _，用 - 分隔会被载荷/签名内部的 - 骗掉（贪婪匹配吃到签名里） */
  const m = s.match(/^AIST-([A-Za-z0-9_-]+)\.([A-Za-z0-9_-]+)$/);
  if (!m) return { ok: false, reason: '授权码格式不对' };
  let pl;
  try { pl = JSON.parse(b64uDec(m[1]).toString('utf8')); } catch (e) { return { ok: false, reason: '授权码无法解析' }; }
  if (!pl || pl.v !== 1 || !pl.m) return { ok: false, reason: '授权码内容不完整' };
  const pub = ((config.license || {}).publicKey) || LIC_PUB;
  let ok = false;
  try {
    const v = crypto.createVerify('RSA-SHA256');
    v.update(m[1]); v.end();
    ok = v.verify(pub, b64uDec(m[2]));
  } catch (e) { ok = false; }
  if (!ok) return { ok: false, reason: '授权码签名校验失败（不是本签发的）' };
  /* v63d：签发方可以停用某个码（对方只能在本机激活时感知；已激活的实例无法远程关停，属预期） */
  const rec = licFind(s);
  if (rec && rec.locked) return { ok: false, reason: '该授权码已被签发方停用，请联系签发方' };
  if (rec && rec.replacedBy) return { ok: false, reason: '该授权码已被换发新码，请使用新授权码' };
  const exp = Number(pl.e) || 0;
  if (exp && Date.now() > exp) return { ok: false, reason: '授权码已过期', exp };
  return { ok: true, exp, mid: String(pl.m), c: String(pl.c || ''), u: String(pl.u || '') };
}
/* 验证授权码：返回 {ok, exp, mid, c, u, reason}。exp=0 表示永久 */
function licVerify(code) {
  const v = licParseCode(code);
  if (!v.ok) return v;
  /* 一机一码：码里绑定的机器码必须等于本机 */
  if (v.mid !== machineId()) return { ok: false, reason: '授权码与本机机器码不符（一机一码）' };
  return v;
}
/* 签发授权码（需要私钥，只有站长这份 config 里有）。
   v73f：payload 可携带 c=签发方联系方式、u=签发方站点地址（激活回执上报用），
   都随签名走、改不了 —— 激活方拿到码就知道找谁联系、向哪上报「我激活了」 */
function licSign(mid, days, privPem, extra) {
  const pl = { v: 1, m: String(mid || '').toUpperCase().replace(/-/g, ''), e: days ? Date.now() + Math.max(1, Number(days)) * 86400000 : 0, n: crypto.randomBytes(6).toString('hex') };
  const x = extra || {};
  if (x.c) pl.c = String(x.c).slice(0, 300);
  if (x.u) pl.u = String(x.u).slice(0, 200);
  const body = b64u(Buffer.from(JSON.stringify(pl), 'utf8'));
  const s = crypto.createSign('RSA-SHA256');
  s.update(body); s.end();
  return { code: LIC_PREFIX + '-' + body + '.' + b64u(s.sign(privPem)), exp: pl.e };
}
/* v73f：激活回执 —— 激活方激活成功后向签发方站点上报（fire-and-forget，失败静默）。
   签发方据此在台账里记「该码已被激活 / 对方机器码」，不用再靠对方口头汇报 */
function licReport(siteUrl, code) {
  try {
    const u = new URL('/api/license/report', String(siteUrl));
    const mod = u.protocol === 'https:' ? https : http;
    const body = JSON.stringify({ code: String(code), mid: machineId(), at: Date.now() });
    const rq = mod.request(u, {
      method: 'POST', timeout: 8000,
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) }
    }, () => {});
    rq.on('timeout', () => rq.destroy());
    rq.on('error', () => {});
    rq.end(body);
    log('info', 'license', '激活回执已上报: ' + u.origin);
  } catch (e) { /* 上报地址无效等情况静默 */ }
}
/* v63d：授权码台账（只有签发方这台机器有）—— 记录签出去的每一个码，可锁定 / 改时长 / 删除 */
function licLedger() {
  const L = (config.license = config.license || {});
  if (!Array.isArray(L.issued)) L.issued = [];
  return L.issued;
}
function licFind(code) { const s = String(code || '').trim(); return licLedger().find(r => r && r.code === s) || null; }
/* 老版本 / 自签自用的码是直接写进 config.license.code 的，台账里没有 —— 补一条，
   否则「当前正在用的码」在台账里查不到、也没法停用和改时长。
   注意别在 licLedger() 里调用本函数：licVerify→licFind→licLedger 会递归。 */
let _licSelfDone = false;
function licEnsureSelf() {
  if (_licSelfDone) return;
  _licSelfDone = true;
  const L = (config.license = config.license || {});
  if (!L.code) return;
  if (!Array.isArray(L.issued)) L.issued = [];
  if (L.issued.some(r => r && r.code === L.code)) return;
  const v = licVerify(L.code);
  L.issued.unshift({
    id: (crypto.randomUUID() || '').slice(0, 8), mid: v.mid || machineId(), code: L.code,
    exp: v.exp || 0, createdAt: L.at || Date.now(), note: '本机当前使用',
    locked: false, activatedAt: L.at || 0, replacedBy: ''
  });
  saveConfig();
}
function licRecord(rec) {
  const L = (config.license = config.license || {});
  const arr = licLedger();
  arr.unshift(rec);
  L.issued = arr.slice(0, 500);   /* 上限 500 条，防止无限膨胀 */
  saveConfig();
}
function licStamp(t) { return t ? new Date(t + 8 * 3600e3).toISOString().slice(0, 16).replace('T', ' ') : ''; }
function licRecState(r) {
  if (r.locked) return { k: 'locked', txt: '已停用' };
  if (r.replacedBy) return { k: 'replaced', txt: '已换发' };
  if (r.activatedAt) return { k: 'used', txt: '已激活' };
  if (r.exp && Date.now() > r.exp) return { k: 'expired', txt: '已过期' };
  return { k: 'new', txt: '未使用' };
}
let _licMemo = { t: 0, ok: null };
/* 授权门禁没有开关、没有旁路：未激活就是 402，唯一的通行证是一张有效授权码。
   （曾经有过一个 LICENSE_OFF=1 的排障开关，后来意识到它等于给所有使用者留了个公开后门，
   加一个环境变量就架空整个授权体系——已彻底移除。本地测试请走正规流程：造密钥对 → 签码 → 激活。） */
function licActive() {
  const now = Date.now();
  if (_licMemo.ok !== null && now - _licMemo.t < 10000) return _licMemo.ok;
  const L = config.license || {};
  const ok = L.code ? licVerify(L.code).ok : false;
  _licMemo = { t: now, ok };
  return ok;
}
function licInfo() {
  const L = config.license || {};
  const v = L.code ? licVerify(L.code) : { ok: false, exp: 0, reason: '未激活' };
  return {
    active: !!v.ok,
    machineId: machineId(),
    machineIdFmt: fmtMid(machineId()),
    exp: v.exp || 0,
    expText: !v.exp ? '永久有效' : new Date(v.exp + 8 * 3600e3).toISOString().slice(0, 10),
    reason: v.ok ? '' : (v.reason || '未激活'),
    at: L.at || 0,
    hasPrivKey: !!(L.privateKey),
    /* 前台激活页展示的「怎么拿到授权码」：后台填的优先，否则用随代码分发的 LIC_CONTACT */
    contact: String(L.contact || LIC_CONTACT || ''),
    /* v73f：签发方站点地址 —— 嵌进签出的码里，对方激活成功后向这里上报回执（台账才看得到激活时间） */
    siteUrl: String(L.siteUrl || '')
  };
}

let users = load('users.json', []);
function saveUsers() { save('users.json', users); }
if (users.length === 0) {
  users.push({
    id: crypto.randomUUID(),
    username: 'admin',
    passwordHash: crypto.createHash('sha256').update('admin123' + PE).digest('hex'),
    role: 'admin',
    createdAt: Date.now()
  });
  saveUsers();
  console.log('[init] 默认管理员已创建 -> admin / admin123  请尽快修改密码');
}

/* ---------- 观看历史 / 收藏（per user，落盘） ---------- */
let hist = load('history.json', {});
let favs = load('fav.json', {});
function saveHist() { save('history.json', hist); }
function saveFavs() { save('fav.json', favs); }

const sessions = {}; // token -> {userId, createdAt}
const sseClients = new Set();
const SESSION_TTL = 7 * 24 * 3600 * 1000;   // 会话 7 天过期
const loginFails = new Map();               // ip -> {n, until}，防暴力破解
setInterval(() => {
  const now = Date.now();
  for (const t in sessions) if (now - (sessions[t].createdAt || 0) > SESSION_TTL) delete sessions[t];
  for (const k of loginFails.keys()) { const v = loginFails.get(k); if (v.until && v.until < now - 60000) loginFails.delete(k); }
}, 3600 * 1000);

/* ---------- 系统日志（内存环形 + 磁盘持久） ---------- */
const LOG_MAX = 1200;
let LOGS = [];
try { LOGS = JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'logs.json'), 'utf8')); } catch (e) {}
let logSaveTimer = null;
function log(level, tag, msg, extra) {
  try {
    const e = { t: Date.now(), l: level, g: tag, m: String(msg).slice(0, 400) };
    if (extra != null && extra !== '') e.x = String(extra).slice(0, 300);
    LOGS.push(e);
    if (LOGS.length > LOG_MAX) LOGS = LOGS.slice(-LOG_MAX);
    if (!logSaveTimer) logSaveTimer = setTimeout(() => {
      logSaveTimer = null;
      try { fs.writeFileSync(path.join(DATA_DIR, 'logs.json'), JSON.stringify(LOGS)); } catch (e) {}
    }, 2000);
  } catch (e) {}
}

/* ---------- 工具 ---------- */
function sha(p) { return crypto.createHash('sha256').update(p + PE).digest('hex'); }
function uid() { return crypto.randomUUID(); }
function getUser(id) { return users.find(u => u.id === id); }
function sendJSON(res, code, obj) {
  /* 接口响应一律不缓存：否则浏览器拿旧 /api/admin/config，重登后台看到的还是上次的配置（表现为「保存后又复原」） */
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(obj));
  try {
    const rq = res.req;
    if (rq) {
      const pp = (rq.url || '').split('?')[0];
      if (pp.startsWith('/api/') && pp !== '/api/dimg' && pp !== '/api/public') {
        const ms = Date.now() - (rq._t0 || Date.now());
        const lv = code >= 500 ? 'error' : code >= 400 ? 'warn' : 'info';
        if (lv !== 'info' || !pp.startsWith('/api/history')) {
          log(lv, 'api', rq.method + ' ' + rq.url + ' -> ' + code + ' (' + ms + 'ms)', (obj && obj.error) || '');
        }
      } else if (code >= 400) {
        log('warn', 'http', rq.method + ' ' + (rq.url || '') + ' -> ' + code);
      }
    }
  } catch (e) {}
}
function readBody(req) {
  return new Promise((resolve) => {
    let d = '';
    req.on('data', c => d += c);
    req.on('end', () => { try { resolve(JSON.parse(d || '{}')); } catch (e) { resolve({}); } });
  });
}
function authUser(req, u) {
  const h = req.headers['authorization'] || '';
  const m = h.match(/^Bearer\s+(.+)$/i);
  if (m) { const s = sessions[m[1]]; if (s && Date.now() - (s.createdAt || 0) < SESSION_TTL) return getUser(s.userId) || null; }
  /* EventSource 不支持自定义头 → SSE 用 ?token= 兜底 */
  if (u) { const t = u.searchParams.get('token'); if (t) { const s = sessions[t]; if (s) return getUser(s.userId) || null; } }
  return null;
}
function isAdmin(u) { return u && u.role === 'admin'; }
/* 取当前请求的会话 token（img/video 标签带不了 Authorization 头，需要拼进 URL） */
function reqToken(req, u) {
  const m = (req.headers['authorization'] || '').match(/^Bearer\s+(.+)$/i);
  if (m) return m[1];
  return (u && u.searchParams && u.searchParams.get('token')) || '';
}
/* 读取请求 Cookie（用于页面级登录门禁：未登录时不下发完整 app.js） */
function getCookie(req, name) {
  const c = req.headers.cookie || '';
  const m = c.match(new RegExp('(?:^|; )' + name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '=([^;]*)'));
  return m ? decodeURIComponent(m[1]) : '';
}
/* 登录/注册成功下发 HttpOnly 会话 Cookie；页面门禁据此切换极简登录页，JS 不直接读它（防 XSS 泄露） */
const SID_NAME = 'aistream_sid';
function sidCookie(token, expire) {
  return SID_NAME + '=' + token + '; Path=/; Max-Age=' + (expire ? 0 : 7 * 24 * 3600) + '; HttpOnly; SameSite=Lax';
}
function sseSend(res, obj) { try { res.write('data: ' + JSON.stringify(obj) + '\n\n'); } catch (e) {} }
const detailCache = new Map();   // 上游详情兜底缓存：id -> {t, d, e}
function broadcast(obj) { for (const c of sseClients) sseSend(c, obj); }
/* 广播连推定时器（v41.2）：管理员启用广播后按 count×interval(秒/分/时) 周期性 SSE 推送，
   即便用户刷新也由服务端持续推，达到"连续推送"效果；count 用尽或关闭即停。 */
let BC_TIMER = null;
function stopBcTimer() { if (BC_TIMER) { clearInterval(BC_TIMER); BC_TIMER = null; } }
function startBcTimer() {
  stopBcTimer();
  const b = config.broadcast;
  if (!b || !b.enabled || !b.count || b.count < 1) return;
  const unitMs = { s: 1000, m: 60000, h: 3600000 }[b.intervalUnit] || 3600000;
  const iv = Math.max(1000, (Number(b.interval) || 1) * unitMs);
  let n = 0;
  const tick = () => {
    if (!config.broadcast || !config.broadcast.enabled) { stopBcTimer(); return; }
    const b2 = config.broadcast;
    const msg = { title: b2.title || '系统通知', content: b2.content || '', level: 'info', time: Date.now() };
    config.lastBroadcast = msg; saveConfig();
    broadcast({ type: 'broadcast', data: msg });
    if (++n >= b2.count) stopBcTimer();
  };
  tick();                                   // 立即首推
  BC_TIMER = setInterval(tick, iv);
}

/* ---------- 上游资源库核心（自建签名 API，地址/密钥由站长自行填写） ---------- */
/* ---------- IPTV 直播配置（后台开关/地址；EPG 仅存储前台不显示） ---------- */
if (!config.iptv) {
  config.iptv = {
    enabled: false,
    m3uUrl: '',
    epgUrl: '',
    epgEnabled: true
  };
  saveConfig();
}
/* v44：多直播源。老配置只有单个 m3uUrl → 迁移为 sources[0] */
if (!Array.isArray(config.iptv.sources)) {
  config.iptv.sources = (config.iptv.m3uUrl ? [{ id: 's1', name: '默认源', url: config.iptv.m3uUrl, enabled: true }] : []);
  saveConfig();
}
/* v46：清理 v45 废弃的 sourcePerm（源级权限与会员等级重复，已由分组权限 groupPerm 取代） */
if (config.iptv.sourcePerm) { delete config.iptv.sourcePerm; saveConfig(); }
/* v45b：分组权限 groupPerm = { users:{用户:{分组:bool}}, levels:{等级:{分组:bool}} }，显式 true/false。
   等级未设置 = 默认允许；用户未设置 = 继承所属会员等级；以后新增的分组默认可看 */
if (!config.iptv.groupPerm || typeof config.iptv.groupPerm !== 'object' || Array.isArray(config.iptv.groupPerm)) { config.iptv.groupPerm = { users: {}, levels: {} }; saveConfig(); }
if (!config.iptv.groupPerm.users) config.iptv.groupPerm.users = {};
if (!config.iptv.groupPerm.levels) config.iptv.groupPerm.levels = {};
/* 某用户是否可看某个频道分组：管理员恒开；用户显式设置 > 继承会员等级 > 默认允许 */
function iptvGroupAllowed(user, group) {
  if (!user || user.role === 'admin') return true;
  const gp = (config.iptv || {}).groupPerm || {};
  const g = String(group || '');
  const urow = (gp.users || {})[user.username];
  if (urow && urow[g] !== undefined) return urow[g] === true;
  const lv = vipLevelObj(user);
  const lrow = lv ? (gp.levels || {})[String(lv.level)] : null;
  if (lrow && lrow[g] !== undefined) return lrow[g] === true;
  return true;
}
/* v46：清理孤儿权限——viewPerm/groupPerm 里已不存在用户的残留（删除用户时也会同步清理） */
(function pruneOrphans() {
  const names = new Set(users.map(x => x.username));
  let touched = false;
  const vp = (config.viewPerm = config.viewPerm || { users: {} }).users || {};
  for (const k of Object.keys(vp)) if (!names.has(k)) { delete vp[k]; touched = true; }
  const gp = (config.iptv || {}).groupPerm || {};
  for (const k of Object.keys(gp.users || {})) if (!names.has(k)) { delete gp.users[k]; touched = true; }
  if (touched) saveConfig();
})();
/* IPTV 访问控制（v30）：统一走栏目权限 viewPerm（后台用户级 IPTV 开关列已移除，避免两套开关打架） */
function iptvAllowed(user) {
  const conf = config.iptv || {};
  if (!conf.enabled) return false;
  if (!user) return false;
  if (user.role === 'admin') return true;
  /* 会员等级特权：该等级勾了 IPTV 即放行（无需再逐用户勾栏目权限） */
  if ((config.vip || {}).enabled !== false && vipLevelObj(user).iptv) return true;
  return viewAllowed(user, 'iptv');
}

/* ---------- 注册开关 + 新用户默认权限 + 栏目级权限（v29） ---------- */
/* 新用户默认权限模板：跳过片头/片尾属会员特权，普通新用户默认关闭（可由会员等级或积分兑换解锁） */
const REG_DEF_PERM = { rec: true, movie: true, series: true, anime: true, variety: true, short: true, iptv: false, history: true, fav: true, skipIntro: false, skipOutro: false };
if (!config.reg) { config.reg = { enabled: true, defaultPerm: REG_DEF_PERM }; saveConfig(); }
else if (!config.reg.defaultPerm) { config.reg.defaultPerm = REG_DEF_PERM; saveConfig(); }
/* 「跳过片头/片尾」是后加的会员特权：老的默认权限模板里没这两个键 → 补成 false（特权默认关闭，靠会员等级/兑换解锁） */
if (config.reg.defaultPerm) {
  let _c = false;
  if (config.reg.defaultPerm.skipIntro === undefined) { config.reg.defaultPerm.skipIntro = false; _c = true; }
  if (config.reg.defaultPerm.skipOutro === undefined) { config.reg.defaultPerm.skipOutro = false; _c = true; }
  if (_c) saveConfig();
}
if (!config.viewPerm) { config.viewPerm = { users: {} }; saveConfig(); }
const VIEW_KEYS = ['rec', 'movie', 'series', 'anime', 'variety', 'short', 'iptv', 'history', 'fav', 'skipIntro', 'skipOutro'];
const VIEW_LABELS = { rec: '推荐', movie: '电影', series: '剧集', anime: '动漫', variety: '综艺', short: '短剧', iptv: 'IPTV', history: '历史记录', fav: '我的收藏', skipIntro: '跳过片头', skipOutro: '跳过片尾' };
/* v46：注册权限模板 → 单个用户的 viewPerm 行（特权键缺省=关，其余缺省=开）。
   注册、后台添加用户、一键应用模板三处共用同一套语义，避免各写各的 */
function regPermRow() {
  const dperm = (config.reg || {}).defaultPerm || {};
  const row = {};
  VIEW_KEYS.forEach(k => { row[k] = (k === 'skipIntro' || k === 'skipOutro') ? (dperm[k] === true) : (dperm[k] !== false); });
  return row;
}
/* 栏目权限：config.viewPerm.users[username][key]，未配置=全部允许；管理员恒开 */
function viewAllowed(user, key) {
  if (!user) return true;
  if (user.role === 'admin') return true;
  /* 积分兑换获得的限时权限优先放行 */
  if (grantActive(user, key)) return true;
  /* 会员等级访问权限：该等级勾选了此栏目即直接放行（会员特权，无视用户单独设置）
     v47 重要修正：只对「真会员等级」（Lv>=1）生效。Lv0 = 普通用户，不是会员，
     它的 perm 只是缺省模板，绝不能反过来覆盖管理员的单独设置——
     否则只要 Lv0 勾了某项（历史遗留配置里 Lv0 就被勾上了 rec/movie/series/anime/variety/fav），
     所有普通用户都会被强行放行，管理员在「注册默认权限 / 用户单独权限」里怎么取消勾选都没用，
     表现为「取消勾选保存后又全勾上」「新账号权限是满的」。 */
  const lv = ((config.vip || {}).enabled !== false) ? (vipLevelObj(user) || {}) : {};
  const lp = lv.perm;
  if (lp && Number(lv.level) > 0 && lp[key] === true) return true;
  const m = (config.viewPerm && config.viewPerm.users || {})[user.username];
  if (!m) return (lp && lp[key] === false) ? false : true;
  return m[key] !== false;
}

/* ---------- 广告联盟 / 积分 / 会员 / 邀请注册（request E） ---------- */
function featureDefaults() {
  return {
    ads: {
      enabled: false,
      network: 'custom',                 // custom=自定义图片广告 | code=粘贴联盟代码(HTML/JS)
      items: [],                         // {id,title,img,link,slots:['sidebar'|'pause'],weight,enabled}
      code: { sidebar: '', pause: '' },
      pause: { enabled: false, delay: 800, closeable: true, autoClose: 0 },
      sidebar: { enabled: false, position: 'belowDetail', width: '100%', height: 'auto', max: 2 }
    },
    points: {
      enabled: true,
      checkin: { base: 10, streakBonus: 5, streakMax: 7 },
      invite: { perInvite: 50, dailyCap: 200, requireRegister: false },
      watch: { pointsPerMin: 1, dailyCapMin: 120 },
      vipMul: { '0': 1, '1': 1.5, '2': 2 }
    },
    vip: {
      enabled: true,
      /* perm = 该等级「额外解锁」的栏目：勾选的栏目直接放行（无视用户单独设置），未勾选=仍按用户单独设置。
         Lv0 默认空（普通用户完全按单独设置，避免等级白名单覆盖用户限制） */
      levels: [
        { level: 0, name: '普通用户', noAds: false, pointMul: 1, iptv: false, points: 0, perm: {} },
        /* 会员等级默认解锁「跳过片头/片尾」特权（普通用户 Lv0 不给），后台可自行取消勾选 */
        { level: 1, name: 'VIP会员', noAds: false, pointMul: 1.5, iptv: false, points: 500, perm: { skipIntro: true, skipOutro: true } },
        { level: 2, name: 'SVIP会员', noAds: true, pointMul: 2, iptv: true, points: 2000, perm: { iptv: true, skipIntro: true, skipOutro: true } }
      ]
    },
    /* 积分兑换：items[] = {id,title,desc,kind:'vip'|'perm',level,permKey,days,cost,stock(-1无限),enabled} */
    redeem: { enabled: true, items: [] }
  };
}
/* 老 config.json 缺字段时补齐（只加不覆盖，改完才落盘） */
function ensureFeatureDefaults() {
  let changed = false;
  const d = featureDefaults();
  const merge = (dst, src) => {
    for (const k in src) {
      if (src[k] && typeof src[k] === 'object' && !Array.isArray(src[k])) {
        if (!dst[k] || typeof dst[k] !== 'object' || Array.isArray(dst[k])) { dst[k] = src[k]; changed = true; }
        else merge(dst[k], src[k]);
      } else if (dst[k] === undefined) { dst[k] = src[k]; changed = true; }
    }
  };
  for (const k of ['ads', 'points', 'vip']) {
    if (!config[k]) { config[k] = d[k]; changed = true; }
    else merge(config[k], d[k]);
  }
  if (!config.redeem) { config.redeem = d.redeem; changed = true; }
  /* 老等级数据补「积分门槛」字段（成长进度条用；数组不做深 merge，这里显式补） */
  const PT_DEF = { 0: 0, 1: 500, 2: 2000 };
  ((config.vip || {}).levels || []).forEach(l => {
    if (l.points === undefined) { l.points = PT_DEF[l.level] != null ? PT_DEF[l.level] : 0; changed = true; }
    /* 老等级补「访问权限」字段：默认只保留 IPTV 特权（与该等级 iptv 标志一致），其余空白=按用户单独设置 */
    if (!l.perm || typeof l.perm !== 'object') {
      l.perm = l.iptv ? { iptv: true } : {};
      changed = true;
    }
    /* 新增「跳过片头/片尾」会员特权：会员等级(Lv>=1)默认解锁；只补未定义的键，不覆盖管理员已改的勾选 */
    if (Number(l.level) >= 1) {
      if (l.perm.skipIntro === undefined) { l.perm.skipIntro = true; changed = true; }
      if (l.perm.skipOutro === undefined) { l.perm.skipOutro = true; changed = true; }
    }
  });
  if (changed) saveConfig();
}
ensureFeatureDefaults();
/* 当天键（本地时区 YYYY-MM-DD） */
function dayKey(d) { const x = d || new Date(); return x.getFullYear() + '-' + String(x.getMonth() + 1).padStart(2, '0') + '-' + String(x.getDate()).padStart(2, '0'); }
/* 用户当日计数器（跨天自动重置）：观看分钟/秒累计、邀请奖励、签到次数 */
function userDaily(usr) { const k = dayKey(); if (!usr.daily || usr.daily.date !== k) usr.daily = { date: k, watchMin: 0, watchSec: 0, invitePts: 0, checkins: 0 }; return usr.daily; }
/* 会员等级对象（过期自动回落 0） */
function vipLevelObj(usr) {
  const v = config.vip || { levels: [] };
  let lv = (usr.vip && Number(usr.vip.level)) || 0;
  if (usr.vip && usr.vip.expire && Number(usr.vip.expire) < Date.now()) lv = 0;
  const hit = (v.levels || []).find(x => Number(x.level) === lv);
  return hit || (v.levels || [])[0] || { level: 0, name: '普通用户', noAds: false, pointMul: 1 };
}
function vipMulOf(usr) { const m = Number(vipLevelObj(usr).pointMul); return m > 0 ? m : 1; }
function vipNoAds(usr) { return !!vipLevelObj(usr).noAds; }
function vipInfo(usr) {
  const o = vipLevelObj(usr);
  const exp = (usr.vip && Number(usr.vip.expire)) || 0;
  return { level: o.level, name: o.name, noAds: !!o.noAds, pointMul: Number(o.pointMul) || 1, expire: exp, days: exp ? Math.max(0, Math.ceil((exp - Date.now()) / 86400000)) : 0 };
}
/* 成长进度：当前等级 + 下一级积分门槛 + 还差多少分（供首页左下用户卡展示，兑换即升级） */
function growthInfo(usr) {
  const v = config.vip || { levels: [] };
  const cur = vipLevelObj(usr);
  const pts = usr.points || 0;
  const cands = (v.levels || []).filter(x => Number(x.level) > Number(cur.level) && (Number(x.points) || 0) > 0)
    .sort((a, b) => (Number(a.points) - Number(b.points)) || (Number(a.level) - Number(b.level)));
  const next = cands[0] || null;
  const perInv = Math.max(1, Number(((config.points || {}).invite || {}).perInvite)) || 1;
  if (!next) return { level: cur.level, name: cur.name, points: pts, progress: 100, need: 0, inviteNeed: 0, next: null };
  const from = Number(cur.points) || 0, to = Number(next.points) || 0;
  const need = Math.max(0, to - pts);
  const progress = to > from ? Math.max(0, Math.min(100, Math.round((pts - from) / (to - from) * 100))) : 0;
  return { level: cur.level, name: cur.name, points: pts, progress, need, inviteNeed: Math.ceil(need / perInv), next: { level: next.level, name: next.name, points: to } };
}
/* 积分兑换获得的限时权限是否有效 */
function grantActive(usr, key) {
  if (!usr.grants || !usr.grants.length) return false;
  const g = usr.grants.find(x => x.key === key);
  return !!(g && (!g.expire || Number(g.expire) > Date.now()));
}
/* 加积分（按会员倍率），返回实际到账分 */
function addPoints(usr, raw, reason) {
  if (!(raw > 0)) return 0;
  const mul = vipMulOf(usr);
  const gain = Math.max(1, Math.round(raw * mul));
  usr.points = (usr.points || 0) + gain;
  log('info', 'points', '积分 ' + usr.username + ' +' + gain + '（' + reason + ' x' + mul + '）');
  return gain;
}
/* 邀请码（懒生成，8 位大写十六进制，全局唯一） */
function ensureInviteCode(usr) {
  if (usr.inviteCode) return usr.inviteCode;
  let c = '';
  do { c = crypto.randomBytes(4).toString('hex').toUpperCase(); } while (users.some(x => x.inviteCode === c));
  usr.inviteCode = c; saveUsers();
  return c;
}
/* 观看累计积分：只累计正常播放推进（<=30s 增量，防拖动/切集跳变），满 60s 计 1 分钟，受每日上限约束 */
function accWatchPoints(usr, id, pos) {
  const pc = config.points || {};
  if (!pc.enabled || !(pc.watch && Number(pc.watch.pointsPerMin) > 0)) return 0;
  const d = userDaily(usr), w = pc.watch;
  const cap = Number(w.dailyCapMin) > 0 ? Number(w.dailyCapMin) : 9999;
  if (d.watchMin >= cap) return 0;
  if (!usr.watchAcc || usr.watchAcc.id !== id) { usr.watchAcc = { id: id, pos: Number(pos) || 0, acc: 0 }; return 0; }
  const delta = (Number(pos) || 0) - usr.watchAcc.pos;
  usr.watchAcc.pos = Number(pos) || 0;
  /* 只累计正常播放推进：单次增量封顶 30s（防拖动进度条/切集跳变刷分，但暂停续播等大跳变仍按 30s 计，不丢分） */
  if (delta > 0) usr.watchAcc.acc += Math.min(delta, 30);
  let gained = 0;
  while (usr.watchAcc.acc >= 60 && d.watchMin < cap) { usr.watchAcc.acc -= 60; d.watchMin += 1; gained += Number(w.pointsPerMin); }
  if (gained) { addPoints(usr, gained, '观看奖励'); saveUsers(); }
  return gained;
}

/* m3u 频道解析缓存 + 白名单（流代理只放行来自已解析清单的地址，防开放代理） */
const IPTV_CACHE = new Map();   // m3uUrl -> { t, channels }
const IPTV_ALLOW = new Set();   // 允许代理的流地址
const IPTV_LOGO = new Set();    // 允许代理的台标地址（同样只认当前清单，防开放代理）
const LOGO_CACHE = new Map();   // logoUrl -> { t, ct, buf }（台标基本不变，缓存 1h）
const IPTV_CID = new Map();     // v31 防窥：不透明频道 id -> 真实流地址（F12 只见 ?ch=xxx）
const IPTV_LOGO_CID = new Map(); // 不透明台标 id -> logo 地址
function cidOf(s) { return crypto.createHash('sha1').update(String(s)).digest('hex').slice(0, 16); }
function parseM3U(text) {
  const out = [];
  let cur = null;
  for (const line0 of String(text).split(/\r?\n/)) {
    const line = line0.trim();
    if (!line) continue;
    if (line.startsWith('#EXTINF')) {
      const attrs = {};
      for (const m of (line.match(/[a-zA-Z0-9\-_]+="[^"]*"/g) || [])) {
        const i = m.indexOf('=');
        attrs[m.slice(0, i)] = m.slice(i + 1).replace(/"/g, '');
      }
      const nm = line.split(',').slice(1).join(',').trim();
      cur = { name: nm || attrs['tvg-name'] || '未命名频道', logo: attrs['tvg-logo'] || '', group: attrs['group-title'] || '未分组', tid: attrs['tvg-id'] || '', url: '' };
    } else if (line[0] !== '#') {
      if (cur) { cur.url = line; out.push(cur); cur = null; }
    }
  }
  return out.filter(c => c.url);
}
/* 指向本机自己的域名（NAT 回环）在容器内不通，自动改写 127.0.0.1。
   v57：本机局域网 IP 同样回环不通——容器访问宿主机 LAN IP 会被宿主机挡掉，
   而 127.0.0.1 能直达（docker 发布的端口也监听在 127.0.0.1）。所以一并把本机 IP 改写成 127.0.0.1。 */
let LOCAL_IPS = [];
try {
  const os = require('os');
  const nets = os.networkInterfaces() || {};
  for (const k in nets) for (const it of (nets[k] || [])) {
    if (it && it.family === 'IPv4' && !it.internal) LOCAL_IPS.push(it.address);
  }
} catch (e) { LOCAL_IPS = []; }
function isLocalUrl(u) {
  const s = String(u || '');
  return LOCAL_IPS.some(ip => s.indexOf('//' + ip + ':') >= 0 || s.indexOf('//' + ip + '/') >= 0);
}
function iptvFix(u) {
  let s = String(u || '');
  for (const ip of LOCAL_IPS) {
    s = s.split('//' + ip + ':').join('//127.0.0.1:').split('//' + ip + '/').join('//127.0.0.1/');
  }
  return s;
}
async function fetchIptv(url, timeoutMs) {
  const ctrl = new AbortController(); const t = setTimeout(() => ctrl.abort(), timeoutMs || 20000);
  try {
    const target = isLocalUrl(url) ? iptvFix(url) : url;
    const r = await fetch(target, { signal: ctrl.signal, headers: { 'User-Agent': 'Mozilla/5.0' } });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    return r;
  } catch (e) {
    const alt = iptvFix(url);
    if (alt !== url) {
      const r2 = await fetch(alt, { signal: AbortSignal.timeout(timeoutMs || 20000), headers: { 'User-Agent': 'Mozilla/5.0' } });
      if (!r2.ok) throw new Error('HTTP ' + r2.status);
      return r2;
    }
    throw e;
  } finally { clearTimeout(t); }
}
/* ---------- EPG 节目单（xmltv）：频道当前/下一档节目，30min 缓存 ---------- */
const EPG_CACHE = new Map();   // epgUrl -> { t, now:{urlKey:{t,next}}, chName:{norm:progKey} }
function normCh(s) { return String(s || '').toLowerCase().replace(/[\s\-_/|（）()]/g, ''); }
async function epgNow(epgUrl) {
  if (!epgUrl) return {};
  const hit = EPG_CACHE.get(epgUrl);
  if (hit && Date.now() - hit.t < 1800000) return hit.now;
  let text = '';
  try {
    const r = await fetchIptv(epgUrl, 25000);
    text = await r.text();
  } catch (e) { log('warn', 'iptv', 'EPG 拉取失败: ' + (e.message || e)); return hit ? hit.now : {}; }
  /* 部分源的「EPG 地址」实际返回的是 M3U 频道清单（如 playback.xml），并非 xmltv 节目单 → 跳过 */
  if (/^\s*#EXTM3U/.test(text)) {
    log('warn', 'iptv', 'EPG 地址返回的是 M3U 清单而非 xmltv 节目单，EPG 匹配跳过（不影响频道播放）');
    EPG_CACHE.set(epgUrl, { t: Date.now(), now: {}, chName: {} });
    return {};
  }
  /* xmltv: <channel id=".."><display-name>名</display-name>..  <programme start=".." stop=".." channel=".."><title>节目</title>
     v31 修复：① display-name 带 lang 属性；② 本源 <programme> 的 channel 属性在 start/stop 之前 ——
     旧正则按「start→stop→channel」固定顺序匹配导致 0 命中，改为通用属性解析 */
  const chName = {};
  const chRe = /<channel[^>]*id="([^"]+)"[^>]*>([\s\S]*?)<\/channel>/g;
  let m;
  while ((m = chRe.exec(text))) {
    const dn = (m[2].match(/<display-name[^>]*>([^<]*)<\/display-name>/) || [])[1] || '';
    if (dn) { chName[m[1]] = dn; chName[normCh(dn)] = m[1]; }
  }
  const nowTs = Date.now();
  const prog = {};   // channelId -> [{s,st,t}]
  const prRe = /<programme\s+([^>]*?)>([\s\S]*?)<\/programme>/g;
  const ts = x => { const s = String(x); const d = new Date(s.slice(0, 4) + '-' + s.slice(4, 6) + '-' + s.slice(6, 8) + 'T' + (s.slice(8, 10) || '00') + ':' + (s.slice(10, 12) || '00') + ':' + (s.slice(12, 14) || '00') + '+08:00'); return isNaN(d) ? 0 : d.getTime(); };
  while ((m = prRe.exec(text))) {
    const A = m[1];
    const chA = (A.match(/channel="([^"]*)"/) || [])[1] || '';
    const st0 = ts((A.match(/start="([^"]*)"/) || [])[1]);
    const st1 = ts((A.match(/stop="([^"]*)"/) || [])[1]);
    if (!chA || !st0 || !st1 || st1 < nowTs - 6 * 3600e3 || st0 > nowTs + 6 * 3600e3) continue;
    const title = ((m[2].match(/<title[^>]*>([^<]*)<\/title>/) || [])[1] || '').trim();
    if (!title) continue;
    (prog[chA] = prog[chA] || []).push({ s: st0, st: st1, t: title });
  }
  const now = {};
  for (const cid of Object.keys(prog)) {
    const list = prog[cid].sort((a, b) => a.s - b.s);
    const cur = list.find(x => x.s <= nowTs && x.st > nowTs);
    if (!cur) continue;
    const nx = list.find(x => x.s >= cur.st);
    /* v32：ce=本档结束时间戳，ns=下档开始时间戳（前台显示「20:00 接下来」） */
    now[cid] = { t: cur.t, ce: cur.st, next: nx ? nx.t : '', ns: nx ? nx.s : 0 };
  }
  EPG_CACHE.set(epgUrl, { t: Date.now(), now, chName });
  return now;
}

async function iptvChannels(m3uUrl) {
  const hit = IPTV_CACHE.get(m3uUrl);
  if (hit && Date.now() - hit.t < 600000) return hit.channels;
  let text;
  {
    const r = await fetchIptv(m3uUrl, 20000);
    text = await r.text();
  }
  const ch = parseM3U(text);
  if (!ch.length) throw new Error('清单解析为空（不是有效的 M3U？）');
  for (const c of ch) c.cid = cidOf(c.url);
  IPTV_CACHE.set(m3uUrl, { t: Date.now(), channels: ch });
  return ch;
}
/* v44：合并全部启用的直播源（多源聚合）。每个频道带上 src/srcName；
   同时重建流代理白名单/频道映射/台标映射，并记录 cid->源 供按源权限校验 */
const IPTV_CGROUP = new Map(); // v45b：频道cid -> 分组名（按分组权限校验流代理）
async function iptvAllChannels() {
  const conf = config.iptv || {};
  let srcs = (conf.sources || []).filter(s => s && s.enabled !== false && s.url);
  if (!srcs.length && conf.m3uUrl) srcs = [{ id: 's1', name: '默认源', url: conf.m3uUrl, enabled: true }];
  const merged = [];
  const seen = new Set();
  for (const s of srcs) {
    let ch = [];
    try { ch = await iptvChannels(s.url); }
    catch (e) { log('warn', 'iptv', '直播源拉取失败「' + (s.name || s.id) + '」: ' + (e.message || e)); continue; }
    /* v57：源上手动指定了分组 → 该源全部频道统一归到这个分组（覆盖清单自带的 group-title） */
    const forced = String((s && s.group) || '').trim();
    for (const c of ch) {
      if (seen.has(c.url)) continue;   /* 多源同地址去重，先到先得 */
      seen.add(c.url);
      const one = Object.assign({}, c, { src: s.id, srcName: s.name || s.id });
      if (forced) one.group = forced;
      merged.push(one);
    }
  }
  IPTV_ALLOW.clear(); IPTV_CID.clear(); IPTV_LOGO_CID.clear(); IPTV_CGROUP.clear();
  for (const c of merged) {
    IPTV_ALLOW.add(c.url); IPTV_CID.set(c.cid, c.url); IPTV_CGROUP.set(c.cid, c.group || '');
    if (c.logo) { const lc = cidOf(c.logo); c.lcid = lc; IPTV_LOGO_CID.set(lc, c.logo); }
  }
  return merged;
}

function upCfg() { return Object.assign({ base: '', key: '', cookie: '', mirrors: [] }, config.upstream || {}); }
function upCandidates() {
  const c = upCfg();
  const list = [c.base].concat(Array.isArray(c.mirrors) ? c.mirrors : []).map(x => String(x || '').replace(/\/+$/, '')).filter(Boolean);
  return list;
}
function upSign(method, full, ts, nonce) {
  return crypto.createHmac('sha256', String(upCfg().key || ''))
    .update(method + '\n' + full + '\n' + ts + '\n' + nonce, 'utf8').digest('hex');
}
/* v60：上游连通自检。传入独立 cfg（支持「先测后存」，不用先写进 config 就能验证新地址/新密钥）。
   逐个候选（主地址 + 镜像）打 /v1/feed/home，返回每个候选的真实状态码与耗时，第一个成功即停。 */
async function probeUpstream(cfg) {
  const key = String((cfg && cfg.key) || '');
  const cands = [cfg.base].concat(Array.isArray(cfg.mirrors) ? cfg.mirrors : [])
    .map(x => String(x || '').replace(/\/+$/, '')).filter(Boolean);
  const out = [];
  for (const base of cands) {
    const t0 = Date.now();
    const ts = String(Date.now());
    const nonce = crypto.randomBytes(16).toString('hex');
    const path = '/v1/feed/home';
    const sig = crypto.createHmac('sha256', key).update('GET\n' + path + '\n' + ts + '\n' + nonce, 'utf8').digest('hex');
    const headers = {
      'Accept': 'application/json',
      'x-ai-movie-timestamp': ts,
      'x-ai-movie-nonce': nonce,
      'x-ai-movie-signature': sig
    };
    if (cfg.cookie) headers['Cookie'] = cfg.cookie;
    const ac = new AbortController(); const to = setTimeout(() => ac.abort(), 12000);
    try {
      const r = await fetch(base + path, { headers, signal: ac.signal });
      clearTimeout(to);
      const txt = await r.text();
      let j = null; try { j = JSON.parse(txt); } catch (e) {}
      let secs = 0, cards = 0;
      if (j && Array.isArray(j.sections)) {
        secs = j.sections.length;
        for (const s of j.sections) { const cs = s.cards || s.items || []; if (cs.length) cards += cs.length; }
      }
      const ok = r.status >= 200 && r.status < 300 && !!j;
      let msg = '';
      if (!ok) {
        if (r.status === 401 || r.status === 403) msg = 'HTTP ' + r.status + ' 签名被拒（API 密钥不对）';
        else if (r.status === 404) msg = 'HTTP 404 地址上没有 /v1 接口（API 地址填错）';
        else msg = 'HTTP ' + r.status + ' ' + txt.slice(0, 60).replace(/\s+/g, ' ');
      }
      out.push({ base, status: r.status, ms: Date.now() - t0, ok, secs, cards, msg });
      if (ok) break;
    } catch (e) {
      clearTimeout(to);
      out.push({ base, status: 0, ms: Date.now() - t0, ok: false, secs: 0, cards: 0, msg: e.name === 'AbortError' ? '连接超时（12 秒无响应）' : String(e.message || e) });
    }
  }
  return out;
}
/* v60：把一个播放/资源域名展开成苹果CMS API 候选地址 */
function collectCandidatesFromUrl(u) {
  if (!/^https?:\/\//i.test(String(u || ''))) return [];
  let host = '';
  try { host = new URL(u).hostname; } catch (e) { return []; }
  const p = host.split('.');
  const root = p.length <= 2 ? host : p.slice(-2).join('.');
  return [...new Set([host, root, 'www.' + root, 'api.' + root, 'caiji.' + root])]
    .map(c => 'https://' + c + '/api.php/provide/vod');
}
/* v60：后台在「采集站」页手动删掉的上游采集档线路（记名字，同步上游时跳过，防止删了又回来） */
function isColBlocked(label) {
  const b = config.colBlockedLines;
  return Array.isArray(b) && b.indexOf(String(label || '')) >= 0;
}
function setColBlocked(label, on) {
  if (!Array.isArray(config.colBlockedLines)) config.colBlockedLines = [];
  const s = String(label || '');
  if (on) { if (s && config.colBlockedLines.indexOf(s) < 0) config.colBlockedLines.push(s); }
  else config.colBlockedLines = config.colBlockedLines.filter(x => x !== s);
}
/* v60：真实连通测试一个采集站 API（必须是标准苹果CMS videolist 返回且有 list 数组） */
async function probeCollectApi(api, timeoutMs) {
  const url = api.replace(/\/+$/, '') + '/?ac=videolist&pg=1';
  const ac = new AbortController();
  const to = setTimeout(() => ac.abort(), timeoutMs || 6000);
  try {
    const r = await fetch(url, { signal: ac.signal, headers: { 'User-Agent': 'Mozilla/5.0' } });
    clearTimeout(to);
    if (r.status !== 200) return { ok: false, why: 'HTTP ' + r.status };
    const txt = await r.text();
    let j = null; try { j = JSON.parse(txt); } catch (e) { return { ok: false, why: '返回的不是 JSON' }; }
    if (!j || !Array.isArray(j.list)) return { ok: false, why: '返回无 list 字段（不是采集 API）' };
    return { ok: true, total: Number(j.total) || 0, n: j.list.length };
  } catch (e) {
    clearTimeout(to);
    return { ok: false, why: e.name === 'AbortError' ? '超时' : (String(e.message || e).slice(0, 40)) };
  }
}
/* 并发跑一批（限并发，防一次性几百个请求打死本机网络） */
async function probeMany(jobs, timeoutMs, conc) {
  const res = new Array(jobs.length);
  let i = 0;
  const W = conc || 12;
  while (i < jobs.length) {
    const idxs = [];
    for (let k = i; k < Math.min(i + W, jobs.length); k++) idxs.push(k);
    const rs = await Promise.all(idxs.map(k => probeCollectApi(jobs[k], timeoutMs)));
    idxs.forEach((k, n) => { res[k] = rs[n]; });
    i += W;
  }
  return res;
}
const UP_FAILS = new Map();
function isUpDown(d) { const f = UP_FAILS.get(d); return f && f.until > Date.now(); }
function markUpFail(d) { const f = UP_FAILS.get(d) || { fails: 0, until: 0 }; f.fails++; f.until = Date.now() + Math.min(60000 * f.fails, 300000); UP_FAILS.set(d, f); }
function markUpOk(d) { UP_FAILS.delete(d); }
async function upstream(method, urlPath, rawQuery, bodyObj) {
  const ts = String(Date.now());
  const nonce = crypto.randomBytes(16).toString('hex');
  let qobj = {};
  if (rawQuery) {
    const qs = rawQuery.startsWith('?') ? rawQuery.slice(1) : rawQuery;
    for (const part of qs.split('&')) {
      if (!part) continue;
      const i = part.indexOf('=');
      const k = i < 0 ? part : part.slice(0, i);
      const v = i < 0 ? '' : part.slice(i + 1);
      qobj[decodeURIComponent(k)] = decodeURIComponent(v);
    }
  }
  const encodedQuery = Object.entries(qobj).map(([k, v]) => encodeURIComponent(k) + '=' + encodeURIComponent(v)).join('&');
  const full = urlPath + (encodedQuery ? '?' + encodedQuery : '');
  const headers = {
    'Accept': 'application/json',
    'x-ai-movie-timestamp': ts,
    'x-ai-movie-nonce': nonce,
    'x-ai-movie-signature': upSign(method, full, ts, nonce)
  };
  const c = upCfg();
  if (c.cookie) headers['Cookie'] = c.cookie;
  let reqBody = null;
  if (bodyObj) { headers['Content-Type'] = 'application/json'; reqBody = JSON.stringify(bodyObj); }
  const cands = upCandidates();
  const per = cands.length > 1 ? 9000 : 15000;
  let lastErr = null;
  for (let i = 0; i < cands.length; i++) {
    const base = cands[i];
    if (i > 0 && isUpDown(base)) continue;
    const ac = new AbortController(); const to = setTimeout(() => ac.abort(), per);
    try {
      const r = await fetch(base + full, { method, headers, body: reqBody, signal: ac.signal });
      clearTimeout(to);
      if (r.status >= 500) { markUpFail(base); if (i < cands.length - 1) continue; return r; }
      markUpOk(base);
      return r;
    } catch (e) { clearTimeout(to); markUpFail(base); lastErr = e; if (i < cands.length - 1) continue; throw e; }
  }
  if (lastErr) throw lastErr;
  throw new Error('no upstream available');
}
/* 上游内存缓存 */
const upCache = new Map();
async function upJson(path, q, ttl, method, bodyObj) {
  const key = path + '?' + (q || '') + (method === 'POST' ? '|POST|' + crypto.createHash('md5').update(JSON.stringify(bodyObj || {})).digest('hex') : '');
  const hit = upCache.get(key);
  if (hit && Date.now() - hit.t < (hit.ttl != null ? hit.ttl : (ttl || 300000))) return hit.j;
  const r = await upstream(method || 'GET', path, q, bodyObj);
  const t = await r.text();
  let j = null; try { j = JSON.parse(t); } catch (e) {}
  if (r.status >= 200 && r.status < 300 && j) {
    /* v53：空结果（上游抖动/限流返回的 items:[]）只缓存 30s。
       以前空结果也按调用方 TTL 缓存，一次抖动就让「搜索无结果」挂 10 分钟（线上已中招） */
    let useTtl = ttl || 300000;
    try {
      const arr = j.items || j.cards || j.line_options || j.lines || j.episodes;
      if (Array.isArray(arr) && arr.length === 0) useTtl = Math.min(useTtl, 30000);
    } catch (e) {}
    upCache.set(key, { t: Date.now(), j, ttl: useTtl });
    return j;
  }
  if (hit) { log('warn', 'upstream', path + ' -> ' + r.status + '，回退旧缓存'); return hit.j; }
  log('error', 'upstream', path + ' -> ' + r.status + ' ' + t.slice(0, 120));
  const err = new Error('upstream ' + r.status); err.status = r.status; throw err;
}

/* ---------- v34：上游官方线路同步（手动按钮 + 定时自动） ----------
   ticket 会被上游轮换，这里把原来的 sync-upstream 路由逻辑抽成函数复用。
   注意：同步结果为空时不动现有线路（避免上游抖动把好线路清空）。 */
let upSyncing = false;
async function syncUpstreamLines() {
  if (upSyncing) return { ok: false, error: '同步进行中，请稍候' };
  upSyncing = true;
  try {
    const feed = await upJson('/v1/feed/home', '', 60000);
    const secs = feed.sections || [];
    let sampleId = '';
    for (const sec of secs) { const cards = sec.cards || sec.items || []; if (cards.length) { sampleId = cards[0].id; break; } }
    if (!sampleId) return { ok: false, error: '上游暂无内容' };
    const det = await upJson('/v1/catalog/' + encodeURIComponent(sampleId), '', 120000);
    const ej = await upJson('/v1/catalog/' + encodeURIComponent(sampleId) + '/episodes', '', 120000).catch(() => null);
    const eps = (ej && (ej.episodes || ej.items || ej.list)) || (det && det.episodes) || [];
    const lines = []; const seen = {};
    const collect = []; const seenC = {};   /* v53：普通线路（上游采集档）单独存一份，后台可查 */
    for (const ep of (eps || []).slice(0, 2)) {
      const tk = ep.token || ep.playback_token || '';
      if (!tk) continue;
      const rj = await upJson('/v1/playback/resolve/' + encodeURIComponent(tk), '', 300000).catch(() => null);
      if (!rj) continue;
      const opts = (rj && (rj.line_options || rj.lines)) || [];
      for (const o of opts) {
        const label = o.display_label || o.label || o.provider_name || '官方';
        const uo = String((o && o.url) || '');
        const isOff = upIsOfficial(o);
        if (isOff) {
          if (seen[label]) continue; seen[label] = 1;
          if (uo && !uo.startsWith('resolve://')) lines.push({ label, url: uo });
          else { const t2 = uo.replace('resolve://', ''); if (t2) lines.push({ label, ticket: t2 }); }
        } else {
          /* 普通线路 = 上游返回的采集资源档（红牛/ikun/1080zyk…），播放时是换源面板里的「普通线路」
             v60：后台删掉的线路记在 config.colBlockedLines，这里必须跳过，否则一同步就又回来了 */
          if (isColBlocked(label)) continue;
          if (seenC[label]) continue; seenC[label] = 1;
          const w = Number(o && o.preference_weight);
          const entry = { label, weight: isNaN(w) ? -1 : w };
          if (uo && !uo.startsWith('resolve://')) entry.url = uo;
          else { const t2 = uo.replace('resolve://', ''); if (t2) entry.ticket = t2; }
          collect.push(entry);
        }
      }
    }
    if (!lines.length) return { ok: false, error: '上游未返回任何线路（保留现有配置不变）' };
    config.upstreamLines = lines;
    config.upstreamCollectLines = collect;
    saveConfig();
    return { ok: true, list: lines, collect };
  } catch (e) {
    return { ok: false, error: String(e.message || e) };
  } finally { upSyncing = false; }
}
/* ---------- v36：DLNA 投屏（局域网 SSDP 发现 + SOAP 控制，零依赖） ---------- */
function dlnaSoap(controlUrl, action, body) {
  return new Promise((resolve, reject) => {
    let u; try { u = new URL(controlUrl); } catch (e) { return reject(new Error('控制地址无效')); }
    const xml = '<?xml version="1.0" encoding="utf-8"?>'
      + '<s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/" s:encodingStyle="http://schemas.xmlsoap.org/soap/encoding/">'
      + '<s:Body><u:' + action + ' xmlns:u="urn:schemas-upnp-org:service:AVTransport:1">' + body + '</u:' + action + '></s:Body></s:Envelope>';
    const buf = Buffer.from(xml, 'utf8');
    const req = (u.protocol === 'https:' ? https : http).request({
      host: u.hostname, port: u.port || (u.protocol === 'https:' ? 443 : 80), path: u.pathname + (u.search || ''), method: 'POST',
      headers: {
        'Content-Type': 'text/xml; charset="utf-8"',
        'SOAPACTION': '"urn:schemas-upnp-org:service:AVTransport:1#' + action + '"',
        'Content-Length': buf.length
      }
    }, res => { let d = ''; res.on('data', c => d += c); res.on('end', () => resolve({ status: res.statusCode, body: d })); });
    req.on('error', reject);
    req.setTimeout(9000, () => { try { req.destroy(new Error('投屏设备响应超时')); } catch (e) {} });
    req.write(buf); req.end();
  });
}
function dlnaEsc(s) { return String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'); }
/* 解析设备描述 XML：取 friendlyName 与 AVTransport 控制地址 */
function dlnaParseDesc(xml, base) {
  const name = (xml.match(/<friendlyName>([^<]*)<\/friendlyName>/i) || [])[1] || '未知设备';
  let ctrl = '';
  const svc = xml.match(/<service>[\s\S]*?<\/service>/gi) || [];
  for (const s of svc) {
    if (!/urn:schemas-upnp-org:service:AVTransport:1/i.test(s)) continue;
    ctrl = (s.match(/<controlURL>([^<]*)<\/controlURL>/i) || [])[1] || '';
    break;
  }
  if (!ctrl) return null;
  try { ctrl = new URL(ctrl, base).href; } catch (e) { ctrl = base.replace(/\/[^/]*$/, '/') + ctrl.replace(/^\//, ''); }
  return { name: name.trim(), controlUrl: ctrl };
}
/* SSDP M-SEARCH：多播发现局域网内的投屏设备（MediaRenderer / AVTransport） */
function dlnaScan(ms) {
  return new Promise(resolve => {
    const sock = dgram.createSocket({ type: 'udp4', reuseAddr: true });
    const locs = {};
    let done = false;
    const finish = () => {
      if (done) return; done = true;
      try { sock.close(); } catch (e) {}
      resolve(Object.keys(locs));
    };
    sock.on('message', msg => {
      const t = msg.toString('utf8');
      const loc = (t.match(/^LOCATION:\s*(\S+)/im) || [])[1] || (t.match(/^location:\s*(\S+)/im) || [])[1];
      if (loc) locs[loc] = 1;
    });
    sock.on('error', () => { try { sock.close(); } catch (e) {} if (!done) { done = true; resolve(Object.keys(locs)); } });
    sock.bind(0, () => {
      try { sock.setBroadcast(true); sock.setMulticastTTL(2); } catch (e) {}
      const mk = st => ['M-SEARCH * HTTP/1.1', 'HOST: 239.255.255.250:1900', 'MAN: "ssdp:discover"', 'MX: 2', 'ST: ' + st, '', ''].join('\r\n');
      [mk('urn:schemas-upnp-org:device:MediaRenderer:1'), mk('ssdp:all')].forEach(m => {
        try { sock.send(Buffer.from(m, 'utf8'), 1900, '239.255.255.250'); } catch (e) {}
      });
      setTimeout(finish, ms || 2600);
    });
    setTimeout(() => { if (!done) finish(); }, (ms || 2600) + 1500);
  });
}
async function dlnaDevices() {
  const locs = await dlnaScan(2600);
  const out = [];
  await Promise.all(locs.map(async loc => {
    try {
      const r = await fetch(loc, { headers: { 'User-Agent': 'aistream/1.0' } });
      const xml = await r.text();
      const d = dlnaParseDesc(xml, loc);
      if (d) out.push(Object.assign({ location: loc }, d));
    } catch (e) {}
  }));
  return out;
}

/* 自动同步状态（持久化在 config.upAutoSync，后台可开关/调间隔） */
function upAutoSyncState() {
  if (!config.upAutoSync || typeof config.upAutoSync !== 'object') config.upAutoSync = { enabled: false, intervalMin: 60, lastRun: 0, lastOk: null, lastMsg: '' };
  return config.upAutoSync;
}
async function upAutoSyncTick(reason) {
  const st = upAutoSyncState();
  const r = await syncUpstreamLines();
  st.lastRun = Date.now();
  st.lastOk = !!r.ok;
  st.lastMsg = r.ok ? ('已更新 ' + ((r.list || []).length) + ' 条线路') : (r.error || '失败');
  saveConfig();
  if (r.ok) log('info', 'sys', '上游线路自动同步(' + reason + ')：' + st.lastMsg);
  else log('warn', 'sys', '上游线路自动同步(' + reason + ')失败：' + st.lastMsg);
  return r;
}
/* 每分钟巡检一次是否到期（间隔下限 5 分钟，防误配打爆上游） */
setInterval(() => {
  try {
    const st = upAutoSyncState();
    if (!st.enabled) return;
    const iv = Math.max(5, parseInt(st.intervalMin, 10) || 60) * 60000;
    if (st.lastRun && Date.now() - st.lastRun < iv) return;
    upAutoSyncTick('定时');
  } catch (e) {}
}, 60000);

/* ---------- v60：采集站自动获取（每天一次，持久化在 config.collectAuto） ---------- */
function collectAutoState() {
  if (!config.collectAuto || typeof config.collectAuto !== 'object') config.collectAuto = { enabled: false, lastRun: 0, lastMsg: '' };
  return config.collectAuto;
}
let collectAutoRunning = false;
async function collectAutoTick() {
  if (collectAutoRunning) return;
  collectAutoRunning = true;
  try {
    let ups = (config.upstreamCollectLines || []).slice();
    if (!ups.length) { const s = await syncUpstreamLines(); if (!s || !s.ok) return; ups = (config.upstreamCollectLines || []).slice(); }
    const seen = {}, cands = [];
    for (const e of ups) for (const api of collectCandidatesFromUrl(e.url || '')) {
      if (seen[api]) continue; seen[api] = 1;
      cands.push({ name: String(e.label || '').replace(/资源$/, '') || '未命名', api });
    }
    const have = {};
    (config.collectList || []).forEach(c => { have[String(c.api || '').replace(/\/+$/, '').toLowerCase()] = 1; });
    const todo = cands.filter(c => !have[c.api.toLowerCase()]);
    if (!todo.length) return;
    const rs = await probeMany(todo.map(c => c.api), 5000, 12);
    const byName = {}, added = [];
    todo.forEach((c, i) => { const r = rs[i]; if (r && r.ok && !byName[c.name]) { byName[c.name] = 1; added.push(c); } });
    const st = collectAutoState();
    st.lastRun = Date.now();
    if (added.length) {
      config.collectList = config.collectList || [];
      added.forEach(a => config.collectList.push({ id: uid(), name: a.name, api: a.api }));
      st.lastMsg = '新增 ' + added.length + ' 个';
      log('info', 'sys', '采集站自动获取(定时)：探测 ' + todo.length + ' 个候选，' + st.lastMsg);
    } else { st.lastMsg = '探测 ' + todo.length + ' 个，0 通过'; }
    saveConfig();
  } catch (e) {
    try { log('warn', 'sys', '采集站自动获取(定时)异常：' + (e.message || e)); } catch (x) {}
  } finally { collectAutoRunning = false; }
}
/* 每 30 分钟检查一次，距上次超过 24 小时才真正跑（避开夜间上游抖动集中打爆） */
setInterval(() => {
  try {
    const st = collectAutoState();
    if (!st.enabled) return;
    if (st.lastRun && Date.now() - st.lastRun < 86400000) return;
    collectAutoTick();
  } catch (e) {}
}, 1800000);

/* resolve-line 凭证转正：按 ticket 缓存 10 分钟 + 失败重试一次（上游易限流/抖动，成功返回 201） */
const rlCache = new Map();
const rlNeg = new Map();   /* v55：失败负缓存——上游 404（ticket 过期/资源没了）60s 内不再重打，
                              否则 debug=1 的预热每次都把 8 条过期 ticket 重打一遍，面板打开被拖慢 5s+ */
async function upResolveLine(ticket) {
  const hit = rlCache.get(ticket);
  if (hit && Date.now() - hit.t < 600000) return hit.j;
  const neg = rlNeg.get(ticket);
  if (neg && Date.now() - neg.t < 60000) { const e = new Error('resolve-line 404(cached)'); e.status = neg.status; throw e; }
  let lastErr = null;
  for (let a = 0; a < 2; a++) {
    try { const j = await upJson('/v1/playback/resolve-line', 'view=compact', 1, 'POST', { ticket }); rlCache.set(ticket, { t: Date.now(), j }); rlNeg.delete(ticket); return j; }
    catch (e) {
      lastErr = e;
      /* 404/410（ticket 过期/资源下架）重试没意义，直接负缓存 */
      if (e.status === 404 || e.status === 410) { rlNeg.set(ticket, { t: Date.now(), status: e.status }); break; }
    }
    await new Promise(r => setTimeout(r, 450));
  }
  throw lastErr || new Error('resolve-line failed');
}

/* ---------- 线路体检：直链探测 Content-Type，非视频自动顺延 ---------- */
const ctCache = new Map();
async function lineIsPlayable(url) {
  const u0 = String(url || '');
  if (!u0) return false;
  if (/\.m3u8(\?|$)/i.test(u0) || u0.indexOf('/hls') >= 0) return true;   /* m3u8 直接放行 */
  /* v53：上游明确标记 mp4 的直链免探测（mime_type=video_mp4）。
     以前对 mp4 也发 Range 探测，冷链路白等 0.3~0.5s；image/jpeg 假链接都出现在 m3u8 线，mp4 不受影响 */
  if (/mime_type=video_mp4/i.test(u0) || /\.(mp4|m4v|mov)(\?|$)/i.test(u0)) return true;
  const key = u0.slice(0, 220);
  if (ctCache.has(key)) return ctCache.get(key);
  let ok = true;
  try {
    const ac = new AbortController();
    const timer = setTimeout(() => { try { ac.abort(); } catch (e) {} }, 6000);
    const r = await fetch(u0, {
      method: 'GET', signal: ac.signal,
      headers: { 'Range': 'bytes=0-1', 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)', 'Accept': '*/*' }
    });
    clearTimeout(timer);
    try { if (r.body && r.body.cancel) await r.body.cancel(); } catch (e) {}
    const ct = String((r.headers && r.headers.get) ? (r.headers.get('content-type') || '') : '').toLowerCase();
    ok = r.status < 400 && (ct === '' || /^(video|audio)\//.test(ct) || /mpegurl/.test(ct)
         || /octet-stream/.test(ct) || /\/mp4|\/webm|\/mpeg|\/x-flv/.test(ct));
    if (!ok) log('warn', 'play', '线路体检不合格(' + (ct || 'no-ct') + ' status=' + r.status + ') → ' + u0.slice(0, 110));
  } catch (e) { ok = true; }   /* 探测本身失败不阻断，交给播放器尝试 */
  if (ctCache.size > 400) ctCache.clear();
  ctCache.set(key, ok);
  return ok;
}

/* ---------- TMDB ---------- */
const cache = new Map(); // key -> {t, data}
/* 磁盘持久缓存：重启容器/首次部署后依然秒开 */
try {
  const persisted = JSON.parse(fs.readFileSync(jp('tmdb-cache.json'), 'utf8'));
  for (const k in persisted) cache.set(k, persisted[k]);
  console.log('[cache] 已载入 TMDB 缓存 ' + Object.keys(persisted).length + ' 条');
} catch (e) {}
let _cacheSaveTimer = null;
function cachePersist() {
  clearTimeout(_cacheSaveTimer);
  _cacheSaveTimer = setTimeout(() => {
    const o = {};
    for (const [k, v] of cache) o[k] = v;
    save('tmdb-cache.json', o);
  }, 800);
}
/* TMDB 直连兜底：本网络 IPv6 到 CloudFront 可达而 IPv4 国际受限，Node fetch 默认顺序
   在并发下容易挑中挂起的地址（undici connectTimeout 恰好 10s）。这里用 node:https 强制 family=6，
   作为 global fetch 失败后的确定性通道。 */
const TMDB_NEG = new Map();   // 负缓存：key -> 失败时间，60s 内不再打上游
/* 出网代理候选（本机/局域网代理端口）。config.outProxy 可在后台覆盖，格式 host:port */
function proxyList() {
  const out = [];
  const pick = x => {
    const m = String(x || '').match(/^([a-zA-Z0-9.\-]+):(\d{2,5})$/);
    if (m && !out.some(o => o.host === m[1] && o.port === +m[2])) out.push({ host: m[1], port: +m[2] });
  };
  pick(config.outProxy);
  pick(process.env.OUT_PROXY);
  return out;
}
/* 经代理的 HTTPS CONNECT 隧道：直连抖动/被墙时的备选通道。
   没配代理（config.outProxy / 环境变量 OUT_PROXY 都为空）就直接失败，由调用方回落直连 */
function tmdbViaProxy(uStr, attempt, hdrs) {
  const cands = proxyList();
  if (!cands.length) return Promise.reject(new Error('no proxy configured'));
  const use = cands[((2 - attempt) % cands.length + cands.length) % cands.length];   // 第一次用首个候选
  return new Promise((resolve, reject) => {
    const u = new URL(uStr);
    const rq0 = http.request({ host: use.host, port: use.port, method: 'CONNECT', path: u.hostname + ':443', timeout: 8000 });
    rq0.on('connect', (res, socket) => {
      if (res.statusCode !== 200) { socket.destroy(); return reject(new Error('proxy connect ' + res.statusCode)); }
      const rq = https.request(u, {
        method: 'GET',
        createConnection: () => require('tls').connect({ socket, servername: u.hostname }),
        headers: hdrs || { 'Authorization': 'Bearer ' + tmdbToken(), 'accept': 'application/json' },
        timeout: 12000
      }, rs => {
        let b = '';
        rs.on('data', c => { b += c; });
        rs.on('end', () => { try { resolve(JSON.parse(b)); } catch (e) { reject(e); } });
      });
      rq.on('timeout', () => rq.destroy(new Error('proxy tls timeout')));
      rq.on('error', reject);
      rq.end();
    });
    rq0.on('timeout', () => rq0.destroy(new Error('proxy connect timeout')));
    rq0.on('error', reject);
    rq0.end();
  }).catch(e => { if (attempt > 0) return tmdbViaProxy(uStr, attempt - 1, hdrs); throw e; });
}
function tmdbDirect6(uStr, hdrs) {
  return new Promise((resolve, reject) => {
    const u = new URL(uStr);
    const mod = u.protocol === 'http:' ? require('http') : require('https');
    const rq = mod.request(u, {
      method: 'GET', family: 6, timeout: 12000,
      headers: hdrs || { 'Authorization': 'Bearer ' + tmdbToken(), 'accept': 'application/json' }
    }, rs => {
      let b = '';
      rs.on('data', c => { b += c; });
      rs.on('end', () => { try { resolve(JSON.parse(b)); } catch (e) { reject(e); } });
    });
    rq.on('timeout', () => rq.destroy(new Error('direct6 timeout')));
    rq.on('error', reject);
    rq.end();
  });
}
async function tmdbFetch(p, params, ttl) {
  params = Object.assign({ language: 'zh-CN' }, params || {});
  if (config.tmdbRegion) params.region = config.tmdbRegion;   // 内容地区（默认 CN）
  /* 关键：TMDB 的 region 只对 movie 类请求生效，/discover/tv 会忽略 → TV 内容国内化必须用
     with_original_language=zh（追剧日历/热门剧集等）。已显式指定语言（如日语动画 ja）的请求不覆盖 */
  if (p.indexOf('/discover/tv') === 0 && !params.with_original_language) params.with_original_language = 'zh';
  const key = p + '|' + JSON.stringify(params);
  const hit = cache.get(key);
  if (hit && Date.now() - hit.t < (ttl || 1800000)) return hit.data;
  const neg = TMDB_NEG.get(key);
  if (neg && Date.now() - neg < 60000) { if (hit) return hit.data; throw new Error('tmdb 负缓存中'); }
  const u = new URL(TMDB_API + p);
  for (const k in params) u.searchParams.set(k, params[k]);
  const uStr = u.toString();
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 12000);
  let data = null;
  try {
    const r = await fetch(uStr, {
      headers: { 'Authorization': 'Bearer ' + tmdbToken(), 'accept': 'application/json' },
      signal: ctrl.signal
    });
    data = await r.json();
    if (!data || (!data.results && !data.total_results && data.success === undefined && !data.id)) throw new Error('tmdb 异常响应');
  } catch (e1) {
    /* 兜底链：mihomo 隧道 → 强制 IPv6 直连 → fetch 重试 */
    try { data = await tmdbViaProxy(uStr, 2); }   // 依次尝试代理候选
    catch (e2) {
      try { data = await tmdbDirect6(uStr); }
      catch (e3) {
        try { data = await fetch(uStr, { headers: { 'Authorization': 'Bearer ' + tmdbToken(), 'accept': 'application/json' }, signal: AbortSignal.timeout(12000) }).then(r => r.json()); }
        catch (e4) { data = null; }
      }
    }
  } finally { clearTimeout(t); }
  if (data) {
    cache.set(key, { t: Date.now(), data });
    cachePersist();
    return data;
  }
  TMDB_NEG.set(key, Date.now());
  console.error('[tmdb] 拉取失败', p);
  /* 拉取失败时回退旧缓存（哪怕过期），首页不至于空白 */
  if (hit) return hit.data;
  throw new Error('tmdb 拉取失败');
}

/* v41.4：RECENT_FLOOR/RECENT_CEIL 把栏目锁在 [今年-2年, 明年末] 区间 ——
   既剔除 2018/2023 等老剧，也挡掉 TMDB 里「100 Years 2099 / 2040」这类离谱未来日期（否则按日期降序会浮到最顶）；
   各 discover 栏目统一按 首播/上映日期 降序 排到最前（用户要求：所有页面按最新年份日期排序） */
const RECENT_FLOOR = (new Date().getFullYear() - 2) + '-01-01';
const RECENT_CEIL = (new Date().getFullYear()) + '-12-31';
const COLS = {
  /* v41.2：原 trending 全球榜不支持 region，改为「国内热门」discover/tv（tmdbFetch 自动注入 region=CN）。
     旧首页配置里的 trending 栏目键名不变，自动变国内热门，无需改后台栏目配置 */
  /* v41.3：/tv/* 列表端点（popular/top_rated/on_the_air）不支持任何内容过滤参数，全是全球榜 →
     改为 /discover/tv（tmdbFetch 自动注入 with_original_language=zh），热门/高分/新上线全部国内化 */
  /* v41.4：全部改为按 首播/上映日期降序 + 最近 2 年地板 + 明年末上界，最新内容排到最前且无离谱未来片 */
  trending: { path: '/discover/tv', params: { sort_by: 'first_air_date.desc', 'first_air_date.gte': RECENT_FLOOR, 'first_air_date.lte': RECENT_CEIL }, label: '国内热门', media: () => 'tv' },
  movie_popular: { path: '/discover/movie', params: { sort_by: 'primary_release_date.desc', 'primary_release_date.gte': RECENT_FLOOR, 'primary_release_date.lte': RECENT_CEIL }, label: '热门电影', media: () => 'movie' },
  tv_popular: { path: '/discover/tv', params: { sort_by: 'first_air_date.desc', 'vote_count.gte': 5, 'first_air_date.gte': RECENT_FLOOR, 'first_air_date.lte': RECENT_CEIL }, label: '热门剧集', media: () => 'tv' },
  movie_top: { path: '/discover/movie', params: { sort_by: 'vote_average.desc', 'vote_count.gte': 100, 'primary_release_date.gte': RECENT_FLOOR, 'primary_release_date.lte': RECENT_CEIL }, label: '高分电影', media: () => 'movie' },
  tv_top: { path: '/discover/tv', params: { sort_by: 'vote_average.desc', 'vote_count.gte': 100, 'first_air_date.gte': RECENT_FLOOR, 'first_air_date.lte': RECENT_CEIL }, label: '高分剧集', media: () => 'tv' },
  movie_now: { path: '/movie/now_playing', label: '正在热映', media: () => 'movie' },
  tv_air: { path: '/discover/tv', params: { sort_by: 'first_air_date.desc', 'vote_count.gte': 5, 'first_air_date.lte': RECENT_CEIL }, label: '即将上线', media: () => 'tv' },
  zh_tv_hot: { path: '/discover/tv', params: { with_original_language: 'zh', sort_by: 'first_air_date.desc', 'vote_count.gte': 20, 'first_air_date.gte': RECENT_FLOOR, 'first_air_date.lte': RECENT_CEIL }, label: '华语热播剧', media: () => 'tv' },
  zh_movie_hot: { path: '/discover/movie', params: { with_original_language: 'zh', sort_by: 'primary_release_date.desc', 'vote_count.gte': 20, 'primary_release_date.gte': RECENT_FLOOR, 'primary_release_date.lte': RECENT_CEIL }, label: '华语热门电影', media: () => 'movie' }
};
normalizeConfig(); /* COLS 已定义，此处安全调用 */
/* v73：启动时把历史遗留的采集站地址规范化一遍。
   之前没有校验，有人把「光秃秃的域名」存进去了（如 https://<某资源站域名>），
   列表请求打到域名根 → 返回 HTML 而不是 JSON → 解析失败 → 首页空、点进去「暂无分集」。
   这里只做「能修的修」，修不了的（m3u8 直链等）原样保留，由保存时拦下，不静默删用户数据。 */
(function normalizeCollectList() {
  const list = config.collectList;
  if (!Array.isArray(list) || !list.length) return;
  let dirty = false;
  for (const c of list) {
    if (!c || !c.api) continue;
    const na = normalizeCollectApi(c.api);
    if (na.error || !na.api || na.api === c.api) continue;
    log('info', 'sys', '采集站地址自动修正: ' + c.name + '  ' + c.api + ' → ' + na.api);
    c.api = na.api;
    dirty = true;
  }
  if (dirty) saveConfig();
})();
/* v2：首页栏目升级为国内外混合（只迁移一次） */
if (config.cfgVer !== 2) {
  config.cfgVer = 2;
  const curCols = (config.home && config.home.columns) || [];
  const hasZh = curCols.some(c => c.key === 'zh_tv_hot' || c.key === 'zh_movie_hot');
  /* 分发版：新装实例（columns 为空）不注入任何 TMDB 栏目 —— 那时还没人配 TMDB 凭据，
     塞一堆必然拉不动的栏目只会让首页空白。空着，等站长自己加采集站/加栏目 */
  if (!hasZh && curCols.length) {
    config.home.columns = [
      { type: 'tmdb', key: 'trending', label: '本周热门' },
      { type: 'tmdb', key: 'zh_tv_hot', label: '华语热播剧' },
      { type: 'tmdb', key: 'zh_movie_hot', label: '华语热门电影' },
      { type: 'tmdb', key: 'tv_popular', label: '热门剧集' },
      { type: 'tmdb', key: 'movie_popular', label: '热门电影' },
      { type: 'tmdb', key: 'movie_now', label: '正在热映' }
    ];
  }
  saveConfig();
  console.log('[migrate] 首页栏目已升级 v2（含华语内容）');
}
/* v3：上游资源库配置字段补齐（仅补结构，绝不填值） */
if (config.cfgVer < 3) {
  config.cfgVer = 3;
  /* 脱敏：绝不往配置里塞任何上游地址/密钥/Cookie。留空 = 拿到的是空壳，
     必须站长自己在后台「上游接入」页填（一实例一号，禁止共用） */
  if (!config.upstream) config.upstream = { base: '', key: '', cookie: '', mirrors: [] };
  saveConfig();
  console.log('[migrate] 上游资源库字段已补齐 v3（地址/密钥留空，需站长自行填写）');
}

/* ---------- 广告过滤配置默认值 ---------- */
if (!config.adFilter || typeof config.adFilter !== 'object') config.adFilter = {};
config.adFilter.enabled = config.adFilter.enabled !== false;   // 默认开启
config.adFilter.tsProxy = !!config.adFilter.tsProxy;            // 切片代理回退（占上行），默认关
if (!Array.isArray(config.adFilter.blacklist)) config.adFilter.blacklist = [];
/* 公告兜底：mode=maintenance 为强制维护公告（前台无法关闭、刷新也弹）；「当天不再弹」由前台 localStorage 控制，后台不存储 */
if (!config.announcement || typeof config.announcement !== 'object') config.announcement = {};
config.announcement = Object.assign({ enabled: false, title: '', content: '', mode: 'normal' }, config.announcement);
/* 广播兜底：enabled 独立开关；count 连续推送次数；intervalUnit/h interval 间隔（秒/分/时） */
if (!config.broadcast || typeof config.broadcast !== 'object') config.broadcast = {};
config.broadcast = Object.assign({ enabled: false, title: '', content: '', count: 1, intervalUnit: 'h', interval: 1 }, config.broadcast);
config.broadcast.count = Math.max(1, Math.min(50, parseInt(config.broadcast.count, 10) || 1));
config.broadcast.interval = Math.max(1, Math.min(1440, parseInt(config.broadcast.interval, 10) || 1));
if (!['s', 'm', 'h'].includes(config.broadcast.intervalUnit)) config.broadcast.intervalUnit = 'h';
/* 内容地区：默认 CN，注入到所有 TMDB 请求（popular/now_playing/airing_today/discover 支持 region；trending 忽略该参数无碍） */
if (!config.tmdbRegion || typeof config.tmdbRegion !== 'string') config.tmdbRegion = 'CN';
saveConfig();

/* ================= m3u8 广告过滤 =================
   设计：代理只改写 m3u8 清单、删除插播广告切片；切片 URL 保持采集站绝对直链，
   浏览器直连源站（不占家庭上行）。算法以「跨域/可疑后缀」为主、组内时长异常为辅，
   并带熔断，避免误删正片。 */
const AD_CACHE = new Map();                 // 指纹|url|token -> {t, text}
const AD_CACHE_TTL = 90000;   /* v52: 30s→90s，换线切回来时清单直接命中缓存（VOD 清单短时不变） */
const SUSPECT_TLDS = ['vip','bet','top','xyz','cc','icu','fun','shop','live','link','click','monster','rest','pro','work','lol','wang','ren','club','date','racing','stream','info','biz'];

function regDomain(host) {
  if (!host) return '';
  host = String(host).toLowerCase();
  const p = host.split('.');
  if (p.length <= 2) return host;
  const multi = ['com.cn','net.cn','org.cn','gov.cn','edu.cn','co.uk','org.uk','com.au','co.jp','com.hk','com.tw','or.jp'];
  if (multi.includes(p.slice(-3).join('.'))) return p.slice(-3).join('.');
  return p.slice(-2).join('.');
}
function isPrivateHost(host) {
  if (!host) return true;
  host = String(host).toLowerCase();
  if (host === 'localhost' || host.endsWith('.localhost')) return true;
  const m = host.match(/^(\d{1,3})(?:\.(\d{1,3})){3}$/);
  if (m) {
    const a = [+m[1], +m[2], +m[3], +m[4]];
    if (a[0] === 127 || a[0] === 0) return true;
    if (a[0] === 10) return true;
    if (a[0] === 169 && a[1] === 254) return true;
    if (a[0] === 172 && a[1] >= 16 && a[1] <= 31) return true;
    if (a[0] === 192 && a[1] === 168) return true;
  }
  return false;
}
function absUrl(u, base) {
  if (/^https?:\/\//i.test(u)) return u;
  try { return new URL(u, base).href; } catch (e) { return u; }
}
async function fetchText(url, timeout = 12000, depth = 0) {
  if (depth > 6) throw new Error('too many redirects');
  if (!/^https?:\/\//i.test(url) || isPrivateHost(new URL(url).host)) throw new Error('blocked url');
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeout);
  try {
    const r = await fetch(url, { signal: ctrl.signal, headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36', 'Referer': url } });
    if (r.status >= 300 && r.status < 400 && r.headers.get('location')) return await fetchText(new URL(r.headers.get('location'), url).href, timeout, depth + 1);
    if (!r.ok) throw new Error('upstream ' + r.status);
    return await r.text();
  } finally { clearTimeout(t); }
}
function parseSegs(lines, base) {
  const segs = []; let disc = false, discLine = -1;
  for (let i = 0; i < lines.length; i++) {
    const ln = lines[i].trim();
    if (ln.startsWith('#EXT-X-DISCONTINUITY')) { disc = true; discLine = i; continue; }
    if (ln.startsWith('#EXTINF:')) {
      const m = ln.match(/#EXTINF:([\d.]+)/);
      const dur = m ? parseFloat(m[1]) : 0;
      let u = '';
      for (let j = i + 1; j < lines.length; j++) { if (!lines[j].trim().startsWith('#')) { u = lines[j].trim(); break; } }
      if (u) segs.push({ dur, url: absUrl(u, base), disc, discLine, li: i });
      disc = false; discLine = -1;
    }
  }
  return segs;
}
/* 广告分析报告写入日志（同源节流，避免刷屏；便于事后总结广告特征/改进规则） */
const AD_LOG_THROTTLE = new Map();
function logAdAnalyze(rawHost, a) {
  try {
    const host = regDomain(rawHost);
    const now = Date.now();
    const last = AD_LOG_THROTTLE.get(host) || 0;
    if (now - last < 15 * 60 * 1000) return;   // 同源每 15 分钟最多记一次
    AD_LOG_THROTTLE.set(host, now);
    const discPct = (a.discRatio * 100).toFixed(1);
    const summary = `切片${a.total} 断点${a.discMarkers}(${discPct}%) 主域=${a.mainRD} 中位时长=${a.med}s 时长极差=${a.minDur}~${a.maxDur}s 有差异=${a.variety}`
      + ` 拦截=${a.blocked}(跨域${a.reasons.crossDomain}/长异常${a.reasons.durLong}/短异常${a.reasons.durShort}/断点插播${a.reasons.discAd}/CUE${a.reasons.cue}/黑名单${a.reasons.blacklist}) 熔断=${a.tripped} CUE广告段=${a.cueAd}`;
    log('info', 'ad-analyze', `[${rawHost}] ${summary}`, JSON.stringify(a));
  } catch (e) {}
}
/* 纯分析（不改写清单）：返回插播广告统计 + 各插播块的时间点，供选线标注 / 后台预览 / 播放日志复用。
   断点插播识别 = 该组以 #EXT-X-DISCONTINUITY 起头 + 整块时长 < 最长正片段的 15% + 绝对 <90s + ≤30 片。 */
function analyzeMedia(text, base, cfg) {
  const lines = text.split('\n').map(l => l.replace(/\r$/, ''));
  const segs = parseSegs(lines, base);
  const reasons = { crossDomain: 0, durLong: 0, durShort: 0, cue: 0, blacklist: 0, discAd: 0 };
  if (segs.length < 8) return { unchanged: true, lines, segs, reasons, blocked: 0, adBlocks: [], adLine: new Set(), discMarkers: 0, tripped: false, total: segs.length };
  /* 主域：优先用切片注册域的众数（正片通常占多数），比照抄清单自身域名更鲁棒
     —— 有些源清单在 A 域而切片全在 B 域，此时拿清单域当主域会把正片全判成跨域。
     众数不够显著（<30%）说明切片域名很分散（多 CDN），回落到清单域名。 */
  const rdCount = new Map();
  for (const s of segs) { const rd = regDomain(new URL(s.url).host); if (rd) rdCount.set(rd, (rdCount.get(rd) || 0) + 1); }
  let mainRD = regDomain(new URL(base).host), topN = 0;
  for (const [rd, n] of rdCount) { if (n > topN) { topN = n; mainRD = rd; } }
  if (topN < segs.length * 0.3) mainRD = regDomain(new URL(base).host);
  const durs = segs.map(s => s.dur).filter(d => d > 0).sort((a, b) => a - b);
  const med = durs[Math.floor(durs.length / 2)] || 0;
  const minDur = durs.length ? durs[0] : 0, maxDur = durs.length ? durs[durs.length - 1] : 0;
  /* 时长有显著差异（极差>1.8倍）才启用「短时广告块」判定：
     否则整源都是 2s 这种同质拼接源（如哆啦A梦），短时块会和正片无法区分 → 不误杀，留给整线拉黑 */
  const variety = med > 0 && maxDur > minDur * 1.8;
  /* EXT-X-CUE-OUT / CUE-IN 精确广告段标记（上游显式标了广告区间） */
  const cueAd = new Set(); let inAd = false;
  for (let i = 0; i < lines.length; i++) {
    const ln = lines[i].trim();
    if (/^#EXT-X-CUE-OUT/i.test(ln)) inAd = true;
    else if (/^#EXT-X-CUE-IN/i.test(ln)) inAd = false;
    else if (ln.startsWith('#EXTINF:')) {
      if (inAd) { for (let j = i + 1; j < lines.length; j++) { if (!lines[j].trim().startsWith('#')) { cueAd.add(j); break; } } }
    }
  }
  /* 累计起始秒，用于插播块定位（供后台预览/播放日志标注广告出现的时间点） */
  let acc = 0;
  for (const s of segs) { s.startSec = acc; acc += s.dur; }
  const groups = []; let g = [];
  for (const s of segs) { if (s.disc && g.length) { groups.push(g); g = []; } g.push(s); }
  if (g.length) groups.push(g);
  const bl = (cfg.blacklist || []).map(x => String(x).trim().toLowerCase()).filter(Boolean);
  const adLine = new Set(); let blocked = 0;
  const mark = (grp) => { for (const s of grp) { if (!adLine.has(s.li)) { adLine.add(s.li); blocked++; } if (s.discLine >= 0) adLine.add(s.discLine); } };
  /* 最长组几乎必然是「正片连续块」（插播广告恒为极短块）。用它做广告时长的上限基准，
     比用全部组的中位数更稳——广告组会把中位数拉低从而漏判 */
  const groupDurs = groups.map(gp => gp.reduce((a, b) => a + b.dur, 0));
  const maxGroupDur = groupDurs.length ? Math.max(0, ...groupDurs) : 0;
  const adBlocks = [];
  for (const grp of groups) {
    const rds = [...new Set(grp.map(s => regDomain(new URL(s.url).host)))];
    const suspect = rds.some(rd => rd && rd !== mainRD && SUSPECT_TLDS.includes(rd.split('.').pop()));
    const gt = grp.reduce((a, b) => a + b.dur, 0);
    const gavg = gt / grp.length;
    /* 长异常：单组总时长远超正片中位（典型整段长广告） */
    const durLong = med > 0 && gavg > med * 3 && gt >= 8 && gt <= 180 && grp.length < 10;
    /* 短异常：同源、时长明显短于正片、且夹在断点之间的小段（典型 2s 填充广告），
       仅在「源有时长差异」时启用，避免同质源误杀 */
    const durShort = variety && gavg < med * 0.6 && grp.length >= 2 && grp.length <= 14;
    const hasCue = grp.some(s => cueAd.has(s.li));
    const blHit = grp.some(s => bl.some(b => { const h = new URL(s.url).host.toLowerCase(); return h === b || h.endsWith('.' + b) || regDomain(h) === b; }));
    /* ★ 断点插播广告（ts 片段级，HLS 通用信号）：同 CDN、同参数、跨域/时长/CUE 都抓不到，
       但必以 #EXT-X-DISCONTINUITY 起头（广告边界），且整块极短（远小于正片连续块）。
       识别 = 该组以断点起头 + 时长 < 最长正片段的 15% + 绝对 <90s + ≤30 片。
       用户实测 功夫2004（量子资源 vip.lzcdn2.com）：3 处插播块均为 7 片/~26s，正片块 400~540 片。 */
    const discAd = !!grp.length && grp[0].disc && gt > 0 && gt < maxGroupDur * 0.15 && gt < 90 && grp.length <= 30;
    if (blHit) { mark(grp); reasons.blacklist += grp.length; }
    else if (suspect) { mark(grp); reasons.crossDomain += grp.length; }
    else if (durLong) { mark(grp); reasons.durLong += grp.length; }
    else if (durShort) { mark(grp); reasons.durShort += grp.length; }
    else if (hasCue) { mark(grp); reasons.cue += grp.length; }
    else if (discAd) { mark(grp); reasons.discAd += grp.length; adBlocks.push({ startSec: Math.round(grp[0].startSec), segs: grp.length, dur: Math.round(gt), type: 'discAd' }); }
  }
  /* ★ 删除插播块必须连带其两侧的 #EXT-X-DISCONTINUITY 一起删。
     实测拼接广告源（ppvod 系）广告自带独立 PTS 时间轴、正片 PTS 跨插播点严格连续
     （功夫2004 00074→00075 首帧差 = EXTINF 4.1708s）。mark() 只删广告组自己的起始断点，
     广告结束处的断点若残留，清单会声明一个实际不存在的"时间轴断点"——
     hls.js 在该点重置时间轴映射，部分场景直接卡死转圈（大哥 33:00 实测）。
     这里对每段连续删除的组区间，把区间之后那组的起始断点一并标记删除，让正片无缝衔接。 */
  for (let gi = 0; gi < groups.length; gi++) {
    if (!adLine.has(groups[gi][0].li)) continue;
    let gj = gi;
    while (gj + 1 < groups.length && adLine.has(groups[gj + 1][0].li)) gj++;
    const after = groups[gj + 1];
    if (after && after.length && after[0].discLine >= 0 && !adLine.has(after[0].discLine)) adLine.add(after[0].discLine);
    gi = gj;
  }
  /* 熔断：宁可放过广告，也绝不误删正片。删除占比 >20% 或删完剩 <5 片 → 整份原样放行 */
  const tripped = blocked > segs.length * 0.2 || (segs.length - blocked) < 5;
  const discMarkers = lines.filter(l => l.trim().startsWith('#EXT-X-DISCONTINUITY')).length;
  return { unchanged: false, lines, segs, reasons, blocked, adBlocks, adLine, discMarkers, tripped, total: segs.length, mainRD, med, minDur, maxDur, variety, cueAd };
}
/* 把媒体清单里的相对切片地址 / URI="..."（key/map）改写为绝对地址。
   清单经 /api/m3u8filter 代理后由站点域名提供服务，若切片是相对地址会被解析到站点源 → 404 黑屏。
   ad 过滤的 unchanged/tripped 短路分支与 adFilter 关闭分支也必须先过这道绝对化，否则相对地址源（如西瓜资源）播放失败。 */
function absolutizeMediaText(text, base) {
  const lines = text.split('\n');
  const out = []; let lastSeg = false;
  for (const raw of lines) {
    const ln = raw.trim();
    if (ln.startsWith('#EXTINF:')) { out.push(raw); lastSeg = true; continue; }
    if (lastSeg && !ln.startsWith('#')) { lastSeg = false; out.push(absUrl(ln, base)); continue; }
    if (/URI="/.test(ln)) { out.push(ln.replace(/URI="([^"]+)"/g, (m, u) => 'URI="' + absUrl(u, base) + '"')); continue; }
    out.push(raw);
  }
  return out.join('\n');
}
function filterMedia(text, base, cfg, token) {
  const a = analyzeMedia(text, base, cfg);
  if (a.unchanged) return { text: absolutizeMediaText(text, base), blocked: 0 };
  if (a.tripped) {
    logAdAnalyze(new URL(base).host, {
      host: regDomain(new URL(base).host), rawHost: new URL(base).host, total: a.total,
      discMarkers: a.discMarkers, discRatio: a.discMarkers / a.total, mainRD: a.mainRD, med: a.med, minDur: a.minDur, maxDur: a.maxDur, variety: a.variety,
      blocked: 0, reasons: a.reasons, tripped: true, cueAd: a.cueAd.size
    });
    return { text: absolutizeMediaText(text, base), blocked: 0 };
  }
  const lines = a.lines, adLine = a.adLine;
  const out = []; let skipUrl = false, lastSeg = false;
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i]; const ln = raw.trim();
    if (adLine.has(i)) { if (ln.startsWith('#EXTINF:')) skipUrl = true; continue; }
    if (ln.startsWith('#EXTINF:')) { out.push(raw); lastSeg = true; continue; }
    if (skipUrl && !ln.startsWith('#')) { skipUrl = false; continue; }
    if (lastSeg && !ln.startsWith('#')) { lastSeg = false; out.push(cfg.tsProxy ? ('/api/m3u8slice?url=' + encodeURIComponent(absUrl(ln, base)) + (token ? ('&token=' + encodeURIComponent(token)) : '')) : absUrl(ln, base)); continue; }
    if (/^#EXT-X-(CUE|DATERANGE|SCTE-35)/i.test(ln)) continue;          // 删广告信令
    if (/URI="/.test(ln)) { out.push(ln.replace(/URI="([^"]+)"/g, (mm, uu) => 'URI="' + absUrl(uu, base) + '"')); continue; }
    out.push(raw);
  }
  const body = out.join('\n').replace(/^#EXTM3U[^\n]*\n?/, '');
  logAdAnalyze(new URL(base).host, {
    host: regDomain(new URL(base).host), rawHost: new URL(base).host, total: a.total,
    discMarkers: a.discMarkers, discRatio: a.discMarkers / a.total, mainRD: a.mainRD, med: a.med, minDur: a.minDur, maxDur: a.maxDur, variety: a.variety,
    blocked: a.blocked, reasons: a.reasons, tripped: false, cueAd: a.cueAd.size
  });
  return { text: '#EXTM3U\n# X-AD-BLOCKED: ' + a.blocked + '\n' + body, blocked: a.blocked, adBlocks: a.adBlocks };
}
/* 给定一条播放地址（直链 m3u8 / resolve:// 凭证 / 主清单），返回插播广告分析结论。
   主清单自动取首个变体分析；非 m3u8（如 mp4 直链）返回 notm3u。 */
async function analyzeM3u8(target, cfg, token) {
  try {
    const raw = await fetchText(target, 15000);
    if (!/#EXTM3U/i.test(raw)) return { blocked: 0, discAd: 0, discMarkers: 0, adBlocks: [], total: 0, tripped: false, verdict: 'notm3u' };
    if (!/#EXT-X-STREAM-INF/i.test(raw)) {
      const a = analyzeMedia(raw, target, cfg);
      if (a.unchanged) return { blocked: 0, discAd: 0, discMarkers: 0, adBlocks: [], total: 0, tripped: false, verdict: 'clean' };
      const verdict = a.reasons.discAd > 0 ? 'ad' : (a.blocked > 0 ? 'ad' : 'clean');
      return { blocked: a.blocked, discAd: a.reasons.discAd, discMarkers: a.discMarkers, adBlocks: a.adBlocks, total: a.total, tripped: a.tripped, verdict };
    }
    const lines = raw.split('\n').map(l => l.replace(/\r$/, ''));
    let vurl = '';
    for (let i = 0; i < lines.length; i++) {
      if (lines[i].trim().startsWith('#EXT-X-STREAM-INF') && lines[i].trim().indexOf('I-FRAME') === -1) {
        let u2 = ''; for (let j = i + 1; j < lines.length; j++) { if (!lines[j].trim().startsWith('#')) { u2 = lines[j].trim(); break; } }
        if (u2) { vurl = absUrl(u2, target); break; }
      }
    }
    if (!vurl) return { blocked: 0, discAd: 0, discMarkers: 0, adBlocks: [], total: 0, tripped: false, verdict: 'clean' };
    const vraw = await fetchText(vurl, 20000);
    const a = analyzeMedia(vraw, vurl, cfg);
    if (a.unchanged) return { blocked: 0, discAd: 0, discMarkers: 0, adBlocks: [], total: 0, tripped: false, verdict: 'clean' };
    const verdict = a.reasons.discAd > 0 ? 'ad' : (a.blocked > 0 ? 'ad' : 'clean');
    return { blocked: a.blocked, discAd: a.reasons.discAd, discMarkers: a.discMarkers, adBlocks: a.adBlocks, total: a.total, tripped: a.tripped, verdict };
  } catch (e) { return { blocked: 0, discAd: 0, discMarkers: 0, adBlocks: [], total: 0, error: String(e.message || e), verdict: 'error' }; }
}
/* 解析并落 'play-ad' 日志（Task C）：分析一条线路 m3u8 的插播广告情况，记录线路名/主域/切片数/
   断点数/断点插播拦截数/插播块时间点，供事后总结插播广告原理。供 schedulePlayAd 与 scanAllLines 共用。 */
async function analyzeAndLogPlayAd(label, url, token) {
  if (!url) return null;
  try {
    const r = await analyzeM3u8(url, config.adFilter, token || '');
    if (r.verdict === 'notm3u' || r.verdict === 'error') return r;
    let host = '';
    try { host = regDomain(new URL(url).host); } catch (e) {}
    const blocks = (r.adBlocks || []).map(b => b.startSec + 's/' + b.dur + 's×' + b.segs).join(', ');
    log('info', 'play-ad', `线路=${label} 主域=${host} 切片${r.total} 断点${r.discMarkers} 插播拦截=${r.discAd} 块数=${(r.adBlocks || []).length} 块=[${blocks}] 过滤${config.adFilter.enabled ? '开' : '关'}${(r.tripped ? ' 熔断' : '')}`, JSON.stringify(r));
    return r;
  } catch (e) { return null; }
}
/* 播放日志增强（Task C）：实际选定某条线后，fire-and-forget 跑一次插播广告分析并落 'play-ad' 日志 */
function schedulePlayAd(label, url) {
  if (!url) return;
  setTimeout(() => { analyzeAndLogPlayAd(label, url, '').catch(() => {}); }, 20);
}
/* ---------- v52：官方/采集线路判定（对齐上游分组） ----------
   实测上游「官方线路」档：专享Y(w=1000) / 官方Z~R(998~994) / 腾讯视频，weight 全部 ≥990；
   采集资源档（红牛/西瓜/ikun…）weight 从 920 起步，中间是明确分界。
   旧逻辑只认名字里有没有「官方」二字 → 专享Y、腾讯视频被错划进采集。 */
function upIsOfficial(o) {
  const lb = String((o && (o.display_label || o.label || o.provider_name)) || '');
  if (/官方|专享|腾讯/.test(lb)) return true;
  const w = Number(o && o.preference_weight);
  return !isNaN(w) && w >= 990;
}
/* 自动识别所有线路插播广告（用户需求：不要每次手动看片发现漏网，播放器应自动识别全部线路）。
   进入影片/剧集时后台调用一次：解析全部可用线路 → 逐条分析 m3u8 → 落 'play-ad' 日志，
   返回每条线路的 verdict/插播情况，供换源面板即时标注。 */
const SCAN_CACHE = new Map();   /* v55：token -> {t, out}，warm 预扫描与播放页扫描共用 */
async function scanAllLines(tk) {
  /* v55：扫描结果缓存 5 分钟——warm 预热时触发的扫描结果留给播放页的
     /api/ad-scan-all 秒取（换源面板打开即有标注，不再「分析中…」转圈） */
  const scHit = SCAN_CACHE.get(tk);
  if (scHit && Date.now() - scHit.t < 300000) return scHit.out;
  const out = [];
  try {
    const rj = await upJson('/v1/playback/resolve/' + encodeURIComponent(tk), '', 300000);
    const rawOpts = (rj && (rj.line_options || rj.lines)) || [];
    const BL = config.blockedLines || [];
    const isBlockedLine = o => BL.some(b => {
      const lb = String((o && (o.display_label || o.label || o.provider_name)) || '');
      const uo = String((o && o.url) || '');
      return (lb && lb.indexOf(b) >= 0) || (uo && uo.indexOf(b) >= 0);
    });
    const isOfficial = upIsOfficial;
    const pickLine = j => (j && ((j.line && j.line.url) || (j.urls && j.urls[0] && j.urls[0].url) || j.resolved_url || j.url)) || '';
    /* v53b：4 路并发扫描（原来串行 26 条要 70s+，把事件循环占满，同用户正在起的播放全被拖慢）。
       并发 4 平衡速度与上游压力；每条分析内部已有超时/缓存 */
    const scanOne = async (o) => {
      if (isBlockedLine(o)) return null;
      const lb = (o && (o.display_label || o.label || o.provider_name)) || '官方';
      let uo = String((o && o.url) || '');
      let lu = '';
      if (uo && !uo.startsWith('resolve://')) lu = uo;
      else {
        const ticket = uo.replace('resolve://', '');
        if (!ticket) return null;
        try { const lj = await upResolveLine(ticket); lu = pickLine(lj); } catch (e) {}
      }
      if (!lu) return null;
      await new Promise(r => setTimeout(r, 120));
      const r = await analyzeAndLogPlayAd(lb, lu, tk);
      /* v55：必须带 url——前端 ALL_LINE_AD 按 url 建索引，缺了它扫描结果全作废（面板永远「分析中」） */
      return { url: lu, label: lb, official: isOfficial(o), verdict: r ? r.verdict : 'error', discAd: r ? r.discAd : 0, blocks: (r && r.adBlocks) || [], clean: r ? r.verdict === 'clean' : false };
    };
    const CH = 4;
    for (let i = 0; i < rawOpts.length; i += CH) {
      const rs = await Promise.all(rawOpts.slice(i, i + CH).map(o => scanOne(o).catch(() => null)));
      rs.forEach(x => { if (x) out.push(x); });
    }
  } catch (e) { log('error', 'ad-scan', '全线路扫描异常: ' + (e.message || e)); }
  if (out.length) {
    SCAN_CACHE.set(tk, { t: Date.now(), out });
    if (SCAN_CACHE.size > 50) { let del = SCAN_CACHE.size - 50; for (const k of SCAN_CACHE.keys()) { if (del-- <= 0) break; SCAN_CACHE.delete(k); } }
  }
  return out;
}
async function filterPlaylist(text, base, cfg, token, depth = 0) {
  if (depth > 4) return { text, blocked: 0 };
  if (!/#EXT-X-STREAM-INF/i.test(text)) return filterMedia(text, base, cfg, token);
  const lines = text.split('\n').map(l => l.replace(/\r$/, ''));
  const variants = [];
  for (let i = 0; i < lines.length; i++) {
    const ln = lines[i].trim();
    if (ln.startsWith('#EXT-X-STREAM-INF') && ln.indexOf('I-FRAME') === -1) {
      let u = ''; for (let j = i + 1; j < lines.length; j++) { if (!lines[j].trim().startsWith('#')) { u = lines[j].trim(); break; } }
      if (u) variants.push({ line: i, url: absUrl(u, base), rewritten: null });
    }
  }
  let total = 0;
  for (const v of variants) {
    try {
      const vt = await fetchText(v.url, 20000);   // 变体清单动辄数千切片，超时给宽一点，失败则回退原始地址
      const sub = await filterPlaylist(vt, v.url, cfg, token, depth + 1);
      total += sub.blocked;
      v.rewritten = '/api/m3u8filter?url=' + encodeURIComponent(v.url) + (token ? ('&token=' + encodeURIComponent(token)) : '');
    } catch (e) { v.rewritten = v.url; }
  }
  const out = [];
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i]; const ln = raw.trim();
    if (ln.startsWith('#EXT-X-STREAM-INF') && ln.indexOf('I-FRAME') === -1) {
      out.push(raw);
      let k = i + 1; while (k < lines.length && lines[k].trim().startsWith('#')) k++;
      if (k < lines.length) { const v = variants.find(x => x.line === i); out.push(v && v.rewritten ? v.rewritten : lines[k].trim()); i = k; }
      continue;
    }
    out.push(raw);
  }
  const body = out.join('\n').replace(/^#EXTM3U[^\n]*\n?/, '');
  return { text: '#EXTM3U\n# X-AD-BLOCKED: ' + total + '\n' + body, blocked: total };
}
function sendFiltered(res, text) {
  res.writeHead(200, { 'Content-Type': 'application/vnd.apple.mpegurl; charset=utf-8', 'Cache-Control': 'max-age=20', 'Access-Control-Allow-Origin': '*' });
  res.end(text);
}
/* 过滤清单（带 30s 缓存，指纹含 enabled/tsProxy/blacklist/token 防串号）。
   被 /api/m3u8filter 路由与 resolve 内联合并共用。返回过滤后清单文本；非 m3u8 / 失败返回 null。
   主清单走 rewriteMasterM3u8 轻量改写各码率变体地址；媒体清单走 filterPlaylist 内联过滤。 */
function rewriteMasterM3u8(raw, masterUrl, token) {
  const lines = raw.split('\n').map(l => l.replace(/\r$/, ''));
  const tokQ = token ? '&token=' + encodeURIComponent(token) : '';
  const out = [];
  for (let i = 0; i < lines.length; i++) {
    const ln = lines[i].trim();
    if (ln.startsWith('#EXT-X-I-FRAME-STREAM-INF')) {
      out.push(lines[i].replace(/URI="([^"]+)"/g, (m, u) => 'URI="' + proxyMasterUrl(u, masterUrl, tokQ) + '"'));
      continue;
    }
    if (ln.startsWith('#EXT-X-STREAM-INF') && ln.indexOf('I-FRAME') === -1) {
      out.push(lines[i]);
      let k = i + 1; while (k < lines.length && lines[k].trim().startsWith('#')) k++;
      if (k < lines.length) { out.push(proxyMasterUrl(lines[k].trim(), masterUrl, tokQ)); i = k; }
      continue;
    }
    out.push(lines[i]);
  }
  const body = out.join('\n').replace(/^#EXTM3U[^\n]*\n?/, '');
  return '#EXTM3U\n# X-AD-BLOCKED: 0 (master)\n' + body;
}
function proxyMasterUrl(u, masterUrl, tokQ) {
  return '/api/m3u8filter?url=' + encodeURIComponent(absUrl(u, masterUrl)) + tokQ;
}
const AD_INFLIGHT = new Map();   /* v41.1：同键并发去重——resolve 后台预热与前端 m3u8filter 请求共用一次上游拉取 */
async function filterManifestCached(target, token) {
  if (!target) return null;
  const fp = (config.adFilter.enabled ? 1 : 0) + ':' + (config.adFilter.tsProxy ? 1 : 0)
    + ':' + (config.adFilter.blacklist || []).join(',');
  const cacheKey = fp + '|' + target + '|' + (token || '');
  const hit = AD_CACHE.get(cacheKey);
  if (hit && Date.now() - hit.t < AD_CACHE_TTL) return hit.text;
  const inflight = AD_INFLIGHT.get(cacheKey);
  if (inflight) return inflight;
  const p = (async () => {
    const _t0 = Date.now();
    const raw = await fetchText(target);
    if (!/#EXTM3U/i.test(raw)) return null;                       // 非 m3u8（如 mp4 二进制）不内联
    if (/#EXT-X-STREAM-INF/i.test(raw)) {                         // 主清单：轻量改写各码率变体地址走代理（按需拉取+过滤，不递归拉全码率，避免拖慢 resolve/预热）
      const txt = rewriteMasterM3u8(raw, target, token);
      AD_CACHE.set(cacheKey, { t: Date.now(), text: txt });
      if (AD_CACHE.size > 300) { let del = AD_CACHE.size - 300; for (const k of AD_CACHE.keys()) { if (del-- <= 0) break; AD_CACHE.delete(k); } }
      log('info', 'perf', 'm3u8 主清单 ' + (Date.now() - _t0) + 'ms 大小=' + txt.length + 'B ' + target.slice(0, 90));
      return txt;
    }
    const result = config.adFilter.enabled
      ? await filterPlaylist(raw, target, config.adFilter, token)
      : { text: absolutizeMediaText(raw, target), blocked: 0 };
    AD_CACHE.set(cacheKey, { t: Date.now(), text: result.text });
    if (AD_CACHE.size > 300) { let del = AD_CACHE.size - 300; for (const k of AD_CACHE.keys()) { if (del-- <= 0) break; AD_CACHE.delete(k); } }
    log('info', 'perf', 'm3u8 媒体清单 ' + (Date.now() - _t0) + 'ms 大小=' + result.text.length + 'B 拦截=' + (result.blocked || 0) + ' ' + target.slice(0, 90));
    return result.text;
  })().catch(e => { console.warn('[m3u8filter]', e.message); return null; }).finally(() => AD_INFLIGHT.delete(cacheKey));
  AD_INFLIGHT.set(cacheKey, p);
  return p;
}
/* 方案C 内联合并：对 m3u8 线路把过滤清单随 resolve 一并返回（前端 blob 直喂 HLS，省一次浏览器→服务端往返）。
   仅内联媒体清单、跳过 mp4/主清单/取失败（回落到原 m3u8filter 路径）。 */
async function resolveInlineManifest(lu, tk) {
  if (!lu) return null;
  if (/\.(mp4|m4v|mov|webm|flv|mkv|ts|key)(\?|$)/i.test(lu)) return null;  // 直连 mp4 等，不走清单
  try { return await filterManifestCached(lu, tk); } catch (e) { return null; }
}

function mapItem(x, mediaFn) {
  const media = mediaFn(x);
  return {
    id: x.id,
    title: x.title || x.name || '',
    media,
    poster: x.poster_path ? IMG + 'w500' + x.poster_path : '',
    year: (x.release_date || x.first_air_date || '').slice(0, 4),
    score: x.vote_average || 0
  };
}

async function buildHome() {
  /* 并发拉取全部栏目（多栏目自由组合：TMDB 榜单 + 采集站最新） */
  /* v72：后台加了采集站却没去「首页栏目管理」里配栏目 → 首页一片空白，
     看着像采集站没生效。这里把「还没配置成栏目」的采集站自动补成栏目，
     加了站就能直接在首页看到内容（要改顺序/改名再去栏目管理里调）。 */
  let colsCfg = (config.home && config.home.columns) || [];
  /* v73：空壳没有任何栏目配置时，注入内置豆瓣栏目（数据来自豆瓣公开榜单，无需密钥），
     首页开箱就有内容；站长一旦在后台配过栏目，就以配置为准，不再注入 */
  if (!colsCfg.length) {
    colsCfg = [
      { type: 'douban', key: 'db_series', label: '热门剧集', kind: 'series' },
      { type: 'douban', key: 'db_movie', label: '热门电影', kind: 'movie' },
      { type: 'douban', key: 'db_variety', label: '热门综艺', kind: 'variety' },
      { type: 'douban', key: 'db_anime', label: '热门动漫', kind: 'anime' }
    ];
  }
  if ((config.collectList || []).length) {
    const used = {};
    colsCfg.forEach(c => { if (c && c.type === 'collect' && c.stationId) used[c.stationId] = 1; });
    const miss = (config.collectList || []).filter(s => !used[s.id]);
    if (miss.length) {
      colsCfg = colsCfg.concat(miss.map(s => ({ type: 'collect', key: 'collect', stationId: s.id, label: s.name })));
    }
  }
  const cols = (await Promise.all(colsCfg.map(async col => {
    try {
      if (col.type === 'collect') {
        const st = (config.collectList || []).find(c => c.id === col.stationId);
        if (!st) return { label: col.label || '采集', items: [] };
        const list = await collectList(st, 1);
        return { label: col.label || st.name, items: list.map(v => ({
          id: v.id, title: v.name, media: 'collect', poster: v.poster || '', year: v.year, score: 0, station: st.id
        })) };
      }
      if (col.type === 'douban') {
        /* v73：内置豆瓣栏目 —— 前端 homeCard 点击后按片名去采集站聚合播放 */
        try {
          const list = await doubanList(col.kind || 'series', 1, 20);
          return { label: col.label || '热门推荐', items: list.map(x => ({
            id: x.id, title: x.title, media: col.kind === 'movie' ? 'movie' : 'tv',
            poster: x.poster_url, year: x.year, score: x.score
          })) };
        } catch (e) { return { label: col.label || '热门推荐', items: [] }; }
      }
      const def = COLS[col.key];
      if (!def) return null;
      /* 栏目缓存 2h；失败自动重试 3 次（TMDB 偶发限流/超时自愈） */
      let d = null, lastErr = null;
      for (let i = 0; i < 3 && !d; i++) {
        try { d = await tmdbFetch(def.path, Object.assign({ page: 1 }, def.params || {}), 7200000); }
        catch (e) { lastErr = e; await new Promise(r => setTimeout(r, 600 * (i + 1))); }
      }
      if (!d) { console.error('[home] 栏目拉取失败', col.key, lastErr && lastErr.message); return { label: col.label || '栏目', items: [] }; }
      return { label: col.label || def.label, items: (d.results || []).slice(0, 20).map(x => mapItem(x, def.media)) };
    } catch (e) { return { label: col.label || '栏目', items: [] }; }
  }))).filter(Boolean);
  return cols;
}

/* ---------- 采集站 (AppleCMS v10 标准) ---------- */
/* v73：采集站地址规范化。
   用户常把「播放页地址 / m3u8 直链 / 光秃秃的域名」当成 API 地址填进来，
   存进去以后每次列表请求都打到一个不存在的路径，表现为首页空、点进去「暂无分集」。
   这里在保存时统一：
     - 非法/非 http(s)      → 直接报错拦下
     - 播放地址/m3u8 直链   → 直接报错并提示要填 API 根地址
     - 只填了域名           → 自动补 /api.php/provide/vod（fixed:true，前端提示「已自动补全」）
     - 带了 ?ac=videolist   → 去掉查询串，只留 API 根
   只做语法层处理，不做网络探测（连通性由 /api/admin/collect/test 负责）。 */
function normalizeCollectApi(raw) {
  let s = String(raw == null ? '' : raw).trim();
  if (!s) return { error: 'API 地址不能为空' };
  if (!/^https?:\/\//i.test(s)) {
    return { error: 'API 地址需以 http:// 或 https:// 开头（如 https://api.example.com/api.php/provide/vod）' };
  }
  /* 播放地址 / 视频直链 —— 一眼就能看出来的填错 */
  if (/\.(m3u8|mp4|mkv|ts|flv)(\?|#|$)/i.test(s) || /\/index\.m3u8/i.test(s)) {
    return { error: '填的是视频直链，不是采集 API。苹果CMS 采集地址形如 https://域名/api.php/provide/vod ' };
  }
  if (/\/(vod|video|play|detail|index\.php\/vod)/i.test(s) && !/api\.php/i.test(s)) {
    /* 例如 https://xxx/voddetail/123.html —— 是播放页不是 API 根 */
    if (/\/vod(type|detail|play)?\/[\d_-]+\.html/i.test(s)) {
      return { error: '填的是播放页地址，不是采集 API。请填 https://域名/api.php/provide/vod ' };
    }
  }
  let u;
  try { u = new URL(s); } catch (e) { return { error: 'API 地址格式无法解析' }; }
  if (!u.hostname) return { error: 'API 地址缺少域名' };
  const before = u.toString().replace(/\/+$/, '');
  /* 去掉 ?ac=videolist&... 之类的查询串与 hash */
  u.search = '';
  u.hash = '';
  let path = u.pathname.replace(/\/+$/, '');
  let fixed = false;
  if (!/api\.php/i.test(path)) {
    /* 只填了域名根（或任意非 API 路径）→ 直接挂到标准 API 根 */
    path = (path && path !== '/' ? path : '') + '/api.php/provide/vod';
    fixed = true;
  } else {
    /* 已含 api.php：保留到 api.php 层，后面多余路径（如 /provide/vod/from/xxx）由 collectRaw 处理 */
    const m = path.match(/^(.*?\/api\.php(?:\/provide\/vod)?)(\/.*)?$/i);
    if (m) path = m[1];
  }
  u.pathname = path;
  let api = u.toString().replace(/\/+$/, '');
  if (before !== api) fixed = true;
  if (!/api\.php\/provide\/vod$/i.test(api)) {
    /* 兜底：保证结尾是标准 API 根，collectRaw 依赖这个特征 */
    if (!/api\.php$/i.test(api)) api = api + '/api.php/provide/vod';
  }
  return { api: api, fixed: fixed };
}
async function collectRaw(station, qs) {
  const cb = station.api.replace(/\/$/, '');
  const url = cb.includes('/api.php/provide/vod') ? `${cb}/?ac=videolist&${qs}` : `${cb}/api.php/provide/vod/?ac=videolist&${qs}`;
  log('info', 'collect', '请求 ' + url.slice(0, 160));
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 9000);
  try {
    const r = await fetch(url, { signal: ctrl.signal, headers: { 'User-Agent': 'Mozilla/5.0' } });
    return await r.json();
  } finally { clearTimeout(t); }
}
function parsePlay(v) {
  const froms = (v.vod_play_from || '').split('$$$');
  const blocks = (v.vod_play_url || '').split('$$$');
  const sources = [];
  for (let i = 0; i < froms.length; i++) {
    const eps = (blocks[i] || '').split('#').map(e => {
      const idx = e.lastIndexOf('$');
      return { name: e.slice(0, idx), url: e.slice(idx + 1) };
    }).filter(e => e.url);
    if (eps.length) sources.push({ from: froms[i] || ('线路' + (i + 1)), episodes: eps });
  }
  return sources;
}
/* v72：采集站原始条目缓存。
   很多采集站（典型：360zy）只开放「列表」接口，wd 搜索 / ids 精确取都是关的，
   于是首页看着有卡片，点进去却报「暂无片源」。这里把每次列表拉取的原始条目按 vod_id 存一份，
   播放时直接用 id 从缓存里取原始条目解析播放地址，不再依赖站方开不开搜索。 */
const COLLECT_RAW = new Map();   // stationId -> {t, map:{vod_id: raw}}，10 分钟 TTL
function collectRawPut(sid, list) {
  let e = COLLECT_RAW.get(sid);
  if (!e || Date.now() - e.t > 600000) { e = { t: Date.now(), map: {} }; COLLECT_RAW.set(sid, e); }
  for (const v of (list || [])) if (v && v.vod_id != null) e.map[String(v.vod_id)] = v;
  if (COLLECT_RAW.size > 40) { let del = COLLECT_RAW.size - 40; for (const k of COLLECT_RAW.keys()) { if (del-- <= 0) break; COLLECT_RAW.delete(k); } }
  return e;
}
function collectRawGet(sid, vid) {
  const e = COLLECT_RAW.get(sid);
  if (!e || Date.now() - e.t > 600000) return null;
  return e.map[String(vid)] || null;
}
/* 按 id 精确取：先摸缓存，没有再试站方的 ids= 参数（有的站支持） */
async function collectById(station, vid) {
  const hit = collectRawGet(station.id, vid);
  if (hit) return hit;
  try {
    const j = await collectRaw(station, 'ids=' + encodeURIComponent(vid));
    if (j && j.list && j.list.length) { collectRawPut(station.id, j.list); return j.list[0]; }
  } catch (e) {}
  return null;
}
function collectDetail(v) {
  if (!v) return null;
  /* 有的站只填 vod_blurb（短简介）不填 vod_content，取的时候两个都看；
     还有的站简介里塞了 HTML 实体，直接显示会露出 &nbsp; 这类脏字符 */
  const raw = String(v.vod_content || v.vod_blurb || '');
  const plot = raw
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'")
    .replace(/\s+/g, ' ').trim().slice(0, 600);
  return {
    plot,
    actors: String(v.vod_actor || '').trim(),
    director: String(v.vod_director || '').trim(),
    type: String(v.type_name || v.vod_class || '').trim(),
    area: String(v.vod_area || '').trim(),
    lang: String(v.vod_lang || '').trim(),
    remark: String(v.vod_remarks || '').trim()
  };
}
/* 直接用「采集站 id + 站内 vod_id」取可播结果（不依赖站方搜索接口） */
async function playByVid(sid, vid) {
  const st = (config.collectList || []).find(x => x.id === sid);
  if (!st) return null;
  const raw = await collectById(st, vid);
  if (!raw) return null;
  return {
    station: st.name, stationId: st.id, id: raw.vod_id, name: raw.vod_name,
    year: raw.vod_year || '', sources: parsePlay(raw),
    detail: collectDetail(raw),
    poster: raw.vod_pic || ''
  };
}
async function collectList(station, pg) {
  try {
    const j = await collectRaw(station, 'pg=' + (pg || 1));
    if (!j || !j.list) return [];
    collectRawPut(station.id, j.list);   /* v72：顺手把原始条目存进缓存，供播放时按 id 取 */
    return j.list.map(v => ({
      id: v.vod_id, name: v.vod_name, year: v.vod_year || '',
      poster: v.vod_pic || '', remark: v.vod_remarks || ''
    }));
  } catch (e) { return []; }
}
async function collectSearch(station, name) {
  try {
    const j = await collectRaw(station, 'wd=' + encodeURIComponent(name));
    if (!j || !j.list) { log('warn', 'collect', station.name + ' 搜「' + name + '」无结果/返回异常'); return []; }
    /* v73c：搜索路径也要带 detail + poster。以前只有按 id 精确取（playByVid）才带，
       从豆瓣卡/分类页降级进来的播放页按片名搜索 → 拿不到简介/演员/海报，
       播放页只能摆「该资源来自采集站」占位文案，「播放历史」里也没图 */
    const r = j.list.map(v => ({
      id: v.vod_id, name: v.vod_name, year: v.vod_year || '',
      poster: v.vod_pic || '', remark: v.vod_remarks || '',
      sources: parsePlay(v), detail: collectDetail(v)
    }));
    log('info', 'collect', station.name + ' 搜「' + name + '」→ ' + r.length + ' 条');
    return r;
  } catch (e) { log('error', 'collect', station.name + ' 搜索失败: ' + (e.message || e)); return []; }
}

const AGG_CACHE = new Map();   // 搜索名 -> {t, out}，5 分钟 TTL：重复搜索直接命中
async function aggregatePlay(name) {
  const key = String(name || '').trim().toLowerCase();
  const hit = AGG_CACHE.get(key);
  if (hit && Date.now() - hit.t < 300000) return hit.out;
  const stations = config.collectList || [];
  /* 并行搜所有采集站（原来串行，两站最坏 18s），单站自带 9s 超时 */
  const rs = await Promise.all(stations.map(st => collectSearch(st, name).catch(() => []).then(arr => arr.map(v => Object.assign(v, { station: st.name, stationId: st.id })))));
  const out = [];
  for (const r of rs) for (const v of r) out.push({ station: v.station, stationId: v.stationId, id: v.id, name: v.name, year: v.year, poster: v.poster || '', remark: v.remark || '', sources: v.sources, detail: v.detail || null });
  AGG_CACHE.set(key, { t: Date.now(), out });
  if (AGG_CACHE.size > 200) { let del = AGG_CACHE.size - 200; for (const k of AGG_CACHE.keys()) { if (del-- <= 0) break; AGG_CACHE.delete(k); } }
  return out;
}

/* ---------- 本周追剧周历（TMDB discover 按日聚合，服务端缓存 6h） ---------- */
function weekMonday(base) {
  const bj = new Date(Date.now() + 8 * 3600e3);          // 北京时间
  if (base) { const d = new Date(base + 'T00:00:00Z'); bj.setUTCFullYear(d.getUTCFullYear()); bj.setUTCMonth(d.getUTCMonth()); bj.setUTCDate(d.getUTCDate()); }
  const dow = (bj.getUTCDay() + 6) % 7;                   // 周一=0
  bj.setUTCDate(bj.getUTCDate() - dow);
  return bj.toISOString().slice(0, 10);
}
const WD_LABEL = ['周一', '周二', '周三', '周四', '周五', '周六', '周日'];
function bjToday() { return new Date(Date.now() + 8 * 3600e3).toISOString().slice(0, 10); }

/* v41.4：追剧日历主源切到上游的追剧日历接口（/v1/watch-calendar，自建签名体系）。
   该源返回「本周各平台热播更新」的中文剧集/动漫/综艺/电影，按热度排序，天然无 2018/2023 老剧。
   off=周偏移 / date=任意日期（取其所在周）；上游不可用时回退到原 TMDB 按日聚合逻辑（weeklyBuildTmdb）。 */

/* v73：内置豆瓣数据源 —— 公开接口，无需任何密钥。
   空壳实例既没有 TMDB 凭据也没有上游资源库，首页栏目/分类页/追剧日历不该是一片空白。
   用豆瓣的公开榜单垫底：片名/海报/年份/评分齐全，播放线路仍由站长接入的采集站提供
   （点击卡片 → 按片名去采集站聚合搜索，这条链路 v72 已经打通）。
   主站 m.douban.com 偶发风控，cmliussss 公共 CDN 是圈内通用备用，三主机轮换。 */
const DOUBAN_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36';
const DOUBAN_HOSTS = ['https://m.douban.com', 'https://m.douban.cmliussss.net', 'https://m.douban.cmliussss.com'];
async function doubanJson(pathQs, ttlMs) {
  const ckey = 'db|' + pathQs;
  const hit = cache.get(ckey);
  if (hit && Date.now() - hit.t < (ttlMs || 6 * 3600e3)) return hit.data;
  let lastErr = null;
  for (const host of DOUBAN_HOSTS) {
    try {
      const r = await fetch(host + '/rexxar/api/v2/' + pathQs, {
        headers: { 'User-Agent': DOUBAN_UA, 'Referer': 'https://movie.douban.com/', 'Accept': 'application/json' },
        signal: AbortSignal.timeout(9000)
      });
      if (!r.ok) throw new Error('HTTP ' + r.status);
      const j = await r.json();
      cache.set(ckey, { t: Date.now(), data: j });
      return j;
    } catch (e) { lastErr = e; }
  }
  throw lastErr || new Error('douban 全部主机失败');
}
/* 豆瓣榜单 → 上游卡片结构（poster_url/title/year/content_kind/id），前端 upCard 直接渲染。
   id 统一加 db_ 前缀：既不会和上游 av_ id 撞车，也不会被当成真上游 id 去打 /api/up/detail。 */
const DOUBAN_KINDS = {
  movie: 'subject/recent_hot/movie',
  series: 'subject/recent_hot/tv',
  anime: 'subject/recent_hot/tv?category=tv&type=tv_animation',
  variety: 'subject/recent_hot/tv?category=show'
};
async function doubanList(kind, page, limit) {
  const path = DOUBAN_KINDS[kind];
  if (!path) return [];
  const start = (Math.max(1, page | 0) - 1) * (limit | 0);
  const j = await doubanJson(path + (path.includes('?') ? '&' : '?') + 'start=' + start + '&limit=' + (limit | 0));
  return (j && j.items || []).filter(x => x && x.title && x.pic).map(x => ({
    id: 'db_' + x.id,
    title: x.title,
    poster_url: (x.pic && (x.pic.normal || x.pic.large)) || '',
    year: (/^\d{4}/.test(x.card_subtitle || '') ? x.card_subtitle.slice(0, 4) : ''),
    score: (x.rating && x.rating.value) || 0,
    content_kind: kind
  }));
}
/* 追剧日历豆瓣回退：weeklyBuildTmdb（TMDB discover）没有凭据时是全 0 天，照样返回。
   这里拉 4 个热门池（剧集/动漫/综艺/电影各 50 条）按天切片填 7 天——豆瓣没有公开的
   「周几更新」数据，切片不能当真实播出表，但开箱有内容、有海报、能点能搜。 */
async function weeklyBuildDouban(off, date) {
  let mon = weekMonday(date);
  if (!date && off) { const d = new Date(mon + 'T00:00:00Z'); d.setUTCDate(d.getUTCDate() + off * 7); mon = d.toISOString().slice(0, 10); }
  const today = bjToday();
  const mk = (kind) => doubanList(kind, 1, 50).catch(() => []);
  const [series, anime, variety, movie] = await Promise.all([mk('series'), mk('anime'), mk('variety'), mk('movie')]);
  const card = x => ({ id: x.id, title: x.title, poster: x.poster_url || '', year: x.year || '', score: x.score || 0, media: x.content_kind === 'movie' ? 'movie' : 'tv' });
  const days = WD_LABEL.map((wd, i) => {
    const d = new Date(mon + 'T00:00:00Z'); d.setUTCDate(d.getUTCDate() + i);
    const ds = d.toISOString().slice(0, 10);
    const cut = (arr) => { const s = arr.slice(i * 6, i * 6 + 6); return (s.length ? s : arr.slice(0, 4)).map(card); };
    const tv = cut(series), an = cut(anime), va = cut(variety), mv = cut(movie);
    return { date: ds, wd, day: Number(ds.slice(8, 10)), isToday: ds === today,
      counts: { tv: tv.length, anime: an.length, variety: va.length, movie: mv.length },
      tv, anime: an, variety: va, movie: mv };
  });
  return { weekStart: mon, today, days };
}

async function weeklyBuild(off, date) {
  let mon = weekMonday(date);
  if (!date && off) { const d = new Date(mon + 'T00:00:00Z'); d.setUTCDate(d.getUTCDate() + off * 7); mon = d.toISOString().slice(0, 10); }
  const curMon = weekMonday();
  const q = (mon && mon !== curMon) ? ('week=' + mon) : '';
  try {
    const j = await upJson('/v1/watch-calendar', q, 6 * 3600e3);
    if (j && j.object === 'aimovie.watch_calendar' && Array.isArray(j.days) && j.days.length) {
      return aimovieToWeek(j);
    }
  } catch (e) { log('warn', 'weekly', 'aimovie 上游失败，回退 TMDB: ' + (e.message || e)); }
  /* v73：TMDB 无凭据时 discover 全是 0 天，视为无数据 → 豆瓣回退，周历开箱有内容 */
  try {
    const tm = await weeklyBuildTmdb(off, date);
    const hasData = (tm.days || []).some(d => (d.tv || []).length || (d.anime || []).length || (d.variety || []).length || (d.movie || []).length);
    if (hasData) return tm;
  } catch (e) { log('warn', 'weekly', 'TMDB 回退失败，走豆瓣: ' + (e.message || e)); }
  return weeklyBuildDouban(off, date);
}

/* 把上游追剧日历响应映射成前端追剧周历所需结构（groups: series/anime/variety/movie） */
function aimovieToWeek(j) {
  const today = bjToday();
  const days = (j.days || []).map(d => {
    const g = d.groups || {};
    const grp = (key, media, cap) => {
      const gr = g[key] || {};
      const arr = (gr.preview || []).slice(0, cap).map(it => ({
        id: it.id || it.variant_id || '',
        title: it.title || '',
        poster: it.poster_url || '',
        year: String(it.year || ''),
        score: it.heat_score != null ? Math.round(it.heat_score) : 0,
        media,
        ep: it.latest_episode_label || ''
      }));
      return { items: arr, total: gr.total || arr.length };
    };
    const tv = grp('series', 'tv', 18);
    const anime = grp('anime', 'anime', 18);
    const variety = grp('variety', 'variety', 18);
    const movie = grp('movie', 'movie', 12);
    return {
      date: d.date, wd: d.weekday_label || '', day: Number((d.date || '').slice(8, 10)) || 0, isToday: d.date === today,
      counts: { tv: tv.total, anime: anime.total, variety: variety.total, movie: movie.total },
      tv: tv.items, anime: anime.items, variety: variety.items, movie: movie.items
    };
  });
  return {
    weekStart: (j.snapshot && j.snapshot.week_start_date) || (days[0] && days[0].date) || '',
    today, days
  };
}

async function weeklyBuildTmdb(off, date) {
  let mon = weekMonday(date);
  if (!date && off) { const d = new Date(mon + 'T00:00:00Z'); d.setUTCDate(d.getUTCDate() + off * 7); mon = d.toISOString().slice(0, 10); }
  const today = new Date(Date.now() + 8 * 3600e3).toISOString().slice(0, 10);
  const mkDay = async (i) => {
    const d = new Date(mon + 'T00:00:00Z'); d.setUTCDate(d.getUTCDate() + i);
    const ds = d.toISOString().slice(0, 10);
    const tvq = { 'air_date.gte': ds, 'air_date.lte': ds, sort_by: 'popularity.desc', 'vote_count.gte': 2, include_adult: 'false', page: 1 };
    const mvq = { 'primary_release_date.gte': ds, 'primary_release_date.lte': ds, sort_by: 'popularity.desc', include_adult: 'false', page: 1 };
    const mp = r => (r && r.results || []).filter(x => x.poster_path).slice(0, 12).map(x => ({
      id: 'tmdb_' + x.id, title: x.name || x.title || '',
      poster: x.poster_path || '', year: (x.first_air_date || x.release_date || '').slice(0, 4),
      score: Math.round((x.vote_average || 0) * 10) / 10, media: x.title ? 'movie' : 'tv'
    }));
    const [tv, anime, variety, movie] = await Promise.all([
      tmdbFetch('/discover/tv', tvq, 6 * 3600e3).catch(() => null),
      tmdbFetch('/discover/tv', Object.assign({}, tvq, { with_genres: 16, with_original_language: 'ja' }), 6 * 3600e3).catch(() => null),
      tmdbFetch('/discover/tv', Object.assign({}, tvq, { with_genres: '10764|10767' }), 6 * 3600e3).catch(() => null),
      tmdbFetch('/discover/movie', mvq, 6 * 3600e3).catch(() => null)
    ]);
    const cnt = r => (r && Number(r.total_results)) || 0;
    return {
      date: ds, wd: WD_LABEL[i], day: Number(ds.slice(8, 10)), isToday: ds === today,
      counts: { tv: cnt(tv), anime: cnt(anime), variety: cnt(variety), movie: cnt(movie) },
      tv: mp(tv), anime: mp(anime), variety: mp(variety), movie: mp(movie)
    };
  };
  /* 并发限流（v31：一次 4 天 = 16 个 TMDB 请求，首次翻周更快） */
  const pool = async (n, fn) => {
    const out = new Array(7);
    let cur = 0;
    await Promise.all(Array.from({ length: n }, async () => {
      while (cur < 7) { const idx = cur++; out[idx] = await fn(idx); }
    }));
    return out;
  };
  const days = await pool(4, mkDay);
  return { weekStart: mon, today, days };
}

/* ---------- 静态文件 ---------- */
const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.svg': 'image/svg+xml', '.ico': 'image/x-icon'
};
/* HTML 模板占位符：按后台配置在服务端渲染，避免页面上出现 {{XXX}} 原文 */
function tplVars() {
  const siteName = config.siteName || 'AIStream';
  const hero = config.hero || {};
  return {
    'SITE_NAME': siteName,
    'PAGE_TITLE': hero.pageTitle || (siteName + ' · AI 影视'),
    'GATE_SUB': hero.gateSub || 'AI 智能影视聚合 · 请登录后观看'
  };
}
function renderTpl(str) {
  if (!str || str.indexOf('{{') < 0) return str;
  const v = tplVars();
  return str.replace(/\{\{\s*([A-Z_]+)\s*\}\}/g, (m, k) => (Object.prototype.hasOwnProperty.call(v, k) ? v[k] : ''));
}

/* 静态文件 mtime（5 秒缓存，避免每个请求都 stat 一次磁盘） */
const STAT_MTIME = new Map();
function fileMtime(fp) {
  const now = Date.now();
  const hit = STAT_MTIME.get(fp);
  if (hit && now - hit.t < 5000) return hit.ms;
  let ms = 0;
  try { ms = fs.statSync(fp).mtimeMs || 0; } catch (e) { ms = 0; }
  STAT_MTIME.set(fp, { t: now, ms });
  return ms;
}

function serveStatic(req, res, urlPath) {
  let p = decodeURIComponent(urlPath.split('?')[0]);
  if (p === '/admin' || p === '/admin/') p = '/admin.html';
  /* 页面级登录门禁：未带有效会话 Cookie 时，/ 与 /index.html 改发极简登录页 gate.html，
     避免把完整 app.js / player.js 提前下发给未登录访客（F12 不再暴露一整包应用代码） */
  /* v63c：未激活的空壳站一律改发激活页 —— 后台 admin.html 也同样改发。
     之前后台放行、让人用管理员账号登进去激活，实际是多余的门槛（激活码校验在服务端，
     本来就不需要登录），别人还得知道 admin 密码才能激活，白绕一圈。 */
  if ((p === '/' || p === '/index.html' || p === '/player.html' || p === '/admin' || p === '/admin.html') && !licActive()) p = '/activate.html';
  if (p === '/' || p === '/index.html') {
    const sid = getCookie(req, SID_NAME);
    const s = sid ? sessions[sid] : null;
    const authed = s && Date.now() - (s.createdAt || 0) < SESSION_TTL;
    if (!authed) p = '/gate.html';
  }
  if (p === '/' ) p = '/index.html';
  const fp = path.join(PUBLIC_DIR, path.normalize(p).replace(/^(\.\.[/\\])+/, ''));
  if (!fp.startsWith(PUBLIC_DIR)) { res.writeHead(403); res.end('forbidden'); return; }
  fs.readFile(fp, (err, buf) => {
    /* v73c：异步回调执行时若响应头已发出（请求被更早的分支/超时逻辑响应过），
       再 writeHead 会抛 ERR_HTTP_HEADERS_SENT —— 因为没有 uncaughtException 处理，
       一次竞态就把整个进程打崩（实测：容器反复重启 RestartCount 飙到 9+）。
       这里双写防护 + 留痕（记录是哪个 URL 走到的），以后能顺藤摸到真正的双写源头 */
    if (res.headersSent) {
      log('warn', 'static', '双响应防护触发: ' + req.method + ' ' + urlPath.slice(0, 120));
      try { res.end(); } catch (e) {}
      return;
    }
    if (err) { res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }); res.end('404'); return; }
    const ext = path.extname(fp);
    /* html/js/css 一律「每次校验」+ ETag：
       ① 后台改了站名/标题要立刻生效；② 部署新版 admin.js/app.js 后用户浏览器不能再拿旧脚本
       （旧脚本提交旧字段会把已保存的配置冲掉，表现为「保存后又复原」）；有 ETag 时命中仍是 304，开销极小 */
    const headers = { 'Content-Type': MIME[ext] || 'application/octet-stream' };
    if (ext === '.html' || ext === '.js' || ext === '.css') {
      headers['Cache-Control'] = 'no-cache, must-revalidate';
      const etag = '"' + buf.length.toString(16) + '-' + Number(fileMtime(fp)).toString(16) + '"';
      headers.ETag = etag;
      if ((req.headers['if-none-match'] || '') === etag) { res.writeHead(304, headers); return res.end(); }
    }
    let out = buf;
    if (ext === '.html') {
      try { out = Buffer.from(renderTpl(buf.toString('utf8')), 'utf8'); }
      catch (e) { log('error', 'static', '模板渲染失败: ' + p + ' ' + (e.message || e)); out = buf; }
    }
    res.writeHead(200, headers);
    res.end(out);
  });
}

/* ---------- 路由 ---------- */
const server = http.createServer(async (req, res) => {
  const u = new URL(req.url, 'http://localhost');
  const p = u.pathname;
  const method = req.method.toUpperCase();
  req._t0 = Date.now();
  /* 基础安全响应头 */
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'no-referrer');

  /* 站点图标（不进门禁，浏览器打开任何页面都会来要） */
  if (p === '/favicon.ico') {
    const FAV_PNG = Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAACAAAAAgCAYAAABzenr0AAAAfUlEQVR42u3XQQrAIAwEQH8gPfT/T7XUQ0HEonHjBqOQ885BNBvidYefSaBpZmiGdmFW' +
      'h1cIRniBYIV/iANghucZBryHDkAixAAUZBowC4EBpAgoQAJRAYxAVAE9iL0B/i6hz4fI52dE/Y41FpKzE5oA0IuJiWpmopwur+cPP6ul2BS6jkoAAAAA' +
      'SUVORK5CYII=', 'base64');
    res.writeHead(200, { 'Content-Type': 'image/png', 'Content-Length': FAV_PNG.length, 'Cache-Control': 'public, max-age=86400' });
    return res.end(FAV_PNG);
  }

  try {
    /* 公开：登录页品牌 */
    if (p === '/api/public' && method === 'GET') {
      return sendJSON(res, 200, { siteName: config.siteName, hero: config.hero || null, needLogin: true, regEnabled: !!(config.reg && config.reg.enabled), inviteRequired: !!((config.points || {}).invite || {}).requireRegister });
    }
    /* 登录 */
    if (p === '/api/auth/login' && method === 'POST') {
      const b = await readBody(req);
      const user = users.find(x => x.username === b.username);
      const ip = (req.socket && req.socket.remoteAddress) || '';
      /* 防暴力破解：同 IP 连续失败 5 次锁定 15 分钟 */
      const lf = loginFails.get(ip);
      if (lf && lf.until > Date.now()) {
        log('warn', 'auth', 'IP 锁定中拒绝登录: ' + ip);
        return sendJSON(res, 429, { error: '失败次数过多，请 ' + Math.ceil((lf.until - Date.now()) / 60000) + ' 分钟后再试' });
      }
      if (!user || user.passwordHash !== sha(b.password || '')) {
        const rec = lf || { n: 0, until: 0 };
        rec.n++;
        if (rec.n >= 5) { rec.until = Date.now() + 15 * 60 * 1000; rec.n = 0; log('warn', 'auth', '连续失败 5 次，锁定该 IP 15 分钟: ' + ip); }
        loginFails.set(ip, rec);
        log('warn', 'auth', '登录失败: ' + (b.username || '?') + ' ip=' + ip + ' 已败 ' + rec.n + ' 次');
        return sendJSON(res, 401, { error: '用户名或密码错误（连续失败 5 次将锁定 15 分钟）' });
      }
      loginFails.delete(ip);
      const token = uid();
      sessions[token] = { userId: user.id, createdAt: Date.now() };
      log('info', 'auth', '登录成功: ' + user.username + ' ip=' + ip);
      res.setHeader('Set-Cookie', sidCookie(token, false));
      return sendJSON(res, 200, { token, user: { id: user.id, username: user.username, role: user.role } });
    }
    /* 注册（后台可关；开着时任何人可自助建普通账号） */
    if (p === '/api/auth/register' && method === 'POST') {
      if (!(config.reg && config.reg.enabled)) { log('warn', 'auth', '注册被拒绝（注册已关闭）'); return sendJSON(res, 403, { error: '管理员已关闭注册' }); }
      const b = await readBody(req);
      const name = String(b.username || '').trim();
      const pw = String(b.password || '');
      const ip = (req.socket && req.socket.remoteAddress) || '';
      if (!/^[a-zA-Z0-9_\u4e00-\u9fa5]{2,20}$/.test(name)) return sendJSON(res, 400, { error: '用户名需 2-20 位（中文/字母/数字/下划线）' });
      if (pw.length < 6) return sendJSON(res, 400, { error: '密码至少 6 位' });
      if (users.find(x => x.username === name)) return sendJSON(res, 409, { error: '用户名已存在' });
      /* 邀请注册：带码先校验有效性；后台开了「必须邀请码」则没码直接拒 */
      const inv = String(b.invite || b.inviteCode || '').trim();
      const pinv = (config.points || {}).invite || {};
      let inviter = null;
      if (inv) {
        inviter = users.find(x => x.inviteCode && x.inviteCode.toLowerCase() === inv.toLowerCase());
        if (!inviter) return sendJSON(res, 400, { error: '邀请码无效' });
      } else if (pinv.requireRegister) {
        log('warn', 'auth', '注册被拒（缺少邀请码）: ' + name);
        return sendJSON(res, 400, { error: '需要邀请码才能注册，请联系已注册用户索取' });
      }
      const nu = { id: uid(), username: name, passwordHash: sha(pw), role: 'user', createdAt: Date.now(), points: 0 };
      users.push(nu); saveUsers();
      /* 新用户按后台「注册访问权限」模板落权限（未配置的栏目默认全允许，避免普通用户权限过高） */
      const hasAny = VIEW_KEYS.some(k => ((config.reg || {}).defaultPerm || {})[k] !== undefined);
      if (hasAny) {
        const m = (config.viewPerm.users || (config.viewPerm.users = {}));
        m[name] = regPermRow();
        saveConfig();
        log('info', 'auth', '新用户 ' + name + ' 按注册模板授权，IPTV=' + m[name].iptv);
      }
      /* 邀请人奖励（受每日上限，达到上限不再发但注册仍成功） */
      if (inviter) {
        const d = userDaily(inviter);
        const cap = Number(pinv.dailyCap) > 0 ? Number(pinv.dailyCap) : 9999;
        if (d.invitePts < cap) {
          const g = addPoints(inviter, Number(pinv.perInvite) || 0, '邀请注册');
          d.invitePts += g; inviter.invited = (inviter.invited || 0) + 1; saveUsers();
        }
        log('info', 'auth', '邀请注册: ' + name + ' ← 邀请人 ' + inviter.username);
      }
      const token = uid();
      sessions[token] = { userId: nu.id, createdAt: Date.now() };
      log('info', 'auth', '新用户注册: ' + name + ' ip=' + ip);
      res.setHeader('Set-Cookie', sidCookie(token, false));
      return sendJSON(res, 200, { token, user: { id: nu.id, username: nu.username, role: nu.role } });
    }
    /* 登出 */
    if (p === '/api/auth/logout' && method === 'POST') {
      const h = (req.headers['authorization'] || '').match(/^Bearer\s+(.+)$/i);
      if (h) delete sessions[h[1]];
      res.setHeader('Set-Cookie', sidCookie('', true));
      return sendJSON(res, 200, { ok: true });
    }
    /* 当前用户 */
    /* 修改密码（本人） */
    if (p === '/api/auth/change-password' && method === 'POST') {
      const user = authUser(req, u);
      if (!user) return sendJSON(res, 401, { error: '未登录' });
      const b = await readBody(req);
      if (!b.oldPassword || !b.newPassword || String(b.newPassword).length < 6) return sendJSON(res, 400, { error: '新密码至少 6 位' });
      if (user.passwordHash !== sha(b.oldPassword)) return sendJSON(res, 400, { error: '原密码错误' });
      user.passwordHash = sha(b.newPassword);
      saveUsers();
      return sendJSON(res, 200, { ok: true });
    }
    if (p === '/api/auth/me' && method === 'GET') {
      const user = authUser(req, u);
      if (!user) return sendJSON(res, 401, { error: '未登录' });
      /* v71：token 有效但会话 Cookie 没了（用户清过 Cookie / 关浏览器自动清 / 站点 Cookie 被拦）
         → 顺手把 Cookie 补回去，用同一个 token 当 sid。
         不补的后果：大门禁只认 Cookie → 访问 / 一律被打回登录页，登录页又凭 token 判定
         「已登录」→ 跳回 / → 再被打回 → 整页无限循环刷新（线上实测 12 秒 200+ 次 /api/auth/me）。
         补了 Cookie，下一次访问 / 就能拿到完整首页，环自然解开。 */
      try {
        const bm = (req.headers['authorization'] || '').match(/^Bearer\s+(.+)$/i);
        const tk0 = bm ? bm[1] : '';
        const cur = getCookie(req, SID_NAME);
        const cs = cur ? sessions[cur] : null;
        const cookieOk = !!(cs && Date.now() - (cs.createdAt || 0) < SESSION_TTL);
        if (!cookieOk && tk0 && sessions[tk0]) {
          res.setHeader('Set-Cookie', sidCookie(tk0));
          log('info', 'auth', '会话 Cookie 缺失，已凭有效 token 补发（防登录页刷新死循环）');
        }
      } catch (e) {}
      return sendJSON(res, 200, { user: { id: user.id, username: user.username, role: user.role, points: user.points || 0, vip: vipInfo(user) } });
    }

    /* v63 授权：免登录查询激活状态（激活页/后台授权页都要用） */
    if (p === '/api/license/status' && method === 'GET') {
      machineId();
      return sendJSON(res, 200, licInfo());
    }
    /* v63 授权：提交授权码激活（免登录，未激活的实例唯一能做的事） */
    if (p === '/api/license/activate' && method === 'POST') {
      const b = await readBody(req).catch(() => ({}));
      const v = licVerify(b.code);
      if (!v.ok) { log('warn', 'license', '激活失败: ' + (v.reason || '未知')); return sendJSON(res, 400, { error: v.reason || '授权码无效' }); }
      config.license = config.license || {};
      const code = String(b.code || '').trim().replace(/\s+/g, '');
      config.license.code = code;
      config.license.at = Date.now();
      /* v73f：码里带了签发方联系方式 → 写进本实例（激活页/签发台账都显示签发方最新的联系方法） */
      if (v.c) config.license.contact = String(v.c).slice(0, 300);
      /* v63d：台账回写「该码已在 X 时激活」（签发方是本机时才看得到） */
      const rec = licFind(code);
      if (rec) { rec.activatedAt = Date.now(); rec.lastMid = machineId(); }
      saveConfig();
      _licMemo = { t: 0, ok: null };
      log('info', 'license', '站点已激活 exp=' + (v.exp || '永久'));
      /* v73f：码里带了签发方站点地址 → 异步上报激活回执，让签发方台账记下「已激活/对方机器码」 */
      if (v.u) licReport(v.u, code);
      return sendJSON(res, 200, { ok: true, info: licInfo() });
    }
    /* v73f：激活回执接收端（签发方用）。免登录 —— 对方实例激活成功那一刻自动 POST 过来。
       只验「码是本机签的」（签名），不比本机机器码（码绑的是对方机器）。伪造最多把台账激活时间写假，无实害 */
    if (p === '/api/license/report' && method === 'POST') {
      const b = await readBody(req).catch(() => ({}));
      const v = licParseCode(b.code);
      if (!v.ok) return sendJSON(res, 400, { error: v.reason || '授权码无效' });
      const rec = licFind(String(b.code || '').trim().replace(/\s+/g, ''));
      if (rec) {
        rec.activatedAt = Number(b.at) || Date.now();
        rec.lastMid = String(b.mid || '').toUpperCase().slice(0, 16);
        saveConfig();
        log('info', 'license', '收到激活回执 mid=' + rec.lastMid + '（码 id=' + rec.id + '）');
      }
      return sendJSON(res, 200, { ok: true });
    }

    const user = authUser(req, u);
    /* v63 授权门禁：未激活的空壳站点，除「授权/登录」相关接口外一律 402。
       前端（app.js / admin.js）收到 needLicense 就跳 /activate.html。
       ⚠️ 必须排在登录门禁「之前」：否则未登录的人撞到的是 401「未登录」，
       会被前端当成「该去登录」而不是「该去激活」，在空壳上凭空多一道没账号可用的登录墙。 */
    if (p.startsWith('/api/') && !licActive()) {
      const LIC_FREE = ['/api/license/status', '/api/license/activate', '/api/admin/license', '/api/admin/license/gen'];
      if (LIC_FREE.indexOf(p) < 0) return sendJSON(res, 402, { error: '站点未授权，请先激活后再使用', needLicense: true });
    }

    /* 以下 API 均需登录（静态页面/前端资源不拦截，由页面内 API 调用保证登录门禁） */
    if (p.startsWith('/api/') && !user && p !== '/api/dimg') return sendJSON(res, 401, { error: '未登录' });

    /* SSE 广播通道 */
    if (p === '/api/stream' && method === 'GET') {
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', 'Connection': 'keep-alive', 'Access-Control-Allow-Origin': '*' });
      res.write('retry: 3000\n\n');
      sseClients.add(res);
      if (config.announcement && config.announcement.enabled) sseSend(res, { type: 'announcement', data: config.announcement });
      req.on('close', () => sseClients.delete(res));
      return;
    }

    /* 本周追剧周历（主源=上游追剧日历接口，回退 TMDB 按日聚合，再回退内置热门池；服务端 6h 缓存）；off=周偏移，date=任意日期（取其所在周） */
    if (p === '/api/weekly' && method === 'GET') {
      if (!viewAllowed(user, 'rec')) return sendJSON(res, 200, { weekStart: '', today: '', days: [] });
      const off = parseInt(u.searchParams.get('off') || '0', 10) || 0;
      const dateM = (u.searchParams.get('date') || '').match(/^\d{4}-\d{2}-\d{2}$/);
      try { return sendJSON(res, 200, await weeklyBuild(dateM ? 0 : off, dateM ? dateM[0] : '')); }
      catch (e) { log('error', 'weekly', e.message || e); return sendJSON(res, 200, { weekStart: '', today: '', days: [] }); }
    }

    /* IPTV 直播：解析 m3u 清单（登录后可用） */
    if (p === '/api/iptv' && method === 'GET') {
      const conf = config.iptv || {};
      const srcN = ((conf.sources || []).filter(s => s.enabled !== false && s.url)).length || (conf.m3uUrl ? 1 : 0);
      if (!conf.enabled || !srcN) return sendJSON(res, 200, { enabled: false, channels: [] });
      if (!iptvAllowed(user)) return sendJSON(res, 200, { enabled: true, denied: true, channels: [] });
      try {
        const all = await iptvAllChannels();
        /* 按分组权限过滤：后台矩阵按会员等级/用户控制能看哪些分组（用户未设置的分组继承所属等级） */
        const ch = all.filter(c => iptvGroupAllowed(user, c.group));
        const usedSrc = {};
        for (const c of ch) usedSrc[c.src] = c.srcName || c.src;
        /* EPG 当前节目（可选，失败不影响频道列表） */
        let now = {};
        if (conf.epgEnabled && conf.epgUrl) { try { now = await epgNow(conf.epgUrl); } catch (e) {} }
        /* 频道 → EPG 匹配：tvg-id 直配，否则按名称归一化匹配 */
        let chNameMap = {};
        const eh = EPG_CACHE.get(conf.epgUrl);
        if (eh) chNameMap = eh.chName || {};   // 同时含 id->display-name 与 归一化名->id
        const idNorm = {};
        for (const k of Object.keys(chNameMap)) idNorm[normCh(k)] = chNameMap[k];
        const now2 = {};
        const chOut = [];
        for (const c of ch) {
          let hit = c.tid && now[c.tid];
          if (!hit) {
            const pid = idNorm[normCh(c.name)];
            hit = pid && now[pid];
          }
          /* v31 防窥：响应不再携带真实流地址（F12 里只有不透明 cid） */
          if (hit) now2[c.cid] = hit;
          chOut.push({ cid: c.cid, name: c.name, group: c.group, tid: c.tid, src: c.src, direct: /\.(mp4|mkv|webm)(\?|$)/i.test(c.url), logo: c.lcid ? '/api/iptv/logo?c=' + c.lcid + '&token=' + encodeURIComponent(reqToken(req, u)) : '' });
        }
        return sendJSON(res, 200, { enabled: true, count: ch.length, total: all.length, sources: usedSrc, channels: chOut, now: now2, groupOrder: (conf.groupOrder || []) });
      } catch (e) { log('error', 'iptv', '清单拉取失败: ' + (e.message || e)); return sendJSON(res, 200, { enabled: true, error: '清单拉取失败: ' + (e.message || e), channels: [] }); }
    }

    /* v57b：m3u8 改写 —— 相对地址按清单真实 URL 补成绝对地址，再统一包一层本站代理 /api/iptv/px。
   绝对地址进 IPTV_PX 白名单，代理端只放行清单里出现过的地址（防任意 URL 代理被滥用）。 */
const IPTV_PX = new Map();
function pxAllow(abs) {
  if (IPTV_PX.size > 8000) IPTV_PX.clear();
  IPTV_PX.set(abs, Date.now());
  return abs;
}
/* useProxy=true 时把地址包进本站 /api/iptv/px 由服务端代拉；
   默认 false：只把相对地址补成绝对地址后交给浏览器直连（跟历史行为一致，不占 NAS 转发带宽）。
   注意 base 必须用「跟随 302 之前」的原始地址——ott 这类域名会按来源调度 CDN，
   若用 302 后的 CDN 地址当 base，浏览器直连那个 CDN 节点可能是不可达的（实测 miguvideo 就不通）。 */
function rewriteM3u(txt, baseUrl, token, useProxy) {
  return String(txt || '').split('\n').map(ln => {
    const s = ln.trim();
    if (!s || s[0] === '#') return ln;
    let abs = s;
    if (!/^https?:\/\//i.test(s)) {
      try { abs = new URL(s, baseUrl).href; } catch (e) { return ln; }
    }
    if (!useProxy) return abs;
    pxAllow(abs);
    return '/api/iptv/px?u=' + encodeURIComponent(abs) + (token ? '&token=' + encodeURIComponent(token) : '');
  }).join('\n');
}

/* IPTV 流代理：?ch= 不透明频道 id（v31 防窥，不再接受明文 u=）+ ?token=（video 标签带不了 header） */
    if (p === '/api/iptv/stream' && method === 'GET') {
      if (!iptvAllowed(user)) return sendJSON(res, 403, { error: 'IPTV 未对你的账号开放' });
      const chId = u.searchParams.get('ch') || '';
      if (IPTV_CGROUP.has(chId) && !iptvGroupAllowed(user, IPTV_CGROUP.get(chId))) return sendJSON(res, 403, { error: '该分组未对你的账号开放' });
      const target = IPTV_CID.get(chId);
      if (!target) return sendJSON(res, 403, { error: '流地址不在当前播放清单内' });
      try {
        const tryFetch = u => {
          const h2 = { 'User-Agent': 'Mozilla/5.0' };
          if (req.headers.range) h2.Range = req.headers.range;
          return fetch(u, { headers: h2 });
        };
        /* 本机域名/本机 IP 回流改写优先（容器里访问宿主机 LAN IP 不通），失败回落原始地址 */
        const t2 = isLocalUrl(target) ? iptvFix(target) : target;
        const r = await tryFetch(t2).catch(e => (t2 !== target ? tryFetch(target) : Promise.reject(e)));
        const h = { 'Content-Type': r.headers.get('content-type') || 'video/mp2t', 'Access-Control-Allow-Origin': '*', 'Accept-Ranges': r.headers.get('accept-ranges') || 'bytes' };
        const cr = r.headers.get('content-range'); if (cr) h['Content-Range'] = cr;
        const cl = r.headers.get('content-length'); if (cl) h['Content-Length'] = cl;
        /* v57b：清单必须改写后返回，不能原样透传——
           ① 相对路径会被 hls.js 按本站 URL 拼出 /api/iptv/01.m3u8 打回自己 → 401；
           ② 即便补成绝对地址，咪咕等源浏览器直连也不通（IPTV 系统能播是因为走它服务端代理），
              所以统一改写成走本站 /api/iptv/px 代理，由服务端去拉。 */
        const ctUp = String(r.headers.get('content-type') || '').toLowerCase();
        const looksPlaylist = /mpegurl|text\/plain|application\/octet-stream/.test(ctUp);
        if (looksPlaylist) {
          const txt = await r.text();
          if (/^\s*#EXTM3U/.test(txt)) {
            /* 顶层清单只补绝对地址、不代拉。
               关键：base 必须用「未经 iptvFix 回环改写」的原始地址 target（即宿主机 LAN IP 那一个），
               不能用 t2（127.0.0.1）——127.0.0.1 只在 NAS 本机有意义，回给浏览器它会去连自己，直接失败。 */
            const out = rewriteM3u(txt, target, reqToken(req, u), false);
            res.writeHead(r.status, { 'Content-Type': 'application/vnd.apple.mpegurl', 'Access-Control-Allow-Origin': '*' });
            return res.end(out);
          }
          res.writeHead(r.status, h);
          return res.end(txt);
        }
        res.writeHead(r.status, h);
        if (r.body && r.body.getReader) {
          const { Readable } = require('stream');
          Readable.fromWeb(r.body).pipe(res);
        } else res.end();
      } catch (e) { try { res.writeHead(502, { 'Content-Type': 'text/plain' }); res.end('upstream error'); } catch (x) {} }
      return;
    }

    /* v57b：清单内 m3u8/分片代理（浏览器直连咪咕等源会失败，必须服务端代拉）。
       只放行清单改写时登记过的地址，避免变成任意 URL 代理。 */
    if (p === '/api/iptv/px' && method === 'GET') {
      if (!iptvAllowed(user)) return sendJSON(res, 403, { error: 'IPTV 未对你的账号开放' });
      const abs = u.searchParams.get('u') || '';
      /* 与 /api/m3u8filter 同一标准：登录即可 + 必须是 http(s)。
         （原本用"清单登记白名单"校验，实际会因清单重建/列表刷新登记不到而误杀，已放开） */
      if (!/^https?:\/\//i.test(abs)) return sendJSON(res, 403, { error: '地址非法' });
      try {
        const h2 = { 'User-Agent': 'Mozilla/5.0' };
        if (req.headers.range) h2.Range = req.headers.range;
        const t3 = isLocalUrl(abs) ? iptvFix(abs) : abs;
        const r = await fetch(t3, { headers: h2 });
        const ct = String(r.headers.get('content-type') || '').toLowerCase();
        if (/mpegurl|text\/plain/.test(ct)) {
          const txt = await r.text();
          if (/^\s*#EXTM3U/.test(txt)) {
            /* px 是显式代拉通道：这里继续用代拉（base 用 302 后的最终地址，因为后续也由服务端拉） */
            const out = rewriteM3u(txt, r.url || t3, reqToken(req, u), true);
            res.writeHead(r.status, { 'Content-Type': 'application/vnd.apple.mpegurl', 'Access-Control-Allow-Origin': '*' });
            return res.end(out);
          }
          res.writeHead(r.status, { 'Content-Type': ct, 'Access-Control-Allow-Origin': '*' });
          return res.end(txt);
        }
        const h = { 'Content-Type': r.headers.get('content-type') || 'video/mp2t', 'Access-Control-Allow-Origin': '*', 'Accept-Ranges': r.headers.get('accept-ranges') || 'bytes' };
        const cr2 = r.headers.get('content-range'); if (cr2) h['Content-Range'] = cr2;
        const cl2 = r.headers.get('content-length'); if (cl2) h['Content-Length'] = cl2;
        res.writeHead(r.status, h);
        if (r.body && r.body.getReader) {
          const { Readable } = require('stream');
          Readable.fromWeb(r.body).pipe(res);
        } else res.end();
      } catch (e) { try { res.writeHead(502, { 'Content-Type': 'text/plain' }); res.end('upstream error'); } catch (x) {} }
      return;
    }

    /* IPTV 台标代理：?c= 不透明台标 id（清单里的 logo 常被生成成 127.0.0.1，浏览器侧连不上） */
    if (p === '/api/iptv/logo' && method === 'GET') {
      if (!iptvAllowed(user)) { res.writeHead(403); return res.end('denied'); }
      const lg = IPTV_LOGO_CID.get(u.searchParams.get('c') || '');
      const hit = LOGO_CACHE.get(lg);
      if (hit && Date.now() - hit.t < 3600000) {
        res.writeHead(200, { 'Content-Type': hit.ct, 'Cache-Control': 'public, max-age=3600' });
        return res.end(hit.buf);
      }
      try {
        const lgT = isLocalUrl(lg) ? iptvFix(lg) : lg;   /* v57：本机 IP/域名台标同样要回环改写 */
        const r = await fetch(lgT, { headers: { 'User-Agent': 'Mozilla/5.0' }, signal: AbortSignal.timeout(8000) });
        const buf = Buffer.from(await r.arrayBuffer());
        const ct = r.headers.get('content-type') || 'image/png';
        if (r.ok && buf.length) { LOGO_CACHE.set(lg, { t: Date.now(), ct, buf }); if (LOGO_CACHE.size > 400) LOGO_CACHE.clear(); }
        res.writeHead(r.ok ? 200 : 404, { 'Content-Type': ct, 'Cache-Control': 'public, max-age=3600' });
        return res.end(buf);
      } catch (e) { try { res.writeHead(502); res.end(''); } catch (x) {} }
      return;
    }

    /* 前台配置(开关/提示/公告弹窗/首页/广播) */
    if (p === '/api/config' && method === 'GET') {
      return sendJSON(res, 200, {
        siteName: config.siteName,
        home: config.home,
        tip: config.home.tip,
        toggles: config.toggles,
        announcement: config.announcement.enabled ? config.announcement : { enabled: false },
        lastBroadcast: config.lastBroadcast || null,
        broadcast: { enabled: !!(config.broadcast || {}).enabled },
        hasParse: (config.parseList || []).length > 0,
        adFilter: { enabled: !!config.adFilter.enabled, tsProxy: !!config.adFilter.tsProxy },
        iptv: { enabled: !!(config.iptv && config.iptv.enabled), allowed: iptvAllowed(user) },
        views: VIEW_KEYS.reduce((m, k) => (m[k] = viewAllowed(user, k), m), {}),
        weekly: { enabled: config.weekly === undefined || !!(config.weekly && config.weekly.enabled !== false) },
        ads: (config.ads || {}).enabled ? config.ads : { enabled: false },
        points: {
          enabled: !!(config.points || {}).enabled,
          checkin: (config.points || {}).checkin || {},
          invite: { perInvite: ((config.points || {}).invite || {}).perInvite || 0, requireRegister: !!((config.points || {}).invite || {}).requireRegister },
          watch: (config.points || {}).watch || {}
        },
        vip: { enabled: !!(config.vip || {}).enabled, levels: (config.vip || {}).levels || [] },
        /* v63 其他设置：播放器加载卡文案 + 继续发现轮播间隔（前端按缺项回落默认文案） */
        misc: { rotMs: ((config.misc || {}).rotMs) || 10, text: ((config.misc || {}).text) || {} }
      });
    }

    /* m3u8 广告过滤代理：改写清单、切片保持采集站直链（浏览器直连，不占家庭上行） */
    if (p === '/api/m3u8filter' && method === 'GET') {
      const target = u.searchParams.get('url');
      if (!target) return sendJSON(res, 400, { error: 'missing url' });
      /* 优先 ?token=（原生 HLS / iframe 无法自定义请求头），否则回落到 Authorization 头 */
      const hm = (req.headers['authorization'] || '').match(/^Bearer\s+(.+)$/i);
      const token = u.searchParams.get('token') || (hm ? hm[1] : '') || '';
      const text = await filterManifestCached(target, token);
      if (text == null) {
        res.writeHead(502, { 'Content-Type': 'application/vnd.apple.mpegurl; charset=utf-8' });
        return res.end('#EXTM3U\n');
      }
      return sendFiltered(res, text);
    }

    /* 广告过滤实时预览：分析一条播放地址（直链 m3u8 / resolve:// 凭证 / 主清单）的插播广告情况。
       与线上过滤共用同一套 analyzeMedia 规则（含断点插播 discAd），后台「广告过滤」页与选线面板都走这里。 */
    if (p === '/api/ad-preview' && method === 'GET') {
      const target0 = u.searchParams.get('url');
      if (!target0) return sendJSON(res, 400, { error: 'missing url' });
      const token = u.searchParams.get('token') || '';
      try {
        let target = target0;
        if (target.startsWith('resolve://')) {
          const t = target.replace('resolve://', '');
          const lj = await upResolveLine(t);
          const pick = j => (j && ((j.line && j.line.url) || (j.urls && j.urls[0] && j.urls[0].url) || j.resolved_url || j.url)) || '';
          target = pick(lj);
          if (!target) return sendJSON(res, 200, { error: '无法解析该线路', blocked: 0, discAd: 0, discMarkers: 0, adBlocks: [], verdict: 'error' });
        }
        /* v55：先用全线路扫描缓存（warm 预扫描写的），命中秒回——面板 annotateLine 的单条
           分析就不再现场打上游；未命中才真分析 */
        for (const sc of SCAN_CACHE.values()) {
          const hit = (sc.out || []).find(x => x.url === target);
          if (hit && Date.now() - sc.t < 300000) {
            return sendJSON(res, 200, { verdict: hit.verdict, discAd: hit.discAd, discMarkers: 0, adBlocks: hit.blocks || [], enabled: !!config.adFilter.enabled, cached: 1 });
          }
        }
        const r = await analyzeM3u8(target, config.adFilter, token);
        r.enabled = !!config.adFilter.enabled;
        try { r.host = regDomain(new URL(target).host); } catch (e) { r.host = ''; }
        return sendJSON(res, 200, r);
      } catch (e) {
        return sendJSON(res, 200, { error: String(e.message || e), blocked: 0, discAd: 0, discMarkers: 0, adBlocks: [], verdict: 'error' });
      }
    }

    /* 切片代理回退（仅当 adFilter.tsProxy 开启；开启后会占用家庭上行） */
    if (p === '/api/m3u8slice' && method === 'GET') {
      if (!config.adFilter.tsProxy) return sendJSON(res, 403, { error: 'ts proxy disabled' });
      const target = u.searchParams.get('url');
      if (!target) return sendJSON(res, 400, { error: 'missing url' });
      try {
        const ctrl = new AbortController(); const t = setTimeout(() => ctrl.abort(), 20000);
        const r = await fetch(target, { signal: ctrl.signal, headers: { 'User-Agent': 'Mozilla/5.0', 'Referer': target } });
        clearTimeout(t);
        res.writeHead(r.status, { 'Content-Type': r.headers.get('content-type') || 'video/MP2T', 'Access-Control-Allow-Origin': '*' });
        if (r.body && typeof r.body.pipe === 'function') return r.body.pipe(res);
        const buf = await r.arrayBuffer(); res.end(Buffer.from(buf));
      } catch (e) { res.writeHead(502); res.end('ts proxy error'); }
    }

    /* 首页栏目 */
    if (p === '/api/home' && method === 'GET') {
      if (!viewAllowed(user, 'rec')) return sendJSON(res, 200, { columns: [] });
      const cols = await buildHome();
      /* stations / hasUpstream 给前台判断「该显示引导卡片还是空态」用 */
      return sendJSON(res, 200, {
        columns: cols,
        stations: (config.collectList || []).length,
        hasUpstream: !!String(((config.upstream || {}).base) || '')
      });
    }

    /* TMDB 代理 */
    if (p.startsWith('/api/tmdb/') && method === 'GET') {
      const sub = p.replace('/api/tmdb', '') + (u.search || '');
      const data = await tmdbFetch(sub, {}, 1800000);
      return sendJSON(res, 200, data);
    }

    /* 搜索(TMDB + 采集站) */
    if (p === '/api/search' && method === 'GET') {
      const q = u.searchParams.get('q') || '';
      /* TMDB 与采集站并行（原来 TMDB 先串行跑完才轮到采集站） */
      const [tmdb, collect] = await Promise.all([
        tmdbFetch('/search/multi', { query: q, page: 1 }, 600000)
          .then(d => (d.results || []).filter(x => x.media_type === 'movie' || x.media_type === 'tv').slice(0, 20).map(x => mapItem(x, () => x.media_type)))
          .catch(() => []),
        aggregatePlay(q).catch(() => [])
      ]);
      return sendJSON(res, 200, { tmdb, collect });
    }

    /* 播放解析聚合(采集站搜索) */
    if (p === '/api/play' && method === 'GET') {
      /* v72：优先「采集站 id + 站内 vod_id」精确取。
         站点只开放列表接口时，按名字搜必然扑空（表现为首页有卡片、进播放页却「暂无片源」），
         走这条路就能稳定拿到播放地址，顺带把简介/演员/分类一起带回来。 */
      const sid0 = u.searchParams.get('sid') || '';
      const vid0 = u.searchParams.get('vid') || '';
      if (sid0 && vid0) {
        const one = await playByVid(sid0, vid0);
        if (one && (one.sources || []).length) {
          log('info', 'play', '按 id 取到「' + one.name + '」（' + one.station + '）→ ' + one.sources.length + ' 条线路');
          return sendJSON(res, 200, { results: [one], parseList: config.parseList || [], hasParse: (config.parseList || []).length > 0 });
        }
        /* 精确取不到（缓存过期 / 站方 ids 也不支持）→ 落到按名字搜的老路 */
        if (one) log('warn', 'play', '按 id 取到条目但无播放地址，回退按名搜索：' + one.name);
      }
      const name = u.searchParams.get('name') || '';
      const year = u.searchParams.get('year') || '';
      const results = await aggregatePlay(name);
      if (year) results.sort((a, b) => (b.year === year ? 1 : 0) - (a.year === year ? 1 : 0));
      log('info', 'play', '聚合搜索「' + name + '」→ ' + results.length + ' 条结果');
      return sendJSON(res, 200, { results, parseList: config.parseList || [], hasParse: (config.parseList || []).length > 0 });
    }

    /* ================= 上游资源库（自建，需站长自行填写地址与密钥） ================= */
    if (p === '/api/up/feed' && method === 'GET') {
      if (!viewAllowed(user, 'rec')) return sendJSON(res, 200, { sections: [] });
      try {
        const j = await upJson('/v1/feed/home', 'scope=public&mode=preview&sections=6&cards=16', 300000);
        return sendJSON(res, 200, { sections: j.sections || j.cards || [] });
      } catch (e) {
        console.error('[up] feed', e.message);
        /* v73：没配上游（空壳常态）→ 豆瓣热门拼 3 个推荐区块兜底（推荐页开箱有内容） */
        try {
          const mk = (kind, label) => doubanList(kind, 1, 20).then(items => items.length ? { title: label, cards: items } : null).catch(() => null);
          const secs = (await Promise.all([mk('series', '热门剧集'), mk('movie', '热门电影'), mk('variety', '热门综艺')])).filter(Boolean);
          return sendJSON(res, 200, { sections: secs });
        } catch (e2) { return sendJSON(res, 200, { sections: [] }); }
      }
    }
    if (p === '/api/up/catalog' && method === 'GET') {
      const kind = u.searchParams.get('kind') || 'movie';
      if (!viewAllowed(user, kind)) return sendJSON(res, 200, { items: [], total: 0 });
      const page = u.searchParams.get('page') || '1';
      const limit = u.searchParams.get('limit') || '40';
      try {
        let j;
        let pageSize = 0;
        if (kind === 'short') {
          /* 短剧优先走 browse/catalog（支持 limit/page 分页）；上游不支持时回退专用 feed。
             v55：short-drama/feed 每页固定 12 条且必须显式传 page（不传每页都返回第一页），
             所以这里用 12 为页大小并把 pageSize 回给前端，让「显示更多」判断准确 */
          j = await upJson('/v1/browse/catalog', 'kind=short&limit=' + limit + '&page=' + page, 180000).catch(() => null);
          if (!j || !(j.items || j.cards || []).length) {
            j = await upJson('/v1/short-drama/feed', 'limit=12&page=' + page, 180000);
            pageSize = 12;
          }
        } else {
          j = await upJson('/v1/browse/catalog', 'kind=' + encodeURIComponent(kind) + '&limit=' + limit + '&page=' + page, 180000);
        }
        return sendJSON(res, 200, { items: (j && (j.items || j.cards)) || [], pageSize });
      } catch (e) {
        console.error('[up] catalog', e.message);
        /* v73：没配上游（空壳常态）→ 内置豆瓣榜单兜底，分类页开箱有内容 */
        try {
          const items = await doubanList(kind, Number(page) || 1, Number(limit) || 48);
          return sendJSON(res, 200, { items, pageSize: 48 });
        } catch (e2) { return sendJSON(res, 200, { items: [] }); }
      }
    }
    /* v53：起播预热——首页点击卡片时调用。服务端立即返回，detail 在后台拉齐进缓存，
       播放页 initUp 再拉就是 0ms 命中（浏览器端预取会被页面跳转取消，不可靠） */
    if (p === '/api/up/warm' && method === 'GET') {
      const wid = u.searchParams.get('id') || '';
      if (/^av_/.test(wid)) {
        (async () => {
          try {
            const d = await upJson('/v1/catalog/' + encodeURIComponent(wid), '', 300000);
            const e0 = await upJson('/v1/catalog/' + encodeURIComponent(wid) + '/episodes', '', 300000).catch(() => null);
            /* v53b：顺手预热第一集的 resolve（line_options 缓存）+ 前 8 条线路凭证转换，
               这样用户点进播放页时 resolve 也是 0ms 命中——冷起播从 ~4s 砍到 ~2s */
            const eps = (e0 && (e0.episodes || e0.items || e0.list)) || [];
            const tk = eps[0] && (eps[0].token || eps[0].playback_token);
            if (tk) {
              const rj = await upJson('/v1/playback/resolve/' + encodeURIComponent(tk), '', 300000).catch(() => null);
              const opts = (rj && (rj.line_options || rj.lines)) || [];
              opts.slice(0, 8).forEach(o => {
                const uo = String((o && o.url) || '');
                if (uo.startsWith('resolve://')) upResolveLine(uo.slice('resolve://'.length)).catch(() => {});
              });
              /* v55：顺手触发全线路插播扫描（fire-and-forget）——以前要等播放页起播后 2s 才扫，
                 用户点开换源面板时大部分线路还是「分析中…」。现在从点首页卡片就开始扫，进页面基本已标好 */
              scanAllLines(tk).catch(() => {});
            }
          } catch (e) {}
        })();
      }
      return sendJSON(res, 200, { ok: true });
    }
    if (p === '/api/up/search' && method === 'GET') {
      const q = u.searchParams.get('q') || '';
      const limit = u.searchParams.get('limit') || '40';
      /* v54：上游搜索降级——/v1/browse/catalog?q= 挂掉时（10-15 晚抽风一小时，全站搜索空、
         随机一部失效），本机用 feed 卡片做标题匹配顶上。覆盖不了全库但至少能搜、有海报 */
      const norm = s => String(s || '').toLowerCase().replace(/\s|第[一二三四五六七八九十0-9]+季|season\s*\d+/gi, '');
      let items = [];
      let degraded = 0;
      try {
        const j = await upJson('/v1/browse/catalog', 'q=' + encodeURIComponent(q) + '&limit=' + limit, 600000);
        items = j.cards || j.items || [];
      } catch (e) { console.error('[up] search', e.message); }
      if (!items.length) {
        try {
          /* 与 /api/up/feed 相同的查询参数，否则上游返回空 */
          const fd = await upJson('/v1/feed/home', 'scope=public&mode=preview&sections=6&cards=16', 180000);
          const pool = [];
          for (const s of (fd.sections || [])) for (const c of (s.cards || s.items || [])) if (c && c.id) pool.push(c);
          const nq = norm(q);
          items = pool.filter(c => {
            const t = norm(c.title || c.normalized_title);
            return nq && (t.indexOf(nq) >= 0 || (t.length >= 2 && nq.indexOf(t) >= 0));
          }).slice(0, parseInt(limit, 10) || 40);
          if (items.length) { degraded = 1; log('info', 'search', '上游搜索降级：feed 本地匹配「' + q + '」命中 ' + items.length + ' 条'); }
        } catch (e) {}
      }
      return sendJSON(res, 200, { items, degraded });
    }
    /* 上游剧集分页合并：每页固定 48 条，按 offset 翻页并发拉全（长剧可达 20 页）。
       合并结果写入 detailCache(full:true)，前端 quick 模式回来补拉时优先复用，避免重复打上游 */
    const _mergeJobs = new Map();   // id -> Promise（防止并发重复合并）
    async function mergeEpisodes(id, e0) {
      const ej0 = (e0 && (e0.episodes || e0.items || e0.list)) || [];
      const pz = (e0 && e0.episode_pagination) || {};
      const total = Number(pz.total_count) || Number(e0 && e0.episode_count) || ej0.length;
      const pgSz = Number(pz.limit) || Math.max(ej0.length, 1);
      const pages = Math.min(20, Math.ceil(total / pgSz));
      if (pages <= 1) return e0;
      const rs = await Promise.all(Array.from({ length: pages - 1 }, (_, i) =>
        upJson('/v1/catalog/' + encodeURIComponent(id) + '/episodes', 'offset=' + ((i + 1) * pgSz), 300000).catch(() => null)));
      const seen = new Set(ej0.map(x => x && x.id));
      const all = ej0.slice();
      for (const r of rs) {
        for (const ep of ((r && (r.episodes || r.items || r.list)) || [])) {
          if (ep && ep.id && !seen.has(ep.id)) { seen.add(ep.id); all.push(ep); }
        }
      }
      all.sort((a, b) => (Number(a && a.number) || 0) - (Number(b && b.number) || 0));
      return Object.assign({}, e0, { episodes: all });
    }
    async function getFullEpisodes(id, d, e0, pages) {
      if (pages <= 1) return e0;
      const cached = detailCache.get(id);
      if (cached && cached.full) return cached.e;
      if (_mergeJobs.has(id)) return await _mergeJobs.get(id);
      const job = (async () => {
        try {
          const merged = await mergeEpisodes(id, e0);
          detailCache.set(id, { t: Date.now(), d, e: merged, full: true });
          log('info', 'up', '剧集分页合并(后台): ' + id.slice(0, 24) + ' 共 ' + ((merged.episodes || merged.items || merged.list) || []).length + ' 集');
          return merged;
        } finally { _mergeJobs.delete(id); }
      })();
      _mergeJobs.set(id, job);
      return await job;
    }
    if (p === '/api/up/detail' && method === 'GET') {
      /* 分发版：没配上游时直接返回空，不要抛 500。
         只装采集站的用户根本不该碰到上游接口，返回空可以让调用方安静降级 */
      if (!String(((config.upstream || {}).base) || '')) {
        return sendJSON(res, 200, { detail: null, episodes: [], noUpstream: true });
      }
      const id = u.searchParams.get('id') || '';
      const phase = u.searchParams.get('phase');   // '1' = 快速模式：仅返回第 1 页分集，立即渲染+起播，剩余页后台合并
      const fill = u.searchParams.get('fill');      // '1' = 确保拉全部分页（优先复用后台合并结果，不重复打上游）
      try {
        const [d, e0] = await Promise.all([
          upJson('/v1/catalog/' + encodeURIComponent(id), '', 300000),
          upJson('/v1/catalog/' + encodeURIComponent(id) + '/episodes', '', 300000).catch(() => null)
        ]);
        /* 上游剧集接口每页固定 48 条，分页参数是 offset（episode_pagination: {offset,limit,total_count,has_more}）。
           按 offset 翻页并发拉全，否则长剧只能看到前 48 集 */
        const ej0 = (e0 && (e0.episodes || e0.items || e0.list)) || [];
        const pz = (e0 && e0.episode_pagination) || {};
        const total = Number(pz.total_count) || Number(e0 && e0.episode_count) || ej0.length;
        const pgSz = Number(pz.limit) || Math.max(ej0.length, 1);
        const pages = Math.min(20, Math.ceil(total / pgSz));
        const hasMore = pages > 1;
        let e = e0;
        if (fill) {
          /* 确保全量：复用后台合并结果（若已合并完）或立即合并，避免每次都重新翻页打上游 */
          e = await getFullEpisodes(id, d, e0, pages);
        } else if (phase === '1' && hasMore) {
          /* 快速模式：先缓存第 1 页并立即返回，剩余分页丢到后台合并，前端先渲染+起播，不再干等全部页 */
          detailCache.set(id, { t: Date.now(), d, e: e0, full: false });
          getFullEpisodes(id, d, e0, pages).catch(() => {});   // 后台合并，不 await
          return sendJSON(res, 200, { detail: d, episodes: e0, quick: true, pagination: { total, limit: pgSz, pages, has_more: hasMore } });
        } else if (hasMore) {
          e = await getFullEpisodes(id, d, e0, pages);
        }
        detailCache.set(id, { t: Date.now(), d, e, full: !hasMore || true });
        if (detailCache.size > 600) detailCache.clear();
        return sendJSON(res, 200, { detail: d, episodes: e });
      } catch (ex) {
        /* 上游抖动：30 分钟内成功过的详情直接回退，页面不再「加载失败」 */
        const oc = detailCache.get(id);
        if (oc) { log('warn', 'play', '详情上游失败，回退缓存: ' + id.slice(0, 24)); return sendJSON(res, 200, { detail: oc.d, episodes: oc.e, cached: true }); }
        return sendJSON(res, 500, { error: '详情获取失败' });
      }
    }
    if (p === '/api/up/resolve' && method === 'GET') {
      const tk = u.searchParams.get('token') || '';
      const pickLine = j => (j && ((j.line && j.line.url) || (j.urls && j.urls[0] && j.urls[0].url) || j.resolved_url || j.url)) || '';
      const isBlockedLine = o => {
          const BL = config.blockedLines || [];
          if (!BL.length) return false;
          const lb = String((o && (o.display_label || o.label || o.provider_name)) || '');
          const uo = String((o && o.url) || '');
          return BL.some(b => (lb && lb.indexOf(b) >= 0) || (uo && uo.indexOf(b) >= 0));
        };
      try {
        const rj = await upJson('/v1/playback/resolve/' + encodeURIComponent(tk), '', 300000);
        const rawOpts = (rj && (rj.line_options || rj.lines)) || [];
        const isOfficial = upIsOfficial;
        /* 跟随上游「智能选择」：selected 是上游钦定的那条，preference_weight 是上游的权重排序。
           旧逻辑只按名字里有没有「官方」二字排序，会把专享Y/腾讯这类（名字不含官方但权重最高）挤到后面，
           导致我们默认选中的线和上游管理页显示的不是同一条。 */
        const isSel = o => o && (o.selected === true || o.selected === 'true' || o.selected === 1);
        const pw = o => { const n = Number(o && o.preference_weight); return isNaN(n) ? -1 : n; };
        /* 拉黑过滤 */
        const usable = rawOpts.filter(o => {
          if (isBlockedLine(o)) { log('info', 'play', '跳过已拉黑线路: ' + (o.display_label || o.label || o.provider_name || '官方')); return false; }
          return true;
        });
        usable.sort((a, b) => {
          const sa = isSel(a) ? 1 : 0, sb = isSel(b) ? 1 : 0;
          if (sa !== sb) return sb - sa;                                          /* 1. 上游 selected 置顶 */
          const wa = pw(a), wb = pw(b);
          if (wa !== wb) return wb - wa;                                          /* 2. 按上游权重降序 */
          return (isOfficial(a) ? 0 : 1) - (isOfficial(b) ? 0 : 1);               /* 3. 兜底：官方优先 */
        });
        const skipN = Math.max(0, parseInt(u.searchParams.get('skip') || '0', 10) || 0);
        /* v69：沿用当前播放源（keep=线路名）——自动下一集/手动选集时不再重新挑一条，
           继续用正在播的那条源（命中缓存更快、画质/音量体验一致）。
           ⚠️ 必须在下面用它之前声明：const 有 TDZ，晚声明会让整个 resolve 抛
           「Cannot access 'keepLb' before initialization」，全网播放直接失败（v69 首版踩过） */
        const keepLb = (u.searchParams.get('keep') || '').trim();
        /* v52 秒换预热：后台把前 8 条 ticket 提前转正（rlCache 缓存 10 分钟）。
           之后用户手动换线/自动换线 = 纯本地缓存，不再现场打上游 —— 上游能秒切，我们也秒切。
           v55：debug 请求（换源面板拉列表用）跳过预热——面板只读列表，预热纯属拖慢打开速度 */
        /* v69：沿用当前源时不再预热 8 条凭证——只打算用这一条，预热纯属给上游加压，
           实测把上游打到 429 并发限流，反过来让这条源的体检/转正失败，被迫顺延（得不偿失） */
        if (!u.searchParams.get('debug') && !keepLb) setTimeout(() => {
          /* v69：8 条 → 3 条。实测同时转正 8 条凭证会把上游打到 429 并发限流
             （playback_account_concurrency），反过来让真正要用的那条也转不正、被迫顺延换源。
             换线本来就是「顺延下一条」，预热 3 条足够覆盖常规换线 */
          usable.slice(0, 3).forEach(o => {
            const uo = String((o && o.url) || '');
            if (uo.startsWith('resolve://')) {
              const t2 = uo.slice('resolve://'.length);
              if (t2) upResolveLine(t2).catch(() => {});
            }
          });
        }, 50);
        if (skipN > 0) log('info', 'play', '用户手动换线：跳过前 ' + skipN + ' 条可用线路');
        if (u.searchParams.get('debug')) {
          let conv = null;
          if (u.searchParams.get('debug') === '2') {
            const t0 = usable.map(o => ({ o, t: String((o && o.url) || '').replace('resolve://', '') })).filter(x => x.t);
            for (const x of t0.slice(0, 3)) {
              try {
                const lj = await upJson('/v1/playback/resolve-line', 'view=compact', 600000, 'POST', { ticket: x.t });
                conv = conv || [];
                conv.push({ label: (x.o.display_label || x.o.label || x.o.provider_name) || '官方', raw: JSON.stringify(lj).slice(0, 4000) });
              } catch (e) {
                conv = conv || [];
                conv.push({ label: (x.o.display_label || x.o.label || x.o.provider_name) || '官方', error: String(e.message || e) });
              }
            }
          }
          return sendJSON(res, 200, { debug: true, total: usable.length, conv, lines: usable.map(o => ({ label: (o.display_label || o.label || o.provider_name) || '官方', official: isOfficial(o), selected: isSel(o), weight: pw(o), type: String((o && o.url) || '').startsWith('resolve://') ? 'ticket' : 'direct', url: String((o && o.url) || '') })) });
        }
        /* v69：把用户正在用的那条源挪到队首，下面的选线循环自然就先试它。
           该源失效（体检不过/凭证转不正）时循环里的 continue 会顺延下一条，前端无感知 */
        if (keepLb) {
          const lbOf = o => (o && (o.display_label || o.label || o.provider_name)) || '官方';
          const ki = usable.findIndex(o => lbOf(o) === keepLb);
          if (ki > 0) { const k = usable.splice(ki, 1)[0]; usable.unshift(k); }
          else if (ki === 0) { /* 已是首选，无需重排 */ }
          else log('info', 'play', '续用线路不在当前可用列表（可能已失效），按默认顺序选: ' + keepLb);
        }
        const maxTry = Math.min(usable.length, 8);   /* 单次最多试 8 条，剩余由前端 skip 换线接力 */
        for (let i = 0; i < maxTry; i++) {
          const o = usable[(i + skipN) % usable.length];
          const lb = (o && (o.display_label || o.label || o.provider_name)) || '官方';
          const uo = String((o && o.url) || '');
          if (uo && !uo.startsWith('resolve://')) {
            log('info', 'play', '上游直连线路: ' + lb + ' ← ' + uo.slice(0, 120));
            if (!(await lineIsPlayable(uo))) { log('info', 'play', (keepLb && lb === keepLb ? '续用线路体检未通过，无感顺延: ' : '线路体检未通过，顺延下一条: ') + lb); continue; }
            schedulePlayAd(lb, uo);
            /* v41.1 修复：resolve 不再阻塞等清单过滤（实测把起播拖到 11s+ 且触发前端 22s 超时连环换线）。
               改为后台预热 AD_CACHE，前端随后的 /api/m3u8filter 命中缓存/in-flight 秒回。 */
            resolveInlineManifest(uo, tk).catch(() => {});
            return sendJSON(res, 200, { url: uo, label: lb, official: isOfficial(o) });
          }
          const ticket = uo.replace('resolve://', '');
          if (!ticket) continue;
          try {
            const lj = await upResolveLine(ticket);
            const lu = pickLine(lj);
            if (lu) {
              log('info', 'play', '上游凭证转正: ' + lb + ' ← ' + lu.slice(0, 120));
              if (!(await lineIsPlayable(lu))) { log('info', 'play', (keepLb && lb === keepLb ? '续用线路体检未通过，无感顺延: ' : '线路体检未通过，顺延下一条: ') + lb); continue; }
              schedulePlayAd(lb, lu);
              resolveInlineManifest(lu, tk).catch(() => {});
              return sendJSON(res, 200, { url: lu, label: lb, official: isOfficial(o) });
            }
          } catch (e) {}
        }
        log('warn', 'play', '上游解析无可用线路 token=' + tk.slice(0, 24));
        return sendJSON(res, 200, { url: '', error: '暂无可播线路' });
      } catch (e) { log('error', 'play', '上游解析异常: ' + (e.message || e)); return sendJSON(res, 200, { url: '', error: '解析失败' }); }
    }
    /* 自动识别所有线路插播广告：进入影片/剧集时前端后台调用，逐条分析全部可用线路并落 'play-ad' 日志 */
    if (p === '/api/ad-scan-all' && method === 'GET') {
      const tk = u.searchParams.get('token') || '';
      if (!tk) return sendJSON(res, 400, { error: '缺少 token' });
      const out = await scanAllLines(tk);
      return sendJSON(res, 200, { lines: out, scanned: out.length });
    }
    /* 漏网广告反馈（用户需求：个别遗漏可提交分析、升级规则）。记录到 /data/ad-reports.json 并落 'ad-report' 日志 */
    if (p === '/api/ad-report' && method === 'POST') {
      const b = await readBody(req);
      const rec = {
        t: Date.now(),
        user: (authUser(req, u) && authUser(req, u).username) || '?',
        title: String((b && b.title) || '').slice(0, 120),
        label: String((b && b.label) || '').slice(0, 120),
        url: String((b && b.url) || '').slice(0, 800),
        ts: Number((b && b.ts) || 0) || 0,
        note: String((b && b.note) || '').slice(0, 600)
      };
      try {
        const fp = jp('ad-reports.json');
        let arr = [];
        try { arr = JSON.parse(fs.readFileSync(fp, 'utf8') || '[]'); } catch (e) {}
        arr.push(rec);
        if (arr.length > 800) arr = arr.slice(-800);
        fs.writeFileSync(fp, JSON.stringify(arr, null, 2));
        log('warn', 'ad-report', `漏网广告反馈 ${rec.title} 线路=${rec.label} 时间=${rec.ts}s 备注=${rec.note}`, JSON.stringify(rec));
      } catch (e) { return sendJSON(res, 200, { ok: false, error: String(e.message || e) }); }
      return sendJSON(res, 200, { ok: true });
    }
    /* v36：DLNA 投屏（手机端用）：扫描局域网设备 / 推送播放 / 停止 */
    if (p === '/api/dlna/scan' && method === 'GET') {
      try {
        const list = await dlnaDevices();
        log('info', 'cast', '局域网投屏扫描：发现 ' + list.length + ' 台可用设备');
        return sendJSON(res, 200, { list });
      } catch (e) { return sendJSON(res, 200, { list: [], error: String(e.message || e) }); }
    }
    if (p === '/api/dlna/cast' && method === 'POST') {
      const b = await readBody(req);
      const cu = String((b && b.controlUrl) || '').trim();
      const url = String((b && b.url) || '').trim();
      if (!cu || !url) return sendJSON(res, 400, { error: '缺少设备地址或播放地址' });
      const title = String((b && b.title) || 'AIStream');
      const meta = '<DIDL-Lite xmlns="urn:schemas-upnp-org:metadata-1-0/DIDL-Lite/" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:upnp="urn:schemas-upnp-org:metadata-1-0/upnp/">'
        + '<item id="aistream-1" parentID="0" restricted="1"><dc:title>' + dlnaEsc(title) + '</dc:title>'
        + '<upnp:class>object.item.videoItem</upnp:class>'
        + '<res protocolInfo="http-get:*:video/mp4:*">' + dlnaEsc(url) + '</res></item></DIDL-Lite>';
      try {
        const r1 = await dlnaSoap(cu, 'SetAVTransportURI',
          '<InstanceID>0</InstanceID><CurrentURI>' + dlnaEsc(url) + '</CurrentURI><CurrentURIMetaData>' + dlnaEsc(meta) + '</CurrentURIMetaData>');
        if (r1.status >= 400) return sendJSON(res, 200, { ok: false, error: '设备拒绝了播放请求（HTTP ' + r1.status + '）' });
        await dlnaSoap(cu, 'Play', '<InstanceID>0</InstanceID><Speed>1</Speed>').catch(() => null);
        log('info', 'cast', '已投屏：' + title.slice(0, 24));
        return sendJSON(res, 200, { ok: true });
      } catch (e) { return sendJSON(res, 200, { ok: false, error: String(e.message || e) }); }
    }
    /* 兜底：SSDP 被路由器隔离时，手动输入设备描述地址添加 */
    if (p === '/api/dlna/probe' && method === 'POST') {
      const b = await readBody(req);
      const loc = String((b && b.location) || '').trim();
      if (!loc) return sendJSON(res, 400, { error: '缺少设备地址' });
      try {
        const r = await fetch(loc, { headers: { 'User-Agent': 'aistream/1.0' } });
        const xml = await r.text();
        const d = dlnaParseDesc(xml, loc);
        if (!d) return sendJSON(res, 200, { ok: false, error: '该设备上没有可用的投屏服务（AVTransport）' });
        log('info', 'cast', '手动添加投屏设备：' + d.name);
        return sendJSON(res, 200, { ok: true, device: Object.assign({ location: loc }, d) });
      } catch (e) { return sendJSON(res, 200, { ok: false, error: String(e.message || e) }); }
    }
    if (p === '/api/dlna/stop' && method === 'POST') {
      const b = await readBody(req);
      const cu = String((b && b.controlUrl) || '').trim();
      if (!cu) return sendJSON(res, 400, { error: '缺少设备地址' });
      try {
        await dlnaSoap(cu, 'Stop', '<InstanceID>0</InstanceID>');
        return sendJSON(res, 200, { ok: true });
      } catch (e) { return sendJSON(res, 200, { ok: false, error: String(e.message || e) }); }
    }
    /* ---------- 观看历史（继续观看 / 断点续播） ---------- */
    /* ---------- 广告联盟（前台按 slot 取广告；会员去广告特权在服务端生效） ---------- */
    if (p === '/api/ads' && method === 'GET') {
      const slot = (u.searchParams.get('slot') === 'pause') ? 'pause' : 'sidebar';
      const A = config.ads || {};
      const out = { enabled: false, slot, network: A.network || 'custom', items: [], code: '' };
      if (A.enabled && !vipNoAds(user)) {
        if (slot === 'pause' && !(A.pause && A.pause.enabled)) return sendJSON(res, 200, out);
        if (slot === 'sidebar' && !(A.sidebar && A.sidebar.enabled)) return sendJSON(res, 200, out);
        out.enabled = true;
        if ((A.network || 'custom') === 'code') {
          out.code = String((A.code || {})[slot] || '').slice(0, 20000);
        } else {
          const cand = (A.items || []).filter(x => x.enabled !== false && (x.slots || []).indexOf(slot) >= 0 && x.img);
          const max = slot === 'sidebar' ? Math.max(1, Math.min(6, Number((A.sidebar || {}).max) || 2)) : 1;
          const pool = cand.slice(); const picked = [];
          while (picked.length < max && pool.length) {
            const tot = pool.reduce((s, x) => s + (Number(x.weight) > 0 ? Number(x.weight) : 1), 0) || 1;
            let r = Math.random() * tot, idx = pool.length - 1;
            for (let i = 0; i < pool.length; i++) { r -= (Number(pool[i].weight) > 0 ? Number(pool[i].weight) : 1); if (r <= 0) { idx = i; break; } }
            const it = pool.splice(idx, 1)[0];
            picked.push({ id: it.id, title: it.title || '', img: it.img, link: it.link || '' });
          }
          out.items = picked;
        }
      }
      return sendJSON(res, 200, out);
    }
    /* ---------- 积分中心 / 签到 / 邀请 ---------- */
    if (p === '/api/points/me' && method === 'GET') {
      const pc = config.points || {};
      const d = userDaily(user);
      const today = !!(user.checkin && user.checkin.last === dayKey());
      return sendJSON(res, 200, {
        points: user.points || 0,
        vip: vipInfo(user),
        growth: growthInfo(user),
        checkin: { today, streak: (user.checkin && user.checkin.streak) || 0, last: (user.checkin && user.checkin.last) || '' },
        invite: { code: ensureInviteCode(user), invited: user.invited || 0, perInvite: (pc.invite || {}).perInvite || 0 },
        daily: { watchMin: d.watchMin, date: d.date },
        cfg: { enabled: !!pc.enabled, checkin: pc.checkin || {}, invite: { perInvite: (pc.invite || {}).perInvite || 0, requireRegister: !!(pc.invite || {}).requireRegister }, watch: pc.watch || {} }
      });
    }
    if (p === '/api/checkin' && method === 'POST') {
      const pc = config.points || {};
      if (!pc.enabled) return sendJSON(res, 200, { ok: false, error: '积分系统未开启' });
      const today = dayKey();
      if (user.checkin && user.checkin.last === today) return sendJSON(res, 200, { ok: false, error: '今天已经签到过了', points: user.points || 0, streak: user.checkin.streak || 0 });
      const c = pc.checkin || {};
      let streak = 1;
      if (user.checkin && user.checkin.last === dayKey(new Date(Date.now() - 86400000))) streak = (user.checkin.streak || 0) + 1;
      const bonus = Math.min(Math.max(0, streak - 1), Number(c.streakMax) || 0) * (Number(c.streakBonus) || 0);
      const raw = (Number(c.base) || 0) + bonus;
      const gain = addPoints(user, raw, '每日签到');
      user.checkin = { last: today, streak };
      userDaily(user).checkins = (userDaily(user).checkins || 0) + 1;
      saveUsers();
      return sendJSON(res, 200, { ok: true, gained: gain, streak, points: user.points || 0, msg: '签到成功 +' + gain + ' 分' + (bonus > 0 ? '（连签 ' + streak + ' 天加成）' : '') });
    }
    if (p === '/api/invite' && method === 'GET') {
      return sendJSON(res, 200, { code: ensureInviteCode(user), invited: user.invited || 0, perInvite: ((config.points || {}).invite || {}).perInvite || 0 });
    }
    /* ---------- 积分兑换（会员时长 / 限时权限） ---------- */
    if (p === '/api/redeem' && method === 'GET') {
      const r = config.redeem || {};
      return sendJSON(res, 200, {
        enabled: r.enabled !== false,
        items: (r.items || []).filter(x => x.enabled !== false).map(x => ({
          id: x.id, title: x.title || '', desc: x.desc || '', kind: x.kind === 'perm' ? 'perm' : 'vip',
          level: Number(x.level) || 0, permKey: x.permKey || '', days: Number(x.days) || 0,
          cost: Number(x.cost) || 0, stock: x.stock === undefined ? -1 : Number(x.stock),
          soldOut: (x.stock !== undefined && Number(x.stock) === 0)
        })),
        me: { points: user.points || 0, vip: vipInfo(user) }
      });
    }
    if (p === '/api/redeem' && method === 'POST') {
      const b = await readBody(req);
      const r = config.redeem || {};
      if (r.enabled === false) return sendJSON(res, 200, { ok: false, error: '兑换功能未开启' });
      const it = (r.items || []).find(x => x.id === String(b.id || ''));
      if (!it || it.enabled === false) return sendJSON(res, 200, { ok: false, error: '兑换项不存在或已下架' });
      const stock = it.stock === undefined ? -1 : Number(it.stock);
      if (stock === 0) return sendJSON(res, 200, { ok: false, error: '该兑换项已兑完' });
      const cost = Number(it.cost) || 0;
      if ((user.points || 0) < cost) return sendJSON(res, 200, { ok: false, error: '积分不足，还差 ' + (cost - (user.points || 0)) + ' 分' });
      const days = Number(it.days) || 0;
      if (it.kind === 'perm') {
        const key = String(it.permKey || '');
        if (VIEW_KEYS.indexOf(key) < 0) return sendJSON(res, 200, { ok: false, error: '该兑换项配置的权限无效，请联系管理员' });
        const exp = Date.now() + (days > 0 ? days : 3650) * 86400000;
        user.grants = (user.grants || []).filter(g => g.key !== key);
        user.grants.push({ key: key, expire: exp });
      } else {
        const lv = Number(it.level) || 0;
        const base = Math.max(Date.now(), (user.vip && Number(user.vip.expire)) || 0);
        user.vip = { level: lv, expire: days > 0 ? base + days * 86400000 : 0 };
      }
      user.points = (user.points || 0) - cost;
      if (stock > 0) { it.stock = stock - 1; saveConfig(); }
      saveUsers();
      log('info', 'redeem', '积分兑换: ' + user.username + ' -> ' + (it.title || it.id) + ' -' + cost + ' 分，余 ' + user.points);
      return sendJSON(res, 200, { ok: true, points: user.points, msg: '兑换成功：' + (it.title || '') });
    }
    if (p === '/api/history' && method === 'GET') {
      if (!viewAllowed(user, 'history')) return sendJSON(res, 200, { items: [] });
      return sendJSON(res, 200, { items: (hist[user.id] || []).slice(0, 60) });
    }
    if (p === '/api/history' && method === 'POST') {
      const b = await readBody(req);
      if (b.clear) { hist[user.id] = []; saveHist(); return sendJSON(res, 200, { ok: true }); }
      const it = { id: String(b.id || ''), title: b.title || '', poster: b.poster || '', year: b.year || '',
        ep: b.ep || 0, epTotal: b.epTotal || 0, pos: b.pos || 0, dur: b.dur || 0, t: Date.now() };
      if (!it.id || !it.title) return sendJSON(res, 400, { error: 'bad body' });
      /* v47：未开放「历史记录」栏目时不再落库——否则关了权限照样偷偷攒记录，
         哪天管理员一开权限，一堆陈年记录全冒出来。观看积分照常累加，不受栏目开关影响 */
      if (!viewAllowed(user, 'history')) {
        try { accWatchPoints(user, it.id, it.pos); } catch (e) {}
        return sendJSON(res, 200, { ok: true, ignored: true });
      }
      const arr = hist[user.id] || (hist[user.id] = []);
      const ix = arr.findIndex(x => x.id === it.id);
      if (ix >= 0) arr.splice(ix, 1);
      arr.unshift(it);
      if (arr.length > 60) arr.length = 60;
      saveHist();
      try { accWatchPoints(user, it.id, it.pos); } catch (e) {}
      return sendJSON(res, 200, { ok: true });
    }
    if (p === '/api/history' && method === 'DELETE') {
      const b = await readBody(req);
      hist[user.id] = b.id ? (hist[user.id] || []).filter(x => x.id !== b.id) : [];
      saveHist();
      return sendJSON(res, 200, { ok: true });
    }
    /* ---------- 我的收藏 ---------- */
    if (p === '/api/fav' && method === 'GET') {
      if (!viewAllowed(user, 'fav')) return sendJSON(res, 200, { items: [] });
      return sendJSON(res, 200, { items: favs[user.id] || [] });
    }
    if (p === '/api/fav' && method === 'POST') {
      /* v47：写收藏同样要过「我的收藏」栏目权限。之前只拦了 GET，导致没权限的用户
         点收藏照样 200 保存成功（前端提示成功、数据也进库），只是列表读不出来，
         一旦权限放开历史脏数据全冒出来——现在写入直接 403，前后端口径一致 */
      if (!viewAllowed(user, 'fav')) return sendJSON(res, 403, { error: '管理员未对你的账号开放「我的收藏」功能' });
      const b = await readBody(req);
      const arr = favs[user.id] || (favs[user.id] = []);
      if (b.del) { favs[user.id] = arr.filter(x => x.id !== b.del); saveFavs(); return sendJSON(res, 200, { ok: true, on: false }); }
      if (b.add && b.add.id) {
        const ix = arr.findIndex(x => x.id === b.add.id);
        if (ix >= 0) arr.splice(ix, 1); else arr.unshift(b.add);
        if (arr.length > 100) arr.length = 100;
        saveFavs();
        return sendJSON(res, 200, { ok: true, on: ix < 0 });
      }
      return sendJSON(res, 400, { error: 'bad body' });
    }

    /* 海报图片代理（公开：img 标签无法携带 Authorization；已做内网 SSRF 防护） */
    if (p === '/api/dimg' && method === 'GET') {
      /* 1x1 透明 PNG：第三方图床拉不到时的兜底，避免把 502 抛给浏览器 */
      const BLANK_PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR42mNgAAIAAAUAAen63NgAAAAASUVORK5CYII=', 'base64');
      const src = u.searchParams.get('u') || '';
      let _hh = ''; try { _hh = new URL(src).hostname; } catch (e) {}
      if (!/^https?:\/\//.test(src) || /^(localhost|127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(_hh)) { res.writeHead(403); return res.end(); }
      const ext = (src.split('?')[0].match(/\.(jpg|jpeg|png|webp|gif|bmp|avif)(\/|$)/i) || [])[1] || 'jpg';
      const hk = crypto.createHash('md5').update(src).digest('hex');
      const cacheFile = path.join(DIMGCACHE, hk + '.' + ext);
      const ctyOf = e => (e === 'png' ? 'image/png' : e === 'webp' ? 'image/webp' : e === 'gif' ? 'image/gif' : e === 'avif' ? 'image/avif' : 'image/jpeg');
      /* 内存 + 磁盘双层缓存：海报/剧照等第三方图床 CDN 直链首次拉取后落盘，重复请求秒回，不再每次打上游 */
      const mc = _dimgMem.get(hk);
      if (mc && Date.now() - mc.t < 7 * 86400000) {
        try { const buf = fs.readFileSync(cacheFile); res.writeHead(200, { 'Content-Type': mc.cty, 'Cache-Control': 'public, max-age=86400', 'X-Dimg': 'mem' }); return res.end(buf); } catch (e) {}
      }
      if (fs.existsSync(cacheFile)) {
        try { const buf = fs.readFileSync(cacheFile); const cty = ctyOf(ext); _dimgMem.set(hk, { t: Date.now(), cty }); res.writeHead(200, { 'Content-Type': cty, 'Cache-Control': 'public, max-age=86400', 'X-Dimg': 'disk' }); return res.end(buf); } catch (e) {}
      }
      try {
        /* 豆瓣图床有 Referer 防盗链（无 Referer 返回 418），v73：对豆瓣域名带上来源页；
           其他图床带不带都行，统一带也无副作用 */
        const ih = { 'User-Agent': 'Mozilla/5.0', 'Accept': 'image/*', 'Referer': 'https://movie.douban.com/' };
        let buf = null, cty = 'image/jpeg';
        try {
          const ir = await fetch(src, { headers: ih, signal: AbortSignal.timeout(9000) });
          if (!ir.ok) throw new Error('HTTP ' + ir.status);
          cty = ir.headers.get('content-type') || cty;
          buf = Buffer.from(await ir.arrayBuffer());
        } catch (e1) {
          /* 直连不稳（CloudFront IPv6 可用/IPv4 受限）：走 mihomo 隧道拿原始字节（重试 1 次） */
          let _tp = 0;
          const cands = proxyList();
          const tunnel = () => new Promise((resolve, reject) => {
            const u = new URL(src);
            const pu = cands[(_tp++ % cands.length + cands.length) % cands.length];
            const rq0 = http.request({ host: pu.host, port: pu.port, method: 'CONNECT', path: u.hostname + ':443', timeout: 8000 });
            rq0.on('connect', (pc, socket) => {
              if (pc.statusCode !== 200) { socket.destroy(); return reject(new Error('proxy ' + pc.statusCode)); }
              const rq = https.request(u, {
                method: 'GET',
                createConnection: () => require('tls').connect({ socket, servername: u.hostname }),
                headers: ih, timeout: 9000
              }, rs => {
                const chunks = [];
                rs.on('data', c => chunks.push(c));
                rs.on('end', () => resolve(Buffer.concat(chunks)));
              });
              rq.on('timeout', () => rq.destroy(new Error('timeout')));
              rq.on('error', reject);
              rq.end();
            });
            rq0.on('error', reject);
            rq0.end();
          });
          try { buf = await tunnel(); }
          catch (e2) { buf = await tunnel(); }
        }
        if (!buf || !buf.length) throw new Error('empty image');
        try { fs.writeFileSync(cacheFile, buf); } catch (e) {}
        _dimgMem.set(hk, { t: Date.now(), cty });
        res.writeHead(200, { 'Content-Type': cty, 'Cache-Control': 'public, max-age=86400', 'X-Dimg': 'fresh' });
        return res.end(buf);
      } catch (e) {
        log('warn', 'dimg', src.slice(0, 100) + ' -> ' + (e.message || e));
        /* 拉不到就给一张 1x1 透明占位图（200），别把 502 甩给浏览器：
           ① 控制台/网络面板不再刷红色报错；② <img> 不会抛 onerror，
           卡片里 .ph 占位照常垫底，页面不闪。要不要用代理是站长自己的选择。 */
        res.writeHead(200, { 'Content-Type': 'image/png', 'Cache-Control': 'public, max-age=600', 'X-Dimg': 'blank' });
        return res.end(BLANK_PNG);
      }
    }

    /* ================= 后台 (需管理员) ================= */
    if (p.startsWith('/api/admin/')) {
      if (!isAdmin(user)) return sendJSON(res, 403, { error: '需要管理员权限' });

      if (p === '/api/admin/config' && method === 'GET') {
        return sendJSON(res, 200, config);
      }

      /* ---------- v63 授权管理 ---------- */
      if (p === '/api/admin/license' && method === 'GET') {
        const L = config.license || {};
        licEnsureSelf();
        const cur = String(L.code || '');
        return sendJSON(res, 200, {
          info: licInfo(),
          privKeyTail: L.privateKey ? String(L.privateKey).slice(-24) : '',
          /* 私钥只在站长自己这份配置里存在；空壳仓库没有，签不了码 */
          canSign: !!L.privateKey,
          contact: String(L.contact || ''),
          siteUrl: String(L.siteUrl || ''),   /* v73f：漏了这个后台输入框回填永远是空的 */
          /* v63d 台账：签出去的码一览（没有私钥的实例不该看到签发/管理功能，前端据此隐藏） */
          issued: licLedger().map(r => ({
            id: r.id, mid: r.mid, midFmt: fmtMid(r.mid), exp: r.exp || 0,
            expText: !r.exp ? '永久' : licStamp(r.exp).slice(0, 10),
            createdAt: r.createdAt, createdText: licStamp(r.createdAt),
            activatedAt: r.activatedAt || 0, activatedText: licStamp(r.activatedAt || 0),
            /* v73f：激活方回执上报来的机器码（谁的码被用在哪台机上，一目了然） */
            lastMid: r.lastMid || '', lastMidFmt: r.lastMid ? fmtMid(r.lastMid) : '',
            note: r.note || '', replacedBy: r.replacedBy || '',
            state: licRecState(r),
            isCurrent: !!(cur && r.code === cur),
            /* 码本身只在「未使用 / 本人这台」时下发，避免台账被人直接抄走别人的码 */
            code: (!r.activatedAt && !r.locked && !r.replacedBy) ? r.code : ''
          }))
        });
      }
      if (p === '/api/admin/license' && method === 'POST') {
        const b = await readBody(req).catch(() => ({}));
        const act = String(b.action || 'activate');
        if (act === 'activate') {
          const v = licVerify(b.code);
          if (!v.ok) return sendJSON(res, 400, { error: v.reason || '授权码无效' });
          config.license = config.license || {};
          config.license.code = String(b.code || '').trim().replace(/\s+/g, '');
          config.license.at = Date.now();
          saveConfig(); _licMemo = { t: 0, ok: null };
          log('info', 'license', '后台激活成功 exp=' + (v.exp || '永久'));
          return sendJSON(res, 200, { ok: true, info: licInfo() });
        }
        if (act === 'clear') {   /* 解除激活（换机器/重装时用） */
          if (config.license) { delete config.license.code; config.license.at = 0; saveConfig(); _licMemo = { t: 0, ok: null }; }
          return sendJSON(res, 200, { ok: true, info: licInfo() });
        }
        /* ---------- v63d：台账管理 ---------- */
        if (act === 'lock') {    /* 停用 / 恢复：停用后对方再激活会被拒（已激活的实例无法远程关停，属预期） */
          const rec = licLedger().find(x => x && x.id === b.id);
          if (!rec) return sendJSON(res, 400, { error: '找不到该授权码' });
          if (String(config.license.code || '') === rec.code && b.on) return sendJSON(res, 400, { error: '这是本站当前正在用的授权码，停用会把本站锁死，已拒绝' });
          rec.locked = !!b.on;
          saveConfig(); _licMemo = { t: 0, ok: null };
          log('info', 'license', (b.on ? '停用' : '恢复') + '授权码 id=' + rec.id + ' mid=' + rec.mid);
          return sendJSON(res, 200, { ok: true });
        }
        if (act === 'del') {     /* 从台账删除（只删记录，不影响对方已激活的实例） */
          const arr = licLedger();
          const i = arr.findIndex(x => x && x.id === b.id);
          if (i < 0) return sendJSON(res, 400, { error: '找不到该授权码' });
          if (String(config.license.code || '') === arr[i].code) return sendJSON(res, 400, { error: '这是本站当前正在用的授权码，不能删除' });
          arr.splice(i, 1);
          (config.license).issued = arr;
          saveConfig();
          return sendJSON(res, 200, { ok: true });
        }
        /* 改时长：签名里写死了到期时间，改不了旧码 —— 只能给同一台机器重签一个新码，旧码标记「已换发」 */
        if (act === 'regen') {
          const pk = (config.license || {}).privateKey;
          if (!pk) return sendJSON(res, 400, { error: '本实例没有签发私钥，无法重新签发' });
          const arr = licLedger();
          const old = arr.find(x => x && x.id === b.id);
          if (!old) return sendJSON(res, 400, { error: '找不到该授权码' });
          let out;
          /* v73d：换发一律永久（旧码若带期限也一并升级成永久） */
          try { out = licSign(old.mid, 0, pk, { c: (config.license || {}).contact || LIC_CONTACT, u: (config.license || {}).siteUrl || '' }); }
          catch (e) { return sendJSON(res, 400, { error: '重签失败：' + (e.message || e) }); }
          const nid = (crypto.randomUUID() || '').slice(0, 8) || Date.now().toString(36);
          const rec = { id: nid, mid: old.mid, code: out.code, exp: out.exp, createdAt: Date.now(), note: (old.note || '') + '（换发·永久）', locked: false, activatedAt: 0, replacedBy: '' };
          old.locked = false; old.replacedBy = nid;
          /* 对方用的就是旧码时，本站也不能把它继续当有效码 */
          if (String(config.license.code || '') === old.code) { config.license.code = out.code; config.license.at = Date.now(); _licMemo = { t: 0, ok: null }; }
          arr.unshift(rec);
          (config.license).issued = arr.slice(0, 500);
          saveConfig();
          log('info', 'license', '换发永久码 id=' + old.id + ' → ' + nid + ' mid=' + old.mid);
          /* v73d：带上 exp，前端/脚本能直接确认换发出来的是永久码（exp=0） */
          return sendJSON(res, 200, { ok: true, code: out.code, id: nid, midFmt: fmtMid(old.mid), exp: out.exp, expText: !out.exp ? '永久' : licStamp(out.exp).slice(0, 10) });
        }
        if (act === 'note') {
          const rec = licLedger().find(x => x && x.id === b.id);
          if (!rec) return sendJSON(res, 400, { error: '找不到该授权码' });
          rec.note = String(b.note || '').slice(0, 40);
          saveConfig();
          return sendJSON(res, 200, { ok: true });
        }
        if (act === 'contact') {  /* 前台激活页展示的「怎么拿到授权码」 */
          config.license = config.license || {};
          config.license.contact = String(b.contact || '').slice(0, 300);
          saveConfig();
          return sendJSON(res, 200, { ok: true, info: licInfo() });
        }
        if (act === 'siteurl') {  /* v73f：签发方站点地址（嵌进码里，对方激活后向这里回执） */
          let su = String(b.siteUrl || '').trim();
          if (su && !/^https?:\/\//i.test(su)) su = 'http://' + su;
          if (su) su = su.replace(/\/+$/, '');
          if (su && !/^https?:\/\/[A-Za-z0-9._:-]+/.test(su)) return sendJSON(res, 400, { error: '站点地址格式不对（示例 http://your-domain.com:8890）' });
          config.license = config.license || {};
          config.license.siteUrl = su;
          saveConfig();
          return sendJSON(res, 200, { ok: true, info: licInfo() });
        }
        if (act === 'setkey') {  /* 导入/更换签发私钥（GitHub 空壳没有私钥，站长自己这份才有） */
          const pk = String(b.privateKey || '').trim();
          if (!pk) return sendJSON(res, 400, { error: '私钥不能为空' });
          let okKey = false;
          try {
            const t = b64u(Buffer.from('{"v":1,"m":"TEST"}', 'utf8'));
            const s = crypto.createSign('RSA-SHA256'); s.update(t); s.end();
            const vv = crypto.createVerify('RSA-SHA256'); vv.update(t); vv.end();
            okKey = vv.verify(((config.license || {}).publicKey) || LIC_PUB, s.sign(pk));
          } catch (e) { okKey = false; }
          if (!okKey) return sendJSON(res, 400, { error: '私钥无效或与当前公钥不匹配' });
          config.license = config.license || {};
          config.license.privateKey = pk;
          saveConfig();
          return sendJSON(res, 200, { ok: true, info: licInfo() });
        }
        return sendJSON(res, 400, { error: '未知操作' });
      }
      /* 签发授权码：给别人的机器码签一个。
         v73d：授权一律永久 —— 即使请求里带了 days 也强制按 0（永久）签，不再有期限档位 */
      if (p === '/api/admin/license/gen' && method === 'POST') {
        const b = await readBody(req).catch(() => ({}));
        const pk = (config.license || {}).privateKey;
        if (!pk) return sendJSON(res, 400, { error: '本实例没有签发私钥，无法生成授权码（私钥只保存在站长自己的站点配置里）' });
        const mid = String(b.machineId || '').toUpperCase().replace(/[^0-9A-F]/g, '');
        if (mid.length !== 16) return sendJSON(res, 400, { error: '机器码必须是 16 位（可在对方后台「授权管理」里复制）' });
        let out;
        try { out = licSign(mid, 0, pk, { c: (config.license || {}).contact || LIC_CONTACT, u: (config.license || {}).siteUrl || '' }); }
        catch (e) { return sendJSON(res, 400, { error: '签发失败：' + (e.message || e) }); }
        /* v63d：记进台账，之后才能停用 / 改时长 / 查状态 */
        const rec = { id: (crypto.randomUUID() || '').slice(0, 8) || Date.now().toString(36), mid, code: out.code, exp: out.exp, createdAt: Date.now(), note: String(b.note || '').slice(0, 40), locked: false, activatedAt: 0, replacedBy: '' };
        licRecord(rec);
        log('info', 'license', '签发授权码 id=' + rec.id + ' mid=' + mid + ' days=' + (Number(b.days) || 0));
        return sendJSON(res, 200, { ok: true, code: out.code, id: rec.id, machineIdFmt: fmtMid(mid), exp: out.exp, expText: !out.exp ? '永久' : licStamp(out.exp).slice(0, 10) });
      }
      if (p === '/api/admin/config' && method === 'POST') {
        const b = await readBody(req);
        if (b.siteName !== undefined) config.siteName = String(b.siteName).slice(0, 40);
        if (b.home) config.home = Object.assign(config.home, b.home);
        if (b.toggles) config.toggles = Object.assign(config.toggles, b.toggles);
        if (b.hero) config.hero = Object.assign(config.hero || {}, b.hero);
        if (b.announcement) config.announcement = Object.assign(config.announcement, b.announcement);
        if (b.adFilter) config.adFilter = Object.assign(config.adFilter || {}, {
          enabled: b.adFilter.enabled !== false,
          tsProxy: !!b.adFilter.tsProxy,
          blacklist: Array.isArray(b.adFilter.blacklist) ? b.adFilter.blacklist.map(x => String(x).trim()).filter(Boolean) : (config.adFilter.blacklist || [])
        });
        /* v63 其他设置：轮播间隔（秒，3~120）+ 加载卡文案（白名单键，空值=回落默认） */
        if (b.misc && typeof b.misc === 'object' && !Array.isArray(b.misc)) {
          const m = (config.misc = config.misc || {});
          if (b.misc.rotMs !== undefined) m.rotMs = Math.min(120, Math.max(3, parseInt(b.misc.rotMs, 10) || 10));
          if (b.misc.text && typeof b.misc.text === 'object' && !Array.isArray(b.misc.text)) {
            const t = (m.text = m.text || {});
            const KEYS = ['slHead', 'slBig', 'slLine', 'slFeats', 'slSwitch', 'slTickSoon', 'slTickWait',
              'stTitle', 'stSub', 'stLineOne', 'stLineN', 'infoTitle', 'infoSub', 'matchTitle', 'matchSub',
              'badgeInit', 'badgeOfficial', 'badgeCollect'];
            for (const k of KEYS) {
              if (!(k in b.misc.text)) continue;
              const v = String(b.misc.text[k] == null ? '' : b.misc.text[k]).slice(0, 120);
              if (!v.trim()) delete t[k]; else t[k] = v;
            }
          }
        }
        if (b.outProxy !== undefined) config.outProxy = String(b.outProxy).trim();
        if (b.tmdbRegion !== undefined) config.tmdbRegion = String(b.tmdbRegion).trim().toUpperCase().slice(0, 8) || 'CN';
        if (b.reg) {
          /* 关键：没传 defaultPerm 时必须保留原值，绝不能重置成「全 true」（否则旧页面/部分提交会把已取消的勾选冲掉） */
          const dp = (b.reg.defaultPerm && typeof b.reg.defaultPerm === 'object' && !Array.isArray(b.reg.defaultPerm)) ? b.reg.defaultPerm : (((config.reg || {}).defaultPerm) || REG_DEF_PERM);
          const row = {};
          /* 「跳过片头/片尾」是会员特权：旧页面提交里没这两个键时必须按「关」处理，绝不能因为缺失就放开 */
          VIEW_KEYS.forEach(k => { row[k] = (k === 'skipIntro' || k === 'skipOutro') ? (dp[k] === true) : (dp[k] !== false); });
          /* v46c 审计：reg 被谁改的必须留痕（来源 IP + 传入内容 + 落库结果），排查「取消勾选又复原」 */
          log('info', 'admin', '注册权限保存 audit: ip=' + ((req.socket && req.socket.remoteAddress) || '?')
            + ' 传入=' + (b.reg.defaultPerm && typeof b.reg.defaultPerm === 'object' ? JSON.stringify(b.reg.defaultPerm) : '(未传，保留原值)')
            + ' 落库=' + JSON.stringify(row));
          config.reg = { enabled: !!b.reg.enabled, defaultPerm: row };
        }
        if (b.viewPerm && b.viewPerm.users && typeof b.viewPerm.users === 'object' && !Array.isArray(b.viewPerm.users)) {
          const m = {};
          for (const k in b.viewPerm.users) {
            const src = b.viewPerm.users[k];
            if (!src || typeof src !== 'object' || Array.isArray(src)) continue;
            const mm = {};
            for (const vk of VIEW_KEYS) if (src[vk] !== undefined) mm[vk] = !!src[vk];
            m[String(k).slice(0, 40)] = mm;
          }
          config.viewPerm = { users: m };
        }
        if (b.iptv) {
          const iv = config.iptv = config.iptv || {};
          if (b.iptv.enabled !== undefined) iv.enabled = !!b.iptv.enabled;
          if (b.iptv.m3uUrl !== undefined) iv.m3uUrl = String(b.iptv.m3uUrl).trim();
          if (b.iptv.epgUrl !== undefined) iv.epgUrl = String(b.iptv.epgUrl).trim();
          if (b.iptv.epgEnabled !== undefined) iv.epgEnabled = !!b.iptv.epgEnabled;
          /* v44 多直播源：sources=[{id,name,url,enabled}]；m3uUrl 同步为第一个启用的源（兼容旧逻辑） */
          if (Array.isArray(b.iptv.sources)) {
            iv.sources = b.iptv.sources.slice(0, 20).map((s, i) => ({
              id: String((s && s.id) || ('s' + (i + 1))).slice(0, 12),
              name: String((s && s.name) || '').slice(0, 30) || ('源' + (i + 1)),
              url: String((s && s.url) || '').trim().slice(0, 500),
              enabled: !s || s.enabled !== false,
              /* v57：手动分组——留空则用清单自带的 group-title；填了就把该源全部频道归入这个分组 */
              group: String((s && s.group) || '').trim().slice(0, 30)
            })).filter(s => s.url);
            const firstOn = iv.sources.find(s => s.enabled) || iv.sources[0];
            if (firstOn) iv.m3uUrl = firstOn.url;
          }
          /* 分组权限（v45b/v46）：{users:{对象:{分组:bool}},levels:{...}}，显式 true/false；
             等级未设置=默认允许，用户未设置=继承所属等级，以后新增的分组默认可看 */
          const normPermRow = row => {
            const mm = {};
            if (!row || typeof row !== 'object' || Array.isArray(row)) return mm;
            for (const sk in row) { const v = row[sk]; if (v === true || v === false) mm[String(sk).slice(0, 30)] = !!v; }
            return mm;
          };
          if (b.iptv.groupPerm && typeof b.iptv.groupPerm === 'object' && !Array.isArray(b.iptv.groupPerm)) {
            const users = {};
            if (b.iptv.groupPerm.users && typeof b.iptv.groupPerm.users === 'object' && !Array.isArray(b.iptv.groupPerm.users)) {
              for (const k in b.iptv.groupPerm.users) users[String(k).slice(0, 40)] = normPermRow(b.iptv.groupPerm.users[k]);
            }
            const levels = {};
            if (b.iptv.groupPerm.levels && typeof b.iptv.groupPerm.levels === 'object' && !Array.isArray(b.iptv.groupPerm.levels)) {
              for (const k in b.iptv.groupPerm.levels) levels[String(k).slice(0, 4)] = normPermRow(b.iptv.groupPerm.levels[k]);
            }
            iv.groupPerm = { users, levels };
          }
          /* 分组快照：后台「获取/刷新分组」的结果持久化，进后台就能直接看到列表 */
          if (Array.isArray(b.iptv.groupStats)) {
            iv.groupStats = b.iptv.groupStats.slice(0, 100).map(g => ({ name: String((g && g.name) || '').slice(0, 40), count: Math.max(0, Number((g && g.count) || 0)) })).filter(g => g.name);
          }
          /* v64：分组排序 —— 后台拖上下序，前台分组页签按此顺序显示；不在名单里的分组排后面（按字典序） */
          if (Array.isArray(b.iptv.groupOrder)) {
            iv.groupOrder = b.iptv.groupOrder.slice(0, 100).map(n => String(n == null ? '' : n).trim().slice(0, 40)).filter(Boolean);
            if (!iv.groupOrder.length) delete iv.groupOrder;   // 清空 = 恢复默认字典序
          }
          if (b.iptv.users && typeof b.iptv.users === 'object' && !Array.isArray(b.iptv.users)) {
            const m = {};
            for (const k in b.iptv.users) m[String(k).slice(0, 40)] = !!b.iptv.users[k];
            iv.users = m;
          }
        }
        saveConfig();
        return sendJSON(res, 200, { ok: true, config });
      }
      /* IPTV 清单连通测试 */
      /* IPTV 清单测试：v44 起逐个测试全部（或草稿）直播源，并汇总自动获取的分组 */
      if (p === '/api/admin/iptv-test' && method === 'POST') {
        const conf = config.iptv || {};
        const b = await readBody(req).catch(() => ({}));
        let srcs = (Array.isArray(b.sources) && b.sources.length ? b.sources : (conf.sources || []).filter(s => s.enabled !== false))
          .map((s, i) => ({ id: (s && s.id) || ('s' + (i + 1)), name: (s && s.name) || ('源' + (i + 1)), url: String((s && s.url) || '').trim(), group: String((s && s.group) || '').trim() }))
          .filter(s => s.url);
        if (!srcs.length && conf.m3uUrl) srcs = [{ id: 's1', name: '默认源', url: conf.m3uUrl }];
        if (!srcs.length) return sendJSON(res, 200, { ok: false, error: '请先添加直播源' });
        const results = [];
        const groups = new Map();
        let total = 0;
        for (const s of srcs) {
          try {
            const ch = await iptvChannels(s.url);
            results.push({ id: s.id, name: s.name, ok: true, count: ch.length, group: s.group || '' });
            total += ch.length;
            /* v57：手动分组优先 —— 该源频道全部计入手动分组，不再按清单自带分组拆开统计 */
            if (s.group) groups.set(s.group, (groups.get(s.group) || 0) + ch.length);
            else for (const c of ch) groups.set(c.group, (groups.get(c.group) || 0) + 1);
          } catch (e) { results.push({ id: s.id, name: s.name, ok: false, error: (e.message || '拉取失败') }); }
        }
        const okAny = results.some(r => r.ok);
        return sendJSON(res, 200, {
          ok: okAny,
          results,
          total,
          groups: Array.from(groups.entries()).map(([name, count]) => ({ name, count })).sort((a, b) => b.count - a.count)
        });
      }
      /* 节目单（EPG）连通测试：识别 xmltv / M3U 冒充 / 无效内容 */
      if (p === '/api/admin/epg-test' && method === 'POST') {
        const conf = config.iptv || {};
        const b0 = await readBody(req).catch(() => ({}));
        const eurl = String(b0.url || conf.epgUrl || '').trim();
        if (!eurl) return sendJSON(res, 200, { ok: false, error: '请先填写节目单（EPG）地址' });
        try {
          const r = await fetchIptv(eurl, 25000);
          const text = await r.text();
          if (/^\s*#EXTM3U/.test(text)) return sendJSON(res, 200, { ok: false, kind: 'm3u', error: '该地址返回的是 M3U 频道清单、不是 xmltv 节目单（频道可正常播放，但匹配不到节目信息）。请换真正的 xmltv 地址' });
          const chN = (text.match(/<channel[\s>]/g) || []).length;
          const pgN = (text.match(/<programme[\s>]/g) || []).length;
          if (!chN && !pgN) return sendJSON(res, 200, { ok: false, error: '内容不是有效的 xmltv 节目单（' + Math.round(text.length / 1024) + 'KB）' });
          return sendJSON(res, 200, { ok: true, kind: 'xmltv', channels: chN, programmes: pgN, kb: Math.round(text.length / 1024) });
        } catch (e) { return sendJSON(res, 200, { ok: false, error: e.message || '拉取失败' }); }
      }

      /* 广播推送配置（v41.2）：独立开关 + 连续推送次数 + 间隔(秒/分/时)；保存后按配置启动/停止定时器 */
      if (p === '/api/admin/broadcast' && method === 'POST') {
        const b = await readBody(req);
        config.broadcast = Object.assign(config.broadcast || {}, {
          enabled: !!b.enabled,
          title: (b.title || '').slice(0, 80),
          content: (b.content || '').slice(0, 2000),
          count: Math.max(1, Math.min(50, parseInt(b.count, 10) || 1)),
          intervalUnit: ['s', 'm', 'h'].includes(b.intervalUnit) ? b.intervalUnit : 'h',
          interval: Math.max(1, Math.min(1440, parseInt(b.interval, 10) || 1))
        });
        saveConfig();
        if (config.broadcast.enabled) startBcTimer();
        else { stopBcTimer(); config.lastBroadcast = null; saveConfig(); }   /* 关推送即清除末条，避免新用户首次进页面还看到一次已删除的推送 */
        return sendJSON(res, 200, { ok: true, broadcast: config.broadcast, clients: sseClients.size });
      }
      /* 公告弹窗（v41.2）：mode=maintenance 为强制维护公告（前台无法关闭、刷新也弹）；「当天不再弹」由前台 localStorage 控制，后台不接收 */
      if (p === '/api/admin/announcement' && method === 'POST') {
        const b = await readBody(req);
        config.announcement = Object.assign(config.announcement || {}, {
          enabled: !!b.enabled,
          title: (b.title || '').slice(0, 80),
          content: (b.content || '').slice(0, 2000),
          mode: b.mode === 'maintenance' ? 'maintenance' : 'normal'
        });
        saveConfig();
        if (b.push && config.announcement.enabled) {
          broadcast({ type: 'announcement', data: config.announcement });
        }
        return sendJSON(res, 200, { ok: true, announcement: config.announcement });
      }
      /* 用户管理 */
      if (p === '/api/admin/users' && method === 'GET') {
        return sendJSON(res, 200, { users: users.map(x => ({ id: x.id, username: x.username, role: x.role, createdAt: x.createdAt, points: x.points || 0, invited: x.invited || 0, inviteCode: x.inviteCode || '', vip: vipInfo(x), checkin: { last: (x.checkin && x.checkin.last) || '', streak: (x.checkin && x.checkin.streak) || 0 } })) });
      }
      if (p === '/api/admin/users' && method === 'POST') {
        const b = await readBody(req);
        if (!b.username || !b.password) return sendJSON(res, 400, { error: '用户名和密码必填' });
        if (!/^[a-zA-Z0-9_\u4e00-\u9fa5]{2,20}$/.test(String(b.username).trim())) return sendJSON(res, 400, { error: '用户名需 2-20 位（中文/字母/数字/下划线）' });
        if (String(b.password).length < 6) return sendJSON(res, 400, { error: '密码至少 6 位' });
        if (users.find(x => x.username === b.username)) return sendJSON(res, 400, { error: '用户名已存在' });
        const role = b.role === 'admin' ? 'admin' : 'user';
        users.push({ id: uid(), username: b.username, passwordHash: sha(b.password), role, createdAt: Date.now() });
        saveUsers();
        /* v46：后台添加的普通用户同样套用「新用户默认访问权限」模板（之前不走模板 → 缺省全允许，权限过高） */
        let applied = false;
        if (role === 'user' && VIEW_KEYS.some(k => ((config.reg || {}).defaultPerm || {})[k] !== undefined)) {
          (config.viewPerm.users || (config.viewPerm.users = {}))[b.username] = regPermRow();
          saveConfig();
          applied = true;
          log('info', 'admin', '后台添加用户 ' + b.username + ' 按注册模板授权，IPTV=' + config.viewPerm.users[b.username].iptv);
        }
        return sendJSON(res, 200, { ok: true, permApplied: applied });
      }
      /* v46：把当前「新用户默认访问权限」模板一键应用到全部现有普通用户（管理员不动） */
      if (p === '/api/admin/reg-apply' && method === 'POST') {
        const row = regPermRow();
        const m = (config.viewPerm.users || (config.viewPerm.users = {}));
        let n = 0;
        users.forEach(u => {
          if (u.role !== 'admin') { m[u.username] = Object.assign({}, row); n++; }
        });
        saveConfig();
        log('info', 'admin', '注册模板已应用到 ' + n + ' 个普通用户');
        return sendJSON(res, 200, { ok: true, applied: n, perm: row });
      }
      if (p === '/api/admin/users/role' && method === 'POST') {
        const b = await readBody(req);
        const t = getUser(b.id);
        if (!t) return sendJSON(res, 404, { error: '用户不存在' });
        if (t.username === 'admin') return sendJSON(res, 400, { error: '内置管理员不可修改' });
        t.role = b.role === 'admin' ? 'admin' : 'user';
        saveUsers();
        return sendJSON(res, 200, { ok: true });
      }
      if (p === '/api/admin/users/password' && method === 'POST') {
        const b = await readBody(req);
        if (!b.id || !b.newPassword || String(b.newPassword).length < 6) return sendJSON(res, 400, { error: '新密码至少 6 位' });
        const t = getUser(b.id);
        if (!t) return sendJSON(res, 404, { error: '用户不存在' });
        t.passwordHash = sha(b.newPassword);
        saveUsers();
        return sendJSON(res, 200, { ok: true });
      }
      /* 会员：设置等级与时长（level=0 取消会员；days>0 在现有到期时间上叠加，days=0 表示永久） */
      if (p === '/api/admin/users/vip' && method === 'POST') {
        const b = await readBody(req);
        const t = getUser(b.id);
        if (!t) return sendJSON(res, 404, { error: '用户不存在' });
        const levels = (config.vip || {}).levels || [];
        const lv = Number(b.level) || 0;
        if (!levels.some(x => Number(x.level) === lv)) return sendJSON(res, 400, { error: '会员等级不存在' });
        const days = Number(b.days) || 0;
        if (lv === 0) t.vip = { level: 0, expire: 0 };
        else {
          const base = Math.max(Date.now(), (t.vip && Number(t.vip.expire)) || 0);
          t.vip = { level: lv, expire: days > 0 ? base + days * 86400000 : 0 };
        }
        saveUsers();
        log('info', 'admin', '设置会员: ' + t.username + ' -> Lv' + lv + (days > 0 ? ' +' + days + '天' : (lv ? ' 永久' : '')));
        return sendJSON(res, 200, { ok: true, vip: vipInfo(t) });
      }
      /* 积分：后台手动调整（delta 正加负减） */
      if (p === '/api/admin/users/points' && method === 'POST') {
        const b = await readBody(req);
        const t = getUser(b.id);
        if (!t) return sendJSON(res, 404, { error: '用户不存在' });
        const delta = Number(b.delta) || 0;
        t.points = Math.max(0, (t.points || 0) + delta);
        saveUsers();
        log('info', 'admin', '调整积分: ' + t.username + ' ' + (delta >= 0 ? '+' : '') + delta + ' -> ' + t.points);
        return sendJSON(res, 200, { ok: true, points: t.points });
      }
      /* ---------- 广告联盟配置 ---------- */
      if (p === '/api/admin/ads' && method === 'GET') return sendJSON(res, 200, { ads: config.ads || {} });
      if (p === '/api/admin/ads' && method === 'POST') {
        const b = await readBody(req);
        const a = b.ads || {};
        const items = (Array.isArray(a.items) ? a.items : []).map(x => ({
          id: String(x.id || uid()).slice(0, 40),
          title: String(x.title || '').slice(0, 60),
          img: String(x.img || '').slice(0, 500),
          link: String(x.link || '').slice(0, 500),
          slots: (Array.isArray(x.slots) ? x.slots : []).filter(s => s === 'sidebar' || s === 'pause'),
          weight: Math.max(1, Math.min(99, Number(x.weight) || 1)),
          enabled: x.enabled !== false
        })).filter(x => x.img && x.slots.length).slice(0, 60);
        config.ads = {
          enabled: !!a.enabled,
          network: a.network === 'code' ? 'code' : 'custom',
          items,
          code: { sidebar: String((a.code || {}).sidebar || '').slice(0, 20000), pause: String((a.code || {}).pause || '').slice(0, 20000) },
          pause: { enabled: !!(a.pause || {}).enabled, delay: Math.max(0, Math.min(10000, Number((a.pause || {}).delay) || 0)), closeable: (a.pause || {}).closeable !== false, autoClose: Math.max(0, Math.min(600, Number((a.pause || {}).autoClose) || 0)) },
          sidebar: { enabled: !!(a.sidebar || {}).enabled, position: ['belowDetail', 'belowPoster', 'aboveHistory', 'topOfSide'].indexOf((a.sidebar || {}).position) >= 0 ? (a.sidebar || {}).position : 'belowDetail', width: String((a.sidebar || {}).width || '100%').slice(0, 20), height: String((a.sidebar || {}).height || 'auto').slice(0, 20), max: Math.max(1, Math.min(6, Number((a.sidebar || {}).max) || 2)) }
        };
        saveConfig();
        return sendJSON(res, 200, { ok: true, ads: config.ads });
      }
      /* ---------- 积分配置 ---------- */
      if (p === '/api/admin/points' && method === 'GET') return sendJSON(res, 200, { points: config.points || {} });
      if (p === '/api/admin/points' && method === 'POST') {
        const b = await readBody(req);
        const q = b.points || {};
        const num = (v, d, lo, hi) => { const n = Number(v); return isNaN(n) ? d : Math.max(lo, Math.min(hi, n)); };
        const vm = {}; const vsrc = q.vipMul || {};
        for (const k in vsrc) vm[String(k).slice(0, 4)] = num(vsrc[k], 1, 0, 100);
        config.points = {
          enabled: q.enabled !== false,
          checkin: { base: num(q.checkin && q.checkin.base, 10, 0, 100000), streakBonus: num(q.checkin && q.checkin.streakBonus, 5, 0, 100000), streakMax: num(q.checkin && q.checkin.streakMax, 7, 0, 365) },
          invite: { perInvite: num(q.invite && q.invite.perInvite, 50, 0, 100000), dailyCap: num(q.invite && q.invite.dailyCap, 200, 0, 100000), requireRegister: !!(q.invite && q.invite.requireRegister) },
          watch: { pointsPerMin: num(q.watch && q.watch.pointsPerMin, 1, 0, 100000), dailyCapMin: num(q.watch && q.watch.dailyCapMin, 120, 0, 1440) },
          vipMul: vm
        };
        saveConfig();
        return sendJSON(res, 200, { ok: true, points: config.points });
      }
      /* ---------- 会员等级配置 ---------- */
      if (p === '/api/admin/vip' && method === 'GET') return sendJSON(res, 200, { vip: config.vip || {} });      if (p === '/api/admin/vip' && method === 'POST') {
        const b = await readBody(req);
        const v = b.vip || {};
        const levels = (Array.isArray(v.levels) ? v.levels : []).map(x => {
          const perm = {};
          const psrc = (x.perm && typeof x.perm === 'object' && !Array.isArray(x.perm)) ? x.perm : {};
          VIEW_KEYS.forEach(k => { if (psrc[k] === true) perm[k] = true; });   /* 只存勾选的键，未勾=按用户单独设置 */
          return {
            level: Math.max(0, Math.min(9, Number(x.level) || 0)),
            name: String(x.name || '').slice(0, 20) || ('Lv' + (Number(x.level) || 0)),
            noAds: !!x.noAds,
            pointMul: Math.max(0, Math.min(100, Number(x.pointMul) || 1)),
            iptv: !!x.iptv,
            points: Math.max(0, Math.min(99999999, Number(x.points) || 0)),
            perm
          };
        }).slice(0, 10);
        if (!levels.some(x => x.level === 0)) levels.unshift({ level: 0, name: '普通用户', noAds: false, pointMul: 1 });
        config.vip = { enabled: v.enabled !== false, levels };
        saveConfig();
        return sendJSON(res, 200, { ok: true, vip: config.vip });
      }
      /* ---------- 积分兑换项配置 ---------- */
      if (p === '/api/admin/redeem' && method === 'GET') return sendJSON(res, 200, { redeem: config.redeem || { enabled: true, items: [] } });
      if (p === '/api/admin/redeem' && method === 'POST') {
        const b = await readBody(req);
        const r = b.redeem || {};
        const items = (Array.isArray(r.items) ? r.items : []).map(x => ({
          id: String(x.id || uid()).slice(0, 40),
          title: String(x.title || '').slice(0, 40),
          desc: String(x.desc || '').slice(0, 120),
          kind: x.kind === 'perm' ? 'perm' : 'vip',
          level: Math.max(0, Math.min(9, Number(x.level) || 0)),
          permKey: String(x.permKey || '').slice(0, 20),
          days: Math.max(0, Math.min(3650, Number(x.days) || 0)),
          cost: Math.max(0, Math.min(9999999, Number(x.cost) || 0)),
          stock: x.stock === undefined ? -1 : Math.max(-1, Math.min(999999, Number(x.stock) || 0)),
          enabled: x.enabled !== false
        })).filter(x => x.title && (x.kind === 'vip' || VIEW_KEYS.indexOf(x.permKey) >= 0)).slice(0, 60);
        config.redeem = { enabled: r.enabled !== false, items };
        saveConfig();
        return sendJSON(res, 200, { ok: true, redeem: config.redeem });
      }
      if (p.startsWith('/api/admin/users/') && method === 'DELETE') {
        const id = p.split('/').pop();
        const t = getUser(id);
        if (!t) return sendJSON(res, 404, { error: '用户不存在' });
        if (t.role === 'admin') return sendJSON(res, 400, { error: '管理员账号不可删除' });
        const admins = users.filter(x => x.role === 'admin');
        if (admins.length <= 1 && t.role !== 'admin') { /* 删除普通用户不影响 */ }
        users = users.filter(x => x.id !== id);
        saveUsers();
        /* v46：同步清理该用户的权限残留（栏目权限/分组权限），不再越积越多 */
        let touched = false;
        if (config.viewPerm && config.viewPerm.users && config.viewPerm.users[t.username]) { delete config.viewPerm.users[t.username]; touched = true; }
        const gp = (config.iptv || {}).groupPerm;
        if (gp && gp.users && gp.users[t.username]) { delete gp.users[t.username]; touched = true; }
        if (touched) saveConfig();
        return sendJSON(res, 200, { ok: true });
      }
      /* 解析地址 (官方解析) */
      if (p === '/api/admin/parse' && method === 'GET') {
        return sendJSON(res, 200, { list: config.parseList || [] });
      }
      if (p === '/api/admin/parse' && method === 'POST') {
        const b = await readBody(req);
        if (!b.name || !b.url) return sendJSON(res, 400, { error: '名称和地址必填' });
        config.parseList = config.parseList || [];
        config.parseList.push({ id: uid(), name: b.name, url: b.url });
        saveConfig();
        return sendJSON(res, 200, { ok: true, list: config.parseList });
      }
      if (p.startsWith('/api/admin/parse/') && method === 'DELETE') {
        const id = p.split('/').pop();
        config.parseList = (config.parseList || []).filter(x => x.id !== id);
        saveConfig();
        return sendJSON(res, 200, { ok: true });
      }
      /* 系统日志 */
      if (p === '/api/admin/logs' && method === 'GET') {
        const level = u.searchParams.get('level') || '';
        const q = (u.searchParams.get('q') || '').toLowerCase();
        const limit = parseInt(u.searchParams.get('limit') || '400', 10) || 400;
        let list = LOGS.slice().reverse();
        if (level && level !== 'all') list = list.filter(e => e.l === level);
        if (q) list = list.filter(e => ((e.m || '') + ' ' + (e.g || '') + ' ' + (e.x || '')).toLowerCase().includes(q));
        return sendJSON(res, 200, { list: list.slice(0, limit), total: LOGS.length });
      }
      if (p === '/api/admin/logs' && method === 'DELETE') {
        LOGS = [];
        try { fs.writeFileSync(path.join(DATA_DIR, 'logs.json'), '[]'); } catch (e) {}
        log('info', 'sys', '日志已清空');
        return sendJSON(res, 200, { ok: true });
      }
      /* 播放速度巡查：实测「上游清单/直链出网耗时 / 我方过滤处理耗时 / 切片直连耗时」，对比我方链路与上游直连差异 */
      if (p === '/api/admin/speedtest' && method === 'GET') {
        const url = u.searchParams.get('url') || '';
        const token = u.searchParams.get('token') || '';
        if (!url) return sendJSON(res, 400, { error: 'missing url' });
        const isM3u8 = /\.m3u8(\?|$)/i.test(url) || url.indexOf('/hls') >= 0;
        try {
          if (!isM3u8) {
            const t0h = Date.now();
            const upHeadMs = await (async () => {
              const ac = new AbortController(); const tt = setTimeout(() => { try { ac.abort(); } catch (e) {} }, 12000);
              try { const r = await fetch(url, { method: 'GET', signal: ac.signal, headers: { 'Range': 'bytes=0-1023', 'User-Agent': 'Mozilla/5.0' } }); await r.arrayBuffer(); return Date.now() - t0h; }
              finally { clearTimeout(tt); }
            })();
            return sendJSON(res, 200, { isM3u8: false, upHeadMs, filterMs: 0, blocked: 0, segMs: upHeadMs, note: '直链视频(mp4等)：我方与上游路径完全一致，均直连源站，无清单过滤' });
          }
          const t0 = Date.now();
          const raw = await fetchText(url, 15000);
          const upMasterMs = Date.now() - t0;
          const isMaster = /#EXT-X-STREAM-INF/i.test(raw);
          let variantMs = 0, variantUrl = '';
          if (isMaster) {
            const lines = raw.split('\n').map(l => l.replace(/\r$/, ''));
            for (let i = 0; i < lines.length; i++) {
              if (lines[i].trim().startsWith('#EXT-X-STREAM-INF')) {
                let u2 = ''; for (let j = i + 1; j < lines.length; j++) { if (!lines[j].trim().startsWith('#')) { u2 = lines[j].trim(); break; } }
                if (u2) { variantUrl = absUrl(u2, url); break; }
              }
            }
            if (variantUrl) { const tv = Date.now(); const vraw = await fetchText(variantUrl, 15000); variantMs = Date.now() - tv; }
          }
          const src = variantUrl ? await fetchText(variantUrl, 15000) : raw;
          const segs = parseSegs(src.split('\n').map(l => l.replace(/\r$/, '')), variantUrl || url).slice(0, 3);
          let segMs = 0, sampleSeg = '';
          if (segs[0]) {
            const t0s = Date.now();
            try { const ac = new AbortController(); const tt = setTimeout(() => { try { ac.abort(); } catch (e) {} }, 12000); const r = await fetch(segs[0].url, { signal: ac.signal, headers: { 'Range': 'bytes=0-1023', 'User-Agent': 'Mozilla/5.0' } }); await r.arrayBuffer(); clearTimeout(tt); segMs = Date.now() - t0s; sampleSeg = segs[0].url.slice(0, 70); }
            catch (e) { segMs = -1; }
          }
          const tf = Date.now();
          const filtered = config.adFilter.enabled ? await filterPlaylist(raw, url, config.adFilter, token) : { blocked: 0 };
          const filterMs = Date.now() - tf;
          return sendJSON(res, 200, {
            isM3u8: true, upMasterMs, isMaster, variantMs, segMs, filterMs,
            blocked: filtered.blocked, sampleSeg,
            note: '切片由浏览器直连上游（两路径一致）；我方仅在服务端过滤清单一次并缓存30s，去广告可避免解码器重置造成的卡顿/无声'
          });
        } catch (e) { return sendJSON(res, 200, { error: String(e.message || e) }); }
      }
      /* ---------- v60：上游接入（API 地址 / 密钥 / Cookie / 镜像） ---------- */
      if (p === '/api/admin/upstream' && method === 'GET') {
        const c = upCfg();
        return sendJSON(res, 200, {
          base: c.base || '', key: c.key || '', cookie: c.cookie || '',
          mirrors: Array.isArray(c.mirrors) ? c.mirrors : []
        });
      }
      if (p === '/api/admin/upstream' && method === 'POST') {
        const b = await readBody(req);
        const cur = upCfg();
        const nb = String((b && b.base != null) ? b.base : (cur.base || '')).trim().replace(/\/+$/, '');
        if (!nb) return sendJSON(res, 400, { error: '上游 API 地址不能为空' });
        if (!/^https?:\/\//i.test(nb)) return sendJSON(res, 400, { error: '上游 API 地址需以 http:// 或 https:// 开头' });
        const mirrors = ((b && Array.isArray(b.mirrors)) ? b.mirrors : (cur.mirrors || []))
          .map(x => String(x || '').trim().replace(/\/+$/, '')).filter(x => /^https?:\/\//i.test(x)).slice(0, 10);
        config.upstream = Object.assign({}, config.upstream || {}, {
          base: nb,
          key: String((b && b.key != null) ? b.key : (cur.key || '')).trim(),
          cookie: String((b && b.cookie != null) ? b.cookie : (cur.cookie || '')).trim(),
          mirrors
        });
        /* 换地址/密钥后必须清缓存，否则新上游还在吃旧上游的缓存数据（表现为"改了没反应"） */
        upCache.clear();
        UP_FAILS.clear();
        saveConfig();
        log('warn', 'sys', '上游接入已更新: ' + nb + (mirrors.length ? ('（镜像 ' + mirrors.length + ' 个）') : '') + '，缓存已清空');
        return sendJSON(res, 200, { ok: true, base: nb, mirrors });
      }
      /* 连通自检：支持传入待验证的地址/密钥先测后存 */
      if (p === '/api/admin/upstream/test' && method === 'POST') {
        const b = await readBody(req) || {};
        const cur = upCfg();
        const cfg = {
          base: String((b && b.base != null) ? b.base : (cur.base || '')).trim().replace(/\/+$/, ''),
          key: String((b && b.key != null) ? b.key : (cur.key || '')).trim(),
          cookie: String((b && b.cookie != null) ? b.cookie : (cur.cookie || '')).trim(),
          mirrors: (b && Array.isArray(b.mirrors)) ? b.mirrors : (cur.mirrors || [])
        };
        if (!cfg.base) return sendJSON(res, 400, { error: '请先填写上游 API 地址' });
        if (!/^https?:\/\//i.test(cfg.base)) return sendJSON(res, 400, { error: '上游 API 地址需以 http:// 或 https:// 开头' });
        const rs = await probeUpstream(cfg);
        const good = rs.find(x => x.ok);
        log(good ? 'info' : 'warn', 'sys', '上游连通自检：' + cfg.base + ' → ' + (good ? ('连通 ' + good.ms + 'ms') : ((rs[0] && rs[0].msg) || '不可达')));
        return sendJSON(res, 200, {
          ok: !!good, results: rs,
          base: good ? good.base : '', ms: good ? good.ms : 0,
          secs: good ? good.secs : 0, cards: good ? good.cards : 0,
          error: good ? '' : ((rs[0] && rs[0].msg) || '全部候选不可达')
        });
      }
      /* 上游官方线路（解析地址）：查看 + 从上游同步 */
      if (p === '/api/admin/up-lines' && method === 'GET') {
        return sendJSON(res, 200, {
          list: config.upstreamLines || [],
          blocked: config.blockedLines || [],
          collect: config.upstreamCollectLines || [],
          colBlocked: config.colBlockedLines || []
        });
      }
      /* v60：删除上游采集档线路（同时记进 colBlockedLines，同步上游时不再拉回来） */
      if (p === '/api/admin/up-lines/collect/delete' && method === 'POST') {
        const b = await readBody(req);
        const lb = String((b && b.label) || '').trim();
        if (!lb) return sendJSON(res, 400, { error: '缺少线路名' });
        const before = (config.upstreamCollectLines || []).length;
        config.upstreamCollectLines = (config.upstreamCollectLines || []).filter(x => String(x.label || '') !== lb);
        setColBlocked(lb, true);
        saveConfig();
        log('info', 'sys', '已删除上游采集线路: ' + lb + '（' + before + ' → ' + config.upstreamCollectLines.length + '）');
        return sendJSON(res, 200, { ok: true, deleted: lb, left: config.upstreamCollectLines.length, colBlocked: config.colBlockedLines });
      }
      /* v60：恢复已删除的上游采集档线路（让它下次同步时能再回来） */
      if (p === '/api/admin/up-lines/collect/restore' && method === 'POST') {
        const b = await readBody(req);
        const lb = String((b && b.label) || '').trim();
        if (lb === '__all__') {
          const n = (config.colBlockedLines || []).length;
          config.colBlockedLines = []; saveConfig();
          log('info', 'sys', '已恢复全部被删除的上游采集线路（' + n + ' 条，下次同步后重新出现）');
          return sendJSON(res, 200, { ok: true, colBlocked: [] });
        }
        if (!lb) return sendJSON(res, 400, { error: '缺少线路名' });
        setColBlocked(lb, false);
        saveConfig();
        log('info', 'sys', '已恢复上游采集线路: ' + lb + '（下次同步后重新出现）');
        return sendJSON(res, 200, { ok: true, colBlocked: config.colBlockedLines });
      }
      if (p === '/api/admin/up-lines/block' && method === 'POST') {
        const b = await readBody(req);
        const lb = String((b && b.label) || '').trim();
        if (!lb) return sendJSON(res, 400, { error: '缺少线路名' });
        config.blockedLines = config.blockedLines || [];
        if (config.blockedLines.indexOf(lb) < 0) config.blockedLines.push(lb);
        saveConfig();
        log('warn', 'sys', '已拉黑播放线路: ' + lb);
        return sendJSON(res, 200, { ok: true, blocked: config.blockedLines });
      }
      if (p === '/api/admin/up-lines/update' && method === 'POST') {
        const b = await readBody(req);
        const lb = String((b && b.label) || '').trim();
        const nl = String((b && b.newLabel) || '').trim();
        const nu = String((b && b.newUrl) || '').trim();
        if (!lb) return sendJSON(res, 400, { error: '缺少线路名' });
        const arr = config.upstreamLines || [];
        const it = arr.find(x => String(x.label || '') === lb);
        if (!it) return sendJSON(res, 404, { error: '线路不存在: ' + lb });
        if (nl && nl !== lb) {
          it.label = nl;
          /* 改名后同步拉黑名单，避免按旧名拉黑的条目失配 */
          config.blockedLines = (config.blockedLines || []).map(x => x === lb ? nl : x);
        }
        if (nu) it.url = nu;
        saveConfig();
        log('info', 'sys', '已修改播放线路: ' + lb + ' → ' + it.label + (nu ? '（地址已更新）' : ''));
        return sendJSON(res, 200, { ok: true, line: it });
      }
      if (p === '/api/admin/up-lines/unblock' && method === 'POST') {
        const b = await readBody(req);
        const lb = String((b && b.label) || '').trim();
        config.blockedLines = (config.blockedLines || []).filter(x => x !== lb);
        saveConfig();
        log('info', 'sys', '已恢复播放线路: ' + lb);
        return sendJSON(res, 200, { ok: true, blocked: config.blockedLines });
      }
      if (p === '/api/admin/parse/sync-upstream' && method === 'POST') {
        /* v34：逻辑抽到 syncUpstreamLines()，与定时自动同步共用 */
        return sendJSON(res, 200, await syncUpstreamLines());
      }
      /* v34：上游线路自动同步（ticket 被上游轮换时自动更新并保存） */
      if (p === '/api/admin/up-autosync' && method === 'GET') {
        const st = upAutoSyncState();
        return sendJSON(res, 200, { enabled: !!st.enabled, intervalMin: st.intervalMin, lastRun: st.lastRun || 0, lastOk: st.lastOk, lastMsg: st.lastMsg || '' });
      }
      if (p === '/api/admin/up-autosync' && method === 'POST') {
        const b = await readBody(req);
        const st = upAutoSyncState();
        if (b && b.enabled != null) st.enabled = !!b.enabled;
        if (b && b.intervalMin != null) { const n = parseInt(b.intervalMin, 10); if (n >= 5) st.intervalMin = n; }
        saveConfig();
        log('info', 'sys', '上游线路自动同步已' + (st.enabled ? '开启（每 ' + st.intervalMin + ' 分钟检查）' : '关闭'));
        let run = null;
        if (st.enabled && b && b.runNow) run = await upAutoSyncTick('手动');
        return sendJSON(res, 200, { ok: true, state: st, run });
      }
      /* 采集地址 */
      if (p === '/api/admin/collect' && method === 'GET') {
        return sendJSON(res, 200, { list: config.collectList || [] });
      }
      if (p === '/api/admin/collect' && method === 'POST') {
        const b = await readBody(req);
        if (!b.name || !b.api) return sendJSON(res, 400, { error: '名称和API地址必填' });
        const na = normalizeCollectApi(b.api);
        if (na.error) return sendJSON(res, 400, { error: na.error });
        config.collectList = config.collectList || [];
        config.collectList.push({ id: uid(), name: String(b.name).trim().slice(0, 40), api: na.api });
        saveConfig();
        return sendJSON(res, 200, { ok: true, list: config.collectList, api: na.api, fixed: na.fixed });
      }
      if (p === '/api/admin/collect/update' && method === 'POST') {
        const b = await readBody(req);
        const cid = String((b && b.id) || '');
        const it = (config.collectList || []).find(x => x.id === cid);
        if (!it) return sendJSON(res, 404, { error: '采集站不存在' });
        if (b.name && String(b.name).trim()) it.name = String(b.name).trim().slice(0, 40);
        if (b.api && String(b.api).trim()) {
          const na = normalizeCollectApi(b.api);
          if (na.error) return sendJSON(res, 400, { error: na.error });
          it.api = na.api;
        }
        saveConfig();
        log('info', 'sys', '已修改采集站: ' + it.name + ' ← ' + it.api);
        return sendJSON(res, 200, { ok: true, api: it.api });
      }
      if (p.startsWith('/api/admin/collect/') && method === 'DELETE') {
        const id = p.split('/').pop();
        config.collectList = (config.collectList || []).filter(x => x.id !== id);
        saveConfig();
        /* 若首页源指向它则复位 */
        if (config.home.source === id) config.home.source = 'tmdb';
        saveConfig();
        return sendJSON(res, 200, { ok: true });
      }
      /* 测试采集站连通性 */
      if (p === '/api/admin/collect/test' && method === 'POST') {
        const b = await readBody(req);
        const _ap = String((b && b.api) || '').trim();
        /* v73：先规范化，用户填域名根也能测出真实结果，而不是打到一个不存在的路径上说不通 */
        const _na = normalizeCollectApi(_ap);
        if (_na.error) return sendJSON(res, 200, { ok: false, error: _na.error });
        const _use = _na.api;
        try {
          const j = await collectRaw({ api: _use }, 'pg=1');
          const got = !!(j && j.list && j.list.length);
          return sendJSON(res, 200, {
            ok: got, api: _use, fixed: !!_na.fixed, total: j && j.total,
            error: got ? null : '地址可访问但没有返回影片列表（可能不是苹果CMS 采集接口，确认形如 https://域名/api.php/provide/vod）'
          });
        } catch (e) { return sendJSON(res, 200, { ok: false, api: _use, error: String(e.message || e) }); }
      }
      /* ---------- v60：自动获取上游采集地址（先拉上游采集档线路 → 展开候选 → 真实测通 → 自动保存） ----------
         实测结论（写在注释里备忘）：上游没有「采集站清单」接口（50 个候选端点全 404），
         上游给的采集档地址是「播放 CDN」，与苹果CMS 采集 API 是两套体系，166 个候选 0 命中。
         因此这里做的是「尽最大努力自动探测」，探测不到时如实上报原因，日常补站走批量导入。 */
      if (p === '/api/admin/collect/auto' && method === 'POST') {
        const b = await readBody(req) || {};
        const st = collectAutoState();
        if (b && b.setAuto) {
          st.enabled = !!b.enabled; saveConfig();
          log('info', 'sys', '采集站自动获取已' + (st.enabled ? '开启（每天一次）' : '关闭'));
          return sendJSON(res, 200, { ok: true, enabled: st.enabled });
        }
        if (collectAutoRunning) return sendJSON(res, 200, { error: '正在探测中，请稍候' });
        collectAutoRunning = true;
        try {
          let ups = (config.upstreamCollectLines || []).slice();
          if (!ups.length) {
            const s = await syncUpstreamLines();
            ups = (config.upstreamCollectLines || []).slice();
            if (!ups.length) {
              /* 区分两种空：自己全删了 vs 上游真没给 */
              const nb = (config.colBlockedLines || []).length;
              if (nb && !(s && s.error)) return sendJSON(res, 200, { error: '你已把 ' + nb + ' 条上游采集线路全部删除了，先到下面点「恢复全部」再来获取' });
              return sendJSON(res, 200, { error: '上游没有返回采集档线路' + (s && s.error ? '（' + s.error + '）' : '') + '，先到「解析地址」页点「重新获取并添加」' });
            }
          }
          /* 1) 展开候选地址 */
          const seen = {}, cands = [];
          for (const e of ups) {
            for (const api of collectCandidatesFromUrl(e.url || '')) {
              if (seen[api]) continue; seen[api] = 1;
              cands.push({ name: String(e.label || '').replace(/资源$/, '') || '未命名', api });
            }
          }
          const have = {};
          (config.collectList || []).forEach(c => { have[String(c.api || '').replace(/\/+$/, '').toLowerCase()] = 1; });
          const todo = cands.filter(c => !have[c.api.toLowerCase()]);
          const skipped = cands.filter(c => !todo.includes(c)).map(c => ({ name: c.name, api: c.api, why: '已存在，跳过' }));
          /* 2) 并发真实连通测试 */
          const rs = await probeMany(todo.map(c => c.api), 5000, 12);
          /* 3) 通过的自动保存（同一资源名只保留第一个通的） */
          const added = [], failed = skipped.slice(), byName = {};
          todo.forEach((c, i) => {
            const r = rs[i] || { ok: false, why: '未测试' };
            if (r && r.ok && !byName[c.name]) { byName[c.name] = 1; added.push({ name: c.name, api: c.api, total: r.total }); }
            else if (!(r && r.ok)) failed.push({ name: c.name, api: c.api, why: (r && r.why) || '不可达' });
          });
          if (added.length) {
            config.collectList = config.collectList || [];
            added.forEach(a => { config.collectList.push({ id: uid(), name: a.name, api: a.api }); });
            saveConfig();
            log('info', 'sys', '自动获取采集地址：探测 ' + todo.length + ' 个候选，新增 ' + added.length + ' 个采集站');
          } else {
            log('warn', 'sys', '自动获取采集地址：探测 ' + todo.length + ' 个候选，无一通过（上游播放 CDN 上通常没有采集 API）');
          }
          st.lastRun = Date.now();
          st.lastMsg = added.length ? ('新增 ' + added.length + ' 个') : ('探测 ' + todo.length + ' 个，0 通过');
          saveConfig();
          return sendJSON(res, 200, {
            ok: true, tested: todo.length, added, failed, skipped,
            note: added.length ? '' : '（上游只提供播放地址，不提供采集站 API，自动反推命中率低）'
          });
        } catch (e) {
          return sendJSON(res, 200, { error: String(e.message || e) });
        } finally { collectAutoRunning = false; }
      }
      /* ---------- v60：批量导入采集地址（逐条真实测通后才保存） ---------- */
      if (p === '/api/admin/collect/import' && method === 'POST') {
        const b = await readBody(req) || {};
        const lines = String(b.text || '').split(/\r?\n/).map(x => x.trim()).filter(Boolean);
        if (!lines.length) return sendJSON(res, 400, { error: '请粘贴至少一条采集地址' });
        if (lines.length > 200) return sendJSON(res, 400, { error: '一次最多导入 200 条' });
        const items = lines.map(l => {
          const i = l.indexOf('|');
          if (i > 0) return { name: l.slice(0, i).trim() || '未命名', api: l.slice(i + 1).trim() };
          let api = l, host = '';
          try { host = new URL(l).hostname; } catch (e) {}
          return { name: host || '未命名', api };
        });
        const bad = [], good = [];
        items.forEach(it => {
          /* v73：批量导入同样先规范化，域名根自动补全、视频直链直接剔除 */
          const na = normalizeCollectApi(it.api);
          if (na.error) { bad.push(Object.assign({}, it, { why: na.error })); return; }
          good.push(Object.assign({}, it, { api: na.api }));
        });
        const have = {};
        (config.collectList || []).forEach(c => { have[String(c.api || '').replace(/\/+$/, '').toLowerCase()] = 1; });
        const todo = [], skipped = [];
        good.forEach(c => { if (have[c.api.toLowerCase()]) skipped.push({ name: c.name, api: c.api, why: '已存在，跳过' }); else todo.push(c); });
        const rs = await probeMany(todo.map(c => c.api), 8000, 10);
        const added = [], failed = bad.slice();
        todo.forEach((c, i) => {
          const r = rs[i] || { ok: false, why: '未测试' };
          if (r && r.ok) added.push({ name: c.name, api: c.api, total: r.total });
          else failed.push({ name: c.name, api: c.api, why: (r && r.why) || '不可达' });
        });
        if (added.length) {
          config.collectList = config.collectList || [];
          added.forEach(a => { config.collectList.push({ id: uid(), name: a.name, api: a.api }); });
          saveConfig();
          log('info', 'sys', '批量导入采集站：提交 ' + lines.length + ' 条，通过 ' + added.length + ' 条已保存');
        }
        return sendJSON(res, 200, { ok: true, added, failed, skipped });
      }
    }

    /* 客户端（播放器）上报日志：音频出错 / 解码重置 / 卡顿 等前端才能感知的事件，汇入同一套后台日志。
       放在管理员块之外：播放器用登录用户 token（可能是普通用户），只需登录即可上报 */
    if (p === '/api/log' && method === 'POST') {
      const user = authUser(req, u);
      if (!user) return sendJSON(res, 401, { error: 'unauthorized' });
      const b = await readBody(req);
      const lvl = ['info', 'warn', 'error', 'debug'].includes(b.level) ? b.level : 'info';
      const tag = String(b.tag || 'client').slice(0, 24).replace(/[^a-zA-Z0-9_:-]/g, '');
      const msg = String(b.msg || '').slice(0, 400);
      const extra = b.extra != null ? String(b.extra).slice(0, 300) : '';
      if (!msg) return sendJSON(res, 400, { error: 'empty' });
      log(lvl, 'c:' + tag, msg, extra);
      return sendJSON(res, 200, { ok: true });
    }

    /* 静态 */
    if (method === 'GET') return serveStatic(req, res, p);

    return sendJSON(res, 404, { error: 'not found' });
  } catch (e) {
    console.error('[err]', p, e);
    if (!res.headersSent) sendJSON(res, 500, { error: String(e.message || e) });
  }
});

/* v73c：进程级守护。之前任何异步回调里的未捕获异常（如静态文件双响应的
   ERR_HTTP_HEADERS_SENT）都会把进程打崩，docker --restart always 拉起后
   再崩，循环重启期间全站 401（会话在内存里）。守住进程，异常留痕继续服务。 */
process.on('uncaughtException', e => {
  try { log('error', 'crash', '未捕获异常(已守护): ' + (e && (e.stack || e.message) || e).split('\n').slice(0, 4).join(' | ')); } catch (x) {}
  console.error('[uncaught]', e && (e.stack || e.message) || e);
});
process.on('unhandledRejection', e => {
  try { log('error', 'crash', '未处理的Promise拒绝(已守护): ' + (e && (e.stack || e.message) || e).split('\n').slice(0, 4).join(' | ')); } catch (x) {}
  console.error('[unhandledRejection]', e && (e.stack || e.message) || e);
});

server.listen(PORT, HOST, () => {
  console.log(`[aistream] listening on ${HOST}:${PORT}  data=${DATA_DIR}`);
  log('info', 'sys', '服务启动 ' + HOST + ':' + PORT + ' data=' + DATA_DIR);
  startBcTimer();   // 启动/重启后恢复广播连推定时器（若后台已启用）
});

