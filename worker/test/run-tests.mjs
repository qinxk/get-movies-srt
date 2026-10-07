/**
 * 用真实抓下来的 SubtitleCat HTML 做夹具，离线验证 Worker v2。
 *
 * 运行： node test/run-tests.mjs
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import worker from '../src/index.js';

const here = dirname(fileURLToPath(import.meta.url));
const fixture = (name) => readFileSync(join(here, 'fixtures', name), 'utf8');

/* ------------------------------------------------------------------ 断言 */

let passed = 0;
const failures = [];

function check(name, condition, detail) {
  if (condition) {
    passed++;
    console.log(`  \u2713 ${name}`);
  } else {
    failures.push(name);
    console.log(`  \u2717 ${name}${detail ? `  -> ${detail}` : ''}`);
  }
}

function eq(name, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  check(name, ok, ok ? '' : `期望 ${JSON.stringify(expected)}，实际 ${JSON.stringify(actual)}`);
}

function section(title) {
  console.log(`\n${title}`);
}

/* ------------------------------------------------------------------ fetch 打桩 */

const PAGES = new Map([
  ['/index.php?search=JUL-185', fixture('search-jul185.html')],
  ['/index.php?search=SYNTH-001', fixture('synth-search.html')],
  ['/index.php?search=ZZQQ-99999', fixture('empty-search.html')],
  ['/subs/177/JUL-185 eng.html', fixture('detail-177.html')],
  ['/subs/176/JUL-185.html', fixture('detail-176.html')],
  ['/subs/206/JUL-185-zh-CN.html', fixture('detail-206.html')],
  ['/subs/900/SYNTH-001-nozh.html', fixture('synth-detail-nozh.html')],
  ['/subs/901/SYNTH-001-zh.html', fixture('synth-detail-zh.html')],
]);

const FAKE_SRT = '1\n00:00:01,000 --> 00:00:02,000\n测试字幕\n\n';

let upstreamCalls = 0;
const realFetch = globalThis.fetch;

globalThis.fetch = async (input, init) => {
  const href = typeof input === 'string' ? input : input.url;
  const url = new URL(href);
  const decodedPath = decodeURIComponent(url.pathname) + url.search;
  upstreamCalls++;

  if (decodedPath.endsWith('.srt')) {
    return new Response(FAKE_SRT, {
      status: 200,
      headers: { 'content-type': 'application/x-subrip; charset=utf-8' },
    });
  }

  const body = PAGES.get(decodedPath);
  if (body != null) {
    return new Response(body, { status: 200, headers: { 'content-type': 'text/html; charset=utf-8' } });
  }

  return new Response('not found', { status: 404 });
};

/* ------------------------------------------------------------------ 用例 */

const BASE = 'https://worker.test';
const call = (path, headers) => worker.fetch(new Request(BASE + path, { headers }));

section('1) 下载量解析（v1 恒为 0 的 bug）');
{
  const res = await call('/api/resolve?query=JUL-185');
  const data = await res.json();

  eq('HTTP 200', res.status, 200);
  eq('识别番号', data.searchCode, 'JUL-185');
  eq('扫到 8 条结果', data.scannedResults, 8);
  eq('取前 3 条', data.candidates.length, 3);
  eq('按下载量降序 71/63/41', data.candidates.map((c) => c.downloads), [71, 63, 41]);
  eq('标题顺序正确', data.candidates.map((c) => c.title), ['JUL-185 eng', 'JUL-185', 'JUL-185-zh-CN']);
  eq('评分被解析出来', data.candidates.map((c) => c.rating), ['bad', 'good', null]);
  eq('三条都找到中文', data.candidates.map((c) => !!c.subtitle), [true, true, true]);
  eq('无错误', data.error, null);
  eq('topResult 带下载量', data.topResult.downloads, 71);
  eq('兼容字段 downloadsTop3 同步', data.downloadsTop3.length, 3);
}

section('2) 中文识别用 id 语言码，而不是猜文本窗口');
{
  const res = await call('/api/resolve?query=JUL-185');
  const data = await res.json();
  const [first, , third] = data.candidates;

  eq('#1 选中简体', first.subtitle.lang, 'zh-CN');
  eq('#1 标签', first.subtitle.label, 'Chinese (Simplified)');
  eq('中文变体去重后存在', first.chineseVariants.length >= 2, true);
  eq('变体含 zh-TW', first.chineseVariants.some((v) => v.lang === 'zh-TW'), true);
  eq('#3 也同样识别出中文', !!third.subtitle, true);
}

