/**
 * background service worker
 * 职责：接收提取结果并暂存到 chrome.storage.session -> 打开选择页；提供跨域取图代理。
 * 注意：MV3 的 service worker 会随时休眠，因此状态一律放在 chrome.storage.session。
 */
importScripts('/src/common/sites.js', '/src/common/utils.js');

const U = globalThis.ECI_UTILS;
const RESULT_PREFIX = 'eci:result:';
const LAST_KEY = 'eci:last';
const MAX_RESULTS = 8;
const RESULT_TTL = 2 * 60 * 60 * 1000;
const MAX_ITEMS = 800;
const MAX_PROXY_BYTES = 30 * 1024 * 1024;

const GALLERY_URL = 'src/gallery/gallery.html';

function galleryUrl(id) {
  const base = chrome.runtime.getURL(GALLERY_URL);
  return id ? base + '?id=' + encodeURIComponent(id) : base;
}

/* -------------------- 提取结果存取 -------------------- */

async function pruneResults() {
  const all = await chrome.storage.session.get(null);
  const entries = Object.keys(all)
    .filter(function (key) {
      return key.indexOf(RESULT_PREFIX) === 0;
    })
    .map(function (key) {
      const value = all[key];
      return { key: key, createdAt: (value && value.createdAt) || 0 };
    });

  entries.sort(function (a, b) {
    return b.createdAt - a.createdAt;
  });

  const now = Date.now();
  const removeKeys = [];
  for (let i = 0; i < entries.length; i++) {
    if (i >= MAX_RESULTS || now - entries[i].createdAt > RESULT_TTL) removeKeys.push(entries[i].key);
  }
  if (removeKeys.length) await chrome.storage.session.remove(removeKeys);
  return removeKeys.length;
}

async function openGallery(payload) {
  if (!payload || !Array.isArray(payload.items) || !payload.items.length) {
    throw new Error('没有可展示的图片');
  }

  const items = payload.items
    .slice(0, MAX_ITEMS)
    .map(function (item) {
      return {
        url: String(item.url || ''),
        width: Number(item.width) || 0,
        height: Number(item.height) || 0,
        source: String(item.source || 'page'),
        ext: String(item.ext || ''),
        animated: !!item.animated
      };
    })
    .filter(function (item) {
      return /^https?:\/\//i.test(item.url);
    });

  if (!items.length) throw new Error('图片地址无效');

  const id = U.randomId();
  const record = {
    id: id,
    siteId: String(payload.siteId || ''),
    siteName: String(payload.siteName || ''),
    title: String(payload.title || '未命名商品').slice(0, 120),
    pageUrl: String(payload.pageUrl || ''),
    items: items,
    createdAt: Date.now()
  };

  const data = {};
  data[RESULT_PREFIX + id] = record;
  data[LAST_KEY] = id;
  await chrome.storage.session.set(data);
  await pruneResults();

  await chrome.tabs.create({ url: galleryUrl(id) });
  return { ok: true, id: id, count: items.length };
}

/* -------------------- 跨域取图代理 -------------------- */

function bufferToBase64(buffer) {
  const bytes = new Uint8Array(buffer);
  const chunk = 0x8000;
  let binary = '';
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

async function proxyFetch(url) {
  if (!/^https?:\/\//i.test(String(url || ''))) throw new Error('不支持的地址');

  const response = await fetch(url, {
    credentials: 'omit',
    cache: 'force-cache',
    redirect: 'follow'
  });
  if (!response.ok) throw new Error('HTTP ' + response.status);

  const buffer = await response.arrayBuffer();
  if (!buffer.byteLength) throw new Error('图片内容为空');
  if (buffer.byteLength > MAX_PROXY_BYTES) throw new Error('图片超过 30MB，无法代理获取');

  const type = response.headers.get('content-type') || 'application/octet-stream';
  return {
    ok: true,
    dataUrl: 'data:' + type.split(';')[0] + ';base64,' + bufferToBase64(buffer)
  };
}

/* -------------------- 读取页面全局状态 -------------------- */

const MAX_STATE_CHARS = 4000000;

/**
 * content script 运行在隔离世界，读不到页面自己的 window.__INITIAL_STATE__ 等变量，
 * 因此在 MAIN world 执行一次取值脚本，把序列化后的状态回传给 content script 做正则提取。
 */
async function getPageState(tabId) {
  if (typeof tabId !== 'number') throw new Error('无法定位当前标签页');

  const injection = await chrome.scripting.executeScript({
    target: { tabId: tabId },
    world: 'MAIN',
    func: function () {
      const keys = [
        '__INITIAL_STATE__',
        '__NEXT_DATA__',
        '__NUXT__',
        '__PRELOADED_STATE__',
        '__INITIAL_DATA__',
        '__PAGE_DATA__'
      ];
      const out = {};
      for (let i = 0; i < keys.length; i++) {
        try {
          const value = window[keys[i]];
          if (value && typeof value === 'object') out[keys[i]] = value;
        } catch (e) { /* 忽略不可访问的属性 */ }
      }
      try {
        return JSON.stringify(out);
      } catch (e) {
        return '';
      }
    }
  });

  const text = injection && injection[0] ? injection[0].result : '';
  if (!text || typeof text !== 'string') return { ok: true, text: '' };
  return { ok: true, text: text.slice(0, MAX_STATE_CHARS) };
}

/* -------------------- 消息路由 -------------------- */

chrome.runtime.onMessage.addListener(function (message, sender, sendResponse) {
  if (!message || typeof message.type !== 'string') return undefined;

  if (message.type === 'OPEN_GALLERY') {
    openGallery(message.payload)
      .then(sendResponse)
      .catch(function (error) {
        sendResponse({ ok: false, error: (error && error.message) || '打开选择页失败' });
      });
    return true;
  }

  if (message.type === 'FETCH_IMAGE_PROXY') {
    proxyFetch(message.url)
      .then(sendResponse)
      .catch(function (error) {
        sendResponse({ ok: false, error: (error && error.message) || '代理获取失败' });
      });
    return true;
  }

  if (message.type === 'GET_PAGE_STATE') {
    const tabId = sender && sender.tab ? sender.tab.id : null;
    getPageState(tabId)
      .then(sendResponse)
      .catch(function (error) {
        sendResponse({ ok: false, error: (error && error.message) || '读取页面状态失败' });
      });
    return true;
  }

  return undefined;
});

/* -------------------- 工具栏图标：打开上次结果 -------------------- */

chrome.action.onClicked.addListener(async function () {
  try {
    const data = await chrome.storage.session.get(LAST_KEY);
    const lastId = data[LAST_KEY];
    if (lastId) {
      const key = RESULT_PREFIX + lastId;
      const exist = await chrome.storage.session.get(key);
      if (exist[key]) {
        await chrome.tabs.create({ url: galleryUrl(lastId) });
        return;
      }
    }
  } catch (e) { /* 忽略，落到空白页 */ }
  await chrome.tabs.create({ url: galleryUrl() });
});

chrome.runtime.onInstalled.addListener(function () {
  pruneResults().catch(function () { /* 忽略 */ });
});
