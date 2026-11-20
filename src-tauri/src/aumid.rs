// ============================================================================
//  aumid.rs — регистрация AppUserModelID для нативных уведомлений Windows.
//
//  WinRT-тосты (tauri-plugin-notification) отправляются от имени AUMID =
//  identifier из tauri.conf.json ("com.bearnestclienttaurirust.vpn").
//  Чтобы Windows приняла тост и показала BearNest в
//  «Параметры → Система → Уведомления», нужен ярлык в меню «Пуск»
//  со свойством System.AppUserModel.ID = наш AUMID.
//
//  Поэтому при старте:
//    1) назначаем процессу AUMID (SetCurrentProcessExplicitAppUserModelID);
//    2) создаём/обновляем ярлык "BearNest VPN.lnk" в пользовательском
//       Start Menu\Programs через IShellLinkW + IPropertyStore (COM).
// ============================================================================

#[cfg(windows)]
pub fn init(app_id: &str) {
    crate::notify::log_line(&format!("aumid init: {app_id}"));
    set_process_aumid(app_id);
    match ensure_shortcut(app_id) {
        Ok(_) => crate::notify::log_line("aumid shortcut OK"),
        Err(e) => {
            crate::notify::log_line(&format!("aumid shortcut ERR: {e}"));
            eprintln!("[BearNest] AUMID shortcut: {e}");
        }
    }
}

#[cfg(not(windows))]
pub fn init(_app_id: &str) {}

#[cfg(windows)]
fn set_process_aumid(app_id: &str) {
    use windows::core::HSTRING;
    use windows::Win32::UI::Shell::SetCurrentProcessExplicitAppUserModelID;
    unsafe {
        let _ = SetCurrentProcessExplicitAppUserModelID(&HSTRING::from(app_id));
    }
}

#[cfg(windows)]
fn ensure_shortcut(app_id: &str) -> Result<(), String> {
    use windows::core::{HSTRING, Interface, PWSTR};
    use windows::Win32::Storage::EnhancedStorage::PKEY_AppUserModel_ID;
    use windows::Win32::System::Com::StructuredStorage::{
        PROPVARIANT, PROPVARIANT_0, PROPVARIANT_0_0,
    };
    use windows::Win32::System::Com::{
        CoCreateInstance, CoInitializeEx, CoTaskMemAlloc, CLSCTX_INPROC_SERVER,
        COINIT_APARTMENTTHREADED, IPersistFile,
    };
    use windows::Win32::System::Variant::VT_LPWSTR;
    use windows::Win32::UI::Shell::PropertiesSystem::IPropertyStore;
    use windows::Win32::UI::Shell::{IShellLinkW, ShellLink};

    // Пути: exe и ярлык в пользовательском меню «Пуск»
    let exe = std::env::current_exe().map_err(|e| e.to_string())?;
    let start = dirs::data_dir()
        .ok_or("no APPDATA")?
        .join("Microsoft")
        .join("Windows")
        .join("Start Menu")
        .join("Programs");
    std::fs::create_dir_all(&start).map_err(|e| e.to_string())?;
    let link = start.join("BearNest VPN.lnk");

    unsafe {
        // S_FALSE (уже инициализировано) тоже считается успехом
        let _ = CoInitializeEx(None, COINIT_APARTMENTTHREADED);

        let shell_link: IShellLinkW =
            CoCreateInstance(&ShellLink, None, CLSCTX_INPROC_SERVER).map_err(|e| e.to_string())?;

        let exe_w = HSTRING::from(exe.as_os_str());
        shell_link.SetPath(&exe_w).map_err(|e| e.to_string())?;
        if let Some(dir) = exe.parent() {
            let _ = shell_link.SetWorkingDirectory(&HSTRING::from(dir.as_os_str()));
        }

        // System.AppUserModel.ID = AUMID (VT_LPWSTR в PROPVARIANT)
        let store: IPropertyStore = shell_link.cast().map_err(|e| e.to_string())?;
        let id_w: Vec<u16> = app_id.encode_utf16().chain(Some(0)).collect();
        let mem = CoTaskMemAlloc(id_w.len() * std::mem::size_of::<u16>());
        if mem.is_null() {
            return Err("CoTaskMemAlloc failed".into());
        }
        std::ptr::copy_nonoverlapping(id_w.as_ptr(), mem as *mut u16, id_w.len());

        let mut pv: PROPVARIANT = std::mem::zeroed();
        {
            let inner = &mut *pv.Anonymous.Anonymous; // ManuallyDrop → DerefMut
            inner.vt = VT_LPWSTR;
            inner.Anonymous.pwszVal = PWSTR(mem as *mut u16);
        }
        store
            .SetValue(&PKEY_AppUserModel_ID, &pv)
            .map_err(|e| e.to_string())?;
        store.Commit().map_err(|e| e.to_string())?;

        // Сохраняем ярлык на диск
        let persist: IPersistFile = shell_link.cast().map_err(|e| e.to_string())?;
        persist
            .Save(&HSTRING::from(link.as_os_str()), true)
            .map_err(|e| e.to_string())?;
        // mem сознательно не освобождаем: PROPVARIANT ушёл в property store,
        // а ярлык создан раз за сессию (утечка ~100 байт, некритично)
    }
    Ok(())
}
