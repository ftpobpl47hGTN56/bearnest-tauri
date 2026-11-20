// ============================================================================
//  state.rs — глобальное состояние приложения (аналог полей MainWindow).
//  Хранится в Tauri через app.manage(state) и достаётся в командах как
//  State<'_, AppState>.
// ============================================================================

use crate::xcore::CoreManager;
use crate::models::ServerConfig;
use crate::storage::AppStorage;
use crate::tun::TunManager;
use std::path::PathBuf;
use std::sync::atomic::AtomicBool;
use tokio::sync::Mutex;

pub struct AppState {
    pub storage: AppStorage,
    pub core: CoreManager,
    pub tun: Mutex<Option<TunManager>>,
    // Флаг мягкого рестарта (аналог _isSwitching): пока true, отключение xray
    // не считается настоящим разрывом сессии.
    pub is_switching: AtomicBool,
    pub selected: Mutex<Option<ServerConfig>>,

    pub xray_path: PathBuf,
    pub config_path: PathBuf,
    pub tun2socks_path: PathBuf,
}

impl AppState {
    pub fn new(core_dir: PathBuf) -> Result<Self, String> {
        let xray_path = core_dir.join("xray.exe");
        let config_path = core_dir.join("config.json");
        let tun2socks_path = core_dir.join("tun2socks.exe");

        Ok(AppState {
            storage: AppStorage::new()?,
            core: CoreManager::new(xray_path.clone(), config_path.clone()),
            tun: Mutex::new(None),
            is_switching: AtomicBool::new(false),
            selected: Mutex::new(None),
            xray_path,
            config_path,
            tun2socks_path,
        })
    }
}
