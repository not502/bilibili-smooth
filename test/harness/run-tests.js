'use strict';
/* =============================================================================
 * bilibili-smooth.user.js 回放测试（Node 直接运行：node test/harness/run-tests.js）
 *
 * v2.0.1：脚本只做 P2P/PCDN 换源（不改画质/编码/弹幕等任何播放设置）。
 *
 * 方法：读取工作区根目录 bilibili-smooth.user.js 源码，用 vm 在桩化全局环境中
 * 【真实 eval 执行】（非静态检查），再用 test/samples/ 下的真实接口样本回放：
 *  - fetch 通道：桩 fetch 返回由真实样本 JSON 构造的 Response（Node 原生 Response，
 *    保证脚本内 resp.clone()/new Headers/new Response 走真实路径）；
 *  - XHR 通道：桩 XMLHttpRequest（原型带 response/responseText getter，满足脚本
 *    installXhrHook 的安装条件）；
 *  - __playinfo__ 通道：直接向 window 赋值触发 defineProperty setter。
 *
 * 断言口径（换源策略，实测依据见脚本设计说明）：
 *  - 主地址为 P2P 节点 → 换用响应内自签名的非 P2P 备用地址，原 P2P 主地址追加为最后备用；
 *  - 无可用备用 / 备用也全为 P2P / 主地址本就正常 / 接口错误体 / 非 playurl URL → 一律原样不动
 *    （实测：伪造签名换主机 403，宁可不改）。
 * ============================================================================= */
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const util = require('node:util');
const assert = require('node:assert');

const ROOT = path.resolve(__dirname, '..', '..');
const SCRIPT_PATH = path.join(ROOT, 'bilibili-smooth.user.js');
const SAMPLES_DIR = path.join(ROOT, 'test', 'samples');

const SRC = fs.readFileSync(SCRIPT_PATH, 'utf8');
const sample = JSON.parse(fs.readFileSync(path.join(SAMPLES_DIR, 'playurl.json'), 'utf8'));
const viewSample = JSON.parse(fs.readFileSync(path.join(SAMPLES_DIR, 'view.json'), 'utf8'));
const provenance = JSON.parse(fs.readFileSync(path.join(SAMPLES_DIR, 'provenance.json'), 'utf8'));

const clone = v => structuredClone(v);
// 跨 vm realm 的深比较：vm 内对象的原型属于 vm realm，deepStrictEqual 会因原型不同而误判，
// 故统一 JSON 往返后再比较（被比较数据均为纯 JSON 值）
const sameJSON = (a, b, msg) => assert.deepStrictEqual(
  JSON.parse(JSON.stringify(a)), JSON.parse(JSON.stringify(b)), msg);

/* ---------------- 桩环境 ---------------- */
function makeConsole(box) {
  const rec = level => (...args) => {
    const text = args.map(a => {
      try { return typeof a === 'string' ? a : util.inspect(a); }
      catch { return String(a); }
    }).join(' ');
    box.push({ level, text });
  };
  return { log: rec('log'), warn: rec('warn'), error: rec('error'), info: rec('log'), debug: rec('log'), trace: rec('log') };
}
function makeDocument() {
  const styles = new Map();
  const mkEl = tag => ({
    tagName: tag, id: '', textContent: '', style: {}, parentNode: null,
    setAttribute() {}, getAttribute() { return null; },
    remove() { if (this.parentNode && this.parentNode.__removeChild) this.parentNode.__removeChild(this); },
    appendChild(child) { if (child && child.id) styles.set(child.id, child); child && (child.parentNode = this); return child; },
    __removeChild(child) { for (const [k, v] of styles) if (v === child) styles.delete(k); child.parentNode = null; return child; },
  });
  const head = mkEl('head');
  head.removeChild = head.__removeChild;
  const body = mkEl('body');
  body.removeChild = body.__removeChild;
  const documentElement = mkEl('html');
  documentElement.removeChild = documentElement.__removeChild;
  return {
    head, body, documentElement,
    createElement: tag => mkEl(tag),
    getElementById: id => styles.get(id) || null,
    addEventListener() {}, removeEventListener() {},
  };
}
class FakeXHR {
  constructor() { this.readyState = 0; this.responseType = ''; this.__text = ''; this.__url = ''; this.__method = ''; }
  open(method, url) { this.__method = method; this.__url = url; } // 脚本会包裹此方法
  send() {}
}
Object.defineProperty(FakeXHR.prototype, 'response', {
  configurable: true,
  get() { return this.responseType === 'json' ? JSON.parse(this.__text) : this.__text; },
});
Object.defineProperty(FakeXHR.prototype, 'responseText', {
  configurable: true,
  get() { return this.__text; },
});

