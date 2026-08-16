# dsh-shell — Tauri 2 桌面壳（issue 07 MVP）

薄壳：窗口直接加载网关 URL，不打包业务静态资源。首次启动展示本地配置页，
保存服务器地址（`tauri-plugin-store` 持久化到 `settings.json`）后导航到网关；
登录在 webview 内完成，token 经网关登录页以 `HttpOnly; Secure; SameSite=Lax`
cookie 持久化——壳不保存 token，不引入 keyring/stronghold。

## 结构

- `src/` — 本地启动配置页（零构建：`index.html` / `main.js` / `styles.css`，
  经 `withGlobalTauri` 全局 API 调 Rust command；IPC 仅本地页面可用）。
- `src-tauri/` — Tauri 2 工程。
  - `src/lib.rs` — 窗口创建（已配置 → `WebviewUrl::External(网关)`，否则本地配置页）、
    `get_server_url` / `set_server_url` command、原生菜单「更改服务器地址」
    （回配置页改指向另一实例）、URL 校验（https 任意；http 仅回环，对应 RUNBOOK 降配形态）。
  - `capabilities/default.json` — 仅 `core:default`。
  - `tauri.conf.json` — `frontendDist: ../src`，窗口在代码中创建。

## 构建依赖（Linux）

Rust stable + 系统库（Tauri 2 / WebKitGTK 4.1）：

```sh
sudo apt install pkg-config libwebkit2gtk-4.1-dev libgtk-3-dev libglib2.0-dev \
  libsoup-3.0-dev libjavascriptcoregtk-4.1-dev libssl-dev
pnpm install
pnpm build   # 或 pnpm dev
```

## 运行形态

入口默认 `https://localhost:8443`（形态 C，见 `deploy/RUNBOOK.md`）。
Caddy 本地 CA 根证书需被系统信任（`caddy trust` 或手动导入，同浏览器），
否则 webview 会报证书错误——与 RUNBOOK「浏览器信任」一节同一前置。
