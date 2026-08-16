# 04 — 认证面（登录页 + cookie 中间件）

**What to build:** 网关自带最小登录页：粘贴静态长 token（≥128 bit 随机，环境变量配置），校验后种 `HttpOnly; Secure; SameSite=Lax` 长效 cookie。认证中间件统一覆盖静态页、`/api` POST、WS upgrade——无有效 cookie 一律 401（登录页与登录端点除外）。登录端点带速率限制，日志脱敏。cookie `Secure` 标志按配置开关（HTTP 回环/可信内网的显式降配，启动时告警）。

**Blocked by:** 02

**Status:** ready-for-agent

- [ ] 无 cookie 访问静态页/`/api`/WS 一律 401
- [ ] 登录页贴错 token 拒绝、贴对后 SPA 全流程可用（含 WS）
- [ ] 登录端点触发限流后按预期拒绝
- [ ] `Secure` 关闭时启动日志有显式降配警告
- [ ] 日志中不出现 token 明文