const PLAYURL_URL = provenance.playurlUrl;
const VIEW_URL = provenance.viewUrl;
const PLAYURLSV_URL = 'https://api.bilibili.com/x/player/playurlsv?bvid=BV1GJ411x7h7&cid=137649199&qn=64'; // “playurl” 后跟字母，不应命中 PLAYURL_RE

function makeFetch(routes, callsBox) {
  return function mockFetch(input) {
    const url = typeof input === 'string' ? input : (input && input.url) || String(input);
    callsBox.push(url);
    const r = routes.find(r => r.url === url);
    if (!r) return Promise.reject(new Error('桩 fetch：未注册的 URL：' + url));
    const text = typeof r.body === 'string' ? r.body : JSON.stringify(r.body);
    r.lastResponse = new Response(text, {
      status: r.status != null ? r.status : 200,
      headers: { 'content-type': r.contentType || 'application/json; charset=utf-8' },
    });
    return Promise.resolve(r.lastResponse);
  };
}

/* 评估脚本源码：一次 = 一次真实安装。返回 { sb, box, routes, calls } */
function loadScript(opts = {}) {
  const box = [];
  const calls = [];
  const storage = new Map(Object.entries(opts.localStorageData || {}));
  const routes = opts.routes || [];
  const sb = {};
  sb.window = sb;           // @inject-into page + @grant none：window 即全局
  sb.unsafeWindow = sb;
  sb.GM_getValue = () => undefined;  // GM_* 桩（脚本 v2.0.0 实际未引用）
  sb.GM_setValue = () => {};
  sb.GM_addStyle = () => {};
  sb.GM_xmlhttpRequest = () => {};
  sb.GM_info = { script: { name: 'stub', version: '0' } };
  sb.console = makeConsole(box);
  sb.localStorage = {
    getItem: k => (storage.has(k) ? storage.get(k) : null),
    setItem: (k, v) => storage.set(k, String(v)),
    removeItem: k => storage.delete(k),
    clear: () => storage.clear(),
  };
  sb.document = makeDocument();
  sb.XMLHttpRequest = FakeXHR;
  sb.Headers = Headers;
  sb.Response = Response;
  sb.AbortController = AbortController;
  // 定时器桩：避免 toast 定时器挂住进程；被测逻辑不依赖真实计时
  sb.setTimeout = () => 0;
  sb.clearTimeout = () => {};
  sb.setInterval = () => 0;
  sb.clearInterval = () => {};
  sb.fetch = makeFetch(routes, calls); // installFetchHook 前置条件：window.fetch 是函数
  vm.createContext(sb);
  vm.runInContext(SRC, sb, { filename: 'bilibili-smooth.user.js' });
  return { sb, box, routes, calls };
}

/* ---------------- 测试运行器 ---------------- */
const results = [];
async function runCase(name, fn) {
  const box = [];
  try {
    await fn(box);
    results.push({ name, ok: true });
    console.log(`[PASS] ${name}`);
  } catch (e) {
    results.push({ name, ok: false, err: e, box });
    console.log(`[FAIL] ${name}`);
    console.log(`  断言失败：${e.message}`);
    if (e instanceof assert.AssertionError) {
      console.log(`  期望值：${util.inspect(e.expected, { depth: 4, maxArrayLength: 20, breakLength: 120 })}`);
      console.log(`  实际值：${util.inspect(e.actual, { depth: 4, maxArrayLength: 20, breakLength: 120 })}`);
    }
    const warns = box.filter(b => b.level === 'warn' || b.level === 'error');
    if (warns.length) console.log('  被测脚本 warn/error 记录：\n    ' + warns.map(w => w.text).join('\n    '));
  }
}

/* ================= 测试用例 ================= */
const tests = [];

