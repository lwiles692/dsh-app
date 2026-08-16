# 06 — 形态 A/B 部署配置

**What to build:** runbook 补齐另外两种拓扑：形态 A（公网 VPS 跑 Caddy+网关，WireGuard/frp 隧道回连开发机的 dsh Host，公网域名自动证书）与形态 B（单机内网，Caddy+网关+Host 同在开发机，自有域名 DNS-01 签证书或内网 CA）。各给一套 Caddyfile 与进程托管参考实现（systemd 单元 + launchd plist），隧道配置样例。网关上游地址等差异全部走配置，代码不变。

**Blocked by:** 05

**Status:** resolved

- [x] 形态 A 的 Caddyfile + 隧道样例 + runbook 章节齐套
- [x] 形态 B 的 Caddyfile（DNS-01 或内网 CA）+ runbook 章节齐套
- [x] systemd 单元与 launchd plist 两份参考实现覆盖网关与 dsh Host
- [ ] 至少其中一种形态在真实环境实测通过（视持有资源而定，记录验证的是哪种）——未勾选：本环境无 VPS/自有域名/隧道资源，无法实测；已完成静态验证（Caddy validate、systemd-analyze verify、plist 解析），见 Comments

## Comments

### 完成内容（2026-08-16）

- **新增文件**（均在 `deploy/` 下，代码零改动）：
  - `deploy/topology-a/Caddyfile`：公网域名站点 → `reverse_proxy 127.0.0.1:3000`；ACME 自动证书（80/443 公网可达）；`admin off`。
  - `deploy/topology-a/wireguard/wg0.vps.conf.sample` / `wg0.dev.conf.sample`：VPS(10.9.0.1) ↔ 开发机(10.9.0.2)，开发机侧 Endpoint + PersistentKeepalive 穿 NAT。
  - `deploy/topology-a/frp/frps.toml.sample` / `frpc.toml.sample`（frp ≥ v0.52）：token 鉴权 + TLS；`proxyBindAddr = "127.0.0.1"` 把映射端口钉在 VPS 回环。
  - `deploy/topology-b/Caddyfile`：自有域名（A 记录指内网 IP）；DNS-01（cloudflare 插件，`{env.CLOUDFLARE_API_TOKEN}` 环境注入）为默认，`tls internal` 为注释互斥备选。
  - `deploy/process-management/systemd/dsh-host.service` / `dsh-gateway.service`：系统单元；秘密走 `EnvironmentFile=-/etc/dsh/gateway.env`（0600）；`Restart=on-failure`、`NoNewPrivileges`、`PrivateTmp`。
  - `deploy/process-management/launchd/com.dsh-app.dsh-host.plist` / `com.dsh-app.dsh-gateway.plist`：用户级 LaunchAgent；`KeepAlive`+`ThrottleInterval`；AUTH_TOKEN 只能写 plist，头注释要求 `chmod 0600` 并给出 Keychain 包装建议。
  - `deploy/RUNBOOK.md`：重定标题为「形态 A/B/C」总 runbook，原形态 C 内容降为同级章节（标题层级对应调整，正文不变），新增「形态 A」「形态 B」「进程托管」三章。
- **关键决策**：
  1. **隧道一律折返开发机回环**。上游有意不支持 `--host 0.0.0.0`（安全设计，见上游 README 与 built-bin e2e），信任栅栏要求回环来源。因此两种隧道样例都把开发机 `127.0.0.1:3080` 映射为 VPS `127.0.0.1:3080`——网关 `UPSTREAM` 保持默认，Host 头改写与形态 C 完全一致，**网关/Host 零配置差异**（仅 AUTH_TOKEN 等常规变量）。WireGuard 方案用两端 socat 转发器实现折返；frp 方案 frpc 自带本地转发。
  2. **frp `proxyBindAddr` 显式钉回环**：其默认与 `bindAddr` 相同（0.0.0.0），不设会把 3080 暴露公网，样例与 runbook 均强调。
  3. **形态 B 默认 DNS-01**：域名解析到私网地址也能签发（验证走 DNS API），客户端免配信任；`tls internal` 留作无插件/纯离线备选。DNS-01 需 xcaddy 插件构建，已在 Caddyfile 注释与 runbook 写明。
  4. 进程托管只覆盖网关与 dsh Host 两进程；Caddy/frp/wg-quick 自带官方单元，不重复造。
- **验证证据（静态）**：
  - `caddy validate --config deploy/topology-a/Caddyfile`（官方静态二进制 v2.11.4，临时下载于 `.scratch/bin/`，用后已清理）→ **Valid configuration**。
  - 形态 B Caddyfile：`caddy fmt` 解析通过；DNS-01 指令需插件构建，stock 二进制无法 validate，改为对 `tls internal` 变体（sed 替换 dns 行）跑 `caddy validate` → **Valid configuration**。
  - `systemd-analyze verify deploy/process-management/systemd/*.service` → exit 0，无告警。
  - 两个 plist 用 `python3 plistlib` 解析通过（本环境无 plutil）；Label/ProgramArguments 与预期一致。
  - 网关环境变量充分性确认：`gateway/src/server.js` 仅读 `UPSTREAM`/`HOST`/`PORT`/`AUTH_TOKEN`/`AUTH_COOKIE_SECURE`，形态 A/B 所需差异（上游地址、监听地址）全覆盖，代码不变成立。

### 遗留问题

- 第 4 项验收（真实环境实测）未做、checkbox 保持未勾：本环境无 VPS、无自有域名、无 DNS-01 凭证与隧道对端，无法实测形态 A/B。有资源后按 runbook 从零拉起，把 `https://dsh.example.com` 换成实际域名重跑形态 C 同款健康检查即可闭环。
- WireGuard 方案的 socat 转发器是命令样例，长期运行需自行托管（runbook 已注明）；frp 方案无此问题，推荐优先。
- systemd 单元中 `WorkingDirectory=/opt/dsh-app` 与 node 路径为占位，按目标机实际调整（runbook「进程托管」章已注明）。
