# dsh-shell — Tauri 2 桌面壳（issue 07 MVP + 08 桌面体验项 + 09 出包/更新 + 12 移动端）

薄壳：窗口直接加载网关 URL，不打包业务静态资源。首次启动展示本地配置页，
保存服务器地址（`tauri-plugin-store` 持久化到 `settings.json`）后导航到网关；
登录在 webview 内完成，token 经网关登录页以 `HttpOnly; Secure; SameSite=Lax`
cookie 持久化——壳不保存 token，不引入 keyring/stronghold。

桌面体验项（issue 08）：系统托盘（显示/隐藏窗口、开机自启与关窗驻留开关、退出）、
单实例（重复启动聚焦已有窗口，不新开进程）、关窗默认驻留托盘（托盘可关，
关闭后关窗即退出进程）。开机自启首次启动默认开启，托盘勾选关闭后不再覆盖。

自动更新（issue 09）：`tauri-plugin-updater` + `tauri-plugin-dialog`。检查/确认/
下载/安装全在 Rust 侧完成（`src-tauri/src/updater.rs`）——主窗口加载的是远程网关
页，IPC 不暴露给远程页面，因此不走 webview 内 JS updater API。入口：启动时静默
检查（失败只打日志，不影响使用）+ 原生菜单/托盘菜单「检查更新…」（无更新/失败
均弹系统对话框）。Linux（AppImage 替换）与 macOS（app 替换）装完自动重启，
Windows 走 msi passive 安装器自行退出应用。

## 结构

- `src/` — 本地启动配置页（零构建：`index.html` / `main.js` / `styles.css`，
  经 `withGlobalTauri` 全局 API 调 Rust command；IPC 仅本地页面可用）。
- `src-tauri/` — Tauri 2 工程。
  - `src/lib.rs` — 窗口创建（已配置 → `WebviewUrl::External(网关)`，否则本地配置页）、
    `get_server_url` / `set_server_url` command、原生菜单「更改服务器地址」
    （回配置页改指向另一实例）、URL 校验（https 任意；http 仅回环，对应 RUNBOOK 降配形态）。
  - `src/updater.rs` — 更新检查/确认/下载/安装（issue 09，Rust 侧触发）。
  - `capabilities/default.json` — 桌面能力：`core:default` + `updater:default`
    （权限仅对本地页面生效；实际更新流程不经 JS API，权限为本地页直连预留）。
  - `capabilities/mobile.json` — 移动端能力：仅 `core:default`（issue 12）。
  - `tauri.conf.json` — `frontendDist: ../src`，窗口在代码中创建；
    `plugins.updater` 为占位配置（见下「自动更新占位」）。
  - `gen/android/` — Tauri Android 工程（issue 12，`tauri android init` 产物，
    **入库**：MainActivity 补丁等手改内容在 init 产物里，重新 init 不会保留）。

## 移动端（issue 12）

同一 `shell/` 工程开 Android target。桌面专属能力按平台门控（`#[cfg(desktop)]` +
Cargo.toml 按 target 门控依赖）：托盘/原生菜单（tray-icon crate 与 muda 无 Android
实现）、single-instance、autostart、updater（插件移动端官方支持 none）；移动端保留
启动配置页、网关加载、store 持久化、dialog。

原生补丁（`gen/android/app/src/main/java/.../MainActivity.kt`，来源 issue 10 spike）：

1. **safe-area 桥（S1）**：Android WebView < 140 的 `env(safe-area-inset-*)` 恒为 0
   （tauri#14240），原生读 systemBars + displayCutout，经 `evaluateJavascript` 写
   `--dsh-safe-{top,right,bottom,left}` CSS 变量；网关移动 CSS 补丁（issue 11）以
   `max(env(...), var(--dsh-safe-*))` 回退链消费。走 evaluateJavascript 而非插件
   JS API——主窗口是远程页，IPC 不对其开放。
2. **键盘 inset（K1/K2）**：manifest `android:windowSoftInputMode="adjustResize"`
   + MainActivity 把 IME inset 设为 WebView 底部 padding（edge-to-edge 下
   adjustResize 单独不生效，tauri#7868）；与网关补丁的
   `interactive-widget=resizes-content`（K3）配合。

### 构建 debug APK（Linux）

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

真机部署：`adb install -r <apk>`，首次启动在配置页填网关入口（形态 B
`https://dsh.home.example.com:8443` 或 DNS-01 域名），登录即建立 cookie 会话。

### iOS（工程配置待生成，出包需 macOS）

`tauri ios init` 在 Linux 上**不可用**：CLI 的 `Ios` 子命令为
`#[cfg(target_os = "macos")]`（tauri-cli `src/lib.rs`），且工程生成硬依赖 XcodeGen
（`xcodegen generate`，仅 macOS）。因此 `gen/apple/` 尚未生成，macOS 上的步骤：

```sh
rustup target add aarch64-apple-ios aarch64-apple-ios-sim
pnpm exec tauri ios init          # 生成 gen/apple/ Xcode 工程
pnpm exec tauri ios build         # 需 Xcode + Apple 开发者证书/签名
```

签名配置：`tauri.conf.json` `bundle.ios`（或 `TAURI_APPLE_DEVELOPMENT_TEAM` 等
环境变量，见 Tauri 文档 iOS 签名节）。iOS 侧同样需要 safe-area/键盘适配
（Android 的 MainActivity 桥为 Kotlin 实现，iOS 对应处在
`gen/apple/` 生成后的 Swift 侧，届时参照同一 spike 结论落地）。



## CI 出包（issue 09）

`.github/workflows/shell-release.yml`：矩阵构建三平台安装包，产物上传 workflow
artifacts；tag `v*` 构建同时附到 draft release（`contents: write`，人工核对后发布）。

| 平台 | runner | 产物 |
| --- | --- | --- |
| macOS | `macos-latest` | universal dmg（aarch64 + x86_64） |
| Linux | `ubuntu-22.04` | AppImage + deb |
| Windows | `windows-latest` | msi（x64） |

签名当前为占位（未签名构建）：真实密钥就绪后在 workflow 对应平台 job 注入签名
环境变量（注释中标了占位位置），并开启 `createUpdaterArtifacts` 产出 updater
签名产物（见下）。

## 自动更新占位（issue 09）

`tauri.conf.json` 的 `plugins.updater` 目前为占位配置，**不可直接用于生产**：

- `endpoints` — `https://updates.dsh.example.com/dsh-shell/{{target}}/{{arch}}/{{current_version}}`
  为占位域名。启用时改为真实更新源（静态 JSON 或 latest-release 接口），JSON 需含
  `version` / `notes` / `pub_date` / `platforms.{target}`（`signature` + `url`）。
- `pubkey` — `PLACEHOLDER-REPLACE-WITH-REAL-MINISIGN-PUBLIC-KEY` 为占位。生成密钥对：
  `pnpm exec tauri signer generate -w ~/.tauri/dsh-shell.key`（私钥入 CI secrets
  `TAURI_SIGNING_PRIVATE_KEY` / `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`，公钥替换占位）。
- `bundle.createUpdaterArtifacts` 当前 `false`。updater 产物要求 `min`：
  Windows 需 NSIS（`windows` bundle），macOS 需 dmg updater 产物与 aarch64 交叉
  编译——矩阵切到 NSIS + 开启 `createUpdaterArtifacts: true` 后即可产出。

占位 endpoint 下应用行为：启动时静默检查得到一次失败的 HTTP 请求（打日志），
菜单「检查更新…」弹「检查更新失败」——不影响其他功能。


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
