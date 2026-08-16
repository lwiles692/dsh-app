package com.dsh.app

import android.os.Bundle
import android.view.View
import android.view.ViewGroup
import android.webkit.WebView
import androidx.activity.enableEdgeToEdge
import androidx.core.view.ViewCompat
import androidx.core.view.WindowInsetsCompat
import androidx.core.view.children

/**
 * 移动壳 MainActivity（issue 12）。
 *
 * 两个原生补丁（来源 issue 10 spike 的真机复核清单，实现参照公开先例
 * catgo-LRG 的 IME inset 补丁与 jellytau 的 WindowInsets 桥模式）：
 *
 * 1. S1 safe-area 桥：`env(safe-area-inset-*)` 在 Android WebView < 140 恒为 0
 *    （tauri#14240），原生读 systemBars + displayCutout inset，经
 *    evaluateJavascript 写 `--dsh-safe-{top,right,bottom,left}` CSS 变量；
 *    issue 11 网关注入的移动 CSS 补丁以
 *    `max(env(safe-area-inset-*), var(--dsh-safe-*))` 回退链消费。
 *    走 evaluateJavascript 而非插件 JS API：主窗口是远程网关页，IPC 不对其
 *    开放（issue 07 架构约定），此桥对任意已加载页面生效。
 *
 * 2. K2 IME inset 补丁：edge-to-edge 下 manifest adjustResize 单独不生效
 *    （tauri#7868），键盘弹出时原生把 IME inset 作为 WebView 底部 padding，
 *    内容区整体抬升到键盘上方；与网关补丁的 viewport
 *    `interactive-widget=resizes-content`（K3）配合，两侧视口收缩一致。
 *
 * 上述两项均为真机复核点（本环境无真机）：inset 实测值、变量生效时机、
 * 键盘弹出后的布局行为见 issue 12 Comments 的复核清单。
 */
class MainActivity : TauriActivity() {
  override fun onCreate(savedInstanceState: Bundle?) {
    enableEdgeToEdge()
    super.onCreate(savedInstanceState)

    val root = findViewById<ViewGroup>(android.R.id.content)
    ViewCompat.setOnApplyWindowInsetsListener(root) { view, insets ->
      val bars =
          insets.getInsets(
              WindowInsetsCompat.Type.systemBars() or WindowInsetsCompat.Type.displayCutout())
      val ime = insets.getInsets(WindowInsetsCompat.Type.ime())

      findWebView(view)?.let { web ->
        // S1：系统栏 + 刘海 → CSS 变量（px）。每次 inset 变化重写，导航到新页面后
        // 由下一次 inset/resize 事件补写；变量只是回退链的一环，偶发缺失不致命。
        val js =
            """
            (function () {
              var s = document.documentElement.style;
              s.setProperty('--dsh-safe-top', '${bars.top}px');
              s.setProperty('--dsh-safe-right', '${bars.right}px');
              s.setProperty('--dsh-safe-bottom', '${bars.bottom}px');
              s.setProperty('--dsh-safe-left', '${bars.left}px');
            })()
            """
                .trimIndent()
        web.evaluateJavascript(js, null)

        // K2：IME inset 作为底部 padding，键盘弹出时内容区抬到键盘上方。
        // 系统栏不在此处 padding——已由上面的 CSS 变量桥处理，避免双重内缩。
        web.setPadding(0, 0, 0, ime.bottom)
      }
      insets
    }
  }

  /** TauriActivity 在 onCreate 后才创建 WebView，逐次回调时再向下找。 */
  private fun findWebView(view: View): WebView? =
      when (view) {
        is WebView -> view
        is ViewGroup -> view.children.asSequence().mapNotNull(::findWebView).firstOrNull()
        else -> null
      }
}
