# 02 — 网关骨架与 HTTP 反代

**What to build:** 基于 fastify 的网关进程，把上游 SPA 静态文件与 `/api` 一元 POST 全量反向代理到 dsh Host，代理时重写 `Host: 127.0.0.1:3080` 并剥离（或改写一致的）Origin 头——这是过信任栅栏的关键。请求体上限对齐上游 160 MiB。此票不含认证与 WS。

**Blocked by:** 01

**Status:** ready-for-agent

- [ ] curl 经网关调通一个真实 RPC（如 `session.list`），envelope 正常返回
- [ ] 浏览器直接打开网关地址能加载 SPA 并完成非流式操作
- [ ] 不带 Origin 改写时栅栏 403、改写后通过——有验证记录
- [ ] 超过 160 MiB 的请求体行为与上游一致（413）
