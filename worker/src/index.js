/**
 * SubtitleCat 中文 SRT 下载器 —— Worker v2
 *
 * 相比 v1 的改动：
 *   1. 修好下载量解析（旧正则在「数字」和「downloads」之间隔着 HTML 标签，恒为 0）
 *   2. 候选详情页并发抓取（v1 是串行 3 次，耗时约三分之一）
 *   3. /api/download 不传 index 时，自动选「第一条有中文的候选」，不再死盯 #1
 *   4. 中文识别改用 <a id="download_zh-CN"> 里的语言码，并支持 ?lang=zh-TW 指定
 *   5. 出错时按 Accept 协商：浏览器 302 到 SubtitleCat 详情页，脚本/CLI 仍拿 JSON
 *   6. 文件名用 RFC 5987（filename*），中文/特殊字符不再乱码
 *   7. 上游页面用 Cache API 缓存，重复查询几乎瞬时
 *   8. Worker 自己托管一个「一步下载」移动端页面（/），不再依赖 GitHub Pages
 */

const UPSTREAM_ORIGINS = ['https://www.subtitlecat.com', 'https://subtitlecat.com'];
const UA = 'Mozilla/5.0 (compatible; subtitlecat-srt/2.0; +https://github.com/qinxk/get-movies-srt)';
const FETCH_TIMEOUT_MS = 20000;
const CACHE_TTL_SECONDS = 600;
const MAX_CANDIDATES = 3;
const SITE_TITLE = 'SubtitleCat 中文 SRT 下载器';

/* ------------------------------------------------------------------ 基础工具 */

function json(data, init = {}) {
  const headers = new Headers(init.headers || {});
  headers.set('content-type', 'application/json; charset=utf-8');
  headers.set('access-control-allow-origin', '*');
  headers.set('access-control-allow-methods', 'GET, OPTIONS');
  headers.set('access-control-allow-headers', 'content-type');
  headers.set('cache-control', 'no-store');
  return new Response(JSON.stringify(data, null, 2), { ...init, headers });
}

function html(body, init = {}) {
  const headers = new Headers(init.headers || {});
  headers.set('content-type', 'text/html; charset=utf-8');
  headers.set('cache-control', 'no-store');
  return new Response(body, { ...init, headers });
}

function badRequest(message) {
  return json({ error: 'BAD_REQUEST', message }, { status: 400 });
}

function normalizePath(pathname) {
  if (pathname.length > 1 && pathname.endsWith('/')) return pathname.slice(0, -1);
  return pathname || '/';
}

function clamp(n, lo, hi) {
  return Math.max(lo, Math.min(hi, n));
}

function stripTags(input) {
  return String(input || '')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]*>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, ' ')
    .trim();
}

