/**
 * 悬浮按钮（Shadow DOM 隔离）
 * 对外暴露 globalThis.ECI_BUTTON.create({ onClick }) -> { host, setState, setLabel, toast, destroy }
 */
(function () {
  'use strict';

  const STYLE = [
    '.eci-wrap{position:relative;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC","Hiragino Sans GB","Microsoft YaHei",sans-serif;-webkit-font-smoothing:antialiased;}',
    '.eci-wrap *{box-sizing:border-box;}',
    '.eci-btn{display:inline-flex;align-items:center;gap:8px;height:44px;padding:0 18px;border:0;border-radius:999px;cursor:pointer;',
    'color:#fff;font-size:14px;font-weight:600;letter-spacing:.2px;line-height:1;white-space:nowrap;',
    'background:linear-gradient(135deg,#ff7a1a 0%,#ff4d00 100%);',
    'box-shadow:0 8px 24px rgba(255,77,0,.32),0 2px 6px rgba(0,0,0,.12);',
    'transition:transform .18s ease,box-shadow .18s ease,filter .18s ease,background .18s ease;}',
    '.eci-btn:hover{transform:translateY(-2px);box-shadow:0 12px 30px rgba(255,77,0,.38),0 3px 8px rgba(0,0,0,.14);}',
    '.eci-btn:active{transform:translateY(0) scale(.98);}',
    '.eci-btn:focus-visible{outline:2px solid #fff;outline-offset:3px;box-shadow:0 0 0 5px rgba(255,77,0,.45);}',
    '.eci-btn:disabled{cursor:progress;}',
    '.eci-btn[data-state="loading"]{background:linear-gradient(135deg,#6674ff 0%,#3b4bc8 100%);box-shadow:0 8px 24px rgba(59,75,200,.3);}',
    '.eci-btn[data-state="loading"]:hover{transform:none;}',
    '.eci-btn[data-state="success"]{background:linear-gradient(135deg,#34d399 0%,#059669 100%);box-shadow:0 8px 24px rgba(5,150,105,.3);}',
    '.eci-btn[data-state="empty"]{background:linear-gradient(135deg,#fbbf24 0%,#d97706 100%);box-shadow:0 8px 24px rgba(217,119,6,.3);}',
    '.eci-btn[data-state="error"]{background:linear-gradient(135deg,#f87171 0%,#dc2626 100%);box-shadow:0 8px 24px rgba(220,38,38,.3);}',
    '.eci-icon{display:inline-flex;align-items:center;justify-content:center;width:18px;height:18px;flex:0 0 auto;}',
    '.eci-spinner{display:none;width:16px;height:16px;border-radius:50%;border:2px solid rgba(255,255,255,.35);border-top-color:#fff;animation:eci-spin .7s linear infinite;}',
    '.eci-btn[data-state="loading"] .eci-spinner{display:block;}',
    '.eci-btn[data-state="loading"] .eci-icon svg{display:none;}',
    '@keyframes eci-spin{to{transform:rotate(360deg);}}',
    '.eci-badge{min-width:20px;height:20px;padding:0 6px;border-radius:999px;background:rgba(255,255,255,.24);',
    'font-size:12px;font-weight:600;display:inline-flex;align-items:center;justify-content:center;}',
    '.eci-toast{position:absolute;right:0;bottom:calc(100% + 10px);max-width:280px;padding:9px 12px;border-radius:10px;',
    'background:#1f2937;color:#fff;font-size:12px;line-height:1.5;box-shadow:0 10px 24px rgba(0,0,0,.24);',
    'opacity:0;transform:translateY(6px);transition:opacity .18s ease,transform .18s ease;pointer-events:none;}',
    '.eci-toast.show{opacity:1;transform:translateY(0);}',
    '@media (prefers-reduced-motion:reduce){.eci-btn,.eci-toast{transition:none;}.eci-spinner{animation:none;}}'
  ].join('');

  const TEMPLATE = [
    '<div class="eci-wrap">',
    '  <button class="eci-btn" type="button" part="button" data-state="idle" aria-label="获取当前页面的商品图片">',
    '    <span class="eci-icon" aria-hidden="true">',
    '      <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">',
    '        <rect x="3" y="4" width="18" height="16" rx="2.5"></rect>',
    '        <circle cx="8.5" cy="9.5" r="1.4" fill="currentColor" stroke="none"></circle>',
    '        <path d="M4 17.2l4.6-4.6 3.1 3.1 3.4-3.4L20 17"></path>',
    '      </svg>',
    '      <span class="eci-spinner" aria-hidden="true"></span>',
    '    </span>',
    '    <span class="eci-label">获取图片</span>',
    '    <span class="eci-badge" hidden>0</span>',
    '  </button>',
    '  <div class="eci-toast" role="status" aria-live="polite"></div>',
    '</div>'
  ].join('');

  function create(options) {
    const opts = options || {};
    const host = document.createElement('div');
    host.id = 'eci-floating-root';
    host.setAttribute('data-eci', 'root');
    host.style.cssText =
      'all:initial !important;position:fixed !important;right:24px !important;' +
      'bottom:24px !important;z-index:2147483647 !important;';

    const shadow = host.attachShadow({ mode: 'open' });
    const style = document.createElement('style');
    style.textContent = STYLE;
    shadow.appendChild(style);

    const mount = document.createElement('div');
    mount.innerHTML = TEMPLATE;
    shadow.appendChild(mount);

    const button = shadow.querySelector('.eci-btn');
    const label = shadow.querySelector('.eci-label');
    const badge = shadow.querySelector('.eci-badge');
    const toastEl = shadow.querySelector('.eci-toast');

    let resetTimer = null;
    let toastTimer = null;

    function clearReset() {
      if (resetTimer) {
        clearTimeout(resetTimer);
        resetTimer = null;
      }
    }

    function setState(state, count) {
      clearReset();
      button.dataset.state = state;
      button.disabled = state === 'loading';

      if (state === 'loading') {
        label.textContent = '正在提取…';
        badge.hidden = true;
      } else if (state === 'success') {
        label.textContent = '已获取';
        badge.hidden = false;
        badge.textContent = String(count == null ? 0 : count);
        resetTimer = setTimeout(function () {
          setState('idle');
        }, 2600);
      } else if (state === 'empty') {
        label.textContent = '没有找到图片';
        badge.hidden = true;
        resetTimer = setTimeout(function () {
          setState('idle');
        }, 2600);
      } else if (state === 'error') {
        label.textContent = '提取失败，重试';
        badge.hidden = true;
        resetTimer = setTimeout(function () {
          setState('idle');
        }, 3000);
      } else {
        label.textContent = '获取图片';
        badge.hidden = true;
        button.disabled = false;
      }
    }

    function setLabel(text) {
      if (button.dataset.state === 'loading' && text) label.textContent = text;
    }

    function toast(message, duration) {
      if (!message) return;
      toastEl.textContent = message;
      toastEl.classList.add('show');
      if (toastTimer) clearTimeout(toastTimer);
      toastTimer = setTimeout(function () {
        toastEl.classList.remove('show');
      }, duration || 2800);
    }

    function destroy() {
      clearReset();
      if (toastTimer) clearTimeout(toastTimer);
      if (host.parentNode) host.parentNode.removeChild(host);
    }

    button.addEventListener('click', function (event) {
      event.preventDefault();
      event.stopPropagation();
      if (button.disabled) return;
      if (typeof opts.onClick === 'function') opts.onClick();
    });

    // 阻止事件冒泡回页面，避免触发站点自身的快捷键/点击逻辑
    ['mousedown', 'mouseup', 'pointerdown', 'pointerup', 'dblclick'].forEach(function (type) {
      host.addEventListener(type, function (event) {
        event.stopPropagation();
      }, true);
    });

    setState('idle');

    return {
      host: host,
      setState: setState,
      setLabel: setLabel,
      toast: toast,
      destroy: destroy
    };
  }

  globalThis.ECI_BUTTON = { create: create };
})();
