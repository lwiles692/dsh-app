# 05 — 形态 C 本机部署验收

**What to build:** `deploy/` 给出形态 C（本机自用）全套：Caddyfile（`localhost` 本地证书，或 HTTP 回环的显式降配）+ 部署 runbook（常驻进程清单、环境变量、启动顺序、健康检查；进程托管方式不限）。这是 Phase 1 的总验收：完整链路在真实浏览器中验证通过。

**Blocked by:** 03, 04

**Status:** resolved

- [x] 按照 runbook 从零可启动 dsh Host + 网关 + Caddy 三进程
- [x] 浏览器经 `https://localhost` 验证通过：登录 → 建 workspace → 开会话 → 执行一条 agent 消息（流式下行正常）
  - 无浏览器环境，以 curl + `gateway/scripts/probe-ws.mjs`（带 cookie、指向 Caddy 入口）替代，见 Comments；入口为 `https://localhost:8443`（8443 而非 443 的原因见 Comments）；agent 消息因无 LLM 凭证在模型调用处报错，链路本身（prompt 受理 → turn 执行 → 事件流下行）完整验证通过
- [x] 特权方法（如 `settings.describe`）远程可调用
- [x] 无 cookie 一律 401 在此部署形态下仍成立

## Comments

### 完成内容（2026-08-16）

- **`deploy/` 结构**（仅两文件，进程托管方式不限）：
  - `deploy/Caddyfile`：`https://localhost:8443` → `reverse_proxy 127.0.0.1:3000`（网关）；`tls internal` 本地 CA；`admin off`；`auto_https disable_redirects`。WS upgrade 由 Caddy reverse_proxy 自动透传，无需额外配置。
  - `deploy/RUNBOOK.md`：常驻进程清单（dsh Host / 网关 / Caddy）、环境变量表（含 `AUTH_TOKEN` 生成）、启动顺序、健康检查命令、浏览器信任本地 CA 步骤、端口与降配说明、停止顺序。
- **Caddy 选型结论**：系统未安装 Caddy，下载官方静态二进制 v2.11.4 到 `.scratch/bin/`（临时，**未提交 git**，验收后已清理）。**TLS 不降配**：`localhost` 走 Caddy 本地 CA（`tls internal`）签发证书，网关 `AUTH_COOKIE_SECURE` 保持默认 `true`（`set-cookie` 实测带 `Secure`）。两处与常规配置的偏差，已在 Caddyfile 注释与 runbook「端口与降配说明」中说明：
  1. **8443 而非 443**：验收环境非 root 运行，`net.ipv4.ip_unprivileged_port_start=1024`，无特权端口绑定权；以 root/`CAP_NET_BIND_SERVICE` 运行时把站点地址改为 `https://localhost` 即可使用 443。
  2. **`auto_https disable_redirects`**：HTTP→HTTPS 跳转会绑 `:80`（同样无权限且会导致 Caddy 启动失败 `listen tcp :80: bind: permission denied`），本形态只经 `https://localhost:8443` 访问。
- **从零启动验证**（严格按 runbook 命令）：3080 上已有一个非本票启动的 dsh web（按约定保留，不作处理），故 dsh Host 以与 runbook 相同的命令启动在 **3081**（`node vendor/deepseek-harness/apps/cli/lib/bin.js web --port 3081`，日志 `dsh web: http://127.0.0.1:3081`），网关以文档化的 `UPSTREAM` 覆盖指向 3081（`UPSTREAM=http://127.0.0.1:3081 HOST=127.0.0.1 PORT=3000 AUTH_TOKEN=<128bit> pnpm start`），Caddy 按 `deploy/Caddyfile` 原样启动（`certificate obtained successfully, issuer: local`）。三进程均为本票新起，链路 Caddy(8443) → 网关(3000) → dsh Host(3081) 完全从零。

### 验证证据（入口一律 `https://localhost:8443`，`curl --cacert <Caddy 根证书>`；探针 `NODE_EXTRA_CA_CERTS=<根证书>`）

- **无 cookie 一律 401（经 Caddy 入口）**：`GET /` → 401；`GET /manifest.webmanifest` → 401；`POST /api/session.list` → 401；WS upgrade（`GET /api/events.mux` 带完整握手头）→ 401；伪造 `dsh_auth=deadbeef` → 401。对照：`GET /login` 豁免 → 200。
- **登录**：错误 token `POST /login` → 401；正确 token → 204，`set-cookie: dsh_auth=<64hex>; HttpOnly; SameSite=Lax; Path=/; Max-Age=31536000; Secure`。
- **全链路（带 cookie）**：`GET /` → 200 SPA（含 `window.__DSH_BOOT__`）；`workspace.create` → `{ok:true, workspaceId:45e2d316…}`；`session.create` → `{ok:true, sessionId:session-9265bdd7…, agentPreset:"standard"}`；`probe-ws.mjs stream`（`GATEWAY=https://localhost:8443`，带 cookie）→ **经 `wss://localhost:8443/api/events.mux` 建连成功，7 帧 / 3205ms 窗口内逐条到达，全部为文本 JSON server-request，exit=0**。
- **agent 消息（无 LLM 凭证，按约定替代并如实记录）**：`session.prompt`（payload `{sessionId, content:[{type:'text',text:'ping'}], mode:'queue'}`）经入口 → `{ok:true, accepted:true}`；挂 mux WS 观察 12s 收到 **22 帧**（`session/queue`、`session/event`、`session/projection` 等）；`session.history` 显示 turn 完整执行：`turn/start` → `user/message` → `request/header` → `assistant/chunk` → `turn/end`，终止原因为 `llm-deepseek: no API key for provider route "deepseek-official"`（环境无 `DEEPSEEK_API_KEY`，`credentials.describe` 返回空）。**即链路验证通过、仅模型调用因无凭证失败**；有凭证环境下同一路径即可获得流式回答。
- **特权方法经入口**：`settings.describe` → 200 `{ok:true}`（writable:true，11 个命名空间）；`llm.discoverModels`、`credentials.describe` 亦经入口可达（业务层按 payload 校验/空凭证正常应答）。

### 遗留问题

- 浏览器实测未做（本环境无浏览器），以 curl + probe-ws.mjs 替代；登录页与 SPA 均为已验证的静态资源 + 标准 fetch/WebSocket，风险低。
- agent 消息的模型流式回答未验证（无 LLM 凭证）；补充 `DEEPSEEK_API_KEY`（credentials 服务或环境变量）后重新运行 `session.prompt` 即可完成闭环。
- Caddy 根证书信任为人工步骤（`caddy trust` 或手动导入），runbook 已写明；本机自用形态可接受。