function sanitizeFilenameBase(name) {
  const s = String(name || '').trim();
  const cleaned = s
    .replace(/\.(srt|ass|ssa|sub|vtt|mp4|mkv|avi|wmv|mov|ts|m2ts|rmvb|flv|webm)$/i, '')
    .replace(/[\\/:*?"<>|]/g, '_')
    .replace(/[\u0000-\u001f]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  return cleaned.replace(/[. ]+$/g, '') || 'subtitle';
}

/** 从任意输入里抽出用于 SubtitleCat 搜索的番号 */
function extractSearchCode(input) {
  const s = String(input || '').trim();
  const hyphen = s.match(/\b([a-z]{2,10})\s*-\s*(\d{2,6})\b/i);
  if (hyphen) return `${hyphen[1].toUpperCase()}-${hyphen[2]}`;
  const plain = s.match(/\b([a-z]{2,10})(\d{2,6})\b/i);
  if (plain) return `${plain[1].toUpperCase()}-${plain[2]}`;
  return s;
}

/** Content-Disposition：ASCII 兜底 + RFC 5987 UTF-8 真名 */
function contentDisposition(filename) {
  const ascii = String(filename).replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_');
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(filename)}`;
}

/* ------------------------------------------------------------------ 上游抓取 */

const memCache = new Map();

function memGet(key) {
  const hit = memCache.get(key);
  if (!hit) return null;
  if (hit.expires < Date.now()) {
    memCache.delete(key);
    return null;
  }
  return hit.value;
}

function memSet(key, value) {
  if (memCache.size > 200) memCache.clear();
  memCache.set(key, { value, expires: Date.now() + CACHE_TTL_SECONDS * 1000 });
}

function hasCacheApi() {
  return typeof caches !== 'undefined' && caches && caches.default;
}

async function edgeGet(cacheKey) {
  if (!hasCacheApi()) return null;
  try {
    const res = await caches.default.match(cacheKey);
    return res ? await res.text() : null;
  } catch {
    return null;
  }
}

async function edgePut(cacheKey, text) {
  if (!hasCacheApi()) return;
  try {
    await caches.default.put(
      cacheKey,
      new Response(text, {
        headers: {
          'content-type': 'text/html; charset=utf-8',
          'cache-control': `max-age=${CACHE_TTL_SECONDS}`,
        },
      })
    );
  } catch {
    /* 缓存失败不影响主流程 */
  }
}

function timeoutSignal() {
  try {
    return AbortSignal.timeout(FETCH_TIMEOUT_MS);
  } catch {
    return undefined;
  }
}

async function fetchUpstreamPath(path) {
  let lastError = null;
  for (const origin of UPSTREAM_ORIGINS) {
    const url = origin + path;
    try {
      const res = await fetch(url, {
        redirect: 'follow',
        headers: { 'user-agent': UA, accept: 'text/html,application/xhtml+xml' },
        signal: timeoutSignal(),
      });
      if (res.ok) return { url, text: await res.text() };
      lastError = new Error(`上游返回 HTTP ${res.status}`);
    } catch (err) {
      lastError = err;
    }
  }
  throw lastError || new Error('上游不可达');
}

/** 带内存 + 边缘缓存的页面抓取 */
async function getPage(path) {
  const memo = memGet(path);
  if (memo) return memo;

  const cacheKey = `https://subtitlecat-srt.internal/cache${path}`;
  const cached = await edgeGet(cacheKey);
  if (cached) {
    memSet(path, cached);
    return cached;
  }

  const { text } = await fetchUpstreamPath(path);
  memSet(path, text);
  await edgePut(cacheKey, text);
  return text;
}

/* ------------------------------------------------------------------ 搜索页解析 */

/** 从一段纯文本里读指标，例如 "Downloads 71 downloads" / "1,234 downloads" */
function parseMetric(text, word) {
  const labelFirst = new RegExp(`${word}\\s*[:：]?\\s*([\\d][\\d,]{0,9})`, 'i');
  const m1 = text.match(labelFirst);
  if (m1) return parseInt(m1[1].replace(/,/g, ''), 10);

  const valueFirst = new RegExp(`([\\d][\\d,]{0,9})\\s*${word}`, 'i');
  const m2 = text.match(valueFirst);
  if (m2) return parseInt(m2[1].replace(/,/g, ''), 10);

  return null;
}

function parseSearchRows(searchHtml) {
  const rows = [];
  const trMatches = String(searchHtml || '').match(/<tr\b[\s\S]*?<\/tr>/gi) || [];

  for (const tr of trMatches) {
    const link = tr.match(/<a[^>]+href="([^"]*subs\/[^"]+?\.html)"[^>]*>([\s\S]*?)<\/a>/i);
    if (!link) continue;

    const text = stripTags(tr);
    const sourceMatch = text.match(/\(translated from ([^)]+)\)/i);

    rows.push({
      href: link[1],
      title: stripTags(link[2]),
      downloads: parseMetric(text, 'downloads') ?? parseMetric(text, '下载'),
      languages: parseMetric(text, 'languages'),
      rating: /rated good by users/i.test(tr) ? 'good' : /rated bad by users/i.test(tr) ? 'bad' : null,
      sourceLang: sourceMatch ? sourceMatch[1].trim() : null,
    });
  }

  return rows;
}

const RATING_SCORE = { good: 1, bad: -1 };

/** 下载量降序；没有下载量的排最后；同分好评优先、差评靠后 */
function rankRows(rows) {
  return rows
    .map((row, index) => ({ row, index }))
    .sort((a, b) => {
      const da = a.row.downloads ?? -1;
      const db = b.row.downloads ?? -1;
      if (db !== da) return db - da;
      const ra = RATING_SCORE[a.row.rating] ?? 0;
      const rb = RATING_SCORE[b.row.rating] ?? 0;
      if (rb !== ra) return rb - ra;
      return a.index - b.index;
    })
    .map((x) => x.row);
}

/* ------------------------------------------------------------------ 详情页解析 */

const CHINESE_RANK = {
  'zh-cn': 300, // 简体
  'zh-hans': 300,
  'zh-sg': 290,
  zh: 250,
  'zh-hant': 200, // 繁体
  'zh-tw': 200,
  'zh-hk': 190,
  'zh-mo': 190,
};

function scoreLanguage(lang, label) {
  const code = String(lang || '').toLowerCase();
  if (CHINESE_RANK[code] != null) return CHINESE_RANK[code];

  const text = String(label || '').toLowerCase();
  if (/simplified|简体/.test(text)) return 280;
  if (/traditional|繁体|繁體/.test(text)) return 180;
  if (/chinese|中文/.test(text)) return 150;
  return 0;
}

function languageFromHref(href) {
  const m = String(href).match(/-([a-z]{2}(?:-[A-Za-z]{2,4})?)\.srt(?:\?|$)/i);
  return m ? m[1] : null;
}

/** 列出详情页里所有可下载的 .srt（含语言码与就近标签） */
function listSrtLinks(detailHtml) {
  const source = String(detailHtml || '');
  const re = /<a\b[^>]*href="([^"]+?\.srt(?:\?[^"#]*)?)"[^>]*>([\s\S]{0,40}?)<\/a>/gi;
  const links = [];
  let m;

  while ((m = re.exec(source))) {
    if (!/^download$/i.test(stripTags(m[2]))) continue;

    const idMatch = /id="download_([^"]+)"/i.exec(m[0]);
    const before = stripTags(source.slice(Math.max(0, m.index - 400), m.index));
    const labelMatch = before.match(
      /(Chinese\s*\(\s*(?:Simplified|Traditional)\s*\)|Chinese\s+Simplified|Chinese\s+Traditional|简体中文|繁體中文|简体|繁体|中文|Chinese)\s*$/i
    );

    const lang = (idMatch && idMatch[1]) || languageFromHref(m[1]) || null;
    const label = labelMatch ? labelMatch[0].replace(/\s+/g, ' ').trim() : null;

    links.push({ href: m[1], lang, label });
  }

  return links;
}

