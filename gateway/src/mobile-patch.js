// dsh 网关移动布局补丁（issue 11：网关注入主渠道）。
//
// 经网关代理的 text/html 200 响应在 </head> 前注入一段补丁 <style>，并把
// viewport meta 补齐 viewport-fit=cover（env() 安全区生效前置）与
// interactive-widget=resizes-content（键盘弹出收缩布局视口）。补丁内容按
// issue 10 产出的 CSS 缺口清单；全部规则包在 @media (max-width: 768px) 内，
// 桌面宽屏布局不命中、不受影响。
//
// 选择器锚点只用上游稳定属性（构建产物的 CSS module class 名按内容 hash，
// 如 _frame_9gj4p_，随构建漂移不可锚定）。锚点出处（vendor/ pin，见
// scripts/verify-upstream.sh 头注释）：
//   [data-composer-seat] / [data-phase]   ui-conversation ConversationRoot.tsx
//     （同一根元素声明 --dsh-composer-* 布局变量，见 ConversationRoot.module.css .root）
//   [data-sidebar-collapsed] / [data-shell-overlay]   ui-layout AppFrame.tsx
//     （框架根 div；子序：1 sidebarCol、2 centerCol、3 detailsCol、4 overlayLayer，
//      React fragment 不产生 DOM 节点）
//   [data-side]    AppFrame DragHandle（纯鼠标拖拽手柄）
//   [data-slot=…]  web-react scoped-slots.tsx 的 display:contents 包装 div，
//     布局中立、纯寻址锚点（键名如 'sidebar'）
// 宽度几何事实（ConversationRoot/ChatView/StatsLine 等 module css）：内容宽
// --dsh-chat-content-width(748px) 只作为 max-width 上限消费，窄列天然全宽，
// 无需覆盖；--dsh-composer-side-clearance(16px) 是横向内边距的实际来源。
// 窄屏三列几何（ui-layout columns.ts）：视口 < 1024 侧栏自动收成 56px 轨，
// details 放不下时由让位链强制收 0——≤768 时 details 恒为收起，无需补丁。
const MOBILE_PATCH_CSS = `
/* dsh 移动布局补丁（issue 11，网关注入主渠道）。仅窄屏命中。 */
@media (max-width: 768px) {
  /* 缺口 1（spike S1/S2）：安全区变量回退链。env(safe-area-inset-*) 在
     Android WebView < 140.0.7339.51 恒 0（tauri#14240）：max() 让壳侧原生
     桥写入的 --dsh-safe-* 变量兜底；浏览器 env() 正常时桥变量保持 0px
     不干扰。壳桥变量由 issue 12 的原生侧写入 :root 内联样式。 */
  :root {
    --dsh-safe-top: 0px;
    --dsh-safe-right: 0px;
    --dsh-safe-bottom: 0px;
    --dsh-safe-left: 0px;
  }

  /* 缺口 2（spike K3）：高度链补 100dvh。上游 base.css 是
     html/body/#root height:100%（html 的 100% 随初始包含块，移动端含
     URL 栏高度抖动）；dvh 只覆盖 html——body/#root 维持上游 100% 链
     （body 带 border-box 安全区 padding，若也设 dvh 会溢出视口），
     整条链随动态视口收缩，配合注入 meta 的
     interactive-widget=resizes-content，键盘弹出时底部输入区不被遮挡。
     旧引擎不识别 dvh 时该声明被丢弃，回退上游 100%。 */
  html {
    height: 100dvh;
  }

  /* viewport-fit=cover 下内容伸入系统栏/刘海，body 一层四方向安全区内缩
     整个应用（border-box 保证总高仍 100dvh；上游 body 无 padding、
     margin 0，此处为首添）。下游 .frame/.root 的 100% 链随之落在
     安全区内；固定定位元素（下方抽屉）逃逸 body padding，各自补。 */
  body {
    box-sizing: border-box;
    padding-top: max(env(safe-area-inset-top, 0px), var(--dsh-safe-top));
    padding-right: max(env(safe-area-inset-right, 0px), var(--dsh-safe-right));
    padding-bottom: max(env(safe-area-inset-bottom, 0px), var(--dsh-safe-bottom));
    padding-left: max(env(safe-area-inset-left, 0px), var(--dsh-safe-left));
  }

  /* 缺口 4/窄屏主路径：三列框架钉为「56px 轨 + 全宽中列」。上游让位链在
     < 1024 已自动收侧栏，但手动再展开会把中列挤到不足 CENTER_MIN（360px
     手机上仅剩 ~80px）；!important 压过 AppFrame 的内联
     grid-template-columns（样式表 !important > 内联非 important），中列
     恒全宽。details 第三轨在 ≤768 恒为 0（让位链强制），一并钉死。 */
  div:has(> [data-shell-overlay]) {
    grid-template-columns: 56px minmax(0, 1fr) 0px !important;
  }

  /* 侧栏手动展开（框架无 data-sidebar-collapsed）时改为左侧抽屉覆盖层，
     不再挤压聊天列。无遮罩：点右侧露出的聊天区即可继续操作，抽屉内自带
     收起按钮；z-index 40 低于 Tooltip(100)、高于 overlayLayer(20)。 */
  div:has(> [data-shell-overlay]):not([data-sidebar-collapsed]) > div:first-child {
    position: fixed;
    top: 0;
    bottom: 0;
    left: 0;
    z-index: 40;
    width: min(85vw, 340px);
    padding-bottom: max(env(safe-area-inset-bottom, 0px), var(--dsh-safe-bottom));
  }

  /* 窄屏聊天主路径：横向 clearance 16px→8px。消费方为 ChatView 内边距
     (clearance+16)/侧 与 composer/dock 卡两侧 clearance，全窄屏收缩；
     内容宽 748px 仅作 max-width，不覆盖。 */
  [data-phase] {
    --dsh-composer-side-clearance: 8px;
  }

  /* 缺口 4：触屏最小目标 44px（Apple HIG 44pt / Android 48dp 折中），只钉
     主路径控件——composer 座内全部按钮（发送/停止/命令等）与侧栏（轨图标
     与列表行）。消息行内 28px 图标按钮维持上游密度（行高 28px 固定，强制
     44 会溢出重叠），留待 issue 12 真机调优；菜单/列表项按 role 泛化。 */
  [data-composer-seat] button,
  [data-slot='sidebar'] button {
    min-height: 44px;
    min-width: 44px;
  }
  [role='menuitem'], [role='option'] {
    min-height: 44px;
  }

  /* 缺口 4：输入控件 ≥16px，避免移动浏览器聚焦时自动放大页面（上游
     composer 卡已 16px，此处兜住其余输入面）。缩放本身不禁（无障碍）。 */
  input, select, textarea, [contenteditable='true'] {
    font-size: 16px;
  }

  /* 缺口 4：去 hover/精细指针依赖——列宽拖拽手柄（DragHandle，data-side）
     是 pointer-capture 纯鼠标交互，触屏不可用，窄屏隐藏（框架已钉死列宽，
     手柄本就无意义）。消息操作按钮常显、时间标签 hover-reveal 已对
     hover:none 自理（MessageIconActions.module.css @media (hover: hover)），
     无需补丁。 */
  [data-side] {
    display: none;
  }
}
`

