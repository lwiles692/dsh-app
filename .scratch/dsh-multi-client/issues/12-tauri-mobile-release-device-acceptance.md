# 12 — Tauri Mobile 出包与真机验收

**What to build:** 若 10 结论为 go：同一 `shell/` 工程开 Android target，构建 APK，真机完成一次完整会话；iOS target 配置就绪（开发者证书到位后再出包）。若 10 结论为 no-go：本票改为 PWA 验收——移动浏览器将网关加为主屏 PWA，完成完整会话。

**Blocked by:** 10（结论为 go）, 11

**Status:** ready-for-agent

- [ ] Android APK 构建产出并可安装
- [ ] 真机完成一次完整会话（含流式事件、键盘中发送）
- [ ] iOS target 工程配置就绪，出包步骤记录在案（或明确记录 no-go 后的 PWA 验收结果）
