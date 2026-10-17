/* v35：手机端自动识别
   判定顺序：URL 强制 ?m=1 / ?m=0  →  localStorage 记忆  →  UA 关键字  →  触屏+窄屏
   只有确认为手机时才给 <html> 加 class="is-mobile"，PC 端不会带这个 class，
   因此本次所有移动端样式对电脑网页端零影响。
   选集每页数量：手机 12 集（4 列 × 3 行），电脑保持 20 集（5 列 × 4 行）。 */
(function () {
  var KEY = 'aistream_m';
  function forced() {
    var q = new URLSearchParams(location.search).get('m');
    if (q === '1') return true;
    if (q === '0') return false;
    var s = null;
    try { s = localStorage.getItem(KEY); } catch (e) {}
    if (s === '1') return true;
    if (s === '0') return false;
    return null;
  }
  function detect() {
    var ua = navigator.userAgent || '';
    if (/Android|iPhone|iPad|iPod|Mobile|Windows Phone|HarmonyOS|Opera Mini|BlackBerry/i.test(ua)) return true;
    var coarse = false, narrow = false;
    try { coarse = window.matchMedia('(pointer:coarse)').matches; } catch (e) {}
    narrow = Math.min(window.innerWidth || 1e9, window.innerHeight || 1e9) <= 820;
    return !!(coarse && narrow);
  }
  function apply() {
    var f = forced();
    var isM = (f === null) ? detect() : f;
    if (window.IS_MOBILE === isM) return;
    var prev = window.IS_MOBILE;
    window.IS_MOBILE = isM;
    var el = document.documentElement;
    if (isM) el.classList.add('is-mobile'); else el.classList.remove('is-mobile');
    /* 记住 URL 里的强制选择，下次生效 */
    var q = new URLSearchParams(location.search).get('m');
    if (q === '1' || q === '0') { try { localStorage.setItem(KEY, q); } catch (e) {} }
    if (prev !== undefined) {
      try { window.dispatchEvent(new Event('mobchange')); } catch (e) {}
    }
  }
  apply();
  /* 旋屏 / 窗口变化重判（未强制时按触屏+窄屏实时判定） */
  var t = null;
  window.addEventListener('resize', function () {
    clearTimeout(t);
    t = setTimeout(apply, 200);
  });
  window.addEventListener('orientationchange', function () { setTimeout(apply, 300); });
})();
