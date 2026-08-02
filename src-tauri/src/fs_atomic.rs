//! Atomic file writes: write to a temp file in the same directory, then
//! rename over the destination, so readers (e.g. Rekordbox) never observe a
//! half-written file.

use std::io;
use std::path::Path;
use std::sync::atomic::{AtomicU64, Ordering};

static TMP_SEQ: AtomicU64 = AtomicU64::new(0);

pub fn atomic_write(path: &Path, contents: &[u8]) -> io::Result<()> {
    if let Some(parent) = path.parent() {
        if !parent.as_os_str().is_empty() {
            std::fs::create_dir_all(parent)?;
        }
    }
    let seq = TMP_SEQ.fetch_add(1, Ordering::Relaxed);
    let tmp = path.with_extension(format!("tagdeck-writing-{}-{}", std::process::id(), seq));
    match std::fs::write(&tmp, contents).and_then(|_| std::fs::rename(&tmp, path)) {
        Ok(()) => Ok(()),
        Err(e) => {
            let _ = std::fs::remove_file(&tmp);
            Err(e)
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn creates_overwrites_and_leaves_no_temp() {
        let dir = std::env::temp_dir().join(format!("tagdeck-aw-{}", std::process::id()));
        let _ = std::fs::create_dir_all(&dir);
        let f = dir.join("out.xml");

        atomic_write(&f, b"one").unwrap();
        assert_eq!(std::fs::read(&f).unwrap(), b"one");

        atomic_write(&f, b"two").unwrap();
        assert_eq!(std::fs::read(&f).unwrap(), b"two");

        let leftover = std::fs::read_dir(&dir)
            .unwrap()
            .filter_map(|e| e.ok())
            .any(|e| e.file_name().to_string_lossy().contains("tagdeck-writing"));
        assert!(!leftover, "no tagdeck-writing* temp file should remain in the dir");

        let _ = std::fs::remove_dir_all(&dir);
    }
}
