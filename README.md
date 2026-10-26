# 电商图片提取助手（Edge 扩展）

在淘宝 / 天猫、京东、拼多多（含商家版）的商品详情页，一键提取页面里的主图、SKU 图、详情长图，
在新标签页集中预览、勾选，并批量转换下载为 **PNG**。

- Manifest V3，原生 HTML / CSS / JavaScript，无需构建，加载即用
- 悬浮按钮使用 Shadow DOM 隔离，不污染站点样式，也不被站点样式污染
- 图片选择页纯本地渲染，不发起任何数据上报

---

## 一、安装（Edge）

1. 打开 `edge://extensions/`
2. 打开左侧（或页面右下角）的「开发人员模式」
3. 点击「加载解压缩的扩展」，选择本 `day5` 文件夹（即包含 `manifest.json` 的那一层）
4. 建议把「电商图片提取助手」固定到工具栏，方便打开上次的提取结果

> 修改代码后，在 `edge://extensions/` 里点击该扩展的「重新加载」即可，已打开的详情页需要刷新一次。

## 二、使用

1. 打开商品详情页（如 `item.taobao.com/item.htm?id=...`、`item.jd.com/xxx.html`、拼多多商品页）
2. 页面右下角出现橙色「获取图片」按钮
3. 点击后按钮进入 loading，会自动滚动页面触发懒加载，然后打开新标签页
4. 在新页面里：
   - 点击卡片勾选 / 取消勾选，右上角圆圈为选中态
   - 点击卡片右下角放大镜、双击卡片或按 `Enter` 查看大图，`←` `→` 切换，`Esc` 关闭
   - 顶部工具栏可全选、反选、清空，按来源 / 最小边筛选，按尺寸排序
   - 底部「下载选中为 PNG」开始批量下载，进度实时显示；失败的图片可在卡片上单独「重试」

下载文件保存在浏览器默认下载目录下的 `电商图片/` 子文件夹中，命名规则：

```
站点_商品标题前30字_序号_宽x高.png
例：淘宝_春夏新款纯棉短袖T恤男_01_800x800.png
```

## 三、目录结构

```
day5/
├── manifest.json                  # MV3 清单：权限、注入规则、后台脚本
├── README.md
└── src/
    ├── common/
    │   ├── sites.js               # 站点配置表：匹配规则、选择器、CDN 白名单、URL 归一化
    │   └── utils.js               # 通用工具：URL 规范化、srcset 解析、文件名清洗等
    ├── content/
    │   ├── extractor.js           # 图片提取：DOM / 背景图 / 内联 JSON / 懒加载滚动
    │   ├── button.js              # Shadow DOM 悬浮按钮
    │   └── content.js             # 入口：路由检测、注入、提取、跳转选择页
    ├── background/
    │   └── service-worker.js      # 结果暂存、打开选择页、跨域取图代理、MAIN world 读状态
    └── gallery/
        ├── gallery.html           # 图片选择页
        ├── gallery.css            # 界面样式（含深色模式）
        └── gallery.js             # 筛选、勾选、预览、转 PNG、批量下载
```

文件之间的加载顺序在 `manifest.json` 的 `content_scripts.js` 中固定：`sites → utils → extractor → button → content`。
这几个文件是**经典脚本**而不是 ES Module，因为 Manifest V3 的 `content_scripts` 不支持 `type: module`；
每个文件通过 `globalThis.ECI_*` 暴露接口，service worker 用 `importScripts` 复用同一份代码。

## 四、实现要点

**提取（extractor.js）**

| 来源 | 处理方式 |
| --- | --- |
| `img` | `src`、`data-src`、`data-lazy-src`、`data-original`、`data-ks-lazyload` 等 12 个懒加载属性 |
| `srcset` / `picture` | 解析描述符，取宽度最大或密度最高的一项 |
| 背景图 | 扫描 `[style*="background"]` 与站点配置的背景图容器，读 `getComputedStyle` |
| 内联 JSON | 扫描 `script` 文本 + MAIN world 读取 `window.__INITIAL_STATE__` 等全局状态 |
| 视频封面 | 当前不处理（避免简介视频混入商品图），可在 `extractor.js` 中扩展 `video[poster]` |

