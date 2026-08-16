// 全局 Tauri API（withGlobalTauri）在远程网关页面不可用 —— IPC 只对本地配置页开放，
// 壳内 SPA 走标准 fetch/WebSocket + HttpOnly cookie，与浏览器形态完全一致。

use serde_json::{json, Value};
use tauri::{
    menu::{CheckMenuItemBuilder, MenuBuilder, MenuItemBuilder},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    AppHandle, Manager, WebviewUrl, WebviewWindowBuilder, WindowEvent,
};
use tauri_plugin_autostart::ManagerExt;
use tauri_plugin_store::StoreExt;

mod updater;

const STORE_PATH: &str = "settings.json";
const SERVER_URL_KEY: &str = "server_url";
const CLOSE_TO_TRAY_KEY: &str = "close_to_tray";
const AUTOSTART_INIT_KEY: &str = "autostart_initialized";

/// 启动配置页读取已保存的网关地址（用于预填表单）。
#[tauri::command]
fn get_server_url(app: AppHandle) -> Option<String> {
    let store = app.store(STORE_PATH).ok()?;
    store.get(SERVER_URL_KEY)?.as_str().map(str::to_owned)
}

/// 保存服务器地址并把主窗口导航到网关 URL。
/// token 不经壳保存：登录页在 webview 内种 HttpOnly cookie（见 issue 04/07）。
#[tauri::command]
fn set_server_url(app: AppHandle, url: String) -> Result<(), String> {
    let parsed = validate_server_url(&url)?;
    let store = app.store(STORE_PATH).map_err(|e| e.to_string())?;
    store.set(SERVER_URL_KEY, json!(parsed.as_str()));
    store.save().map_err(|e| e.to_string())?;
    let window = app
        .get_webview_window("main")
        .ok_or_else(|| "main window not found".to_string())?;
    window.navigate(parsed).map_err(|e| e.to_string())
}

/// 仅允许 https；http 只放行回环地址（对应 RUNBOOK 的 HTTP 回环显式降配形态）。
fn validate_server_url(input: &str) -> Result<url::Url, String> {
    let parsed = url::Url::parse(input.trim())
        .map_err(|_| "地址无法解析，请输入完整 URL（含协议）".to_string())?;
    match parsed.scheme() {
        "https" => Ok(parsed),
        "http" => {
            let host = parsed.host_str().unwrap_or_default();
            if matches!(host, "localhost" | "127.0.0.1" | "[::1]" | "::1") {
                Ok(parsed)
            } else {
                Err("http 仅允许回环地址（localhost/127.0.0.1/::1）".to_string())
            }
        }
        scheme => Err(format!("不支持的协议 {scheme}://，仅支持 https/http")),
    }
}

/// 「关窗驻留托盘」配置：store 未写入时默认开启；显式 false 时关窗即退出进程。
fn close_to_tray_from(value: Option<&Value>) -> bool {
    value.and_then(Value::as_bool).unwrap_or(true)
}

fn close_to_tray_enabled(app: &AppHandle) -> bool {
    let value = app
        .store(STORE_PATH)
        .ok()
        .and_then(|s| s.get(CLOSE_TO_TRAY_KEY));
    close_to_tray_from(value.as_ref())
}

/// 显示/隐藏主窗口（托盘左键与托盘菜单共用）。
fn toggle_main_window(app: &AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        if window.is_visible().unwrap_or(false) {
            let _ = window.hide();
        } else {
            let _ = window.unminimize();
            let _ = window.show();
            let _ = window.set_focus();
        }
    }
}

/// 聚焦已有主窗口（单实例插件回调：重复启动时不新开进程，只唤起窗口）。
fn focus_main_window(app: &AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.unminimize();
        let _ = window.show();
        let _ = window.set_focus();
    }
}

