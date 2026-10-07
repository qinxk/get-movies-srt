# SubtitleCat 中文 SRT 下载器（手机可用）

本仓库提供一个 **手机可用** 的字幕下载工具：

- **GitHub Pages**：提供网页 UI（输入 → 解析预览 → 下载）
- **Cloudflare Workers**：负责抓取 SubtitleCat（选 downloads 前三 + 简体优先中文 SRT）并代理返回 `.srt`，同时用你的输入命名文件

---

## 目录结构

- `site/`：GitHub Pages 静态站点
  - `index.html`
  - `app.js`
- `worker/`：Cloudflare Workers（v2）
  - `src/index.js`
  - `wrangler.toml`
  - `test/`：离线测试，用真实上游 HTML 夹具（`npm test`）
- `docs/plans/`：设计文档

---

## Worker v2 改了什么

| # | 问题 | v1 | v2 |
| --- | --- | --- | --- |
| 1 | 下载量解析 | 数字与 `downloads` 之间隔着 `<span>`，正则匹配不到 → 所有候选恒为 0，所谓「前三」其实是页面顺序 | 先剥标签再取值，实测同一搜索页拿到 `71/63/41/39/29/25/14/9` |
| 2 | 中文识别 | ±250 字窗口猜，相邻行的 `Chinese (Traditional)` 会污染上一行打分 | 读 `<a id="download_zh-CN">` 的语言码，简体 > 中文 > 繁体 |
| 3 | 默认候选 | 写死 `#1`，`#1` 没中文就 404（哪怕 `#2` 有） | 不传 `index` 时自动选第一条有中文的 |
| 4 | 详情页抓取 | 串行 3 次 | 并发，耗时约 1/3 |
| 5 | 上游缓存 | 无 | 内存 + Cache API（不可用时自动降级） |
| 6 | 中文文件名 | 非法响应头，Safari 会乱码 | ASCII 兜底 + `filename*=UTF-8''…`（RFC 5987） |
| 7 | 出错提示 | 手机浏览器只看到一坨 JSON | 按 `Accept` 协商：浏览器 302 到详情页，脚本仍拿 JSON |
| 8 | 手机端 | 依赖 GitHub Pages，且要「解析 → 再下载」两步 | Worker 直接在 `/` 提供一步下载页 |
| 9 | 语言 | 只能简体 | `?lang=zh-TW` / `?lang=zh-HK` |

接口保持向后兼容：`/api/resolve` 的字段与 `/api/download?query=&index=` 都没变，现有 `site/` 页面无需改动。

---

## 1) 部署 Cloudflare Worker

### 前置条件

- 一个 Cloudflare 账号
- 本机安装 Node.js（推荐 LTS）
- 安装 Wrangler（Cloudflare 官方 CLI）

安装 Wrangler：

```bash
npm i -g wrangler
```

登录：

```bash
wrangler login
```

部署 Worker：

```bash
cd worker
wrangler deploy
```

部署完成后，你会得到一个地址，类似：

- `https://subtitlecat-srt.<your-subdomain>.workers.dev`

记下这个 **Worker Origin**（后面要填到前端）。

---

## 2) 部署 GitHub Pages（静态页面）

### 步骤

1. 在 GitHub 创建一个新仓库，把本项目推上去
2. 打开仓库设置：`Settings → Pages`
3. `Build and deployment`：
   - Source 选择 `Deploy from a branch`
   - Branch 选择 `main`（或你的默认分支）
   - Folder 选择 `/site`
4. 保存后，GitHub 会给你 Pages 地址，类似：
   - `https://<user>.github.io/<repo>/`

---

## 3) 绑定前端到 Worker

编辑 `site/app.js`，把：

```js
const WORKER_ORIGIN = 'REPLACE_WITH_YOUR_WORKER_ORIGIN';
```

替换为你的 Worker，例如：

```js
const WORKER_ORIGIN = 'https://subtitlecat-srt.<your-subdomain>.workers.dev';
```

提交并推送到 GitHub。Pages 更新后即可使用。

---

## 4) 手机上如何使用

1. 用手机浏览器打开 GitHub Pages 地址
2. 输入任意字符串，例如：
   - `hhd800.com@jul-185`
   - `JUL-185 eng-zh-CN`
   - `JUL185`
3. 点击 **解析**
4. 页面会展示：
   - 识别到的番号（用于 SubtitleCat 搜索）
   - 选中的最大 downloads 结果详情页
   - 选中的中文字幕（简体优先）
   - 输出文件名（按你的原始输入命名）
5. 点击 **下载 SRT**：浏览器会下载到手机本地

然后你可以在 VLC 里手动选择该 `.srt` 作为外部字幕。

---

## 手机端一步下载

Worker v2 自己托管了一个页面，**不依赖 GitHub Pages**：

- `https://subtitlecat-srt.linfengwuchen.workers.dev`

特性：

- 输入番号 → 回车 → **直接开始下载**（不用先「解析」再点「下载」）
- 三个 `候选 #1/#2/#3` 按钮，已知是哪条时一键跳过排序歧义
- 最近 6 条番号存在本地，可一键复用
- 带参直达：`/?q=JUL-185` 预填、`/?q=JUL-185&go=1` 预填并立刻下载（给快捷指令 / 书签用）
- 没有中文字幕时会自动跳到 SubtitleCat 详情页，不会静默失败

接入方式：

| 平台 | 做法 |
| --- | --- |
| iOS / Android 通用 | 浏览器打开上面的地址 → 分享 / 菜单 → **添加到主屏幕**，当 App 用 |
| iOS 快捷指令 | `要求输入` → `文本`（拼 `…/api/download?query=[输入]&name=[输入].srt`）→ `打开 URL`；可挂到 Siri 与分享表单 |
| Android Chrome | 设置 → 搜索引擎 → 站点搜索：快捷字词 `srt`，网址 `…/api/download?query=%s`，之后地址栏敲 `srt JUL-185` |
| 任意浏览器 | 书签直接存 `…/api/download?query=JUL-185`，点一下就是一次下载 |

iOS 15 之后快捷指令导入必须签名，所以上面只给步骤、不给 `.shortcut` 文件，自己搭一次约一分钟。

---

## 本地测试

不需要联网、不需要 wrangler：

```bash
cd worker
npm test          # 等价于 node test/run-tests.mjs
```

夹具是 2026-10-07 从 SubtitleCat 实际抓下来的页面（`worker/test/fixtures/`），共 48 项断言，
覆盖下载量解析、排序、简繁选择、`lang` 指定、缓存命中、候选回退、响应头合法性、出错协商、页面路由。
上游改版导致解析再次失效时，重新抓一份 HTML 覆盖夹具，跑测试就能立刻定位到哪一步断了。

---

## 常见问题

### 解析慢 / 失败

- SubtitleCat 上游网络慢或限制导致，稍后重试
- Worker 会返回 `NO_RESULTS` 或 `NO_CHINESE_SRT` 等错误信息

### 文件名中有特殊字符

Worker 会把 `\\ / : * ? \" < > |` 替换为 `_`，避免跨平台保存失败。

