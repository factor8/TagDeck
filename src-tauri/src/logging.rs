use std::fs::{self, OpenOptions};
use std::io::Write;
use std::path::PathBuf;
use std::sync::Mutex;
use std::sync::atomic::{AtomicBool, Ordering};
use tauri::{AppHandle, Emitter};
use serde::{Serialize, Deserialize};
use chrono::Local;

/// Maximum size per log file before rotation (~5 MB)
const MAX_LOG_FILE_SIZE: u64 = 5 * 1024 * 1024;
/// Number of rotated log files to keep
const MAX_LOG_FILES: usize = 5;
/// In-memory log buffer cap (shown in the Logs window)
const MAX_MEMORY_LOGS: usize = 2000;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LogEntry {
    pub timestamp: String,
    pub level: String,
    pub message: String,
}

pub struct LogState {
    pub logs: Mutex<Vec<LogEntry>>,
    pub log_dir: Mutex<Option<PathBuf>>,
    pub debug_mode: AtomicBool,
}

impl LogState {
    pub fn new() -> Self {
        Self {
            logs: Mutex::new(Vec::new()),
            log_dir: Mutex::new(None),
            debug_mode: AtomicBool::new(false),
        }
    }

    /// Initialise the persistent log directory.
    /// macOS convention: ~/Library/Logs/<AppName>/
    pub fn init_log_dir(&self) {
        let log_dir = dirs::home_dir()
            .unwrap_or_else(|| PathBuf::from("/tmp"))
            .join("Library/Logs/TagDeck");

        if let Err(e) = fs::create_dir_all(&log_dir) {
            eprintln!("[LogState] Failed to create log directory {:?}: {}", log_dir, e);
            return;
        }

        if let Ok(mut dir) = self.log_dir.lock() {
            *dir = Some(log_dir.clone());
        }

        // Write a startup marker
        self.write_to_file("INFO", &format!(
            "=== TagDeck session started at {} ===",
            Local::now().format("%Y-%m-%d %H:%M:%S %Z")
        ));
    }

    /// The current (active) log file path.
    fn current_log_path(&self) -> Option<PathBuf> {
        self.log_dir.lock().ok()?.as_ref().map(|d| d.join("tagdeck.log"))
    }

    /// Returns the log directory path.
    pub fn get_log_dir(&self) -> Option<PathBuf> {
        self.log_dir.lock().ok()?.clone()
    }

    /// Rotate log files: tagdeck.log → tagdeck.1.log → tagdeck.2.log → …
    fn rotate_if_needed(&self) {
        let Some(current) = self.current_log_path() else { return };
        let file_size = fs::metadata(&current).map(|m| m.len()).unwrap_or(0);
        if file_size < MAX_LOG_FILE_SIZE {
            return;
        }

        let Some(dir) = self.get_log_dir() else { return };

        // Shift existing rotated files
        for i in (1..MAX_LOG_FILES).rev() {
            let from = dir.join(format!("tagdeck.{}.log", i));
            let to = dir.join(format!("tagdeck.{}.log", i + 1));
            let _ = fs::rename(&from, &to);
        }
        // Rotate current → .1
        let _ = fs::rename(&current, dir.join("tagdeck.1.log"));
    }

    /// Append a formatted line to the persistent log file.
    fn write_to_file(&self, level: &str, message: &str) {
        self.rotate_if_needed();
        let Some(path) = self.current_log_path() else { return };

        let line = format!(
            "[{}] [{}] {}\n",
            Local::now().format("%Y-%m-%d %H:%M:%S%.3f"),
            level,
            message
        );

        if let Ok(mut file) = OpenOptions::new().create(true).append(true).open(&path) {
            let _ = file.write_all(line.as_bytes());
        }
    }

