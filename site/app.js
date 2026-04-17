// Configure to your deployed Worker origin, e.g. https://subtitlecat-srt.<your-subdomain>.workers.dev
const WORKER_ORIGIN = 'https://subtitlecat-srt.linfengwuchen.workers.dev';

const $ = (id) => document.getElementById(id);

function setStatus(text, kind = 'info') {
  const el = $('status');
  el.textContent = text || '';
  el.className = 'status' + (kind === 'error' ? ' error' : kind === 'ok' ? ' ok' : '');
}

function renderKV(container, key, value, asLink = false) {
  const row = document.createElement('div');
  row.className = 'kv';

  const k = document.createElement('div');
  k.className = 'k';
  k.textContent = key;

  const v = document.createElement('div');
  v.className = 'v';

  if (value == null || value === '') {
    v.textContent = '-';
  } else if (asLink) {
    const a = document.createElement('a');
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

async function resolveQuery(query) {
  if (!WORKER_ORIGIN || WORKER_ORIGIN.includes('REPLACE_WITH')) {
    throw new Error('请先在 site/app.js 里配置 WORKER_ORIGIN');
  }
  const url = new URL('/api/resolve', WORKER_ORIGIN);
  url.searchParams.set('query', query);
  const res = await fetch(url.toString(), { method: 'GET' });
  if (!res.ok) throw new Error(`解析失败（HTTP ${res.status}）`);
  return await res.json();
}

function buildDownloadUrl(query) {
  const url = new URL('/api/download', WORKER_ORIGIN);
  url.searchParams.set('query', query);
  return url.toString();
}

function setPreview(data) {
  const container = $('preview');
  container.innerHTML = '';

  renderKV(container, '输入', data?.input || '-');
  renderKV(container, '识别番号', data?.searchCode || '-');
  renderKV(container, '输出文件名', data?.filename || '-');
  renderKV(container, '最大 downloads', data?.topResult?.downloads ?? '-', false);
  renderKV(container, '详情页', data?.topResult?.detailUrl || '-', true);
  renderKV(container, '字幕语言', data?.subtitle?.label || '-', false);
  renderKV(container, '字幕链接', data?.subtitle?.downloadUrl || '-', true);

  const downloadBtn = $('downloadBtn');
  const copyBtn = $('copyBtn');

  const canDownload = Boolean(data?.subtitle?.downloadUrl) && !data?.error;
  downloadBtn.disabled = !canDownload;
  copyBtn.disabled = !canDownload;
}

async function onResolve() {
  const query = $('query').value.trim();
  if (!query) {
    setStatus('请输入内容', 'error');
    return;
  }

  const resolveBtn = $('resolveBtn');
  resolveBtn.disabled = true;
  $('downloadBtn').disabled = true;
  $('copyBtn').disabled = true;

  setStatus('解析中...', 'info');
  setPreview({});

  try {
    const data = await resolveQuery(query);
    setPreview(data);

    if (data?.error === 'NO_RESULTS') {
      setStatus('未找到任何字幕结果。', 'error');
      return;
    }
    if (data?.error === 'NO_CHINESE_SRT') {
      setStatus('找到结果但未发现中文 SRT。', 'error');
      return;
    }
    if (data?.error) {
      setStatus(`解析失败：${data.error}`, 'error');
      return;
    }

    setStatus('解析成功，可以下载。', 'ok');

    // Wire download/copy for current query
    const downloadUrl = buildDownloadUrl(query);
    $('downloadBtn').onclick = () => {
      window.location.href = downloadUrl;
    };
    $('copyBtn').onclick = async () => {
      try {
        await navigator.clipboard.writeText(downloadUrl);
        setStatus('已复制下载链接。', 'ok');
      } catch {
        setStatus('复制失败（浏览器不支持剪贴板权限）。', 'error');
      }
    };
  } catch (e) {
    setStatus(e?.message || String(e), 'error');
  } finally {
    resolveBtn.disabled = false;
  }
}

document.addEventListener('DOMContentLoaded', () => {
  $('resolveBtn').addEventListener('click', onResolve);
  $('query').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') onResolve();
  });
});

