/**
 * 图片提取器（仅运行在 content script 环境）
 * 职责：收集图片候选 -> 清洗/归一化/去重 -> 按「主图 -> SKU -> 详情 -> 其他」排序
 */
(function () {
  'use strict';

  const U = globalThis.ECI_UTILS;

  /* 常见懒加载属性，顺序即优先级 */
  const LAZY_ATTRS = [
    'src',
    'data-src',
    'data-lazy-src',
    'data-original',
    'data-ks-lazyload',
    'data-lazyload',
    'data-lazy',
    'data-url',
    'data-image',
    'data-img',
    'data-echo',
    'data-original-src'
  ];

  /* 图标 / 占位图 / 装饰图黑名单 */
  const JUNK_RE =
    /(?:^|[/_.-])(icon|logo|avatar|sprite|loading|placeholder|blank|spacer|pixel|transparent|noimage|nopic|default-img|bg_img)(?:[/_.-]|$)/i;

  const SOURCE_RANK = { main: 0, sku: 1, detail: 2, page: 3, json: 4 };

  /* 明确小于该边长的图片直接丢弃（图标级别），更细的阈值交给选择页 */
  const HARD_MIN_SIDE = 60;

  const MAX_SCROLL_MS = 6000;
  const SCROLL_STEP_RATIO = 1.1;
  const SCROLL_DELAY_MS = 150;

  /* -------------------- 页面标题 -------------------- */

  function getPageTitle(site) {
    const clean = function (text) {
      return String(text == null ? '' : text).replace(/\s+/g, ' ').trim();
    };

    const selectors = (site && site.titleSelectors) || [];
    for (let i = 0; i < selectors.length; i++) {
      let el = null;
      try {
        el = document.querySelector(selectors[i]);
      } catch (e) { /* 忽略非法选择器 */ }
      const text = el ? clean(el.textContent) : '';
      if (text.length >= 2) return text.slice(0, 80);
    }

    const meta =
      document.querySelector('meta[property="og:title"]') ||
      document.querySelector('meta[name="title"]');
    if (meta) {
      const text = clean(meta.getAttribute('content'));
      if (text.length >= 2) return text.slice(0, 80);
    }

    const docTitle = clean(document.title);
    if (docTitle) {
      return docTitle
        .replace(/[-_|–—]\s*(淘宝网|天猫|京东|拼多多|拼多多商家版).*$/i, '')
        .slice(0, 80);
    }

    const h1 = document.querySelector('h1');
    return h1 ? clean(h1.textContent).slice(0, 80) : '';
  }

  /* -------------------- 站点/来源判断 -------------------- */

  function isProductUrl(url, site, opts) {
    let u;
    try {
      u = new URL(url);
    } catch (e) {
      return false;
    }
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return false;
    if (u.pathname.length < 4) return false;

    const hostOk = (site.cdnHosts || []).some(function (re) {
      return re.test(u.hostname);
    });
    if (!hostOk) return false;

    const hints = site.productPathHints || [];
    if (!hints.length) return true;
    const target = u.pathname + u.search;
    if (hints.some(function (re) { return re.test(target); })) return true;

    // 兜底：DOM 中真实渲染出来的大图，即使路径不符合特征也保留
    return !!(opts && opts.allowHintMiss);
  }

  function makeRow(raw, width, height, source, site, opts) {
    if (!raw) return null;
    const url = U.normalizeImageUrl(raw, site, location.href);
    if (!url) return null;
    if (JUNK_RE.test(url)) return null;
    if (!isProductUrl(url, site, opts)) return null;
    // 主图 / SKU 图在页面上通常是缩略图（如 60×60），其 URL 已还原为原图，不能按渲染尺寸丢弃
    const isThumbSource = source === 'main' || source === 'sku';
    if (width && height && Math.min(width, height) < HARD_MIN_SIDE && !isThumbSource) return null;
    return {
      url: url,
      width: width || 0,
      height: height || 0,
      source: source || 'page',
      order: 0
    };
  }

  /**
   * 一次性扫描主图 / SKU / 详情容器，建立 img -> 来源 的映射，避免对每张图重复 closest。
   */
  function buildSourceMap(site) {
    const map = new WeakMap();
    const keys = ['main', 'sku', 'detail'];
    for (let k = 0; k < keys.length; k++) {
      const key = keys[k];
      const selectors = (site.selectors && site.selectors[key]) || [];
      for (let s = 0; s < selectors.length; s++) {
        let roots;
        try {
          roots = document.querySelectorAll(selectors[s]);
        } catch (e) {
          continue;
        }
        for (let r = 0; r < roots.length; r++) {
          const root = roots[r];
          const imgs = root.tagName === 'IMG' ? [root] : root.querySelectorAll('img');
          for (let i = 0; i < imgs.length; i++) {
            if (!map.has(imgs[i])) map.set(imgs[i], key);
          }
        }
      }
    }
    return map;
  }

  function classifyByClosest(el, site) {
    const keys = ['main', 'sku', 'detail'];
    for (let k = 0; k < keys.length; k++) {
      const selectors = (site.selectors && site.selectors[keys[k]]) || [];
      for (let s = 0; s < selectors.length; s++) {
        try {
          if (el.closest(selectors[s])) return keys[k];
        } catch (e) { /* 忽略 */ }
      }
    }
    return 'page';
  }

  /* -------------------- 各类图片来源 -------------------- */

  function collectFromDom(site, sourceMap, rows) {
    const imgs = document.images || [];
    for (let i = 0; i < imgs.length; i++) {
      const el = imgs[i];
      const nw = el.naturalWidth || 0;
      const nh = el.naturalHeight || 0;
      const source = sourceMap.get(el) || 'page';
      const allowHintMiss = nw >= 400 && (source === 'main' || source === 'sku');

      const candidates = [];
      for (let a = 0; a < LAZY_ATTRS.length; a++) {
        const value = el.getAttribute(LAZY_ATTRS[a]);
        if (value) candidates.push(value);
      }

      const srcset = el.getAttribute('srcset') || el.getAttribute('data-srcset');
      if (srcset) {
        const best = U.parseSrcset(srcset);
        if (best) candidates.push(best);
      }
      if (el.currentSrc) candidates.push(el.currentSrc);

      for (let c = 0; c < candidates.length; c++) {
        const row = makeRow(candidates[c], nw, nh, source, site, { allowHintMiss: allowHintMiss });
        if (row) rows.push(row);
      }
    }
  }

  function cssUrls(backgroundImage) {
    const out = [];
    if (!backgroundImage || backgroundImage === 'none') return out;
    const re = /url\((['"]?)([^'")]+)\1\)/gi;
    let m;
    while ((m = re.exec(backgroundImage))) {
      if (m[2]) out.push(m[2]);
    }
    return out;
  }

  function collectFromBackground(site, rows) {
    const candidates = new Set();
    const inlineSelectors = ['[style*="background"]', '[style*="Background"]', '[style*="BACKGROUND"]'];
    for (let i = 0; i < inlineSelectors.length; i++) {
      try {
        document.querySelectorAll(inlineSelectors[i]).forEach(function (el) { candidates.add(el); });
      } catch (e) { /* 忽略 */ }
    }
    (site.backgroundSelectors || []).forEach(function (sel) {
      try {
        document.querySelectorAll(sel).forEach(function (el) { candidates.add(el); });
      } catch (e) { /* 忽略 */ }
    });

    let count = 0;
    candidates.forEach(function (el) {
      if (count++ > 3000) return;
      let bg = '';
      try {
        bg = getComputedStyle(el).backgroundImage;
      } catch (e) {
        return;
      }
      const urls = cssUrls(bg);
      if (!urls.length) return;
      const source = classifyByClosest(el, site);
      let rect = { width: 0, height: 0 };
      try {
        rect = el.getBoundingClientRect();
      } catch (e) { /* 忽略 */ }
      const allowHintMiss = rect.width >= 240 && rect.height >= 240;
      for (let i = 0; i < urls.length; i++) {
        const row = makeRow(urls[i], 0, 0, source, site, { allowHintMiss: allowHintMiss });
        if (row) rows.push(row);
      }
    });
  }

  const INLINE_URL_RE = /https?:\/\/[^\s"'<>()\\]+?\.(?:jpe?g|png|webp|gif)(?:\?[^\s"'<>()\\]*)?/gi;

  /**
   * 从任意文本（内联 JSON、页面全局状态的序列化结果）里提取图片地址
   * 只接受命中 CDN 白名单且路径符合商品图特征的地址，避免把埋点/装饰图带进来
   */
  function collectFromText(text, site, rows) {
    if (!text || typeof text !== 'string') return 0;
    const normalized = text.indexOf('\\/') >= 0 ? text.replace(/\\\//g, '/') : text;
    let produced = 0;
    let guard = 0;
    INLINE_URL_RE.lastIndex = 0;
    let m;
    while ((m = INLINE_URL_RE.exec(normalized)) && guard < 4000) {
      guard++;
      if (produced >= 1500) break;
      const url = m[0];
      if (JUNK_RE.test(url)) continue;
      const row = makeRow(url, 0, 0, 'json', site, { allowHintMiss: false });
      if (row) {
        rows.push(row);
        produced++;
      }
    }
    return produced;
  }

  /**
   * 扫描内联 script 中的 JSON 图片地址，覆盖「还没滚动到、还没渲染」的图片
   */
  function collectFromJson(site, rows) {
    const texts = [];
    const globals = ['__INITIAL_STATE__', '__NEXT_DATA__', '__NUXT__', '__PRELOADED_STATE__', '__INITIAL_DATA__', '__PAGE_DATA__'];
    for (let i = 0; i < globals.length; i++) {
      try {
        const value = window[globals[i]];
        if (value && typeof value === 'object') texts.push(JSON.stringify(value));
      } catch (e) { /* 循环引用等，忽略 */ }
    }

    const scripts = document.querySelectorAll('script');
    for (let i = 0; i < scripts.length; i++) {
      const script = scripts[i];
      if (script.src) continue;
      const text = script.textContent || '';
      if (text.length < 40 || text.length > 8000000) continue;
      if (!/\.(?:jpe?g|png|webp|gif)/i.test(text)) continue;
      texts.push(text);
    }

    for (let i = 0; i < texts.length; i++) {
      collectFromText(texts[i], site, rows);
    }
  }

  /* -------------------- 懒加载预加载 -------------------- */

  function waitForImages() {
    const images = document.images || [];
    const pending = [];
    for (let i = 0; i < images.length; i++) {
      if (!images[i].complete) pending.push(images[i]);
    }
    if (!pending.length) return Promise.resolve();
    return Promise.all(
      pending.map(function (img) {
        return new Promise(function (resolve) {
          let settled = false;
          const done = function () {
            if (settled) return;
            settled = true;
            resolve();
          };
          img.addEventListener('load', done, { once: true });
          img.addEventListener('error', done, { once: true });
          setTimeout(done, 2000);
        });
      })
    );
  }

  function documentHeight() {
    const doc = document.documentElement;
    return Math.max(
      doc ? doc.scrollHeight : 0,
      document.body ? document.body.scrollHeight : 0
    );
  }

  async function autoScroll(onProgress) {
    const startY = window.scrollY || window.pageYOffset || 0;
    if (documentHeight() <= window.innerHeight * 1.4) return false;

    if (onProgress) onProgress('正在滚动加载页面…');
    const started = Date.now();
    let lastHeight = 0;
    let stableRounds = 0;
    let lastY = -1;
    let stuckRounds = 0;

    while (Date.now() - started < MAX_SCROLL_MS) {
      window.scrollBy(0, Math.floor(window.innerHeight * SCROLL_STEP_RATIO));
      await U.sleep(SCROLL_DELAY_MS);

      // 页面使用内部滚动容器时 scrollBy 无效，连续无位移则提前结束
      const currentY = window.scrollY || 0;
      if (currentY === lastY) {
        stuckRounds++;
        if (stuckRounds >= 3) break;
      } else {
        stuckRounds = 0;
      }
      lastY = currentY;

      const height = documentHeight();
      const atBottom = window.innerHeight + currentY >= height - 4;
      if (atBottom) {
        if (height === lastHeight) stableRounds++;
        else stableRounds = 0;
        lastHeight = height;
        if (stableRounds >= 2) break;
        await U.sleep(280);
      }
    }

    window.scrollTo(0, startY);
    await U.sleep(200);
    await waitForImages();
    return true;
  }

  /* -------------------- 汇总 -------------------- */

  function finalize(rows) {
    const map = new Map();
    let order = 0;

    for (let i = 0; i < rows.length; i++) {
      const row = rows[i];
      if (!row) continue;
      const exist = map.get(row.url);
      if (exist) {
        if (!exist.width && row.width) {
          exist.width = row.width;
          exist.height = row.height;
        }
        if (SOURCE_RANK[row.source] < SOURCE_RANK[exist.source]) exist.source = row.source;
        continue;
      }
      row.order = order++;
      row.ext = U.extOf(row.url) || 'jpg';
      row.animated = /^gif$/i.test(row.ext);
      map.set(row.url, row);
    }

    const list = Array.from(map.values());
    list.sort(function (a, b) {
      const rankA = SOURCE_RANK[a.source] == null ? 9 : SOURCE_RANK[a.source];
      const rankB = SOURCE_RANK[b.source] == null ? 9 : SOURCE_RANK[b.source];
      if (rankA !== rankB) return rankA - rankB;
      return a.order - b.order;
    });

    return list.map(function (item, index) {
      return {
        url: item.url,
        width: item.width,
        height: item.height,
        source: item.source,
        ext: item.ext,
        animated: item.animated,
        index: index
      };
    });
  }

  /**
   * 提取入口
   * @param {object} site   站点配置
   * @param {object} options { preload: boolean, onProgress: (text) => void }
   */
  async function extractImages(site, options) {
    const opts = options || {};
    const preload = opts.preload !== false;

    if (preload) {
      try {
        await autoScroll(opts.onProgress);
      } catch (e) { /* 滚动失败不影响提取 */ }
    }
    if (opts.onProgress) opts.onProgress('正在提取图片…');

    const sourceMap = buildSourceMap(site);
    const rows = [];
    collectFromDom(site, sourceMap, rows);
    collectFromBackground(site, rows);
    collectFromJson(site, rows);

    // 页面全局状态（如 window.__INITIAL_STATE__）内容脚本读不到，交给后台在 MAIN world 读取后回传
    if (typeof opts.getStateText === 'function') {
      let stateText = '';
      try {
        stateText = await opts.getStateText();
      } catch (e) {
        stateText = '';
      }
      if (stateText) collectFromText(stateText, site, rows);
    }

    return finalize(rows);
  }

  globalThis.ECI_EXTRACT = {
    extractImages: extractImages,
    getPageTitle: getPageTitle,
    autoScroll: autoScroll
  };
})();
