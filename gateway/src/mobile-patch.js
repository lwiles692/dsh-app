// dsh 网关移动布局补丁：经网关代理的 text/html 200 响应在 </head> 前注入
// 一段补丁 <style>，并补齐 viewport meta。全部规则包在 @media (max-width:
// 768px) 内，桌面宽屏不命中。
//
// 选择器锚点只用上游稳定属性：构建产物的 CSS module class 名按内容 hash
//（如 _frame_9gj4p_），随构建漂移不可锚定。锚点出处（vendor/ pin 见
// scripts/verify-upstream.sh 头注释）：[data-composer-seat]/[data-phase] 为
// ui-conversation ConversationRoot 根元素，[data-sidebar-collapsed]/
// [data-shell-overlay] 为 ui-layout AppFrame 框架根，[data-side] 为列宽拖拽
// 手柄，[data-slot=…] 为 web-react scoped-slots 的 display:contents 包装 div。
const MOBILE_PATCH_CSS = `
/* dsh 移动布局补丁。仅窄屏命中。 */
@media (max-width: 768px) {
  /* 安全区变量回退：env(safe-area-inset-*) 在 Android WebView < 140.0.7339.51
     恒 0（tauri#14240），max() 让壳侧原生桥写入的 --dsh-safe-* 变量兜底。 */
  :root {
    --dsh-safe-top: 0px;
    --dsh-safe-right: 0px;
    --dsh-safe-bottom: 0px;
    --dsh-safe-left: 0px;
  }

  /* 上游 html/body/#root 均为 height:100%，移动端随 URL 栏抖动；dvh 只覆盖
     html（body 带 border-box 安全区 padding，同设 dvh 会溢出视口），配合
     interactive-widget=resizes-content，键盘弹出时底部输入区不被遮挡。
     旧引擎不识别 dvh 时回退上游 100%。 */
  html {
    height: 100dvh;
  }

  /* viewport-fit=cover 下内容伸入系统栏/刘海：body 一层四方向安全区内缩整个
     应用。固定定位元素（下方抽屉）逃逸 body padding，各自补。 */
  body {
    box-sizing: border-box;
    padding-top: max(env(safe-area-inset-top, 0px), var(--dsh-safe-top));
    padding-right: max(env(safe-area-inset-right, 0px), var(--dsh-safe-right));
    padding-bottom: max(env(safe-area-inset-bottom, 0px), var(--dsh-safe-bottom));
    padding-left: max(env(safe-area-inset-left, 0px), var(--dsh-safe-left));
  }

  /* 三列框架钉为「56px 轨 + 全宽中列」：手动展开侧栏会把中列挤到不足
     CENTER_MIN；!important 压过 AppFrame 的内联 grid-template-columns
    （样式表 !important > 内联非 important）。 */
  div:has(> [data-shell-overlay]) {
    grid-template-columns: 56px minmax(0, 1fr) 0px !important;
  }

  /* 侧栏手动展开（框架无 data-sidebar-collapsed）时改为左侧抽屉覆盖层，
     不再挤压聊天列；z-index 低于 Tooltip(100)、高于 overlayLayer(20)。 */
  div:has(> [data-shell-overlay]):not([data-sidebar-collapsed]) > div:first-child {
    position: fixed;
    top: 0;
    bottom: 0;
    left: 0;
    z-index: 40;
    width: min(85vw, 340px);
    padding-bottom: max(env(safe-area-inset-bottom, 0px), var(--dsh-safe-bottom));
  }

  /* 横向 clearance 16px→8px：消费方为 ChatView 内边距与 composer/dock 卡两侧。 */
  [data-phase] {
    --dsh-composer-side-clearance: 8px;
  }

  /* 触屏最小目标 44px（Apple HIG 44pt / Android 48dp 折中），只钉主路径
     控件——composer 座内按钮与侧栏；消息行内 28px 图标按钮维持上游密度
    （行高 28px 固定，强制 44 会溢出重叠）。 */
  [data-composer-seat] button,
  [data-slot='sidebar'] button {
    min-height: 44px;
    min-width: 44px;
  }
  [role='menuitem'], [role='option'] {
    min-height: 44px;
  }

  /* 输入控件 ≥16px，避免移动浏览器聚焦时自动放大页面。 */
  input, select, textarea, [contenteditable='true'] {
    font-size: 16px;
  }

  /* 列宽拖拽手柄是 pointer-capture 纯鼠标交互，触屏不可用，窄屏隐藏。 */
  [data-side] {
    display: none;
  }
}
`

const PATCH_MARK = 'dsh-mobile-patch'

// id 即自检锚点：检查 document 中是否存在该元素；SPA 路由切换不重载文档，注入常驻。
const STYLE_TAG = `<style id="${PATCH_MARK}">${MOBILE_PATCH_CSS}</style>`

// viewport-fit=cover 是 env() 安全区生效前置；interactive-widget=
// resizes-content 让键盘弹出时收缩布局视口，与 100dvh 规则配套。
const VIEWPORT_TOKENS = ['viewport-fit=cover', 'interactive-widget=resizes-content']

// 向已有 viewport meta 的 content 补齐缺失 token；已存在的键（含异值）不覆盖。
const mergeViewportContent = (content) => {
  const tokens = content.split(',').map((t) => t.trim()).filter(Boolean)
  const keys = new Set(tokens.map((t) => t.split('=')[0].trim().toLowerCase()))
  for (const token of VIEWPORT_TOKENS) {
    if (!keys.has(token.split('=')[0])) tokens.push(token)
  }
  return tokens.join(', ')
}

// 幂等：已含补丁标记的文档原样返回；找不到 </head>（截断/非文档 HTML）时
// 原样返回，不留下半套改写。
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