/**
 * 挑中文 SRT。
 * preferred 传 ['zh-tw'] 之类时只认该语言。
 */
function pickBestChineseSrt(detailHtml, preferred = []) {
  const wanted = preferred.map((x) => String(x).toLowerCase()).filter(Boolean);
  let best = null;

  for (const link of listSrtLinks(detailHtml)) {
    const code = String(link.lang || '').toLowerCase();
    let score = scoreLanguage(link.lang, link.label);

    if (wanted.length) {
      if (!wanted.includes(code)) continue;
      score = 1000;
    }
    if (score <= 0) continue;

    if (!best || score > best.score) {
      best = { href: link.href, lang: link.lang, label: link.label, score };
    }
  }

  return best;
}

/* ------------------------------------------------------------------ 业务逻辑 */

async function loadCandidate(row, preferredLangs) {
  const detailUrl = new URL(row.href, UPSTREAM_ORIGINS[0]).href;
  const path = detailUrl.replace(/^https?:\/\/[^/]+/i, '');

  const candidate = {
    rank: 0,
    downloads: row.downloads,
    languages: row.languages,
    rating: row.rating,
    sourceLang: row.sourceLang,
    title: row.title,
    detailUrl,
    subtitle: null,
    chineseVariants: [],
  };

  try {
    const detailHtml = await getPage(path);
    const links = listSrtLinks(detailHtml);

    candidate.chineseVariants = links
      .filter((l) => scoreLanguage(l.lang, l.label) > 0)
      .map((l) => ({ lang: l.lang, label: l.label, downloadUrl: new URL(l.href, detailUrl).href }));

    const best = pickBestChineseSrt(detailHtml, preferredLangs);
    if (best) {
      candidate.subtitle = {
        downloadUrl: new URL(best.href, detailUrl).href,
        lang: best.lang,
        label: best.label,
        score: best.score,
      };
    }
  } catch (err) {
    candidate.detailError = err && err.message ? err.message : String(err);
  }

  return candidate;
}

