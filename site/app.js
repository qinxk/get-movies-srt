// Configure to your deployed Worker origin, e.g. https://subtitlecat-srt.<your-subdomain>.workers.dev
const WORKER_ORIGIN = 'https://subtitlecat-srt.linfengwuchen.workers.dev';

const $ = function (id) {
  return document.getElementById(id);
};

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

function getProp(obj, path, fallback) {
  if (obj == null) return fallback;
  var parts = path.split('.');
  var cur = obj;
  for (var i = 0; i < parts.length; i++) {
    if (cur == null) return fallback;
    cur = cur[parts[i]];
  }
  return cur == null ? fallback : cur;
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

function buildDownloadUrl(query) {
  var url = new URL('/api/download', WORKER_ORIGIN);
  url.searchParams.set('query', query);
  return url.toString();
}

function setPreview(data) {
  data = data || {};
  var container = $('preview');
  if (!container) return;
  container.innerHTML = '';

  renderKV(container, '输入', data.input || '-');
  renderKV(container, '识别番号', data.searchCode || '-');
  renderKV(container, '输出文件名', data.filename || '-');

  var downloads = getProp(data, 'topResult.downloads', null);
  renderKV(container, '最大 downloads', downloads != null ? downloads : '-', false);

  renderKV(container, '详情页', (data.topResult && data.topResult.detailUrl) || '-', true);
  renderKV(container, '字幕语言', (data.subtitle && data.subtitle.label) || '-', false);
  renderKV(container, '字幕链接', (data.subtitle && data.subtitle.downloadUrl) || '-', true);

  var downloadBtn = $('downloadBtn');
  var copyBtn = $('copyBtn');
  var canDownload = !!(data.subtitle && data.subtitle.downloadUrl) && !data.error;
  if (downloadBtn) downloadBtn.disabled = !canDownload;
  if (copyBtn) copyBtn.disabled = !canDownload;
}

function onResolve() {
  var queryEl = $('query');
  var query = queryEl ? String(queryEl.value || '').trim() : '';
  if (!query) {
    setStatus('请输入内容', 'error');
    return;
  }

  var resolveBtn = $('resolveBtn');
  if (resolveBtn) resolveBtn.disabled = true;
  var dBtn = $('downloadBtn');
  var cBtn = $('copyBtn');
  if (dBtn) dBtn.disabled = true;
  if (cBtn) cBtn.disabled = true;

  setStatus('解析中...', 'info');
  setPreview({});

  resolveQuery(query)
    .then(function (data) {
      setPreview(data);

      if (data && data.error === 'NO_RESULTS') {
        setStatus('未找到任何字幕结果。', 'error');
        return;
      }
      if (data && data.error === 'NO_CHINESE_SRT') {
        setStatus('找到结果但未发现中文 SRT。', 'error');
        return;
      }
      if (data && data.error) {
        setStatus('解析失败：' + data.error, 'error');
        return;
      }

      setStatus('解析成功，可以下载。', 'ok');

      var downloadUrl = buildDownloadUrl(query);
      if (dBtn) {
        dBtn.onclick = function () {
          window.location.href = downloadUrl;
        };
      }
      if (cBtn) {
        cBtn.onclick = function () {
          if (navigator.clipboard && navigator.clipboard.writeText) {
            navigator.clipboard.writeText(downloadUrl).then(
              function () {
                setStatus('已复制下载链接。', 'ok');
              },
              function () {
                setStatus('复制失败（浏览器不支持剪贴板权限）。', 'error');
              }
            );
          } else {
            setStatus('复制失败（浏览器不支持剪贴板权限）。', 'error');
          }
        };
      }
    })
    .catch(function (e) {
      var msg = e && e.message ? e.message : String(e);
      setStatus(msg, 'error');
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

// 动态插入 + defer 的 app.js 可能在 DOMContentLoaded 之后才执行，仅监听 DOMContentLoaded 会永远不绑定点击
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', bindUi);
} else {
  bindUi();
}
