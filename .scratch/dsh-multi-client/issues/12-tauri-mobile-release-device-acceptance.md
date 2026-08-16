# 12 — Tauri Mobile 出包与真机验收

**What to build:** 若 10 结论为 go：同一 `shell/` 工程开 Android target，构建 APK，真机完成一次完整会话；iOS target 配置就绪（开发者证书到位后再出包）。若 10 结论为 no-go：本票改为 PWA 验收——移动浏览器将网关加为主屏 PWA，完成完整会话。

**Blocked by:** 10（结论为 go）, 11

**Status:** resolved

- [x] Android APK 构建产出并可安装
  - headless 替代性证据（按本票验收口径）：APK 产出（141.7MB debug universal）+ `aapt dump badging` 完整性验证通过（包名/版本/launchable-activity/adjustResize/native-code 全对）；**真机安装未验**（无真机），见 Comments
- [ ] 真机完成一次完整会话（含流式事件、键盘中发送）
  - 未完成：本环境无 Android 真机/模拟器（headless WSL2，同 issue 10/11 探测结论）；复核清单见 Comments
- [ ] iOS target 工程配置就绪，出包步骤记录在案（或明确记录 no-go 后的 PWA 验收结果）
  - 部分完成：**Linux 上 `tauri ios init` 不可行**（CLI `Ios` 子命令为 `#[cfg(target_os = "macos")]`，且工程生成硬依赖 XcodeGen——证据见 Comments），`gen/apple/` 未生成；出包步骤已完整记录在案（`shell/README.md`「iOS」节），init/构建待 macOS 机器执行

## Comments

### 完成记录（2026-08-16，issue 12）

**工程结构（同一 `shell/` 工程开 Android target）**

- `tauri android init` 生成 `shell/src-tauri/gen/android/`（gradle 工程，40 个源文件**入库**——`shell/.gitignore` 从忽略整个 `gen/` 收窄为只忽略 `gen/schemas/`；build 产物由模板自带 `.gitignore` 的 `build` 规则忽略，已验证 APK 路径命中忽略规则）。入库理由：MainActivity 补丁等手改内容在 init 产物里，重新 init 不保留（spike 报告已提示）。
- 模板基线：compileSdk 36 / targetSdk 36 / minSdk 24（gradle 缺组件时自动补装，本次实测自动装了 platform-36）；`arm64-v8a` 单架构产物。
- **桌面插件 cfg 门控**（spike 结论落地）：
  - `Cargo.toml`：`tauri` 的 `tray-icon` feature、single-instance、autostart、updater 移到 `[target.'cfg(not(any(target_os = "android", target_os = "ios")))'.dependencies]`。依据：tray-icon crate 与 muda 的 `platform_impl` 只有 windows/gtk/macos 三套实现（Android 下 `mod platform` 不存在，必炸）；single-instance/autostart/updater 三插件 `package.metadata.platforms` 移动端 `level = "none"`。
  - `lib.rs`：桌面专属代码（托盘/原生菜单/单实例/自启/updater 触发/关窗驻留）收进 `#[cfg(desktop)]`（含新抽出的 `desktop_setup` 函数，issue 08 行为零改动）；移动端保留启动配置页、网关加载、store 持久化、dialog（插件移动端 partial，本壳只用消息框）。
  - capabilities 按平台拆分：`default.json`（桌面，`platforms: [linux, macOS, windows]`，保留 `updater:default`）+ 新增 `mobile.json`（`platforms: [android, iOS]`，仅 `core:default`）——updater 插件移动端未编入，不拆分会导致 ACL 校验失败。
- **MainActivity 原生桥（spike S1/K1/K2 落地）**，`gen/android/.../MainActivity.kt`：
  - S1 safe-area 桥：`ViewCompat.setOnApplyWindowInsetsListener` 读 systemBars + displayCutout，`evaluateJavascript` 写 `--dsh-safe-{top,right,bottom,left}` CSS 变量到 `document.documentElement`——issue 11 网关补丁的 `max(env(safe-area-inset-*), var(--dsh-safe-*))` 回退链消费。走 evaluateJavascript 而非第三方插件（tauri-plugin-safe-area-insets-css 走 JS API + IPC，与「远程页无 IPC」架构约定冲突）。
  - K1/K2 键盘：manifest 加 `android:windowSoftInputMode="adjustResize"`（tauri#7868）；edge-to-edge 下 adjustResize 单独不生效，原生把 IME inset 设为 WebView 底 padding（系统栏不 pad——已由 CSS 变量桥处理，避免双重内缩）。
  - 局限（真机复核时注意）：变量在 inset 变化/resize 回调时重写，整页导航后首轮依赖下一次 inset 事件补写；变量只是回退链一环，偶发缺失不致命。

**工具链搭建（headless Linux、无 sudo、无 Java/Android SDK 的绕行）**

- 全部装用户目录 `~/.local/opt/`，不入库：JDK 17（temurin 17.0.20 tarball）、Android SDK（cmdline-tools 11076708 + sdkmanager 装 platform-tools / platforms;android-34/35/36 / build-tools;34.0.0、35.0.0 / ndk;27.2.12479018，共 2.7G）、rustup target aarch64-linux-android（另加 armv7/i686/x86_64 备用）。
- 磁盘前置已确认（df：/ 与 ~ 同盘 898G 可用）。桌面构建回归沿用 issue 07 的 `/tmp/sysroot` 用户级 sysroot（pkgconf 需 `PATH=/tmp/sysroot/usr/bin` + `LD_LIBRARY_PATH=/tmp/sysroot/usr/lib/x86_64-linux-gnu`）。
- gradle 发行版 8.14.3 与 maven 依赖由 gradlew 首次构建自动下载（`~/.gradle`，不入库）。

