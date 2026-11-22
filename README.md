# B站流畅播放

篡改猴（Tampermonkey）脚本：把 B 站 playurl 下发的 P2P/PCDN 流（`*.mcdn.bilivideo.cn`、`*.szbdyd.com`、第三方 PCDN 边缘等）换回响应内自签名的正规 CDN 源，缓解播放缓冲卡顿。零配置，不改画质、编码、弹幕等任何播放设置。

仓库：<https://github.com/not502/bilibili-smooth> · 当前版本 v2.0.1

## 背景

B 站会按调度策略把部分播放流的主地址指向 P2P/PCDN 节点（通常用于分摊 CDN 带宽压力）。本仓库 `test/samples/playurl.json` 这份真实抓取样本中，全部主地址均为 P2P 节点：`*.mcdn.bilivideo.cn` 与第三方 PCDN 边缘域名。这类节点走终端互传/边缘转发，速率随网络波动，不足时播放端表现为频繁缓冲卡顿。

**为什么不伪造签名**：playurl 下发的取流 URL 自带按主机绑定的签名参数；据脚本设计期实测，伪造签名换主机返回 403（见 `bilibili-smooth.user.js` 头部设计注释）。因此脚本绝不自己拼 URL，**只换用响应 `backup_url` 里 B 站自签名的正规 CDN 备用地址**——签名是 B 站随响应下发的，直接可用。

**兜底机制**：换源时，被提升的 CDN 地址从备用列表移出，原 P2P 主地址追加到备用列表末尾；主地址加载失败时，播放器仍可回退到备用列表末尾的原 P2P 节点；脚本处理出现任何异常时保持原始响应不变。

## 安装

1. 在 Edge / Chrome 中安装 [Tampermonkey（篡改猴）](https://www.tampermonkey.net/) 扩展；
2. 打开安装直链：<https://raw.githubusercontent.com/not502/bilibili-smooth/HEAD/bilibili-smooth.user.js>（`HEAD` 解析为仓库默认分支，不因默认分支改名而失效）；
3. 在篡改猴弹出的安装页中点击安装。

脚本仅匹配 `https://www.bilibili.com/*`：只在网页版 `www.bilibili.com` 生效；直播 `live.bilibili.com`、移动版 `m.bilibili.com` 及 iframe 内嵌播放器（脚本标注 `@noframes`，不注入 iframe）不在覆盖范围。

## 行为

- **零配置**：无任何设置入口，装上即用（脚本未使用 `GM_*` 存储 API）。
- **不碰播放设置**：不改画质、编码、弹幕等任何选项，只替换取流 URL。
- 每页**首次**换源成功时，右上角短暂提示（约 4 秒）：`B站流畅播放：已将 N 条 P2P/PCDN 流切换为正规 CDN`。
- 控制台输出 `[BiliSmooth]` 前缀日志，可查看每次换源的条数及被换下的节点主机。
- **停用**：在篡改猴面板中关闭本脚本即可。

## 工作原理

- 在 `document-start` 注入，同时覆盖三条数据通道：`window.fetch`、`XMLHttpRequest`（`open` 时按 URL 标记、响应就绪后处理）与 `window.__playinfo__`（属性拦截；注入晚于页面内联脚本时就地处理已有值）。
- 用正则识别 playurl 类接口（`PLAYURL_RE`，见脚本源码）：`/x/`、`/pgc/`、`/pugv/` 命名空间的 `/player/` 路径，其后为 `wbi/`、`web/`、`web/v2/` 之一或直接跟 `playurl`；负向断言排除 `playurlsv` 等以 playurl 开头的其他接口名。
- 按主机特征识别 P2P/PCDN 节点：`*.mcdn.bilivideo.(cn|com)`、`p2p.bilivideo`、`*.szbdyd.com`，以及带 B 站取流路径的第三方边缘域名。
- 主地址为 P2P 且备用列表中存在非 P2P 自签名地址时，将其提升为主地址（`base_url`/`baseUrl` 同步），原 P2P 地址追加为最后备用；覆盖 DASH 的 video/audio/dolby/flac 与渐进式 durl。
- 备用不可用或处理异常时，一律保持原始响应，失败自动回退。

## 测试

```bash
node test/harness/run-tests.js
```

- 18 用例回放测试，需 Node 18+（用到 `structuredClone` 与内置 `Response`/`Headers`）。
- 测试在桩化环境中真实 eval 脚本源码，fetch、XHR、`__playinfo__` 三条通道均有回放用例；真实抓取样本用于 fetch 通道换源冒烟、view 接口透传与 XHR 未就绪透传校验，其余用例使用合成响应。
- 样本已含在 `test/samples/`（`playurl.json`、`view.json`、`provenance.json`），为匿名请求真实 B 站接口的原始响应；来源与抓取方式见 `provenance.json`，抓取脚本为 `test/harness/fetch-samples.mjs`（匿名直取，遇 412 风控自动带浏览器 UA + Referer 重试）。

## 局限

- 若响应内备用地址也全是 P2P 节点，脚本不做任何改写（保持原始响应）——没有可用目标时宁可不换。
- 回退仅在主地址加载**失败**时发生，脚本不比较节点速率：若本机 P2P 节点实际速率优于被提升的 CDN 地址，改写后首选流可能变慢且不会自动回退。
- B 站签名机制若再变化（例如备用地址不再随响应下发或失效），需要跟进适配。

## License

[MIT](LICENSE)，与脚本元数据一致（`bilibili-smooth.user.js` 头部 `@license MIT`）。
