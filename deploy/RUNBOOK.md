# dsh 部署 Runbook（形态 A / B / C）

三种部署形态共用同一条链路 `浏览器 → Caddy → 网关 → dsh Host`，差异只在组件落点与证书来源，**网关与 dsh Host 代码不变，差异全部走环境变量**（`UPSTREAM`/`HOST`/`PORT`/`AUTH_TOKEN`/`AUTH_COOKIE_SECURE`）：

- **形态 A（公网可达）**：VPS 跑 Caddy + 网关，WireGuard/frp 隧道回连开发机的 dsh Host；公网域名 ACME 自动证书。配置见 `deploy/topology-a/`，章节见下「形态 A」。
- **形态 B（单机内网）**：Caddy + 网关 + dsh Host 同在开发机；自有域名走 DNS-01 签证书或内网 CA。配置见 `deploy/topology-b/`，章节见下「形态 B」。
- **形态 C（本机自用）**：全回环，`localhost` 本地 CA。配置见 `deploy/Caddyfile`，章节见下「形态 C」。

进程托管参考实现（systemd / launchd）统一放在 `deploy/process-management/`，见「进程托管」章节。

## 前置

- `vendor/deepseek-harness` 已按 pin 获取并构建（见 `scripts/verify-upstream.sh` 头注释；`pnpm install && pnpm run build`）。
- `gateway/` 已 `pnpm install`。
- Caddy v2 静态二进制：系统未安装时从官方下载（`https://caddyserver.com/api/download?os=linux&arch=amd64`）放到仓库外任意目录，**不要提交进 git**。形态 B 选 DNS-01 时需带 DNS 插件的构建（`xcaddy build --with github.com/caddy-dns/cloudflare`），见「形态 B」。
- 生成入口 token（仅此一处需要人工秘密）：

  ```sh
  export AUTH_TOKEN=$(openssl rand -hex 16)   # ≥32 字符；网关启动必填
  ```

## 形态 C（本机自用）

单用户本机自用的完整链路：`浏览器 → Caddy(https://localhost:8443) → 网关(127.0.0.1:3000) → dsh Host(127.0.0.1:3080)`。三个常驻进程，全部只监听回环。

### 常驻进程清单与启动顺序

按顺序起三个进程（进程托管方式不限：tmux/systemd --user/裸 nohup 均可）。

#### 1) dsh Host（上游 web 服务）

```sh
cd vendor/deepseek-harness
node apps/cli/lib/bin.js web --port 3080
# 日志出现 "dsh web: http://127.0.0.1:3080" 即就绪
```

环境变量：无（回环信任栅栏由上游内置）。

#### 2) 网关（认证 + 反代 + WS 透传）

```sh
cd gateway
UPSTREAM=http://127.0.0.1:3080 \
HOST=127.0.0.1 \
PORT=3000 \
AUTH_TOKEN="$AUTH_TOKEN" \
pnpm start
```

环境变量（详见 `gateway/src/server.js` 头注释）：

| 变量 | 默认 | 说明 |
| --- | --- | --- |
| `UPSTREAM` | `http://127.0.0.1:3080` | dsh Host 地址 |
| `HOST` | `127.0.0.1` | 监听地址，本形态保持回环 |
| `PORT` | `3000` | 监听端口 |
| `AUTH_TOKEN` | （必填） | 登录 token，≥32 字符；缺失/过短启动即拒绝 |
| `AUTH_COOKIE_SECURE` | `true` | 本形态入口是 HTTPS，**保持默认**；仅 HTTP 回环降配时才显式设 `false`（启动会打告警） |

#### 3) Caddy（TLS 终止 + 入口）

```sh
caddy run --config deploy/Caddyfile
# 首次运行自动创建本地 CA 并为 localhost 签证书；
# 日志出现 "certificate obtained successfully" / "serving initial configuration" 即就绪
```

环境变量：无必需。默认数据目录 `~/.local/share/caddy`（本地 CA 与证书）；想隔离可用 `XDG_DATA_HOME`/`XDG_CONFIG_HOME` 覆盖。

### 健康检查（形态 C）

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

### 浏览器信任（本地 CA）

入口证书由 Caddy 本地 CA 签发，浏览器首次访问需信任根证书（二选一）：

- 系统级：`sudo caddy trust`（caddy 二进制所在机器上执行），或手动把 `~/.local/share/caddy/pki/authorities/local/root.crt` 导入系统/浏览器信任库；
- 临时：浏览器打开 `https://localhost:8443` 手动确认例外（仅限本人本机）。

无浏览器环境用 `curl --cacert <root.crt>` 与 `NODE_EXTRA_CA_CERTS=<root.crt> node gateway/scripts/probe-ws.mjs` 替代（见 issue 05 Comments 的验证记录）。

之后浏览器打开 `https://localhost:8443` → 登录页粘贴 token → 进入 SPA。

