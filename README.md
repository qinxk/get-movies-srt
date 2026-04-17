# SubtitleCat 中文 SRT 下载器（手机可用）

本仓库提供一个 **手机可用** 的字幕下载工具：

- **GitHub Pages**：提供网页 UI（输入 → 解析预览 → 下载）
- **Cloudflare Workers**：负责抓取 SubtitleCat（选 downloads 前三 + 简体优先中文 SRT）并代理返回 `.srt`，同时用你的输入命名文件

---

## 目录结构

- `site/`：GitHub Pages 静态站点
  - `index.html`
  - `app.js`
- `worker/`：Cloudflare Workers
  - `src/index.js`
  - `wrangler.toml`

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

## 常见问题

### 解析慢 / 失败

- SubtitleCat 上游网络慢或限制导致，稍后重试
- Worker 会返回 `NO_RESULTS` 或 `NO_CHINESE_SRT` 等错误信息

### 文件名中有特殊字符

Worker 会把 `\\ / : * ? \" < > |` 替换为 `_`，避免跨平台保存失败。

