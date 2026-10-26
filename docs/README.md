# 官网说明

「电商图片提取助手」的静态官网，纯 HTML / CSS / 原生 JS，无构建、无外部依赖。

## 本地预览

直接双击 `index.html` 即可。想用本地服务器预览：

```bash
python -m http.server 8080 --directory docs
```

然后访问 `http://localhost:8080/`。

## 发布到 GitHub Pages

1. 把整个仓库推到 GitHub（`docs/` 目录保持与扩展目录 `day5/` 同级）
2. 仓库 **Settings → Pages**
3. **Source** 选 `Deploy from a branch`，Branch 选 `main`，目录选 `/docs`
4. 保存后访问 `https://<用户名>.github.io/<仓库名>/`

页面全部使用相对路径，放在任何子路径下都能正常加载。

## 替换说明

Logo 在 `index.html` 的 `.brand-mark` 内联 SVG 中；主色改 `assets/css/style.css` 顶部的 `--brand` 与 `--btn-bg`；页脚两个 `href="#"` 换成实际链接；界面预览为纯 CSS 示意图，替换 `.window` 内部结构即可换图。
