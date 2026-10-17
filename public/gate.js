'use strict';
/* 极简登录页脚本：只负责登录/注册 + 跳转到主应用，不加载也不暴露 app.js / player.js 的任何逻辑 */
const $ = s => document.querySelector(s);
const TOKEN_KEY = 'aistream_token';

/* v71：跳转熔断。
   死循环场景：本地 token 还在、会话 Cookie 丢了 → 大门禁只认 Cookie，访问 / 被打回登录页，
   登录页又凭 token 判定「已登录」→ 跳回 / → 又被打回 → 整页无限刷新。
   服务端会在 /api/auth/me 里补发 Cookie 把这个环解开；但万一浏览器彻底禁用 Cookie，
   补了也没用 → 这里再做一层保险：3 秒内连跳 3 次就停下，老老实实显示登录框。 */
function canJump() {
  try {
    const now = Date.now();
    const last = Number(sessionStorage.getItem('__gjt') || '0');
    const n = (now - last < 3000) ? Number(sessionStorage.getItem('__gjn') || '0') + 1 : 1;
    sessionStorage.setItem('__gjt', String(now));
    sessionStorage.setItem('__gjn', String(n));
    return n <= 2;
  } catch (e) { return true; }
}
/* 主动进入应用（登录/注册成功）时清掉计数，别被之前的循环记录误伤 */
function resetJump() {
  try { sessionStorage.removeItem('__gjt'); sessionStorage.removeItem('__gjn'); } catch (e) {}
}
/* 返回 true = 真跳了；false = 被熔断拦下（调用方要接着显示登录框） */
function goApp() {
  if (!canJump()) return false;
  location.replace('/');
  return true;
}

/* 已登录（本地 token 仍有效）→ 直接进应用，跳过登录框 */
async function alreadyIn() {
  const t = localStorage.getItem(TOKEN_KEY);
  if (!t) return false;
  try {
    /* credentials: 'include' —— 让服务端有机会通过这次请求把丢失的会话 Cookie 补回来 */
    const r = await fetch('/api/auth/me', { headers: { 'Authorization': 'Bearer ' + t }, credentials: 'include' });
    return r.ok;
  } catch (e) { return false; }
}

function toggleReg(show) {
  $('#gReg').classList.toggle('hidden', !show);
  $('#gateFoot').classList.toggle('hidden', show);
  $('#gateErr').textContent = '';
}

async function login() {
  $('#gateErr').textContent = '';
  const u = $('#gUser').value.trim(), p = $('#gPass').value;
  if (!u || !p) { $('#gateErr').textContent = '请输入用户名和密码'; return; }
  try {
    const r = await fetch('/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: u, password: p }) });
    const j = await r.json();
    if (!r.ok) { $('#gateErr').textContent = j.error || '登录失败'; return; }
    localStorage.setItem(TOKEN_KEY, j.token);   /* 服务端同时下发了 HttpOnly 会话 Cookie 供页面门禁使用 */
    resetJump();
    goApp();
  } catch (e) { $('#gateErr').textContent = '网络错误'; }
}

async function doRegister() {
  const u = $('#gRegUser').value.trim(), p1 = $('#gRegPass').value, p2 = $('#gRegPass2').value;
  const invite = ($('#gRegInvite') ? $('#gRegInvite').value.trim() : '');
  $('#gateErr').textContent = '';
  if (p1 !== p2) { $('#gateErr').textContent = '两次输入的密码不一致'; return; }
  try {
    const r = await fetch('/api/auth/register', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: u, password: p1, invite }) });
    const j = await r.json();
    if (!r.ok) { $('#gateErr').textContent = j.error || '注册失败'; return; }
    localStorage.setItem(TOKEN_KEY, j.token);
    resetJump();
    goApp();
  } catch (e) { $('#gateErr').textContent = '网络错误'; }
}

async function init() {
  /* 品牌与注册开关来自公开接口（不含任何敏感信息） */
  try {
    const pub = await fetch('/api/public').then(r => r.json());
    if (pub && pub.siteName) $('#gateLogo').textContent = pub.siteName;
    if (pub && pub.hero && pub.hero.gateSub) $('#gateSub').textContent = pub.hero.gateSub;
    if (pub && pub.regEnabled === false) $('#gateFoot').classList.add('hidden');
    /* 邀请注册：后台开了「必须邀请码」时把邀请码框亮出来并提示必填 */
    if (pub && pub.inviteRequired && $('#gRegInvite')) {
      $('#gRegInvite').classList.remove('hidden');
      $('#gRegInvite').placeholder = '邀请码（必填）';
    }
  } catch (e) {}
  /* 邀请链接（/gate.html?invite=XXX）带来的邀请码自动回填，并直接切到注册框 */
  try {
    const inv = new URLSearchParams(location.search).get('invite');
    if (inv && $('#gRegInvite')) { $('#gRegInvite').value = inv; toggleReg(true); }
  } catch (e) {}
  /* 已登录 → 进应用；被熔断拦下（Cookie 补不回来）时不能 return，
     要接着往下走把登录框显示出来，否则用户看到的就是一个停不下来的空页 */
  if (await alreadyIn()) { if (goApp()) return; }
  $('#gLogin').onclick = login;
  $('#gPass').addEventListener('keydown', e => { if (e.key === 'Enter') login(); });
  $('#gRegLink').onclick = () => toggleReg(true);
  $('#gBackLogin').onclick = () => toggleReg(false);
  $('#gRegBtn').onclick = doRegister;
  $('#gRegPass2').addEventListener('keydown', e => { if (e.key === 'Enter') doRegister(); });
}
init();
