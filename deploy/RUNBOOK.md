# 形态 C 本机部署 Runbook

单用户本机自用的完整链路：`浏览器 → Caddy(https://localhost:8443) → 网关(127.0.0.1:3000) → dsh Host(127.0.0.1:3080)`。三个常驻进程，全部只监听回环。

## 前置

- `vendor/deepseek-harness` 已按 pin 获取并构建（见 `scripts/verify-upstream.sh` 头注释；`pnpm install && pnpm run build`）。
- `gateway/` 已 `pnpm install`。
- Caddy v2 静态二进制：系统未安装时从官方下载（`https://caddyserver.com/api/download?os=linux&arch=amd64`）放到仓库外任意目录，**不要提交进 git**。
- 生成入口 token（仅此一处需要人工秘密）：

  ```sh
  export AUTH_TOKEN=$(openssl rand -hex 16)   # ≥32 字符；网关启动必填
  ```

## 常驻进程清单与启动顺序

按顺序起三个进程（进程托管方式不限：tmux/systemd --user/裸 nohup 均可）。

### 1) dsh Host（上游 web 服务）

```sh
cd vendor/deepseek-harness
node apps/cli/lib/bin.js web --port 3080
# 日志出现 "dsh web: http://127.0.0.1:3080" 即就绪
```

环境变量：无（回环信任栅栏由上游内置）。

### 2) 网关（认证 + 反代 + WS 透传）

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

### 3) Caddy（TLS 终止 + 入口）

```sh
caddy run --config deploy/Caddyfile
# 首次运行自动创建本地 CA 并为 localhost 签证书；
# 日志出现 "certificate obtained successfully" / "serving initial configuration" 即就绪
```

环境变量：无必需。默认数据目录 `~/.local/share/caddy`（本地 CA 与证书）；想隔离可用 `XDG_DATA_HOME`/`XDG_CONFIG_HOME` 覆盖。

## 健康检查

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

## 浏览器信任（本地 CA）

入口证书由 Caddy 本地 CA 签发，浏览器首次访问需信任根证书（二选一）：

- 系统级：`sudo caddy trust`（caddy 二进制所在机器上执行），或手动把 `~/.local/share/caddy/pki/authorities/local/root.crt` 导入系统/浏览器信任库；
- 临时：浏览器打开 `https://localhost:8443` 手动确认例外（仅限本人本机）。

无浏览器环境用 `curl --cacert <root.crt>` 与 `NODE_EXTRA_CA_CERTS=<root.crt> node gateway/scripts/probe-ws.mjs` 替代（见 issue 05 Comments 的验证记录）。

之后浏览器打开 `https://localhost:8443` → 登录页粘贴 token → 进入 SPA。

## 端口与降配说明

- **8443 而非 443**：非 root 进程无特权端口绑定权（`ip_unprivileged_port_start=1024`）。以 root/`CAP_NET_BIND_SERVICE` 运行时，把 `deploy/Caddyfile` 站点地址改为 `https://localhost` 即用标准 443。
- **TLS 不降配**：本形态默认走本地 CA 的 HTTPS，cookie `Secure` 保持开启。仅当 Caddy 完全不可用时才考虑 HTTP 回环降配：去掉 Caddy，直接暴露网关 `http://127.0.0.1:3000`，并显式 `AUTH_COOKIE_SECURE=false` 启动（网关会打告警；切勿暴露到非回环地址）。
- 换 token 即全量会话失效（cookie 值为 `sha256(token)`，见 issue 04）。

## 停止

逆向顺序即可：Caddy → 网关 → dsh Host（各自 Ctrl-C 或杀进程）。