清洗规则：剔除 1×1 占位图、`data:image/gif` 骨架图、icon/logo/avatar 等装饰图；
只保留命中站点 CDN 白名单的地址；已知尺寸小于 60px 的直接丢弃。
去重按**归一化后的 URL**：淘宝的 `_400x400.jpg`、`_q90.jpg`、`_.webp`，京东的 `/n1/`、`/s450x450_`、`!q70.dpg`，
拼多多的 `?imageView2/...` 都会被还原或抹平，保证拿到的是原图。

**下载（gallery.js）**

```
fetch 原图 → Blob → createImageBitmap（失败降级 Image）→ canvas → toBlob('image/png')
→ chrome.downloads.download(blob URL) → 监听下载完成后 revokeObjectURL
```

- 扩展页面 fetch 有 `host_permissions`，不受页面 CORS 限制；仍失败时改由 service worker 代理取图并回传 data URL
- 并发 3、每次间隔 180ms，避免浏览器把批量下载判定为异常行为
- 画布超过 32767 边长或 2.68 亿像素时，降级保存原格式并在卡片上提示，不静默失败
- GIF / 动态 WebP 只能取首帧，界面上会标注「动图·仅首帧」

**界面**

- 8px 栅格、12px 圆角、系统字体栈，跟随系统深色模式
- 主色 `#ff5000`，全部颜色走 CSS 变量，改 `gallery.css` 顶部的 `:root` 即可换肤
- 键盘可用：`Tab` 聚焦、`空格` 勾选、`Enter` 预览、`←/→` 切换、`Esc` 关闭
- 空态 / 加载态 / 错误态齐全，操作反馈用 toast

## 五、站点适配

配置集中在 `src/common/sites.js`，新增站点只需追加一条配置：

```js
{
  id: 'xxx',
  name: '站点名',
  shortName: '文件名前缀',
  color: '#主色',
  hostPatterns: [/xxx\.com$/i],          // 哪些域名生效
  detailUrl: { include: [/.../], exclude: [/.../] },  // 详情页 URL 特征
  titleSelectors: ['...'],                // 商品标题选择器
  cdnHosts: [/xxxcdn\.com$/i],            // 图片 CDN 白名单
  productPathHints: [/\/goods\//i],       // 商品图路径特征（过滤装饰图）
  selectors: { main: [], sku: [], detail: [] },  // 主图/SKU/详情容器
  backgroundSelectors: [],                // 背景图容器
  normalize: function (url) { return url; }      // 缩略图还原为原图
}
```

当前内置：

| 站点 | 详情页特征 | 图片 CDN | 特殊处理 |
| --- | --- | --- | --- |
| 淘宝 / 天猫 | `item.htm`、`detail.htm`、`/item/` | `*.alicdn.com` | 去掉 `_400x400`、`_q90`、`_.webp` 等后缀 |
| 京东 | `/\d+\.html` | `*.360buyimg.com` | `/n1/` → `/n0/`，`/s450x450_jfs/` → `/jfs/` |
| 拼多多 | `/goods.html` 等 | `*.pddpic.com` | 去掉 `imageView2` 缩放参数 |
| 拼多多商家版 | `mms.pinduoduo.com/goods/...`（排除 `goods_list`） | `*.pddpic.com` | 同上，选择器按商家后台结构单独配置 |

**站点改版时会失效**：这类页面 class 名经常变，所以选择器都写成多个候选 + `class*=` 模糊匹配 + 管道兜底。
如果某天提取不到图，优先在 `sites.js` 里补选择器，或把浏览器控制台里图片容器的 class 发回来。

## 六、权限说明

