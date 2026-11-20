// ============================================================================
//  notify.rs — нативные уведомления Windows (Action Center / «тост» справа
//  внизу экрана) напрямую через WinRT, минуя JS-плагин.
//
//  Зачем отдельный путь: window.__TAURI__.notification в withGlobalTauri-
//  сборке может отсутствовать, и тогда фронтенд молча не шлёт ни одного
//  тоста — а Windows добавляет приложение в «Параметры → Уведомления»
//  только ПОСЛЕ первого реального уведомления. Здесь тост отправляет сам
//  Rust-процесс через tauri-winrt-notification от имени нашего AUMID
//  (ярлык с System.AppUserModel.ID создаёт aumid.rs при старте).
//
//  Дополнительно ведём диагностический лог %LOCALAPPDATA%\BearNest\notif.log:
//  туда пишется и создание ярлыка (из aumid.rs), и результат каждого тоста.
// ============================================================================

use std::path::PathBuf;

/// AppUserModelID — должен совпадать с identifier в tauri.conf.json
/// и с тем, что aumid::init() пишет в ярлык меню «Пуск».
#[cfg(windows)]
const AUMID: &str = "com.bearnestclienttaurirust.vpn";

/// Путь диагностического лога уведомлений.
pub fn log_path() -> PathBuf {
    dirs::data_local_dir()
        .unwrap_or_else(|| PathBuf::from("."))
        .join("BearNest")
        .join("notif.log")
}

/// Дописать строку в диагностический лог (создаёт папку при первом вызове).
pub fn log_line(msg: &str) {
    use std::io::Write;
    let p = log_path();
    if let Some(dir) = p.parent() {
        let _ = std::fs::create_dir_all(dir);
    }
    if let Ok(mut f) = std::fs::OpenOptions::new().create(true).append(true).open(&p) {
        let secs = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_secs())
            .unwrap_or(0);
        let _ = writeln!(f, "[{secs}] {msg}");
    }
}

/// Отправить нативный тост Windows. Вызывается из фронтенда вместо
/// T.notification.sendNotification (который может отсутствовать в рантайме).
#[tauri::command]
pub fn notify_native(title: String, body: String) -> Result<(), String> {
    #[cfg(windows)]
    {
        use tauri_winrt_notification::{Sound, Toast};
        let r = Toast::new(AUMID)
            .title(&title)
            .text1(&body)
            .sound(Some(Sound::Default))
            .show();
        match r {
            Ok(_) => {
                log_line(&format!("toast OK: {title} | {body}"));
                Ok(())
            }
            Err(e) => {
                let m = e.to_string();
                log_line(&format!("toast ERR: {m} ({title} | {body})"));
                Err(m)
            }
        }
    }
    #[cfg(not(windows))]
    {
        let _ = (title, body);
        Ok(())
    }
}

/// Диагностика для отладки «почему нет уведомлений»:
/// существует ли ярлык с AUMID + хвост лога тостов.
#[tauri::command]
pub fn notify_diag() -> String {
    let mut out = String::new();
    let lnk = dirs::data_dir()
        .unwrap_or_default()
        .join("Microsoft")
        .join("Windows")
        .join("Start Menu")
        .join("Programs")
        .join("BearNest VPN.lnk");
    out.push_str(&format!("shortcut {} exists={}\n", lnk.display(), lnk.exists()));
    out.push_str(&format!("log {}\n", log_path().display()));
    match std::fs::read_to_string(log_path()) {
        Ok(s) => {
            let tail: Vec<&str> = s.lines().rev().take(20).collect();
            for l in tail.iter().rev() {
                out.push_str(l);
                out.push('\n');
            }
        }
        Err(e) => out.push_str(&format!("(лога пока нет: {e})\n")),
    }
    out
}
