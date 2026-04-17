// Configure to your deployed Worker origin, e.g. https://subtitlecat-srt.<your-subdomain>.workers.dev
const WORKER_ORIGIN = 'https://subtitlecat-srt.linfengwuchen.workers.dev';

const $ = function (id) {
  return document.getElementById(id);
};

var lastQuery = '';

function setStatus(text, kind) {
  kind = kind || 'info';
  var el = $('status');
  if (!el) return;
  el.textContent = text || '';
  el.className = 'status' + (kind === 'error' ? ' error' : kind === 'ok' ? ' ok' : '');
}

function renderKV(container, key, value, asLink) {
  asLink = !!asLink;
  var row = document.createElement('div');
  row.className = 'kv';

  var k = document.createElement('div');
  k.className = 'k';
  k.textContent = key;

  var v = document.createElement('div');
  v.className = 'v';

  if (value == null || value === '') {
    v.textContent = '-';
  } else if (asLink) {
    var a = document.createElement('a');
    a.href = value;
    a.target = '_blank';
    a.rel = 'noreferrer';
    a.textContent = value;
    v.appendChild(a);
  } else {
    v.textContent = String(value);
  }

  row.appendChild(k);
  row.appendChild(v);
  container.appendChild(row);
}

function resolveQuery(query) {
  if (!WORKER_ORIGIN || WORKER_ORIGIN.indexOf('REPLACE_WITH') !== -1) {
    throw new Error('请先在 site/app.js 里配置 WORKER_ORIGIN');
  }
  var url = new URL('/api/resolve', WORKER_ORIGIN);
  url.searchParams.set('query', query);
  return fetch(url.toString(), { method: 'GET' }).then(function (res) {
    if (!res.ok) {
      throw new Error('解析失败（HTTP ' + res.status + '）');
    }
    return res.json();
  });
}

function buildDownloadUrl(query, index) {
  var url = new URL('/api/download', WORKER_ORIGIN);
  url.searchParams.set('query', query);
  if (index >= 1 && index <= 3) {
    url.searchParams.set('index', String(index));
  }
  return url.toString();
}

function clearDownloadLinks() {
  var wrap = $('downloadLinks');
  if (wrap) wrap.innerHTML = '';
}

function fillDownloadLinks(query, data) {
  clearDownloadLinks();
  var wrap = $('downloadLinks');
  if (!wrap) return;

  var top3 = (data && data.downloadsTop3) || [];
  for (var i = 0; i < top3.length; i++) {
    var it = top3[i];
    var a = document.createElement('a');
    a.className = 'secondary';
    a.textContent = '下载 #' + it.rank + '（' + it.downloads + ' 次）';
    if (it.subtitle && it.subtitle.downloadUrl) {
      a.href = buildDownloadUrl(query, it.rank);
      a.className = 'secondary';
    } else {
      a.href = '#';
      a.className = 'secondary muted';
      a.setAttribute('aria-disabled', 'true');
      a.onclick = function (e) {
        e.preventDefault();
      };
    }
    wrap.appendChild(a);
  }
}

function setPreview(data) {
  data = data || {};
  var container = $('preview');
  if (!container) return;
  container.innerHTML = '';

  renderKV(container, '输入', data.input || '-');
  renderKV(container, '识别番号', data.searchCode || '-');

  var base = data.baseFilename || '';
  if (!base && data.filename) {
    base = String(data.filename).replace(/_\d+\.srt$/i, '').replace(/\.srt$/i, '');
  }
  renderKV(container, '文件名规则', (base || '-') + '_1.srt ~ _3.srt');

  var top3 = data.downloadsTop3 || [];
  if (top3.length) {
    var lines = [];
    for (var t = 0; t < top3.length; t++) {
      var it = top3[t];
      var title = (it.title || '').length > 60 ? (it.title || '').slice(0, 60) + '…' : it.title || '';
      lines.push('#' + it.rank + ' ' + it.downloads + ' 次 — ' + title + (it.subtitle ? ' 【有中文】' : ' 【无中文】'));
    }
    renderKV(container, '前 3 条（下载量降序）', lines.join('\n'), false);
  } else if (data.topResult) {
    var dls = data.topResult.downloads != null ? data.topResult.downloads : '-';
    renderKV(container, '最大 downloads', dls, false);
    renderKV(container, '详情页', data.topResult.detailUrl || '-', true);
    renderKV(container, '字幕语言', (data.subtitle && data.subtitle.label) || '-', false);
    renderKV(container, '字幕链接', (data.subtitle && data.subtitle.downloadUrl) || '-', true);
  }

  var copyBtn = $('copyBtn');
  var hasAny = false;
  for (var j = 0; j < top3.length; j++) {
    if (top3[j].subtitle) {
      hasAny = true;
      break;
    }
  }
  if (copyBtn) copyBtn.disabled = !hasAny;
}

function onResolve() {
  var queryEl = $('query');
  var query = queryEl ? String(queryEl.value || '').trim() : '';
  if (!query) {
    setStatus('请输入内容', 'error');
    return;
  }

  lastQuery = query;

  var resolveBtn = $('resolveBtn');
  if (resolveBtn) resolveBtn.disabled = true;
  var copyBtn = $('copyBtn');
  if (copyBtn) copyBtn.disabled = true;
  clearDownloadLinks();

  setStatus('解析中（可能需几秒，正在抓取前 3 条详情）...', 'info');
  setPreview({});

  resolveQuery(query)
    .then(function (data) {
      setPreview(data);
      fillDownloadLinks(query, data);

      if (data && data.error === 'NO_RESULTS') {
        setStatus('未找到任何字幕结果。', 'error');
        return;
      }
      if (data && data.error === 'NO_CHINESE_SRT') {
        setStatus('前 3 条均未发现中文 SRT。', 'error');
        return;
      }
      if (data && data.error) {
        setStatus('解析失败：' + data.error, 'error');
        return;
      }

      var n = 0;
      var top3 = data.downloadsTop3 || [];
      for (var i = 0; i < top3.length; i++) {
        if (top3[i].subtitle) n += 1;
      }
      setStatus('解析成功：共 ' + top3.length + ' 条结果，其中 ' + n + ' 条可下载中文 SRT。', 'ok');

      if (copyBtn) {
        copyBtn.onclick = function () {
          var parts = [];
          for (var k = 0; k < top3.length; k++) {
            if (top3[k].subtitle) {
              parts.push(buildDownloadUrl(query, top3[k].rank));
            }
          }
          var text = parts.join('\n');
          if (navigator.clipboard && navigator.clipboard.writeText) {
            navigator.clipboard.writeText(text).then(
              function () {
                setStatus('已复制 ' + parts.length + ' 个下载链接。', 'ok');
              },
              function () {
                setStatus('复制失败。', 'error');
              }
            );
          } else {
            setStatus('复制失败（浏览器不支持剪贴板）。', 'error');
          }
        };
      }
    })
    .catch(function (e) {
      var msg = e && e.message ? e.message : String(e);
      setStatus(msg, 'error');
      clearDownloadLinks();
    })
    .then(function () {
      if (resolveBtn) resolveBtn.disabled = false;
    });
}

function bindUi() {
  var rb = $('resolveBtn');
  var q = $('query');
  if (rb) rb.addEventListener('click', onResolve);
  if (q) {
    q.addEventListener('keydown', function (e) {
      if (e.key === 'Enter') onResolve();
    });
  }
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', bindUi);
} else {
  bindUi();
}
