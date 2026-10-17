/* v63d 站点激活页：只需 /api/license/status（查机器码/联系方式）和 /api/license/activate（提交授权码），
   这两个接口免登录 —— 未激活时也能访问 */
'use strict';
const $ = s => document.querySelector(s);
let MID = '';

/* 复制：navigator.clipboard 只在 https/localhost 下可用，大哥这种 http://192.168.x.x 直连访问
   拿不到 clipboard 对象 → 必须回落 execCommand，否则「复制」点了没反应（v63d 修） */
async function copyText(t, btn, okTxt) {
  let ok = false;
  try { if (navigator.clipboard && navigator.clipboard.writeText) { await navigator.clipboard.writeText(t); ok = true; } } catch (e) {}
  if (!ok) {
    try {
      const ta = document.createElement('textarea');
      ta.value = t;
      ta.setAttribute('readonly', '');
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
    btn.classList.toggle('done', ok);
    setTimeout(() => { btn.textContent = old; btn.classList.remove('done'); }, 1800);
  }
  return ok;
}
function setMsg(txt, cls) {
  const el = $('#actMsg'); if (!el) return;
  el.textContent = txt || '';
  el.className = 'act-msg' + (cls ? ' ' + cls : '');
}
async function loadStatus() {
  let j = null;
  try {
    j = await fetch('/api/license/status', { headers: { 'Accept': 'application/json' } }).then(r => r.json());
  } catch (e) {}
  if (!j) { $('#actMid').textContent = '（读取失败，请检查服务）'; return; }
  MID = j.machineIdFmt || j.machineId || '';
  $('#actMid').textContent = MID || '（读取失败）';
  if (j.contact && String(j.contact).trim()) {
    const box = $('#actContact');
    if (box) {
      box.innerHTML = '<div class="ct">📮 联系站长获取授权码</div>' + String(j.contact).replace(/</g, '&lt;').replace(/\n/g, '<br>');
      $('#actContactSec').style.display = '';
    }
  }
  if (j.active) done(j);
}
function done(j) {
  const card = $('#actCard'); if (!card) return;
  card.innerHTML = '<div class="act-ok">'
    + '<div class="ic">✅</div>'
    + '<div class="t1">激活成功</div>'
    + '<div class="t2">有效期：' + ((j && j.expText) || '永久有效') + '　正在进入站点…</div>'
    + '</div>';
  setTimeout(() => { location.href = '/index.html'; }, 1000);
}
async function activate() {
  const code = ($('#actCode').value || '').trim();
  if (!code) { setMsg('请先粘贴授权码', 'err'); return; }
  const btn = $('#actGo');
  btn.disabled = true; btn.textContent = '激活中…';
  setMsg('');
  try {
    const r = await fetch('/api/license/activate', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code })
    });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) { setMsg(j.error || '激活失败', 'err'); btn.disabled = false; btn.textContent = '激 活'; return; }
    setMsg('激活成功', 'ok');
    done(j.info || j);
  } catch (e) {
    setMsg('网络错误，请重试', 'err');
    btn.disabled = false; btn.textContent = '激 活';
  }
}
$('#actGo').onclick = activate;
$('#actRefresh').onclick = () => location.reload();
$('#actCopy').onclick = () => copyText(MID || $('#actMid').textContent.trim(), $('#actCopy'));
$('#actCode').addEventListener('keydown', e => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) activate(); });
loadStatus();
