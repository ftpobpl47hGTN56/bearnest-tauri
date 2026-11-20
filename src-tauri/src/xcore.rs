// ============================================================================
//  core.rs — перенос CoreManager.cs
//
//  Управляет процессом xray: запуск, чтение stdout/stderr построчно (иначе
//  переполнение буфера процесса → deadlock, как отмечено в оригинале),
//  корректная остановка, аварийное убийство при закрытии приложения.
//
//  Логи и смена статуса отдаются наружу через колбэки (LogFn / StatusFn),
//  которые в commands.rs завёрнуты в app.emit("log"/"status"). Так core.rs
//  не зависит от Tauri напрямую.
// ============================================================================

use std::path::PathBuf;
use std::sync::Arc;
use tokio::io::{AsyncBufReadExt, BufReader};
use tokio::process::{Child, Command};
use tokio::sync::Mutex;

pub type LogFn = Arc<dyn Fn(String) + Send + Sync>;
pub type StatusFn = Arc<dyn Fn(bool) + Send + Sync>;

pub struct CoreManager {
    xray_path: PathBuf,
    config_path: PathBuf,
    child: Mutex<Option<Child>>,
}

impl CoreManager {
    pub fn new(xray_path: PathBuf, config_path: PathBuf) -> Self {
        CoreManager {
            xray_path,
            config_path,
            child: Mutex::new(None),
        }
    }

    pub async fn is_running(&self) -> bool {
        let mut guard = self.child.lock().await;
        if let Some(ch) = guard.as_mut() {
            // try_wait() == Ok(None) → всё ещё работает
            matches!(ch.try_wait(), Ok(None))
        } else {
            false
        }
    }

    // ── ЗАПУСК (порт StartAsync) ────────────────────────────────────────────
    pub async fn start(&self, log: LogFn, status: StatusFn) {
        if self.is_running().await {
            return;
        }

        // Убиваем зависшие процессы xray, чтобы освободить порт 19808
        kill_zombies();
        tokio::time::sleep(std::time::Duration::from_millis(300)).await;

        let mut cmd = Command::new(&self.xray_path);
        cmd.arg("run")
            .arg("-c")
            .arg(&self.config_path)
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::piped());
        no_window(&mut cmd);

        let mut child = match cmd.spawn() {
            Ok(c) => c,
            Err(e) => {
                log(format!("[BearNest] Не удалось запустить xray: {e}"));
                status(false);
                return;
            }
        };

        // Асинхронно читаем stdout и stderr
        if let Some(out) = child.stdout.take() {
            let log = log.clone();
            tokio::spawn(async move {
                let mut lines = BufReader::new(out).lines();
                while let Ok(Some(line)) = lines.next_line().await {
                    log(line);
                }
            });
        }
        if let Some(err) = child.stderr.take() {
            let log = log.clone();
            tokio::spawn(async move {
                let mut lines = BufReader::new(err).lines();
                while let Ok(Some(line)) = lines.next_line().await {
                    log(line);
                }
            });
        }

        {
            let mut guard = self.child.lock().await;
            *guard = Some(child);
        }

        // Ждём 500 мс и проверяем — не упал ли xray сразу (порт занят и т.п.)
        tokio::time::sleep(std::time::Duration::from_millis(500)).await;

        let exited = {
            let mut guard = self.child.lock().await;
            match guard.as_mut() {
                Some(ch) => matches!(ch.try_wait(), Ok(Some(_))),
                None => true,
            }
        };

        if exited {
            log("[BearNest] Xray упал сразу после старта (порт занят?)".into());
            status(false);
            return;
        }

        status(true);
        log("[BearNest] Xray process started.".into());
    }

    // ── ОСТАНОВКА (порт StopAsync) ──────────────────────────────────────────
    pub async fn stop(&self, status: StatusFn) {
        {
            let mut guard = self.child.lock().await;
            if let Some(mut ch) = guard.take() {
                let _ = ch.kill().await;
                let _ = ch.wait().await;
            }
        }
        status(false);
    }

    // ── АВАРИЙНОЕ УБИЙСТВО (порт KillImmediate) ─────────────────────────────
    pub async fn kill_immediate(&self) {
        let mut guard = self.child.lock().await;
        if let Some(mut ch) = guard.take() {
            let _ = ch.start_kill();
        }
        kill_zombies();
    }
}

// ── Платформенные хелперы ────────────────────────────────────────────────────

// CREATE_NO_WINDOW — чтобы не мигало консольное окно xray.
#[cfg(windows)]
fn no_window(cmd: &mut Command) {
    // tokio::process::Command имеет собственный creation_flags на Windows.
    const CREATE_NO_WINDOW: u32 = 0x0800_0000;
    cmd.creation_flags(CREATE_NO_WINDOW);
}
#[cfg(not(windows))]
fn no_window(_cmd: &mut Command) {}

// Убить зависшие xray.exe, чтобы освободить SOCKS-порт.
#[cfg(windows)]
fn kill_zombies() {
    use std::os::windows::process::CommandExt;
    const CREATE_NO_WINDOW: u32 = 0x0800_0000;
    let _ = std::process::Command::new("taskkill")
        .args(["/F", "/IM", "xray.exe"])
        .creation_flags(CREATE_NO_WINDOW)
        .output();
}
#[cfg(not(windows))]
fn kill_zombies() {
    let _ = std::process::Command::new("pkill").arg("-x").arg("xray").output();
}