async function resolveQuery(input, options = {}) {
  const raw = String(input || '').trim();
  const preferredLangs = options.lang ? [options.lang] : [];
  const maxCandidates = clamp(Number(options.top) || MAX_CANDIDATES, 1, 8);

  const searchCode = extractSearchCode(raw);
  const base = sanitizeFilenameBase(raw);
  const filename = `${base}.srt`;

  const result = {
    input: raw,
    searchCode,
    baseFilename: base,
    filename,
    downloadsTop3: [],
    candidates: [],
    topResult: null,
    subtitle: null,
    error: null,
  };

  const searchPath = `/index.php?search=${encodeURIComponent(searchCode)}`;

  let searchHtml;
  try {
    searchHtml = await getPage(searchPath);
  } catch (err) {
    result.error = 'UPSTREAM_FAILED';
    result.message = err && err.message ? err.message : String(err);
    return result;
  }

  const rows = parseSearchRows(searchHtml);
  if (!rows.length) {
    result.error = 'NO_RESULTS';
    return result;
  }

  const ranked = rankRows(rows).slice(0, maxCandidates);
  const candidates = await Promise.all(ranked.map((row) => loadCandidate(row, preferredLangs)));

  candidates.forEach((c, i) => {
    c.rank = i + 1;
    c.filename = filename;
  });

  result.candidates = candidates;
  result.downloadsTop3 = candidates; // 兼容 v1 的字段名
  result.scannedResults = rows.length;

  const firstWithSubtitle = candidates.find((c) => c.subtitle) || null;
  result.subtitle = firstWithSubtitle ? firstWithSubtitle.subtitle : null;
  result.topResult = candidates[0]
    ? {
        downloads: candidates[0].downloads,
        rating: candidates[0].rating,
        title: candidates[0].title,
        detailUrl: candidates[0].detailUrl,
      }
    : null;

  if (!firstWithSubtitle) result.error = 'NO_CHINESE_SRT';

  return result;
}

/* ------------------------------------------------------------------ 移动端页面 */

function wantsHtml(request) {
  const accept = request.headers.get('accept') || '';
  return accept.includes('text/html') || accept.includes('application/xhtml');
}

function searchPageUrl(searchCode) {
  return `${UPSTREAM_ORIGINS[0]}/index.php?search=${encodeURIComponent(searchCode || '')}`;
}

/** 出错时：浏览器跳上游详情页，脚本拿 JSON */
function noSubtitleResponse(request, resolved, candidate, errorCode) {
  const fallbackUrl = (candidate && candidate.detailUrl) || searchPageUrl(resolved && resolved.searchCode);

  if (wantsHtml(request)) {
    return new Response(null, {
      status: 302,
      headers: { location: fallbackUrl, 'cache-control': 'no-store' },
    });
  }

  return json(
    {
      error: errorCode,
      message:
        errorCode === 'NO_RESULTS'
          ? '上游没有搜到这个番号'
          : '该候选没有中文 SRT（可用 ?index=2/3 换一条，或浏览器打开详情页）',
      searchCode: resolved && resolved.searchCode,
      detailUrl: fallbackUrl,
    },
    { status: 404 }
  );
}

