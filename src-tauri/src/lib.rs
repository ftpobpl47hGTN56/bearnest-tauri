// ============================================================================
//  lib.rs — точка сборки Tauri-приложения BearNest (Rust-порт).
//
//  • вычисляет папку core\ рядом с exe (там лежат xray.exe, tun2socks.exe,
//    wintun.dll, geoip.dat, geosite.dat — те же файлы, что в C#-версии);
//  • создаёт AppState и регистрирует его;
//  • строит иконку в системном трее с меню (Показать/Подключить/Отключить/Выход);
//  • крестик окна СВОРАЧИВАЕТ в трей (а не выходит) — очистка прокси/TUN
//    происходит только при явном «Выход» из трея (аналог CleanupOnExit).
// ============================================================================

mod commands;
mod config;
mod aumid; // регистрация AppUserModelID для нативных уведомлений Windows
mod notify; // прямая отправка WinRT-тостов + диагностика (notify_native)
mod xcore;
mod models;
mod pinger;
mod logger;
mod portability; // экспорт/импорт настроек и тем через нативный «Проводник»
mod selftest;    // диагностика соединения (self-test через локальный SOCKS)
mod state;
mod storage;
mod subscription;
mod system_proxy;
mod tun;

use state::AppState;
use std::path::PathBuf;
use tauri::{Emitter, Manager};

// Папка core\ ищется рядом с исполняемым файлом; если её там нет
// (например, `cargo run` из корня) — берём ./src-tauri/core или ./core.
fn resolve_core_dir() -> PathBuf {
    if let Ok(exe) = std::env::current_exe() {
        if let Some(dir) = exe.parent() {
            let c = dir.join("core");
            if c.exists() {
                return c;
            }
        }
    }
    for cand in ["src-tauri/core", "core"] {
        let p = PathBuf::from(cand);
        if p.exists() {
            return p;
        }
    }
    PathBuf::from("core")
}

// ── Системный трей ───────────────────────────────────────────────────────────
// Меню на правый клик; левый клик — показать/спрятать окно.
// Пункты «Подключить/Отключить» шлют событие во фронтенд, чтобы переиспользовать
// уже готовую логику doConnect()/doDisconnect() (там выбор сервера, split и т.д.).

fn build_tray(app: &tauri::AppHandle) -> tauri::Result<()> {
    use tauri::menu::{MenuBuilder, MenuItemBuilder};
    use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};

    let show_i = MenuItemBuilder::with_id("show", "Показать окно").build(app)?;
    let connect_i = MenuItemBuilder::with_id("connect", "Подключить").build(app)?;
    let disconnect_i = MenuItemBuilder::with_id("disconnect", "Отключить").build(app)?;
    let quit_i = MenuItemBuilder::with_id("quit", "Выход").build(app)?;

    let menu = MenuBuilder::new(app)
        .item(&show_i)
        .item(&connect_i)
        .item(&disconnect_i)
        .separator()
        .item(&quit_i)
        .build()?;

    let mut builder = TrayIconBuilder::with_id("bearnest-tray")
        .tooltip("BearNest VPN Tauri+Rust v2.10.0")
        .menu(&menu)
        // меню — только на правый клик; левый обрабатываем сами (тоггл окна)
        .show_menu_on_left_click(false)
        .on_menu_event(|app, event| match event.id().as_ref() {
            "show" => {
                if let Some(w) = app.get_webview_window("main") {
                    let _ = w.show();
                    let _ = w.unminimize();
                    let _ = w.set_focus();
                }
            }
            "connect" => {
                let _ = app.emit("tray-connect", ());
            }
            "disconnect" => {
                let _ = app.emit("tray-disconnect", ());
            }
            "quit" => {
                // Настоящий выход: снимаем прокси/TUN и убиваем ядро, затем exit.
                commands::cleanup_blocking(app);
                app.exit(0);
            }
            _ => {}
        })
        .on_tray_icon_event(|tray, event| {
            if let TrayIconEvent::Click {
                button: MouseButton::Left,
                button_state: MouseButtonState::Up,
                ..
            } = event
            {
                let app = tray.app_handle();
                if let Some(w) = app.get_webview_window("main") {
                    if w.is_visible().unwrap_or(false) {
                        let _ = w.hide();
                    } else {
                        let _ = w.show();
                        let _ = w.unminimize();
                        let _ = w.set_focus();
                    }
                }
            }
        });

    // Иконка трея = иконка приложения (из bundle.icon).
    if let Some(icon) = app.default_window_icon().cloned() {
        builder = builder.icon(icon);
    }

    builder.build(app)?;
    Ok(())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]

pub fn run() {
    logger::init(); // первой строкой, до aumid::init()
    let app = tauri::Builder::default() 
        .plugin(tauri_plugin_notification::init())
        .setup(|app| {
            // Регистрируем AppUserModelID (процесс + ярлык в меню «Пуск»),
            // иначе WinRT-тосты не доходят, а приложения нет в списке
            // «Параметры → Система → Уведомления».
            aumid::init("com.bearnestclienttaurirust.vpn");

            let core_dir = resolve_core_dir();
            let st = AppState::new(core_dir).map_err(|e| e.to_string())?;
            app.manage(st);
            build_tray(app.handle())?;

            // Сплеш-заставка: показываем splash 2.5 сек, затем прячем его и
            // открываем главное окно (оно стартует скрытым, visible:false).
            let handle = app.handle().clone();
            tauri::async_runtime::spawn(async move {
                tokio::time::sleep(std::time::Duration::from_millis(2500)).await;
                if let Some(sp) = handle.get_webview_window("splash") {
                    let _ = sp.close();
                }
                if let Some(mn) = handle.get_webview_window("main") {
                    let _ = mn.show();
                    let _ = mn.set_focus();
                }
            });
            Ok(())
        })
        .on_window_event(|window, event| {
            // Крестик [X] у главного и редактора -> прячем в трей/скрываем (окна
            // переиспользуются). Сплеш и прочие окна закрываются по-настоящему.
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                let label = window.label();
                if label == "main" || label == "editor" {
                    api.prevent_close();
                    let _ = window.hide();
                }
            }
        })
        .invoke_handler(tauri::generate_handler![
            commands::connect,
            commands::disconnect,
            commands::switch_server,
            commands::load_subscription,
            commands::ping_server,
            commands::ping_all,
            commands::get_setting,
            commands::set_setting,
            commands::get_physical_interface,
            commands::cleanup_on_exit,
            // ── экспорт/импорт (портируемость настроек и тем) ──
            portability::export_to_file,
            portability::import_from_file,
            // ── диагностика соединения (self-test через локальный SOCKS) ──
            selftest::proxy_selftest,
            // ── нативные уведомления Windows (Action Center) ──
            notify::notify_native,
            notify::notify_diag,
            commands::log_write, // ← если ещё нет
            commands::open_logs_dir,   // ← добавить

        ])
        .build(tauri::generate_context!())
        .expect("error while building BearNest");

        app.run(|_app, event| {
            if let tauri::RunEvent::Exit = event {
                logger::shutdown();
            }
        });
}