### 端口与降配说明

- **8443 而非 443**：非 root 进程无特权端口绑定权（`ip_unprivileged_port_start=1024`）。以 root/`CAP_NET_BIND_SERVICE` 运行时，把 `deploy/Caddyfile` 站点地址改为 `https://localhost` 即用标准 443。
- **TLS 不降配**：本形态默认走本地 CA 的 HTTPS，cookie `Secure` 保持开启。仅当 Caddy 完全不可用时才考虑 HTTP 回环降配：去掉 Caddy，直接暴露网关 `http://127.0.0.1:3000`，并显式 `AUTH_COOKIE_SECURE=false` 启动（网关会打告警；切勿暴露到非回环地址）。
- 换 token 即全量会话失效（cookie 值为 `sha256(token)`，见 issue 04）。

### 停止（形态 C）

逆向顺序即可：Caddy → 网关 → dsh Host（各自 Ctrl-C 或杀进程）。

## 形态 A（公网 VPS + 隧道回连开发机）

链路：`浏览器 → https://<公网域名>（VPS Caddy）→ 网关(VPS 127.0.0.1:3000) → 隧道 → dsh Host(开发机 127.0.0.1:3080)`。适用于手机/他机从任意网络访问自己的 dsh。

设计要点：

- **dsh Host 永远只绑回环**：上游有意不支持 `--host 0.0.0.0`（安全设计，见上游 README），信任栅栏要求回环来源连接。因此隧道一律把流量折返到开发机回环，dsh Host 配置与形态 C 完全一致。
- **网关配置不变**：两种隧道样例都把开发机回环 3080 映射成 VPS 回环 3080，网关 `UPSTREAM` 保持默认 `http://127.0.0.1:3080`，Host 头改写与形态 C 相同。
- **公网面只有 Caddy**：443 由 Caddy 占用并自动签发/续期 ACME 证书；网关、隧道代理端口全部只绑 VPS 回环。

### 组件与配置文件

- `deploy/topology-a/Caddyfile`（VPS）：站点地址换成自有域名，DNS A/AAAA 指向 VPS，防火墙放行 80/443。Caddy 以 root 或官方 systemd 单元运行（需特权端口）。
- 隧道二选一（样例均在 `deploy/topology-a/`）：
  - **WireGuard**：`wireguard/wg0.vps.conf.sample`（VPS）、`wireguard/wg0.dev.conf.sample`（开发机）。防火墙放行 VPS UDP 51820。
  - **frp**（frp ≥ v0.52，开发机在 NAT 后也可用）：`frp/frps.toml.sample`（VPS）、`frp/frpc.toml.sample`（开发机）。防火墙放行 VPS TCP 7000。

### 启动顺序

1. **开发机 dsh Host**：与形态 C 相同（`node apps/cli/lib/bin.js web --port 3080`）。
2. **隧道**：
   - WireGuard：两端 `sudo wg-quick up wg0`，`wg show` 看到握手即通；然后两端各起一个本地转发器把隧道流量折返回环：
     ```sh
     # 开发机：隧道地址 10.9.0.2:3080 -> 本机回环 dsh Host
     socat TCP-LISTEN:3080,bind=10.9.0.2,fork,reuseaddr TCP:127.0.0.1:3080 &
     # VPS：网关打 VPS 回环 3080 -> 隧道 -> 开发机
     socat TCP-LISTEN:3080,bind=127.0.0.1,fork,reuseaddr TCP:10.9.0.2:3080 &
     ```
     （转发器只是样例；长期运行建议用 systemd 托管或改用下面的 frp 方案。）
   - frp：VPS `frps -c frps.toml`，开发机 `frpc -c frpc.toml`（frpc 已含本地转发，无需 socat）。
3. **VPS 网关**：与形态 C 相同（`UPSTREAM=http://127.0.0.1:3080 HOST=127.0.0.1 PORT=3000 AUTH_TOKEN=... pnpm start`）。`AUTH_COOKIE_SECURE` 保持默认 `true`（入口是 HTTPS）。
4. **VPS Caddy**：`caddy run --config deploy/topology-a/Caddyfile`（正式用 systemd 托管）；日志出现 `certificate obtained successfully` 即证书就绪。

### 健康检查（形态 A）

```sh
# VPS 上：隧道通（经 VPS 回环打到开发机 dsh Host）
curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:3080/login   # 期望 200

# 入口：无 cookie 401、登录 204、带 cookie RPC 200——与形态 C 健康检查同一套命令，
# 只把 https://localhost:8443 换成 https://<公网域名>，且不再需要 --cacert（公开证书）
curl -s -o /dev/null -w '%{http_code}\n' https://dsh.example.com/        # 期望 401
```

### 形态 A 注意事项