// P2P/PCDN URL 常量（形态取自本机 2026-11-22 真实样本）
const MCDN_URL = 'https://xy171x43x250x130xy.mcdn.bilivideo.cn:8082/v1/resource/upgcxcode/99/91/137649199/137649199_da2x1-1-100110.m4s?os=mcdn&upsig=abc';
const EDGE_URL = 'https://lve7981c.edge.mountaintoys.cn:4483/upgcxcode/99/91/137649199/137649199_da2x1-1-100110.m4s?os=mcdn&upsig=abc';
const MIRROR_URL = 'https://upos-sz-mirrorcoso1.bilivideo.com/upgcxcode/99/91/137649199/137649199_da2x1-1-100110.m4s?os=coso1bv&upsig=xyz';
const SZBDYD_URL = 'https://xy10x20x30x40xy.szbdyd.com:4483/upgcxcode/99/91/137649199/137649199_da2x1-1-100110.m4s?os=mcdn&upsig=abc';

// (f1) 安装：只做换源，无任何配置入口
tests.push(['(f1) 干净环境加载：安装成功，v2.0.1 仅做换源（无配置入口）', async () => {
  const { sb, box } = loadScript({ routes: [] });
  assert.strictEqual(sb.window.__biliSmoothInstalled__, true, 'window.__biliSmoothInstalled__ 应为 true');
  assert.strictEqual(sb.window.__biliSmoothConfig, undefined, '不应暴露任何配置入口（画质/编码/弹幕逻辑已全部移除）');
  const installedLog = box.filter(b => b.level === 'log' && b.text.includes('已安装'));
  assert.strictEqual(installedLog.length, 1, '应恰好输出 1 条安装日志');
  assert.ok(installedLog[0].text.includes('2.0.1'), '安装日志应含版本号 2.0.1');
  assert.ok(installedLog[0].text.includes('P2P/PCDN'), '安装日志应说明只做 P2P/PCDN 换源');
}]);

// (c) 非 playurl URL 完全透传
tests.push(['(c1) 非 playurl URL（view 接口）：完全透传，返回原 Response', async () => {
  const routes = [{ url: VIEW_URL, body: viewSample }];
  const { sb } = loadScript({ routes });
  const resp = await sb.window.fetch(VIEW_URL);
  const got = await resp.json();
  assert.strictEqual(resp, routes[0].lastResponse, '非 playurl 必须返回原 Response 对象');
  assert.deepStrictEqual(got, viewSample, 'view 响应体必须逐字段一致');
}]);
tests.push(['(c2) playurlsv（“playurl”后跟字母）：不命中 PLAYURL_RE，完全透传', async () => {
  const body = { code: 0, data: { marker: 'sv' } };
  const routes = [{ url: PLAYURLSV_URL, body }];
  const { sb } = loadScript({ routes });
  const resp = await sb.window.fetch(PLAYURLSV_URL);
  const got = await resp.json();
  assert.strictEqual(resp, routes[0].lastResponse, 'playurlsv 必须透传（正则负向断言 (?![\\w.-])）');
  assert.deepStrictEqual(got, body, '响应体必须原样');
}]);

// (b4) 接口错误体
tests.push(['(b4) 接口错误体 code=-412：原样透传', async () => {
  const body = { code: -412, message: '请求被拦截', ttl: 1, data: null };
  const routes = [{ url: PLAYURL_URL, body }];
  const { sb } = loadScript({ routes });
  const resp = await sb.window.fetch(PLAYURL_URL);
  const got = await resp.json();
  assert.deepStrictEqual(got, body, '错误体必须原样透传');
  assert.strictEqual(resp, routes[0].lastResponse, '应返回原 Response 对象');
}]);