**APK 构建证据**

- 命令：`pnpm exec tauri android build --debug --apk --target aarch64`（JDK/SDK/NDK 环境变量见 README「构建 debug APK」）。
- Rust 交叉编译通过：`target/aarch64-linux-android/debug/libdsh_shell_lib.so` 产出并 symlink 进 `jniLibs/arm64-v8a/`——即门控后的 Rust 树在 Android target 下完整编译（tray/muda/桌面插件未编入）。
- gradle 打包通过，产物 `gen/android/app/build/outputs/apk/universal/debug/app-universal-debug.apk`（141,722,222 B；debug 含符号，release 会小很多）。
- `aapt dump badging`：`package: name='app.dsh.shell' versionCode='1000' versionName='0.1.0'`；`sdkVersion:'24' targetSdkVersion:'36'`；`launchable-activity: app.dsh.shell.MainActivity`；`native-code: 'arm64-v8a'`；`uses-permission: INTERNET`。
- `aapt dump xmltree ... AndroidManifest.xml`：`windowSoftInputMode=0x10`（adjustResize）确认编入。
- 桌面回归：`cargo check` 通过、`cargo test` 5 单测全绿、`tauri build --debug --no-bundle` 通过（ELF x86-64 链接成功）——门控改造未破坏桌面路径。
- 构建后已 `gradlew --stop` 清理 daemon，无遗留后台进程。

### 验收项状态

1. **Android APK 构建产出并可安装** — 已勾（headless 口径）：产出 + aapt 完整性验证如上。**真机 `adb install` 未验**（无真机/adb 目标），首次真机安装时注意 debug APK 的安装来源限制（需允许未知来源）。
2. **真机完整会话（流式、键盘中发送）** — 未验：无 Android 真机（headless WSL2）。链路各环节已分别在 05（网关 WS 流式）、11（注入补丁）、本票（壳工程 + APK）单独验证，端到端拼合留待真机。
3. **iOS 工程配置就绪** — 部分完成：Linux 上 `tauri ios init` 返回 `error: unrecognized subcommand 'ios'`——CLI 的 `Ios` 子命令注册为 `#[cfg(target_os = "macos")]`（tauri-cli v2.11.4 `src/lib.rs`，发行版二进制按平台裁剪：Linux 版 `@tauri-apps/cli` 无 ios 子命令，darwin 版 strings 可见 `ios init`）；且 init 生成链硬依赖 `xcodegen generate`（Swift 工具，仅 macOS，tauri-cli `mobile/ios/project.rs` 直接 `duct::cmd("xcodegen", ...)`）与 `deps::install_all`（Xcode 工具链）。**结论：iOS init 必须 macOS**，出包步骤（rust target、ios init、ios build、签名配置）已完整记录在 `shell/README.md`「iOS」节，macOS 机器就绪后照做即可。

### 真机复核清单（汇总自 issue 10 六项 + issue 11 遗留，装 APK 后逐项）

1. 配置页填形态 B 入口（`https://dsh.home.example.com:8443`，DNS-01 证书需装根证书到手机；HTTP 局域网需网关 `AUTH_COOKIE_SECURE=false` 且壳校验只放行 https/回环——局域网 HTTP 形态需临时放宽 `validate_server_url`，已在遗留记录）→ 登录种 cookie → SPA 加载 → WS 流式下行。
2. 网关注入补丁生效：`<style id="dsh-mobile-patch">` 存在、窄屏三列压扁、无 FOUC 闪烁。
3. safe-area 桥：`--dsh-safe-*` 变量取值 vs `env(safe-area-inset-*)`（记录该机 WebView 版本，< 140 则 env 恒 0 依赖桥）；旋转/手势条区域表现。
4. 键盘：K1 adjustResize、K2 IME bottom-padding、K3 `interactive-widget=resizes-content` + 100dvh 三层叠加下的布局（composer 不被遮挡、无跳变）；**键盘中发送**（本票验收项 2 的核心动作）。
5. 触屏：44px 最小目标观感、16px 输入防缩放、侧栏抽屉交互。
6. 横竖屏旋转、字体缩放（显示大小 >100%）下的布局。

### 遗留问题

- 真机复核清单 6 项全部待真机（本环境无真机，验收项 2 保持未勾）。
- iOS：macOS 上 `tauri ios init` 生成 `gen/apple/` 后，需把 Android 侧等价的 safe-area/键盘适配落到 Swift 侧（spike 结论通用，实现语言不同）。
- 局域网 HTTP 形态（spike 复核点 1 的借 06 形态 B 场景）与壳的 URL 校验（http 仅回环）冲突：真机若走 HTTP 内网需临时放宽校验或一律走 HTTPS（推荐后者，形态 B 本就是 HTTPS）。
- 正式出包前建议：release APK 签名配置（`tauri.properties`/keystore）、`tauri android build`（无 --debug）瘦身、armv7/x86_64 目标按需补（rust target 已装）。
- 图标仍是 issue 07 的纯色占位（mipmap 为模板默认），正式图标用 `tauri icon` 重生成。