const PATCH_MARK = 'dsh-mobile-patch'

// 注入的 <style> 标签。id 即自检锚点：issue 10 清单工程项「DOM 锚点自检」
// 检查 document 中是否存在该元素；SPA 路由切换不重载文档，注入常驻。
const STYLE_TAG = `<style id="${PATCH_MARK}">${MOBILE_PATCH_CSS}</style>`

// viewport meta 需要补齐的 token（缺口 2/3：S3 viewport-fit=cover 是
// env() 安全区生效前置；interactive-widget=resizes-content 让 Chrome/WebView
// 键盘弹出时收缩布局视口而不是遮挡输入区，与 100dvh 规则配套；不支持的
// 引擎按规范忽略未知 token）。
const VIEWPORT_TOKENS = ['viewport-fit=cover', 'interactive-widget=resizes-content']

// 向已有 viewport meta 的 content 补齐缺失 token；键名大小写/空白不敏感，
// 已存在的键（含异值）不覆盖。
const mergeViewportContent = (content) => {
  const tokens = content.split(',').map((t) => t.trim()).filter(Boolean)
  const keys = new Set(tokens.map((t) => t.split('=')[0].trim().toLowerCase()))
  for (const token of VIEWPORT_TOKENS) {
    if (!keys.has(token.split('=')[0])) tokens.push(token)
  }
  return tokens.join(', ')
}

// 对 HTML 文档应用补丁：viewport meta 升级 + 注入补丁 <style>。幂等：已含
// 补丁标记的文档原样返回。补丁是原子的：找不到 </head>（截断/非文档 HTML）
// 时原样返回，不留下半套改写。
export const patchHtml = (html) => {
  if (html.includes(PATCH_MARK)) return html
  if (!/<\/head>/i.test(html)) return html

  let out = html
  const metaRe = /<meta\s[^>]*name=["']viewport["'][^>]*>/i
  const metaMatch = out.match(metaRe)
  if (metaMatch) {
    const tag = metaMatch[0]
    const contentRe = /content=(["'])([^"']*)\1/i
    const cm = tag.match(contentRe)
    if (cm) {
      out = out.replace(tag, tag.replace(contentRe, `content=${cm[1]}${mergeViewportContent(cm[2])}${cm[1]}`))
    }
  } else {
    out = out.replace(/<head([^>]*)>/i, `<head$1>\n<meta name="viewport" content="width=device-width, initial-scale=1, ${VIEWPORT_TOKENS.join(', ')}">`)
  }

  return out.replace(/<\/head>/i, `${STYLE_TAG}\n</head>`)
}
