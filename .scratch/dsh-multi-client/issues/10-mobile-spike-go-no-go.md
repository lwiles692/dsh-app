# 10 — 移动端 spike（go/no-go）

**What to build:** 半天的技术验证：Tauri Android 壳在真机上加载网关 URL（真机需局域网可达，可借用 06 的形态 B 配置），验证三项内容——对远程加载页面注入 CSS/JS 的可行性与程度、虚拟键盘行为、安全区适配。产出书面 go/no-go 结论与 CSS 缺口清单初稿，决定 12 的形态。

**Blocked by:** 05

**Status:** resolved

- [ ] Android 真机上壳加载网关并登录成功
  - 未完成：本环境无 Android 真机/SDK/模拟器（headless WSL2），保持未勾；转为 issue 12 的真机复核点，见 Comments
- [x] 远程页面注入补丁的能力边界有明确结论（能/不能/部分）
  - 结论：**能**（边界明确），依据为 wry 源码 + 官方文档调研而非真机实测，见 Comments「注入能力边界」
- [x] 键盘与安全区问题清单记录
  - 清单基于文档/已知 issue 调研记录（tauri#7868、tauri#14240 等），真机实测项待复核，见 Comments「键盘与安全区清单」
- [x] go/no-go 结论写入票内（go → 12 做 Tauri Mobile；no-go → 12 改 PWA 验收）
  - 结论：**go（有条件）**，置信度中-高；条件与真机复核点见 Comments

## Comments

### Spike 报告（2026-08-16）

**环境探测（如实记录）**：本机为 headless Linux 开发机（WSL2，Ubuntu 24.04）。`which adb sdkmanager avdmanager emulator java` 全部未找到，`~/Android` 不存在，`ANDROID_HOME`/`ANDROID_SDK_ROOT` 未设置。**无 Android 真机、SDK、模拟器可用，真机实测项全部无法执行**。以下 go/no-go 判断基于 Tauri 官方文档、tauri/wry 源码与已知 issue 的调研，**非真机实测**；置信度与复核点如实标注。

### 调研发现（附来源）

