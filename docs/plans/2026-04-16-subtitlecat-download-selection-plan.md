# SubtitleCat 下载量最大选择 Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Make SubtitleCat search result parsing reliably select the top 3 entries by downloads, then download the best-matching Chinese `.srt` for each (Simplified preferred).

**Architecture:** In `popup.js`, replace the "parse downloads from whole row text" logic with a table-aware extractor: (A) header-driven downloads column index, (B) fallback per-cell scan for a downloads cell, (C) strict regex fallback. Add a deterministic Chinese SRT ranking function to pick best link.

**Tech Stack:** Chrome Extension MV3 (popup page), Fetch API, DOMParser, `chrome.downloads`.

---

### Task 1: Harden downloads extraction (A/B/C) and select top 3

**Files:**
- Modify: `popup.js`

**Step 1: Add helper functions**

- Add `parseDownloadsNumber(text)` that extracts the first integer from a downloads-cell-like string.
- Add `findDownloadsColumnIndex(doc)` that tries to locate the "Downloads" header column index.
- Add `getRowDownloads(row, downloadsColIndex)` that:
  - If `downloadsColIndex` is valid, parse that `td`
  - Else scan `td`s for a cell containing "downloads" and parse that cell
  - Else strict fallback: parse the best candidate from row text (avoid unrelated numbers)

**Step 2: Replace current row-mapping logic**

- Iterate `tr` rows
- For each row, find search-result links (SubtitleCat uses `subs/.../*.html`)
- Compute downloads via `getRowDownloads`
- Sort desc by downloads and take top 3 (or select top 3 in one pass)

**Step 3: Verify behavior on a known query**

- Manual test in browser extension popup:
  - Input a known code that returns multiple results with different downloads
- Ensure status message shows the top 3 downloads chosen and downloads order is correct

---

### Task 2: Deterministic Chinese SRT selection

**Files:**
- Modify: `popup.js`

**Step 1: Add `rankChineseSrtLink(a)`**

- Build a normalized string from `${a.textContent} ${a.href}` lowercased
- Score matches:
  - Simplified: `chinese (simplified)`, `简体`, `zh-cn`, `chs` → +300
  - Traditional: `chinese (traditional)`, `繁体`, `zh-tw`, `cht` → +200
  - Generic Chinese: `chinese`, `中文`, `zh` → +100
- Prefer `.srt` links (already filtered)
- Return a numeric score

**Step 2: Pick best link**

- Sort by score desc; take first with score > 0 (for each of the top 3 results)
- If none, show "未发现中文 SRT 文件"

**Step 3: Verify on a detail page**

- Confirm simplified is preferred over traditional when both exist

---

### Task 3: Better status and error handling

**Files:**
- Modify: `popup.js`

**Step 1: Make status messages explicit**

- Distinguish:
  - no input
  - no results
  - parse failure (no downloads/link)
  - no Chinese SRT
  - network/parse exception

**Step 2: Keep existing try/catch but add more specific messages**

---

### Task 4: Sanity check

**Files:**
- Verify: `manifest.json`, `popup.html`

**Step 1: Ensure permissions are sufficient**

- `host_permissions` includes `https://subtitlecat.com/*`
- `permissions` includes `downloads`

