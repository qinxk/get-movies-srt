const SUBTITLECAT_ORIGIN = 'https://subtitlecat.com';

function json(data, init = {}) {
  const headers = new Headers(init.headers || {});
  headers.set('content-type', 'application/json; charset=utf-8');
  headers.set('access-control-allow-origin', '*');
  headers.set('access-control-allow-methods', 'GET, OPTIONS');
  headers.set('access-control-allow-headers', 'content-type');
  return new Response(JSON.stringify(data, null, 2), { ...init, headers });
}

function text(data, init = {}) {
  const headers = new Headers(init.headers || {});
  headers.set('content-type', 'text/plain; charset=utf-8');
  headers.set('access-control-allow-origin', '*');
  return new Response(String(data ?? ''), { ...init, headers });
}

function badRequest(message) {
  return json({ error: message }, { status: 400 });
}

function sanitizeFilenameBase(name) {
  const s = String(name || '').trim();
  const cleaned = s.replace(/[\\/:*?"<>|]/g, '_').replace(/\s+/g, ' ').trim();
  return cleaned.replace(/[. ]+$/g, '') || 'subtitle';
}

function extractSearchCode(input) {
  const s = String(input || '').trim();
  const mHyphen = s.match(/\b([a-z]{2,10})\s*-\s*(\d{2,6})\b/i);
  if (mHyphen) return `${mHyphen[1].toUpperCase()}-${mHyphen[2]}`;
  const mNoHyphen = s.match(/\b([a-z]{2,10})(\d{2,6})\b/i);
  if (mNoHyphen) return `${mNoHyphen[1].toUpperCase()}-${mNoHyphen[2]}`;
  return s;
}

function parseDownloadsFromText(text) {
  const raw = String(text || '');
  const m1 = raw.match(/(\d[\d,]{0,})\s*(downloads|下载)\b/i);
  const m2 = raw.match(/\b(downloads|下载)\s*(\d[\d,]{0,})/i);
  const m = m1 ? m1[1] : (m2 ? m2[2] : null);
  if (!m) return null;
  const normalized = m.replace(/,/g, '');
  const n = parseInt(normalized, 10);
  return Number.isFinite(n) ? n : null;
}

function rankChineseSrtContext(contextText) {
  const normalized = String(contextText || '').toLowerCase();
  const has = (re) => re.test(normalized);

  const simplified =
    has(/chinese\s*(\(\s*)?simplified(\s*\))?/i) ||
    has(/\bchinese\s+simple\b/i) ||
    has(/简体/) ||
    has(/\bzh[-_](cn|hans)\b/i) ||
    has(/(^|[^a-z0-9])chs([^a-z0-9]|$)/i);
  if (simplified) return 300;

  const traditional =
    has(/chinese\s*(\(\s*)?traditional(\s*\))?/i) ||
    has(/繁体/) ||
    has(/\bzh[-_](tw|hk|hant)\b/i) ||
    has(/(^|[^a-z0-9])cht([^a-z0-9]|$)/i);
  if (traditional) return 200;

  const generic =
    has(/\bchinese\b/i) ||
    has(/中文/) ||
    has(/\bzh\b/i);
  return generic ? 100 : 0;
}

function pickAllSearchResultsSorted(searchHtml) {
  const html = String(searchHtml || '');
  const trMatches = html.match(/<tr[\s\S]*?<\/tr>/gi) || [];
  const rows = [];

  for (const tr of trMatches) {
    const hrefMatch = tr.match(/<a[^>]+href="([^"]*(?:\/)?subs\/[^"]+?\.html)"[^>]*>([\s\S]*?)<\/a>/i);
    if (!hrefMatch) continue;

    const href = hrefMatch[1];
    const title = hrefMatch[2].replace(/<[^>]*>/g, '').trim();

    const m = tr.match(/(\d[\d,]{0,})\s*(downloads|下载)\b/i);
    const downloads = m ? (parseDownloadsFromText(m[0]) ?? 0) : 0;

    rows.push({ href, downloads, title });
  }

  rows.sort((a, b) => b.downloads - a.downloads);
  return rows;
}

function pickBestChineseSrt(detailHtml) {
  const html = String(detailHtml || '');
  const matches = Array.from(html.matchAll(/<a[^>]+href="([^"]+?\.srt(?:\?[^"]*)?(?:#[^"]*)?)"[^>]*>\s*Download\s*<\/a>/gi));

  let best = null;

  for (const m of matches) {
    const href = m[1];
    // Use a window around the match to infer language label nearby.
    const idx = m.index ?? 0;
    const start = Math.max(0, idx - 250);
    const end = Math.min(html.length, idx + 250);
    const context = html.slice(start, end);
    const contextText = context.replace(/<[^>]*>/g, ' ');
    const score = rankChineseSrtContext(`${contextText} ${href}`);

    if (score <= 0) continue;

    // Try to extract a human label near by (e.g. "Chinese (Simplified)")
    let label = null;
    const labelMatch = contextText.match(/Chinese\s*\(\s*(Simplified|Traditional)\s*\)|Chinese\s+Simplified|Chinese\s+Traditional|中文|简体|繁体/iu);
    if (labelMatch) label = String(labelMatch[0]).trim();

    if (!best || score > best.score) {
      best = { href, score, label };
    }
  }

  return best;
}

async function fetchTextOrThrow(url, init) {
  const res = await fetch(url, init);
  if (!res.ok) {
    throw new Error(`Upstream HTTP ${res.status}`);
  }
  return await res.text();
}

async function resolveSubtitlesQuery(query) {
  const input = String(query || '').trim();
  const searchCode = extractSearchCode(input);
  const base = sanitizeFilenameBase(input);

  const searchUrl = `${SUBTITLECAT_ORIGIN}/index.php?search=${encodeURIComponent(searchCode)}`;
  const searchHtml = await fetchTextOrThrow(searchUrl, {
    headers: {
      'user-agent': 'subtitlecat-srt/1.0 (+workers)',
      'accept': 'text/html',
    },
  });

  const sorted = pickAllSearchResultsSorted(searchHtml);
  if (!sorted.length) {
    return {
      input,
      searchCode,
      baseFilename: base,
      downloadsTop3: [],
      topResult: null,
      filename: `${base}_1.srt`,
      subtitle: null,
      error: 'NO_RESULTS',
    };
  }

  const top3source = sorted.slice(0, 3);
  const downloadsTop3 = [];

  for (let i = 0; i < top3source.length; i++) {
    const r = top3source[i];
    const rank = i + 1;
    const detailUrl = new URL(r.href, SUBTITLECAT_ORIGIN).href;
    let subtitle = null;

    try {
      const detailHtml = await fetchTextOrThrow(detailUrl, {
        headers: {
          'user-agent': 'subtitlecat-srt/1.0 (+workers)',
          'accept': 'text/html',
        },
      });
      const bestSrt = pickBestChineseSrt(detailHtml);
      if (bestSrt) {
        subtitle = {
          downloadUrl: new URL(bestSrt.href, SUBTITLECAT_ORIGIN).href,
          score: bestSrt.score,
          label: bestSrt.label || null,
        };
      }
    } catch {
      subtitle = null;
    }

    downloadsTop3.push({
      rank,
      downloads: r.downloads,
      title: r.title,
      detailUrl,
      filename: `${base}_${rank}.srt`,
      subtitle,
    });
  }

  const anyChinese = downloadsTop3.some((x) => x.subtitle);
  const firstWith = downloadsTop3.find((x) => x.subtitle);

  return {
    input,
    searchCode,
    baseFilename: base,
    downloadsTop3,
    topResult: downloadsTop3[0]
      ? {
          downloads: downloadsTop3[0].downloads,
          title: downloadsTop3[0].title,
          detailUrl: downloadsTop3[0].detailUrl,
        }
      : null,
    filename: firstWith ? firstWith.filename : `${base}_1.srt`,
    subtitle: firstWith ? firstWith.subtitle : null,
    error: anyChinese ? null : 'NO_CHINESE_SRT',
  };
}

export default {
  async fetch(request) {
    const url = new URL(request.url);

    if (request.method === 'OPTIONS') {
      return new Response(null, {
        status: 204,
        headers: {
          'access-control-allow-origin': '*',
          'access-control-allow-methods': 'GET, OPTIONS',
          'access-control-allow-headers': 'content-type',
        },
      });
    }

    if (request.method !== 'GET') {
      return text('Method Not Allowed', { status: 405 });
    }

    if (url.pathname === '/' || url.pathname === '/health') {
      return json({ ok: true });
    }

    if (url.pathname === '/api/resolve') {
      const query = url.searchParams.get('query') || '';
      if (!query.trim()) return badRequest('Missing query');
      try {
        const resolved = await resolveSubtitlesQuery(query);
        return json(resolved);
      } catch (err) {
        return json({ error: 'RESOLVE_FAILED', message: err?.message || String(err) }, { status: 502 });
      }
    }

    if (url.pathname === '/api/download') {
      const query = url.searchParams.get('query') || '';
      if (!query.trim()) return badRequest('Missing query');

      const indexRaw = url.searchParams.get('index') || '1';
      const index = Math.max(1, Math.min(3, parseInt(indexRaw, 10) || 1));

      let resolved;
      try {
        resolved = await resolveSubtitlesQuery(query);
      } catch (err) {
        return json({ error: 'RESOLVE_FAILED', message: err?.message || String(err) }, { status: 502 });
      }

      if (resolved.error === 'NO_RESULTS') {
        return json(resolved, { status: 404 });
      }
      if (resolved.error === 'NO_CHINESE_SRT') {
        return json(resolved, { status: 404 });
      }

      const item =
        resolved.downloadsTop3 && resolved.downloadsTop3[index - 1] ? resolved.downloadsTop3[index - 1] : null;
      if (!item || !item.subtitle || !item.subtitle.downloadUrl) {
        return json(
          { error: 'NO_CHINESE_AT_INDEX', index, message: '该名次无中文 SRT 或条目不存在' },
          { status: 404 }
        );
      }

      let upstream;
      try {
        upstream = await fetch(item.subtitle.downloadUrl, {
          headers: {
            'user-agent': 'subtitlecat-srt/1.0 (+workers)',
            'accept': 'text/plain, text/*, */*',
          },
        });
      } catch (err) {
        return json({ error: 'DOWNLOAD_FETCH_FAILED', message: err?.message || String(err) }, { status: 502 });
      }

      if (!upstream.ok) {
        return json({ error: 'DOWNLOAD_HTTP_ERROR', status: upstream.status }, { status: 502 });
      }

      const headers = new Headers();
      headers.set('content-type', 'application/x-subrip; charset=utf-8');
      headers.set('content-disposition', `attachment; filename="${item.filename}"`);
      headers.set('cache-control', 'no-store');
      headers.set('access-control-allow-origin', '*');

      return new Response(upstream.body, { status: 200, headers });
    }

    return text('Not Found', { status: 404 });
  },
};