1. **Tauri Android 壳加载远程 URL —— 官方支持**。
   - `frontendDist` 可直接填远程 URL："An external URL that should be used as the default application URL. No assets are embedded in the app in this case."（[Tauri v2 config reference](https://v2.tauri.app/reference/config/#frontenddist)）；代码侧即 `WebviewUrl::External`。
   - 远程页面要用 Tauri IPC 需在 capabilities 里配 `remote.urls`（同文档 CapabilityRemote 节）；**本场景壳只是加载器，不需要 IPC**，无此复杂度。
   - Cookie 认证：页面直接以 https/https-origin 加载在 WebView 主 frame，网关的 `HttpOnly; SameSite=Lax` cookie 属第一方，Android WebView CookieManager 正常处理，无跨站问题。**但注意**：`Secure` cookie 要求 https；真机走局域网 HTTP（借用 06 形态 B）时需 `AUTH_COOKIE_SECURE=false` 降配，与 05 的降配说明一致。

2. **对远程页面的 JS/CSS 注入 —— 能，机制与边界均从 wry 源码确认**（wry dev 分支 `src/android/kotlin/RustWebView.kt`、`RustWebViewClient.kt`）：
   - **document-start 注入**：若设备 WebView 支持 AndroidX WebKit `DOCUMENT_START_SCRIPT` feature，wry 调 `WebViewCompat.addDocumentStartJavaScript(this, script, setOf("*"))`——**允许源为 `"*"`，即对远程 URL 同样生效**，document-start 时机注入。
   - **回退路径**：不支持该 feature 时，远程 URL（未被自定义协议拦截，`interceptedState[url] == false`）在 `onPageStarted` 回调里 `evaluateJavascript(initScript)`——**同样覆盖远程页面**，时机略晚（页面已开始加载，可能有短暂未补丁闪烁/FOUC）。
   - **运行时注入**：`Webview.evaluate_javascript`（底层即 WebView `evaluateJavascript`）是 native API，**无同源限制**，对任意已加载远程页面可执行；配合 `on_page_load`（`onPageFinished`）钩子可在每次导航后重注入。CSS 补丁即通过 JS 插入 `<style>` 元素实现。
   - **边界**：
     a. 注入时机分两档（document-start 视 WebView 版本；回退为 onPageStarted），首屏可能有极短未补丁帧——CSS 补丁可接受，关键 JS 行为补丁需注意时序；
     b. 注入发生在每次主 frame 导航；SPA 内路由切换不触发重注入（需补丁脚本自驻留），整页跳转会重新注入（onPageStarted 路径自动）；
     c. **子 frame（iframe）不注入**（wry [#1313](https://github.com/tauri-apps/wry/issues/1313)），主 frame 注入不受影响；
     d. 注入的 inline `<style>`/`script` 受页面自身 CSP 约束——网关是我们自己的，CSP 可控，不构成障碍，但 issue 11 设计注入通道时要把 CSP 头纳入考量；
     e. 远端页面更新导致 DOM 结构变化时补丁可能失效（注入式方案的固有风险，与 PWA 方案相比此处是补丁层的共性风险）。

3. **虚拟键盘 —— 存在已知问题，已有成熟解法**。
   - tauri [#7868](https://github.com/tauri-apps/tauri/issues/7868)：Android 键盘遮挡/推挤行为在多次启动间不一致；解决方案为 manifest 设 `android:windowSoftInputMode="adjustResize"`。
   - Android 15+（edge-to-edge 默认，Tauri 模板调 `enableEdgeToEdge()`）下 **adjustResize 单独不生效**：需在 `MainActivity` 里 `ViewCompat.setOnApplyWindowInsetsListener` 消费 IME inset 作为 WebView bottom padding，前端配合 `visualViewport` 重排。有同类型（终端/xterm）Tauri Android 应用的完整补丁实例可参考（catgo-LRG 的 `MainActivity.kt` 原生补丁，[源码](https://github.com/Hello-QM/catgo-LRG/blob/main/deploy/android/README.md)）。**这类 MainActivity 补丁在每次 `tauri android init` 后需重新应用**（gen/ 目录重新生成）。
   - 对 dsh 的影响：输入框在底部，键盘行为是核心体验，此补丁为 12 的必做项，但方案已有公开先例验证可行。

4. **安全区 —— env() 在 Android WebView 不可靠，需原生桥**。
   - tauri [#14240](https://github.com/tauri-apps/tauri/issues/14240)（2025-10）：`env(safe-area-inset-*)` 在 Android WebView 中恒为 0，是 Chromium bug，直到 WebView 140.0.7339.51 才修复；API 36（Android 16）edge-to-edge 默认开启使问题显性化。
   - 成熟解法：原生侧读 `WindowInsets`（系统栏 + display cutout）通过桥写入 CSS 变量——现有插件 [tauri-plugin-safe-area-insets-css](https://github.com/saurL/tauri-plugin-safe-area-insets-css)，或自建 MainActivity 桥（jellytau `WindowInsetsBridge.kt`、Cyberia 均为此模式）。CSS 侧用 `env(safe-area-inset-bottom, var(--safe-bottom, 0px))` 式回退链。
   - 前置：viewport meta 需 `viewport-fit=cover`（dsh web UI 是我们自己的，可直接改；若走注入补丁通道则由补丁注入）。

5. **Tauri Mobile 成熟度**：Tauri 2 稳定版（2024-10 起）正式支持 Android/iOS，官方文档有完整 mobile 开发流程（[v2.tauri.app/develop](https://v2.tauri.app/develop/)）。已知限制对本场景的影响：多 webview API 在移动端不可用（tauri [#10012](https://github.com/tauri-apps/tauri/issues/10012)）——单 webview 壳不受影响。整体判断：**单壳 + 远程 URL + 注入补丁的用法在 Tauri Mobile 的能力范围之内**，已知问题集中在键盘/安全区两类，且均有公开解法。

### 注入能力边界结论（验收项 2）

**能**。对远程加载页面注入 CSS/JS 在 Tauri Android 上成立：document-start（视 WebView 版本）或 onPageStarted 时机自动注入 + 运行时 `evaluate_javascript` 任意时机注入，均覆盖远程 URL（wry 源码级确认）。边界：子 frame 不注入、SPA 路由切换不重注入、回退路径有 FOUC 风险、inline 注入受页面 CSP 约束（网关自控，可解）。

### 键盘与安全区清单（验收项 3，初稿）

| # | 问题 | 依据 | 解法 | 真机待验证 |
|---|---|---|---|---|
| K1 | 键盘遮挡底部输入框 / adjustResize 行为不一致 | tauri#7868 | manifest `adjustResize` | ✅ |
| K2 | edge-to-edge 下 adjustResize 失效，IME 覆盖 WebView | catgo-LRG 补丁实例 | MainActivity 消费 IME inset + 前端 visualViewport | ✅ |
| K3 | 键盘弹出时布局高度跳变（100vh 类问题） | 移动 Web 普遍问题 | `100dvh` / visualViewport 驱动布局 | ✅ |
| S1 | `env(safe-area-inset-*)` 恒 0（WebView < 140.0.7339.51） | tauri#14240 | 原生桥写 CSS 变量（插件或自建） | ✅ |
| S2 | API 36 edge-to-edge 默认开启，内容伸入系统栏 | tauri#14240 | 同 S1 + themes.xml / insets 处理 | ✅ |
| S3 | viewport-fit=cover 缺失导致 env() 不生效 | 通用常识 + #11475 | 改 dsh web 模板或补丁注入 meta | ✅ |

### CSS 缺口清单初稿（供 issue 11/12）

1. 安全区变量回退链：`padding-bottom: env(safe-area-inset-bottom, var(--dsh-safe-bottom, 0px))` 四方向，配合原生桥变量；
2. 键盘态布局：输入区改为 visualViewport 驱动定位，容器高度用 `100dvh` 替代 `100vh`；
3. viewport meta：`viewport-fit=cover`（直接修改 dsh web 模板优先，注入作为兜底）；
4. 触屏适配：最小触控目标 44px、去 hover 依赖（桌面 UI 的 hover 菜单/工具提示需替代交互）、`user-scalable` 策略、长按选择/系统菜单的取舍；
5. 注入通道工程项：补丁脚本自驻留（SPA 路由切换时不丢失）、`<style>` 注入与网关 CSP 头协同、补丁按页面版本可探测失效（DOM 锚点自检）。

### go/no-go 结论（验收项 4）

**GO（有条件）** —— issue 12 按 Tauri Mobile 形态推进。置信度：**中-高**。

- 支撑：三项验证目标（远程加载、注入、键盘/安全区）在文档与源码层面均有肯定答案，且键盘/安全区两大已知问题均有公开、可复用的解法（含同类型终端应用的完整补丁先例）；未发现阻断性证据。
- 局限：结论全部基于文档/源码调研，**无一真机实测**；注入时机（document-start vs onPageStarted）依赖真机 WebView 版本；`DOCUMENT_START_SCRIPT` 支持面未核实到具体 WebView 版本下限。
- 若真机复核发现注入路径不成立（低概率），回退方案：issue 11 的网关注入通道（服务端向 HTML 插入补丁）与壳方案正交、仍可复用，12 再改为 PWA 验收，损失限于壳骨架。

### 真机复核点（转入 issue 12 的验收前置）

1. `tauri android init` + `frontendDist` 指向局域网网关 URL（借用 06 形态 B 配置；HTTP 时 `AUTH_COOKIE_SECURE=false`），真机安装、登录（cookie 会话建立）、SPA 加载、WS 流式下行；
2. init script 注入验证：注入一段改背景色的 CSS，确认生效时机（有无未补丁闪烁）与 `WebViewFeature.DOCUMENT_START_SCRIPT` 在该机 WebView 版本上是否可用（`chrome://inspect` 或日志）；
3. `evaluate_javascript` 运行时注入远程页面验证；
4. 键盘：K1/K2/K3 逐项（adjustResize、IME inset 补丁、visualViewport 布局）；
5. 安全区：S1 实测 `env(safe-area-inset-*)` 取值（记录该机 WebView 版本），原生桥变量方案验证；
6. 横竖屏旋转、手势导航条区域、字体缩放下的布局表现。
