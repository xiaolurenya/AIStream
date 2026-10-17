'use strict';
const $ = s => document.querySelector(s);
const COLS_LABELS = { trending: '本周热门', zh_tv_hot: '华语热播剧', zh_movie_hot: '华语热门电影', movie_popular: '热门电影', tv_popular: '热门剧集', movie_top: '高分电影', tv_top: '高分剧集', movie_now: '正在热映', tv_air: '即将上线' };
let TOKEN = localStorage.getItem('aistream_admin_token') || '';
let ME = null, CFG = null, ColConfig = [];

async function api(path, opts = {}) {
  opts.headers = Object.assign({ 'Authorization': 'Bearer ' + TOKEN }, opts.headers || {});
  if (opts.body && typeof opts.body !== 'string') opts.body = JSON.stringify(opts.body);
  const r = await fetch(path, opts);
  if (r.status === 401) {
    /* 关键：先清掉失效 token 再跳，否则本页重载后带着死 token 再次 401 → 无限刷新狂闪 */
    localStorage.removeItem('aistream_admin_token');
    location.replace('/admin.html');   /* 必须用 .html：/admin 没有对应路由，会 404 */
    throw new Error('no auth');
  }
  /* v63：未激活的空壳站，除授权接口外一律 402 —— 后台给一条明确提示，别让人以为后台坏了 */
  if (r.status === 402) { showLicBlock(); throw new Error('license'); }
  return r.json();
}
function toast(t, c = 3000) { const e = document.createElement('div'); e.className = 'toast'; e.innerHTML = `<div class="tt">${t}</div>`; $('#toast').appendChild(e); setTimeout(() => e.remove(), c); }