fn open_main_window(app: &AppHandle, url: WebviewUrl) -> tauri::Result<()> {
    WebviewWindowBuilder::new(app, "main", url)
        .title("dsh")
        .inner_size(1280.0, 800.0)
        .build()?;
    Ok(())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        // 单实例必须最先注册：第二个进程在此即退出，回调聚焦已有窗口。
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            focus_main_window(app);
        }))
        .plugin(tauri_plugin_store::Builder::default().build())
        .plugin(tauri_plugin_autostart::init(
            tauri_plugin_autostart::MacosLauncher::LaunchAgent,
            None,
        ))
        // dialog：更新确认/提示用系统对话框（主窗口是远程页，不能走 webview 内 UI）；
        // updater：自动更新插件，检查逻辑见 src/updater.rs（Rust 侧触发，不依赖 JS API）。
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .invoke_handler(tauri::generate_handler![get_server_url, set_server_url])
        .setup(|app| {
            // 原生菜单：「更改服务器地址」回配置页可改指向另一实例；
            // 「检查更新」在本地上下文触发 updater（远程网关页无 IPC，见 updater.rs）。
            let change_server =
                MenuItemBuilder::with_id("change-server", "更改服务器地址").build(app)?;
            let check_update = MenuItemBuilder::with_id("check-update", "检查更新…").build(app)?;
            let menu = MenuBuilder::new(app)
                .item(&change_server)
                .item(&check_update)
                .build()?;
            app.set_menu(menu)?;

            // 首次启动默认开启开机自启；写入标记，之后不覆盖用户在托盘的勾选。
            let store = app.store(STORE_PATH)?;
            if store.get(AUTOSTART_INIT_KEY).is_none() {
                let _ = app.autolaunch().enable();
                store.set(AUTOSTART_INIT_KEY, json!(true));
                let _ = store.save();
            }

            // 系统托盘：显示/隐藏窗口、开机自启、关窗驻留开关、退出。
            let toggle = MenuItemBuilder::with_id("toggle-window", "显示/隐藏窗口").build(app)?;
            let autostart_item = CheckMenuItemBuilder::with_id("autostart", "开机自启")
                .checked(app.autolaunch().is_enabled().unwrap_or(false))
                .build(app)?;
            let close_to_tray_item =
                CheckMenuItemBuilder::with_id("close-to-tray", "关窗时驻留托盘")
                    .checked(close_to_tray_enabled(app.handle()))
                    .build(app)?;
            let quit = MenuItemBuilder::with_id("quit", "退出").build(app)?;
            let tray_check_update =
                MenuItemBuilder::with_id("tray-check-update", "检查更新…").build(app)?;
            let tray_menu = MenuBuilder::new(app)
                .items(&[
                    &toggle,
                    &autostart_item,
                    &close_to_tray_item,
                    &tray_check_update,
                    &quit,
                ])
                .build()?;
            let mut tray = TrayIconBuilder::with_id("tray")
                .menu(&tray_menu)
                .show_menu_on_left_click(false)
                .on_menu_event(|app, event| match event.id().as_ref() {
                    "toggle-window" => toggle_main_window(app),
                    "autostart" => {
                        let autostart = app.autolaunch();
                        if autostart.is_enabled().unwrap_or(false) {
                            let _ = autostart.disable();
                        } else {
                            let _ = autostart.enable();
                        }
                    }
                    "close-to-tray" => {
                        if let Ok(store) = app.store(STORE_PATH) {
                            store.set(CLOSE_TO_TRAY_KEY, json!(!close_to_tray_enabled(app)));
                            let _ = store.save();
                        }
                    }
                    "tray-check-update" => updater::check_for_updates(app.clone(), true),
                    "quit" => app.exit(0),
                    _ => {}
                })
                .on_tray_icon_event(|tray, event| {
                    // 左键点击托盘图标 = 显示/隐藏窗口（菜单走右键）。
                    if let TrayIconEvent::Click {
                        button: MouseButton::Left,
                        button_state: MouseButtonState::Up,
                        ..
                    } = event
                    {
                        toggle_main_window(tray.app_handle());
                    }
                });
            if let Some(icon) = app.default_window_icon() {
                tray = tray.icon(icon.clone());
            }
            tray.build(app)?;

            // 已配置地址 → 窗口直接加载网关 URL；否则加载本地启动配置页。
            let saved = app
                .store(STORE_PATH)
                .ok()
                .and_then(|s| s.get(SERVER_URL_KEY))
                .and_then(|v| v.as_str().map(str::to_owned))
                .and_then(|u| validate_server_url(&u).ok());
            let url = match saved {
                Some(u) => WebviewUrl::External(u),
                None => WebviewUrl::App("index.html".into()),
            };
            open_main_window(app.handle(), url)?;

            // 启动时静默检查更新：占位 endpoint 下只会得到一次失败的 HTTP 请求
            //（打日志），不影响启动；发现新版本才弹确认框（见 updater.rs）。
            updater::check_for_updates(app.handle().clone(), false);
            Ok(())
        })
        .on_menu_event(|app, event| match event.id().as_ref() {
            "change-server" => {
                if let Some(window) = app.get_webview_window("main") {
                    // destroy 绕过关窗驻留拦截（CloseRequested），直接销毁重建。
                    let _ = window.destroy();
                }
                let _ = open_main_window(app, WebviewUrl::App("index.html".into()));
            }
            "check-update" => updater::check_for_updates(app.clone(), true),
            _ => {}
        })
        .on_window_event(|window, event| {
            // 关窗不退进程（默认开）：拦截关闭改为隐藏，进程驻留托盘；托盘「退出」才退出。
            if let WindowEvent::CloseRequested { api, .. } = event {
                if close_to_tray_enabled(&window.app_handle()) {
                    api.prevent_close();
                    let _ = window.hide();
                }
            }
        })
        .run(tauri::generate_context!())
        .expect("error while running dsh-shell");
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn accepts_https() {
        assert!(validate_server_url("https://localhost:8443").is_ok());
        assert!(validate_server_url("https://dsh.example.com/").is_ok());
    }

    #[test]
    fn accepts_http_loopback_only() {
        assert!(validate_server_url("http://127.0.0.1:3000").is_ok());
        assert!(validate_server_url("http://localhost:3000").is_ok());
        assert!(validate_server_url("http://192.168.1.10:3000").is_err());
    }

    #[test]
    fn rejects_garbage_and_other_schemes() {
        assert!(validate_server_url("localhost:8443").is_err());
        assert!(validate_server_url("not a url").is_err());
        assert!(validate_server_url("file:///etc/passwd").is_err());
        assert!(validate_server_url("").is_err());
    }

    #[test]
    fn close_to_tray_defaults_to_enabled() {
        assert!(close_to_tray_from(None));
        assert!(close_to_tray_from(Some(&json!("not-a-bool"))));
    }

    #[test]
    fn close_to_tray_honors_explicit_value() {
        assert!(close_to_tray_from(Some(&json!(true))));
        assert!(!close_to_tray_from(Some(&json!(false))));
    }
}
