# SubtitleCat 手机网页字幕下载器（GitHub Pages + Cloudflare Workers）设计

**Goal:** 手机浏览器打开 GitHub Pages 页面，输入任意字符串（如 `hhd800.com@jul-185` / `JUL185 eng-zh-CN`），服务端自动在 SubtitleCat 搜索并按 **downloads 降序取前 3 条**，分别解析每条详情页的 **中文 SRT（简体优先）**。页面先展示解析结果（含前三条的 downloads/是否有中文），用户点击对应名次下载；字幕以 **用户原始输入** 命名保存到手机本地（重复下载由浏览器自动加后缀避免覆盖）。

## 架构

- **Frontend（GitHub Pages）**：纯静态页面
  - 输入框 + “解析”按钮
  - 解析结果展示：识别到的番号、按 downloads 降序的前 3 条结果（downloads/详情页/是否有中文）、最终文件名
  - “下载”入口：每条结果一个下载按钮/链接（#1/#2/#3），跳转到 Workers 的下载接口（浏览器直接下载到本地）

- **Backend（Cloudflare Workers）**：两条 HTTP 接口
  1. `GET /api/resolve?query=...`
     - 返回 JSON（用于预览）
  2. `GET /api/download?query=...&index=1|2|3`
     - 代理返回 `.srt` 内容（带 `Content-Disposition` 文件名）

## 关键规则

### 1) 输入处理

- **searchCode 提取**：从 `query` 中识别番号用于 SubtitleCat 搜索
  - 支持 `AAA-123` 及 `AAA123`，规范化为 `AAA-123`（大写）
  - 若无法识别，回退为原字符串（但可能搜不到）
- **输出文件名**：使用用户原始 `query` 清洗后作为基础名
  - 替换 Windows/跨平台非法字符：`\\ / : * ? \" < > |` → `_`
  - 去除尾部空格/点
  - 最终：`<base>.srt`（前三条下载都使用同名；重复下载由浏览器自动重命名）

### 2) 搜索页按 downloads 降序取前 3 条

- 抓取 `https://subtitlecat.com/index.php?search=<searchCode>`
- 从结果表中提取每个条目：
  - 详情链接：`subs/.../*.html`
  - downloads：`N downloads`（兼容逗号）
- 按 downloads 降序排序，取前 3 条作为 `downloadsTop3`

### 3) 详情页选择中文 SRT（简体优先）

- 抓取 `https://subtitlecat.com/<topResult.href>`
- 提取所有 `.srt` 下载链接（形如 `/subs/.../*.srt`）
- 基于 “链接附近文本 + href” 进行打分（互斥返回）：
  - **300 简体**：`Chinese simplified` / `Chinese (Simplified)` / `Chinese simple` / `简体` / `zh-CN|zh_Hans` / `chs`
  - **200 繁体**：`Chinese traditional` / `繁体` / `zh-TW|zh-HK|zh_Hant` / `cht`
  - **100 中文兜底**：`Chinese` / `中文` / `zh`

## 接口契约

### `GET /api/resolve`

返回示例：

```json
{
  "input": "hhd800.com@jul-185",
  "searchCode": "JUL-185",
  "filename": "hhd800.com@jul-185.srt",
  "downloadsTop3": [
    {
      "rank": 1,
      "downloads": 67,
      "title": "ADN-424",
      "detailUrl": "https://subtitlecat.com/subs/403/ADN-424.html",
      "filename": "hhd800.com@jul-185.srt",
      "subtitle": {
        "downloadUrl": "https://subtitlecat.com/subs/403/ADN-424-zh-CN.srt",
        "score": 300,
        "label": "Chinese (Simplified)"
      }
    }
  ]
}
```

### `GET /api/download`

- 响应头：
  - `Content-Type: application/x-subrip; charset=utf-8`
  - `Content-Disposition: attachment; filename="<filename>"`
- Body：`.srt` 文件内容

## 安全与限制

- Workers 为公开服务：可加简单的速率限制（后续可选）
- 依赖 SubtitleCat 页面结构，需容错（无结果/无中文/网络错误 → 返回明确错误 JSON/文本）

