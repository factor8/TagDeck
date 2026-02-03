use std::sync::Mutex;
use tauri::{AppHandle, Emitter};
use serde::{Serialize, Deserialize};
use chrono::Local;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LogEntry {
    pub timestamp: String,
    pub level: String,
    pub message: String,
}

pub struct LogState {
    pub logs: Mutex<Vec<LogEntry>>,
}

impl LogState {
    pub fn new() -> Self {
        Self {
            logs: Mutex::new(Vec::new()),
        }
    }

    pub fn add_log(&self, level: &str, message: &str, app: &AppHandle) {
        let entry = LogEntry {
            timestamp: Local::now().format("%Y-%m-%d %H:%M:%S").to_string(),
            level: level.to_string(),
            message: message.to_string(),
        };

        if let Ok(mut logs) = self.logs.lock() {
            logs.push(entry.clone());
            // Optional: Limit log size
            if logs.len() > 1000 {
                logs.remove(0);
            }
        }

        // Emit event to all windows
        let _ = app.emit("log-event", entry);
    }
}

#[tauri::command]
pub fn get_logs(state: tauri::State<'_, LogState>) -> Vec<LogEntry> {
    state.logs.lock().unwrap().clone()
}

#[tauri::command]
pub fn log_error(message: String, app: AppHandle, state: tauri::State<'_, LogState>) {
    state.add_log("ERROR", &message, &app);
}
