use notify::{Config, RecommendedWatcher, RecursiveMode, Watcher};
use std::path::PathBuf;
use std::sync::mpsc::channel;
use std::sync::{Arc, Mutex};
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

        let last_event_time = Arc::new(Mutex::new(Instant::now()));
        // Set initial last_event_time far in past so we don't trigger immediately on loop start if something weird happens 
        // (actually Instant::now() is fine, we compare duration)
        
        // Debounce handling
        // We will just process events and check if enough time has passed since last emit
        // But better: receive event -> wait -> check if more events came -> emit
        
        let last_emit_time = Arc::new(Mutex::new(Instant::now().checked_sub(Duration::from_secs(60)).unwrap()));

        loop {
            match rx.recv() {
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

                            if !is_relevant {
                                // println!("[WATCHER] Ignoring irrelevant file event: {:?}", event.paths); // Too verbose?
                                continue;
                            }

                            // Verbose Logging
                            println!("[WATCHER] Relevant File System Event: {:?}", event);
                            
                            // Check specific kinds of events if needed (Modify, Create)
                            // Usually "Write" or "Modify"
                            
                            let mut last_emit = last_emit_time.lock().unwrap();
                            if last_emit.elapsed() > Duration::from_secs(5) {
                                println!("[WATCHER] Debounce passed. Emitting music-library-changed event.");
                                *last_emit = Instant::now();
                                
                                let _ = app_handle.emit("music-library-changed", ());
                                
                                // Log to App UI
                                let msg = format!("Detected changes in Music Library files. Types: {:?}", event.kind);
                                app_handle.state::<crate::logging::LogState>().add_log("INFO", &msg, &app_handle);
                            } else {
                                println!("[WATCHER] Event ignored due to debounce (occurred {:?} ago)", last_emit.elapsed());
                            }
                        }
                        Err(e) => eprintln!("[WATCHER] Watch error: {:?}", e),
                    }
                }
                Err(e) => {
                    eprintln!("[WATCHER] Watcher channel error: {:?}", e);
                    break;
                }
            }
        }
    });
}