// (p1) 核心换源：mcdn 主地址 + 自签名镜像备用
tests.push(['(p1) 主地址为 mcdn、备用含正规镜像：换用自签名镜像，原 P2P 主地址挪为最后备用', async () => {
  const body = { code: 0, data: { dash: {
    video: [{ id: 32, codecid: 7, codecs: 'avc1.64001F', base_url: MCDN_URL, baseUrl: MCDN_URL, backup_url: [EDGE_URL, MIRROR_URL], backupUrl: [EDGE_URL, MIRROR_URL] }],
    audio: [{ id: 30232, base_url: MCDN_URL, backup_url: [MIRROR_URL] }],
  } } };
  const routes = [{ url: PLAYURL_URL, body }];
  const { sb } = loadScript({ routes });
  const got = await (await sb.window.fetch(PLAYURL_URL)).json();
  const v = got.data.dash.video[0];
  assert.strictEqual(v.base_url, MIRROR_URL, '主地址应换用备用中的自签名镜像 URL');
  assert.strictEqual(v.baseUrl, MIRROR_URL, 'baseUrl 驼峰字段应同步');
  assert.deepStrictEqual(v.backup_url, [EDGE_URL, MCDN_URL], '备用应保留原备用列表（去掉已提升为基址的镜像）并把原 P2P 主地址挪到末尾兜底');
  assert.strictEqual(got.data.dash.audio[0].base_url, MIRROR_URL, '音频流同样换源');
  assert.deepStrictEqual(got.data.dash.audio[0].backup_url, [MCDN_URL], '音频流的备用应为原 P2P 主地址');
}]);

// (p2) 备用也全是 P2P：不动
tests.push(['(p2) 主地址与备用全为 P2P（无可用自签名镜像）：整体不动，原样返回', async () => {
  const body = { code: 0, data: { dash: { video: [{ id: 32, base_url: MCDN_URL, baseUrl: MCDN_URL, backup_url: [EDGE_URL] }], audio: [{ id: 30232, base_url: MIRROR_URL }] } } };
  const routes = [{ url: PLAYURL_URL, body }];
  const { sb } = loadScript({ routes });
  const resp = await sb.window.fetch(PLAYURL_URL);
  assert.strictEqual(resp, routes[0].lastResponse, '无可用换源目标时应返回原 Response（绝不伪造签名，实测 403）');
  assert.deepStrictEqual(await resp.json(), body, '响应体应逐字段一致');
}]);

// (p4) 主地址本就正常：不动
tests.push(['(p4) 主地址已是正规 CDN：不受影响', async () => {
  const body = { code: 0, data: { dash: { video: [{ id: 32, base_url: MIRROR_URL, baseUrl: MIRROR_URL, backup_url: [EDGE_URL] }], audio: [] } } };
  const routes = [{ url: PLAYURL_URL, body }];
  const { sb } = loadScript({ routes });
  const resp = await sb.window.fetch(PLAYURL_URL);
  assert.strictEqual(resp, routes[0].lastResponse, '正常地址不应触发任何改写');
}]);

// (p5) durl 渐进式
tests.push(['(p5) durl 渐进式 + P2P 主地址：url 字段同样换源', async () => {
  const body = { code: 0, data: { durl: [{ order: 1, url: MCDN_URL, backup_url: [MIRROR_URL] }] } };
  const routes = [{ url: PLAYURL_URL, body }];
  const { sb } = loadScript({ routes });
  const got = await (await sb.window.fetch(PLAYURL_URL)).json();
  assert.strictEqual(got.data.durl[0].url, MIRROR_URL, 'durl 的 url 应换用自签名镜像');
  assert.deepStrictEqual(got.data.durl[0].backup_url, [MCDN_URL], '原 P2P 主地址应挪为备用');
}]);

// (p6) __playinfo__ 通道
tests.push(['(p6) __playinfo__ 赋值通道：P2P 主地址同样被换源', async () => {
  const { sb } = loadScript({ routes: [] });
  const incoming = { code: 0, data: { dash: { video: [{ id: 32, base_url: MCDN_URL, baseUrl: MCDN_URL, backup_url: [EDGE_URL, MIRROR_URL] }], audio: [] } } };
  sb.window.__playinfo__ = incoming;
  const cur = sb.window.__playinfo__;
  assert.strictEqual(cur.data.dash.video[0].base_url, MIRROR_URL, 'SSR/赋值通道也应换源');
  assert.deepStrictEqual(cur.data.dash.video[0].backup_url, [EDGE_URL, MCDN_URL], '备用列表同步调整');
}]);

