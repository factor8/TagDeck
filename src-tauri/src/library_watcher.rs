use notify::{Config, RecommendedWatcher, RecursiveMode, Watcher};
use std::path::PathBuf;
use std::sync::mpsc::{channel, RecvTimeoutError};
use std::thread;
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter, Manager};

pub fn start_library_watcher(app: AppHandle) {
    let app_handle = app.clone();
    
    thread::spawn(move || {
        let (tx, rx) = channel();

        // Attempt to create the watcher
        let mut watcher: Box<dyn Watcher> = match RecommendedWatcher::new(tx, Config::default()) {
            Ok(w) => Box::new(w),
            Err(e) => {
                let msg = format!("Failed to create library watcher: {}", e);
                eprintln!("{}", msg);
                // Try logging to app if possible, though this is a startup thread
                return;
            }
        };

        // Determine paths to watch
        let home_dir = dirs::home_dir().unwrap_or(PathBuf::from("/Users/Shared"));
        let music_dir_modern = home_dir.join("Music/Music");
        let music_dir_legacy = home_dir.join("Music/iTunes");
        
        let mut paths_to_watch = Vec::new();
        
        // Modern: ~/Music/Music/Music Library.musiclibrary
        paths_to_watch.push(music_dir_modern.join("Music Library.musiclibrary"));
        // Modern XML: ~/Music/Music/Library.xml
        paths_to_watch.push(music_dir_modern.join("Library.xml"));
        
        // Legacy: ~/Music/iTunes/iTunes Library.xml
        paths_to_watch.push(music_dir_legacy.join("iTunes Library.xml"));
        // Legacy Variation: ~/Music/iTunes/iTunes Music Library.xml (seen in user ls)
        paths_to_watch.push(music_dir_legacy.join("iTunes Music Library.xml"));

        // User Custom Locations (Confimed via lsof)
        let home = dirs::home_dir().unwrap_or(PathBuf::from("/Users/Shared"));
        paths_to_watch.push(home.join("Music/Music 1/Music Library.musiclibrary"));
        
        let mut watching_any = false;

        for path in &paths_to_watch {
            if path.exists() {
               // Use Recursive to catch changes inside .musiclibrary package
               if let Err(e) = watcher.watch(path, RecursiveMode::Recursive) {
                   eprintln!("[WATCHER] Failed to watch path {:?}: {}", path, e);
               } else {
                   println!("[WATCHER] Started watching: {:?}", path);
                   watching_any = true;
               }
            } else {
                // Determine if parent exists to give a hint
                if let Some(parent) = path.parent() {
                    if parent.exists() {
                        println!("[WATCHER] Path not found, but parent exists (watching skipped): {:?}", path);
                    }
                }
            }
        }

        if !watching_any {
            eprintln!("[WATCHER] No Music library files found to watch at standard locations.");
            // Fallback: Watch ~/Music/Music folder directly
            if music_dir_modern.exists() {
                 let _ = watcher.watch(&music_dir_modern, RecursiveMode::Recursive);
                 println!("[WATCHER] Fallback: Watching Music directory: {:?}", music_dir_modern);
            }
        }

        // Trailing Debounce Implementation
        // We wait for an event. Once received, we wait for silence for 'debounce_duration'.
        let debounce_duration = Duration::from_secs(2);
        let mut last_activity: Option<Instant> = None;

        loop {
            // Determine behavior based on whether we have a pending change
            let evt = if last_activity.is_some() {
                 rx.recv_timeout(debounce_duration)
            } else {
                 rx.recv().map_err(|_| RecvTimeoutError::Disconnected)
            };

            match evt {
                Ok(res) => {
                    match res {
                        Ok(event) => {
                            // Filter out noise: Temp files, locks, etc.
                            let is_relevant = event.paths.iter().any(|p| {
                                let s = p.to_string_lossy();
                                // We care about .musiclibrary (directory), .musicdb, .itdb, .xml, .plist
                                // We strictly ignore .tmp, .lock, .log
                                !s.ends_with(".tmp") && !s.ends_with(".lock") && !s.contains(".tmp")
                            });

                            if is_relevant {
                                println!("[WATCHER] Activity detected: {:?} -> Resetting debounce timer.", event.kind);
                                last_activity = Some(Instant::now());
                            }
                        }
                        Err(e) => eprintln!("[WATCHER] Watch error: {:?}", e),
                    }
                }
                Err(RecvTimeoutError::Timeout) => {
                    // Timeout hit! This means 'debounce_duration' passed without new events.
                    if let Some(_) = last_activity {
                        println!("[WATCHER] Debounce silence period reached. Emitting music-library-changed event.");
                        let _ = app_handle.emit("music-library-changed", ());
                        
                        let msg = "Library changes stabilized. Triggering sync.";
                        app_handle.state::<crate::logging::LogState>().add_log("INFO", msg, &app_handle);
                        
                        // Reset
                        last_activity = None;
                    }
                }
                Err(RecvTimeoutError::Disconnected) => {
                    eprintln!("[WATCHER] Channel disconnected. Stopping watcher.");
                    break;
                }
            }
        }
    });
}
