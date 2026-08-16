# dsh-app

把 [deepseek-harness](https://github.com/deepseek-ai/deepseek-harness)（dsh）封装为**多客户端 App**：一套网关 + 一个 Tauri 2 壳，让自己的 dsh（跑在开发机上的 agent 工作台）可以从浏览器、桌面（Windows/macOS/Linux）与移动端（Android/iOS）安全访问。

上游 dsh Host 无认证层且只监听回环，本仓库在它前面加一层网关（认证 + 反向代理 + WebSocket 透传），并用薄壳与部署配置覆盖多种网络拓扑。**网关一份代码通吃所有拓扑与客户端**，差异全部走环境变量与部署配置。

## 架构

```
┌─ 入口侧 ───────────────────────┐
│ Caddy（TLS 终结）→ dsh-gateway  │      dsh Host（进程托管方式不限，
│   认证 + 头改写               │──→   127.0.0.1:3080，裸跑）
│   + WS 代理 + 登录页            │      （同机回环，或经隧道指向它机）
└──────────────▲─────────────────┘
        HTTPS/WSS（cookie 认证）
   ┌────┴─────────┬──────────────┐
桌面 Tauri 壳   移动 Tauri 壳   浏览器/PWA
（Win/mac/Linux）（iOS/Android）
```

链路：`客户端 → Caddy（TLS 终结）→ dsh-gateway（认证 + 反代 + WS 透传）→ dsh Host（永远只绑回环）`。

网关的职责（详见 `gateway/src/server.js` 头注释）：

- **认证面**：静态长 token（≥128 bit 随机）+ 最小登录页 `POST /login` 种 `HttpOnly; Secure; SameSite=Lax` cookie（1 年长效）；除登录外一切请求（含 WS upgrade）须持有效 cookie，否则 401；登录端点按 IP 限流；token/摘要比较恒定时间，日志脱敏；换 token 即全量会话失效。
- **反向代理**：上游 SPA 静态文件与 `/api` 一元 POST（`POST /api/<method>`，单段点号路径）全量代理；请求体上限 160 MiB、WS maxPayload 100 MiB，对齐上游。
- **WS 透传**：`/api/events.mux` 与 `/api/events.host` 两条纯下行 WebSocket；网关关闭 socket/请求超时，长连接空闲不被掐断。
- **过上游信任栅栏**：Host 头改写为上游回环地址，剥离 `Origin` / `Sec-Fetch-*`（上游信任栅栏要求，非认证层）。
- **移动布局补丁注入**：代理 `text/html` 时在 `</head>` 前注入补丁 CSS（全部规则包在 `@media (max-width: 768px)` 内，桌面不受影响），并补齐 viewport 的 `viewport-fit=cover` 与 `interactive-widget=resizes-content`；`MOBILE_CSS_PATCH=false` 可关。见 `gateway/src/mobile-patch.js`。

## 仓库结构

```
dsh-app/
├── gateway/        # Node + fastify 网关：认证、Host/Origin 改写、WS 代理、
│                   #   登录页、移动 CSS 补丁注入（pnpm）
├── app/            # Tauri 2 客户端：一套代码出桌面三平台 + Android/iOS；
│                   #   含自己的 README（构建/CI/移动端补丁细节）
├── deploy/         # 部署 runbook + 三种拓扑的 Caddyfile/隧道样例 +
│                   #   systemd/launchd 进程托管参考实现
├── scripts/        # verify-upstream.sh：上游协议/栅栏行为回归验证（升级必跑）
├── vendor/         # 上游浅克隆（pin 到已验证 commit，仅供阅读调试，不参与构建）
└── docs/           # 实施方案（plans/）与 agent 协作文档（agents/）
```

## 快速开始（形态 C：本机自用）

完整链路 `浏览器 → Caddy(https://localhost:8443) → 网关(127.0.0.1:3000) → dsh Host(127.0.0.1:3080)`，三个常驻进程全部只监听回环。以下为最短路径，细节（健康检查、浏览器信任本地 CA、降配说明）见 `deploy/RUNBOOK.md`。

前置：Node ≥ 20、pnpm、Caddy v2 静态二进制（勿提交进 git）、Rust stable（仅桌面壳需要）。

```sh
# 0) 获取并构建上游（pin 见 scripts/verify-upstream.sh 头注释）
git clone --depth 1 https://github.com/deepseek-ai/deepseek-harness.git vendor/deepseek-harness
cd vendor/deepseek-harness && pnpm install && pnpm run build && cd ../..

# 1) dsh Host（上游 web 服务）
cd vendor/deepseek-harness
node apps/cli/lib/bin.js web --port 3080

# 2) 网关（新终端）
export AUTH_TOKEN=$(openssl rand -hex 16)   # ≥32 字符，启动必填
cd gateway && pnpm install
UPSTREAM=http://127.0.0.1:3080 HOST=127.0.0.1 PORT=3000 AUTH_TOKEN="$AUTH_TOKEN" pnpm start

# 3) Caddy（新终端；首次运行自动为 localhost 签本地 CA 证书）
caddy run --config deploy/Caddyfile
```

信任 Caddy 本地 CA 根证书（`sudo caddy trust`，或浏览器手动确认例外），然后浏览器打开 `https://localhost:8443` → 登录页粘贴 token → 进入 SPA。

### 网关环境变量

| 变量 | 默认 | 说明 |
| --- | --- | --- |
| `UPSTREAM` | `http://127.0.0.1:3080` | dsh Host 地址 |
| `HOST` | `127.0.0.1` | 监听地址；保持回环，由 Caddy 对外 |
| `PORT` | `3000` | 监听端口 |
| `AUTH_TOKEN` | （必填） | 登录 token，≥32 字符；缺失/过短启动即拒绝 |
| `AUTH_COOKIE_SECURE` | `true` | cookie `Secure` 开关；仅 HTTP 回环降配时显式设 `false`（启动打告警） |
| `MOBILE_CSS_PATCH` | `true` | 移动布局补丁注入开关 |

## 部署形态

三种形态共用同一份网关与 Host 代码，差异全在落点与证书来源。配置、启动顺序、健康检查、注意事项见 `deploy/RUNBOOK.md`。

| 形态 | 链路 | 适用 |
| --- | --- | --- |
| **A 公网可达** | VPS 跑 Caddy + 网关（ACME 自动证书），WireGuard/frp 隧道回连开发机的 dsh Host；配置在 `deploy/topology-a/` | 手机/他机从任意网络访问 |
| **B 单机内网** | 三进程同在开发机，入口换自有域名（DNS-01 签证书，或内网 CA）；配置在 `deploy/topology-b/` | 局域网内多设备访问 |
| **C 本机自用** | 全回环，`localhost` 本地 CA；配置在 `deploy/Caddyfile` | 本人本机 |

安全红线：dsh Host 永不直接暴露（上游有意拒绝 `--host 0.0.0.0`）；公网面只有 Caddy 443；网关、隧道代理端口只绑回环。进程托管参考实现（systemd 单元 / launchd plist，secret 走 `EnvironmentFile` 或 0600 plist）在 `deploy/process-management/`。

## 桌面与移动客户端（app/）

薄壳：窗口直接加载网关 URL，不打包业务静态资源。首次启动展示本地配置页，保存服务器地址（`tauri-plugin-store`）后导航到网关；登录在 webview 内完成，token 以 cookie 持久化——壳不保存 token。

- **桌面**（Windows/macOS/Linux）：系统托盘、关窗驻留、开机自启、单实例、自动更新（`tauri-plugin-updater`，Rust 侧触发）。
- **Android**：同一 `app/` 工程，桌面专属能力按平台门控；原生 MainActivity 补丁解决 safe-area 与键盘 inset（Android WebView 的 `env(safe-area-inset-*)` 缺陷与 edge-to-edge 键盘行为），与网关注入的 CSS 补丁配合。
- **iOS**：工程配置待在 macOS 上 `tauri ios init` 生成（CLI 硬依赖 macOS + XcodeGen）。

构建（Linux 桌面为例）：

```sh
sudo apt install pkg-config libwebkit2gtk-4.1-dev libgtk-3-dev libglib2.0-dev \
  libsoup-3.0-dev libjavascriptcoregtk-4.1-dev libssl-dev
cd app && pnpm install && pnpm build    # 或 pnpm dev
```

Android debug APK（JDK 17 + Android SDK/NDK 前置、构建与校验命令）见 `app/README.md`。

### CI 出包

`.github/workflows/apps-release.yml`：矩阵构建 macOS universal dmg、Linux AppImage+deb、Windows msi、Android arm64 debug APK。push tag `v*` 时产物附到 draft release；`workflow_dispatch` 手动出包只上传 workflow artifacts。签名与 updater 端点当前为占位（未签名构建），启用步骤见 `app/README.md`。

## 安全模型

- **token 即全权限**：网关把 Host 重写为回环后，上游 `PRIVILEGED_METHODS`（设置/凭据/目录选择等 15 个）远程全部可用，网关不做二次拦截——远程端拥有完整功能。token 泄露 = 开发机控制权 + 凭据存储，自用场景接受；防线为 token 强度（≥128 bit）、HTTPS（cookie `Secure`）、登录限流、日志脱敏。
- **单用户设计**：无多租户、无会话存储；换 token 重启网关即全量失效。
- **上游协议 pin 死**：`vendor/` 与部署使用同一 commit（`47f9438`，`@deepseek-ai/dsh` 0.1.0-rc.5，见 `scripts/verify-upstream.sh`）。升级流程：换 pin → `pnpm install && pnpm run build` → 跑 `scripts/verify-upstream.sh` 回归（RPC 路径格式、信任栅栏行为、WS/SSE、`PRIVILEGED_METHODS` 清单）→ 人工过一遍端到端验收。

## 文档索引

| 文档 | 内容 |
| --- | --- |
| `deploy/RUNBOOK.md` | 部署 runbook：三种形态的配置、启动顺序、健康检查、进程托管 |
| `app/README.md` | Tauri 壳：结构、桌面体验项、自动更新、移动端补丁、构建与 CI |
| `docs/plans/dsh-multi-client-plan.md` | 调研与实施方案（协议核实结论、认证设计、分阶段计划、风险） |
| `gateway/src/server.js` | 网关实现，头注释含完整行为说明与环境变量 |
| `scripts/verify-upstream.sh` | 上游 pin 版本与回归断言清单 |
| `AGENTS.md` / `docs/agents/` | 仓库内 issue tracker、triage 标签与领域文档约定 |
