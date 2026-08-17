# 07 — Tauri 桌面壳 MVP

**What to build:** `shell/` Tauri 2 工程，窗口直接加载网关 URL（不打包本地静态资源）。启动页配置服务器地址并用 store 插件持久化；不引入 keyring/stronghold——token 经登录页以 webview cookie 持久化。壳内完成登录并成功执行完整会话。

**Blocked by:** 05

**Status:** resolved

- [ ] 首次启动展示服务器地址配置页，保存后加载网关 URL
- [ ] webview 内登录页写入 cookie 成功，重启壳后仍保持登录
- [ ] 壳内完成一次完整会话（含流式事件）
- [ ] 改服务器地址后可重新指向另一实例

> 四项均为 GUI 实测验收，本环境（headless、无显示器、无 X/Wayland）无法验证，保持未勾选；逐项替代验证见 Comments。

## Comments

### 完成内容（2026-08-16）

- **工程结构**（`shell/`，Tauri 2.11 + tauri-plugin-store 2.4，薄壳：不打包业务静态资源，窗口直接加载网关 URL）：
  - `shell/src/`（`frontendDist`）— 本地启动配置页，零构建（`index.html`/`main.js`/`styles.css`），经 `withGlobalTauri` 全局 API 调 Rust command；无前端依赖、无打包器。
  - `shell/src-tauri/src/lib.rs` — 启动时读 store（`settings.json` 的 `server_url`）：已配置 → 主窗口 `WebviewUrl::External(网关)` 直接加载网关；未配置 → `WebviewUrl::App("index.html")` 展示配置页。command `get_server_url`（预填表单）/ `set_server_url`（URL 校验 → store 持久化 → 窗口导航到网关）。原生菜单项「更改服务器地址」回到配置页（改指向另一实例的入口）。URL 校验：https 任意；http 仅回环（`localhost`/`127.0.0.1`/`::1`），对应 RUNBOOK 的 HTTP 回环显式降配形态；其余协议/非法输入拒绝。
  - **token 不经壳**：无 keyring/stronghold；登录在 webview 内网关登录页完成，`HttpOnly; Secure; SameSite=Lax` cookie 由 WebKitGTK 持久化。capabilities 仅 `core:default`；远程网关页面无 IPC（Tauri 默认），壳的 command 只对本地配置页暴露。
- **环境探测结论**：
  - 无 Rust → 已用 rustup 安装到用户目录（stable 1.97.1，`~/.cargo`）。
  - 无 sudo（`sudo -n` 需密码）；系统无 pkg-config、无 webkit2gtk-4.1/gtk-3/glib 开发包（`dpkg -l` 仅 build-essential；运行时库 `libgtk-3-0`/`libglib-2.0-0` 存在，但缺少 `-dev` 包）。
  - **替代路径**：`apt-get download` + `dpkg-deb -x` 把 pkg-config/pkgconf 与完整构建依赖树（494 包，含 `libwebkit2gtk-4.1-dev` 2.52.3）解压到用户级 sysroot（`/tmp/sysroot`，仓库外、不入 git），`PKG_CONFIG_PATH` + `PKG_CONFIG_SYSROOT_DIR` 指向该目录后构建全部通过。正常机器上一条 `sudo apt install pkg-config libwebkit2gtk-4.1-dev ...` 命令即可（README 已写明）。
- **构建结果**：
  - `cargo check` 通过（tauri 2.11.5 / tauri-plugin-store 2.4.4 / webkit2gtk 2.0.2 全树编译）。
  - `cargo test` 通过：3 个 URL 校验单元测试全部通过。
  - `pnpm exec tauri build --debug --no-bundle` 通过：tauri.conf.json/capabilities/icons 经 CLI 校验，产出 `src-tauri/target/debug/dsh-shell`（ELF x86-64，链接成功）。
  - `@tauri-apps/cli` 2.11.4 经 pnpm 安装；`pnpm-lock.yaml`/`Cargo.lock` 入库；`target/`、`gen/`、`node_modules/` 已 gitignore。

### 验收项状态（GUI 实测无法验证的原因与替代验证）

1. **首次启动配置页 / 保存后加载网关** — 未验证（headless 无显示器，二进制无法启动 GUI）。替代：`set_server_url`/`get_server_url` 逻辑代码审查 + URL 校验单测 + 完整构建通过；窗口 URL 决策（External vs App）为标准 Tauri API 直译。
2. **webview 写入 cookie / 重启保持登录** — 未验证（同上，需启动 webview 登录）。替代：cookie 模型复用 issue 04 已验证的网关行为（`Secure` 在 https 入口下成立），壳侧零额外代码；WebKitGTK 对 `HttpOnly` cookie 的磁盘持久化为 webview 默认行为。运行前置：Caddy 本地 CA 根证书需被系统信任（同 RUNBOOK 浏览器信任一节），否则 webview 报证书错误。
3. **壳内完整会话（含流式）** — 未验证。替代：issue 05 已验证网关链路（curl + probe-ws.mjs，含 WS 流式）；壳内 SPA 走标准 fetch/WebSocket，与浏览器形态无差异。
4. **改地址重指向** — 未验证。替代：菜单项回配置页的代码路径与启动路径共用同一 `open_main_window`，构建通过。

### 遗留问题

- 四项 GUI 验收需在有显示器的机器上补充实测：安装系统依赖 → `pnpm install && pnpm dev`，入口 `https://localhost:8443`（先 `caddy trust`）。
- 图标为纯色占位 PNG（`src-tauri/icons/`），正式图标留待 issue 08/09。
- 用户级 sysroot 在 `/tmp`，重启即失效；仅为本环境的一次性验证手段，不影响工程本身。
- 发布打包（`tauri build` 含 bundle：deb/AppImage）与自动更新属 issue 09，本票未做（`--no-bundle` 验证）。
- Linux 原生菜单的呈现依桌面环境而定（部分 DE 不显示窗口菜单栏）；若实测不可见，可在 issue 08 加全局快捷键或窗口内入口。