async function handleDownload(url, request) {
  const query = url.searchParams.get('query') || url.searchParams.get('q') || '';
  if (!query.trim()) return badRequest('缺少 query 参数');

  const lang = url.searchParams.get('lang') || '';
  const requestedName = url.searchParams.get('name') || '';
  const indexParam = url.searchParams.get('index');

  let resolved;
  try {
    resolved = await resolveQuery(query, { lang });
  } catch (err) {
    return json({ error: 'RESOLVE_FAILED', message: err?.message || String(err) }, { status: 502 });
  }

  if (resolved.error === 'NO_RESULTS' || resolved.error === 'UPSTREAM_FAILED') {
    return noSubtitleResponse(request, resolved, null, resolved.error);
  }

  const candidates = resolved.candidates || [];
  let candidate = null;

  const explicitIndex = indexParam != null && indexParam !== '' && indexParam !== '0' && indexParam !== 'auto';
  if (explicitIndex) {
    const i = clamp(parseInt(indexParam, 10) || 1, 1, Math.max(candidates.length, 1));
    candidate = candidates[i - 1] || null;
    if (!candidate || !candidate.subtitle) {
      return noSubtitleResponse(request, resolved, candidate, 'NO_CHINESE_AT_INDEX');
    }
  } else {
    // v1 这里固定用 #1，导致「#1 无中文、#2 有中文」时白白 404
    candidate = candidates.find((c) => c.subtitle) || null;
    if (!candidate) {
      return noSubtitleResponse(request, resolved, candidates[0] || null, 'NO_CHINESE_SRT');
    }
  }

  let upstream;
  try {
    upstream = await fetch(candidate.subtitle.downloadUrl, {
      redirect: 'follow',
      headers: { 'user-agent': UA, accept: 'text/plain, text/*, */*' },
      signal: timeoutSignal(),
    });
  } catch (err) {
    return json({ error: 'DOWNLOAD_FETCH_FAILED', message: err?.message || String(err) }, { status: 502 });
  }

  if (!upstream.ok) {
    return json({ error: 'DOWNLOAD_HTTP_ERROR', status: upstream.status }, { status: 502 });
  }

  const name = sanitizeFilenameBase(requestedName || resolved.baseFilename) + '.srt';

  const headers = new Headers();
  headers.set('content-type', 'application/x-subrip; charset=utf-8');
  headers.set('content-disposition', contentDisposition(name));
  headers.set('cache-control', 'no-store');
  headers.set('access-control-allow-origin', '*');
  headers.set('access-control-expose-headers', 'content-disposition, x-subtitle-rank, x-subtitle-lang');
  headers.set('x-subtitle-rank', String(candidate.rank));
  headers.set('x-subtitle-lang', candidate.subtitle.lang || '');

  return new Response(upstream.body, { status: 200, headers });
}