section('3) ?lang=zh-TW 指定繁体');
{
  const res = await call('/api/resolve?query=JUL-185&lang=zh-TW');
  const data = await res.json();
  eq('选中繁体', data.candidates[0].subtitle.lang, 'zh-TW');
  eq('标签为繁体', data.candidates[0].subtitle.label, 'Chinese (Traditional)');
}

section('4) 缓存：第二次查询不再打上游');
{
  upstreamCalls = 0;
  await call('/api/resolve?query=JUL-185');
  const warm = upstreamCalls;
  check('热查询 0 次上游请求', warm === 0, `实际 ${warm} 次`);
}

section('5) /api/download 默认挑「第一条有中文的候选」（v1 固定 #1 会误报 404）');
{
  const res = await call('/api/download?query=SYNTH-001');
  const body = await res.text();

  eq('HTTP 200', res.status, 200);
  eq('返回的是字幕内容', body.includes('-->'), true);
  eq('自动落到 rank 2', res.headers.get('x-subtitle-rank'), '2');
  eq('语言为 zh-CN', res.headers.get('x-subtitle-lang'), 'zh-CN');
}

section('6) /api/download 指定 index');
{
  const res = await call('/api/download?query=JUL-185&index=3');
  eq('HTTP 200', res.status, 200);
  eq('rank 3', res.headers.get('x-subtitle-rank'), '3');
  await res.text();
}

section('7) Content-Disposition 支持中文名（RFC 5987）');
{
  const res = await call('/api/download?query=JUL-185&name=' + encodeURIComponent('hhd800.com@原版首发'));
  const cd = res.headers.get('content-disposition');
  await res.text();

  check('有 ASCII 兜底 filename', /filename="[\x20-\x7e]*"/.test(cd), cd);
  check('有 filename* UTF-8 真名', cd.includes("filename*=UTF-8''"), cd);
  check('中文被百分号编码', cd.includes(encodeURIComponent('hhd800.com@原版首发')), cd);
  check('整条响应头纯 ASCII（不会抛 header 异常）', /^[\x20-\x7e]+$/.test(cd), cd);
}

section('8) 出错时按 Accept 协商');
{
  const browser = await call('/api/download?query=ZZQQ-99999', {
    accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
  });
  eq('浏览器 -> 302', browser.status, 302);
  check('跳到上游搜索页', (browser.headers.get('location') || '').includes('subtitlecat.com'), browser.headers.get('location'));

  const cli = await call('/api/download?query=ZZQQ-99999', { accept: 'application/x-subrip, text/*, */*' });
  eq('脚本 -> 404 JSON', cli.status, 404);
  const data = await cli.json();
  eq('错误码', data.error, 'NO_RESULTS');
  check('带可读中文说明', typeof data.message === 'string' && data.message.length > 0, JSON.stringify(data));
}

section('9) 移动端一步下载页面');
{
  const res = await call('/');
  const body = await res.text();
  eq('HTTP 200', res.status, 200);
  check('是 HTML', (res.headers.get('content-type') || '').includes('text/html'));
  check('有输入框', body.includes('id="q"'));
  check('表单直接提交下载', body.includes("f.addEventListener('submit'"));
  check('有 3 个候选按钮', (body.match(/data-index="/g) || []).length === 3);
  check('打到 /api/download', body.includes("'/api/download?query='"));
  check('有 viewport 适配手机', body.includes('name="viewport"'));
  check('支持加到主屏幕', body.includes('apple-mobile-web-app-capable'));
  check('有最近使用记录', body.includes('localStorage'));
  check('支持 ?q= 预填 / ?go=1 直接开始', body.includes("params.get('q')") && body.includes("params.get('go')"));
  check('用顶层跳转而不是 iframe（302 回退可见）', body.includes('window.location.href = url') && !body.includes('createElement(\'iframe\')'));
}

section('10) 其他路由');
{
  const health = await call('/health');
  eq('/health', await health.json(), { ok: true, version: 2 });

  const missing = await call('/nope');
  eq('/nope -> 404', missing.status, 404);

  const post = await worker.fetch(new Request(BASE + '/api/resolve', { method: 'POST' }));
  eq('POST -> 405', post.status, 405);
}

/* ------------------------------------------------------------------ 收尾 */

globalThis.fetch = realFetch;

console.log(`\n${'-'.repeat(52)}`);
if (failures.length) {
  console.log(`失败 ${failures.length} 项，通过 ${passed} 项`);
  failures.forEach((f) => console.log(`  - ${f}`));
  process.exit(1);
} else {
  console.log(`全部通过：${passed} 项`);
}
