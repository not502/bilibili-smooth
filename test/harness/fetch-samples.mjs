// 取真实样本：GET view 拿 cid，再 GET playurl（匿名 DASH）存入 test/samples/
// 策略：先匿名直取；若遇风控（HTTP 412 或 body.code === -412）改带浏览器 User-Agent + Referer 重试。
// 只写 test/samples/，不改动被测脚本。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const SAMPLES_DIR = path.join(ROOT, 'test', 'samples');
const BV = 'BV1GJ411x7h7';

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

const notes = [];
async function getJson(url, { referer = 'https://www.bilibili.com/' } = {}) {
  // 第一遍：Node 默认 UA 匿名直取
  let resp = await fetch(url);
  let body = null;
  try { body = await resp.json(); } catch { /* ignore */ }
  let risk = resp.status === 412 || (body && Number(body.code) === -412);
  let mode = 'plain';
  if (risk) {
    notes.push(`${url} 首次命中风控(status=${resp.status}, code=${body && body.code})，带浏览器 UA+Referer 重试`);
    mode = 'ua+referer';
    resp = await fetch(url, { headers: { 'User-Agent': UA, 'Referer': referer, 'Accept': 'application/json' } });
    body = null;
    try { body = await resp.json(); } catch { /* ignore */ }
    risk = resp.status === 412 || (body && Number(body.code) === -412);
  }
  if (resp.status !== 200 || risk || !body) {
    throw new Error(`GET ${url} 失败: HTTP ${resp.status}, body.code=${body && body.code}`);
  }
  if (body.code !== 0) {
    throw new Error(`GET ${url} 业务错误: code=${body.code}, message=${body.message}`);
  }
  return { body, mode, httpStatus: resp.status };
}

const viewInfo = await getJson(`https://api.bilibili.com/x/web-interface/view?bvid=${BV}`);
const cid = viewInfo.body.data && viewInfo.body.data.cid;
if (!cid) throw new Error('view 响应中未找到 data.cid');
console.log(`view OK: bvid=${BV} cid=${cid} title=${viewInfo.body.data.title} (fetch mode=${viewInfo.mode})`);

const playurlUrl = `https://api.bilibili.com/x/player/playurl?bvid=${BV}&cid=${cid}&qn=64&fnval=16&fourk=1`;
const playInfo = await getJson(playurlUrl, { referer: `https://www.bilibili.com/video/${BV}/` });
const dash = playInfo.body.data && playInfo.body.data.dash;
console.log(`playurl OK (fetch mode=${playInfo.mode}): code=${playInfo.body.code}, quality=${playInfo.body.data && playInfo.body.data.quality}, dash=${dash ? 'yes' : 'no'}`);
if (dash && Array.isArray(dash.video)) {
  const brief = dash.video.map(v => ({ id: v.id, codecid: v.codecid, codecs: v.codecs }));
  console.log(`dash.video ${dash.video.length} 条:`, JSON.stringify(brief));
} else {
  console.log('警告: 响应不含 dash.video，可能为 durl 渐进式响应');
}

fs.mkdirSync(SAMPLES_DIR, { recursive: true });
fs.writeFileSync(path.join(SAMPLES_DIR, 'view.json'), JSON.stringify(viewInfo.body, null, 2));
fs.writeFileSync(path.join(SAMPLES_DIR, 'playurl.json'), JSON.stringify(playInfo.body, null, 2));
fs.writeFileSync(path.join(SAMPLES_DIR, 'provenance.json'), JSON.stringify({
  fetchedAt: new Date().toISOString(),
  bvid: BV,
  cid,
  viewUrl: `https://api.bilibili.com/x/web-interface/view?bvid=${BV}`,
  playurlUrl,
  anonymous: true,
  fetchMode: { view: viewInfo.mode, playurl: playInfo.mode },
  httpStatus: { view: viewInfo.httpStatus, playurl: playInfo.httpStatus },
  riskControlRetries: notes,
  note: '匿名请求真实 B 站接口所得原始响应，未做任何字段修改',
}, null, 2));
console.log('样本已写入 test/samples/{view.json, playurl.json, provenance.json}');
if (notes.length) console.log('风控重试记录:', notes);
