# 09 — 桌面 CI 出包与自动更新

**What to build:** GitHub Actions 矩阵构建三平台产物（Win msi / macOS dmg，签名可后补 / Linux AppImage+deb），接入 `tauri-plugin-updater` 自动更新。

**Blocked by:** 07

**Status:** resolved

- [ ] CI 矩阵产出三平台安装包
- [ ] 产物安装后可连服务器跑通会话（至少 Linux+macOS 实测）
- [ ] updater 检测到新版本可完成升级

> 三项均需 GitHub Actions 运行器与真机安装实测，本环境（headless、无 GitHub Actions 运行器、无 macOS/Windows 机器、无真实签名密钥与发布域名）无法验证，保持未勾选；替代验证（actionlint 静态校验 + 本机构建）与启用路径见 Comments。

## Comments

### 完成内容（2026-08-16）

- **CI workflow**（`.github/workflows/shell-release.yml`）：
  - 矩阵三平台：macOS `macos-latest`（`--target universal-apple-darwin`，单个 dmg 覆盖 Apple Silicon + Intel，rust-toolchain 加装双 target）/ Linux `ubuntu-22.04`（`--bundles appimage,deb`，按 Tauri 2 官方依赖清单装 WebKitGTK 4.1 + libayatana-appindicator3 + librsvg 等）/ Windows `windows-latest`（`--bundles msi`）。
  - 触发：push tag `v*` 与 `workflow_dispatch`。产物先 `upload-artifact`（`if-no-files-found: error` 兜底产物缺失）；tag 构建再经 `softprops/action-gh-release@v2` 附到 **draft release**（`permissions: contents: write`），人工核对后发布。
  - 产物路径用 `target/**/bundle/**` 通配同时覆盖 host 构建（`target/release/bundle`）与带 `--target` 构建（`target/<target>/release/bundle`）。
  - 签名占位：当前产出未签名构建（macOS 未公证 / Windows msi 未签名 / Linux 无签名要求）；workflow 内注释标明真实密钥就绪后的注入位置（macOS `APPLE_CERTIFICATE` 等、Windows `WINDOWS_CERTIFICATE` 等）。
- **updater 接入**（架构遵循 07 约定：主窗口加载远程网关页，IPC 不暴露给远程页面）：
  - 插件：`tauri-plugin-updater` 2.10.1 + `tauri-plugin-dialog` 2.7.2（后者用于系统对话框——远程页内不能弹 webview UI）。
  - **检查逻辑全在 Rust 侧**（`shell/src-tauri/src/updater.rs`），不走 webview 内 JS updater API：`check_for_updates(handle, interactive)` 在 tauri async runtime 里 `updater_builder().build()?.check()`；发现新版本 → 系统确认框（版本/当前版本/notes，「安装/暂不」）→ `download_and_install` → Linux/macOS `app.restart()`，Windows msi passive 安装器自行退出应用。
  - 触发入口：① 原生菜单与托盘菜单新增「检查更新…」（interactive=true：无更新/失败均弹框反馈）；② 启动时 setup 末尾静默检查（interactive=false：失败只 `eprintln!` 打日志，不打扰启动）。
  - capabilities：`default.json` 加 `updater:default`（远程页无 IPC，权限实际只对本地配置页生效；当前更新流程不经 JS API，权限为本地页后续直连预留）。
  - 占位配置（`tauri.conf.json` `plugins.updater`，`shell/README.md`「自动更新占位」一节有启用步骤）：`endpoints` = `https://updates.dsh.example.com/...` 占位域名；`pubkey` = `PLACEHOLDER-...` 占位（启用时 `tauri signer generate` 生成密钥对，私钥入 CI secrets，公钥替换占位）；`bundle.createUpdaterArtifacts: false`（updater 产物要求 Windows NSIS + `min`，启用签名时一并切）。
- **静态校验与构建证据**（rustup stable 1.97.1 + `/tmp/sysroot` 用户级 sysroot，同 issue 07/08）：
  - `actionlint` 1.7.12（用户级装到 `/tmp/actionlint-bin`，shellcheck 本机不可用故跳过该项）静态校验 workflow 通过，无告警。
  - `cargo check` 通过（tauri-plugin-updater/dialog 全树编译，tauri-build 同步校验了 capabilities 权限标识与 `plugins.updater` 配置 schema）。
  - `cargo test` 通过：5 个既有单测全绿（本票未新增可单测纯函数——更新流程依赖网络/GUI）。
  - `pnpm exec tauri build --debug --no-bundle` 通过：CLI 校验 tauri.conf.json/capabilities，产出 `src-tauri/target/debug/dsh-shell`（ELF x86-64，链接成功，含 updater/dialog 插件）。

### 验收项状态（未勾原因与替代验证）

1. **CI 矩阵产出三平台安装包** — 未验证：本机无 GitHub Actions 运行器，且仓库未配 remote（workflow 无处触发）。替代：actionlint 静态校验通过；矩阵三平台命令/依赖为 Tauri 2 官方文档标准组合；Linux 侧构建链（WebKitGTK 4.1 + appindicator + librsvg）已在 issue 07/08 本机验证同源依赖树可编译链接。
2. **产物安装后可连服务器跑通会话** — 未验证：需真实安装包 + 有显示器的机器实测（Linux+macOS 至少）。替代：壳连网关链路在 issue 05/07 已分别从网关侧（curl + probe-ws.mjs 含 WS 流式）与壳侧（构建 + 代码审查）验证，本票未改动窗口加载与登录路径。
3. **updater 检测到新版本可完成升级** — 未验证：需真实签名密钥 + 更新源 + 两次版本发布实测（占位 pubkey 下签名校验必失败，属预期）。替代：检查/确认/下载/安装代码路径为插件官方 API 直译并全部编译链接通过；占位 endpoint 的失败路径行为已文档化（启动静默检查仅打日志、菜单检查弹失败框，不影响其他功能）。

### 遗留问题

- 首次真实出包需：仓库配 remote → push tag `v*` → 核对 draft release 三平台产物。
- 签名与 updater 产物启用清单（README「自动更新占位」已写全）：生成 minisign 密钥对、私钥入 CI secrets、公钥替换占位、Windows 切 NSIS、`createUpdaterArtifacts: true`、endpoints 换真实更新源（静态 JSON 或 latest-release 接口）。
- CI 出包的正式图标仍用 issue 07 的纯色占位 PNG（dmg/msi 会内嵌该图标）。
