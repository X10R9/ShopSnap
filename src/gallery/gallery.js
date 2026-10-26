/**
 * 图片选择页逻辑
 * 读取 service worker 暂存的提取结果 -> 网格展示 -> 勾选 -> 转 PNG 下载
 */
(function () {
  'use strict';

  const U = globalThis.ECI_UTILS;
  const SITES = globalThis.ECI_SITES || [];

  const CONCURRENCY = 3;
  const THROTTLE_MS = 180;
  // 浏览器画布上限（Chrome/Edge 经验值），超出则降级为保存原格式
  const MAX_CANVAS_AREA = 268435456;
  const MAX_CANVAS_SIDE = 32767;

  const SOURCE_LABELS = {
    main: '主图',
    sku: 'SKU',
    detail: '详情',
    page: '页面',
    json: '页面数据'
  };

  const STATE_ICONS = {
    empty:
      '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">' +
      '<rect x="3" y="4" width="18" height="16" rx="2.5"></rect>' +
      '<circle cx="8.5" cy="9.5" r="1.4" fill="currentColor" stroke="none"></circle>' +
      '<path d="M4 17.2l4.6-4.6 3.1 3.1 3.4-3.4L20 17"></path></svg>',
    error:
      '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">' +
      '<circle cx="12" cy="12" r="9"></circle><path d="M12 7.5v5.5"></path>' +
      '<circle cx="12" cy="16.5" r="1" fill="currentColor" stroke="none"></circle></svg>'
  };

  const state = {
    record: null,
    items: [],
    filtered: [],
    selected: new Set(),
    previewId: null,
    downloading: false,
    done: 0,
    total: 0,
    minSide: 200,
    sourceFilter: 'all',
    sortBy: 'origin'
  };

  const els = {};

  /* -------------------- DOM 初始化 -------------------- */

  function cacheEls() {
    const ids = [
      'siteChip', 'pageTitle', 'pageSub', 'grid', 'state', 'stateIcon', 'stateTitle', 'stateDesc',
      'selCount', 'totalCount', 'estSize', 'downloadBtn', 'progressWrap', 'progressBar', 'progressText',
      'retryFailed', 'preview', 'previewImg', 'previewIndex', 'previewDim', 'previewSelect',
      'previewDownload', 'toasts', 'sourceFilter', 'minSide', 'sortBy'
    ];
    ids.forEach(function (id) {
      els[id] = document.getElementById(id);
    });
  }

  function showState(kind, title, desc) {
    els.state.hidden = false;
    els.state.dataset.kind = kind || 'empty';
    els.stateTitle.textContent = title || '';
    els.stateDesc.textContent = desc || '';
    els.stateIcon.innerHTML = kind === 'loading' ? '' : (STATE_ICONS[kind] || STATE_ICONS.empty);
  }

  function hideState() {
    els.state.hidden = true;
  }

  function toast(message, type, duration) {
    if (!message) return;
    const el = document.createElement('div');
    el.className = 'toast ' + (type || 'info');
    el.textContent = message;
    els.toasts.appendChild(el);
    requestAnimationFrame(function () {
      el.classList.add('show');
    });
    setTimeout(function () {
      el.classList.remove('show');
      setTimeout(function () {
        if (el.parentNode) el.parentNode.removeChild(el);
      }, 240);
    }, duration || 3200);
  }

  function formatTime(ts) {
    if (!ts) return '';
    const d = new Date(ts);
    if (isNaN(d.getTime())) return '';
    const pad = function (n) {
      return n < 10 ? '0' + n : String(n);
    };
    return pad(d.getMonth() + 1) + '-' + pad(d.getDate()) + ' ' + pad(d.getHours()) + ':' + pad(d.getMinutes());
  }

  /* -------------------- 表头 -------------------- */

  function setHeader() {
    const record = state.record || {};
    const site = findSite(record.siteId);
    const name = (site && site.name) || record.siteName || '';

    els.siteChip.hidden = !name;
    els.siteChip.textContent = name;
    if (site && site.color) els.siteChip.style.setProperty('--chip', site.color);

    els.pageTitle.textContent = record.title || '未命名商品';

    let host = '';
    try {
      host = record.pageUrl ? new URL(record.pageUrl).hostname : '';
    } catch (e) {
      host = '';
    }
    const parts = [];
    if (host) parts.push('来源：' + host);
    const time = formatTime(record.createdAt);
    if (time) parts.push('提取于 ' + time);
    els.pageSub.textContent = parts.join(' · ');

    if (record.title) document.title = record.title + ' - 图片选择';
  }

  function findSite(id) {
    for (let i = 0; i < SITES.length; i++) {
      if (SITES[i].id === id) return SITES[i];
    }
    return null;
  }

  /* -------------------- 筛选与渲染 -------------------- */

  function mappedSource(source) {
    if (source === 'main' || source === 'sku' || source === 'detail') return source;
    return 'other';
  }

  function sourceLabel(source) {
    return SOURCE_LABELS[source] || '其他';
  }

  function sourceClass(source) {
    const mapped = mappedSource(source);
    return mapped === 'other' ? 'other' : mapped;
  }

  function sizeText(item) {
    if (item.width && item.height) return item.width + '×' + item.height;
    return '尺寸未知';
  }

  function computeFiltered() {
    const min = state.minSide;
    let list = state.items.filter(function (item) {
      if (state.sourceFilter !== 'all' && mappedSource(item.source) !== state.sourceFilter) return false;
      if (min > 0 && item.width && item.height) {
        // 主图 / SKU 图的页面渲染尺寸往往只是缩略图，真实尺寸以加载后的原图为准，不做尺寸淘汰
        const protectedSource = item.source === 'main' || item.source === 'sku';
        if (!protectedSource && Math.min(item.width, item.height) < min) return false;
      }
      return true;
    });

    if (state.sortBy === 'size') {
      list = list.slice().sort(function (a, b) {
        return b.width * b.height - a.width * a.height;
      });
    }
    return list;
  }

  function applyFilters() {
    state.filtered = computeFiltered();

    if (state.previewId && !state.filtered.some(function (it) { return it.id === state.previewId; })) {
      closePreview();
    }

    renderGrid();
    updateSummary();
  }

  function renderGrid() {
    els.grid.replaceChildren();

    if (!state.items.length) return;

    if (!state.filtered.length) {
      showState('empty', '没有符合筛选条件的图片', '试试把「最小边」调小，或切换「来源」筛选。');
      return;
    }
    hideState();

    const frag = document.createDocumentFragment();
    for (let i = 0; i < state.filtered.length; i++) {
      frag.appendChild(buildCard(state.filtered[i]));
    }
    els.grid.appendChild(frag);
  }

  function buildCard(item) {
    const index = state.items.indexOf(item) + 1;
    const card = document.createElement('div');
    card.className = 'card';
    card.dataset.id = item.id;
    card.tabIndex = 0;
    card.setAttribute('role', 'checkbox');
    card.setAttribute('aria-checked', state.selected.has(item.id) ? 'true' : 'false');
    card.setAttribute('aria-label', '第 ' + index + ' 张图片，' + sourceLabel(item.source));

    const thumb = document.createElement('div');
    thumb.className = 'thumb';

    const img = document.createElement('img');
    img.alt = '第 ' + index + ' 张图片';
    img.loading = 'lazy';
    img.decoding = 'async';
    img.draggable = false;
    img.src = item.url;
    thumb.appendChild(img);

    const tags = document.createElement('div');
    tags.className = 'tags';
    const sourceTag = document.createElement('span');
    sourceTag.className = 'tag source ' + sourceClass(item.source);
    sourceTag.textContent = sourceLabel(item.source);
    tags.appendChild(sourceTag);
    if (item.animated) {
      const animTag = document.createElement('span');
      animTag.className = 'tag anim';
      animTag.textContent = '动图·仅首帧';
      tags.appendChild(animTag);
    }
    thumb.appendChild(tags);

    const meta = document.createElement('div');
    meta.className = 'meta';
    const sizeEl = document.createElement('span');
    sizeEl.className = 'meta-size';
    sizeEl.textContent = sizeText(item);
    const extEl = document.createElement('span');
    extEl.className = 'meta-ext';
    extEl.textContent = (item.ext || 'jpg').toUpperCase();
    meta.appendChild(sizeEl);
    meta.appendChild(extEl);
    thumb.appendChild(meta);

    const check = document.createElement('span');
    check.className = 'check';
    check.innerHTML =
      '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="3" ' +
      'stroke-linecap="round" stroke-linejoin="round"><path d="M5 12.5l4.5 4.5L19 7.5"></path></svg>';
    thumb.appendChild(check);

    const zoom = document.createElement('button');
    zoom.type = 'button';
    zoom.className = 'zoom';
    zoom.setAttribute('aria-label', '预览第 ' + index + ' 张图片');
    zoom.innerHTML =
      '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" ' +
      'stroke-linecap="round"><circle cx="11" cy="11" r="6.5"></circle><path d="M16 16l4 4"></path>' +
      '<path d="M8.5 11h5M11 8.5v5"></path></svg>';
    thumb.appendChild(zoom);

    const status = document.createElement('div');
    status.className = 'status';
    thumb.appendChild(status);

    card.appendChild(thumb);
    card.classList.toggle('selected', state.selected.has(item.id));
    applyStatus(card, item);

    card.addEventListener('click', function (event) {
      if (event.target.closest('.zoom') || event.target.closest('.retry')) return;
      toggleSelect(item.id);
    });

    zoom.addEventListener('click', function (event) {
      event.stopPropagation();
      openPreview(item.id);
    });

    card.addEventListener('dblclick', function (event) {
      event.preventDefault();
      openPreview(item.id);
    });

    card.addEventListener('keydown', function (event) {
      if (event.key === ' ' || event.key === 'Spacebar') {
        event.preventDefault();
        toggleSelect(item.id);
      } else if (event.key === 'Enter') {
        event.preventDefault();
        openPreview(item.id);
      }
    });

    img.addEventListener('load', function () {
      const width = img.naturalWidth || 0;
      const height = img.naturalHeight || 0;
      if (width && height && (width !== item.width || height !== item.height)) {
        // 提取阶段拿到的是页面缩略图尺寸，这里用实际加载的原图尺寸修正
        item.width = width;
        item.height = height;
        sizeEl.textContent = sizeText(item);
        updateSummary();
      }
    }, { once: true });

    img.addEventListener('error', function () {
      card.classList.add('img-error');
      sizeEl.textContent = '预览失败';
    }, { once: true });

    return card;
  }

  function applyStatus(card, item) {
    const holder = card.querySelector('.status');
    if (!holder) return;
    holder.replaceChildren();
    card.classList.remove('status-downloading', 'status-done', 'status-warn', 'status-error');

    if (item.status === 'downloading') {
      card.classList.add('status-downloading');
      holder.textContent = '正在转换…';
    } else if (item.status === 'done') {
      card.classList.add('status-done');
      holder.textContent = '✓ 已下载';
    } else if (item.status === 'warn') {
      card.classList.add('status-warn');
      holder.textContent = item.note || '已按原格式保存';
    } else if (item.status === 'error') {
      card.classList.add('status-error');
      const label = document.createElement('span');
      label.textContent = item.error || '下载失败';
      const retry = document.createElement('button');
      retry.type = 'button';
      retry.className = 'retry';
      retry.textContent = '重试';
      retry.addEventListener('click', function (event) {
        event.stopPropagation();
        retryOne(item);
      });
      holder.appendChild(label);
      holder.appendChild(retry);
    }
  }

  function refreshCard(item) {
    const card = els.grid.querySelector('.card[data-id="' + item.id + '"]');
    if (!card) return;
    applyStatus(card, item);
    const sizeEl = card.querySelector('.meta-size');
    if (sizeEl) sizeEl.textContent = sizeText(item);
    card.classList.toggle('selected', state.selected.has(item.id));
    card.setAttribute('aria-checked', state.selected.has(item.id) ? 'true' : 'false');
  }

  /* -------------------- 选中逻辑 -------------------- */

  function toggleSelect(id) {
    if (state.selected.has(id)) state.selected.delete(id);
    else state.selected.add(id);

    const card = els.grid.querySelector('.card[data-id="' + id + '"]');
    if (card) {
      const on = state.selected.has(id);
      card.classList.toggle('selected', on);
      card.setAttribute('aria-checked', on ? 'true' : 'false');
    }
    if (state.previewId === id) syncPreviewSelect();
    updateSummary();
  }

  function selectVisible(mode) {
    if (mode === 'clear') {
      state.selected.clear();
    } else {
      for (let i = 0; i < state.filtered.length; i++) {
        const id = state.filtered[i].id;
        if (mode === 'invert') {
          if (state.selected.has(id)) state.selected.delete(id);
          else state.selected.add(id);
        } else {
          state.selected.add(id);
        }
      }
    }

    const cards = els.grid.querySelectorAll('.card');
    for (let i = 0; i < cards.length; i++) {
      const on = state.selected.has(cards[i].dataset.id);
      cards[i].classList.toggle('selected', on);
      cards[i].setAttribute('aria-checked', on ? 'true' : 'false');
    }
    if (state.previewId) syncPreviewSelect();
    updateSummary();
  }

  function updateSummary() {
    let count = 0;
    let bytes = 0;
    let unknown = 0;
    state.items.forEach(function (item) {
      if (!state.selected.has(item.id)) return;
      count++;
      if (item.width && item.height) bytes += U.estimateBytes(item.width, item.height);
      else unknown++;
    });

    els.selCount.textContent = String(count);
    els.totalCount.textContent = String(state.items.length);
    els.estSize.textContent = '约 ' + U.formatBytes(bytes) + (unknown ? '+' : '');

    if (state.downloading) {
      els.downloadBtn.textContent = '正在下载…';
      els.downloadBtn.disabled = true;
    } else {
      els.downloadBtn.textContent = '下载选中为 PNG（' + count + '）';
      els.downloadBtn.disabled = count === 0;
    }
  }

  function updateRetryButton() {
    const failed = state.items.filter(function (item) {
      return item.status === 'error';
    });
    els.retryFailed.hidden = failed.length === 0;
    els.retryFailed.textContent = '重试失败项（' + failed.length + '）';
  }

  /* -------------------- 下载 -------------------- */

  function setProgress(done, total) {
    state.done = done;
    state.total = total;
    els.progressWrap.hidden = false;
    els.progressText.textContent = done + ' / ' + total;
    els.progressBar.style.width = total > 0 ? Math.round((done / total) * 100) + '%' : '0%';
  }

  function siteShortName() {
    const site = findSite(state.record && state.record.siteId);
    return (site && site.shortName) || (state.record && state.record.siteName) || '商品';
  }

  function buildFilename(item, width, height, mime) {
    const title = U.sanitizeFilename((state.record && state.record.title) || '商品图片', 30);
    const index = String(state.items.indexOf(item) + 1).padStart(2, '0');
    const dim = width && height ? width + 'x' + height : 'unknown';
    let ext = 'png';
    if (mime && mime !== 'image/png') ext = U.extOf(item.url) || 'jpg';
    const name = U.sanitizeFilename(siteShortName() + '_' + title + '_' + index + '_' + dim, 120);
    return '电商图片/' + name + '.' + ext;
  }

  async function handleDownloadClick() {
    const targets = state.items.filter(function (item) {
      return state.selected.has(item.id) && item.status !== 'done' && item.status !== 'warn';
    });
    if (!targets.length) {
      toast('没有需要下载的图片', 'info');
      return;
    }
    await startDownload(targets);
  }

  async function startDownload(targets) {
    if (state.downloading || !targets.length) return;

    state.downloading = true;
    els.progressWrap.hidden = false;
    setProgress(0, targets.length);
    updateSummary();

    const queue = targets.slice();
    const total = queue.length;
    let ok = 0;
    let failed = 0;
    let completed = 0;

    async function worker() {
      while (queue.length) {
        const item = queue.shift();
        if (!item) break;
        const success = await downloadOne(item);
        if (success) ok++;
        else failed++;
        completed++;
        setProgress(completed, total);
        await U.sleep(THROTTLE_MS);
      }
    }

    const workers = [];
    const workerCount = Math.min(CONCURRENCY, total);
    for (let i = 0; i < workerCount; i++) workers.push(worker());
    await Promise.all(workers);

    state.downloading = false;
    els.progressWrap.hidden = true;
    updateSummary();
    updateRetryButton();

    if (failed > 0) {
      toast(ok + ' 张成功，' + failed + ' 张失败，可点击卡片上的「重试」', 'error', 6000);
    } else {
      toast('已开始下载 ' + ok + ' 张 PNG', 'success');
    }
  }

  async function retryOne(item) {
    if (state.downloading) return;
    state.downloading = true;
    updateSummary();
    els.progressWrap.hidden = false;
    setProgress(0, 1);
    await downloadOne(item);
    setProgress(1, 1);
    setTimeout(function () {
      els.progressWrap.hidden = true;
    }, 600);
    state.downloading = false;
    updateSummary();
    updateRetryButton();
  }

  async function retryAllFailed() {
    const targets = state.items.filter(function (item) {
      return item.status === 'error';
    });
    if (!targets.length) return;
    await startDownload(targets);
  }

  async function downloadOne(item) {
    item.status = 'downloading';
    item.error = '';
    item.note = '';
    refreshCard(item);

    try {
      const sourceBlob = await fetchImageBlob(item.url);
      let outputBlob = sourceBlob;
      let width = item.width;
      let height = item.height;
      let note = '';

      try {
        const png = await convertToPng(sourceBlob);
        outputBlob = png.blob;
        width = png.width;
        height = png.height;
        if (!item.width || !item.height) {
          item.width = width;
          item.height = height;
        }
      } catch (error) {
        if (error && error.code === 'TOO_LARGE') {
          note = '尺寸过大，已保存原格式';
        } else {
          throw error;
        }
      }

      const filename = buildFilename(item, width, height, outputBlob.type);
      const objectUrl = URL.createObjectURL(outputBlob);

      let downloadId;
      try {
        downloadId = await chrome.downloads.download({
          url: objectUrl,
          filename: filename,
          conflictAction: 'uniquify',
          saveAs: false
        });
      } catch (error) {
        URL.revokeObjectURL(objectUrl);
        throw new Error('浏览器拒绝下载：' + ((error && error.message) || '未知原因'));
      }

      releaseObjectUrlLater(downloadId, objectUrl);
      item.status = note ? 'warn' : 'done';
      item.note = note;
      refreshCard(item);
      return true;
    } catch (error) {
      item.status = 'error';
      item.error = (error && error.message) || '下载失败';
      refreshCard(item);
      return false;
    }
  }

  function releaseObjectUrlLater(downloadId, objectUrl) {
    let finished = false;
    const finish = function () {
      if (finished) return;
      finished = true;
      try {
        URL.revokeObjectURL(objectUrl);
      } catch (e) { /* 忽略 */ }
      try {
        chrome.downloads.onChanged.removeListener(onChanged);
      } catch (e) { /* 忽略 */ }
    };

    const onChanged = function (delta) {
      if (!delta || delta.id !== downloadId) return;
      const current = delta.state && delta.state.current;
      if (current === 'complete' || current === 'interrupted') finish();
    };

    if (typeof downloadId !== 'number') {
      setTimeout(finish, 60000);
      return;
    }

    try {
      chrome.downloads.onChanged.addListener(onChanged);
    } catch (e) { /* 忽略 */ }

    // 小文件可能在监听器注册前就已完成，主动查询一次，避免 blob URL 长时间占用内存
    try {
      chrome.downloads
        .search({ id: downloadId })
        .then(function (items) {
          const current = items && items[0] && items[0].state;
          if (current === 'complete' || current === 'interrupted') finish();
        })
        .catch(function () { /* 忽略 */ });
    } catch (e) { /* 忽略 */ }

    setTimeout(finish, 120000);
  }

  /* -------------------- 取图与转 PNG -------------------- */

  async function fetchImageBlob(url) {
    let directError = null;

    try {
      const response = await fetch(url, {
        credentials: 'omit',
        referrerPolicy: 'no-referrer',
        cache: 'force-cache'
      });
      if (!response.ok) throw new Error('HTTP ' + response.status);
      const blob = await response.blob();
      if (!blob.size) throw new Error('图片内容为空');
      return blob;
    } catch (error) {
      directError = error;
    }

    try {
      const result = await chrome.runtime.sendMessage({ type: 'FETCH_IMAGE_PROXY', url: url });
      if (!result || !result.ok) throw new Error((result && result.error) || '代理获取失败');
      const response = await fetch(result.dataUrl);
      const blob = await response.blob();
      if (!blob.size) throw new Error('图片内容为空');
      return blob;
    } catch (error) {
      const reason = (directError && directError.message) || '';
      throw new Error('图片获取失败' + (reason ? '（' + reason + '）' : ''));
    }
  }

  function loadImageElement(url) {
    return new Promise(function (resolve, reject) {
      const img = new Image();
      img.onload = function () {
        resolve(img);
      };
      img.onerror = function () {
        reject(new Error('图片解码失败'));
      };
      img.src = url;
    });
  }

  async function decodeBlob(blob) {
    if (typeof createImageBitmap === 'function') {
      try {
        const bitmap = await createImageBitmap(blob, { imageOrientation: 'from-image' });
        return { source: bitmap, width: bitmap.width, height: bitmap.height, objectUrl: null };
      } catch (e) { /* 继续尝试 */ }
      try {
        const bitmap = await createImageBitmap(blob);
        return { source: bitmap, width: bitmap.width, height: bitmap.height, objectUrl: null };
      } catch (e) { /* 走 Image 兜底 */ }
    }

    const objectUrl = URL.createObjectURL(blob);
    try {
      const img = await loadImageElement(objectUrl);
      const width = img.naturalWidth || img.width;
      const height = img.naturalHeight || img.height;
      if (!width || !height) throw new Error('图片尺寸无效');
      return { source: img, width: width, height: height, objectUrl: objectUrl };
    } catch (e) {
      URL.revokeObjectURL(objectUrl);
      throw new Error('图片解码失败（可能是不支持的格式）');
    }
  }

  async function convertToPng(blob) {
    if (!blob || !blob.size) throw new Error('图片内容为空');

    const decoded = await decodeBlob(blob);
    const width = decoded.width;
    const height = decoded.height;

    try {
      if (!width || !height) throw new Error('图片尺寸无效');
      if (width > MAX_CANVAS_SIDE || height > MAX_CANVAS_SIDE || width * height > MAX_CANVAS_AREA) {
        const error = new Error('图片尺寸超出画布上限');
        error.code = 'TOO_LARGE';
        throw error;
      }

      const canvas = document.createElement('canvas');
      canvas.width = width;
      canvas.height = height;
      const ctx = canvas.getContext('2d', { alpha: true });
      if (!ctx) throw new Error('浏览器无法创建画布');
      ctx.drawImage(decoded.source, 0, 0, width, height);

      const pngBlob = await new Promise(function (resolve, reject) {
        canvas.toBlob(function (result) {
          if (result) resolve(result);
          else reject(new Error('PNG 编码失败'));
        }, 'image/png');
      });

      canvas.width = 0;
      canvas.height = 0;
      return { blob: pngBlob, width: width, height: height };
    } finally {
      if (decoded.source && typeof decoded.source.close === 'function') {
        try {
          decoded.source.close();
        } catch (e) { /* 忽略 */ }
      }
      if (decoded.objectUrl) {
        try {
          URL.revokeObjectURL(decoded.objectUrl);
        } catch (e) { /* 忽略 */ }
      }
    }
  }

  /* -------------------- 大图预览 -------------------- */

  function openPreview(id) {
    state.previewId = id;
    renderPreview();
    els.preview.hidden = false;
    document.body.classList.add('preview-open');
    try {
      els.preview.focus();
    } catch (e) { /* 忽略 */ }
  }

  function closePreview() {
    state.previewId = null;
    els.preview.hidden = true;
    document.body.classList.remove('preview-open');
  }

  function stepPreview(delta) {
    if (!state.filtered.length || !state.previewId) return;
    let index = -1;
    for (let i = 0; i < state.filtered.length; i++) {
      if (state.filtered[i].id === state.previewId) {
        index = i;
        break;
      }
    }
    if (index < 0) index = 0;
    index = (index + delta + state.filtered.length) % state.filtered.length;
    state.previewId = state.filtered[index].id;
    renderPreview();
  }

  function renderPreview() {
    const item = state.items.filter(function (it) {
      return it.id === state.previewId;
    })[0];
    if (!item) return;

    els.previewImg.src = item.url;
    els.previewImg.alt = '大图预览';

    let index = state.filtered.indexOf(item);
    if (index < 0) index = state.items.indexOf(item);
    els.previewIndex.textContent = '第 ' + (index + 1) + ' / ' + state.filtered.length + ' 张';
    els.previewDim.textContent = item.width && item.height ? item.width + ' × ' + item.height : '尺寸未知';
    syncPreviewSelect();
  }

  function syncPreviewSelect() {
    const item = state.items.filter(function (it) {
      return it.id === state.previewId;
    })[0];
    if (!item) return;
    els.previewSelect.textContent = state.selected.has(item.id) ? '取消选择' : '选择此图';
  }

  /* -------------------- 事件 -------------------- */

  function handleAction(action) {
    if (action === 'select-all') selectVisible('all');
    else if (action === 'invert') selectVisible('invert');
    else if (action === 'clear') selectVisible('clear');
    else if (action === 'close-preview') closePreview();
    else if (action === 'prev') stepPreview(-1);
    else if (action === 'next') stepPreview(1);
  }

  function onKeydown(event) {
    const tag = (event.target && event.target.tagName ? event.target.tagName : '').toLowerCase();
    if (tag === 'input' || tag === 'select' || tag === 'textarea') return;

    if (!els.preview.hidden) {
      if (event.key === 'Escape') {
        event.preventDefault();
        closePreview();
      } else if (event.key === 'ArrowLeft') {
        event.preventDefault();
        stepPreview(-1);
      } else if (event.key === 'ArrowRight') {
        event.preventDefault();
        stepPreview(1);
      }
    }
  }

  function bindEvents() {
    document.querySelectorAll('[data-act]').forEach(function (el) {
      el.addEventListener('click', function () {
        handleAction(el.dataset.act);
      });
    });

    els.downloadBtn.addEventListener('click', function () {
      handleDownloadClick();
    });

    els.retryFailed.addEventListener('click', function () {
      retryAllFailed();
    });

    els.sourceFilter.addEventListener('change', function () {
      state.sourceFilter = els.sourceFilter.value;
      applyFilters();
    });

    els.minSide.addEventListener('change', function () {
      state.minSide = parseInt(els.minSide.value, 10) || 0;
      applyFilters();
    });

    els.sortBy.addEventListener('change', function () {
      state.sortBy = els.sortBy.value;
      applyFilters();
    });

    els.previewSelect.addEventListener('click', function () {
      if (state.previewId) toggleSelect(state.previewId);
    });

    els.previewDownload.addEventListener('click', function () {
      const item = state.items.filter(function (it) {
        return it.id === state.previewId;
      })[0];
      if (!item) return;
      if (item.status === 'done') {
        toast('这张图已经下载过了', 'info');
        return;
      }
      retryOne(item);
    });

    document.addEventListener('keydown', onKeydown);
  }

  /* -------------------- 启动 -------------------- */

  function createItems(rawItems) {
    return rawItems.map(function (item, index) {
      const ext = item.ext || U.extOf(item.url) || 'jpg';
      return {
        id: 'i' + index,
        url: item.url,
        width: Number(item.width) || 0,
        height: Number(item.height) || 0,
        source: item.source || 'page',
        ext: ext,
        animated: !!item.animated,
        status: 'idle',
        error: '',
        note: ''
      };
    });
  }

  async function init() {
    cacheEls();
    bindEvents();
    updateSummary();

    const id = new URLSearchParams(location.search).get('id');
    if (!id) {
      els.pageTitle.textContent = '还没有提取结果';
      showState('empty', '请先打开商品详情页', '在淘宝、天猫、京东、拼多多的商品详情页，点击右下角「获取图片」按钮，结果会自动出现在这里。');
      return;
    }

    showState('loading', '正在读取图片…', '');

    let record = null;
    try {
      const key = 'eci:result:' + id;
      const data = await chrome.storage.session.get(key);
      record = data[key];
    } catch (error) {
      showState('error', '读取失败', '无法读取提取结果，请回到商品详情页重新点击「获取图片」。');
      return;
    }

    if (!record || !Array.isArray(record.items) || !record.items.length) {
      showState('error', '结果已过期', '提取结果只保留最近一段时间，请回到商品详情页重新提取。');
      return;
    }

    state.record = record;
    state.items = createItems(record.items);

    setHeader();

    // 默认勾选主图，省去逐张点击
    state.items.forEach(function (item) {
      if (item.source === 'main') state.selected.add(item.id);
    });

    hideState();
    applyFilters();
    updateSummary();
  }

  init().catch(function (error) {
    try {
      showState('error', '页面初始化失败', (error && error.message) || '请刷新页面重试。');
    } catch (e) { /* 忽略 */ }
  });
})();