// (p7) szbdyd.com 与第三方 PCDN 边缘
tests.push(['(p7) szbdyd.com 与第三方 PCDN 边缘主机：均被识别并换源', async () => {
  const body = { code: 0, data: { dash: {
    video: [{ id: 32, base_url: SZBDYD_URL, backup_url: [MIRROR_URL] }],
    audio: [{ id: 30232, base_url: EDGE_URL, backup_url: [MIRROR_URL] }],
  } } };
  const routes = [{ url: PLAYURL_URL, body }];
  const { sb } = loadScript({ routes });
  const got = await (await sb.window.fetch(PLAYURL_URL)).json();
  assert.strictEqual(got.data.dash.video[0].base_url, MIRROR_URL, 'szbdyd.com 主机应被识别为 P2P 并换源');
  assert.strictEqual(got.data.dash.audio[0].base_url, MIRROR_URL, '第三方 PCDN 边缘主机应被识别并换源');
}]);

// (pgc-v2) 番剧 v2 接口
const PGC_V2_URL = 'https://api.bilibili.com/pgc/player/web/v2/playurl?ep_id=754548&fnval=16&fourk=1';
tests.push(['(pgc-v2a) 番剧 /pgc/player/web/v2/playurl（data.video_info.dash）：P2P 主地址被换源', async () => {
  const body = { code: 0, data: { video_info: { dash: { video: [{ id: 32, base_url: MCDN_URL, baseUrl: MCDN_URL, backup_url: [MIRROR_URL] }], audio: [] } } } };
  const routes = [{ url: PGC_V2_URL, body }];
  const { sb } = loadScript({ routes });
  const resp = await sb.window.fetch(PGC_V2_URL);
  assert.strictEqual(resp.status, 200, 'HTTP 状态应保持 200');
  const got = await resp.json();
  assert.strictEqual(got.data.video_info.dash.video[0].base_url, MIRROR_URL, 'v2 响应的 P2P 主地址应被换源');
}]);
tests.push(['(pgc-v2b) XHR 番剧 v2 URL：open 即标记 hook，responseText 同样被换源', async () => {
  const { sb } = loadScript({ routes: [] });
  const xhr = new sb.XMLHttpRequest();
  xhr.open('GET', PGC_V2_URL);
  assert.strictEqual(xhr.__bsHooked, true, 'pgc v2 URL 应命中 PLAYURL_RE 并标记 hook');
  const body = { code: 0, data: { video_info: { dash: { video: [{ id: 32, base_url: MCDN_URL, backup_url: [MIRROR_URL] }], audio: [] } } } };
  xhr.__text = JSON.stringify(body);
  xhr.readyState = 4;
  const got = JSON.parse(xhr.responseText);
  assert.strictEqual(got.data.video_info.dash.video[0].base_url, MIRROR_URL, 'XHR 通道 v2 响应也应被换源');
}]);

// (e) XHR 通道细节
tests.push(['(e1) XHR text 模式：responseText 在 readyState=4 后已被换源', async () => {
  const { sb } = loadScript({ routes: [] });
  const xhr = new sb.XMLHttpRequest();
  xhr.open('GET', PLAYURL_URL);
  assert.strictEqual(xhr.__bsHooked, true, 'playurl URL 应被标记 hook');
  xhr.__text = JSON.stringify({ code: 0, data: { dash: { video: [{ id: 32, base_url: MCDN_URL, backup_url: [MIRROR_URL] }], audio: [] } } });
  xhr.readyState = 4;
  const text = xhr.responseText;
  const got = JSON.parse(text);
  assert.strictEqual(got.data.dash.video[0].base_url, MIRROR_URL, 'responseText 中主地址应已换源');
  const resp = xhr.response;
  assert.strictEqual(resp, text, 'responseType="" 时 response 与 responseText 应一致');
}]);
tests.push(['(e2) XHR json 模式：response 对象已被换源；responseText 保持原生', async () => {
  const { sb } = loadScript({ routes: [] });
  const xhr = new sb.XMLHttpRequest();
  xhr.open('GET', PLAYURL_URL);
  xhr.__text = JSON.stringify({ code: 0, data: { dash: { video: [{ id: 32, base_url: MCDN_URL, backup_url: [MIRROR_URL] }], audio: [] } } });
  xhr.readyState = 4;
  xhr.responseType = 'json';
  const got = xhr.response;
  assert.ok(got && typeof got === 'object', 'json 模式 response 应为对象');
  assert.strictEqual(got.data.dash.video[0].base_url, MIRROR_URL, 'json 模式 response 也应被换源');
  assert.strictEqual(xhr.responseText, xhr.__text, 'json 模式 responseText 保持原生文本');
}]);
tests.push(['(e3) XHR 非 playurl URL：responseText 完全原样', async () => {
  const { sb } = loadScript({ routes: [] });
  const xhr = new sb.XMLHttpRequest();
  xhr.open('GET', VIEW_URL);
  assert.strictEqual(xhr.__bsHooked, undefined, '非 playurl 不应标记 hook');
  const raw = JSON.stringify(viewSample);
  xhr.__text = raw;
  xhr.readyState = 4;
  assert.strictEqual(xhr.responseText, raw, '非 playurl 响应必须逐字节一致');
}]);
tests.push(['(e4) XHR readyState<4 时读取：返回原生文本，不提前处理', async () => {
  const { sb } = loadScript({ routes: [] });
  const xhr = new sb.XMLHttpRequest();
  xhr.open('GET', PLAYURL_URL);
  const raw = JSON.stringify(clone(sample));
  xhr.__text = raw;
  xhr.readyState = 2;
  assert.strictEqual(xhr.responseText, raw, 'readyState<4 时应返回原生文本');
}]);

