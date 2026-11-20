// ============================================================================
//  storage.rs — перенос AppStorage.cs
//
//  Та же схема: одна таблица settings(key TEXT PRIMARY KEY, value TEXT).
//  Тот же путь: %LOCALAPPDATA%\BearNest\settings.db — значит новая Rust-версия
//  подхватит настройки, уже сохранённые старым C#-клиентом (URL подписки,
//  bypass-домены и т.д.). Если это нежелательно — поменяйте имя папки ниже.
// ============================================================================

use rusqlite::Connection;
use std::path::PathBuf;
use std::sync::Mutex;

pub struct AppStorage {
    conn: Mutex<Connection>,
}

impl AppStorage {
    pub fn new() -> Result<Self, String> {
        let path = db_path();
        if let Some(dir) = path.parent() {
            std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
        }
        let conn = Connection::open(&path).map_err(|e| e.to_string())?;
        conn.execute(
            "CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL)",
            [],
        )
        .map_err(|e| e.to_string())?;
        Ok(AppStorage { conn: Mutex::new(conn) })
    }

    pub fn set(&self, key: &str, value: &str) -> Result<(), String> {
        let conn = self.conn.lock().unwrap();
        conn.execute(
            "INSERT INTO settings (key, value) VALUES (?1, ?2)
             ON CONFLICT(key) DO UPDATE SET value = ?2",
            rusqlite::params![key, value],
        )
        .map_err(|e| e.to_string())?;
        Ok(())
    }

    pub fn get(&self, key: &str) -> Option<String> {
        let conn = self.conn.lock().unwrap();
        conn.query_row(
            "SELECT value FROM settings WHERE key = ?1",
            rusqlite::params![key],
            |row| row.get::<_, String>(0),
        )
        .ok()
    }

    // ── Удобные обёртки (те же ключи, что в C#) ─────────────────────────────
    pub fn get_bool(&self, key: &str, default: bool) -> bool {
        match self.get(key) {
            Some(v) => v == "1" || v == "true",
            None => default,
        }
    }
}

fn db_path() -> PathBuf {
    let base = dirs::data_local_dir().unwrap_or_else(|| PathBuf::from("."));
    base.join("BearNest").join("settings.db")
}
