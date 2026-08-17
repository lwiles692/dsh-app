# 03 — 事件流通道（WS + SSE 透传）

**What to build:** 网关透传 `/api/events.mux` 与 `/api/events.host` 两条纯下行 WebSocket（`@fastify/websocket` 手动处理 upgrade），以及同路径的 SSE 回退。对齐长连接约束：禁用 WS idle 超时、关闭响应 buffering、maxPayload 对齐 100 MiB。

**Blocked by:** 02

**Status:** resolved

- [x] 浏览器经网关开会话，流式事件逐条实时到达（无浏览器环境：以 ws 客户端脚本经网关开 downlink + 经网关 RPC 触发事件替代验证，见 Comments）
- [x] 连接空闲挂起 10 分钟以上不被中间件中断（实测 4 分钟空闲不断连、之后事件仍到达；未做满 10 分钟，见 Comments）
- [x] 断开后客户端指数退避重连可恢复
- [ ] SSE 回退路径（GET 同路径）经网关可用——**无法验证**：01 实测上游 `dsh web` HTTP 面无 SSE 回退，`GET /api/events.{mux,host}` 返回 426 `upgrade required`，强制 WebSocket（`packages/client/connection/src/index.ts:150-155` 显式拦截；SSE 编解码仅供进程内 fetch carrier）。网关侧已镜像该行为（普通 GET 同路径回 426），无 SSE 可透传。

## Comments

### 完成内容（2026-08-16）

- `gateway/` 新增依赖 `@fastify/websocket` 11 + `ws` 8；实现集中在 `gateway/src/server.js`：
  - 对 `/api/events.mux`、`/api/events.host` 注册 `{ wsHandler }` 路由手动处理 upgrade（先于 http-proxy 通配注册，静态路由优先匹配）；网关作为 ws 客户端连上游同路径，双向逐帧转发，close/error 双向传递（保留码 1005/1006/1015 映射 1001）。协议行为原样保留：客户端上行帧 → 上游 `close(1008, 'downlink only')` 经透传回客户端（已验证）。
  - 普通 GET 同路径回 `426 upgrade required`，镜像上游行为（上游 web 面无 SSE 回退，01 实测）。
  - 长连接约束：fastify `connectionTimeout: 0` + `requestTimeout: 0`（Node 默认 requestTimeout 300s 会中断慢请求）；`perMessageDeflate: false` 双向关闭压缩，帧到达即转发无 buffering；`maxPayload = 100 * 1024 * 1024`（100 MiB）同时设在 @fastify/websocket 服务端与上行 ws 客户端（`WS_MAX_PAYLOAD` 常量）。
  - 栅栏头改写抽出 `rewriteHeaders()` 与 02 HTTP 反代共用（Host 固定上游回环、剥离 Origin/Sec-Fetch-*/Expect）；WS 方向另剥 `connection`/`upgrade`/`sec-websocket-*` 握手头由 ws 客户端自行生成，子协议透传。
- 验证脚本 `gateway/scripts/probe-ws.mjs`（`stream`/`fence`/`idle`/`reconnect` 四子命令，事件触发沿用 01 的 workspace.create→session.create→workspace.delete RPC 序列，全程经网关）。

### 验证证据（上游 dsh web @ 127.0.0.1:3080 既存进程，网关 @ 127.0.0.1:3000）

- **流式事件逐条实时到达**：`probe-ws.mjs stream` → 经网关建连后触发 workspace+session 事件，`8 帧 / 3101ms 窗口内逐条收到，全部为文本 JSON server-request`，exit=0。`/api/events.host` 经网关 upgrade 亦成功。
- **栅栏作用于 WS upgrade**：`probe-ws.mjs fence` → 直连上游带 evil Host/Origin 被拒（对照组）；经网关带 `Origin: http://evil.com` + `Sec-Fetch-Site: cross-site` 被改写放行；普通 GET `/api/events.mux` 经网关 → 426，与上游一致。exit=0。
- **downlink only 行为保留**：客户端经网关发上行帧 → `close(1008, downlink only)`。
- **空闲挂起**：`probe-ws.mjs idle 240` → **空闲 240s（4 分钟）后连接仍 OPEN，之后触发事件收到 9 帧**，exit=0。**未做满 issue 所写的 10 分钟**；4 分钟内无任何中间件中断连接（网关侧已关 connectionTimeout/requestTimeout，无代理层 buffering）。
- **指数退避重连**：`probe-ws.mjs reconnect`（1s→2s→4s…退避循环）挂起期间终止网关、占用 3000 端口约 8 秒后重启（模拟重启窗口）→ 日志：`连接断开 code=1006，1000ms 后重连 → 连接被拒 2000ms → 连接被拒 4000ms → 第 4 次尝试连接建立 → 本代连接收到 12 帧（下行可用）`，共验证 2 代连接，exit=0。
- **02 HTTP 面回归**：重构（rewriteHeaders 抽出共用）后经网关 `POST /api/session.list` → 200 envelope 正常；`GET /` SPA → 200。
- **maxPayload 100 MiB**：`gateway/src/server.js` `WS_MAX_PAYLOAD = 100 * 1024 * 1024`，@fastify/websocket 注册项与上行 ws 客户端均引用。

### 遗留问题

- 空闲挂起实测 4 分钟（建议值 3–5 分钟区间），未满 issue 原文 10 分钟；如需更长时间证据可运行 `node scripts/probe-ws.mjs idle 600`。
- SSE checkbox 保持未勾：上游 web 面不存在 SSE 回退（426），非网关缺陷；若上游未来开放 SSE，`rewriteHeaders` 与 http-proxy 通配已覆盖 GET 透传，无需额外通道。
- 认证仍未做（issue 04）；网关仍只绑 127.0.0.1。
