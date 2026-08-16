# 11 — 移动布局补丁（网关注入主渠道）

**What to build:** 网关在代理 HTML 时向 `<head>` 注入移动布局补丁 CSS（功能开关可配），按 10 产出的缺口清单修齐聊天主路径的窄屏布局。网关注入是主渠道（桌面移动通吃、不依赖壳内注入能力），壳内注入仅作补充。

**Blocked by:** 10

**Status:** resolved

- [x] 注入开关开启时，经网关的 HTML 响应带补丁 CSS；关闭时原样透传
  - curl 对比取证（真实上游 3080）：开 → 200/16773B 含 `<style id="dsh-mobile-patch">` 且 viewport 补齐 `viewport-fit=cover, interactive-widget=resizes-content`；关 → 200/12109B 与直连上游**逐字节一致**（`cmp` 通过），见 Comments
- [x] 缺口清单逐项修复并有窄屏验证记录
  - 无浏览器环境：以「清单每项有对应 CSS 规则 + 注入后 HTML 内容断言（媒体查询包裹、锚点选择器、变量回退链、dvh、44px 均在注入产物中命中）」替代，见 Comments 逐项核对表；布局渲染效果待 12 真机/浏览器复核
- [x] 桌面宽屏布局不受补丁影响
  - 注入 CSS 除注释外全部规则包在 `@media (max-width: 768px)` 内（脚本断言块外无任何规则），宽屏不命中；唯一文档级改动是 viewport meta 补 token（`viewport-fit`/`interactive-widget` 对桌面布局无影响，不支持的引擎按规范忽略）
- [ ] Android 真机（壳或浏览器）主路径可用
  - 未完成：本环境无 Android 真机/模拟器（headless WSL2），无法验证；与 10 同因，转 issue 12 真机验收项

## Comments

### 完成记录（2026-08-16，issue 11）

**实现要点（`gateway/src/server.js`）**

- 新环境变量 `MOBILE_CSS_PATCH`（默认开；`false/0/no` 关闭，解析惯例与 `AUTH_COOKIE_SECURE` 一致）。
- 注入只命中 **text/html 且 200** 的文档响应；其余（JS/CSS/图片/304/非 200）原样透传，`reply.send(res.stream)` 与 reply-from 默认行为一致。
- 压缩处理取「让 HTML 不压缩」为主、解压改写为兜底：`rewriteRequestHeaders` 对 Accept 含 `text/html` 的文档请求剥 `accept-encoding` 与条件请求头（`if-none-match`/`if-modified-since`，304 无正文可注入），静态资源不受影响；防御路径上若上游仍压缩（gzip/br/deflate），收全量后解压再改写。
- 改写后剥 `content-encoding`/`content-length`/`etag`/`last-modified`（正文已变，校验器失效）；非 UTF-8 charset 文档透传不注入（避免破坏编码）；上游流中断回 502 明确错误（头未发出，安全改码）。
- `patchHtml`（`gateway/src/mobile-patch.js`）幂等（标记 `dsh-mobile-patch` 已存在则原样返回）、原子（无 `</head>` 不动文档）：viewport meta 补 `viewport-fit=cover, interactive-widget=resizes-content`（已有 token 不覆盖，无 meta 则插），`</head>` 前注入补丁 `<style id="dsh-mobile-patch">`。

**补丁要点（按 10 的缺口清单；全部包在 `@media (max-width: 768px)`）**

