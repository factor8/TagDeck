
use tauri::Manager;

#[tauri::command]
pub async fn toggle_logs(app: tauri::AppHandle) {
    if let Some(window) = app.get_webview_window("logs") {
        let _ = window.close();
    } else {
        let _ = tauri::WebviewWindowBuilder::new(
            &app,
            "logs",
            tauri::WebviewUrl::App("index.html?page=logs".into())
        )
        .title("Logs")
        .inner_size(800.0, 600.0)
        .build();
    }
}
