//! 自动更新（issue 09）。检查/确认/下载/安装全部在 Rust 侧完成：
//! 主窗口加载的是远程网关页，IPC 不暴露给远程页面（issue 07 架构约定），
//! 因此不走 webview 内 JS updater API，而由原生菜单/托盘菜单/启动时静默检查触发，
//! 用户提示用系统对话框（tauri-plugin-dialog）。
//!
//! endpoints 与签名公钥目前为占位配置（见 tauri.conf.json `plugins.updater`
//! 与 README「自动更新」一节）：占位 endpoint 查不到版本源，静默检查只会
//! 得到失败并打到 stderr，不影响启动与使用；真实签名密钥与发布域名就绪后
//! 更换配置即可启用。

use tauri::AppHandle;
use tauri_plugin_dialog::{DialogExt, MessageDialogButtons, MessageDialogKind};
use tauri_plugin_updater::UpdaterExt;

/// 触发一次更新检查。
/// interactive=true（菜单/托盘触发）：无更新、失败均弹框反馈。
/// interactive=false（启动时静默检查）：仅在发现新版本或安装失败时提示，
/// 检查失败只打日志，不打扰启动。
pub fn check_for_updates(app: AppHandle, interactive: bool) {
    tauri::async_runtime::spawn(async move {
        if let Err(error) = run_update_check(&app, interactive).await {
            let message = format!("检查更新失败：{error}");
            if interactive {
                alert(&app, &message, MessageDialogKind::Error);
            } else {
                eprintln!("[updater] {message}");
            }
        }
    });
}

async fn run_update_check(app: &AppHandle, interactive: bool) -> Result<(), String> {
    let updater = app.updater_builder().build().map_err(|e| e.to_string())?;
    let Some(update) = updater.check().await.map_err(|e| e.to_string())? else {
        if interactive {
            alert(app, "当前已是最新版本。", MessageDialogKind::Info);
        }
        return Ok(());
    };

    // 主窗口是远程网关页，确认框走系统对话框而非 webview 内 UI。
    let proceed = app
        .dialog()
        .message(format!(
            "发现新版本 {}（当前 {}），是否下载并安装？\n\n{}",
            update.version,
            update.current_version,
            update.body.clone().unwrap_or_default()
        ))
        .title("dsh 更新")
        .buttons(MessageDialogButtons::OkCancelCustom(
            "安装".into(),
            "暂不".into(),
        ))
        .kind(MessageDialogKind::Info)
        .blocking_show();
    if !proceed {
        return Ok(());
    }

    update
        .download_and_install(|_, _| {}, || {})
        .await
        .map_err(|e| e.to_string())?;

    // Windows 安装器（msi passive）会自行退出应用，走不到这里；
    // Linux（AppImage 替换）/ macOS（app 替换）完成后需重启生效。
    app.restart()
}

fn alert(app: &AppHandle, message: &str, kind: MessageDialogKind) {
    app.dialog()
        .message(message)
        .title("dsh 更新")
        .kind(kind)
        .show(|_| {});
}
