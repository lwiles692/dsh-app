# 07 — Tauri 桌面壳 MVP

**What to build:** `shell/` Tauri 2 工程，窗口直接加载网关 URL（不打包本地静态资源）。启动页配置服务器地址并用 store 插件持久化；不引入 keyring/stronghold——token 经登录页以 webview cookie 持久化。壳内完成登录并跑通完整会话。

**Blocked by:** 05

**Status:** ready-for-agent

- [ ] 首次启动展示服务器地址配置页，保存后加载网关 URL
- [ ] webview 内登录页种 cookie 成功，重启壳后仍保持登录
- [ ] 壳内完成一次完整会话（含流式事件）
- [ ] 改服务器地址后可重新指向另一实例
