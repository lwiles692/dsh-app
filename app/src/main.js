// 启动配置页逻辑（零构建、无框架；经 withGlobalTauri 暴露的全局 API 调 Rust command）。
// 仅本地页面可用 IPC；保存成功后窗口导航到网关 URL，IPC 随之不可用。

const DEFAULT_SERVER_URL = "https://localhost:8443";

const form = document.getElementById("form");
const input = document.getElementById("server-url");
const status = document.getElementById("status");

async function init() {
  const invoke = window.__TAURI__?.core?.invoke;
  if (!invoke) {
    status.textContent = "Tauri IPC 不可用（请以壳内本地页面打开）";
    return;
  }
  try {
    const saved = await invoke("get_server_url");
    input.value = saved || DEFAULT_SERVER_URL;
  } catch {
    input.value = DEFAULT_SERVER_URL;
  }
  input.select();

  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    status.textContent = "正在保存并连接…";
    try {
      await invoke("set_server_url", { url: input.value });
    } catch (err) {
      status.textContent = `保存失败：${err}`;
    }
  });
}

window.addEventListener("DOMContentLoaded", init);