function renderPage() {
  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="theme-color" content="#111318">
<meta name="apple-mobile-web-app-capable" content="yes">
<meta name="apple-mobile-web-app-status-bar-style" content="black-translucent">
<meta name="apple-mobile-web-app-title" content="字幕">
<title>${SITE_TITLE}</title>
<link rel="icon" href="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 64 64'%3E%3Crect width='64' height='64' rx='14' fill='%232563eb'/%3E%3Ctext x='32' y='44' font-size='34' text-anchor='middle' fill='white' font-family='sans-serif'%3ES%3C/text%3E%3C/svg%3E">
<style>
  :root { color-scheme: dark; --bg:#111318; --card:#1b1f27; --line:#2a303c; --fg:#e8eaed; --dim:#98a2b3; --accent:#3b82f6; }
  * { box-sizing: border-box; -webkit-tap-highlight-color: transparent; }
  body { margin:0; background:var(--bg); color:var(--fg); font:16px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",system-ui,"PingFang SC","Microsoft YaHei",sans-serif; padding:max(18px,env(safe-area-inset-top)) 16px calc(24px + env(safe-area-inset-bottom)); }
  h1 { font-size:19px; margin:0 0 4px; font-weight:650; }
  .sub { color:var(--dim); font-size:13px; margin-bottom:18px; }
  input[type=text] { width:100%; padding:15px 16px; font-size:17px; border-radius:14px; border:1px solid var(--line); background:var(--card); color:var(--fg); outline:none; }
  input[type=text]:focus { border-color:var(--accent); }
  .go { margin-top:12px; width:100%; padding:16px; font-size:17px; font-weight:650; border:0; border-radius:14px; background:var(--accent); color:#fff; }
  .go:active { transform:scale(.985); }
  .go[disabled] { opacity:.55; }
  .row { display:flex; gap:8px; margin-top:10px; }
  .row button { flex:1; padding:12px 0; font-size:14px; border-radius:12px; border:1px solid var(--line); background:var(--card); color:var(--dim); }
  .row button:active { background:#242a35; }
  section { margin-top:22px; }
  h2 { font-size:13px; color:var(--dim); font-weight:600; margin:0 0 8px; letter-spacing:.04em; text-transform:uppercase; }
  .chips { display:flex; flex-wrap:wrap; gap:8px; }
  .chip { padding:9px 13px; border-radius:999px; background:var(--card); border:1px solid var(--line); font-size:14px; color:var(--fg); }
  .chip:active { background:#242a35; }
  #msg { margin-top:14px; font-size:14px; min-height:20px; color:var(--dim); }
  #msg.err { color:#f87171; }
  #msg.ok { color:#4ade80; }
  details { margin-top:20px; border-top:1px solid var(--line); padding-top:14px; color:var(--dim); font-size:13px; }
  summary { cursor:pointer; }
  code { background:var(--card); padding:1px 5px; border-radius:5px; font-size:12px; }
</style>
</head>
<body>
  <h1>${SITE_TITLE}</h1>
  <div class="sub">输入番号，直接下载中文字幕。不用选、不用点两次。</div>

  <form id="f" autocomplete="off">
    <input id="q" type="text" inputmode="text" autocapitalize="characters" autocorrect="off"
           spellcheck="false" enterkeyhint="go" placeholder="例如 JUL-185" aria-label="番号">
    <button class="go" id="go" type="submit">下载中文字幕</button>
  </form>
  <div class="row">
    <button type="button" data-index="1">候选 #1</button>
    <button type="button" data-index="2">候选 #2</button>
    <button type="button" data-index="3">候选 #3</button>
  </div>

  <div id="msg"></div>

  <section id="recentBox" hidden>
    <h2>最近</h2>
    <div class="chips" id="recent"></div>
  </section>

  <details>
    <summary>说明</summary>
    <p>· 第一次点会有 3–6 秒解析时间（Worker 正在抓上游），之后同样番号几乎瞬间完成。</p>
    <p>· 已经知道是哪条候选时，直接点「候选 #N」，跳过排序歧义。</p>
    <p>· 想要繁体：地址栏加 <code>&amp;lang=zh-TW</code>。</p>
    <p>· 全部候选都没有中文时，会自动跳到 SubtitleCat 详情页，可以自己挑。</p>
  </details>

<script>
(function () {
  var f = document.getElementById('f');
  var q = document.getElementById('q');
  var go = document.getElementById('go');
  var msg = document.getElementById('msg');
  var recentBox = document.getElementById('recentBox');
  var recentEl = document.getElementById('recent');
  var STORE = 'subtitlecat-recent';

  function say(text, kind) {
    msg.textContent = text || '';
    msg.className = kind || '';
  }

  function loadRecent() {
    try { return JSON.parse(localStorage.getItem(STORE) || '[]'); } catch (e) { return []; }
  }

  function saveRecent(value) {
    var list = loadRecent().filter(function (x) { return x !== value; });
    list.unshift(value);
    list = list.slice(0, 6);
    try { localStorage.setItem(STORE, JSON.stringify(list)); } catch (e) {}
    renderRecent();
  }

  function renderRecent() {
    var list = loadRecent();
    recentEl.innerHTML = '';
    recentBox.hidden = list.length === 0;
    list.forEach(function (value) {
      var chip = document.createElement('button');
      chip.type = 'button';
      chip.className = 'chip';
      chip.textContent = value;
      chip.addEventListener('click', function () { q.value = value; start(null); });
      recentEl.appendChild(chip);
    });
  }

  function start(index) {
    var value = (q.value || '').trim();
    if (!value) { say('先输入番号，例如 JUL-185', 'err'); q.focus(); return; }

    var url = '/api/download?query=' + encodeURIComponent(value) + '&name=' + encodeURIComponent(value + '.srt');
    if (index) url += '&index=' + index;

    saveRecent(value);
    say('正在解析并下载…首次约 3–6 秒。若这条没有中文，会自动跳到 SubtitleCat 详情页。', '');
    go.disabled = true;

    // 顶层跳到一个 attachment 响应：浏览器会直接下载并停在当前页；
    // 若上游没有中文字幕，Worker 会 302 到详情页，用户也能看到而不是静默失败。
    window.location.href = url;

    setTimeout(function () { go.disabled = false; }, 1500);
  }

  f.addEventListener('submit', function (e) { e.preventDefault(); start(null); });

  Array.prototype.forEach.call(document.querySelectorAll('[data-index]'), function (btn) {
    btn.addEventListener('click', function () { start(btn.getAttribute('data-index')); });
  });

  renderRecent();
  q.focus();

  // 支持 /?q=JUL-185（以及 &go=1 直接开始），方便快捷指令 / 书签直接调用
  var params = new URLSearchParams(window.location.search);
  var prefill = params.get('q');
  if (prefill) {
    q.value = prefill;
    if (params.get('go') === '1') { start(null); } else { say('已填入 ' + prefill); }
  }
})();
</script>
</body>
</html>`;
}

/* ------------------------------------------------------------------ 入口 */

export default {
  async fetch(request) {
    try {
      const url = new URL(request.url);
      const path = normalizePath(url.pathname);

      if (request.method === 'OPTIONS') {
        return new Response(null, {
          status: 204,
          headers: {
            'access-control-allow-origin': '*',
            'access-control-allow-methods': 'GET, OPTIONS',
            'access-control-allow-headers': 'content-type',
            'access-control-max-age': '86400',
          },
        });
      }

      if (request.method !== 'GET' && request.method !== 'HEAD') {
        return json({ error: 'METHOD_NOT_ALLOWED' }, { status: 405 });
      }

      if (path === '/health') {
        return json({ ok: true, version: 2 });
      }

      // Worker 自己托管的一步下载页面（可加到手机主屏幕）
      if (path === '/' || path === '/index.html' || path === '/app') {
        return html(renderPage());
      }

      if (path === '/api/resolve') {
        const query = url.searchParams.get('query') || url.searchParams.get('q') || '';
        if (!query.trim()) return badRequest('缺少 query 参数');

        const lang = url.searchParams.get('lang') || '';
        const top = url.searchParams.get('top') || '';

        try {
          const resolved = await resolveQuery(query, { lang, top });
          return json(resolved);
        } catch (err) {
          return json({ error: 'RESOLVE_FAILED', message: err?.message || String(err) }, { status: 502 });
        }
      }

      if (path === '/api/download') {
        return await handleDownload(url, request);
      }

      return json({ error: 'NOT_FOUND', path }, { status: 404 });
    } catch (err) {
      return json({ error: 'WORKER_EXCEPTION', message: err?.message || String(err) }, { status: 500 });
    }
  },
};
