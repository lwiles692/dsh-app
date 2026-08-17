# 04 — 认证面（登录页 + cookie 中间件）

**What to build:** 网关自带最小登录页：粘贴静态长 token（≥128 bit 随机，环境变量配置），校验通过后写入 `HttpOnly; Secure; SameSite=Lax` 长效 cookie。认证中间件统一覆盖静态页、`/api` POST、WS upgrade——无有效 cookie 一律 401（登录页与登录端点除外）。登录端点带速率限制，日志脱敏。cookie `Secure` 标志按配置开关（HTTP 回环/可信内网的显式降配，启动时告警）。

**Blocked by:** 02

**Status:** resolved

- [x] 无 cookie 访问静态页/`/api`/WS 一律 401
- [x] 登录页提交错误 token 被拒绝、提交正确 token 后 SPA 全流程可用（含 WS）（无浏览器环境：curl 经网关获取 SPA/RPC + probe-ws.mjs 经网关 WS 替代验证，见 Comments）
- [x] 登录端点触发限流后按预期拒绝
- [x] `Secure` 关闭时启动日志有显式降配警告
- [x] 日志中不出现 token 明文

## Comments

### 完成内容（2026-08-16）

- 实现集中在 `gateway/src/server.js`（无新依赖，仅用 `node:crypto`）：
  - **登录页**：`GET /login` 返回最小 HTML（内联脚本 POST JSON 到 `/login`，成功 204 后跳 `/`，失败按状态码提示 token 无效/限流）。
  - **登录端点**：`POST /login`（JSON `{"token": "..."}`）——恒定时间比较（对双方 sha256 摘要做 `timingSafeEqual`，无长度泄漏）校验 `AUTH_TOKEN`；通过则写入 `dsh_auth` cookie：`HttpOnly; SameSite=Lax; Path=/; Max-Age=31536000`（1 年）+ 按开关附加 `Secure`。cookie 值存 `sha256(token)` hex，不含 token 明文；cookie 校验同样对摘要做恒定时间比较。
  - **认证中间件**：全局 `onRequest` 钩子，仅豁免 `/login`（GET/POST）；其余一切请求（http-proxy 代理的静态页与 `/api` POST、`@fastify/websocket` 的 upgrade 路由）无有效 cookie 一律 401。WS upgrade 走同一路由生命周期，钩子内 401 即拒绝握手。
  - **限流**：`/login` 固定窗口每 IP 10 次/60s（成功/失败都计，成功清零），超限 429 JSON。
  - **日志脱敏**：登录失败/限流只记事实与 IP，不记 token；fastify 默认请求日志不含 header/body，token 与 cookie 值均不写入日志（实测 grep 验证）。
- **新环境变量**：
  - `AUTH_TOKEN`（必填）：静态长 token，≥32 字符（≥128 bit，例 `openssl rand -hex 16`）；缺失或过短启动即拒绝（exit 1，报错只描述规则不引用值）。
  - `AUTH_COOKIE_SECURE`（默认 `true`）：显式设 `false`/`0`/`no` 降配关闭 cookie `Secure` 标志，启动时输出 warn 告警（仅限 HTTP 回环/可信内网）。
- `gateway/scripts/probe-ws.mjs` 新增 `COOKIE` 环境变量支持（WS 握手与 RPC 均带 cookie 头），用于认证后的回归验证。

### 验证证据（上游 dsh web @ 127.0.0.1:3080 既存进程，网关 @ 127.0.0.1:3000，`AUTH_TOKEN` 为 128 bit 随机 hex）

- **无 cookie 一律 401**：`GET /` → 401；`GET /manifest.webmanifest` → 401；`POST /api/session.list` → 401 `unauthorized: missing or invalid auth cookie`；WS upgrade（ws 客户端连 `ws://127.0.0.1:3000/api/events.mux`）→ `Unexpected server response: 401`。`GET /login` 豁免 → 200。伪造 cookie（`dsh_auth=deadbeef`）→ 401。
- **登录流程（无浏览器环境，curl + probe-ws.mjs 替代）**：
  - 错误 token：`POST /login` → 401 `{"error":"invalid token"}`，无 `set-cookie`。
  - 正确 token：→ 204，`set-cookie: dsh_auth=<64hex>; HttpOnly; SameSite=Lax; Path=/; Max-Age=31536000; Secure`。
  - 带 cookie：`GET /` → 200 `text/html`；`POST /api/session.list` → 200 envelope 正常（rpcId 回显）；`COOKIE='dsh_auth=...' node scripts/probe-ws.mjs stream` → WS 建连成功，触发 workspace+session 事件 `13 帧 / 3093ms 窗口内逐条收到，全部为文本 JSON server-request`，exit=0。
- **限流**：连续 12 次错误 token `POST /login` → 前 10 次 401，第 11、12 次 429 `{"error":"too many login attempts, try again later"}`。
- **Secure 降配**：`AUTH_COOKIE_SECURE=false` 启动 → 日志 `level:40 ... "AUTH_COOKIE_SECURE=false：cookie Secure 标志已显式降配关闭，仅限 HTTP 回环/可信内网，切勿暴露到不可信网络"`；登录 `set-cookie` 无 `Secure`（其余属性不变）。
- **日志脱敏**：网关全程运行日志 grep 本次 token 明文 → 0 次；grep cookie 值 → 0 次；登录失败行仅 `{"ip":"127.0.0.1","msg":"登录失败：token 不匹配"}`。
- **配置校验**：无 `AUTH_TOKEN` 或过短（<32 字符）→ 启动打印规则说明并 exit 1，不 listen。

### 遗留问题

- 登录页无浏览器实测（环境限制），以 curl 验证 HTML 200 + 端点行为替代；页面为零依赖内联脚本，风险低。
- 限流为进程内内存实现，网关重启即清零（多实例部署需共享存储，本期单进程网关不适用）。
- cookie 为确定性值（`sha256(token)`），换 token 即全量失效；无单会话吊销能力（静态 token 模型的固有取舍）。
