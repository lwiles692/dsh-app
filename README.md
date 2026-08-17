# dsh-app

[deepseek-harness](https://github.com/deepseek-ai/deepseek-harness)（dsh）是跑在开发机上的 agent 工作台。它的 Host 没有认证层，只监听回环地址，本仓库就在它前面加一层网关（认证 + 反向代理 + WebSocket 透传），再配一个 Tauri 2 薄壳和几套部署样例，让你能从浏览器、桌面（Windows/macOS/Linux）和移动端（Android/iOS）安全访问自己的 dsh。

网关只有一套代码，拓扑与客户端的差异全部由环境变量和部署配置承担。

用户文档只有这一份；`docs/` 下的实施方案和 agent 协作约定面向维护者，不在其列。

## 架构

```
┌─ 入口侧 ───────────────────────┐
│ Caddy（TLS 终结）→ dsh-gateway  │      dsh Host（进程托管方式不限，
│   认证 + 头改写               │──→   127.0.0.1:3080，裸跑）
│   + WS 代理 + 登录页            │      （同机回环，或经隧道指向开发机）
└──────────────▲─────────────────┘
        HTTPS/WSS（cookie 认证）
   ┌────┴─────────┬──────────────┐
桌面 Tauri 壳   移动 Tauri 壳   浏览器/PWA
（Win/mac/Linux）（iOS/Android）
```

链路：`客户端 → Caddy（TLS 终结）→ dsh-gateway（认证 + 反代 + WS 透传）→ dsh Host（永远只绑回环）`。

网关的职责（完整行为见 `gateway/src/server.js` 头注释）：

- **认证**：静态长 token（≥128 bit 随机）。登录页 `POST /login` 校验 token 后种下 `HttpOnly; Secure; SameSite=Lax` 的 cookie（一年有效）；除登录页外，所有请求（含 WS upgrade）都必须携带有效 cookie，否则一律 401。登录端点按来源 IP 限流，token 比较走恒定时间算法，日志脱敏。换掉 token，所有会话立即失效。
- **反向代理**：全量代理上游 SPA 静态文件和 `/api` 一元 POST（`POST /api/<method>`，单段点号路径）；请求体上限 160 MiB，WS maxPayload 100 MiB，与上游对齐。
- **WS 透传**：`/api/events.mux` 和 `/api/events.host` 两条纯下行 WebSocket。网关关闭了 socket 与请求超时，空闲长连接不会被掐断。
- **上游信任栅栏**：把 Host 头改写成上游回环地址，剥离 `Origin` / `Sec-Fetch-*` 头。这是上游的硬性要求，与认证无关。
- **移动布局补丁**：代理 `text/html` 时在 `</head>` 前注入移动端补丁 CSS（规则全部包在 `@media (max-width: 768px)` 内，桌面端不受影响），并给 viewport 补上 `viewport-fit=cover` 与 `interactive-widget=resizes-content`。设 `MOBILE_CSS_PATCH=false` 可关闭，实现见 `gateway/src/mobile-patch.js`。

## 仓库结构

```
dsh-app/
├── gateway/        # Node + fastify 网关：认证、Host/Origin 改写、WS 代理、
│                   #   登录页、移动 CSS 补丁注入（pnpm）
├── app/            # Tauri 2 客户端：一套代码出桌面三平台 + Android/iOS（pnpm）
├── deploy/         # 三种拓扑的 Caddyfile/隧道样例 + systemd/launchd 进程托管参考实现
├── scripts/        # verify-upstream.sh：上游协议/栅栏行为回归验证（升级必跑）
├── vendor/         # 上游浅克隆（pin 到已验证 commit，仅供阅读调试，不参与构建）
└── docs/           # 实施方案（plans/）与 agent 协作文档（agents/）
```

## 部署（形态 A / B / C）

三种形态共用同一条链路 `浏览器 → Caddy → 网关 → dsh Host`，差别只在各组件落在哪台机器、证书从哪来。网关与 dsh Host 的代码不变，差异全靠环境变量（`UPSTREAM`/`HOST`/`PORT`/`AUTH_TOKEN`/`AUTH_COOKIE_SECURE`）：

- **形态 A（公网可达）**：Caddy 和网关跑在 VPS 上，经 WireGuard/frp 隧道回连开发机的 dsh Host；公网域名用 ACME 自动签证书。配置见 `deploy/topology-a/`。
- **形态 B（单机内网）**：Caddy、网关、dsh Host 都在开发机上；自有域名走 DNS-01 签证书，或者用内网 CA。配置见 `deploy/topology-b/`。
- **形态 C（本机自用）**：全部回环，Caddy 用本地 CA 给 `localhost` 签证书。配置见 `deploy/Caddyfile`。

安全红线只有一条：dsh Host 永不直接暴露（上游有意拒绝 `--host 0.0.0.0`）；公网上只开 Caddy 的 443，网关和隧道代理端口一律只绑回环。

### 前置

- Node ≥ 20、pnpm、Rust stable（只有桌面壳需要 Rust）。
- `vendor/deepseek-harness` 已按 pin 获取并构建（`pnpm install && pnpm run build`，见 `scripts/verify-upstream.sh` 头注释）。
- `gateway/` 已执行 `pnpm install`。
- Caddy v2 静态二进制。系统里没有的话从官方下载（`https://caddyserver.com/api/download?os=linux&arch=amd64`），放到仓库外任意目录，别提交进 git。形态 B 走 DNS-01 时还需要带 DNS 插件的构建（`xcaddy build --with github.com/caddy-dns/cloudflare`），见「形态 B」。
- 生成入口 token——整套部署里唯一需要手工生成的秘密：

  ```sh
  export AUTH_TOKEN=$(openssl rand -hex 16)   # ≥32 字符；网关启动必填
  ```

### 形态 C（本机自用）

完整链路：`浏览器 → Caddy(https://localhost:8443) → 网关(127.0.0.1:3000) → dsh Host(127.0.0.1:3080)`。三个常驻进程都只监听回环，按下面的顺序启动。进程托管方式不限，tmux、`systemd --user`、裸 nohup 都行。

#### 1) dsh Host（上游 web 服务）

```sh
cd vendor/deepseek-harness
node apps/cli/lib/bin.js web --port 3080
# 日志出现 "dsh web: http://127.0.0.1:3080" 即为就绪
```

环境变量：无。回环信任栅栏是上游内置的。

#### 2) 网关（认证 + 反代 + WS 透传）

```sh
cd gateway
UPSTREAM=http://127.0.0.1:3080 HOST=127.0.0.1 PORT=3000 AUTH_TOKEN="$AUTH_TOKEN" pnpm start
```

环境变量（详见 `gateway/src/server.js` 头注释）：

| 变量 | 默认 | 说明 |
| --- | --- | --- |
| `UPSTREAM` | `http://127.0.0.1:3080` | dsh Host 地址 |
| `HOST` | `127.0.0.1` | 监听地址；保持回环，由 Caddy 对外 |
| `PORT` | `3000` | 监听端口 |
| `AUTH_TOKEN` | （必填） | 登录 token，≥32 字符；缺失或过短时拒绝启动 |
| `AUTH_COOKIE_SECURE` | `true` | cookie `Secure` 开关；本形态入口是 HTTPS，保持默认。只有做 HTTP 回环降配时才显式设 `false`（启动时会打告警） |
| `MOBILE_CSS_PATCH` | `true` | 移动布局补丁注入开关 |

#### 3) Caddy（TLS 终结 + 入口）

```sh
caddy run --config deploy/Caddyfile
# 首次运行会自动创建本地 CA 并为 localhost 签证书；
# 日志出现 "certificate obtained successfully" / "serving initial configuration" 即为就绪
```

环境变量：无必需。默认数据目录是 `~/.local/share/caddy`（本地 CA 与证书）；想隔离的话用 `XDG_DATA_HOME`/`XDG_CONFIG_HOME` 覆盖。

#### 健康检查（形态 C）

```sh
ROOT_CRT=~/.local/share/caddy/pki/authorities/local/root.crt   # Caddy 本地 CA 根证书

# 1. 三进程存活：3080 / 3000 / 8443 均在监听
ss -ltn | grep -E ':(3080|3000|8443)\b'

# 2. 入口可达（登录页豁免认证）
curl --cacert "$ROOT_CRT" -s -o /dev/null -w '%{http_code}\n' https://localhost:8443/login
# 期望 200

# 3. 无 cookie 一律 401
curl --cacert "$ROOT_CRT" -s -o /dev/null -w '%{http_code}\n' https://localhost:8443/
# 期望 401

# 4. 登录拿 cookie 后 RPC 通
curl --cacert "$ROOT_CRT" -c /tmp/dsh.jar -s -o /dev/null -w '%{http_code}\n' \
  -X POST https://localhost:8443/login -H 'content-type: application/json' \
  -d "{\"token\":\"$AUTH_TOKEN\"}"
# 期望 204（set-cookie: dsh_auth=...; Secure）
curl --cacert "$ROOT_CRT" -b /tmp/dsh.jar -s -X POST https://localhost:8443/api/session.list \
  -H 'content-type: application/json' \
  -d '{"type":"client-request","rpcId":"hc1","method":"session.list","payload":{}}'
# 期望 200 + {"type":"server-response","rpcId":"hc1","result":{"ok":true,...}}
```

#### 浏览器信任（本地 CA）

入口证书是 Caddy 本地 CA 签发的，浏览器首次访问前要先信任根证书，两种方式任选：

- 系统级：`sudo caddy trust`（在 caddy 二进制所在的机器上执行），或者手动把 `~/.local/share/caddy/pki/authorities/local/root.crt` 导入系统/浏览器信任库；
- 临时：浏览器打开 `https://localhost:8443`，手动确认例外（仅限本人本机）。

没有浏览器的环境，用 `curl --cacert <root.crt>` 和 `NODE_EXTRA_CA_CERTS=<root.crt> node gateway/scripts/probe-ws.mjs` 代替。

之后浏览器打开 `https://localhost:8443`，在登录页粘贴 token，就能进入 SPA。

#### 端口与降配

- **为什么是 8443 而非 443**：非 root 进程绑不了特权端口（`ip_unprivileged_port_start=1024`）。以 root 或 `CAP_NET_BIND_SERVICE` 运行时，把 `deploy/Caddyfile` 的站点地址改成 `https://localhost`，即可使用标准 443。
- **TLS 不降配**：本形态默认走本地 CA 的 HTTPS，cookie `Secure` 保持开启。只有 Caddy 完全不可用时才考虑 HTTP 回环降配：去掉 Caddy，直接访问网关 `http://127.0.0.1:3000`，并显式以 `AUTH_COOKIE_SECURE=false` 启动（网关会打告警；切勿暴露到非回环地址）。
- 换 token 可让所有旧会话立即失效——cookie 值就是 `sha256(token)`。

停止时按相反顺序来：Caddy → 网关 → dsh Host，各自 Ctrl-C 或杀进程即可。

### 形态 A（公网 VPS + 隧道回连开发机）

链路：`浏览器 → https://<公网域名>（VPS Caddy）→ 网关(VPS 127.0.0.1:3000) → 隧道 → dsh Host(开发机 127.0.0.1:3080)`。适合用手机或其他设备从任意网络访问自己的 dsh。

几个设计要点：

- **dsh Host 永远只绑回环**。上游有意不支持 `--host 0.0.0.0`（安全设计，见上游 README），信任栅栏也要求连接来自回环，所以隧道一律把流量折返到开发机回环。dsh Host 的配置与形态 C 完全一致。
- **网关配置不变**。两种隧道样例都把开发机的回环 3080 映射成 VPS 的回环 3080，网关 `UPSTREAM` 保持默认 `http://127.0.0.1:3080`，Host 头改写也与形态 C 相同。
- **公网面只有 Caddy**。443 由 Caddy 占用，ACME 证书自动签发、续期；网关和隧道代理端口全部只绑 VPS 回环。

#### 组件与配置文件

- `deploy/topology-a/Caddyfile`（VPS）：站点地址换成自有域名，DNS A/AAAA 指向 VPS，防火墙放行 80/443。Caddy 需要特权端口，以 root 或官方 systemd 单元运行。
- 隧道二选一（样例都在 `deploy/topology-a/`）：
  - **WireGuard**：`wireguard/wg0.vps.conf.sample`（VPS）、`wireguard/wg0.dev.conf.sample`（开发机）。防火墙放行 VPS UDP 51820。
  - **frp**（frp ≥ v0.52，开发机在 NAT 后也可用）：`frp/frps.toml.sample`（VPS）、`frp/frpc.toml.sample`（开发机）。防火墙放行 VPS TCP 7000。

#### 启动顺序

1. **开发机 dsh Host**：与形态 C 相同（`node apps/cli/lib/bin.js web --port 3080`）。
2. **隧道**：
   - WireGuard：两端 `sudo wg-quick up wg0`，`wg show` 能看到握手就说明通了；然后两端各起一个本地转发器，把隧道流量折返回环：
     ```sh
     # 开发机：隧道地址 10.9.0.2:3080 -> 本机回环 dsh Host
     socat TCP-LISTEN:3080,bind=10.9.0.2,fork,reuseaddr TCP:127.0.0.1:3080 &
     # VPS：网关访问 VPS 回环 3080 -> 隧道 -> 开发机
     socat TCP-LISTEN:3080,bind=127.0.0.1,fork,reuseaddr TCP:10.9.0.2:3080 &
     ```
     （转发器只是样例；长期运行建议交给 systemd 托管，或者改用下面的 frp 方案。）
   - frp：VPS 跑 `frps -c frps.toml`，开发机跑 `frpc -c frpc.toml`。frpc 自带本地转发，不需要 socat。
3. **VPS 网关**：与形态 C 相同（`UPSTREAM=http://127.0.0.1:3080 HOST=127.0.0.1 PORT=3000 AUTH_TOKEN=... pnpm start`）。`AUTH_COOKIE_SECURE` 保持默认 `true`（入口是 HTTPS）。
4. **VPS Caddy**：`caddy run --config deploy/topology-a/Caddyfile`（正式使用建议用 systemd 托管）；日志出现 `certificate obtained successfully` 即证书就绪。

#### 健康检查（形态 A）

```sh
# VPS 上：隧道通（经 VPS 回环打到开发机 dsh Host）
curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:3080/login   # 期望 200

# 入口：无 cookie 401、登录 204、带 cookie RPC 200，与形态 C 健康检查同一套命令，
# 只把 https://localhost:8443 换成 https://<公网域名>，且不再需要 --cacert（公开证书）
curl -s -o /dev/null -w '%{http_code}\n' https://dsh.example.com/        # 期望 401
```

#### 注意事项（形态 A）

- 公网暴露面：Caddy 443（ACME 另需 80），外加 WireGuard 51820/UDP 或 frp 7000/TCP 二选一。网关 3000、隧道代理 3080 只绑 VPS 回环，不要对公网放行。
- frp 的 `proxyBindAddr = "127.0.0.1"` 是关键：默认值与 `bindAddr` 相同，会把 3080 绑到公网，样例里已显式改掉。隧道本身用 token + TLS（样例已开）。
- 登录端点限流按来源 IP 计数。经 Caddy 反代后，网关看到的是 Caddy 的回环连接，对单用户自用没有影响；想让网关看到真实客户端 IP，需自行给网关加 `trustProxy` 与 `X-Forwarded-For` 处理。
- 隧道断了网关照常运行，上游请求会 502 或超时；隧道恢复后自动接回（frpc 与 wg 都会自动重连）。

### 形态 B（单机内网 + 自有域名）

链路：`局域网浏览器 → https://dsh.home.example.com（开发机 Caddy）→ 网关(127.0.0.1:3000) → dsh Host(127.0.0.1:3080)`。三个进程同机，与形态 C 的区别只在入口从 `localhost` 换成自有域名、Caddy 监听局域网地址；网关与 dsh Host 的配置完全不变。

#### 组件与配置文件

`deploy/topology-b/Caddyfile`（开发机）：站点地址换成自有域名，DNS A 记录指向开发机内网 IP（如 192.168.1.10）。证书二选一，在 Caddyfile 内用注释互斥切换：

1. **DNS-01（默认）**：域名托管在 DNS 服务商处，用带 DNS 插件的 Caddy 构建（样例为 cloudflare 插件：`xcaddy build --with github.com/caddy-dns/cloudflare`），API token 经环境变量 `CLOUDFLARE_API_TOKEN` 注入。记录解析到私网地址也能签发——验证走 DNS API，不要求开发机公网可达——纯内网私有化使用同样没有问题。
2. **内网 CA（备选）**：`tls internal`，由 Caddy 本地 CA 签发，无需插件、无需公网；代价是每台客户端都要信任 Caddy 根证书（步骤同形态 C「浏览器信任」）。

#### 启动顺序

1. dsh Host：与形态 C 相同。
2. 网关：与形态 C 相同（回环绑定不变；`AUTH_COOKIE_SECURE` 保持默认 `true`）。
3. Caddy：`CLOUDFLARE_API_TOKEN=<token> caddy run --config deploy/topology-b/Caddyfile`（DNS-01）；443 需 root 或 `CAP_NET_BIND_SERVICE`，非 root 时按 Caddyfile 注释改用 `:8443`。

#### 健康检查（形态 B）

与形态 C 同一套命令，入口换成 `https://dsh.home.example.com`：DNS-01 证书不再需要 `--cacert`；`tls internal` 仍需 `--cacert <Caddy 根证书>`。再从局域网另一台机器访问同一入口，确认 DNS 与监听地址无误。

#### 注意事项（形态 B）

- 只有 Caddy 监听局域网接口；网关与 dsh Host 仍只绑回环，与形态 C 一致。
- DNS-01 的 API token 是秘密：走环境变量注入（systemd `EnvironmentFile` / launchd `EnvironmentVariables`），不要写进 Caddyfile 提交。
- 域名只是一条解析到内网 IP 的普通 DNS 记录，用公共 DNS 或内网 DNS 服务器/hosts 分发都可以。

### 进程托管（systemd / launchd）

`deploy/process-management/` 给出了网关与 dsh Host 两个进程的参考实现，三种形态通用（形态 A 中网关单元跑在 VPS、Host 单元跑在开发机）。Caddy 与 frp/WireGuard 自带官方单元（`caddy.service`、`frps.service`/`frpc.service`、`wg-quick@wg0`），这里不再重复。

- **systemd**（Linux，系统级）：`systemd/dsh-host.service`、`systemd/dsh-gateway.service`。安装与 secret 管理（`/etc/dsh/gateway.env`，0600 root）见单元文件头注释。要点：`Restart=on-failure`、`NoNewPrivileges`、`PrivateTmp`；网关的 `AUTH_TOKEN` 等走 `EnvironmentFile`，不落单元文件。
- **launchd**（macOS，用户级 LaunchAgent）：`launchd/com.dsh-app.dsh-host.plist`、`launchd/com.dsh-app.dsh-gateway.plist`。安装见 plist 头注释（`launchctl bootstrap gui/$(id -u)`）。launchd 没有 `EnvironmentFile` 机制，`AUTH_TOKEN` 只能写在 plist 里，务必 `chmod 0600`；更稳妥的做法是包一层从 Keychain 取 token 的启动脚本。

两套实现里的 `WorkingDirectory` 都以 `/opt/dsh-app` 占位，按实际部署路径修改；node 路径（`/usr/bin/node` / `/usr/local/bin/node`）按目标机实际调整（`command -v node`）。

## 桌面与移动客户端（app/）

客户端是个薄壳：窗口直接加载网关 URL，不打包业务静态资源。首次启动先展示本地配置页，保存服务器地址（`tauri-plugin-store` 持久化到 `settings.json`）后导航到网关。登录在 webview 内完成，token 经网关登录页以 `HttpOnly; Secure; SameSite=Lax` cookie 持久化；壳本身不保存 token，也没有引入 keyring/stronghold。

桌面端的体验项：系统托盘（显示/隐藏窗口、开机自启与关窗驻留开关、退出）、单实例（重复启动聚焦已有窗口，不另开进程）、关窗默认驻留托盘（托盘里可以关掉，关掉后关窗即退出进程）。开机自启在首次启动时默认开启，在托盘里取消勾选后不会再被自动打开。

自动更新用 `tauri-plugin-updater` + `tauri-plugin-dialog`，检查、确认、下载、安装全部在 Rust 侧完成（`src-tauri/src/updater.rs`）。不走 webview 内的 JS updater API，是因为主窗口加载的是远程网关页，IPC 不对远程页面开放。入口有两个：启动时静默检查（失败只打日志，不影响使用），以及原生菜单/托盘菜单的「检查更新…」（无更新或失败均弹系统对话框）。Linux（替换 AppImage）与 macOS（替换 app）安装完自动重启；Windows 走 msi passive 安装器，由安装器自行退出应用。

### 结构

- `src/` — 本地启动配置页（零构建：`index.html` / `main.js` / `styles.css`，经 `withGlobalTauri` 全局 API 调 Rust command；IPC 仅本地页面可用）。
- `src-tauri/` — Tauri 2 工程。
  - `src/lib.rs` — 窗口创建（已配置 → `WebviewUrl::External(网关)`，否则本地配置页）、`get_server_url` / `set_server_url` command、原生菜单「更改服务器地址」（回配置页改指向另一实例）、URL 校验（https 任意；http 仅回环，对应部署「端口与降配说明」的降配形态）。
  - `src/updater.rs` — 更新检查/确认/下载/安装（Rust 侧触发）。
  - `capabilities/default.json` — 桌面能力：`core:default` + `updater:default`（权限仅对本地页面生效；实际更新流程不经 JS API，权限为本地页直连预留）。
  - `capabilities/mobile.json` — 移动端能力：仅 `core:default`。
  - `tauri.conf.json` — `frontendDist: ../src`，窗口在代码中创建；`plugins.updater` 为占位配置（见下「自动更新占位」）。
  - `gen/android/` — Tauri Android 工程（`tauri android init` 产物，**入库**：MainActivity 补丁等手改内容在 init 产物里，重新 init 不会保留）。

### 移动端（Android/iOS）

与桌面共用 `app/` 工程，另开移动 target。桌面专属能力按平台门控（`#[cfg(desktop)]`，Cargo.toml 按 target 门控依赖）：托盘与原生菜单（tray-icon crate 和 muda 没有 Android 实现）、single-instance、autostart、updater（插件官方明确不支持移动端）；移动端保留启动配置页、网关加载、store 持久化与 dialog。

原生补丁（`gen/android/app/src/main/java/.../MainActivity.kt`，结论来自移动 spike）：

1. **safe-area 桥（S1）**：Android WebView < 140 的 `env(safe-area-inset-*)` 恒为 0（tauri#14240），原生侧读取 systemBars + displayCutout，经 `evaluateJavascript` 写入 `--dsh-safe-{top,right,bottom,left}` CSS 变量；网关的移动 CSS 补丁用 `max(env(...), var(--dsh-safe-*))` 回退链消费。走 evaluateJavascript 而非插件 JS API，原因同上：主窗口是远程页，IPC 不对其开放。
2. **键盘 inset（K1/K2）**：manifest `android:windowSoftInputMode="adjustResize"` + MainActivity 把 IME inset 设为 WebView 底部 padding（edge-to-edge 下 adjustResize 单独不生效，tauri#7868）；与网关补丁的 `interactive-widget=resizes-content`（K3）配合。

### 构建

#### Linux 桌面（构建依赖）

Rust stable + 系统库（Tauri 2 / WebKitGTK 4.1）：

```sh
sudo apt install pkg-config libwebkit2gtk-4.1-dev libgtk-3-dev libglib2.0-dev \
  libsoup-3.0-dev libjavascriptcoregtk-4.1-dev libssl-dev
cd app && pnpm install && pnpm build    # 或 pnpm dev
```

#### Android debug APK（Linux）

前置（用户级工具链，无需 sudo；本仓库验证时的路径供参考）：

```sh
# JDK 17（temurin tarball 解压）+ Android SDK（cmdline-tools + sdkmanager）
export JAVA_HOME=~/.local/opt/jdk-17
export ANDROID_HOME=~/.local/opt/android-sdk
export NDK_HOME=$ANDROID_HOME/ndk/27.2.12479018
export PATH=$JAVA_HOME/bin:$ANDROID_HOME/platform-tools:$PATH
# rust android target（首次）
rustup target add aarch64-linux-android
# SDK 组件（platform-tools / platforms / build-tools / ndk）
sdkmanager --install "platform-tools" "platforms;android-36" \
  "build-tools;34.0.0" "ndk;27.2.12479018"
```

模板要求 compileSdk 36 / targetSdk 36 / minSdk 24（缺失时 gradle 会自动补装）。

构建与校验：

```sh
pnpm exec tauri android build --debug --apk --target aarch64
# 产物：src-tauri/gen/android/app/build/outputs/apk/universal/debug/app-universal-debug.apk
# 完整性校验（无真机时替代「可安装」验收）：
$ANDROID_HOME/build-tools/34.0.0/aapt dump badging <apk> | head
```

真机部署：`adb install -r <apk>`。首次启动在配置页填网关入口（形态 B 的 `https://dsh.home.example.com:8443` 或 DNS-01 域名），登录后就建立了 cookie 会话。

#### iOS（工程配置待生成，出包需 macOS）

`tauri ios init` 在 Linux 上**不可用**：CLI 的 `Ios` 子命令是 `#[cfg(target_os = "macos")]`（tauri-cli `src/lib.rs`），且工程生成硬依赖 XcodeGen（`xcodegen generate`，仅 macOS）。因此 `gen/apple/` 尚未生成。macOS 上的步骤：

```sh
rustup target add aarch64-apple-ios aarch64-apple-ios-sim
pnpm exec tauri ios init          # 生成 gen/apple/ Xcode 工程
pnpm exec tauri ios build         # 需 Xcode + Apple 开发者证书/签名
```

签名配置在 `tauri.conf.json` 的 `bundle.ios`（或 `TAURI_APPLE_DEVELOPMENT_TEAM` 等环境变量，见 Tauri 文档 iOS 签名节）。iOS 侧同样需要 safe-area/键盘适配：Android 的 MainActivity 桥是 Kotlin 实现，iOS 对应的改动在 `gen/apple/` 生成后的 Swift 侧，届时按同一 spike 结论落地。

### CI 出包

`.github/workflows/apps-release.yml`：矩阵构建三平台安装包 + Android APK，产物上传 workflow artifacts；打 `v*` tag 的构建还会把产物附到 draft release（`contents: write`，人工核对后发布）。

| 平台 | runner | 产物 |
| --- | --- | --- |
| macOS | `macos-latest` | universal dmg（aarch64 + x86_64） |
| Linux | `ubuntu-22.04` | AppImage + deb |
| Windows | `windows-latest` | msi（x64） |
| Android | `ubuntu-22.04` | arm64-v8a debug APK（JDK 17 + SDK/NDK 组件同「Android debug APK」节） |

iOS 不在 CI 内：`gen/apple/` 未生成，且 `tauri ios init` 需 macOS + XcodeGen（见「iOS」节）。

签名目前是占位（构建未签名）：真实密钥就绪后，在 workflow 对应平台的 job 里注入签名环境变量（占位位置已在注释中标出），并开启 `createUpdaterArtifacts` 产出 updater 签名产物（见下）；Android 同理，切到 release 出包并配 keystore（workflow 内注释有步骤）。

### 自动更新占位

`tauri.conf.json` 的 `plugins.updater` 目前是占位配置，**不可直接用于生产**：

- `endpoints` — `https://updates.dsh.example.com/dsh-app/{{target}}/{{arch}}/{{current_version}}` 是占位域名。启用时改成真实更新源（静态 JSON 或 latest-release 接口），JSON 需含 `version` / `notes` / `pub_date` / `platforms.{target}`（`signature` + `url`）。
- `pubkey` — `PLACEHOLDER-REPLACE-WITH-REAL-MINISIGN-PUBLIC-KEY` 是占位。生成密钥对：`pnpm exec tauri signer generate -w ~/.tauri/dsh-app.key`（私钥入 CI secrets `TAURI_SIGNING_PRIVATE_KEY` / `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`，公钥替换占位）。
- `bundle.createUpdaterArtifacts` 当前为 `false`。updater 产物要求 `min`：Windows 需 NSIS（`windows` bundle），macOS 需 dmg updater 产物与 aarch64 交叉编译；矩阵切到 NSIS 并开启 `createUpdaterArtifacts: true` 后即可产出。

占位 endpoint 下的实际表现：启动时的静默检查会收到一次失败的 HTTP 请求（只打日志），菜单「检查更新…」会弹「检查更新失败」，不影响其他功能。

### 运行形态

壳的入口默认是 `https://localhost:8443`（形态 C）。系统需要信任 Caddy 本地 CA 的根证书（`caddy trust` 或手动导入，同「浏览器信任」一节），否则 webview 会报证书错误。

## 安全模型

- **token 即全权限**：网关把 Host 重写为回环后，上游 `PRIVILEGED_METHODS`（设置/凭据/目录选择等 15 个）在远程全部可用，网关不做二次拦截，远程端因此拥有完整功能。token 泄露等于交出开发机控制权与凭据存储——这在自用场景是可以接受的取舍。防线在于 token 强度（≥128 bit）、HTTPS（cookie `Secure`）、登录限流与日志脱敏。
- **单用户设计**：没有多租户，也没有会话存储；换 token 并重启网关，所有会话一并失效。
- **上游协议 pin 死**：`vendor/` 与部署使用同一 commit（`47f9438`，`@deepseek-ai/dsh` 0.1.0-rc.5，见 `scripts/verify-upstream.sh`）。升级流程：换 pin → `pnpm install && pnpm run build` → 跑 `scripts/verify-upstream.sh` 回归（RPC 路径格式、信任栅栏行为、WS/SSE、`PRIVILEGED_METHODS` 清单）→ 人工过一遍端到端验收。

## 文档索引

| 文档 | 内容 |
| --- | --- |
| `docs/plans/dsh-multi-client-plan.md` | 调研与实施方案（协议核实结论、认证设计、分阶段计划、风险） |
| `gateway/src/server.js` | 网关实现，头注释含完整行为说明与环境变量 |
| `scripts/verify-upstream.sh` | 上游 pin 版本与回归断言清单 |
| `AGENTS.md` / `docs/agents/` | 仓库内 issue tracker、triage 标签与领域文档约定 |
