// ============================================================================
//  commands.rs — оркестрация, перенос ключевых методов MainWindow.xaml.cs:
//    ConnectAsync, DisconnectAsync, SwitchToServerDirectAsync (мягкий рестарт),
//    LoadSubscriptionAsync, BtnPing, GetPhysicalInterfaceName, CleanupOnExit.
//
//  Все команды вызываются из фронтенда через invoke("...").
//  Логи и статус уходят на фронтенд событиями app.emit("log"/"status").
// ============================================================================

use crate::xcore::{LogFn, StatusFn};
use crate::models::{ServerConfig, SplitTunnelSettings, SubscriptionInfo};
use crate::state::AppState;
use crate::tun::TunManager;
use crate::{config, pinger, subscription, system_proxy};
use std::sync::atomic::Ordering;
use std::sync::Arc;
use tauri::{AppHandle, Emitter, Manager, State};

const PROXY_HOST: &str = "127.0.0.1";
const PROXY_PORT: u16 = 19809; // HTTP-inbound (как в C#)
const SOCKS_PORT: u16 = 19808;

// ── Колбэки эмита событий на фронтенд ────────────────────────────────────────
fn log_sink(app: &AppHandle) -> LogFn {
    let app = app.clone();
   Arc::new(move |line: String| {
        crate::logger::write(&line); // ← новое
        let _ = app.emit("log", line);
    })
}
fn status_sink(app: &AppHandle) -> StatusFn {
    let app = app.clone();
    Arc::new(move |running: bool| {
        let _ = app.emit("status", running);
    })
}
fn noop_status() -> StatusFn {
    Arc::new(|_running: bool| {})
}

// ── ПОДКЛЮЧЕНИЕ (порт ConnectAsync) ──────────────────────────────────────────
#[tauri::command]
pub async fn connect(
    app: AppHandle,
    state: State<'_, AppState>,
    server: ServerConfig,
    split: SplitTunnelSettings,
) -> Result<(), String> {
    let log = log_sink(&app);
    let status = status_sink(&app);

    // 1. Генерируем и пишем конфиг
    let json = config::generate(&server, Some(&split));
    std::fs::write(&state.config_path, json).map_err(|e| e.to_string())?;
    log(format!("[BearNest] Подключение: {}", server.name));

    // 2. Стартуем ядро
    state.core.start(log.clone(), status.clone()).await;
    tokio::time::sleep(std::time::Duration::from_millis(800)).await;

    // 3. Развилка: TUN или системный прокси
    if split.tun_mode {
        let tun = TunManager::new(state.tun2socks_path.clone());
        match tun.start(&server.address, SOCKS_PORT, log.clone()).await {
            Ok(_) => {
                *state.tun.lock().await = Some(tun);
                let _ = app.emit("tun-status", "🌐 TUN активен");
            }
            Err(e) => {
                log(format!("[BearNest] ❌ Не удалось поднять TUN: {e}"));
                // Откат на системный прокси, чтобы юзер не остался без VPN
                system_proxy::enable(PROXY_HOST, PROXY_PORT);
                let _ = app.emit("tun-status", "⚠️ TUN упал → прокси");
            }
        }
    } else {
        system_proxy::enable(PROXY_HOST, PROXY_PORT);
        log(format!("[BearNest] Прокси включён: {PROXY_HOST}:{PROXY_PORT}"));
    }

    *state.selected.lock().await = Some(server);
    Ok(())
}

// ── ОТКЛЮЧЕНИЕ (порт DisconnectAsync) ────────────────────────────────────────
#[tauri::command]
pub async fn disconnect(app: AppHandle, state: State<'_, AppState>) -> Result<(), String> {
    let log = log_sink(&app);
    let status = status_sink(&app);

    // ВАЖНО: TUN гасим ПЕРВЫМ, иначе трафик уйдёт в мёртвый SOCKS-порт и
    // система на пару секунд останется без интернета.
    if let Some(tun) = state.tun.lock().await.take() {
        tun.stop(log.clone()).await;
        let _ = app.emit("tun-status", "");
    }

    system_proxy::disable();
    log("[BearNest] Прокси выключен".into());
    state.core.stop(status).await;
    *state.selected.lock().await = None;
    Ok(())
}

// ── СМЕНА СЕРВЕРА С МЯГКИМ РЕСТАРТОМ (порт SwitchToServerDirectAsync) ─────────
// Ключевой приём: во время рестарта status(false) НЕ эмитим (noop_status),
// поэтому фронтенд не гасит таймер сессии и не считает это отключением.
#[tauri::command]
pub async fn switch_server(
    app: AppHandle,
    state: State<'_, AppState>,
    server: ServerConfig,
    split: SplitTunnelSettings,
) -> Result<(), String> {
    let log = log_sink(&app);
    let status = status_sink(&app);

    state.is_switching.store(true, Ordering::SeqCst);
    log(format!("[BearNest] ⇄ Переключение на: {}", server.name));

    // У нового сервера другой IP → старый прямой маршрут не годится.
    // Гасим TUN до рестарта, поднимем заново после.
    let tun_was_active = {
        let mut g = state.tun.lock().await;
        if let Some(tun) = g.take() {
            tun.stop(log.clone()).await;
            true
        } else {
            false
        }
    };

    // Пишем новый конфиг и делаем мягкий рестарт xray
    let json = config::generate(&server, Some(&split));
    std::fs::write(&state.config_path, json).map_err(|e| e.to_string())?;

    state.core.stop(noop_status()).await; // не эмитим "выключено"
    tokio::time::sleep(std::time::Duration::from_millis(300)).await;
    state.core.start(log.clone(), status).await;

    state.is_switching.store(false, Ordering::SeqCst);

    // Поднимаем TUN обратно уже с новым адресом сервера
    if tun_was_active {
        tokio::time::sleep(std::time::Duration::from_millis(500)).await;
        let tun = TunManager::new(state.tun2socks_path.clone());
        match tun.start(&server.address, SOCKS_PORT, log.clone()).await {
            Ok(_) => {
                *state.tun.lock().await = Some(tun);
                let _ = app.emit("tun-status", "🌐 TUN активен");
            }
            Err(e) => log(format!("[BearNest] ❌ TUN не поднялся после смены: {e}")),
        }
    }

    let name = server.name.clone();
    *state.selected.lock().await = Some(server);
    let _ = app.emit("toast", serde_json::json!({ "icon": "✅", "message": format!("Переключено: {name}") }));
    Ok(())
}

