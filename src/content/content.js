/**
 * content script 入口
 * 职责：判断是否详情页 -> 注入/移除悬浮按钮 -> 点击后提取图片 -> 交给后台打开选择页
 */
(function () {
  'use strict';

  const SITE_API = globalThis.ECI_SITE_API;
  const EXTRACT = globalThis.ECI_EXTRACT;
  const BUTTON = globalThis.ECI_BUTTON;

  if (!SITE_API || !EXTRACT || !BUTTON) return;
  if (window.__ECI_CONTENT_LOADED__) return;
  window.__ECI_CONTENT_LOADED__ = true;

  const state = {
    site: null,
    ui: null,
    busy: false,
    lastUrl: ''
  };

  const ROUTE_POLL_MS = 1200;

  function currentSite() {
    return SITE_API.findSite(location.href);
  }

  function isTargetPage() {
    const site = currentSite();
    if (!site) return false;
    return SITE_API.isDetailPage(location.href, site);
  }

  function removeButton() {
    if (state.ui) {
      try {
        state.ui.destroy();
      } catch (e) { /* 忽略 */ }
      state.ui = null;
    }
    state.site = null;
  }

  function mountButton(site) {
    const ui = BUTTON.create({
      onClick: function () {
        handleExtract();
      }
    });
    document.documentElement.appendChild(ui.host);
    state.ui = ui;
    state.site = site;
  }

  function sync() {
    if (location.href === state.lastUrl && state.ui) return;
    state.lastUrl = location.href;

    if (!isTargetPage()) {
      removeButton();
      return;
    }

    const site = currentSite();
    // 已有按钮且站点未变：保持现状，避免重复注入
    if (state.ui && state.site && state.site.id === site.id && document.documentElement.contains(state.ui.host)) {
      return;
    }

    removeButton();
    mountButton(site);
  }

  async function handleExtract() {
    if (state.busy || !state.ui || !state.site) return;
    state.busy = true;

    const ui = state.ui;
    ui.setState('loading');
    ui.setLabel('正在滚动加载页面…');

    try {
      const title = EXTRACT.getPageTitle(state.site);
      const items = await EXTRACT.extractImages(state.site, {
        preload: true,
        onProgress: function (text) {
          ui.setLabel(text);
        },
        getStateText: function () {
          return chrome.runtime
            .sendMessage({ type: 'GET_PAGE_STATE' })
            .then(function (response) {
              return response && response.ok ? response.text : '';
            })
            .catch(function () {
              return '';
            });
        }
      });

      if (!items.length) {
        ui.setState('empty');
        ui.toast('没有找到符合条件的图片，可稍等页面加载后重试');
        return;
      }

      ui.setLabel('正在打开选择页…');
      const response = await chrome.runtime.sendMessage({
        type: 'OPEN_GALLERY',
        payload: {
          siteId: state.site.id,
          siteName: state.site.name,
          title: title,
          pageUrl: location.href,
          items: items
        }
      });

      if (!response || !response.ok) {
        throw new Error((response && response.error) || '打开选择页失败');
      }
      ui.setState('success', items.length);
    } catch (error) {
      const message = (error && error.message) || '提取失败';
      ui.setState('error');
      if (/Extension context invalidated/i.test(message)) {
        ui.toast('扩展已更新，请刷新页面后重试', 4000);
      } else {
        ui.toast(message, 3600);
      }
    } finally {
      state.busy = false;
    }
  }

  /**
   * 监听 SPA 路由变化：history 的原生事件可即时感知，站内 pushState 跳转用低频轮询兜底
   */
  function watchRoute() {
    let timer = null;
    function scheduleSync() {
      if (timer) return;
      timer = setTimeout(function () {
        timer = null;
        sync();
      }, 120);
    }

    window.addEventListener('popstate', scheduleSync);
    window.addEventListener('hashchange', scheduleSync);

    setInterval(function () {
      if (location.href !== state.lastUrl) scheduleSync();
    }, ROUTE_POLL_MS);
  }

  function boot() {
    sync();
    watchRoute();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot, { once: true });
  } else {
    boot();
  }
})();
