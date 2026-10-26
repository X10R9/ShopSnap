/**
 * 渐进增强引导（同步加载，只做两件事）
 * 1. 给 <html> 加 .js，让 CSS 启用入场动画与移动端折叠菜单；
 * 2. 1.6 秒内主脚本仍未就绪时移除 .js，保证内容不会被动画样式隐藏。
 */
(function () {
  'use strict';

  var root = document.documentElement;
  root.classList.add('js');

  window.setTimeout(function () {
    if (!root.hasAttribute('data-js-ready')) root.classList.remove('js');
  }, 1600);
})();
