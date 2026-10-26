/**
 * 电商图片提取助手 · 官网脚本
 * 只做渐进增强：移动端菜单、滚动状态、入场动画、导航高亮、复制地址、年份。
 * 禁用 JavaScript 时，页面内容与 FAQ 仍然完整可用。
 */
(function () {
  'use strict';

  var doc = document;

  // 告知 boot.js 主脚本已就位，取消 1.6s 的降级计时器
  doc.documentElement.setAttribute('data-js-ready', '');

  /* ---------- 移动端菜单 ---------- */

  var header = doc.querySelector('.site-header');
  var toggle = doc.querySelector('.nav-toggle');
  var nav = doc.getElementById('site-nav');
  var desktopQuery = window.matchMedia('(min-width: 901px)');

  function setMenu(open) {
    if (!toggle || !nav) return;
    toggle.setAttribute('aria-expanded', open ? 'true' : 'false');
    toggle.setAttribute('aria-label', open ? '关闭导航菜单' : '打开导航菜单');
    nav.classList.toggle('is-open', open);
  }

  if (toggle && nav) {
    toggle.addEventListener('click', function () {
      setMenu(toggle.getAttribute('aria-expanded') !== 'true');
    });

    nav.addEventListener('click', function (event) {
      var link = event.target && event.target.closest ? event.target.closest('a') : null;
      if (link) setMenu(false);
    });

    doc.addEventListener('keydown', function (event) {
      if (event.key !== 'Escape') return;
      if (toggle.getAttribute('aria-expanded') !== 'true') return;
      setMenu(false);
      toggle.focus();
    });

    doc.addEventListener('click', function (event) {
      if (toggle.getAttribute('aria-expanded') !== 'true') return;
      if (header && event.target && header.contains(event.target)) return;
      setMenu(false);
    });

    var onDesktop = function (event) {
      if (event.matches) setMenu(false);
    };
    if (typeof desktopQuery.addEventListener === 'function') {
      desktopQuery.addEventListener('change', onDesktop);
    } else if (typeof desktopQuery.addListener === 'function') {
      desktopQuery.addListener(onDesktop);
    }
  }

  /* ---------- 顶栏滚动阴影 ---------- */

  if (header) {
    var updateHeader = function () {
      header.classList.toggle('is-scrolled', window.scrollY > 8);
    };
    updateHeader();
    window.addEventListener('scroll', updateHeader, { passive: true });
  }

  /* ---------- 入场动画 ---------- */

  var revealItems = Array.prototype.slice.call(doc.querySelectorAll('.reveal'));
  var reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  if (!('IntersectionObserver' in window) || reduceMotion) {
    revealItems.forEach(function (el) {
      el.classList.add('is-in');
    });
  } else {
    var revealObserver = new IntersectionObserver(
      function (entries) {
        entries.forEach(function (entry) {
          if (!entry.isIntersecting) return;
          entry.target.classList.add('is-in');
          revealObserver.unobserve(entry.target);
        });
      },
      { threshold: 0.12, rootMargin: '0px 0px -8% 0px' }
    );

    revealItems.forEach(function (el) {
      revealObserver.observe(el);
    });
  }

  /* ---------- 导航高亮 ---------- */

  var navLinks = Array.prototype.slice.call(doc.querySelectorAll('.nav-list a[href^="#"]'));
  var sectionPairs = [];

  navLinks.forEach(function (link) {
    var id = link.getAttribute('href').slice(1);
    var section = id ? doc.getElementById(id) : null;
    if (section) sectionPairs.push({ link: link, section: section });
  });

  if ('IntersectionObserver' in window && sectionPairs.length) {
    var spyObserver = new IntersectionObserver(
      function (entries) {
        entries.forEach(function (entry) {
          if (!entry.isIntersecting) return;
          var match = null;
          sectionPairs.forEach(function (pair) {
            if (pair.section === entry.target) match = pair;
          });
          if (!match) return;
          navLinks.forEach(function (link) {
            link.classList.remove('is-active');
            link.removeAttribute('aria-current');
          });
          match.link.classList.add('is-active');
          match.link.setAttribute('aria-current', 'true');
        });
      },
      { rootMargin: '-45% 0px -50% 0px', threshold: 0 }
    );

    sectionPairs.forEach(function (pair) {
      spyObserver.observe(pair.section);
    });
  }

  /* ---------- 复制扩展管理页地址 ---------- */

  Array.prototype.slice.call(doc.querySelectorAll('[data-copy]')).forEach(function (button) {
    button.addEventListener('click', function () {
      var text = button.getAttribute('data-copy') || '';
      var label = button.querySelector('.copy-label');
      if (!label) return;
      var original = label.textContent;

      var reset = function () {
        window.setTimeout(function () {
          label.textContent = original;
          button.classList.remove('is-done');
        }, 1800);
      };

      var selectCode = function () {
        var code = button.parentElement ? button.parentElement.querySelector('.code') : null;
        if (!code) return;
        var selection = window.getSelection();
        if (!selection) return;
        var range = doc.createRange();
        range.selectNodeContents(code);
        selection.removeAllRanges();
        selection.addRange(range);
      };

      if (navigator.clipboard && typeof navigator.clipboard.writeText === 'function') {
        navigator.clipboard.writeText(text).then(
          function () {
            label.textContent = '已复制';
            button.classList.add('is-done');
            reset();
          },
          function () {
            label.textContent = '请手动复制';
            selectCode();
            reset();
          }
        );
      } else {
        label.textContent = '请手动复制';
        selectCode();
        reset();
      }
    });
  });

  /* ---------- 版权年份 ---------- */

  var yearEl = doc.getElementById('year');
  if (yearEl) yearEl.textContent = String(new Date().getFullYear());
})();
