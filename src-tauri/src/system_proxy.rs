// ============================================================================
//  system_proxy.rs — перенос SystemProxy.cs
//
//  Включает/выключает системный прокси через реестр
//  HKCU\...\Internet Settings и немедленно применяет изменения через
//  InternetSetOption (WinINet), иначе браузер не увидит новых настроек.
//
//  На не-Windows платформах — пустые заглушки, чтобы проект собирался
//  для проверки логики. Рабочая цель — Windows.
// ============================================================================

#[cfg(windows)]
mod imp {
    use winreg::enums::*;
    use winreg::RegKey;

    const INTERNET_SETTINGS: &str =
        r"Software\Microsoft\Windows\CurrentVersion\Internet Settings";

    // InternetSetOption из wininet.dll
    #[link(name = "wininet")]
    extern "system" {
        fn InternetSetOptionW(
            h_internet: *mut std::ffi::c_void,
            dw_option: u32,
            lp_buffer: *mut std::ffi::c_void,
            dw_buffer_length: u32,
        ) -> i32;
    }

    const INTERNET_OPTION_SETTINGS_CHANGED: u32 = 39;
    const INTERNET_OPTION_REFRESH: u32 = 37;

    fn refresh() {
        unsafe {
            InternetSetOptionW(std::ptr::null_mut(), INTERNET_OPTION_SETTINGS_CHANGED, std::ptr::null_mut(), 0);
            InternetSetOptionW(std::ptr::null_mut(), INTERNET_OPTION_REFRESH, std::ptr::null_mut(), 0);
        }
    }

    pub fn enable(host: &str, port: u16) {
        let hkcu = RegKey::predef(HKEY_CURRENT_USER);
        if let Ok(key) = hkcu.open_subkey_with_flags(INTERNET_SETTINGS, KEY_SET_VALUE) {
            let _ = key.set_value("ProxyEnable", &1u32);
            let _ = key.set_value("ProxyServer", &format!("{host}:{port}"));
            let _ = key.set_value(
                "ProxyOverride",
                &"localhost;127.*;10.*;172.16.*;192.168.*;<local>".to_string(),
            );
            refresh();
        }
    }

    pub fn disable() {
        let hkcu = RegKey::predef(HKEY_CURRENT_USER);
        if let Ok(key) = hkcu.open_subkey_with_flags(INTERNET_SETTINGS, KEY_SET_VALUE) {
            let _ = key.set_value("ProxyEnable", &0u32);
            refresh();
        }
    }

    pub fn is_enabled() -> bool {
        let hkcu = RegKey::predef(HKEY_CURRENT_USER);
        hkcu.open_subkey(INTERNET_SETTINGS)
            .and_then(|k| k.get_value::<u32, _>("ProxyEnable"))
            .map(|v| v == 1)
            .unwrap_or(false)
    }
}

#[cfg(not(windows))]
mod imp {
    pub fn enable(_host: &str, _port: u16) {}
    pub fn disable() {}
    pub fn is_enabled() -> bool { false }
}

pub use imp::{disable, enable, is_enabled};