async function login() {
  const u = $('#aUser').value.trim(), p = $('#aPass').value;
  try {
    const r = await fetch('/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: u, password: p }) });
    const j = await r.json();
    if (!r.ok) { $('#aErr').textContent = j.error || '失败'; return; }
    TOKEN = j.token; localStorage.setItem('aistream_admin_token', TOKEN); ME = j.user;
    if (ME.role !== 'admin') { $('#aErr').textContent = '非管理员账号'; localStorage.removeItem('aistream_admin_token'); return; }
    enter();
  } catch (e) { $('#aErr').textContent = '网络错误'; }
}
function logout() { localStorage.removeItem('aistream_admin_token'); location.href = '/admin.html'; }

async function enter() {
  $('#gateAdmin').classList.add('hidden');
  $('#adminMain').classList.remove('hidden');
  ME = (await api('/api/auth/me')).user;
  $('#uName').textContent = ME.username;
  await loadAll();
}
async function loadAll() {
  /* v63：先取授权状态——未激活的空壳站下面那批接口会全部 402，先让「授权管理」能用 */
  try { await loadLicense(); } catch (e) {}
  try {
  const cfgRes = await api('/api/admin/config');
  CFG = cfgRes.config || cfgRes;
  const users = (await api('/api/admin/users')).users || [];
  const parse = (await api('/api/admin/parse')).list || [];
  const collect = (await api('/api/admin/collect')).list || [];
  const adsCfg = (await api('/api/admin/ads')).ads || {};
  const ptsCfg = (await api('/api/admin/points')).points || {};
  const vipCfg = (await api('/api/admin/vip')).vip || {};
  const rdCfg = (await api('/api/admin/redeem')).redeem || {};
  $('#stats').innerHTML = `
    <div class="b"><div class="n">${users.length}</div><div class="l">用户数</div></div>
    <div class="b"><div class="n">${parse.length}</div><div class="l">解析地址</div></div>
    <div class="b"><div class="n">${collect.length}</div><div class="l">采集站</div></div>
    <div class="b"><div class="n">${adsCfg.enabled ? ((adsCfg.items || []).filter(x => x.enabled !== false).length + ' 条') : '关'}</div><div class="l">广告联盟</div></div>
    <div class="b"><div class="n">${ptsCfg.enabled === false ? '关' : '开'}</div><div class="l">积分系统</div></div>`;
  /* 广告联盟 / 积分会员 表单回填 */
  fillAdsForm(adsCfg);
  fillPointsForm(ptsCfg, vipCfg);
  fillRdForm(rdCfg);
  // 首页配置
  $('#hName').value = CFG.siteName || '';
  /* 注册开关回填 */
  if ($('#regEn')) $('#regEn').checked = !!(CFG.reg && CFG.reg.enabled);
  renderRegPerm();
  const HG = CFG.hero || {};
  $('#hPageTitle').value = HG.pageTitle || '';
  $('#hGateSub').value = HG.gateSub || '';
  $('#hHeroTitle').value = HG.title || '';
  $('#hHeroSub').value = HG.sub || '';
  $('#hHeroTSize').value = HG.titleSize || '';
  $('#hHeroTColor').value = HG.titleColor || '';
  $('#hHeroSSize').value = HG.subSize || '';
  $('#hHeroSColor').value = HG.subColor || '';
  $('#hTip').value = (CFG.home && CFG.home.tip) || '';
  $('#tAutoSkip').checked = !!(CFG.toggles && CFG.toggles.autoSkip);
  ColConfig = (CFG.home && CFG.home.columns) ? CFG.home.columns.map(c => Object.assign({}, c)) : [];
  renderColList();
  populateColKey();
  $('#tScam').checked = !!(CFG.toggles && CFG.toggles.antiScam);
  $('#tScamText').value = (CFG.toggles && CFG.toggles.antiScamText) || '';
  $('#tScamSpeed').value = (CFG.toggles && CFG.toggles.antiScamSpeed) || 15;
  $('#tScamColor').value = (CFG.toggles && CFG.toggles.antiScamColor) || '#ffd9f3';
  $('#tScamSize').value = (CFG.toggles && CFG.toggles.antiScamSize) || 13;
  $('#tScamFrom').value = (CFG.toggles && CFG.toggles.antiScamFrom != null) ? CFG.toggles.antiScamFrom : 100;
  $('#tScamTo').value = (CFG.toggles && CFG.toggles.antiScamTo != null) ? CFG.toggles.antiScamTo : -100;
  // 公告
  $('#aEn').checked = !!(CFG.announcement && CFG.announcement.enabled);
  $('#aTitle').value = (CFG.announcement && CFG.announcement.title) || '';
  $('#aContent').value = (CFG.announcement && CFG.announcement.content) || '';
  $('#aMode').value = (CFG.announcement && CFG.announcement.mode) || 'normal';
  // 广播
  $('#bEn').checked = !!(CFG.broadcast && CFG.broadcast.enabled);
  $('#bTitle').value = (CFG.broadcast && CFG.broadcast.title) || '';
  $('#bContent').value = (CFG.broadcast && CFG.broadcast.content) || '';
  $('#bCount').value = (CFG.broadcast && CFG.broadcast.count) || 1;
  $('#bInterval').value = (CFG.broadcast && CFG.broadcast.interval) || 1;
  $('#bUnit').value = (CFG.broadcast && CFG.broadcast.intervalUnit) || 'h';
  // 内容地区
  $('#hRegion').value = CFG.tmdbRegion || 'CN';
  // 解析 + 上游线路
  renderParse(parse);
  renderUpLines();
  renderUpCollectLines();
  loadUpAutoSync();
  fillUpstreamForm(CFG.upstream || {});
  fillCollectAuto((CFG.collectAuto) || {});
  fillMiscForm(CFG.misc || {});   /* v63 其他设置：播放器加载卡文案 + 继续发现轮播间隔 */
  // 采集
  renderCollect(collect);
  // 用户
  ADMIN_USERS = users || [];
  renderUsers(users);
  // 广告过滤
  const ad = CFG.adFilter || {};
  const iv = CFG.iptv || {};
  $('#iEn').checked = !!iv.enabled;
  $('#iEpg').value = iv.epgUrl || '';
  $('#iEpgEn').checked = iv.epgEnabled !== false && !!iv.epgUrl;
  IPTV_SRCS = Array.isArray(iv.sources) ? iv.sources.map(s => Object.assign({}, s)) : [];
  if (!IPTV_SRCS.length && iv.m3uUrl) IPTV_SRCS = [{ id: 's1', name: '默认源', url: iv.m3uUrl, enabled: true }];
  IPTV_PERM = Object.assign({ users: {}, levels: {} }, iv.groupPerm || {});
  IPTV_ORDER = Array.isArray(iv.groupOrder) ? iv.groupOrder.slice() : [];   /* v64：分组排序 */
  renderIptvSrcs();
  renderIptvPerm();
  renderIptvGroups();
  renderIptvOrder();
  $('#adEn').checked = !!ad.enabled;
  $('#adTs').checked = !!ad.tsProxy;
  $('#adBl').value = Array.isArray(ad.blacklist) ? ad.blacklist.join('\n') : '';
  } catch (e) { /* v63：未激活（402）时到哪一步算哪一步，其余面板留空即可 */ }
}
/* ---------- v44：IPTV 多直播源 + 分组预览 + 按用户控源 ---------- */
let IPTV_SRCS = [], IPTV_PERM = {}, ADMIN_USERS = [];

/* ---------- v57：手动分组 ----------
   源上填了「分组」→ 该源全部频道统一归到这个分组（覆盖清单自带分组）。
   所以「分组列表」= 自动拉取的 groupStats + 所有源上手动填的分组，两处都要能用、能配权限。 */
function iptvManualGroups() {
  const out = [];
  (IPTV_SRCS || []).forEach(s => { const g = String((s && s.group) || '').trim(); if (g && out.indexOf(g) < 0) out.push(g); });
  return out;
}
function iptvAllGroupNames() {
  const out = [];
  (((CFG.iptv || {}).groupStats) || []).forEach(g => { const n = String((g && g.name) || '').trim(); if (n && out.indexOf(n) < 0) out.push(n); });
  iptvManualGroups().forEach(g => { if (out.indexOf(g) < 0) out.push(g); });
  return out;
}
/* datalist 候选：已有分组 + 已手动填过的分组（方便复用同一名字把多个源合到一组） */
function refreshSrcGroupList() {
  const dl = document.getElementById('iSrcGroupList'); if (!dl) return;
  const names = iptvAllGroupNames();
  dl.innerHTML = names.map(n => '<option value="' + esc(n) + '"></option>').join('');
}
function renderIptvSrcs() {
  const tb = $('#iSrcTable tbody'); if (!tb) return;
  tb.innerHTML = '';
  IPTV_SRCS.forEach((s, i) => {
    const tr = document.createElement('tr');
    tr.innerHTML = `<td><input data-si="${i}" data-f="name" value="${esc(s.name || '')}" placeholder="源名称"></td>`
      + `<td><input data-si="${i}" data-f="url" value="${esc(s.url || '')}" placeholder="http://…/m3u"></td>`
      + `<td><input data-si="${i}" data-f="group" list="iSrcGroupList" value="${esc(s.group || '')}" placeholder="留空=清单自带"></td>`
      + `<td style="text-align:center"><input type="checkbox" data-si="${i}" data-f="enabled" ${s.enabled !== false ? 'checked' : ''}></td>`
      + `<td><div style="display:flex;gap:6px"><button class="btn" data-t1="${i}">测试</button><button class="btn danger" data-del="${i}">删除</button></div></td>`;
    tb.appendChild(tr);
  });
  refreshSrcGroupList();
  tb.querySelectorAll('input[data-si]').forEach(inp => {
    inp.onchange = () => {
      const s = IPTV_SRCS[+inp.dataset.si]; if (!s) return;
      const wasGroup = inp.dataset.f === 'group';
      if (inp.dataset.f === 'enabled') s.enabled = inp.checked;
      else s[inp.dataset.f] = inp.value;
      /* v57：改分组会改变分组清单 → 候选列表/权限矩阵/分组表都要跟着变 */
      if (wasGroup) { refreshSrcGroupList(); renderIptvGroups(); renderIptvPerm(); renderIptvOrder(); }
    };
  });
  tb.querySelectorAll('[data-t1]').forEach(b => {
    b.onclick = async () => {
      const s = IPTV_SRCS[+b.dataset.t1];
      b.textContent = '…'; b.disabled = true;
      const r = await api('/api/admin/iptv-test', { method: 'POST', body: { sources: [s] } }).catch(e => ({ ok: false, error: '请求失败' }));
      b.textContent = '测试'; b.disabled = false;
      const hit = (r.results || [])[0] || {};
      b.title = hit.ok ? ('频道 ' + hit.count) : (hit.error || '');
      toast(hit.ok ? ('✅ ' + (s.name || '') + '：' + hit.count + ' 个频道') : ('❌ ' + (s.name || '') + '：' + (hit.error || '失败')));
    };
  });
  tb.querySelectorAll('[data-del]').forEach(b => {
    b.onclick = () => { IPTV_SRCS.splice(+b.dataset.del, 1); renderIptvSrcs(); renderIptvGroups(); renderIptvPerm(); renderIptvOrder(); };
  });
}
$('#iSrcAdd').onclick = () => {
  const url = $('#iSrcUrl').value.trim();
  if (!/^https?:\/\//i.test(url)) return toast('❌ 地址需以 http:// 或 https:// 开头');
  IPTV_SRCS.push({ id: 's' + (IPTV_SRCS.length + 1) + '_' + Math.random().toString(36).slice(2, 6), name: $('#iSrcName').value.trim() || ('源' + (IPTV_SRCS.length + 1)), url, enabled: true, group: $('#iSrcGroup').value.trim() });
  $('#iSrcName').value = ''; $('#iSrcUrl').value = '';
  /* 分组不清空：连着加多个源到同一分组时省事 */
  renderIptvSrcs(); renderIptvGroups(); renderIptvPerm(); renderIptvOrder();   /* v57：新分组立刻出现在分组表和权限矩阵里 */
};
$('#iGroups').onclick = async () => {
  $('#iGroupStat').textContent = '⏳ 正在逐个拉取直播源…';
  $('#iGroupPrev').innerHTML = '';
  const srcs = IPTV_SRCS.filter(s => s.enabled !== false && s.url);
  if (!srcs.length) { $('#iGroupStat').textContent = '❌ 请先添加并启用直播源'; return; }
  const r = await api('/api/admin/iptv-test', { method: 'POST', body: { sources: srcs } }).catch(e => ({ ok: false, error: '请求失败' }));
  const box = $('#iGroupPrev'); box.innerHTML = '';
  const rmap = {};
  (r.results || []).forEach(x => { rmap[x.id] = x; });
  srcs.forEach(s => {
    const hit = rmap[s.id] || {};
    const chip = document.createElement('span');
    chip.className = 'pv';
    chip.innerHTML = hit.ok ? ('✅ ' + esc(s.name || s.id) + ' · ' + hit.count + ' 频道') : ('❌ ' + esc(s.name || s.id) + ' · ' + (hit.error || '失败'));
    chip.style.borderColor = hit.ok ? 'rgba(0,229,255,.4)' : 'rgba(255,107,138,.4)';
    box.appendChild(chip);
  });
  const okN = (r.results || []).filter(x => x.ok).length;
  $('#iGroupStat').textContent = '共 ' + okN + '/' + srcs.length + ' 个源可用，' + (r.total || 0) + ' 个频道，' + (r.groups || []).length + ' 个分组（自动汇总）';
  /* 分组快照持久化：下次进后台直接显示列表（v57：带上手动分组，源拉失败也不丢） */
  const gs2 = (r.groups || []).slice();
  iptvManualGroups().forEach(n => { if (!gs2.some(g => String((g && g.name) || '') === n)) gs2.push({ name: n, count: 0 }); });
  const gr = await api('/api/admin/config', { method: 'POST', body: { iptv: { groupStats: gs2 } } });
  if (gr.config && gr.config.iptv) { CFG.iptv = gr.config.iptv; renderIptvGroups(); renderIptvPerm(); renderIptvOrder(); }
};
/* 权限矩阵（v45b）：行 = VIP 等级 + 用户，列 = 分组。
   v46 修复显示：勾选框显示「实际生效值」——
   等级行：未设置 = 默认允许；用户行：未设置 = 继承所属会员等级（不再一律画成勾，避免后台显示和前台实际不一致） */
function renderIptvPerm() {
  const head = $('#iPermHead'), body = $('#iPermBody'); if (!head || !body) return;
  head.innerHTML = ''; body.innerHTML = '';
  /* v57：手动分组也算一列（源上填了分组名就能直接控权限，不用先刷新分组） */
  const groups = iptvSortedNames(iptvAllGroupNames());   /* v64：权限矩阵列序也跟分组排序走 */
  if (!groups.length) { head.innerHTML = '<th>对象</th>'; body.innerHTML = '<tr><td style="color:var(--muted)">还没拿到分组：点上方「获取/刷新分组」自动拉取，或在直播源表里手动填一个分组名</td></tr>'; return; }
  head.innerHTML = '<th>对象</th>' + groups.map(g => '<th title="' + esc(g) + '">' + esc(g) + '</th>').join('');
  const lvGet = (lvl, g) => { const r = (IPTV_PERM.levels || {})[String(lvl)] || {}; return r[g] !== undefined ? r[g] : true; };
  const mkRow = (label, tag, type, key, eff, lock) => {
    const tr = document.createElement('tr');
    tr.innerHTML = '<td><b>' + esc(label) + '</b> <span class="tag" style="margin-left:6px">' + tag + '</span></td>'
      + groups.map(g => '<td><input type="checkbox" data-pt="' + type + '" data-pk="' + esc(key) + '" data-sk="' + esc(g) + '"'
        + (eff(g) ? ' checked' : '') + (lock ? ' disabled title="管理员始终可看全部分组"' : ' title="' + (type === 'users' ? '未勾选=隐藏；显示的勾 = 自己设置或继承所属会员等级' : '未设置 = 默认允许') + '"') + '></td>').join('');
    body.appendChild(tr);
  };
  (VIP_LEVELS || []).slice().sort((a, b) => a.level - b.level).forEach(l => {
    mkRow('Lv' + l.level + ' ' + (l.name || ''), '会员等级', 'levels', String(l.level), g => lvGet(l.level, g), false);
  });
  (ADMIN_USERS || []).forEach(u => {
    const isAdmin = u.role === 'admin';
    const lvl = (u.vip && u.vip.level != null) ? u.vip.level : 0;
    const urow = (IPTV_PERM.users || {})[u.username] || {};
    const eff = isAdmin ? (() => true) : (g => urow[g] !== undefined ? urow[g] : lvGet(lvl, g));
    mkRow(u.username, isAdmin ? '管理员·恒可看' : '用户' + (lvl ? '·继承Lv' + lvl : ''), 'users', u.username, eff, isAdmin);
  });
  body.querySelectorAll('input[type="checkbox"]:not([disabled])').forEach(i => {
    i.onchange = () => {
      IPTV_PERM.users = IPTV_PERM.users || {}; IPTV_PERM.levels = IPTV_PERM.levels || {};
      const t = IPTV_PERM[i.dataset.pt] || (IPTV_PERM[i.dataset.pt] = {});
      const row = t[i.dataset.pk] || (t[i.dataset.pk] = {});
      row[i.dataset.sk] = !!i.checked;   /* 显式存 true/false：用户未设置的键 = 继承等级；等级未设置的键 = 默认允许 */
    };
  });
}
/* 分组单独列表：从上次获取的快照渲染（获取/刷新后更新并随保存持久化） */
function renderIptvGroups() {
  const tb = $('#iGroupTable tbody'); if (!tb) return;
  const gs = (CFG.iptv || {}).groupStats || [];
  const manual = iptvManualGroups();
  /* v57：手动分组即使没拉过快照也要列出来（标记「手动」），方便一眼看到自己设了哪些 */
  const rows = gs.map(g => ({ name: String((g && g.name) || ''), count: Number((g && g.count) || 0), manual: manual.indexOf(String((g && g.name) || '')) >= 0 }));
  manual.forEach(n => { if (!rows.some(r => r.name === n)) rows.push({ name: n, count: 0, manual: true }); });
  /* v64：分组表也按后台设置的排序显示（跟前台页签一致） */
  const ord = iptvSortedNames(rows.map(r => r.name));
  rows.sort((a, b) => ord.indexOf(a.name) - ord.indexOf(b.name));
  tb.innerHTML = rows.length
    ? rows.map(g => '<tr><td>' + esc(g.name) + (g.manual ? ' <span class="tag" style="margin-left:6px">手动分组</span>' : '') + '</td><td>' + (g.manual && !g.count ? '（源未刷新）' : g.count) + '</td></tr>').join('')
    : '<tr><td colspan="2" style="color:var(--muted)">还没有分组数据 — 点上方「获取/刷新分组」自动拉取全部直播源的分组，或在源表里手动填分组名</td></tr>';
}

/* ---------- v64：分组排序 ----------
   IPTV_ORDER = 后台手动排过的分组名（完整有序）；不在里面的分组按名称排后面。
   前台 /api/iptv 返回 groupOrder，分组页签按同一条规则显示。 */
let IPTV_ORDER = [];
/* 统一排序规则：order 里的按顺序在前，其余按中文字典序跟后 */
function iptvSortedNames(all) {
  const names = all.slice();
  const ord = IPTV_ORDER.filter(n => names.indexOf(n) >= 0);
  const rest = names.filter(n => ord.indexOf(n) < 0).sort((a, b) => a.localeCompare(b, 'zh'));
  return ord.concat(rest);
}
function renderIptvOrder() {
  const box = $('#iOrderBox'); if (!box) return;
  const names = iptvSortedNames(iptvAllGroupNames());
  if (!names.length) { box.innerHTML = '<div style="color:var(--muted);font-size:12.5px">还没有分组 — 先获取/刷新分组或填手动分组</div>'; return; }
  box.innerHTML = names.map((n, i) =>
    '<div style="display:flex;align-items:center;gap:8px;padding:4px 0;border-bottom:1px dashed var(--line)">'
    + '<span style="color:var(--muted);font-size:12px;width:20px">' + (i + 1) + '.</span>'
    + '<span style="flex:1">' + esc(n) + '</span>'
    + '<button class="mini" type="button" data-o-up="' + i + '"' + (i === 0 ? ' disabled' : '') + '>↑</button>'
    + '<button class="mini" type="button" data-o-dn="' + i + '"' + (i === names.length - 1 ? ' disabled' : '') + '>↓</button>'
    + '</div>').join('');
  box.querySelectorAll('[data-o-up]').forEach(b => b.onclick = () => iptvOrderMove(+b.dataset.oUp, -1));
  box.querySelectorAll('[data-o-dn]').forEach(b => b.onclick = () => iptvOrderMove(+b.dataset.oDn, 1));
}
function iptvOrderMove(i, d) {
  const names = iptvSortedNames(iptvAllGroupNames());
  const j = i + d; if (j < 0 || j >= names.length) return;
  const t = names[i]; names[i] = names[j]; names[j] = t;
  IPTV_ORDER = names;          // 全量记住（简单直观：看到的顺序就是保存的顺序）
  renderIptvOrder(); renderIptvGroups();
}
$('#iOrderReset').onclick = () => { IPTV_ORDER = []; renderIptvOrder(); renderIptvGroups(); toast('已恢复默认排序（按名称），点「保存 IPTV 设置」生效'); };
function renderParse(list) {
  const tb = $('#pTable tbody'); tb.innerHTML = '';
  list.forEach(p => { const tr = document.createElement('tr');
    tr.innerHTML = `<td>${p.name}</td><td style="color:var(--muted);word-break:break-all">${p.url}</td><td><button class="btn" data-id="${p.id}">删除</button></td>`;
    tr.querySelector('button').onclick = async () => { await api('/api/admin/parse/' + p.id, { method: 'DELETE' }); toast('已删除'); loadAll(); };
    tb.appendChild(tr); });
}
async function renderUpLines() {
  const box = $('#upLines');
  try {
    const j = await api('/api/admin/up-lines');
    const list = j.list || [], blocked = j.blocked || [];
    if (!list.length) { box.innerHTML = '<div class="muted" style="font-size:13px">尚未获取，点「重新获取并添加」从上游拉取官方解析地址</div>'; return; }
    const isBad = o => blocked.some(b => (o.label && o.label.indexOf(b) >= 0) || (o.url && o.url.indexOf(b) >= 0));
    box.innerHTML = list.map(o => {
      const bad = isBad(o);
      const off = (o.label || '').indexOf('官方') >= 0;
      return `<div class="u${bad ? ' blocked' : ''}"><span class="lab">${esc(o.label || '官方')}</span>`
        + `<span class="typ${off ? '' : ' cj'}">${off ? '官方' : '采集'}</span>`
        + `<span class="uurl">${bad ? '已拉黑（播放自动跳过）' : (o.url ? esc(o.url) : '(需服务端 resolve 解析)')}</span>`
        + `<button class="mini" data-lb="${esc(o.label || '官方')}" data-act="edit">编辑</button>`
        + `<button class="mini" data-lb="${esc(o.label || '官方')}" data-act="${bad ? 'un' : 'block'}">${bad ? '恢复' : '拉黑'}</button></div>`;
    }).join('');
    box.querySelectorAll('button.mini').forEach(b => b.onclick = async () => {
      const lb = b.dataset.lb;
      if (b.dataset.act === 'edit') {
        const cur = list.find(x => (x.label || '官方') === lb);
        const nl = prompt('修改线路名称（原：' + lb + '）', lb);
        if (nl === null) return;
        const nu = prompt('修改线路地址（原：\n' + ((cur && cur.url) || '(需服务端 resolve 解析)') + '）', (cur && cur.url) || '');
        if (nu === null) return;
        if (!nl.trim() && !nu.trim()) { toast('名称和地址都没有改动'); return; }
        await api('/api/admin/up-lines/update', { method: 'POST', body: { label: lb, newLabel: nl.trim(), newUrl: nu.trim() } });
        toast('已保存修改');
        renderUpLines();
        return;
      }
      const un = b.dataset.act === 'un';
      await api('/api/admin/up-lines/' + (un ? 'unblock' : 'block'), { method: 'POST', body: { label: lb } });
      toast(un ? '已恢复该线路' : '已拉黑：' + lb + '，播放将自动换到其它线路');
      renderUpLines();
    });
  } catch (e) { box.innerHTML = '<div class="muted" style="font-size:13px">获取失败</div>'; }
}
/* v60：上游采集档线路列表移入「采集站」页，与解析地址页同款卡片；超过 10 条折进「显示更多」 */
function renderUpCollectLines() {
  const box = $('#upCollectLines'); if (!box) return;
  api('/api/admin/up-lines').then(j => {
    const list = (j.collect || []).slice().sort((a, b) => (Number(b.weight) || -1) - (Number(a.weight) || -1));
    if (!list.length) { box.innerHTML = '<div class="muted" style="font-size:13px">尚未获取 — 到「解析地址」页点「重新获取并添加」，或直接在下面点「自动获取上游采集地址」</div>'; return; }
    const row = (o, hid) =>
      `<div class="u${hid ? ' hid' : ''}" data-lb="${esc(o.label || '')}"><span class="lab">${esc(o.label || '')}</span>`
      + `<span class="typ cj">采集</span>`
      + (Number(o.weight) >= 0 ? `<span class="typ">权重 ${Number(o.weight)}</span>` : '')
      + `<span class="uurl" title="${esc(o.url || '')}">${o.url ? esc(o.url) : '(需服务端 resolve 解析)'}</span>`
      + `<button class="mini" data-lb="${esc(o.label || '')}" data-act="del">删除</button></div>`;
    /* 已删除区：列出被删掉的名字，可单条/全部恢复 */
    const delBox = $('#upCollectDeleted');
    const del = (j.colBlocked || []).slice();
    if (delBox) {
      if (!del.length) { delBox.style.display = 'none'; delBox.innerHTML = ''; }
      else {
        delBox.style.display = '';
        delBox.innerHTML = '<div style="margin-bottom:6px">已删除 ' + del.length + ' 条（下次同步上游不会再拉回来）：<b style="color:#ff6b8a">'
          + del.map(esc).join('、') + '</b></div>'
          + '<div style="display:flex;gap:8px;flex-wrap:wrap">'
          + del.map(d => '<button class="mini rst" data-lb="' + esc(d) + '" style="padding:3px 10px;border-radius:8px;border:1px solid rgba(0,229,255,.5);background:rgba(0,229,255,.1);color:var(--cyan);font-size:11px;cursor:pointer">恢复 ' + esc(d) + '</button>').join('')
          + '<button class="mini rst" data-lb="__all__" style="padding:3px 10px;border-radius:8px;border:1px solid var(--line);background:rgba(255,255,255,.06);color:var(--txt);font-size:11px;cursor:pointer">恢复全部</button></div>';
        delBox.querySelectorAll('button.rst').forEach(b => b.onclick = async () => {
          await api('/api/admin/up-lines/collect/restore', { method: 'POST', body: { label: b.dataset.lb } });
          toast(b.dataset.lb === '__all__' ? '已恢复全部（下次同步后重新出现）' : '已恢复 ' + b.dataset.lb + '（下次同步后重新出现）');
          renderUpCollectLines();
        });
      }
    }
    const FOLD = 10;
    if (list.length <= FOLD) { box.innerHTML = list.map(o => row(o, false)).join(''); }
    else {
      box.innerHTML = list.map((o, i) => row(o, i >= FOLD)).join('')
        + '<div class="up-more" style="grid-column:1/-1"><button class="btn" id="upCollectMore" data-open="0">显示更多（共 ' + list.length + ' 条，已显示 ' + FOLD + ' 条）</button></div>';
    }
    /* 删除按钮 */
    box.querySelectorAll('button.mini[data-act="del"]').forEach(b => b.onclick = async () => {
      const lb = b.dataset.lb;
      if (!confirm('删除上游采集线路「' + lb + '」？\n\n删掉后它不再出现在采集站列表，下次同步上游也不会再拉回来。\n（只是记录，不影响现有播放——播放的线路是每次播放时向上游实时要的）\n\n想撤销就在下面点「恢复」。')) return;
      const r = await api('/api/admin/up-lines/collect/delete', { method: 'POST', body: { label: lb } });
      if (r.error) return toast('❌ ' + r.error);
      toast('已删除 ' + lb);
      renderUpCollectLines();
    });
    const btn = box.querySelector('#upCollectMore');
    if (!btn) return;
    btn.onclick = () => {
      const open = btn.getAttribute('data-open') === '1';
      box.querySelectorAll('.u').forEach((el, i) => { if (i >= FOLD) el.classList.toggle('hid', open); });
      btn.setAttribute('data-open', open ? '0' : '1');
      btn.textContent = open ? ('显示更多（共 ' + list.length + ' 条，已显示 ' + FOLD + ' 条）') : '收起 ▴';
    };
  }).catch(() => { box.innerHTML = '<div class="muted" style="font-size:13px">获取失败</div>'; });
}
function renderCollect(list) {
  const tb = $('#cTable tbody'); tb.innerHTML = '';
  list.forEach(c => { const tr = document.createElement('tr');
    /* v73：地址形态不对就在列表里标红，别等到前台「暂无分集」才发现 */
    const apiTxt = String(c.api || '');
    const susp = !/api\.php\/provide\/vod$/i.test(apiTxt.replace(/\/+$/, ''));
    tr.innerHTML = `<td>${c.name}</td><td style="color:${susp ? 'var(--danger,#e5484d)' : 'var(--muted)'};word-break:break-all">${susp ? '⚠️ ' : ''}${c.api}</td>`
      + `<td><button class="btn" data-act="edit" data-id="${c.id}">编辑</button> <button class="btn" data-id="${c.id}">删除</button></td>`;
    tr.querySelector('[data-act="edit"]').onclick = async () => {
      const nn = prompt('修改采集站名称', c.name); if (nn === null) return;
      const na = prompt('修改 API 地址（需 http(s):// 开头的完整域名）', c.api); if (na === null) return;
      if (!nn.trim() && !na.trim()) return toast('没有改动');
      if (na.trim() && !/^https?:\/\//i.test(na.trim())) return toast('API 地址需以 http:// 或 https:// 开头');
      const rr = await api('/api/admin/collect/update', { method: 'POST', body: { id: c.id, name: nn.trim(), api: na.trim() } });
      if (rr && rr.error) return toast('❌ ' + rr.error, 6000);
      toast(rr && rr.api ? '已保存（地址已修正为 ' + rr.api + '）' : '已保存修改'); loadAll();
    };
    tr.querySelector('button[data-id]:not([data-act])').onclick = async () => { await api('/api/admin/collect/' + c.id, { method: 'DELETE' }); toast('已删除'); loadAll(); };
    tb.appendChild(tr); });
}
function renderUsers(list) {
  const tb = $('#uTable tbody'); tb.innerHTML = '';
  const vpUsers = (CFG.viewPerm && CFG.viewPerm.users) || {};
  list.forEach(u => { const tr = document.createElement('tr');
    const canDel = u.role !== 'admin';
    const isSelf = ME && u.id === ME.id;
    /* v30：用户级 IPTV 开关列已移除——IPTV 访问统一由「栏目权限」勾选控制，避免两处开关打架 */
    const pwBtn = `<button class="btn" data-pw="${u.id}" data-name="${esc(u.username)}">改密码</button>`;
    const vipBtn = `<button class="btn" data-vip="${u.id}" data-name="${esc(u.username)}">设会员</button>`;
    const ptsBtn = `<button class="btn" data-pts="${u.id}" data-name="${esc(u.username)}">调积分</button>`;
    /* 栏目权限：未配置=全部允许 */
    const vp = vpUsers[u.username];
    const denied = vp ? VIEW_KEYS.filter(k => vp[k] === false).length : 0;
    const permBtn = u.role === 'admin'
      ? '<span style="color:var(--muted);font-size:12px">全部允许</span>'
      : `<button class="btn" data-perm="${esc(u.username)}">${vp ? '权限(' + (9 - denied) + '/9)' : '设置权限'}</button>`;
    const delBtn = canDel ? `<button class="btn danger" data-id="${u.id}">删除</button>` : '<span style="color:var(--muted);font-size:12px">不可删除</span>';
    /* 会员 / 积分 / 签到邀请 */
    const v = u.vip || {};
    const vipTxt = v.level > 0
      ? `<span class="tag" style="color:#ffd9f3;border-color:rgba(255,77,216,.5)">${esc(v.name || 'Lv' + v.level)}</span><div style="font-size:11px;color:var(--muted)">${v.days > 0 ? '剩 ' + v.days + ' 天' : '永久'}</div>`
      : '<span style="color:var(--muted);font-size:12px">普通用户</span>';
    const ck = u.checkin || {};
    const ckInv = `<div style="font-size:12px">签到 <b>${ck.streak || 0}</b> 天</div><div style="font-size:12px;color:var(--muted)">邀请 ${u.invited || 0} 人</div>`;
    tr.innerHTML = `<td>${u.username}${isSelf ? ' <span style="color:var(--muted);font-size:11px">(我)</span>' : ''}</td><td>${u.role === 'admin' ? '<span class="tag">管理员</span>' : '用户'}</td><td>${vipTxt}</td><td><b style="color:var(--cyan)">${u.points || 0}</b></td><td>${ckInv}</td><td>${permBtn}</td><td style="color:var(--muted)">${new Date(u.createdAt).toLocaleString()}</td><td><div style="display:flex;gap:6px;flex-wrap:wrap">${vipBtn}${ptsBtn}${pwBtn}${delBtn}</div></td>`;
    const pb = tr.querySelector('[data-pw]');
    pb.onclick = () => openPwModal(u.id, u.username);
    tr.querySelector('[data-vip]').onclick = () => openVipModal(u.id, u.username);
    tr.querySelector('[data-pts]').onclick = () => openPtsModal(u.id, u.username);
    if (canDel) tr.querySelector('[data-id]').onclick = async () => { if (!confirm('确认删除用户 ' + u.username + '？')) return; await api('/api/admin/users/' + u.id, { method: 'DELETE' }); toast('已删除'); loadAll(); };
    const pmBtn = tr.querySelector('[data-perm]');
    if (pmBtn) pmBtn.onclick = () => openPermModal(u.username);
    tb.appendChild(tr); });
}
function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }

/* ================= v63：其他设置（播放器加载卡文案 + 继续发现轮播间隔） =================
   %s 是占位符：倒计时=剩余秒数、超时提示=已等待秒数、第 N 条线路=线路序号。
   留空即恢复默认文案（服务端收到空串就删掉该键，前端 pt() 回落默认）。 */
const PT_FIELDS = [
  { k: 'slHead', label: '卡片顶部小标题', def: '⚡ 正在准备播放' },
  { k: 'slBig', label: '卡片大标题（未起播时）', def: '正在准备播放' },
  { k: 'slLine', label: '状态行（初始）', def: '正在优选播放线路…' },
  { k: 'slFeats', label: '三行卖点（用 | 分隔）', def: '✓ 自动优选|✓ 清晰画面|✓ 秒换线路' },
  { k: 'slSwitch', label: '换源按钮', def: '⇄ 立即换源' },
  { k: 'slTickSoon', label: '倒计时提示（%s = 剩余秒数）', def: '预计 %s 秒内完成' },
  { k: 'slTickWait', label: '超时提示（%s = 已等秒数）', def: '已等待 %s 秒 · 线路较慢，可立即换源' },
  { k: 'stTitle', label: '起播大标题', def: '精彩即将开始' },
  { k: 'stSub', label: '起播副标题（加载视频）', def: '正在加载视频 · 如未自动播放请点击画面' },
  { k: 'stLineOne', label: '首条线路连接中', def: '正在连接播放线路…' },
  { k: 'stLineN', label: '第 N 条线路连接中（%s = 序号）', def: '第 %s 条线路连接中…' },
  { k: 'infoTitle', label: '获取影片信息 · 标题', def: '正在获取影片信息' },
  { k: 'infoSub', label: '获取影片信息 · 副标题', def: '如长时间无响应请刷新页面重试' },
  { k: 'matchTitle', label: '匹配片源 · 标题', def: '正在匹配片源' },
  { k: 'matchSub', label: '匹配片源 · 副标题', def: '该片来自榜单库，正在上游检索…' },
  { k: 'badgeInit', label: '徽章 · 初始（无会员等级时）', def: '线路识别中' },
  { k: 'badgeOfficial', label: '徽章 · 官方线路', def: '官方线路' },
  { k: 'badgeCollect', label: '徽章 · 采集线路', def: '采集线路' }
];
function fillMiscForm(m) {
  const box = $('#miscBox'); if (!box) return;
  const t = (m && m.text) || {};
  box.innerHTML =
    '<div style="width:100%;color:var(--cyan);font-size:13px;margin:16px 0 8px">播放器加载等待框文案（%s 会被替换成数字）</div>'
    + '<div style="display:grid;grid-template-columns:1fr 1fr;gap:12px 16px;width:100%">'
    + PT_FIELDS.map(f => `<div><label>${esc(f.label)}</label><input data-pt="${f.k}" placeholder="${esc(f.def)}" value="${esc(t[f.k] || '')}"></div>`).join('')
    + '</div>';
  if ($('#miscRotMs')) $('#miscRotMs').value = (m && m.rotMs) || 10;
}
if ($('#miscSave')) $('#miscSave').onclick = async () => {
  const box = $('#miscBox');
  const text = {};
  box.querySelectorAll('input[data-pt]').forEach(i => { text[i.dataset.pt] = i.value || ''; });
  const rotMs = Math.min(120, Math.max(3, parseInt($('#miscRotMs').value, 10) || 10));
  const r = await api('/api/admin/config', { method: 'POST', body: { misc: { rotMs, text } } });
  if (r.error) { $('#miscStat').textContent = '❌ ' + r.error; return; }
  $('#miscStat').textContent = '✅ 已保存（刷新播放页生效）';
  toast('其他设置已保存');
  setTimeout(() => { $('#miscStat').textContent = ''; }, 3000);
};
if ($('#miscReset')) $('#miscReset').onclick = async () => {
  const box = $('#miscBox');
  const text = {};
  box.querySelectorAll('input[data-pt]').forEach(i => { i.value = ''; text[i.dataset.pt] = ''; });
  $('#miscRotMs').value = 10;
  const r = await api('/api/admin/config', { method: 'POST', body: { misc: { rotMs: 10, text } } });
  if (r.error) { $('#miscStat').textContent = '❌ ' + r.error; return; }
  $('#miscStat').textContent = '✅ 已恢复默认文案';
  toast('已恢复默认文案');
  setTimeout(() => { $('#miscStat').textContent = ''; }, 3000);
};

/* ================= v63：授权管理 =================
   非对称签发：公钥随代码分发，私钥只存在站长自己这份 config.json 里 → 拿到源码也签不出授权码。
   一个实例一个码（授权码绑定机器码），可签永久或 N 天。
   v63d：台账（停用/改时长/删除/状态）+ 前台联系方式 + 非签发方隐藏签发功能。 */
let LIC = null;
/* 复制：navigator.clipboard 只在 https / localhost 下存在，http://192.168.x.x 直连访问时
   根本没有这个对象 → 必须回落 execCommand（v63d 修「复制一机一码失败」） */
async function copyText(t, btn, okTxt) {
  let ok = false;
  try { if (navigator.clipboard && navigator.clipboard.writeText) { await navigator.clipboard.writeText(t); ok = true; } } catch (e) {}
  if (!ok) {
    try {
      const ta = document.createElement('textarea');
      ta.value = t; ta.setAttribute('readonly', '');
      ta.style.cssText = 'position:fixed;top:-1000px;opacity:0';
      document.body.appendChild(ta);
      ta.select(); ta.setSelectionRange(0, t.length);
      ok = document.execCommand('copy');
      ta.remove();
    } catch (e) { ok = false; }
  }
  if (btn) {
    const old = btn.dataset.txt || btn.textContent;
    btn.dataset.txt = old;
    btn.textContent = ok ? (okTxt || '已复制') : '请手动复制';
    setTimeout(() => { btn.textContent = old; }, 1600);
  }
  if (!ok) toast('复制失败，请手动选中复制');
  return ok;
}
const LIC_STATE_STYLE = {
  used:     ['#7ee0a8', 'rgba(126,224,168,.16)'],
  new:      ['#66d1ff', 'rgba(102,209,255,.14)'],
  locked:   ['#ff6b8a', 'rgba(255,107,138,.16)'],
  replaced: ['#c9a2ff', 'rgba(198,155,255,.16)'],
  expired:  ['#ffd166', 'rgba(255,209,102,.16)']
};
/* v63e：台账默认只显示前 5 条，多的折进「显示更多」（签发多了不至于拉一大屏） */
const LIC_FOLD = 5;
let LIC_ALL = false;
function renderIssued(list) {
  const tb = document.querySelector('#licTable tbody');
  if (!tb) return;
  const more = document.getElementById('licMore');
  if (!list || !list.length) {
    tb.innerHTML = '<tr><td colspan="7" style="color:var(--muted);font-size:12.5px">还没有签发过授权码（在本页③签发后自动入账）</td></tr>';
    if (more) more.innerHTML = '';
    return;
  }
  const show = LIC_ALL ? list : list.slice(0, LIC_FOLD);
  if (more) {
    if (list.length > LIC_FOLD) {
      more.innerHTML = '<button class="btn" id="licMoreBtn">' + (LIC_ALL ? '收起 ▴' : ('显示更多（共 ' + list.length + ' 条，已显示 ' + LIC_FOLD + ' 条）▾')) + '</button>';
      const b = document.getElementById('licMoreBtn');
      if (b) b.onclick = () => { LIC_ALL = !LIC_ALL; renderIssued(list); };
    } else { more.innerHTML = ''; }
  }
  tb.innerHTML = show.map(r => {
    const st = r.state || { k: 'new', txt: '未使用' };
    const c = LIC_STATE_STYLE[st.k] || ['var(--txt)', 'transparent'];
    const cur = r.isCurrent ? ' <span style="color:#ffd166;font-size:11px">· 本站正在用</span>' : '';
    const ops = [
      r.code ? '<a data-act="copy" data-id="' + r.id + '">复制码</a>' : '<span style="color:var(--muted)">码已使用</span>',
      st.k === 'locked' ? '<a data-act="unlock" data-id="' + r.id + '">恢复</a>' : (r.isCurrent ? '' : '<a data-act="lock" data-id="' + r.id + '">停用</a>'),
      '<a data-act="regen" data-id="' + r.id + '">改时长</a>',
      r.isCurrent ? '' : '<a data-act="del" data-id="' + r.id + '" style="color:#ff6b8a">删除</a>'
    ].filter(Boolean).join(' · ');
    return '<tr data-id="' + esc(r.id) + '">'
      + '<td><code style="color:var(--cyan);font-size:12px">' + esc(r.midFmt || r.mid) + '</code>' + cur + '</td>'
      + '<td>' + esc(r.expText || '永久') + '</td>'
      + '<td><span style="padding:2px 9px;border-radius:20px;font-size:11px;color:' + c[0] + ';background:' + c[1] + '">' + esc(st.txt) + '</span></td>'
      + '<td style="font-size:12px;color:var(--muted)">' + esc(r.createdText || '') + '</td>'
      + '<td style="font-size:12px;color:var(--muted)">' + esc(r.activatedText || '—') + '</td>'
      + '<td style="font-size:12px;color:var(--muted)">' + esc(r.note || '') + (r.replacedBy ? ' <span style="color:#c9a2ff">→已换发</span>' : '') + '</td>'
      + '<td style="font-size:12px">' + ops + '</td></tr>';
  }).join('');
  tb.querySelectorAll('a[data-act]').forEach(a => {
    a.style.cursor = 'pointer';
    a.onclick = () => licRowAct(a.dataset.act, a.dataset.id, a);
  });
}
async function licRowAct(act, id, el) {
  const rows = ((LIC && LIC.issued) || []);
  const r = rows.find(x => x && x.id === id) || {};
  try {
    if (act === 'copy') {
      if (!r.code) { toast('该码已被激活过，出于安全不再下发原文'); return; }
      await copyText(r.code, el, '已复制');
      return;
    }
    if (act === 'lock') {
      if (!confirm('停用后，对方「还没激活」的实例将激活失败。\n已激活的实例是离线校验，无法远程关停。\n\n确定停用 ' + (r.midFmt || r.mid) + ' 这个码？')) return;
      const j = await api('/api/admin/license', { method: 'POST', body: { action: 'lock', id, on: true } });
      if (j.error) { toast('❌ ' + j.error); return; }
      toast('已停用'); await loadLicense(); return;
    }
    if (act === 'unlock') {
      const j = await api('/api/admin/license', { method: 'POST', body: { action: 'lock', id, on: false } });
      if (j.error) { toast('❌ ' + j.error); return; }
      toast('已恢复'); await loadLicense(); return;
    }
    if (act === 'regen') {
      /* v73d：授权一律永久 —— 换发同样是永久码 */
      if (!confirm('给 ' + (r.midFmt || r.mid) + ' 换发一个新码？\n\n新码为永久有效，旧码自动标记「已换发」并失效。')) return;
      const j = await api('/api/admin/license', { method: 'POST', body: { action: 'regen', id, days: 0 } });
      if (j.error) { toast('❌ ' + j.error); return; }
      $('#licNewCode').value = j.code;
      $('#licNewTip').textContent = '✅ 已为 ' + (j.midFmt || '') + ' 换发新码（' + (j.expText || '永久') + '），旧码已失效，请把新码发给对方';
      $('#licNewOut').classList.remove('hidden');
      toast('已换发新码'); await loadLicense(); return;
    }
    if (act === 'del') {
      if (!confirm('从台账删除 ' + (r.midFmt || r.mid) + ' 这条记录？\n（只删记录，不影响对方已激活的实例）')) return;
      const j = await api('/api/admin/license', { method: 'POST', body: { action: 'del', id } });
      if (j.error) { toast('❌ ' + j.error); return; }
      toast('已删除'); await loadLicense(); return;
    }
  } catch (e) { toast('❌ 网络错误'); }
}
async function loadLicense() {
  try {
    const r = await api('/api/admin/license');
    LIC = r;
    const i = r.info || {};
    $('#licMid').textContent = i.machineIdFmt || i.machineId || '—';
    const st = $('#licState');
    if (i.active) {
      st.innerHTML = '<b style="color:#7ee0a8">✅ 已激活</b>　有效期：<b>' + esc(i.expText || '永久有效') + '</b>'
        + (i.at ? '　激活时间：' + new Date(i.at + 8 * 3600e3).toISOString().slice(0, 16).replace('T', ' ') : '');
      st.style.borderColor = 'rgba(126,224,168,.45)';
    } else {
      st.innerHTML = '<b style="color:#ff6b8a">⚠️ 未激活</b>　' + esc(i.reason || '本站尚未激活，除本页外所有功能不可用')
        + '　—　把上面的机器码发给站长换授权码。';
      st.style.borderColor = 'rgba(255,107,138,.45)';
    }
    /* v63d：不是签发方（没有私钥）就不给看签发/台账/私钥/联系方式，避免别人误以为自己能发码 */
    const can = !!r.canSign;
    ['licIssuedBox', 'licGenBox', 'licKeyBox', 'licContactBox'].forEach(id => {
      const e = document.getElementById(id); if (e) e.classList.toggle('hidden', !can);
    });
    const tip = document.getElementById('licNoSignTip');
    if (tip) tip.classList.toggle('hidden', can);
    if (can) {
      renderIssued(r.issued || []);
      if ($('#licContact')) $('#licContact').value = r.contact || '';
      if ($('#licSiteUrl')) $('#licSiteUrl').value = r.siteUrl || '';
    }
    $('#licKeyTip').textContent = can
      ? ('已配置签发私钥（…' + esc(r.privKeyTail || '') + '），可以给别人的机器码签发授权码。')
      : '当前没有签发私钥，无法生成授权码。私钥只保存在站长自己的站点配置里，公开仓库版本没有。';
  } catch (e) {}
}
if ($('#licCopy')) $('#licCopy').onclick = () => copyText($('#licMid').textContent.trim(), $('#licCopy'), '已复制');
if ($('#licNewCopy')) $('#licNewCopy').onclick = () => copyText($('#licNewCode').value, $('#licNewCopy'), '已复制');
if ($('#licActivate')) $('#licActivate').onclick = async () => {
  const code = ($('#licCode').value || '').trim();
  if (!code) { $('#licStat').textContent = '❌ 请先粘贴授权码'; return; }
  $('#licStat').textContent = '激活中…';
  try {
    const r = await api('/api/admin/license', { method: 'POST', body: { action: 'activate', code } });
    if (r.error) { $('#licStat').textContent = '❌ ' + r.error; return; }
    $('#licStat').textContent = '✅ 激活成功';
    $('#licCode').value = '';
    /* v63c：激活前所有接口都是 402，其余面板根本没拉到数据 —— 激活成功后必须把整页数据补拉一遍，
       否则用户还得手动刷新才能继续配置 */
    _licBlocked = false;
    await loadLicense();
    await loadAll().catch(() => {});
    toast('站点已激活');
  } catch (e) { $('#licStat').textContent = '❌ 网络错误'; }
};
if ($('#licClear')) $('#licClear').onclick = async () => {
  /* v63b：这是会把全站锁死的危险按钮，光 confirm 一下太容易误点 —— 必须手动输入「解除」两个字 */
  const word = prompt('⚠️ 解除激活后，除本页外全站所有功能立即不可用！\n\n如确认要解除，请在下面输入「解除」两个字：', '');
  if (word === null) return;
  if (word.trim() !== '解除') { $('#licStat').textContent = '❌ 没输入「解除」，已取消'; return; }
  try {
    await api('/api/admin/license', { method: 'POST', body: { action: 'clear' } });
    $('#licStat').textContent = '已解除激活';
    await loadLicense();
  } catch (e) {}
};
if ($('#licGen')) $('#licGen').onclick = async () => {
  const mid = ($('#licGenMid').value || '').trim().toUpperCase().replace(/[^0-9A-F]/g, '');
  if (mid.length !== 16) { $('#licGenStat').textContent = '❌ 机器码必须是 16 位'; return; }
  $('#licGenStat').textContent = '签发中…';
  try {
    /* v73d：授权一律永久，不再提供期限选项（服务端也会强制按永久签发） */
    const r = await api('/api/admin/license/gen', { method: 'POST', body: { machineId: mid, days: 0 } });
    if (r.error) { $('#licGenStat').textContent = '❌ ' + r.error; $('#licGenOut').classList.add('hidden'); return; }
    $('#licGenCode').value = r.code;
    $('#licGenOut').classList.remove('hidden');
    $('#licGenStat').textContent = '✅ 已生成（' + (r.expText || '永久') + '）';
    await loadLicense();   /* 入账后立刻刷新台账 */
  } catch (e) { $('#licGenStat').textContent = '❌ 网络错误'; }
};
if ($('#licGenCopy')) $('#licGenCopy').onclick = () => copyText($('#licGenCode').value, $('#licGenCopy'), '已复制');
if ($('#licKeySave')) $('#licKeySave').onclick = async () => {
  const pk = ($('#licKey').value || '').trim();
  if (!pk) { toast('请先粘贴私钥'); return; }
  try {
    const r = await api('/api/admin/license', { method: 'POST', body: { action: 'setkey', privateKey: pk } });
    if (r.error) { toast('❌ ' + r.error); return; }
    $('#licKey').value = '';
    toast('私钥已保存（请自行备份，丢了就签不出新码）');
    await loadLicense();
  } catch (e) { toast('❌ 网络错误'); }
};
if ($('#licContactSave')) $('#licContactSave').onclick = async () => {
  try {
    const r = await api('/api/admin/license', { method: 'POST', body: { action: 'contact', contact: ($('#licContact').value || '') } });
    if (r.error) { $('#licContactStat').textContent = '❌ ' + r.error; return; }
    $('#licContactStat').textContent = '✅ 已保存（新签/换发的码会带上它，显示在别人站点的激活页上）';
    setTimeout(() => { $('#licContactStat').textContent = ''; }, 4000);
  } catch (e) { $('#licContactStat').textContent = '❌ 网络错误'; }
};
/* v73f：站点地址（激活回执上报） */
if ($('#licSiteUrlSave')) $('#licSiteUrlSave').onclick = async () => {
  try {
    const r = await api('/api/admin/license', { method: 'POST', body: { action: 'siteurl', siteUrl: ($('#licSiteUrl').value || '') } });
    if (r.error) { $('#licSiteUrlStat').textContent = '❌ ' + r.error; return; }
    $('#licSiteUrlStat').textContent = '✅ 已保存（新签/换发的码带上它；对方激活的瞬间你的台账就会记下激活时间）';
    setTimeout(() => { $('#licSiteUrlStat').textContent = ''; }, 4000);
  } catch (e) { $('#licSiteUrlStat').textContent = '❌ 网络错误'; }
};
/* 未激活时空壳站大部分接口返回 402 → 后台给一条明确提示，别让人以为后台坏了 */
let _licBlocked = false;
function showLicBlock() {
  if (_licBlocked) return;
  _licBlocked = true;
  const d = document.createElement('div');
  d.style.cssText = 'position:fixed;inset:0;z-index:999;display:grid;place-items:center;background:rgba(4,6,12,.86);backdrop-filter:blur(3px)';
  d.innerHTML = '<div style="width:420px;max-width:90vw;padding:26px 24px;border-radius:16px;background:var(--panel);border:1px solid var(--line);text-align:center">'
    + '<div style="font-size:20px;font-weight:700;margin-bottom:8px">站点未授权</div>'
    + '<div style="color:var(--muted);font-size:13px;line-height:1.8">本实例还没有激活，除「授权管理」外所有功能不可用。<br>请在「授权管理」里填入授权码后重试。</div>'
    + '<button class="btn primary" id="licBlockGo" style="margin-top:16px;width:100%">前往激活页</button>'
    + '</div>';
  document.body.appendChild(d);
  const go = document.getElementById('licBlockGo');
  if (go) go.onclick = () => { location.href = '/activate.html'; };
}

/* ---------- 栏目权限（每用户可访问栏目细化控制） ---------- */
const VIEW_KEYS = ['rec', 'movie', 'series', 'anime', 'variety', 'short', 'iptv', 'history', 'fav', 'skipIntro', 'skipOutro'];
const VIEW_LABELS = { rec: '🔥 推荐', movie: '🎬 电影', series: '📺 剧集', anime: '🐣 动漫', variety: '🎤 综艺', short: '🎭 短剧', iptv: '📡 IPTV', history: '🕘 历史记录', fav: '⭐ 我的收藏', skipIntro: '⏭ 跳过片头', skipOutro: '⏭ 跳过片尾' };
/* 表格「访问权限」列用的短名（去掉 emoji，避免两个 ⏭ 分不清） */
const VIEW_SHORT = { rec: '推荐', movie: '电影', series: '剧集', anime: '动漫', variety: '综艺', short: '短剧', iptv: 'IPTV', history: '历史', fav: '收藏', skipIntro: '跳片头', skipOutro: '跳片尾' };
let permTarget = '';
function openPermModal(username) {
  permTarget = username;
  const vp = ((CFG.viewPerm && CFG.viewPerm.users) || {})[username] || {};
  $('#permUser').textContent = username;
  const box = $('#permBoxes'); box.innerHTML = '';
  VIEW_KEYS.forEach(k => {
    const lab = document.createElement('label'); lab.className = 'pv';
    /* 未配置的栏目默认允许 → 勾上 */
    lab.innerHTML = `<input type="checkbox" data-pk="${k}" ${vp[k] !== false ? 'checked' : ''}> ${VIEW_LABELS[k]}`;
    box.appendChild(lab);
  });
  $('#permModal').style.display = 'grid';
}
$('#permAll').onclick = () => { document.querySelectorAll('#permBoxes input').forEach(i => i.checked = true); };
$('#permSave').onclick = async () => {
  const map = {};
  document.querySelectorAll('#permBoxes input').forEach(i => { map[i.dataset.pk] = i.checked; });
  const m = Object.assign({}, (CFG.viewPerm && CFG.viewPerm.users) || {});
  m[permTarget] = map;
  const r = await api('/api/admin/config', { method: 'POST', body: { viewPerm: { users: m } } });
  if (r.error) return toast('❌ ' + (r.error || '保存失败'));
  if (r.config) CFG.viewPerm = r.config.viewPerm;
  $('#permModal').style.display = 'none';
  toast('已保存 ' + permTarget + ' 的栏目权限');
  loadAll();
};
/* 点弹窗空白处关闭 */
$('#permModal').addEventListener('click', e => { if (e.target.id === 'permModal') $('#permModal').style.display = 'none'; });

/* ---------- 注册开关 + 新用户默认访问权限 ---------- */
const REG_DEF_PERM_UI = { rec: true, movie: true, series: true, anime: true, variety: true, short: true, iptv: false, history: true, fav: true, skipIntro: false, skipOutro: false };
/* 会员特权键（跳过片头/片尾）：服务端「缺省=关」，界面必须同语义，不能显示成已勾选 */
const PRIV_KEYS = ['skipIntro', 'skipOutro'];
const permOn = (dp, k) => (PRIV_KEYS.indexOf(k) >= 0 ? dp[k] === true : dp[k] !== false);
/* v46c：未保存修改保护——只要动过勾选框，任何 loadAll/重绘都不得覆盖（否则点「添加用户」等
   触发重绘时，未保存的取消勾选会被服务器旧值静默抹平，再点保存就变成「全勾」） */
let regDirty = false;
/* 状态行：直接告诉你「当前已保存的是什么」+「是否有未保存修改」，避免误以为保存了其实没保存 */
function updateRegStatus() {
  const el = $('#regStat'); if (!el) return;
  const dp = (CFG.reg && CFG.reg.defaultPerm) || {};
  const off = VIEW_KEYS.filter(k => (PRIV_KEYS.indexOf(k) >= 0 ? dp[k] === true : dp[k] !== false) === false).map(k => (VIEW_SHORT[k] || k));
  el.innerHTML = (regDirty ? '<b style="color:#ffb454">● 有未保存的修改（点「保存注册设置」生效）</b>' : '<b style="color:#4ade80">✓ 已保存</b>')
    + '<span style="color:var(--muted)"> · 当前模板关闭：' + (off.length ? off.join('、') : '（无，全部开放）') + '</span>';
}
function renderRegPerm(force) {
  const box = $('#regPermBoxes'); if (!box) return;
  if (regDirty && !force) return;
  /* 防御：只认 11 个已知权限键的布尔值，任何被别处对象污染的可能都排除 */
  const raw = (CFG.reg && CFG.reg.defaultPerm) || {};
  const dp = Object.assign({}, REG_DEF_PERM_UI);
  VIEW_KEYS.forEach(k => { if (typeof raw[k] === 'boolean') dp[k] = raw[k]; });
  box.innerHTML = '';
  VIEW_KEYS.forEach(k => {
    const lab = document.createElement('label');
    lab.className = 'pv';
    lab.innerHTML = `<input type="checkbox" data-rk="${k}" ${permOn(dp, k) ? 'checked' : ''}> ${VIEW_LABELS[k] || k}`;
    lab.querySelector('input').addEventListener('change', () => { regDirty = true; updateRegStatus(); });
    box.appendChild(lab);
  });
  updateRegStatus();
}
function collectRegPerm() {
  const boxes = document.querySelectorAll('#regPermBoxes input[data-rk]');
  /* 复选框还没渲染出来时绝不能不提交空对象（服务端会把缺失键当成 true → 冲掉已取消的勾选） */
  if (!boxes.length) return Object.assign({}, (CFG.reg && CFG.reg.defaultPerm) || REG_DEF_PERM_UI);
  const m = {};
  boxes.forEach(i => { m[i.dataset.rk] = !!i.checked; });
  return m;
}
$('#regSave').onclick = async () => {
  const want = collectRegPerm();
  const wantKeys = Object.keys(want);
  const r = await api('/api/admin/config', { method: 'POST', body: { reg: { enabled: $('#regEn').checked, defaultPerm: want } } });
  if (r.error) return toast('❌ ' + (r.error || '保存失败'));
  /* 保存后不信任本地状态，重新向服务端取一次权威配置再渲染（避免任何缓存/时序问题造成「看起来复原」） */
  try {
    const c = await api('/api/admin/config');
    const cfg = c.config || c;
    if (cfg) { CFG = cfg; $('#regEn').checked = !!(CFG.reg && CFG.reg.enabled); }
  } catch (e) { if (r.config) CFG.reg = r.config.reg; }
  renderRegPerm();   /* 脏标记时为 no-op：不许在保存确认前重绘抹掉用户修改 */
  /* 校验：服务端返回的和勾选的一致才算真保存成功 */
  const got = (CFG.reg && CFG.reg.defaultPerm) || {};
  const bad = wantKeys.filter(k => (PRIV_KEYS.indexOf(k) >= 0 ? got[k] === true : got[k] !== false) !== !!want[k]);
  if (bad.length) {
    toast('⚠️ 服务端回读不一致：' + bad.map(k => (VIEW_SHORT[k] || k)).join('/') + '，请刷新后再试');
    return;
  }
  const off = VIEW_KEYS.filter(k => (PRIV_KEYS.indexOf(k) >= 0 ? got[k] === true : got[k] !== false) === false).map(k => (VIEW_SHORT[k] || k));
  regDirty = false;   /* 保存确认成功才解除脏标记 */
  renderRegPerm(true);
  toast('✅ 注册设置已保存' + (off.length ? '（已关闭：' + off.join('/') + '）' : '（全部栏目开放）') + '。已有用户不受影响，需要时点「应用到现有普通用户」');
};
/* v46：把当前模板一键应用到全部现有普通用户 */
$('#regApply').onclick = async () => {
  if (!confirm('确定把当前「新用户默认访问权限」覆盖到全部普通用户吗？管理员不受影响，各用户单独调过的权限会被覆盖。')) return;
  const r = await api('/api/admin/reg-apply', { method: 'POST', body: {} });
  if (r.error) return toast('❌ ' + r.error);
  regDirty = false;
  toast('✅ 已把模板应用到 ' + r.applied + ' 个普通用户');
  loadAll();
};

/* ---------- 密码修改：本人 ---------- */
$('#myPwSave').onclick = async () => {
  const oldP = $('#myOld').value, newP = $('#myNew').value, newP2 = $('#myNew2').value;
  if (!oldP || !newP) return toast('请填写完整');
  if (newP.length < 6) return toast('新密码至少 6 位');
  if (newP !== newP2) return toast('两次新密码不一致');
  const r = await api('/api/auth/change-password', { method: 'POST', body: { oldPassword: oldP, newPassword: newP } });
  if (r.error) return toast(r.error);
  toast('密码已修改，请牢记新密码');
  $('#myOld').value = ''; $('#myNew').value = ''; $('#myNew2').value = '';
};

/* ---------- 密码修改：管理员代改 ---------- */
let pwTargetId = '';
function openPwModal(id, name) { pwTargetId = id; $('#pwUser').textContent = name; $('#pwNew').value = ''; $('#pwModal').style.display = 'grid'; }
$('#pwCancel').onclick = () => { $('#pwModal').style.display = 'none'; };
$('#pwModal').addEventListener('click', e => { if (e.target === $('#pwModal')) $('#pwModal').style.display = 'none'; });
$('#pwSave').onclick = async () => {
  const newP = $('#pwNew').value;
  if (!newP || newP.length < 6) return toast('新密码至少 6 位');
  const r = await api('/api/admin/users/password', { method: 'POST', body: { id: pwTargetId, newPassword: newP } });
  if (r.error) return toast(r.error);
  toast('已重置该用户密码'); $('#pwModal').style.display = 'none';
};

/* ---------- 上游官方线路同步 ---------- */
$('#upSync').onclick = async () => {
  $('#upSyncR').textContent = '获取中（上游可能较慢）…';
  const r = await api('/api/admin/parse/sync-upstream', { method: 'POST' });
  if (r.ok) { $('#upSyncR').textContent = '✅ 已获取 ' + ((r.list || []).length) + ' 条并并入解析列表'; toast('上游官方解析已更新'); loadAll(); }
  else { $('#upSyncR').textContent = '❌ ' + (r.error || '失败'); }
};

/* ---------- v34：上游线路自动同步（ticket 轮换自动更新保存） ---------- */
function fmtLastRun(ts) {
  if (!ts) return '从未运行';
  return new Date(ts).toLocaleString('zh-CN', { hour12: false });
}
async function loadUpAutoSync() {
  try {
    const j = await api('/api/admin/up-autosync');
    $('#upAutoEn').checked = !!j.enabled;
    $('#upAutoIv').value = String(j.intervalMin || 60);
    const okTxt = j.lastOk === true ? '✅ ' : j.lastOk === false ? '❌ ' : '';
    $('#upAutoR').textContent = okTxt + '上次运行：' + fmtLastRun(j.lastRun) + (j.lastMsg ? ' · ' + j.lastMsg : '');
  } catch (e) { $('#upAutoR').textContent = '状态获取失败'; }
}
$('#upAutoSave').onclick = async () => {
  $('#upAutoR').textContent = '保存中…';
  const r = await api('/api/admin/up-autosync', { method: 'POST', body: { enabled: $('#upAutoEn').checked, intervalMin: parseInt($('#upAutoIv').value, 10), runNow: true } });
  if (r.ok) {
    const st = r.state || {}, run = r.run || {};
    toast(st.enabled ? '已开启自动同步并完成一次检测' : '已关闭自动同步');
    const okTxt = run.ok === true ? '✅ 检测成功：' : run.ok === false ? '❌ 检测失败：' : '';
    $('#upAutoR').textContent = okTxt + (run.error ? run.error : (run.list ? '已更新 ' + run.list.length + ' 条线路 · ' : '')) + '上次运行：' + fmtLastRun(st.lastRun) + (st.lastMsg ? ' · ' + st.lastMsg : '');
    loadAll();
  } else { $('#upAutoR').textContent = '❌ ' + (r.error || '保存失败'); }
};

/* ---------- v60：上游接入（API 地址 / 密钥 / Cookie / 镜像）+ 连通自检 ---------- */
function fillUpstreamForm(up) {
  const u = up || {};
  $('#upApiBase').value = u.base || '';
  $('#upApiKey').value = u.key || '';
  $('#upApiCookie').value = u.cookie || '';
  $('#upApiMirrors').value = (Array.isArray(u.mirrors) ? u.mirrors : []).join('\n');
  $('#upApiR').textContent = '';
}
function readUpstreamForm() {
  return {
    base: $('#upApiBase').value.trim(),
    key: $('#upApiKey').value.trim(),
    cookie: $('#upApiCookie').value.trim(),
    mirrors: $('#upApiMirrors').value.split(/\r?\n/).map(x => x.trim()).filter(Boolean)
  };
}
function upResultTxt(r) {
  if (r.ok) {
    let s = '✅ 连通（' + (r.ms || 0) + 'ms · 首页 ' + (r.secs || 0) + ' 个栏目 / ' + (r.cards || 0) + ' 张卡片）';
    if (r.base) s += ' → ' + r.base;
    return s;
  }
  const rs = r.results || [];
  const parts = rs.map(x => x.base + '：' + (x.msg || ('HTTP ' + x.status)));
  return '❌ ' + (r.error || (parts.join(' ｜ ') || '全部候选不可达'));
}
$('#upApiSave').onclick = async () => {
  const v = readUpstreamForm();
  if (!v.base) return toast('请填写上游 API 地址');
  $('#upApiR').textContent = '保存中…';
  const r = await api('/api/admin/upstream', { method: 'POST', body: v });
  $('#upApiR').textContent = r.error ? ('❌ ' + r.error) : '✅ 已保存并立即生效（缓存已清空）';
  if (r.error) return;
  toast('上游接入已保存');
  CFG.upstream = Object.assign({}, CFG.upstream || {}, { base: v.base, key: v.key, cookie: v.cookie, mirrors: v.mirrors });
};
$('#upApiTest').onclick = async () => {
  const v = readUpstreamForm();
  if (!v.base) return toast('请填写上游 API 地址');
  $('#upApiR').textContent = '测试中（最久 12 秒）…';
  const r = await api('/api/admin/upstream/test', { method: 'POST', body: v });
  $('#upApiR').textContent = upResultTxt(r);
};

/* ---------- v60：自动获取上游采集地址 + 批量导入 ---------- */
function fillCollectAuto(ca) {
  const c = ca || {};
  $('#cAutoOn').checked = !!c.enabled;
  $('#cAutoR').textContent = c.lastRun ? ('上次运行：' + new Date(c.lastRun).toLocaleString('zh-CN', { hour12: false }) + (c.lastMsg ? ' · ' + c.lastMsg : '')) : '';
}
$('#cAutoUp').onclick = async () => {
  if (!confirm('将用当前「上游接入」配置去上游拉采集档线路，并逐个真实连通测试后自动保存。\n\n探测 100+ 个候选地址约需 10~40 秒，期间请勿关闭页面。继续？')) return;
  $('#cAutoR').textContent = '① 正在向要上游拉采集档线路…';
  $('#cAutoUp').disabled = true;
  const r = await api('/api/admin/collect/auto', { method: 'POST', body: {} });
  $('#cAutoUp').disabled = false;
  if (r.error) { $('#cAutoR').textContent = '❌ ' + r.error; toast('❌ ' + r.error); return; }
  const added = r.added || [];
  let s = '';
  if (added.length) s = '✅ 新增 ' + added.length + ' 个采集站：' + added.map(a => a.name).join('、');
  else s = '⚠️ 探测了 ' + (r.tested || 0) + ' 个候选，没有一个返回标准苹果CMS 数据';
  if ((r.skipped || []).length) s += '（其中 ' + r.skipped.length + ' 个你早就加过，跳过）';
  if (r.note) s += '　' + r.note;
  $('#cAutoR').textContent = s;
  toast(added.length ? ('已自动保存 ' + added.length + ' 个采集站') : '本次没有可用的采集地址');
  if (added.length) loadAll();
  else {
    const bad = (r.failed || []).slice(0, 8).map(f => '· ' + f.name + '（' + (f.why || '不可达') + '）').join('\n');
    if (bad) alert('本次未通过连通测试的资源（前 8 条）：\n\n' + bad + '\n\n说明：上游只给出「播放 CDN 地址」，不给采集站 API，两者是不同体系，所以从上游域名直接反推成功率很低。\n日常补站请用下面的「批量导入」粘贴采集地址。');
  }
};
$('#cAutoSave').onclick = async () => {
  const r = await api('/api/admin/collect/auto', { method: 'POST', body: { setAuto: true, enabled: $('#cAutoOn').checked } });
  if (r.error) return toast('❌ ' + r.error);
  $('#cAutoR').textContent = '✅ ' + ($('#cAutoOn').checked ? '已开启每天自动获取' : '已关闭自动获取');
  toast($('#cAutoOn').checked ? '已开启每天自动获取' : '已关闭自动获取');
};
$('#cImportGo').onclick = async () => {
  const text = $('#cImport').value;
  if (!text.trim()) return toast('请先粘贴采集地址');
  $('#cImportR').textContent = '逐条连通测试中…';
  $('#cImportGo').disabled = true;
  const r = await api('/api/admin/collect/import', { method: 'POST', body: { text } });
  $('#cImportGo').disabled = false;
  if (r.error) { $('#cImportR').textContent = '❌ ' + r.error; return; }
  const ok = r.added || [], bad = r.failed || [], skip = r.skipped || [];
  let s = '✅ 通过 ' + ok.length + ' 条已保存';
  if (skip.length) s += '　⏭ ' + skip.length + ' 条已存在跳过';
  if (bad.length) s += '　❌ ' + bad.length + ' 条未通过：' + bad.slice(0, 3).map(f => f.api.slice(0, 28) + '（' + f.why + '）').join('、');
  $('#cImportR').textContent = s;
  $('#cImport').value = bad.length ? bad.map(f => f.api).join('\n') : '';
  toast(ok.length ? ('已保存 ' + ok.length + ' 个采集站') : (skip.length ? '这些地址早就存在了' : '没有通过测试的采集地址'));
  loadAll();
};

/* ---------- 系统日志 ---------- */
let logTimer = null;
async function loadLogs() {
  try {
    const level = $('#logLevel').value, q = $('#logQ').value.trim();
    const j = await api('/api/admin/logs?level=' + encodeURIComponent(level) + '&q=' + encodeURIComponent(q) + '&limit=400');
    $('#logTotal').textContent = '内存共 ' + (j.total || 0) + ' 条，当前显示 ' + ((j.list || []).length) + ' 条';
    const box = $('#logBox');
    if (!(j.list || []).length) { box.innerHTML = '<div style="padding:24px;text-align:center;color:var(--muted)">暂无日志</div>'; return; }
    box.innerHTML = j.list.map(e => {
      const ts = new Date(e.t).toLocaleString('zh-CN', { hour12: false });
      const lc = e.l === 'error' ? '#ff6b8a' : e.l === 'warn' ? '#ffb84d' : '#00e5ff';
      return `<div style="padding:5px 4px;border-bottom:1px dashed rgba(120,180,255,.1)">` +
        `<span style="color:var(--muted)">[${ts}]</span> ` +
        `<span style="color:${lc};font-weight:700">[${(e.l || 'info').toUpperCase()}]</span> ` +
        `<span style="color:#b16bff">[${esc(e.g || 'sys')}]</span> ` +
        `<span>${esc(e.m || '')}</span>` +
        (e.x ? `<span style="color:var(--muted)"> ｜ ${esc(e.x)}</span>` : '') +
        `</div>`;
    }).join('');
  } catch (e) { $('#logTotal').textContent = '日志加载失败'; }
}
$('#logRefresh').onclick = loadLogs;
$('#logLevel').onchange = loadLogs;
$('#logQ').addEventListener('keydown', e => { if (e.key === 'Enter') loadLogs(); });
$('#logClear').onclick = async () => { if (!confirm('确认清空全部日志？')) return; await api('/api/admin/logs', { method: 'DELETE' }); toast('日志已清空'); loadLogs(); };
$('#logAuto').onchange = () => {
  if (logTimer) { clearInterval(logTimer); logTimer = null; }
  if ($('#logAuto').checked) logTimer = setInterval(() => { if ($('#p-logs').classList.contains('active')) loadLogs(); }, 5000);
};

/* ---------- 首页栏目管理 ---------- */
async function populateColKey() {
  const t = $('#colType').value;
  const sel = $('#colKey'); sel.innerHTML = '';
  if (t === 'tmdb') {
    for (const k in COLS_LABELS) sel.appendChild(new Option(COLS_LABELS[k], k));
  } else {
    const c = (await api('/api/admin/collect')).list || [];
    if (!c.length) sel.innerHTML = '<option value="">（请先在「采集站」添加）</option>';
    c.forEach(x => sel.appendChild(new Option(x.name, x.id)));
  }
}
function renderColList() {
  const box = $('#colList'); box.innerHTML = '';
  if (!ColConfig.length) { box.innerHTML = '<div class="empty" style="padding:10px">暂无栏目，请在下方添加</div>'; return; }
  ColConfig.forEach((c, i) => {
    const d = document.createElement('div');
    const name = c.type === 'collect'
      ? ('采集站 · ' + (c.label || c.stationId))
      : ('TMDB · ' + (c.label || COLS_LABELS[c.key] || c.key));
    d.style.cssText = 'display:flex;align-items:center;gap:10px;padding:10px 12px;background:rgba(5,6,10,.5);border:1px solid var(--line);border-radius:10px';
    d.innerHTML = `<span style="flex:1">${i + 1}. ${name}</span>
      <button class="btn" data-act="up" ${i === 0 ? 'disabled' : ''}>↑</button>
      <button class="btn" data-act="down" ${i === ColConfig.length - 1 ? 'disabled' : ''}>↓</button>
      <button class="btn" data-act="del">删除</button>`;
    d.querySelector('[data-act=up]').onclick = () => { if (i > 0) { [ColConfig[i - 1], ColConfig[i]] = [ColConfig[i], ColConfig[i - 1]]; renderColList(); } };
    d.querySelector('[data-act=down]').onclick = () => { if (i < ColConfig.length - 1) { [ColConfig[i + 1], ColConfig[i]] = [ColConfig[i], ColConfig[i + 1]]; renderColList(); } };
    d.querySelector('[data-act=del]').onclick = () => { ColConfig.splice(i, 1); renderColList(); };
    box.appendChild(d);
  });
}

/* ---------- 广告联盟（后台） ---------- */
let AD_ITEMS = [];
function renderAdItems() {
  const tb = $('#adItemsTable tbody'); if (!tb) return; tb.innerHTML = '';
  if (!AD_ITEMS.length) { tb.innerHTML = '<tr><td colspan="7" style="color:var(--muted);font-size:13px">暂无广告条目，请在下方添加</td></tr>'; return; }
  AD_ITEMS.forEach((it, i) => {
    const tr = document.createElement('tr');
    const slots = (it.slots || []).map(s => s === 'pause' ? '暂停' : '左侧').join('、') || '—';
    tr.innerHTML = `<td>${esc(it.title)}</td><td style="max-width:170px;word-break:break-all;color:var(--muted);font-size:11px">${esc(it.img)}</td><td style="max-width:140px;word-break:break-all;color:var(--muted);font-size:11px">${esc(it.link)}</td><td>${slots}</td><td>${it.weight}</td><td>${it.enabled !== false ? '<span class="tag">启用</span>' : '<span style="color:var(--muted)">停用</span>'}</td><td><div style="display:flex;gap:6px"><button class="btn" data-tog="${i}">${it.enabled !== false ? '停用' : '启用'}</button><button class="btn danger" data-del="${i}">删除</button></div></td>`;
    tr.querySelector('[data-tog]').onclick = () => { AD_ITEMS[i].enabled = !(AD_ITEMS[i].enabled !== false); renderAdItems(); };
    tr.querySelector('[data-del]').onclick = () => { AD_ITEMS.splice(i, 1); renderAdItems(); };
    tb.appendChild(tr);
  });
}
$('#adItemAdd').onclick = () => {
  const img = $('#adItemImg').value.trim();
  if (!img) return toast('请填写图片地址');
  if (!/^https?:\/\//i.test(img)) return toast('图片地址需以 http:// 或 https:// 开头');
  const slots = [];
  if ($('#adItemSlotSide').checked) slots.push('sidebar');
  if ($('#adItemSlotPause').checked) slots.push('pause');
  if (!slots.length) return toast('请至少勾选一个投放位置');
  AD_ITEMS.push({ id: 'ad_' + Date.now().toString(36), title: $('#adItemTitle').value.trim() || '广告', img, link: $('#adItemLink').value.trim(), slots, weight: Math.max(1, Math.min(99, Number($('#adItemWeight').value) || 1)), enabled: true });
  $('#adItemTitle').value = ''; $('#adItemImg').value = ''; $('#adItemLink').value = '';
  $('#adItemSlotSide').checked = false; $('#adItemSlotPause').checked = false; $('#adItemWeight').value = '1';
  renderAdItems(); toast('已加入列表（记得点下方「保存广告联盟配置」）');
};
function fillAdsForm(A) {
  A = A || {};
  $('#adEn2').checked = !!A.enabled;
  $('#adNetwork').value = A.network === 'code' ? 'code' : 'custom';
  const pa = A.pause || {};
  $('#adPauseEn').checked = !!pa.enabled;
  $('#adPauseDelay').value = pa.delay != null ? pa.delay : 800;
  $('#adPauseClose').checked = pa.closeable !== false;
  $('#adPauseAuto').value = pa.autoClose || 0;
  const sb = A.sidebar || {};
  $('#adSideEn').checked = !!sb.enabled;
  $('#adSidePos').value = sb.position || 'belowDetail';
  $('#adSideW').value = sb.width || '100%';
  $('#adSideH').value = sb.height || 'auto';
  $('#adSideMax').value = sb.max || 2;
  AD_ITEMS = (A.items || []).map(x => Object.assign({}, x));
  renderAdItems();
  $('#adCodeSide').value = (A.code || {}).sidebar || '';
  $('#adCodePause').value = (A.code || {}).pause || '';
}
$('#adSaveBtn').onclick = async () => {
  const r = await api('/api/admin/ads', { method: 'POST', body: { ads: {
    enabled: $('#adEn2').checked, network: $('#adNetwork').value, items: AD_ITEMS,
    code: { sidebar: $('#adCodeSide').value, pause: $('#adCodePause').value },
    pause: { enabled: $('#adPauseEn').checked, delay: Number($('#adPauseDelay').value) || 0, closeable: $('#adPauseClose').checked, autoClose: Number($('#adPauseAuto').value) || 0 },
    sidebar: { enabled: $('#adSideEn').checked, position: $('#adSidePos').value, width: $('#adSideW').value.trim() || '100%', height: $('#adSideH').value.trim() || 'auto', max: Number($('#adSideMax').value) || 2 }
  } } });
  if (r.error) return toast('❌ ' + r.error);
  $('#adSaveR').textContent = '已保存 ' + new Date().toLocaleTimeString();
  toast('广告联盟配置已保存'); loadAll();
};

/* ---------- 积分 / 会员（后台） ---------- */
let VIP_LEVELS = [];
function renderVipLevels() {
  const tb = $('#vipTable tbody'); if (!tb) return; tb.innerHTML = '';
  VIP_LEVELS.slice().sort((a, b) => a.level - b.level).forEach(l => {
    const tr = document.createElement('tr');
    const p = l.perm || {};
    const pn = VIEW_KEYS.filter(k => p[k] === true).length;
    const ptxt = pn === 0 ? '按用户单独设置' : VIEW_KEYS.filter(k => p[k] === true).map(k => (VIEW_SHORT[k] || VIEW_LABELS[k] || k)).join('/');
    tr.innerHTML = `<td><b>Lv${l.level}</b></td><td>${esc(l.name)}</td><td>${l.noAds ? '<span class="tag" style="color:#ffd9f3;border-color:rgba(255,77,216,.5)">去广告</span>' : '<span style="color:var(--muted)">—</span>'}</td><td>${l.iptv ? '<span class="tag" style="color:#9ff;border-color:rgba(0,229,255,.5)">含IPTV</span>' : '<span style="color:var(--muted)">—</span>'}</td><td style="font-size:12px">${esc(ptxt)}</td><td>x${l.pointMul}</td><td>${Number(l.points) > 0 ? Number(l.points) + ' 分' : '<span style="color:var(--muted)">不设</span>'}</td><td><div style="display:flex;gap:6px"><button class="btn" data-edit="${l.level}">编辑</button>${l.level > 0 ? '<button class="btn danger" data-del="' + l.level + '">删除</button>' : '<span style="color:var(--muted);font-size:12px">内置</span>'}</div></td>`;
    tr.querySelector('[data-edit]').onclick = () => {
      $('#vipLv').value = l.level; $('#vipName').value = l.name; $('#vipMul').value = l.pointMul;
      $('#vipNoAds').checked = !!l.noAds; $('#vipIptv').checked = !!l.iptv; $('#vipPoints').value = Number(l.points) || 0;
      renderVipPerm(l.perm, l.level);
    };
    const d = tr.querySelector('[data-del]');
    if (d) d.onclick = () => { VIP_LEVELS = VIP_LEVELS.filter(x => x.level !== l.level); renderVipLevels(); };
    tb.appendChild(tr);
  });
}
/* 会员等级访问权限复选框 */
function renderVipPerm(perm, level) {
  const box = $('#vipPermBoxes'); if (!box) return;
  perm = perm || {};
  box.innerHTML = '';
  /* v47：Lv0 不是会员等级，勾了也不会强行放行（用户单独设置优先），这里写清楚免得误解 */
  if (Number(level) === 0) {
    const tip = document.createElement('div');
    tip.style.cssText = 'grid-column:1/-1;font-size:12px;color:var(--muted);margin-bottom:6px;line-height:1.6';
    tip.textContent = '提示：Lv0 = 普通用户（非会员），这里的勾选只作缺省，不会覆盖「注册默认权限 / 用户单独权限」。要给会员加特权请勾 Lv1、Lv2。';
    box.appendChild(tip);
  }
  VIEW_KEYS.forEach(k => {
    const lab = document.createElement('label'); lab.className = 'pv';
    lab.innerHTML = `<input type="checkbox" data-vk="${k}" ${perm[k] === true ? 'checked' : ''}> ${VIEW_LABELS[k] || k}`;
    box.appendChild(lab);
  });
}
function collectVipPerm() {
  const m = {};
  document.querySelectorAll('#vipPermBoxes input[data-vk]').forEach(i => { m[i.dataset.vk] = !!i.checked; });
  return m;
}
$('#vipAdd').onclick = () => {
  const lv = Number($('#vipLv').value);
  if (isNaN(lv) || lv < 0 || lv > 9) return toast('等级需为 0-9 的整数');
  const name = $('#vipName').value.trim();
  if (!name) return toast('请填写等级名称（如：普通用户 / 黄金会员）');
  const mul = Math.max(0, Math.min(100, Number($('#vipMul').value) || 1));
  const noAds = $('#vipNoAds').checked;
  const iptv = $('#vipIptv').checked;
  const pts = Math.max(0, Number($('#vipPoints').value) || 0);
  const perm = collectVipPerm();
  const ex = VIP_LEVELS.find(x => x.level === lv);
  if (ex) { ex.name = name; ex.pointMul = mul; ex.noAds = noAds; ex.iptv = iptv; ex.points = pts; ex.perm = perm; }
  else VIP_LEVELS.push({ level: lv, name, noAds, pointMul: mul, iptv, points: pts, perm });
  renderVipLevels(); toast('已更新等级（记得点下方保存）');
};

/* ---------- 积分兑换项（后台） ---------- */
let RD_ITEMS = [];
function renderRdItems() {
  const tb = $('#rdTable tbody'); if (!tb) return; tb.innerHTML = '';
  if (!RD_ITEMS.length) { tb.innerHTML = '<tr><td colspan="8" style="color:var(--muted);font-size:13px">暂无兑换项，请在下方添加</td></tr>'; return; }
  RD_ITEMS.forEach((it, i) => {
    const tr = document.createElement('tr');
    const what = it.kind === 'perm' ? (VIEW_LABELS[it.permKey] || it.permKey) + ' 权限' : 'Lv' + it.level + ' 会员';
    tr.innerHTML = `<td>${esc(it.title)}</td><td>${it.kind === 'perm' ? '限时权限' : '会员时长'}</td><td>${esc(what)}</td><td>${it.days > 0 ? it.days + ' 天' : '永久'}</td><td><b style="color:var(--cyan)">${it.cost}</b></td><td>${it.stock < 0 ? '无限' : it.stock}</td><td>${it.enabled !== false ? '<span class="tag">上架</span>' : '<span style="color:var(--muted)">下架</span>'}</td><td><div style="display:flex;gap:6px"><button class="btn" data-tog="${i}">${it.enabled !== false ? '下架' : '上架'}</button><button class="btn danger" data-del="${i}">删除</button></div></td>`;
    tr.querySelector('[data-tog]').onclick = () => { RD_ITEMS[i].enabled = !(RD_ITEMS[i].enabled !== false); renderRdItems(); };
    tr.querySelector('[data-del]').onclick = () => { RD_ITEMS.splice(i, 1); renderRdItems(); };
    tb.appendChild(tr);
  });
}
function fillRdForm(R) {
  R = R || {};
  $('#rdEn').checked = R.enabled !== false;
  RD_ITEMS = (R.items || []).map(x => Object.assign({}, x));
  renderRdItems();
  /* 等级与权限下拉 */
  const sel = $('#rdLevel'); sel.innerHTML = '';
  VIP_LEVELS.slice().sort((a, b) => a.level - b.level).forEach(l => { const o = document.createElement('option'); o.value = l.level; o.textContent = 'Lv' + l.level + ' · ' + (l.name || ''); sel.appendChild(o); });
  const pk = $('#rdPermKey'); pk.innerHTML = '';
  VIEW_KEYS.forEach(k => { const o = document.createElement('option'); o.value = k; o.textContent = VIEW_LABELS[k] || k; pk.appendChild(o); });
  const def = pk.querySelector('option[value="iptv"]'); if (def) pk.value = 'iptv';
}
$('#rdKind').onchange = () => { $('#rdVipWrap').style.display = $('#rdKind').value === 'perm' ? 'none' : ''; $('#rdPermWrap').style.display = $('#rdKind').value === 'perm' ? '' : 'none'; };
$('#rdAdd').onclick = () => {
  const title = $('#rdTitle').value.trim();
  if (!title) return toast('请填写兑换项标题');
  const kind = $('#rdKind').value === 'perm' ? 'perm' : 'vip';
  if (kind === 'perm' && !$('#rdPermKey').value) return toast('请选择要兑换的权限');
  RD_ITEMS.push({
    id: 'rd_' + Date.now().toString(36), title, desc: $('#rdDesc').value.trim(), kind,
    level: Number($('#rdLevel').value) || 0, permKey: kind === 'perm' ? $('#rdPermKey').value : '',
    days: Math.max(0, Number($('#rdDays').value) || 0), cost: Math.max(0, Number($('#rdCost').value) || 0),
    stock: Math.max(-1, Number($('#rdStock').value) || 0), enabled: true
  });
  $('#rdTitle').value = ''; $('#rdDesc').value = '';
  renderRdItems(); toast('已加入列表（记得点「保存兑换设置」）');
};
$('#rdSaveBtn').onclick = async () => {
  const r = await api('/api/admin/redeem', { method: 'POST', body: { redeem: { enabled: $('#rdEn').checked, items: RD_ITEMS } } });
  if (r.error) return toast('❌ ' + r.error);
  $('#ptSaveR').textContent = '兑换设置已保存 ' + new Date().toLocaleTimeString();
  toast('积分兑换设置已保存'); loadAll();
};
function fillPointsForm(P, V) {
  P = P || {}; V = V || {};
  $('#ptEn').checked = P.enabled !== false;
  const ck = P.checkin || {};
  $('#ptCkBase').value = ck.base != null ? ck.base : 10;
  $('#ptCkBonus').value = ck.streakBonus != null ? ck.streakBonus : 5;
  $('#ptCkMax').value = ck.streakMax != null ? ck.streakMax : 7;
  const iv = P.invite || {};
  $('#ptIvPer').value = iv.perInvite != null ? iv.perInvite : 50;
  $('#ptIvCap').value = iv.dailyCap != null ? iv.dailyCap : 200;
  $('#ptIvReq').checked = !!iv.requireRegister;
  const w = P.watch || {};
  $('#ptWPer').value = w.pointsPerMin != null ? w.pointsPerMin : 1;
  $('#ptWCap').value = w.dailyCapMin != null ? w.dailyCapMin : 120;
  $('#vipEn').checked = V.enabled !== false;
  VIP_LEVELS = (V.levels || []).map(x => Object.assign({}, x));
  renderVipLevels();
  /* 访问权限复选框预填：默认全不勾（= 该等级不额外解锁，完全按用户单独设置）；点某等级「编辑」会换成该等级的值 */
  renderVipPerm({}, Number($('#vipLv').value) || 0);
}
$('#ptSaveBtn').onclick = async () => {
  const rp = await api('/api/admin/points', { method: 'POST', body: { points: {
    enabled: $('#ptEn').checked,
    checkin: { base: Number($('#ptCkBase').value) || 0, streakBonus: Number($('#ptCkBonus').value) || 0, streakMax: Number($('#ptCkMax').value) || 0 },
    invite: { perInvite: Number($('#ptIvPer').value) || 0, dailyCap: Number($('#ptIvCap').value) || 0, requireRegister: $('#ptIvReq').checked },
    watch: { pointsPerMin: Number($('#ptWPer').value) || 0, dailyCapMin: Number($('#ptWCap').value) || 0 },
    vipMul: (CFG.points && CFG.points.vipMul) || {}
  } } });
  if (rp.error) return toast('❌ ' + rp.error);
  const rv = await api('/api/admin/vip', { method: 'POST', body: { vip: { enabled: $('#vipEn').checked, levels: VIP_LEVELS } } });
  if (rv.error) return toast('❌ ' + rv.error);
  $('#ptSaveR').textContent = '已保存 ' + new Date().toLocaleTimeString();
  toast('积分与会员配置已保存'); loadAll();
};

/* ---------- 设会员 / 调积分 弹窗 ---------- */
let vipTargetId = '', ptsTargetId = '';
/* v60：默认等级=该用户「当前已有等级」，普通用户则默认最低的付费等级（Lv1 起）——
   以前恒为 Lv0 普通用户，点开直接保存 = 静默取消会员，表现成「设会员不生效」 */
function openVipModal(id, name) {
  vipTargetId = id;
  $('#vipMUser').textContent = name;
  const sel = $('#vipMLv'); sel.innerHTML = '';
  const levels = ((CFG.vip && CFG.vip.levels) || [{ level: 0, name: '普通用户', pointMul: 1 }]);
  const sorted = levels.slice().sort((a, b) => a.level - b.level);
  sorted.forEach(l => {
    const o = document.createElement('option'); o.value = l.level;
    o.textContent = 'Lv' + l.level + ' · ' + (l.name || '') + (l.noAds ? '（去广告）' : '') + (l.iptv ? '（IPTV）' : '') + '（积分 x' + (l.pointMul || 1) + '）';
    sel.appendChild(o);
  });
  const u = (ADMIN_USERS || []).find(x => x.id === id) || {};
  const cur = Number((u.vip && u.vip.level) || 0);
  const paid = sorted.filter(l => Number(l.level) > 0);
  const dflt = cur > 0 ? cur : ((paid[0] && Number(paid[0].level)) || 0);
  sel.value = String(dflt);
  if (sel.value !== String(dflt)) sel.value = sorted[0] ? String(sorted[0].level) : '0';
  /* 顶部显示当前状态，避免「不知道现在是啥就保存」 */
  const curBox = $('#vipMCur');
  if (curBox) {
    const v = u.vip || {};
    curBox.innerHTML = cur > 0
      ? '当前：<b style="color:#ffd9f3">' + esc(v.name || ('Lv' + cur)) + '</b> · ' + (Number(v.days) > 0 ? ('剩 ' + v.days + ' 天') : (v.expire ? ('剩 ' + v.days + ' 天') : '永久'))
      : '当前：<b>普通用户</b>（未开通会员）';
  }
  $('#vipMDays').value = '30';
  $('#vipModal').style.display = 'grid';
}
$('#vipMCancel').onclick = () => { $('#vipModal').style.display = 'none'; };
$('#vipModal').addEventListener('click', e => { if (e.target.id === 'vipModal') $('#vipModal').style.display = 'none'; });
$('#vipMSave').onclick = async () => {
  const lv = Number($('#vipMLv').value) || 0;
  const days = Number($('#vipMDays').value) || 0;
  const u = (ADMIN_USERS || []).find(x => x.id === vipTargetId) || {};
  const was = Number((u.vip && u.vip.level) || 0);
  /* 选了「普通用户」= 取消会员，必须二次确认，避免手滑把会员清掉 */
  if (lv === 0 && was > 0 && !confirm('确认取消 ' + (u.username || '该用户') + ' 的会员吗？')) return;
  $('#vipMSave').disabled = true;
  const r = await api('/api/admin/users/vip', { method: 'POST', body: { id: vipTargetId, level: lv, days } });
  $('#vipMSave').disabled = false;
  if (r.error) return toast('❌ ' + r.error);
  $('#vipModal').style.display = 'none';
  toast(lv === 0 ? '已取消会员' : ('已设为 ' + ((r.vip && r.vip.name) || ('Lv' + lv)) + (days > 0 ? '（+' + days + ' 天）' : '（永久）')));
  loadAll();
};
function openPtsModal(id, name) {
  ptsTargetId = id;
  $('#ptsMUser').textContent = name;
  $('#ptsMDelta').value = '';
  $('#ptsModal').style.display = 'grid';
}
$('#ptsMCancel').onclick = () => { $('#ptsModal').style.display = 'none'; };
$('#ptsModal').addEventListener('click', e => { if (e.target.id === 'ptsModal') $('#ptsModal').style.display = 'none'; });
$('#ptsMSave').onclick = async () => {
  const delta = Number($('#ptsMDelta').value);
  if (isNaN(delta) || delta === 0) return toast('请输入非 0 的增减分数');
  const r = await api('/api/admin/users/points', { method: 'POST', body: { id: ptsTargetId, delta } });
  if (r.error) return toast('❌ ' + r.error);
  $('#ptsModal').style.display = 'none'; toast('积分已调整为 ' + r.points); loadAll();
};

/* 事件 */
$('#aLogin').onclick = login;
$('#aPass').addEventListener('keydown', e => { if (e.key === 'Enter') login(); });
$('#logout').onclick = logout;
document.querySelectorAll('.tabs .chip').forEach(c => c.onclick = () => {
  document.querySelectorAll('.tabs .chip').forEach(x => x.classList.remove('active'));
  document.querySelectorAll('.panel').forEach(x => x.classList.remove('active'));
  c.classList.add('active'); $('#p-' + c.dataset.t).classList.add('active');
  if (c.dataset.t === 'parse') renderUpLines();
  if (c.dataset.t === 'collect') renderUpCollectLines();
  if (c.dataset.t === 'upstream') fillUpstreamForm(CFG.upstream || {});
  if (c.dataset.t === 'logs') loadLogs();
});
$('#bSave').onclick = async () => { const r = await api('/api/admin/broadcast', { method: 'POST', body: { enabled: $('#bEn').checked, title: $('#bTitle').value, content: $('#bContent').value, count: Number($('#bCount').value) || 1, interval: Number($('#bInterval').value) || 1, intervalUnit: $('#bUnit').value } }); const bc = (r && r.broadcast) || {}; const unitTxt = bc.intervalUnit === 's' ? '秒' : bc.intervalUnit === 'm' ? '分' : '时'; toast('广播设置已保存（' + (bc.enabled ? '已启用，连推 ' + (bc.count || 1) + ' 次，间隔 ' + (bc.interval || 1) + ' ' + unitTxt : '已停用') + '），在线 ' + (r && r.clients != null ? r.clients : 0) + ' 台'); };
$('#bStop').onclick = async () => { await api('/api/admin/broadcast', { method: 'POST', body: { enabled: false, title: $('#bTitle').value, content: $('#bContent').value, count: Number($('#bCount').value) || 1, interval: Number($('#bInterval').value) || 1, intervalUnit: $('#bUnit').value } }); $('#bEn').checked = false; toast('已停止广播推送'); };
$('#aSave').onclick = async () => { await api('/api/admin/announcement', { method: 'POST', body: { enabled: $('#aEn').checked, title: $('#aTitle').value, content: $('#aContent').value, mode: $('#aMode').value } }); toast('公告已保存'); };
$('#aPush').onclick = async () => { await api('/api/admin/announcement', { method: 'POST', body: { enabled: $('#aEn').checked, title: $('#aTitle').value, content: $('#aContent').value, mode: $('#aMode').value, push: true } }); toast('已保存并弹窗'); };
$('#hSave').onclick = async () => {
  await api('/api/admin/config', { method: 'POST', body: {
    siteName: $('#hName').value,
    home: { tip: $('#hTip').value, columns: ColConfig },
    hero: { title: $('#hHeroTitle').value.trim(), sub: $('#hHeroSub').value.trim(),
      pageTitle: $('#hPageTitle').value.trim(), gateSub: $('#hGateSub').value.trim(),
      titleSize: Math.min(120, Math.max(0, Number($('#hHeroTSize').value) || 0)),
      titleColor: $('#hHeroTColor').value.trim(),
      subSize: Math.min(40, Math.max(0, Number($('#hHeroSSize').value) || 0)),
      subColor: $('#hHeroSColor').value.trim() },
    toggles: { antiScam: $('#tScam').checked, antiScamText: $('#tScamText').value,
      autoSkip: $('#tAutoSkip').checked,
      antiScamSpeed: Math.min(180, Math.max(5, Number($('#tScamSpeed').value) || 15)),
      antiScamColor: $('#tScamColor').value,
      antiScamSize: Math.min(40, Math.max(10, Number($('#tScamSize').value) || 13)),
      antiScamFrom: Math.min(200, Math.max(-200, Number($('#tScamFrom').value) || 100)),
      antiScamTo: Math.min(200, Math.max(-200, Number($('#tScamTo').value) || -100)) }
  } });
  await api('/api/admin/config', { method: 'POST', body: { tmdbRegion: $('#hRegion').value || 'CN' } });
  toast('首页配置已保存'); loadAll();
};
$('#colType').onchange = populateColKey;
$('#colAdd').onclick = async () => {
  const t = $('#colType').value, key = $('#colKey').value, label = $('#colLabel').value.trim();
  if (t === 'collect' && !key) return toast('请先在「采集站」添加一个站点');
  if (t === 'tmdb' && !key) return toast('请选择 TMDB 榜单');
  ColConfig.push(t === 'collect' ? { type: 'collect', stationId: key, label } : { type: 'tmdb', key, label });
  $('#colLabel').value = ''; renderColList(); toast('已加入栏目列表（点保存生效）');
};
$('#pAdd').onclick = async () => { if (!$('#pName').value || !$('#pUrl').value) return toast('请填写名称和地址'); await api('/api/admin/parse', { method: 'POST', body: { name: $('#pName').value, url: $('#pUrl').value } }); $('#pName').value = ''; $('#pUrl').value = ''; toast('已添加'); loadAll(); };
/* v73：地址不对必须由后台当场拦下并说明原因，不能默默存进去再让前台显示「暂无分集」 */
$('#cAdd').onclick = async () => {
  if (!$('#cName').value || !$('#cApi').value) return toast('请填写名称和API');
  if (!/^https?:\/\//i.test($('#cApi').value.trim())) return toast('API 地址需以 http:// 或 https:// 开头');
  const r = await api('/api/admin/collect', { method: 'POST', body: { name: $('#cName').value, api: $('#cApi').value } });
  if (r && r.error) return toast('❌ ' + r.error, 6000);
  $('#cName').value = ''; $('#cApi').value = '';
  toast(r && r.fixed ? '已添加（地址已自动补全为 ' + r.api + '）' : '已添加'); loadAll();
};
$('#cTest').onclick = async () => {
  const v = $('#cApi').value.trim();
  if (!/^https?:\/\//i.test(v)) { $('#cTestR').textContent = '❌ 需完整地址：以 http:// 或 https:// 开头（如 https://api.example.com/api.php/provide/vod）'; return; }
  $('#cTestR').textContent = '测试中…';
  let r = null;
  try { r = await api('/api/admin/collect/test', { method: 'POST', body: { api: v } }); } catch (e) { r = null; }
  if (!r) { $('#cTestR').textContent = '❌ 测试失败（网络/地址不可达）'; return; }
  $('#cTestR').textContent = r.ok
    ? ('✅ 连通，总数 ' + (r.total || '?') + (r.api && r.api !== v ? '（按 ' + r.api + ' 测的）' : ''))
    : ('❌ ' + (r.error || '失败'));
};
$('#uAdd').onclick = async () => { if (!$('#uNew').value || !$('#uPw').value) return toast('请填写用户名和密码'); const r = await api('/api/admin/users', { method: 'POST', body: { username: $('#uNew').value, password: $('#uPw').value, role: $('#uRole').value } }); if (r.error) return toast(r.error); $('#uNew').value = ''; $('#uPw').value = ''; toast('已添加用户' + (r.permApplied ? '（已按新用户默认权限模板授权）' : '')); loadAll(); };
$('#iSave').onclick = async () => {
  /* v45b：分组权限矩阵 = { users:{对象:{分组:bool}}, levels:{...} }，未设置的键 = 默认允许（含以后新增的分组） */
  const sp = { users: {}, levels: {} };
  const u = IPTV_PERM.users || {}, lv = IPTV_PERM.levels || {};
  Object.keys(u).forEach(k => { const m = {}; Object.keys(u[k] || {}).forEach(s => { m[s] = u[k][s] === true; }); sp.users[k] = m; });
  Object.keys(lv).forEach(k => { const m = {}; Object.keys(lv[k] || {}).forEach(s => { m[s] = lv[k][s] === true; }); sp.levels[k] = m; });
  /* v57：手动分组一起持久化进 groupStats（否则源没拉成功时，自己填的分组会丢） */
  const gstats = (((CFG.iptv || {}).groupStats) || []).slice();
  iptvManualGroups().forEach(n => { if (!gstats.some(g => String((g && g.name) || '') === n)) gstats.push({ name: n, count: 0 }); });
  const body = { iptv: {
    enabled: $('#iEn').checked,
    epgUrl: $('#iEpg').value.trim(),
    epgEnabled: $('#iEpgEn').checked,
    sources: IPTV_SRCS,
    groupPerm: sp,
    groupStats: gstats,
    groupOrder: IPTV_ORDER.slice()   /* v64：分组排序随保存下发 */
  } };
  const r = await api('/api/admin/config', { method: 'POST', body });
  if (r.error) return toast('❌ ' + (r.error || '保存失败'));
  CFG.iptv = r.config && r.config.iptv;
  IPTV_PERM = Object.assign({ users: {}, levels: {} }, (CFG.iptv || {}).groupPerm || {});
  renderIptvPerm();
  toast('IPTV 设置已保存（' + IPTV_SRCS.length + ' 个直播源 / ' + (((CFG.iptv || {}).groupStats || []).length) + ' 个分组），前台刷新后生效');
};
$('#iTest').onclick = async () => {
  $('#iTestR').textContent = '⏳ 正在逐个拉取直播源…';
  const r = await api('/api/admin/iptv-test', { method: 'POST', body: { sources: IPTV_SRCS.filter(s => s.enabled !== false && s.url) } });
  if (!r.results || !r.results.length) { $('#iTestR').textContent = '❌ ' + (r.error || '没有可测试的直播源'); return; }
  $('#iTestR').textContent = r.results.map(x => (x.ok ? '✅ ' + x.name + '：' + x.count + ' 频道' : '❌ ' + x.name + '：' + (x.error || '失败'))).join('　|　')
    + '　— 合计 ' + (r.total || 0) + ' 频道 / ' + (r.groups || []).length + ' 分组';
};
/* 节目单（EPG）连通测试：先存当前填的地址再测，识别 M3U 冒充 */
$('#iEpgTest').onclick = async () => {
  $('#iTestR').textContent = '⏳ 正在拉取节目单…';
  const r = await api('/api/admin/epg-test', { method: 'POST', body: { url: $('#iEpg').value.trim() } });
  $('#iTestR').textContent = r.ok
    ? ('✅ 节目单有效（xmltv）：' + r.channels + ' 个频道 / ' + r.programmes + ' 条节目 / ' + r.kb + 'KB')
    : ('❌ ' + (r.error || '失败'));
};
$('#adSave').onclick = async () => {
  const bl = $('#adBl').value.split('\n').map(x => x.trim()).filter(Boolean);
  const r = await api('/api/admin/config', { method: 'POST', body: { adFilter: { enabled: $('#adEn').checked, tsProxy: $('#adTs').checked, blacklist: bl } } });
  if (r.error) { $('#adSaveR').textContent = '❌ ' + (r.error || '失败'); return; }
  $('#adSaveR').textContent = '✅ 已保存' + (bl.length ? ('（黑名单 ' + bl.length + ' 条）') : '');
  toast('广告过滤设置已保存');
  CFG.adFilter = { enabled: $('#adEn').checked, tsProxy: $('#adTs').checked, blacklist: bl };
};
/* 实时预览（Task B）：接断点插播规则，展示插播块时间点与预计拦截段数 */
function fmtTime(s) {
  s = Math.max(0, Math.floor(s || 0));
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), x = s % 60;
  const mm = (h ? (m < 10 ? '0' + m : m) : m), ss = x < 10 ? '0' + x : x;
  return (h ? h + ':' : '') + mm + ':' + ss;
}
$('#adPrevBtn').onclick = async () => {
  const url = $('#adPrevUrl').value.trim();
  if (!url) { $('#adPrevR').textContent = '❌ 请填写地址'; return; }
  $('#adPrevR').textContent = '分析中…';
  $('#adPrevBox').style.display = 'none';
  const r = await api('/api/ad-preview?url=' + encodeURIComponent(url));
  if (r.error) { $('#adPrevR').textContent = '❌ ' + (r.error || '失败'); return; }
  $('#adPrevR').textContent = (r.verdict === 'ad' ? '⚠️ 有插播' : (r.verdict === 'clean' ? '✅ 无插播' : (r.verdict === 'notm3u' ? 'ℹ️ 非 m3u8（如 mp4 直链）' : (r.verdict === 'error' ? '❌ 分析失败' : '—')))) + (r.enabled ? '' : '（过滤当前关闭）');
  const blocks = (r.adBlocks || []).map(b => '  · ' + fmtTime(b.startSec) + ' 起  约 ' + b.dur + 's / ' + b.segs + ' 段').join('\n');
  $('#adPrevBox').style.display = 'block';
  $('#adPrevBox').textContent =
    '主域: ' + (r.host || '-') + '\n' +
    '切片总数: ' + (r.total || 0) + '\n' +
    '断点标记: ' + (r.discMarkers || 0) + '\n' +
    '预计拦截: ' + (r.blocked || 0) + ' 段（其中断点插播 ' + (r.discAd || 0) + ' 段）\n' +
    '插播块(' + (r.adBlocks || []).length + '):\n' + (blocks || '  （无）') +
    (r.tripped ? '\n⚠️ 熔断：删除占比过高，整份放行未过滤' : '');
};

(async function init() {
  if (!TOKEN) return;
  try { ME = (await api('/api/auth/me')).user; if (ME.role !== 'admin') { localStorage.removeItem('aistream_admin_token'); return; } enter(); }
  catch (e) { /* 401 已在 api() 里清 token 并跳转，这里静默即可 */ }
})();
