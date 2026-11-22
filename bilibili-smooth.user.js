// ==UserScript==
// @name         B站流畅播放
// @namespace    https://github.com/not502/bilibili-smooth
// @version      2.0.1
// @description  把 B 站 playurl 下发的 P2P/PCDN 流换回正规 CDN 源，缓解播放卡顿；不改画质、编码、弹幕等任何播放设置。
// @author       renji
// @match        https://www.bilibili.com/*
// @run-at       document-start
// @grant        none
// @inject-into  page
// @noframes
// @license      MIT
// ==/UserScript==

// 只做一件事：playurl 主地址为 P2P/PCDN 节点时，换用响应内 B 站自签名的正规 CDN 备用地址
// （新版签名绑定主机，伪造签名实测 403，故绝不自己拼 URL）；原 P2P 地址追加为最后备用，
// 换源失败自动回退，绝不比改写前更差。任何异常一律回退原始响应。

(function () {
  'use strict';

  if (window.__biliSmoothInstalled__) return; // 防重复安装
  window.__biliSmoothInstalled__ = true;

  const VERSION = '2.0.1';
  const log = (...a) => { try { console.log('[BiliSmooth]', ...a); } catch (e) { /* 忽略 */ } };
  const warn = (...a) => { try { console.warn('[BiliSmooth]', ...a); } catch (e) { /* 忽略 */ } };

  // playurl 类接口：UGC /x/player[/wbi]/playurl、番剧 /pgc/player/web[/wbi][/v2]/playurl、课程 /pugv/player/web/playurl
  const PLAYURL_RE = /\/(?:x|pgc|pugv)\/player\/(?:wbi\/|web\/(?:v2\/)?)?playurl(?![\w.-])/i;

  const NO_CHANGE = { changed: false };

  // 定位流数据层级：UGC data.dash；番剧 result.dash / result.video_info.dash / data.video_info.dash（pgc v2）；渐进式为 data.durl
  function findStreamHolder(root) {
    const cands = [];
    if (root.data && typeof root.data === 'object') {
      cands.push(root.data);
      if (root.data.video_info && typeof root.data.video_info === 'object') cands.push(root.data.video_info);
    }
    if (root.result && typeof root.result === 'object') {
      cands.push(root.result);
      if (root.result.video_info && typeof root.result.video_info === 'object') cands.push(root.result.video_info);
    }
    for (const c of cands) {
      const d = c.dash;
      if (d && typeof d === 'object' && Array.isArray(d.video) && d.video.length > 0) return c;
      if (Array.isArray(c.durl) && c.durl.length > 0) return c;
    }
    return null;
  }

  // P2P/PCDN 主机：xy<ip 编码>.mcdn.bilivideo.(cn|com)、upos-sz-p2p、*.szbdyd.com，以及带 B 站取流路径的第三方边缘域名
  function isP2PUrl(u) {
    if (typeof u !== 'string' || u.length < 20) return false;
    if (/^https?:\/\/[^/]*(?:mcdn\.bilivideo\.(?:cn|com)|p2p\.bilivideo\.(?:cn|com))(?::\d+)?\//i.test(u)) return true;
    if (/^https?:\/\/[^/]*szbdyd\.com(?::\d+)?\//i.test(u)) return true;
    return /^https?:\/\/(?![^/]*bilivideo\.(?:cn|com))[^/]+\/(?:v1\/resource\/)?upgcxcode\//i.test(u);
  }

  // 换源一个流条目（dash.video/audio 或 durl 元素）
  function fixStreamEntry(e, stats) {
    try {
      if (!e || typeof e !== 'object') return;
      const bkKey = Array.isArray(e.backup_url) ? 'backup_url' : (Array.isArray(e.backupUrl) ? 'backupUrl' : null);
      const baseKeys = ['base_url', 'baseUrl', 'url'].filter(k => typeof e[k] === 'string' && e[k]);
      if (baseKeys.length === 0 || !isP2PUrl(e[baseKeys[0]]) || !bkKey) return;
      const arr = e[bkKey];
      let idx = -1; // 找备用中第一个非 P2P 地址（B 站自签名）
      for (let i = 0; i < arr.length; i++) {
        if (typeof arr[i] === 'string' && arr[i] && !isP2PUrl(arr[i])) { idx = i; break; }
      }
      if (idx < 0) return; // 备用也全是 P2P：宁可不改
      const orig = e[baseKeys[0]];
      const fixed = arr.splice(idx, 1)[0];
      for (const k of baseKeys) { if (isP2PUrl(e[k])) e[k] = fixed; } // base_url / baseUrl 同步
      stats.count++;
      try { stats.hosts.push(new URL(orig).host); } catch (err) { stats.hosts.push('unknown'); }
      if (arr.indexOf(orig) < 0) arr.push(orig); // 原 P2P 地址挪到备用末尾兜底
    } catch (err) { /* 单条失败不影响其余 */ }
  }

  function fixStreamHolder(holder, stats) {
    const lists = [];
    if (holder.dash && typeof holder.dash === 'object') {
      if (Array.isArray(holder.dash.video)) lists.push(holder.dash.video);
      if (Array.isArray(holder.dash.audio)) lists.push(holder.dash.audio);
      if (holder.dash.dolby && Array.isArray(holder.dash.dolby.audio)) lists.push(holder.dash.dolby.audio);
      if (holder.dash.flac && holder.dash.flac.audio) lists.push([holder.dash.flac.audio]);
    }
    if (Array.isArray(holder.durl)) lists.push(holder.durl);
    for (const list of lists) for (const e of list) fixStreamEntry(e, stats);
  }

  // 处理一个 playurl 响应体（原地修改）：只做 P2P/PCDN 换源
  function processPlayinfoBody(root) {
    try {
      if (!root || typeof root !== 'object') return NO_CHANGE;
      if (root.code != null && +root.code !== 0) return NO_CHANGE; // 接口错误体不动
      const holder = findStreamHolder(root);
      if (!holder) return NO_CHANGE;
      const stats = { count: 0, hosts: [] };
      fixStreamHolder(holder, stats);
      if (stats.count === 0) return NO_CHANGE;
      return { changed: true, pcdn: stats.count, hosts: stats.hosts.slice(0, 4) };
    } catch (e) {
      warn('playinfo 处理异常，保持原响应：', e && e.message);
      return NO_CHANGE;
    }
  }

  // 首次换源成功时右上角短暂提示（每次页面加载至多一次）
  let toastShown = false;
  function showToast(text) {
    if (toastShown) return;
    toastShown = true;
    const render = () => {
      try {
        const el = document.createElement('div');
        el.textContent = text;
        el.setAttribute('style', 'position:fixed;top:14px;right:14px;z-index:2147483647;pointer-events:none;'
          + 'background:rgba(15,18,25,.9);color:#fff;font:13px/1.5 "PingFang SC","Microsoft YaHei",sans-serif;'
          + 'padding:8px 14px;border-radius:8px;box-shadow:0 4px 14px rgba(0,0,0,.3);');
        (document.body || document.documentElement).appendChild(el);
        setTimeout(() => { try { el.remove(); } catch (e) { /* 忽略 */ } }, 4000);
      } catch (e) { warn('toast 展示失败：', e && e.message); }
    };
    if (document.body || document.documentElement) render();
    else document.addEventListener('DOMContentLoaded', render, { once: true });
  }

  function reportRewrite(res) {
    try {
      const hosts = res.hosts && res.hosts.length ? `（${res.hosts.join('、')} 等）` : '';
      log(`playurl 已换源：P2P/PCDN → 正规CDN，共 ${res.pcdn} 条${hosts}`);
      showToast(`B站流畅播放：已将 ${res.pcdn} 条 P2P/PCDN 流切换为正规 CDN`);
    } catch (e) { /* 忽略 */ }
  }

  function installPlayinfoHook() {
    // 注入晚于页面内联脚本时 SSR 数据已存在，先就地处理一次
    let current;
    try { current = window.__playinfo__; } catch (e) { /* 忽略 */ }
    if (current && typeof current === 'object') {
      try {
        const res = processPlayinfoBody(current);
        if (res.changed) reportRewrite(res);
      } catch (e) { /* 忽略 */ }
    }
    try {
      Object.defineProperty(window, '__playinfo__', {
        configurable: true,
        get() { return current; },
        set(v) {
          current = v;
          try {
            if (v && typeof v === 'object') {
              const res = processPlayinfoBody(v);
              if (res.changed) reportRewrite(res);
            }
          } catch (e) { warn('__playinfo__ 处理失败（保持原值）：', e && e.message); }
        }
      });
    } catch (e) { warn('__playinfo__ 拦截安装失败：', e && e.message); }
  }

  function installFetchHook() {
    if (typeof window.fetch !== 'function') return;
    const origFetch = window.fetch;
    const hookedFetch = function fetch(input, init) {
      let url = '';
      try {
        if (typeof input === 'string') url = input;
        else if (input && typeof input.url === 'string') url = input.url;
      } catch (e) { /* 忽略 */ }
      let hit = false;
      try { hit = PLAYURL_RE.test(url); } catch (e) { /* 忽略 */ }
      if (!hit) return origFetch.apply(this, arguments);
      let promise;
      try {
        promise = origFetch.apply(this, arguments);
      } catch (e) {
        throw e; // 原始请求同步抛错时按原样抛出
      }
      return promise.then(resp => {
        try {
          if (!resp) return resp;
          return resp.clone().json().then(body => {
            const res = processPlayinfoBody(body);
            if (!res.changed) return resp;
            reportRewrite(res);
            const headers = new Headers(resp.headers);
            try { headers.delete('content-length'); headers.delete('content-encoding'); } catch (e) { /* 忽略 */ }
            return new Response(JSON.stringify(body), { status: resp.status, statusText: resp.statusText, headers });
          }).catch(() => resp); // 非 JSON / 克隆失败：原样返回
        } catch (e) {
          warn('fetch 响应处理异常，保持原响应：', e && e.message);
          return resp;
        }
      });
      // 原始请求 reject 时按原样向上抛出
    };
    try { window.fetch = hookedFetch; } catch (e) { warn('fetch hook 安装失败：', e && e.message); }
  }

  function installXhrHook() {
    if (typeof XMLHttpRequest === 'undefined') return;
    const proto = XMLHttpRequest.prototype;
    const respDesc = Object.getOwnPropertyDescriptor(proto, 'response');
    const textDesc = Object.getOwnPropertyDescriptor(proto, 'responseText');
    if (typeof proto.open !== 'function' || !respDesc || !respDesc.get) return;
    const origOpen = proto.open;

    proto.open = function (method, url) {
      try {
        if (!this.__bsHooked && typeof url === 'string' && PLAYURL_RE.test(url)) {
          this.__bsHooked = true;
          shadowXhrResponse(this, respDesc, textDesc);
        }
      } catch (e) { /* hook 失败不影响原请求 */ }
      return origOpen.apply(this, arguments);
    };
  }

  // 实例级 getter 覆盖 response/responseText：readyState=4 后首次读取时处理一次，失败回退原生值
  function shadowXhrResponse(xhr, respDesc, textDesc) {
    if (xhr.__bsShadowed) return;
    xhr.__bsShadowed = true;
    let settled = false;
    let newText = null; // text 模式改写后的 JSON 字符串
    let newObj;         // json 模式改写后的对象（undefined = 未改写）
    const tryFilter = () => {
      if (settled) return;
      settled = true; // 无论成败都不重试，绝不因脚本导致拿不到响应
      try {
        const rt = xhr.responseType;
        if (rt === '' || rt === 'text') {
          const text = textDesc && textDesc.get ? textDesc.get.call(xhr) : respDesc.get.call(xhr);
          if (typeof text === 'string' && text) {
            const body = JSON.parse(text);
            const res = processPlayinfoBody(body);
            if (res.changed) newText = JSON.stringify(body);
          }
        } else if (rt === 'json') {
          const obj = respDesc.get.call(xhr);
          if (obj && typeof obj === 'object') {
            const res = processPlayinfoBody(obj);
            if (res.changed) newObj = obj;
          }
        }
      } catch (e) { warn('xhr 响应处理失败，保持原响应：', e && e.message); }
    };
    try {
      Object.defineProperty(xhr, 'response', {
        configurable: true,
        get() {
          try { if (xhr.readyState === 4) tryFilter(); } catch (e) { /* 忽略 */ }
          if (newText !== null && (xhr.responseType === '' || xhr.responseType === 'text')) return newText;
          if (newObj !== undefined && xhr.responseType === 'json') return newObj;
          return respDesc.get.call(xhr);
        }
      });
      if (textDesc && textDesc.get) {
        Object.defineProperty(xhr, 'responseText', {
          configurable: true,
          get() {
            const rt = xhr.responseType;
            if (rt === '' || rt === 'text') {
              try { if (xhr.readyState === 4) tryFilter(); } catch (e) { /* 忽略 */ }
              if (newText !== null) return newText;
            }
            return textDesc.get.call(xhr); // 非 text 模式保持原生行为
          }
        });
      }
    } catch (e) { warn('xhr 响应拦截安装失败（不影响原请求）：', e && e.message); }
  }

  installPlayinfoHook();
  installFetchHook();
  installXhrHook();

  log(`v${VERSION} 已安装：P2P/PCDN 流自动换回正规 CDN，不改任何播放设置。`);
})();