1. **安全区回退链（S1/S2/S3）**：`:root` 声明 `--dsh-safe-{top,right,bottom,left}: 0px`（壳侧 issue 12 原生桥写内联覆盖），`body` 四向 `max(env(safe-area-inset-*), var(--dsh-safe-*))`——env() 在 Android WebView < 140 恒 0 时由桥变量兜底（tauri#14240）；viewport meta 补 `viewport-fit=cover` 是 env() 生效前置（S3）。
2. **键盘态/视口高度（K3）**：`html { height: 100dvh }`（上游 base.css 为 `html,body,#root{height:100%}`；dvh 只覆盖 html，body/#root 维持 100% 链，body 带 border-box 安全区 padding 不溢出），meta `interactive-widget=resizes-content` 让键盘弹出收缩布局视口，底部 composer 不被遮挡。旧引擎不识别 dvh 时丢弃该声明回退上游行为。
3. **窄屏聊天主路径**：三列框架（锚 `div:has(> [data-shell-overlay])`，AppFrame 根）钉 `grid-template-columns: 56px minmax(0,1fr) 0px !important`——压过 React 内联样式，手机宽度下中列恒全宽（上游让位链会挤到 ~80px）；侧栏手动展开时转为左侧抽屉（fixed、`min(85vw,340px)`、z-index 40）；`--dsh-composer-side-clearance` 16→8px（消费方为 ChatView padding 与 composer/dock 卡，748px 内容宽仅作 max-width 天然全宽，不需覆盖）。
4. **触屏适配**：composer 座与侧栏按钮最小 44×44（消息行 28px 图标按钮维持上游密度防行重叠，留 12 调优）；`input/textarea/select/contenteditable` 16px 防聚焦自动放大；`[data-side]` 拖拽手柄窄屏隐藏（pointer-capture 纯鼠标交互；消息时间标签 hover-reveal 上游已按 `@media (hover:hover)` 自理，无需补丁）。
5. **注入通道工程项**：`<style id="dsh-mobile-patch">` 即 DOM 自检锚点（补丁失效探测查该元素存在性）；网关注入随文档导航每次生效，无 SPA 路由丢失问题（补丁为纯 CSS，不依赖脚本自驻留）；上游无 CSP 头（实测响应头），inline style 不受阻。

**与半成品的差异（接手修正）**：修掉 `html,body,#root{height:100dvh}`（body 有 padding 会溢出）；修掉无 viewport meta 时「半套改写」不一致（改为原子补丁）；流错误从裸断连接改 502；补非 UTF-8/last-modified 处理；修死代码规则——≤768 时上游让位链（columns.ts）必收 details 为 0，原「details 覆盖层」规则永不命中，改为钉死第三轨 0；44px 从全按钮泛化收窄为主路径控件（全量 44px 会破消息行 28px 固定行高）；修正锚点出处注释（`data-sidebar-collapsed` 非 `data-details-collapsed`）。

**验证证据**

- `patchHtml` 单元断言（node --input-type=module）：viewport 合并/单引号 meta/幂等/无 meta 插入/无 `</head>` 原样返回，全过。
- mock 上游 + 真网关 9 项断言全过：注入 ✅；媒体查询包裹（块外无规则）✅；gzip/br 上游解压改写 ✅；304 透传 ✅；JS（含 `</head>` 字面量陷阱）不误伤 ✅；gbk 透传 ✅；断流 502 ✅；校验器头清理 ✅。
- 真实上游 3080 curl 对比：开（3112）200/16773B 含补丁，viewport 补齐；关（3113）200/12109B 与直连上游 `cmp` 逐字节一致；`/assets/*.css`（67798B）零注入。
- 窄屏验证（无浏览器替代法）：注入产物内容断言覆盖缺口 1/2/4 与主路径锚点（`[data-composer-seat]`、`grid-template-columns`、`[data-side]`、`--dsh-safe-*`、`100dvh`、`min-height:44px`）；DOM 锚点均从 vendor 源码逐个核实（ConversationRoot.tsx / AppFrame.tsx / scoped-slots.tsx，pin 见 `scripts/verify-upstream.sh`）。

**遗留**

- 渲染效果（抽屉交互、44px 观感、dvh 实机行为、44px 是否需扩到消息行）待 issue 12 真机复核调优；壳侧 `--dsh-safe-*` 原生桥（tauri-plugin-safe-area-insets-css 或自建）在 12 落地。
- 顺带清理：接手时发现前一 agent 遗留的测试网关进程（3111，18:00:54 启动）占用端口，已 kill；3080 既存 dsh web 非本任务启动，未动。
