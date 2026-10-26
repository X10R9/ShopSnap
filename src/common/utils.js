/**
 * 通用工具函数
 * 经典脚本，挂载到 globalThis.ECI_UTILS，content script / service worker / 图片选择页共用。
 * 注意：本文件不得在顶层直接使用 location、document 等仅页面上下文存在的对象。
 */
(function () {
  'use strict';

  function sleep(ms) {
    return new Promise(function (resolve) {
      setTimeout(resolve, ms);
    });
  }

  function extOf(url) {
    try {
      const u = new URL(url, 'https://example.com/');
      const m = /\.(jpe?g|png|webp|gif|bmp|avif)$/i.exec(u.pathname);
      return m ? m[1].toLowerCase() : '';
    } catch (e) {
      return '';
    }
  }

  /**
   * 解析 srcset，优先取宽度描述符（w）最大的一项；
   * 只有像素密度描述符（x）时取密度最高的一项，避免把 2x 误判成比 800w 更大。
   */
  function parseSrcset(value) {
    if (!value) return '';
    const parts = String(value).split(',');
    let bestWidth = '';
    let bestWidthScore = -1;
    let bestDensity = '';
    let bestDensityScore = -1;

    for (let i = 0; i < parts.length; i++) {
      const bits = parts[i].trim().split(/\s+/);
      const url = bits[0];
      if (!url) continue;
      const desc = bits[1] || '';

      if (/^\d+w$/i.test(desc)) {
        const width = parseInt(desc, 10);
        if (width > bestWidthScore) {
          bestWidthScore = width;
          bestWidth = url;
        }
      } else if (/^[\d.]+x$/i.test(desc)) {
        const density = parseFloat(desc);
        if (density > bestDensityScore) {
          bestDensityScore = density;
          bestDensity = url;
        }
      } else if (bestWidthScore < 1) {
        bestWidthScore = 1;
        bestWidth = url;
      }
    }

    return bestWidth || bestDensity || '';
  }

  /**
   * 清洗文件名：去掉 Windows 非法字符、控制字符、首尾点与空格
   */
  function sanitizeFilename(name, maxLen) {
    let s = String(name == null ? '' : name)
      .replace(/[\u0000-\u001f\u007f]/g, '')
      .replace(/[<>:"/\\|?*]+/g, ' ')
      .replace(/\s+/g, ' ')
      .replace(/^[.\s]+|[.\s]+$/g, '');
    if (maxLen && maxLen > 0 && s.length > maxLen) s = s.slice(0, maxLen).trim();
    return s || '未命名';
  }

  function formatBytes(bytes) {
    if (!bytes || bytes <= 0) return '0 KB';
    if (bytes < 1024) return bytes + ' B';
    const kb = bytes / 1024;
    if (kb < 1024) return kb.toFixed(kb < 10 ? 1 : 0) + ' KB';
    return (kb / 1024).toFixed(1) + ' MB';
  }

  /**
   * 粗略估算图片体积（仅用于界面提示，不代表真实大小）
   */
  function estimateBytes(w, h) {
    if (!w || !h) return 0;
    return Math.round(w * h * 0.45);
  }

  function isHttpUrl(value) {
    return /^https?:\/\//i.test(String(value || ''));
  }

  /**
   * 把页面里拿到的各种写法规范化成可用的图片绝对地址
   * 处理：空白/引号、&amp;、协议相对地址、相对路径、data:/blob: 等无效地址、
   *       站点自定义的缩略图后缀还原、hash 去除。
   */
  function normalizeImageUrl(raw, site, baseUrl) {
    if (raw == null) return null;
    let value = String(raw).trim();
    if (!value) return null;
    value = value.replace(/^['"]+|['"]+$/g, '').replace(/&amp;/g, '&');
    if (/^(data|blob|javascript|about|chrome|edge|file|mailto|tel):/i.test(value)) return null;

    if (value.indexOf('//') === 0) {
      let proto = 'https:';
      try {
        if (baseUrl) proto = new URL(baseUrl).protocol;
      } catch (e) { /* 用默认 https */ }
      value = proto + value;
    }

    let u;
    try {
      u = new URL(value, baseUrl || 'https://example.com/');
    } catch (e) {
      return null;
    }
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
    u.hash = '';

    let href = u.href;
    if (site && typeof site.normalize === 'function') {
      try {
        href = site.normalize(href);
      } catch (e) { /* 归一化失败则使用原地址 */ }
    }
    if (!isHttpUrl(href)) return null;
    return href;
  }

  function randomId() {
    try {
      if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') return crypto.randomUUID();
    } catch (e) { /* 降级 */ }
    return 'id-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 10);
  }

  globalThis.ECI_UTILS = {
    sleep: sleep,
    extOf: extOf,
    parseSrcset: parseSrcset,
    sanitizeFilename: sanitizeFilename,
    formatBytes: formatBytes,
    estimateBytes: estimateBytes,
    isHttpUrl: isHttpUrl,
    normalizeImageUrl: normalizeImageUrl,
    randomId: randomId
  };
})();
