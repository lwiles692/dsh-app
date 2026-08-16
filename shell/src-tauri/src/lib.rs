// 全局 Tauri API（withGlobalTauri）在远程网关页面不可用 —— IPC 只对本地配置页开放，
// 壳内 SPA 走标准 fetch/WebSocket + HttpOnly cookie，与浏览器形态完全一致。

use serde_json::json;
use tauri::{
    menu::{MenuBuilder, MenuItemBuilder},
    AppHandle, Manager, WebviewUrl, WebviewWindowBuilder,
};
use tauri_plugin_store::StoreExt;

const STORE_PATH: &str = "settings.json";
const SERVER_URL_KEY: &str = "server_url";

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
        .plugin(tauri_plugin_store::Builder::default().build())
        .invoke_handler(tauri::generate_handler![get_server_url, set_server_url])
        .setup(|app| {
            // 原生菜单提供「更改服务器地址」入口：回到本地配置页后可改指向另一实例。
            let change_server =
                MenuItemBuilder::with_id("change-server", "更改服务器地址").build(app)?;
            let menu = MenuBuilder::new(app).item(&change_server).build()?;
            app.set_menu(menu)?;

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
            Ok(())
        })
        .on_menu_event(|app, event| {
            if event.id() == "change-server" {
                if let Some(window) = app.get_webview_window("main") {
                    let _ = window.close();
                }
                let _ = open_main_window(app, WebviewUrl::App("index.html".into()));
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
}
