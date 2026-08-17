# DeepSeek Harness (dsh) 封装为多客户端 App — 调研与实施方案

> v2：经 grilling 评审收敛。相对 v1 的主要变化：RPC 路径格式与栅栏细节按源码核实修正；
> 移除微信小程序（Phase 4 删除）；认证确定为"静态 token + 网关登录页写入 cookie"；
> 部署确定为"公网 VPS 运行 Caddy+网关，隧道回连开发机 dsh Host"；上游版本固定；
> 移动端以 spike 作 go/no-go，CSS 补丁首选网关注入方案。

## 一、调研结论（经源码核实，基于上游 master `47f9438`）

来源：[deepseek-ai/deepseek-harness](https://github.com/deepseek-ai/deepseek-harness)（MIT，TypeScript monorepo，developer preview，官方明确"会有破坏性变更"）。

**架构**：
- Host 端：Node.js + Cordis 插件运行时；`npx @deepseek-ai/dsh web`（`dsh web` 是 `--profile web` 的硬编码别名），默认监听 `127.0.0.1:3080`，托管 API 与前端静态文件。
- 前端：React 18 + Vite SPA（插件化 slot 体系）。**API base 硬编码为 `location.origin`**，全部走同源绝对路径 `/api/...`，无可配置注入点 → 纯反向代理 + cookie 认证可行，前端零改动。必须部署在域根（静态资源、manifest、API 路径全部根锚定，不支持子路径）。
- 有线协议（`packages/host/apiproxy`、`packages/client/connection`）：
  - 一元 RPC：**`POST /api/<method>`，点号连接的单段路径**（如 `POST /api/session.list`；注意不是 `/api/<ns>/<method>` 两段式）。请求体 envelope `{type:'client-request', rpcId, method, payload}`；**响应恒为 200**，业务错误在 `{ok:false,error:{code,message}}` 里。特例：`POST /api/respond`、`GET /api/session.export`（query 下载）。
  - 下行事件流：`/api/events.mux` 与 `/api/events.host`，优先 WebSocket（同源自适应 `ws:`/`wss:`，无子协议、无 query、无认证信息，浏览器靠 cookie），**另存在 SSE 回退**（`GET` 同路径返回 `text/event-stream`）。WS 纯下行文本帧（每帧一个完整 JSON），客户端发消息会被 `close(1008)`；客户端指数退避无限重连（从 500ms 起步，上限 10s）。

**关键限制**（逐条经源码定位核实）：
1. **无认证层，且无注入钩子**。源码明示信任栅栏"is not an auth layer"；`/api` 前缀路由被 client-connection 独占、插件无法整体前置拦截 → 认证只能在网关外侧实现。
2. **信任栅栏不止 Host 头**（`api-request-trust.ts`）：① Host 回环（`localhost`/`[::1]`/127/8 规范四段形式）或匹配 `trustedHosts`（WHATWG 归一化）；② `Sec-Fetch-Site: cross-site` 直接拒；③ **带 Origin 时其 host 必须与 Host 头完全一致**（无 Origin 视为通过）。→ 网关必须**同时重写 Host 并剥离/重写 Origin**，否则浏览器 POST/WS 均返回 403。另有写侧栅栏：非 `application/json` 的 POST 一律 415。
3. **特权方法限定回环**：`PRIVILEGED_METHODS` 共 17 个（`settings.*`、`credentials.*`、`host.pickDirectory/openPath`、agentPreset 创作面等，`packages/client/connection/src/index.ts:89-119`）。**网关把 Host 重写为回环后这些方法全部远程可达，网关后无任何二次防护** → 本期选择**不拦截**，远程端获得完整功能（见三、五）；清单仍固化进 `verify-upstream.sh`，上游升级时监控其变动。
4. **单用户取向**：Host 直接操作本机文件系统、终端、凭据，无多租户。本期按单用户多设备。
5. **WS 无心跳/保活，Host 侧无请求超时**：断连风险全部来自中间件 idle 超时 → 网关必须禁用或放宽 WS idle 超时。其余需对齐的限制：`maxRequestBodyBytes` 默认 160 MiB（由 100 MiB 图片聚合 base64 膨胀推算得出）；WS maxPayload 默认 100 MiB；客户端一元调用默认超时 30s。
6. 上游无 Docker 镜像/容器化文档；`--host 0.0.0.0` 被 CLI 明确拒绝（官方态度：无认证不暴露网络）。移动端无法运行 Node Host，只能是远程瘦客户端。

## 二、总体架构（已确认）

**使用场景**：个人自用，访问自己开发机上的 dsh（agent 操作开发机真实文件系统/终端/凭据）。访问入口可能是公网、内网或本机，**网关代码与拓扑无关**，部署时三选一：

```
┌─ 入口侧 ───────────────────────┐
│ Caddy（TLS 终结）→ dsh-gateway  │      dsh Host（进程托管方式不限，
│   认证 + 头改写               │──→   127.0.0.1:3080，裸跑）
│   + WS 代理 + 登录页            │      （同机回环，或经隧道指向它机）
└──────────────▲─────────────────┘
        HTTPS/WSS（cookie 认证）
   ┌────┴─────────┬──────────────┐
桌面 Tauri 壳   移动 Tauri 壳   浏览器/PWA
（Win/mac/Linux）（iOS/Android） （v1 先行验证）
```

**拓扑形态**（`deploy/` 各提供一套配置，网关一份代码通用）：
- **A. 公网入口**：Caddy + 网关在公网 VPS（自动证书），dsh Host 在开发机，WireGuard/frp 隧道回连。适合外网随时访问。
- **B. 单机内网**：Caddy + 网关 + Host 全在开发机，手机/其他设备通过 LAN 访问 `https://<开发机>`。TLS 用自有域名 + DNS-01 挑战（无需公网可达），或内网 CA/mkcert 手动信任。
- **C. 本机自用**：全部在本机，浏览器直连。Caddy 对 `localhost` 自动签发本地证书，或直接 HTTP 回环。

TLS 与 cookie 的联动：cookie 的 `Secure` 标志由网关按配置开关，HTTPS 部署必须开启；纯 HTTP 仅允许作为回环/可信内网的显式降配（默认关闭，启动日志警告）。

已否决的替代路线：
- **微信小程序**：移除（需企业主体+备案域名+协议子集原生实现，投入产出不成比例）。
- **Tailscale 作为唯一入口**：否决——设备需全部安装 Tailscale 客户端，浏览器/PWA 场景不友好；形态 A 的 VPS↔开发机回连可用 WireGuard。
- **Host 容器化**：否决——agent 需操作开发机真实环境，容器化弊大于利。

工作区 `dsh-app/` 布局：
```
dsh-app/
├── gateway/        # Node + fastify 网关：认证、Host/Origin 改写、WS 代理、登录页
├── app/          # Tauri 2 工程：同一套代码构建 Win/macOS/Linux + iOS/Android
├── deploy/         # 部署 runbook（进程清单/环境变量/启动顺序）+ Caddyfile、隧道配置样例；
│                   #   进程托管参考实现按需提供：systemd 单元 / launchd plist / pm2 配置
├── scripts/        # verify-upstream.sh：上游协议/栅栏行为回归验证（升级前必运行）
├── vendor/         # 上游浅克隆（pin 到同版本 tag，仅供阅读调试，不参与构建）
└── docs/           # 部署与使用文档
```

## 三、认证设计（已定案）

- **凭证模型**：一个静态长 token（≥128 bit 随机数），保存于网关环境变量/配置文件。自用场景不建立登录用户体系、不建立会话存储；泄露时更换 token 并重启网关。
- **出示方式**：浏览器/Tauri webview 里 SPA 无法附加 header/query（已核实），唯一载体是 cookie →
  - 网关自带最小登录页（`/login`，几十行静态 HTML）：粘贴 token → 校验 → `Set-Cookie(HttpOnly; Secure; SameSite=Lax)`，长效；
  - 之后所有 `/api` POST、两条 WS upgrade、静态文件请求均由浏览器自动携带 cookie，网关认证中间件统一校验；
  - 登录端点施加速率限制（防止暴力破解），认证失败日志脱敏。
- **不需要** WS query token（该机制原为小程序设计，已随小程序方案一并移除）。
- **特权方法不拦截**：Host 重写为回环后 `PRIVILEGED_METHODS` 远程全部可用，远程端因此拥有**完整功能**（设置/凭据/目录选择）。代价：token 即全权限，泄露 = 开发机控制权 + 凭据存储——自用场景接受，依靠 token 强度（≥128 bit 随机数）、HTTPS、登录限流作为防线。如需加固，网关保留按配置启用方法黑名单的扩展点（默认关闭）。

## 四、分阶段实施

**Phase 0 — 基线验证（前置，约半天）**
1. `git clone --depth 1 --branch <tag>` 上游到 `vendor/`；`pnpm install && pnpm run build` 验证可构建。
2. 本地启动 `dsh web`，以 DevTools 抓取报文，核对预期（预期值按第一节核实结论：单段点号路径、envelope、恒 200、WS 文本帧、SSE 回退存在）。
3. `curl` 验证栅栏：Host 改写、Origin 一致性、`Sec-Fetch-Site`、415 行为。
4. 产出 `scripts/verify-upstream.sh`：固化以上断言 + `PRIVILEGED_METHODS` 清单，供每次升级回归。

**Phase 1 — dsh-gateway + 部署（核心，优先实施）**
1. fastify 网关（`@fastify/websocket` 手动处理 upgrade）：
   - 认证中间件：cookie 校验，未认证 → 静态页/WS 一律 401（`/login` 与登录端点除外）；
   - 代理到上游（经隧道指向开发机 `dsh Host`），**重写 `Host: 127.0.0.1:3080`、剥离 Origin**（或改写为与 Host 一致）；
   - 全量反代（SPA 静态文件 + `/api` + 两条 WS + SSE 回退路径），WS 关闭 idle 超时、关闭 buffering，body 上限对齐 160 MiB；
   - 登录页 + 登录端点（速率限制）。
2. `deploy/`：按形态 A/B/C 各提供一套——Caddyfile（A：公网域名自动证书；B：DNS-01 或内网 CA；C：localhost 本地证书）+ **部署 runbook**（需常驻的进程清单、环境变量、启动顺序、健康检查；进程托管方式不限，附 systemd 单元与 launchd plist 两份参考实现，pm2/tmux/nohup 等参照 runbook 自行套用）。A 形态另含 WireGuard/frp 隧道配置样例。网关上游地址、cookie `Secure` 开关均通过配置实现。
3. 验收：浏览器经 `https://<域名>` 完整执行"登录 → 建 workspace → 开会话 → 执行一条 agent 消息"（流式事件正常下行）；无 cookie 一律 401；特权方法（如 `settings.describe`）远程可调用。

**Phase 2 — 桌面客户端（Tauri 2）**
1. `pnpm create tauri-app` 初始化 `app/`；窗口加载网关 URL（不做本地静态资源打包）。
2. 定位是**体验项**（独立窗口/托盘/自启），非技术必需——反代头改写全部在服务端，认证走 webview cookie。
3. 启动页仅配置服务器地址（store 插件持久化）；**不引入 keyring/stronghold**（token 由 webview cookie 持久化）。
4. 桌面体验：系统托盘、开机自启、单实例、`tauri-plugin-updater`。
5. GitHub Actions 矩阵构建 Win(msi)/macOS(dmg，签名可后续补充)/Linux(AppImage/deb)。
6. 验收：至少 Linux+macOS 实测连接服务器完成会话。

**Phase 2.5 — 移动 spike（go/no-go，约半天）**
- Tauri Android 壳加载网关 URL，验证：远程页面注入 CSS/JS 的可行性、虚拟键盘、安全区。
- 不可行或体验差 → Phase 3 降级为 PWA + **网关注入方案**（网关代理 HTML 时改写 `<head>` 插入移动补丁 CSS；该方案完全可行且桌面端与移动端均适用，即使 spike 通过也值得作为补丁分发的主渠道）。

**Phase 3 — 移动客户端（Tauri Mobile，视 spike 结果）**
1. 同一 `app/` 工程启用 iOS/Android target；布局补丁优先采用网关注入，壳内注入仅作补充。
2. Android 先构建 APK 实测；iOS 需开发者证书，延后实施。
3. 验收：Android 真机完成一次完整会话。

**贯穿项**
- **版本固定**：部署脚本使用 `npx @deepseek-ai/dsh@<已验证版本>`（不使用 `@latest`），`vendor/` 同步到同 tag；升级 = 修改版本号 + 运行 `verify-upstream.sh` + 人工执行一遍 Phase 1 验收。
- **安全红线**：网关是唯一认证层，Host 永不直接暴露（开发机侧也只监听回环，经隧道对网关开放）；token 即全权限，强度（≥128 bit 随机数）/HTTPS/登录限流是全部防线；日志脱敏。

## 五、风险与已知妥协
- 远程端**功能完整**（含设置/凭据/目录选择——网关不做特权方法拦截）；相应地 token 泄露后果为开发机控制权 + 凭据存储，自用场景接受。
- 单用户；多用户等上游认证/多租户，或 per-user 编排（本期不做）。
- 上游快速迭代 → 固定版本 + verify 脚本保障；协议变更时网关适配层集中修改。
- 移动端体验与桌面 Web UI 有差距；spike 不通过则移动端 = PWA。
- 形态 A 下 VPS 与开发机间隧道的可用性（开发机睡眠/换网）影响整体可达性——开发机睡眠时服务天然不可用，接受；形态 B/C 无此风险。

## 六、验证总表
| 阶段 | 验收 |
|---|---|
| 0 | 上游可构建可运行；栅栏行为（Host/Origin/Sec-Fetch-Site/415）与 RPC 格式断言固化进 verify 脚本 |
| 1 | 浏览器经域名完成登录+RPC+WS 全流程；无 cookie 一律 401；特权方法远程可调用 |
| 2 | 桌面三平台构建产物可安装可连接 |
| 2.5 | spike 有明确 go/no-go 结论并记录 |
| 3 | Android 真机会话通过（或按 spike 结论降级为 PWA 验收） |

## 七、部署形态选择
网关与客户端代码和拓扑无关，开工前只需在 `deploy/` 里选定形态：
- **A 公网入口**：需公网 VPS + 域名；适合外网随时访问。
- **B 单机内网**：需一个自有域名（DNS-01 签发证书，无需公网可达）或接受手动信任内网 CA；适合主要在家庭/公司内网用手机访问。
- **C 本机自用**：零外部依赖；适合仅在本机使用，网关价值主要是统一入口与认证演练。

三者不互斥，配置可并存；首期建议先做 C（验证链路最简单），再按需增加 A 或 B。
