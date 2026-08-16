# 09 — 桌面 CI 出包与自动更新

**What to build:** GitHub Actions 矩阵构建三平台产物（Win msi / macOS dmg，签名可后补 / Linux AppImage+deb），接入 `tauri-plugin-updater` 自动更新。

**Blocked by:** 07

**Status:** ready-for-agent

- [ ] CI 矩阵产出三平台安装包
- [ ] 产物安装后可连服务器跑通会话（至少 Linux+macOS 实测）
- [ ] updater 检测到新版本可完成升级
