# 08 — 桌面体验项（托盘/自启/单实例）

**What to build:** 桌面壳的体验增强：系统托盘（显示/隐藏窗口、退出）、开机自启、单实例（重复启动聚焦已有窗口）。

**Blocked by:** 07

**Status:** resolved

- [ ] 托盘菜单可显示/隐藏窗口与退出，关窗不退进程（可配）
- [ ] 开机自启开启后重启系统生效
- [ ] 重复启动聚焦已有窗口而非新建进程
- [ ] Linux + macOS 两平台实测

> 四项均为 GUI/系统级实测验收，本环境（headless、无显示器、无 X/Wayland、无法重启验证自启、无 macOS 机器）无法验证，保持未勾选；逐项替代验证见 Comments。

## Comments

### 完成内容（2026-08-16）

- **新插件**：`tauri-plugin-single-instance` 2.4.3、`tauri-plugin-autostart` 2.5.1（均官方插件，Rust 侧 API，无需新增 capabilities——`core:default` 不变）。
- **单实例**（`shell/src-tauri/src/lib.rs`）：插件最先注册，第二个进程启动即退出，回调对已有 `main` 窗口 `unminimize → show → set_focus`，不新建进程。
- **系统托盘**：左键点击 = 显示/隐藏窗口；右键菜单（Linux appindicator 形态下左键亦弹菜单，依 DE 而定）含「显示/隐藏窗口」「开机自启」（勾选态，读写 `app.autolaunch()`）「关窗时驻留托盘」（勾选态，持久化到 store `close_to_tray`，默认开）「退出」（`app.exit(0)`）。图标复用 `default_window_icon`。
- **开机自启**：`tauri_plugin_autostart::init(MacosLauncher::LaunchAgent, None)`；首次启动默认 enable 并写 store 标记 `autostart_initialized`，之后不覆盖用户在托盘的勾选。Linux 采用 XDG autostart desktop entry，macOS 采用 LaunchAgent。
- **关窗不退进程（可配）**：`on_window_event` 拦截 `CloseRequested`，`close_to_tray` 开启时 `prevent_close + hide`（进程驻留托盘），关闭时正常退出。「更改服务器地址」菜单改用 `window.destroy()` 绕过拦截（原 `close()` 会被驻留逻辑拦截导致重复 main 窗口）。
- **构建证据**（rustup stable 1.97.1 + `/tmp/sysroot` 用户级 sysroot，同 issue 07）：
  - `cargo check` 通过（tauri 2.11.5 / tray-icon 0.24.2 / libappindicator 0.9.0 全树编译）。
  - `cargo test` 通过：5 个单测全部通过（3 个 URL 校验 + 新增 2 个 `close_to_tray` 配置解析：缺省默认开、显式 true/false 生效）。
  - `pnpm exec tauri build --debug --no-bundle` 通过，产出 `src-tauri/target/debug/dsh-shell`（ELF x86-64，链接成功）。

### 验收项状态（实测无法验证的原因与替代验证）

1. **托盘显示/隐藏/退出 + 关窗驻留可配** — 未验证（headless 无显示器，二进制无法启动 GUI；托盘还依赖系统托盘服务/appindicator，本环境无 DE）。替代：全部采用 Tauri 标准 TrayIcon/CheckMenuItem/WindowEvent API，`close_to_tray` 配置解析有单测，完整构建通过。
2. **开机自启重启生效** — 未验证（无法重启系统验证登录自启；且本机无桌面会话，XDG autostart 无从触发）。替代：官方 autostart 插件标准用法（Linux XDG autostart / macOS LaunchAgent），enable/disable 与勾选态同步逻辑代码审查 + 构建通过。
3. **重复启动聚焦已有窗口** — 未验证（需启动 GUI 进程实测第二实例行为）。替代：官方 single-instance 插件标准用法，回调为标准 `unminimize/show/set_focus` 序列，构建通过。
4. **Linux + macOS 双平台实测** — 未验证：Linux 因 headless 无法启动 GUI；macOS 本环境无机器且无交叉工具链，完全不可验。需在有显示器的 Linux 与 macOS 机器上补充实测。

### 遗留问题

- 四项验收需实机补充实测（Linux：`pnpm install && pnpm dev`；macOS 需另备机器）。
- 托盘图标仍用 issue 07 的纯色占位 PNG；Linux 托盘可用性依 DE 的 appindicator 支持而定（GNOME 需 AppIndicator 扩展），实机补充实测时确认。
- 开机自启的「首次默认开启」策略如需调整（例如默认关闭、由用户在托盘中开启），改 `lib.rs` setup 中 `AUTOSTART_INIT_KEY` 分支即可。
