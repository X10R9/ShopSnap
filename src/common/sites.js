/**
 * 站点配置表
 * 经典脚本（非 ES Module），由 content script、service worker（importScripts）和图片选择页共同加载。
 * 新增站点只需要在 SITES 里追加一条配置，提取与下载主流程无需改动。
 */
(function () {
  'use strict';

  /* -------------------- CDN 域名白名单 -------------------- */
  const ALICDN = [/(^|\.)alicdn\.com$/i, /(^|\.)taobaocdn\.com$/i];
  const JDIMG = [/(^|\.)360buyimg\.com$/i, /(^|\.)jd\.com$/i];
  const PDDIMG = [/(^|\.)pddpic\.com$/i, /(^|\.)yangkeduo\.com$/i];

  /* -------------------- URL 归一化 -------------------- */

  function stripParams(url, names) {
    try {
      const u = new URL(url);
      names.forEach(function (name) {
        u.searchParams.delete(name);
      });
      return u.href;
    } catch (e) {
      return url;
    }
  }

  /**
   * 淘宝 / 天猫：把缩略图后缀还原成原图
   *   xxx.jpg_400x400.jpg   -> xxx.jpg
   *   xxx.jpg_400x400q90.jpg -> xxx.jpg
   *   xxx.jpg_q90.jpg       -> xxx.jpg
   *   xxx.jpg_.webp         -> xxx.jpg
   */
  function normalizeTaobao(url) {
    let u = String(url);
    // xxx.jpg_.webp -> xxx.jpg
    u = u.replace(/_\.webp(?=$|[?#])/i, '');
    // xxx.jpg_400x400.jpg / xxx.jpg_60x60q90.jpg / xxx.jpg_q90.jpg -> xxx.jpg
    u = u.replace(
      /(?:_\d+x\d+(?:q\d+)?|_\d+x\d+[a-z]\d*|_q\d+|_sum|_b)\.(?:jpe?g|png|webp|gif)(?=$|[?#])/gi,
      ''
    );
    return stripParams(u, ['spm', 'scm', 'from', 't', '_t', 'wx_fmt']);
  }

  /**
   * 京东：/n0/ 表示原图，/s450x450_jfs/ 为缩略图，!q70.dpg 为水印压缩参数
   */
  function normalizeJd(url) {
    let u = String(url).split('?')[0].split('#')[0];
    u = u.replace(/\/n\d+\//i, '/n0/');
    u = u.replace(/\/s\d+x\d+_jfs\//i, '/jfs/');
    u = u.replace(/\/s\d+x\d+_/i, '/');
    u = u.replace(/!q\d+(?:\.(?:dpg|jpe?g|png|webp))?$/i, '');
    return u;
  }

  /**
   * 拼多多：?imageView2/2/w/800/q/70 之类的缩放参数直接去掉
   */
  function normalizePdd(url) {
    return String(url).replace(/\?(?:imageView2|imageMogr2|imageView|thumbnail|image)[^#]*$/i, '');
  }

  /* -------------------- 站点配置 -------------------- */
  const SITES = [
    {
      id: 'taobao',
      name: '淘宝 / 天猫',
      shortName: '淘宝',
      color: '#ff5000',
      hostPatterns: [/(^|\.)taobao\.com$/i, /(^|\.)tmall\.com$/i],
      detailUrl: {
        include: [/\/item\.htm/i, /\/detail\.htm/i, /^\/item\//i, /\/i\d+\.htm/i],
        exclude: [/\/list\.htm/i, /\/search/i, /\/cart/i, /login/i, /\/market\//i, /\/trade\//i]
      },
      titleSelectors: [
        '.tb-main-title',
        '#J_Title .tb-main-title',
        '.tb-detail-hd h1',
        'h1[class*="title"]',
        '[class*="ItemHeader"] [class*="title"]',
        '[class*="mainTitle"]'
      ],
      cdnHosts: ALICDN,
      productPathHints: [/\/imgextra\//i, /\/bao\/uploaded\//i, /\/i\d\//i],
      selectors: {
        main: [
          '#J_ImgBooth',
          '#J_UlThumb',
          '.tb-booth',
          '.tb-gallery',
          '[class*="mainPic"]',
          '[class*="MainImage"]',
          '[class*="picGallery"]',
          '[class*="thumbnail"]'
        ],
        sku: ['[class*="sku"]', '[class*="Sku"]', '[class*="prop"]'],
        detail: ['#description', '#J_DivItemDesc', '#J_Detail', '[class*="detail" i]', '[class*="desc" i]']
      },
      backgroundSelectors: ['#J_ImgBooth', '[class*="mainPic"]', '[class*="thumb"]'],
      normalize: normalizeTaobao
    },
    {
      id: 'jd',
      name: '京东',
      shortName: '京东',
      color: '#e1251b',
      hostPatterns: [/(^|\.)jd\.com$/i, /(^|\.)jd\.hk$/i],
      detailUrl: {
        include: [/^\/\d+\.html?$/i, /^\/product\/\d+\.html/i],
        exclude: [/\/list\.html/i, /search/i, /cart/i, /login/i, /\/order\//i]
      },
      titleSelectors: ['.sku-name', '.itemInfo-wrap .sku-name', 'div.sku-name', 'h1[class*="title"]', '.product-intro h1'],
      cdnHosts: JDIMG,
      productPathHints: [/\/jfs\//i, /\/imgzone\//i, /\/popWaterMark\//i],
      selectors: {
        main: ['#spec-img', '#spec-n1 img', '.jqzoom', '[class*="main-img"]', '[class*="preview"]', '[class*="thumb"]'],
        sku: ['#choose-attr', '[class*="choose-attr"]', '[class*="sku"]'],
        detail: ['#detail', '#J-detail-content', '[class*="detail"]', '[class*="desc"]']
      },
      backgroundSelectors: ['#spec-img', '[class*="main-img"]', '[class*="thumb"]'],
      normalize: normalizeJd
    },
    {
      // 必须放在 pdd 之前：findSite 取下第一条命中的配置
      id: 'pdd-mms',
      name: '拼多多商家版',
      shortName: '拼多多商家',
      color: '#e02e24',
      hostPatterns: [/^mms\.pinduoduo\.com$/i],
      detailUrl: {
        include: [/^\/goods\/(?!goods_list|goods_search)/i, /^\/goods\.html/i],
        exclude: [/goods_list/i, /goods_search/i, /\/login/i]
      },
      titleSelectors: [
        '[class*="goodsName"]',
        '[class*="goods-name"]',
        '[class*="goodsTitle"]',
        '[class*="goods-title"]',
        'h1'
      ],
      cdnHosts: PDDIMG,
      productPathHints: [/\/gaudit-image\//i, /\/mms-material-img\//i, /\/goods\//i, /\/open\//i],
      selectors: {
        main: ['[class*="mainImage"]', '[class*="main-image"]', '[class*="goodsImage"]', '[class*="carousel"]', '[class*="banner"]'],
        sku: ['[class*="sku"]', '[class*="spec"]'],
        detail: ['[class*="detail"]', '[class*="description"]', '[class*="richText"]']
      },
      backgroundSelectors: ['[class*="mainImage"]', '[class*="carousel"]'],
      normalize: normalizePdd
    },
    {
      id: 'pdd',
      name: '拼多多',
      shortName: '拼多多',
      color: '#e02e24',
      hostPatterns: [/(^|\.)yangkeduo\.com$/i, /(^|\.)pinduoduo\.com$/i],
      detailUrl: {
        include: [/\/goods\d*\.html/i, /\/goods2?\.html/i],
        exclude: [/login/i, /\/search/i, /goods_list/i]
      },
      titleSelectors: ['[class*="goodsName"]', '[class*="goods-name"]', '[class*="goodsTitle"]', 'h1'],
      cdnHosts: PDDIMG,
      productPathHints: [/\/gaudit-image\//i, /\/mms-material-img\//i, /\/goods\//i, /\/open\//i],
      selectors: {
        main: ['[class*="mainImage"]', '[class*="main-image"]', '[class*="goodsImage"]', '[class*="carousel"]', '[class*="banner"]'],
        sku: ['[class*="sku"]', '[class*="spec"]'],
        detail: ['[class*="detail"]', '[class*="description"]', '[class*="richText"]']
      },
      backgroundSelectors: ['[class*="mainImage"]', '[class*="carousel"]'],
      normalize: normalizePdd
    }
  ];

  /* -------------------- 对外 API -------------------- */

  function findSite(url) {
    let host = '';
    try {
      host = new URL(url).hostname;
    } catch (e) {
      return null;
    }
    for (let i = 0; i < SITES.length; i++) {
      if (SITES[i].hostPatterns.some(function (re) { return re.test(host); })) return SITES[i];
    }
    return null;
  }

  function isDetailPage(url, site) {
    if (!site) return false;
    let u;
    try {
      u = new URL(url);
    } catch (e) {
      return false;
    }
    const target = u.pathname + u.search;
    const exclude = site.detailUrl.exclude || [];
    const include = site.detailUrl.include || [];
    if (exclude.some(function (re) { return re.test(target); })) return false;
    return include.some(function (re) { return re.test(target); });
  }

  function getSite(id) {
    for (let i = 0; i < SITES.length; i++) {
      if (SITES[i].id === id) return SITES[i];
    }
    return null;
  }

  globalThis.ECI_SITES = SITES;
  globalThis.ECI_SITE_API = {
    findSite: findSite,
    isDetailPage: isDetailPage,
    getSite: getSite
  };
})();
