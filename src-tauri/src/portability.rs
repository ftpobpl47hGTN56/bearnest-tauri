// ============================================================================
//  portability.rs — экспорт/импорт данных клиента через нативный «Проводник».
//
//  Две Tauri-команды, вызываемые из фронтенда (main.js) через invoke():
//    • export_to_file(default_name, contents) — открывает диалог «Сохранить как»,
//      пользователь выбирает ПАПКУ и имя файла в Проводнике, мы пишем туда
//      строку contents (UTF-8). Возвращает путь сохранённого файла (или None,
//      если пользователь нажал «Отмена»).
//    • import_from_file() — открывает диалог «Открыть», пользователь выбирает
//      файл, мы читаем его как UTF-8 и возвращаем содержимое строкой (или None
//      при отмене).
//
//  Реализация:
//    Диалоги rfd — блокирующие (нативный Win32/COM common file dialog). Их
//    нельзя крутить прямо в async-команде: на Windows диалог требует STA-поток
//    с инициализированным COM. Поэтому запускаем блокирующий вызов на
//    отдельном потоке через tauri::async_runtime::spawn_blocking — rfd сам
//    инициализирует COM на этом потоке, а Send-через-await проблем не возникает
//    (мы await'им только PathBuf).
//
//  Формат самих данных (JSON) формируется на стороне JS — тут только файловый
//  ввод/вывод, чтобы бэкенд оставался «глупым» и переиспользуемым и для
//  настроек, и для тем.
// ============================================================================

use std::fs;

// ── ЭКСПОРТ: «Сохранить как» → запись строки в выбранный файл ────────────────
#[tauri::command]
pub async fn export_to_file(default_name: String, contents: String) -> Result<Option<String>, String> {
    // подстрахуемся от пустого имени
    let name = if default_name.trim().is_empty() {
        "bearnest-export.json".to_string()
    } else {
        default_name
    };

    // Показ диалога — на блокирующем потоке. Возвращает Option<PathBuf>.
    let picked = tauri::async_runtime::spawn_blocking(move || {
        rfd::FileDialog::new()
            .set_title("Сохранить как")
            .set_file_name(name.as_str())
            .add_filter("JSON", &["json"])
            .add_filter("Все файлы (*.*)", &["*"])
            .save_file()
    })
    .await
    .map_err(|e| format!("dialog thread error: {e}"))?;

    match picked {
        Some(path) => {
            fs::write(&path, contents.as_bytes())
                .map_err(|e| format!("write error: {e}"))?;
            Ok(Some(path.to_string_lossy().to_string()))
        }
        None => Ok(None), // пользователь отменил
    }
}

// ── ИМПОРТ: «Открыть» → чтение выбранного файла как строки ───────────────────
#[tauri::command]
pub async fn import_from_file() -> Result<Option<String>, String> {
    let picked = tauri::async_runtime::spawn_blocking(move || {
        rfd::FileDialog::new()
            .set_title("Открыть файл")
            .add_filter("JSON", &["json"])
            .add_filter("Все файлы (*.*)", &["*"])
            .pick_file()
    })
    .await
    .map_err(|e| format!("dialog thread error: {e}"))?;

    match picked {
        Some(path) => {
            let text = fs::read_to_string(&path)
                .map_err(|e| format!("read error: {e}"))?;
            Ok(Some(text))
        }
        None => Ok(None), // пользователь отменил
    }
}