    /// Core logging method — writes to memory, file, and emits to frontend.
    pub fn add_log(&self, level: &str, message: &str, app: &AppHandle) {
        // Skip DEBUG messages if debug mode is off
        if level == "DEBUG" && !self.debug_mode.load(Ordering::Relaxed) {
            return;
        }

        let entry = LogEntry {
            timestamp: Local::now().format("%Y-%m-%d %H:%M:%S").to_string(),
            level: level.to_string(),
            message: message.to_string(),
        };

        // In-memory buffer (for Logs window)
        if let Ok(mut logs) = self.logs.lock() {
            logs.push(entry.clone());
            if logs.len() > MAX_MEMORY_LOGS {
                let drain_count = MAX_MEMORY_LOGS / 5;
                logs.drain(..drain_count);
            }
        }

        // Persistent file
        self.write_to_file(level, message);

        // Emit to any open Logs window
        let _ = app.emit("log-event", entry);
    }

    pub fn is_debug(&self) -> bool {
        self.debug_mode.load(Ordering::Relaxed)
    }

    pub fn set_debug(&self, enabled: bool) {
        self.debug_mode.store(enabled, Ordering::Relaxed);
    }
}

// ─── Tauri Commands ──────────────────────────────────────────────

#[tauri::command]
pub fn get_logs(state: tauri::State<'_, LogState>) -> Vec<LogEntry> {
    state.logs.lock().unwrap_or_else(|e| e.into_inner()).clone()
}

#[tauri::command]
pub fn log_error(message: String, app: AppHandle, state: tauri::State<'_, LogState>) {
    state.add_log("ERROR", &message, &app);
}

#[tauri::command]
pub fn log_from_frontend(level: String, message: String, app: AppHandle, state: tauri::State<'_, LogState>) {
    let valid_level = match level.to_uppercase().as_str() {
        "ERROR" | "WARN" | "INFO" | "DEBUG" => level.to_uppercase(),
        _ => "INFO".to_string(),
    };
    state.add_log(&valid_level, &format!("[Frontend] {}", message), &app);
}

#[tauri::command]
pub fn get_debug_mode(state: tauri::State<'_, LogState>) -> bool {
    state.is_debug()
}

#[tauri::command]
pub fn set_debug_mode(enabled: bool, app: AppHandle, state: tauri::State<'_, LogState>) {
    let was = state.is_debug();
    state.set_debug(enabled);
    if was != enabled {
        state.add_log(
            "INFO",
            &format!("Debug mode {}", if enabled { "ENABLED" } else { "DISABLED" }),
            &app,
        );
    }
}

#[tauri::command]
pub fn open_log_folder(state: tauri::State<'_, LogState>) -> Result<(), String> {
    let dir = state.get_log_dir().ok_or("Log directory not initialised")?;
    #[cfg(target_os = "macos")]
    {
        std::process::Command::new("open")
            .arg(&dir)
            .spawn()
            .map_err(|e| format!("Failed to open log folder: {}", e))?;
    }
    Ok(())
}

#[tauri::command]
pub fn get_log_file_path(state: tauri::State<'_, LogState>) -> Option<String> {
    state.current_log_path().map(|p| p.to_string_lossy().to_string())
}

/// Convenience: collect log file stats for the Settings panel
#[derive(Serialize)]
pub struct LogStats {
    pub log_dir: String,
    pub total_size_bytes: u64,
    pub file_count: usize,
    pub current_file_size_bytes: u64,
}

#[tauri::command]
pub fn get_log_stats(state: tauri::State<'_, LogState>) -> Option<LogStats> {
    let dir = state.get_log_dir()?;
    let current_path = state.current_log_path()?;

    let mut total_size: u64 = 0;
    let mut file_count: usize = 0;

    if let Ok(entries) = fs::read_dir(&dir) {
        for entry in entries.flatten() {
            if let Ok(meta) = entry.metadata() {
                if meta.is_file() {
                    total_size += meta.len();
                    file_count += 1;
                }
            }
        }
    }

    let current_size = fs::metadata(&current_path).map(|m| m.len()).unwrap_or(0);

    Some(LogStats {
        log_dir: dir.to_string_lossy().to_string(),
        total_size_bytes: total_size,
        file_count,
        current_file_size_bytes: current_size,
    })
}