// (p8) 真实样本冒烟：全条目主地址均为 mcdn
tests.push(['(p8) 真实样本冒烟（全条目主地址均为 mcdn）：换源后主地址不再含 mcdn 且原地址入备用', async () => {
  const routes = [{ url: PLAYURL_URL, body: clone(sample) }];
  const { sb, box } = loadScript({ routes });
  const got = await (await sb.window.fetch(PLAYURL_URL)).json();
  const v0 = got.data.dash.video[0];
  assert.ok(!v0.base_url.includes('mcdn'), '换源后主地址不应再指向 mcdn 节点');
  assert.ok(/bilivideo\.com/.test(v0.base_url), '换源后主地址应为正规 bilivideo CDN');
  const orig0 = sample.data.dash.video[0].base_url;
  assert.ok(Array.isArray(v0.backup_url) && v0.backup_url.indexOf(orig0) >= 0, '原 P2P 主地址应保留在备用列表兜底');
  const a0 = got.data.dash.audio[0];
  assert.ok(!a0.base_url.includes('mcdn'), '音频流主地址同样换源');
  const logLine = box.filter(b => b.level === 'log' && b.text.includes('playurl 已换源'));
  assert.strictEqual(logLine.length, 1, '应输出 1 条换源日志');
}]);

// (f4) 防重复安装
tests.push(['(f4) 同一页面二次加载脚本：不重复安装（fetch 引用不变，安装日志仅 1 条）', async () => {
  const { sb, box } = loadScript({ routes: [] });
  const hooked1 = sb.window.fetch;
  vm.runInContext(SRC, sb, { filename: 'bilibili-smooth.user.js' }); // 第二次注入
  assert.strictEqual(sb.window.fetch, hooked1, '二次加载应直接 return，不得再次包裹 fetch');
  const installedLog = box.filter(b => b.level === 'log' && b.text.includes('已安装'));
  assert.strictEqual(installedLog.length, 1, '安装日志应仍只有 1 条');
}]);

/* ---------------- main ---------------- */
(async () => {
  console.log('=== bilibili-smooth.user.js 回放测试（v2.0.1：仅 P2P/PCDN 换源） ===');
  console.log(`样本来源：${provenance.playurlUrl}`);
  console.log(`  bvid=${provenance.bvid} cid=${provenance.cid} 抓取时间=${provenance.fetchedAt} 匿名=${provenance.anonymous} fetch模式=${JSON.stringify(provenance.fetchMode)}`);
  const mcdnCount = JSON.stringify(sample).match(/mcdn/g);
  console.log(`  样本中 mcdn 出现次数：${mcdnCount ? mcdnCount.length : 0}（主地址全为 P2P 节点）\n`);

  for (const [name, fn] of tests) await runCase(name, fn);

  const failed = results.filter(r => !r.ok);
  console.log(`\n=== 结果：通过 ${results.length - failed.length} / ${results.length} ===`);
  if (failed.length) {
    console.log('失败用例：');
    for (const f of failed) console.log(`  - ${f.name}`);
    process.exitCode = 1;
  } else {
    process.exitCode = 0;
  }
})().catch(e => { console.error('runner 异常：', e); process.exitCode = 2; });