// ── ЗАГРУЗКА ПОДПИСКИ (порт LoadSubscriptionAsync) ───────────────────────────
#[derive(serde::Serialize)]
pub struct SubResult {
    pub servers: Vec<ServerConfig>,
    pub info: SubscriptionInfo,
}

#[tauri::command]
pub async fn load_subscription(url: String, use_proxy: bool) -> Result<SubResult, String> {
    let proxy_port = if use_proxy { SOCKS_PORT } else { 0 };
    let (content, info) = subscription::download_with_info(&url, proxy_port).await?;
    let servers = subscription::parse(&content);
    if servers.is_empty() {
        return Err("Подписка распарсилась, но серверов не найдено".into());
    }
    Ok(SubResult { servers, info })
}

// ── ПИНГ (порт BtnPing / PingAllAsync) ───────────────────────────────────────
#[tauri::command]
pub async fn ping_server(address: String, port: u16) -> i64 {
    tokio::task::spawn_blocking(move || pinger::ping(&address, port))
        .await
        .unwrap_or(-2)
}

#[tauri::command]
pub async fn ping_all(servers: Vec<(String, u16)>) -> Vec<i64> {
    tokio::task::spawn_blocking(move || pinger::ping_all(&servers))
        .await
        .unwrap_or_default()
}

// ── НАСТРОЙКИ (порт AppStorage-обёрток) ──────────────────────────────────────
#[tauri::command]
pub fn get_setting(state: State<'_, AppState>, key: String) -> Option<String> {
    state.storage.get(&key)
}

#[tauri::command]
pub fn set_setting(state: State<'_, AppState>, key: String, value: String) -> Result<(), String> {
    state.storage.set(&key, &value)
}

// ── ФИЗИЧЕСКИЙ АДАПТЕР (порт GetPhysicalInterfaceName) ────────────────────────
#[tauri::command]
pub async fn get_physical_interface() -> String {
    physical_interface_name().await
}

#[cfg(windows)]
async fn physical_interface_name() -> String {
    let ps = "(Get-NetRoute -DestinationPrefix '0.0.0.0/0' -ErrorAction SilentlyContinue | \
              Where-Object { $_.InterfaceAlias -notlike '*BearNest*' -and $_.InterfaceAlias -notlike '*Wintun*' } | \
              Sort-Object RouteMetric | Select-Object -First 1).InterfaceAlias";
    use tokio::process::Command;
    const CREATE_NO_WINDOW: u32 = 0x0800_0000;
    let out = Command::new("powershell")
        .args(["-NoProfile", "-Command", ps])
        .creation_flags(CREATE_NO_WINDOW)
        .output()
        .await;
    match out {
        Ok(o) => String::from_utf8_lossy(&o.stdout).trim().to_string(),
        Err(_) => String::new(),
    }
}

#[cfg(not(windows))]
async fn physical_interface_name() -> String {
    String::new()
}

// ── АВАРИЙНАЯ ОЧИСТКА ПРИ ВЫХОДЕ (порт CleanupOnExit) ────────────────────────
#[tauri::command]
pub async fn cleanup_on_exit(app: AppHandle, state: State<'_, AppState>) -> Result<(), String> {
    let log = log_sink(&app);
    if let Some(tun) = state.tun.lock().await.take() {
        tun.stop(log).await;
    }
    system_proxy::disable();
    state.core.kill_immediate().await;
    Ok(())
}

// Синхронная версия для хука закрытия окна (когда async уже недоступен).
pub fn cleanup_blocking(app: &AppHandle) {
    system_proxy::disable();
    if let Some(state) = app.try_state::<AppState>() {
        // TUN-маршруты снимаем синхронно через route delete
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            const CREATE_NO_WINDOW: u32 = 0x0800_0000;
            let run = |a: &str| {
                let _ = std::process::Command::new("cmd.exe")
                    .args(["/c", a])
                    .creation_flags(CREATE_NO_WINDOW)
                    .output();
            };
            run("route delete 0.0.0.0 mask 128.0.0.0");
            run("route delete 128.0.0.0 mask 128.0.0.0");
            let _ = std::process::Command::new("taskkill")
                .args(["/F", "/IM", "xray.exe"])
                .creation_flags(CREATE_NO_WINDOW)
                .output();
            let _ = std::process::Command::new("taskkill")
                .args(["/F", "/IM", "tun2socks.exe"])
                .creation_flags(CREATE_NO_WINDOW)
                .output();
        }
        let _ = &state; // подавляем предупреждение о неиспользовании на не-Windows
    }
}

// строки, которые родились во фронтенде (self-test и т.п.)
#[tauri::command]
pub fn log_write(line: String) { crate::logger::write(&line); }

#[tauri::command]
pub fn open_logs_dir() -> Result<(), String> {
    let dir = crate::logger::log_dir();
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    std::process::Command::new("explorer.exe").arg(dir).spawn().map_err(|e| e.to_string())?;
    Ok(())
}