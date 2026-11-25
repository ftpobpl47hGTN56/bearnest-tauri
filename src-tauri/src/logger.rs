// Порт RollingLogger.cs: %LOCALAPPDATA%\BearNest\logs\bearnest_*.log, 8000 строк на файл, 10 файлов.
// C:\Users\gullampis810\AppData\Local\BearNest

use chrono::Local;
use std::fs::{self, File};
use std::io::Write;
use std::path::PathBuf;
use std::sync::{Mutex, OnceLock};

// const MAX_BYTES: убираем  не используется больше
// const MAX_BYTES: u64 = 700 * 1024; // ≈ 8000 строк
const MAX_FILES: usize = 10;

const MAX_LINES: usize = 8000;

struct Inner { file: Option<File>, lines: usize }
static LOGGER: OnceLock<Mutex<Inner>> = OnceLock::new();

pub fn log_dir() -> PathBuf {
    dirs::data_local_dir().unwrap_or_else(|| PathBuf::from("."))
        .join("BearNest").join("logs")
}

fn log_files() -> Vec<PathBuf> {
    let mut v: Vec<PathBuf> = fs::read_dir(log_dir()).into_iter().flatten().flatten()
        .map(|e| e.path())
        .filter(|p| p.file_name().and_then(|n| n.to_str())
            .map_or(false, |n| n.starts_with("bearnest_") && n.ends_with(".log")))
        .collect();
    v.sort();
    v
}

// оставляем не больше `keep` старых файлов
fn prune(keep: usize) {
    let mut f = log_files();
    while f.len() > keep {
        let _ = fs::remove_file(f.remove(0));
    }
}

fn open_new() -> Option<File> {
    prune(MAX_FILES - 1); // место под новый файл
    let name = format!("bearnest_{}.log", Local::now().format("%Y%m%d_%H%M%S"));
    File::create(log_dir().join(name)).ok()
}

pub fn init() {
    if let Err(e) = fs::create_dir_all(log_dir()) {
        eprintln!("log dir error: {e}");
    }
    LOGGER.get_or_init(|| {
        prune(MAX_FILES - 1);
        let name = format!("bearnest_{}.log", Local::now().format("%Y%m%d_%H%M%S"));
        let path = log_dir().join(&name);
        let file = match File::create(&path) {
            Ok(f) => Some(f),
            Err(e) => { eprintln!("log create error {path:?}: {e}"); None }
        };
        Mutex::new(Inner { file, lines: 0 })
    });
    write(&format!("=== START v{} | pid {} ===", env!("CARGO_PKG_VERSION"), std::process::id()));

    std::panic::set_hook(Box::new(|info| {
        write(&format!("PANIC: {info}"));
    }));
}

pub fn shutdown() {
    write("=== EXIT ===");
}

pub fn write(line: &str) {
    let Some(m) = LOGGER.get() else { return };
    let Ok(mut g) = m.lock() else { return };
    if g.lines >= MAX_LINES {
        g.file = open_new();
        g.lines = 0;
    }
    let entry = format!("[{}] {}\n", Local::now().format("%Y-%m-%d %H:%M:%S"), line);
    if let Some(f) = g.file.as_mut() {
        if f.write_all(entry.as_bytes()).is_ok() {
            let _ = f.flush();
            g.lines += 1;
        }
    }
}