# 03 — 事件流通道（WS + SSE 透传）

**What to build:** 网关透传 `/api/events.mux` 与 `/api/events.host` 两条纯下行 WebSocket（`@fastify/websocket` 手动处理 upgrade），以及同路径的 SSE 回退。对齐长连接约束：禁用 WS idle 超时、关闭响应 buffering、maxPayload 对齐 100 MiB。

**Blocked by:** 02

**Status:** ready-for-agent

- [ ] 浏览器经网关开会话，流式事件逐条实时到达
- [ ] 连接空闲挂起 10 分钟以上不被中间件掐断
- [ ] 断开后客户端指数退避重连可恢复
- [ ] SSE 回退路径（GET 同路径）经网关可用
