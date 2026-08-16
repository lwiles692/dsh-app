# 05 — 形态 C 本机部署验收

**What to build:** `deploy/` 给出形态 C（本机自用）全套：Caddyfile（`localhost` 本地证书，或 HTTP 回环的显式降配）+ 部署 runbook（常驻进程清单、环境变量、启动顺序、健康检查；进程托管方式不限）。这是 Phase 1 的总验收：完整链路在真实浏览器里走通。

**Blocked by:** 03, 04

**Status:** ready-for-agent

- [ ] 照 runbook 从零可拉起 dsh Host + 网关 + Caddy 三进程
- [ ] 浏览器经 `https://localhost` 走通：登录 → 建 workspace → 开会话 → 跑一条 agent 消息（流式下行正常）
- [ ] 特权方法（如 `settings.describe`）远程可调用
- [ ] 无 cookie 一律 401 在此部署形态下仍成立