| 权限 | 用途 |
| --- | --- |
| `storage` | 用 `chrome.storage.session` 暂存提取结果（只存 URL 和尺寸，不落盘） |
| `downloads` | 调用浏览器下载管理器保存 PNG |
| `scripting` | 在 MAIN world 读取页面全局状态（`__INITIAL_STATE__` 等），提升未渲染图片的提取率 |
| `host_permissions` | 目标站点 + 图片 CDN：注入脚本、跨域读取图片 |

没有申请 `tabs`（`tabs.create` 不需要该权限），没有申请 `"<all_urls>"`，不读取浏览历史、Cookie 或页面输入内容。
提取结果只在内存/会话存储中保留最近 8 条、2 小时，过期自动清理。

## 七、已知限制

1. **CORS / 防盗链**：极少数图床会校验 `Referer` 并拒绝扩展请求。已实现「页面 fetch → 后台代理 fetch」两级兜底，仍失败时卡片上会显示原因，可重试。
2. **登录态页面**：拼多多商家版需要先登录再打开商品详情；未登录时不会出现按钮（URL 不匹配详情页规则）。
3. **动图**：GIF / 动态 WebP 只能导出首帧，这是 canvas 转换的固有限制。
4. **超大图**：超过浏览器画布上限（约 2.68 亿像素）时降级保存原格式，不是 PNG。
5. **懒加载滚动**：自动滚动最长 6 秒（超长详情页通常 2–4 秒完成），滚动结束会回到原位置。滚动期间按钮显示「正在滚动加载页面…」；若页面使用内部滚动容器导致无法滚动，会自动提前结束。
6. **严格 CSP 的站点**：悬浮按钮的样式通过 Shadow DOM 内联 `<style>` 注入，绝大多数电商站不受影响；若某站点禁用了内联样式，按钮会退化为无样式文本。
7. **站点改版**：选择器可能失效，属于这类工具的常态维护成本，改 `sites.js` 即可。
8. **模拟点击/自动操作**：本扩展只读取页面已渲染的内容，不模拟登录、不绕过风控。

## 八、自测清单

每个站点各做一遍：

- [ ] 详情页右下角出现「获取图片」，不遮挡站点自身按钮，页面样式无变化
- [ ] 点击后按钮出现 loading，页面自动滚动，完成后 3 秒内打开新标签页
- [ ] 列表包含：至少 1 张主图、SKU 图（切换规格后重新提取应变化）、详情长图
- [ ] 顶部标题、站点标识、总张数正确
- [ ] 全选 / 反选 / 清空、来源筛选、最小边筛选、排序均生效
- [ ] 勾选 5 张下载，得到 5 个 PNG，尺寸与卡片显示一致，透明背景未被填白
- [ ] 下载失败项可单独重试
- [ ] 刷新页面、切换商品、从详情页返回列表页：按钮正确消失 / 重新出现，无重复注入
- [ ] 深色模式下界面可读
- [ ] 控制台无 error；连续提取 3 次后内存无明显增长

## 九、常见问题

**Q：按钮没出现？**
A：确认 URL 是详情页（列表页、搜索页、购物车不显示）；确认扩展已启用；刷新页面。排查时打开 DevTools，
把控制台左上角的执行上下文从 `top` 切换成本扩展的 content script 上下文，再执行：

```js
const site = ECI_SITE_API.findSite(location.href);
[site && site.id, ECI_SITE_API.isDetailPage(location.href, site)];
```

**Q：提取到的图很少？**
A：先把页面手动滚到底部再点按钮；或检查站点是否改版导致 `productPathHints` 不匹配。

**Q：下载的图不是原图尺寸？**
A：说明该图在页面上只有缩略图版本，`normalize` 规则没覆盖到新的后缀格式，补充 `sites.js` 的正则即可。

**Q：能提取视频吗？**
A：当前只处理图片。`extractor.js` 里已预留 `video[poster]` 的扩展位置，需要时可自行打开。
