# 02 — 网关骨架与 HTTP 反代

**What to build:** 基于 fastify 的网关进程，把上游 SPA 静态文件与 `/api` 一元 POST 全量反向代理到 dsh Host，代理时重写 `Host: 127.0.0.1:3080` 并剥离（或改写一致的）Origin 头——这是过信任栅栏的关键。请求体上限对齐上游 160 MiB。此票不含认证与 WS。

**Blocked by:** 01

**Status:** resolved

- [x] curl 经网关调通一个真实 RPC（如 `session.list`），envelope 正常返回
- [x] 浏览器直接打开网关地址能加载 SPA 并完成非流式操作（无浏览器环境：以 curl 经网关拉取 HTML 与静态资源 200 + 经网关非流式 RPC 200 替代验证，见 Comments）
- [x] 不带 Origin 改写时栅栏 403、改写后通过——有验证记录
- [x] 超过 160 MiB 的请求体行为与上游一致（413）

## Comments

### 完成内容（2026-08-16）

- 新建 `gateway/` pnpm 工程（`dsh-gateway`）：fastify 5 + `@fastify/http-proxy` 11，单文件 `gateway/src/server.js`（ESM，无构建步骤），`pnpm start` 启动。
- 目录结构：`gateway/package.json`、`gateway/pnpm-lock.yaml`、`gateway/src/server.js`。产物（node_modules）由根 `.gitignore` 覆盖。
- 配置项（环境变量）：`UPSTREAM`（默认 `http://127.0.0.1:3080`）、`HOST`（默认 `127.0.0.1`）、`PORT`（默认 `3000`）；bodyLimit 固定 160 MiB。
- 过栅栏实现（`replyOptions.rewriteRequestHeaders`）：Host 改写为 `new URL(UPSTREAM).host`；剥离 `origin`、`sec-fetch-*`、`expect`（undici 不支持 100-continue，大 body 客户端会带，不剥则 500）。
- **踩坑记录**：`@fastify/http-proxy` v11 只把 `replyOptions` 透传给逐请求的 `reply.from()`，`rewriteRequestHeaders` 放插件顶层对 HTTP 路径不生效（顶层同名项仅供 WS 路径用），必须放 `replyOptions` 下。
- 160 MiB 上限在网关侧对等强制（两道闸，因代理走流式透传、fastify bodyLimit 对自定义透传 parser 不生效）：
  1. `onRequest` 钩：声明的 `content-length` 超限 → 即时 413，不读 body；
  2. `preParsing` 钩：chunked/未声明长度 → 计数 Transform，超限中止流，经 `replyOptions.onError` 按标记映射 413。

### 验证证据（上游 `dsh web` @ 127.0.0.1:3080，网关 @ 127.0.0.1:3000）

- RPC：`curl -X POST http://127.0.0.1:3000/api/session.list -H 'content-type: application/json' -d '{"type":"client-request","rpcId":"acc1","method":"session.list","payload":{}}'` → HTTP 200，响应 `{"type":"server-response","rpcId":"acc1","result":{"ok":true,"value":{"items":[...]}}}`，rpcId 回显正常。
- 栅栏对照（`POST /api/host.describe`）：
  - 直连上游 `Origin: http://evil.com` → **403**；同请求经网关 → **200**（网关剥离）。
  - 经网关 `Origin: http://127.0.0.1:3000`（浏览器同源场景）→ **200**。
  - 直连上游 `Sec-Fetch-Site: cross-site` → **403**；经网关 → **200**。
- SPA（无浏览器环境，curl 替代）：`GET /` 经网关 → 200 `text/html`（含 `window.__DSH_BOOT__`）；`/manifest.webmanifest`、`/favicon.svg`、`/assets/index-*.js`、`/assets/vendor-*.js`、`/assets/vendor-*.css` 均 200 且 content-type 正确；非流式 RPC（session.list）经网关 200。
- 413 边界（流式构造，不落盘）：
  - 声明 `content-length: 200000000` → 即时 413 `FST_ERR_CTP_BODY_TOO_LARGE`（仅发出 ~1.7MB 即被拒）。
  - chunked 流式 160 MiB + 1 KiB（node http 客户端，无 content-length）→ 413（计数闸触发）。
  - chunked 恰好 160 MiB → 放行透传至上游，上游返回 400 `body is not JSON`（零字节非 JSON），证明边界不误杀且大 body 透传完整。

### 遗留问题

- 本票不含认证与 WS（issue 03/04）。上游 web 面无 SSE 回退（01 已固化，426），03 只需透传 WS。
- 网关默认绑 `127.0.0.1`；认证落地（issue 03）前不宜对非回环地址开放。
- WS upgrade 目前未代理：浏览器打开 SPA 后 WS 下行通道不通属预期，等 issue 04。