- 公网暴露面：Caddy 443（ACME 另需 80）；WireGuard 51820/UDP 或 frp 7000/TCP 二选一。网关 3000、隧道代理 3080 只绑 VPS 回环，**不要**对公网放行。
- frp 的 `proxyBindAddr = "127.0.0.1"` 是关键（默认与 `bindAddr` 相同会把 3080 绑到公网）；样例已显式设置。隧道本身用 token + TLS（样例已开）。
- 登录端点限流按来源 IP 计数，经 Caddy 反代后网关看到的是 Caddy 的回环连接——单用户自用无影响；若要在网关上看到真实客户端 IP，需自行给网关加 `trustProxy` 与 `X-Forwarded-For` 处理（本票不改代码）。
- 隧道中断时网关照常运行，上游请求会 502/超时；隧道恢复即自愈（frpc/wg 均自动重连）。

## 形态 B（单机内网 + 自有域名）

链路：`局域网浏览器 → https://dsh.home.example.com（开发机 Caddy）→ 网关(127.0.0.1:3000) → dsh Host(127.0.0.1:3080)`。三进程同机，与形态 C 的区别只在入口从 `localhost` 换成自有域名、Caddy 监听局域网地址，网关与 dsh Host 配置完全不变。

### 组件与配置文件

`deploy/topology-b/Caddyfile`（开发机）：站点地址换成自有域名，DNS A 记录指向开发机内网 IP（如 192.168.1.10）。证书二选一（Caddyfile 内注释互斥切换）：

1. **DNS-01（默认）**：域名托管在 DNS 服务商处，用带 DNS 插件的 Caddy 构建（样例为 cloudflare 插件：`xcaddy build --with github.com/caddy-dns/cloudflare`），API token 经环境变量 `CLOUDFLARE_API_TOKEN` 注入。**记录解析到私网地址也能签发**（验证走 DNS API，不要求开发机公网可达），且天然支持内网纯私有化使用。
2. **内网 CA（备选）**：`tls internal`，Caddy 本地 CA 签发，无需插件、无需公网；代价是每台客户端需信任 Caddy 根证书（步骤同形态 C「浏览器信任」）。

### 启动顺序

1. dsh Host：与形态 C 相同。
2. 网关：与形态 C 相同（回环绑定不变；`AUTH_COOKIE_SECURE` 保持默认 `true`）。
3. Caddy：`CLOUDFLARE_API_TOKEN=<token> caddy run --config deploy/topology-b/Caddyfile`（DNS-01）；443 需 root 或 `CAP_NET_BIND_SERVICE`，非 root 时按 Caddyfile 注释改用 `:8443`。

### 健康检查（形态 B）

与形态 C 同一套命令，入口换成 `https://dsh.home.example.com`（DNS-01 证书不再需要 `--cacert`；`tls internal` 仍需 `--cacert <Caddy 根证书>`）。另从另一台局域网机器访问同一入口验证 DNS 与监听地址正确。

### 形态 B 注意事项

- 只有 Caddy 监听局域网接口；网关与 dsh Host 仍只绑回环，与形态 C 一致。
- DNS-01 的 API token 是秘密：走环境变量注入（systemd `EnvironmentFile` / launchd `EnvironmentVariables`），不要写进 Caddyfile 提交。
- 域名只是解析到内网 IP 的普通 DNS 记录，可用公共 DNS 或内网 DNS 服务器/hosts 分发。

## 进程托管（systemd / launchd）

`deploy/process-management/` 给出网关与 dsh Host 两个进程的参考实现，三种形态通用（形态 A 中网关单元跑在 VPS、Host 单元跑在开发机）。Caddy 与 frp/WireGuard 自带官方单元（`caddy.service`、`frps.service`/`frpc.service`、`wg-quick@wg0`），不再重复造。

- **systemd**（Linux，系统级）：`systemd/dsh-host.service`、`systemd/dsh-gateway.service`。安装与 secret 管理（`/etc/dsh/gateway.env`，0600 root）见单元文件头注释。要点：`Restart=on-failure`、`NoNewPrivileges`、`PrivateTmp`；网关的 `AUTH_TOKEN` 等走 `EnvironmentFile`，不落单元文件。
- **launchd**（macOS，用户级 LaunchAgent）：`launchd/com.dsh-app.dsh-host.plist`、`launchd/com.dsh-app.dsh-gateway.plist`。安装见 plist 头注释（`launchctl bootstrap gui/$(id -u)`）。launchd 无 `EnvironmentFile`，`AUTH_TOKEN` 只能写在 plist 里，务必 `chmod 0600`；更严格可包一层从 Keychain 取 token 的启动脚本。

两套实现里 `WorkingDirectory` 均按 `/opt/dsh-app` 占位，按实际部署路径修改；node 路径（`/usr/bin/node` / `/usr/local/bin/node`）按目标机实际调整（`command -v node`）。
