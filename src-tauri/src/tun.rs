// ============================================================================
//  tun.rs — перенос TunManager.cs
//
//  Поднимает виртуальный адаптер через tun2socks и заворачивает ВЕСЬ трафик
//  (включая UDP) в SOCKS5 xray. Критичный порядок операций сохранён:
//
//    ЗАПУСК:
//      1) резолвим адрес сервера в IPv4
//      2) запоминаем текущий шлюз (исключая сам TUN)
//      3) ДО старта tun2socks — прямой маршрут к серверу через старый шлюз
//         (иначе xray стучится к своему серверу через TUN → петля)
//      4) запускаем tun2socks
//         + Job Object (kill-on-close): смерть приложения ⇒ ОС убьёт tun2socks
//      5) ждём появления адаптера
//      6) назначаем IP + DNS адаптеру (netsh)
//      7) две /1-сети 0.0.0.0/1 и 128.0.0.0/1 заворачивают весь трафик
//      8) запускаем сторож: пока приложение живо — молчит; если приложение
//         умерло (крах/kill/сбой), снимает /1-маршруты и добивает процессы
//
//    ОСТАНОВКА (обратный порядок): маршруты → процесс → сторож → Job Object.
//
//  Требует прав администратора. На не-Windows — заглушка с ошибкой.
// ============================================================================

use std::sync::Arc;
use tokio::sync::Mutex;

pub type LogFn = Arc<dyn Fn(String) + Send + Sync>;

const TUN_NAME: &str = "BearNestTun";
const TUN_IP: &str = "10.255.0.2";
const TUN_GATEWAY: &str = "10.255.0.1";
const TUN_MASK: &str = "255.255.255.0";

pub struct TunManager {
    tun2socks_path: std::path::PathBuf,
    child: Mutex<Option<tokio::process::Child>>,
    server_ip: Mutex<Option<String>>,
    original_gateway: Mutex<Option<String>>,
    // Сторож-процесс (powershell): переживает смерть приложения и снимает
    // /1-маршруты + добивает процессы. См. spawn_route_watchdog.
    #[cfg(windows)]
    watchdog: Mutex<Option<tokio::process::Child>>,
    // stdin-пайп сторожа: жив, пока живо приложение. Смерть приложения
    // закрывает пайп — это и есть сигнал «хозяин умер» для сторожа.
    #[cfg(windows)]
    watchdog_stdin: Mutex<Option<tokio::process::ChildStdin>>,
    // Хендл Job Object (kill-on-close), приведённый к isize. Пока хендл жив —
    // tun2socks жив; закрытие хендла (в т.ч. при смерти приложения) убьёт его.
    #[cfg(windows)]
    win_job: Mutex<Option<isize>>,
}

impl TunManager {
    pub fn new(tun2socks_path: std::path::PathBuf) -> Self {
        TunManager {
            tun2socks_path,
            child: Mutex::new(None),
            server_ip: Mutex::new(None),
            original_gateway: Mutex::new(None),
            #[cfg(windows)]
            watchdog: Mutex::new(None),
            #[cfg(windows)]
            watchdog_stdin: Mutex::new(None),
            #[cfg(windows)]
            win_job: Mutex::new(None),
        }
    }

    pub async fn is_running(&self) -> bool {
        let mut g = self.child.lock().await;
        if let Some(ch) = g.as_mut() {
            matches!(ch.try_wait(), Ok(None))
        } else {
            false
        }
    }

    // ── ЗАПУСК (порт StartAsync) ────────────────────────────────────────────
    #[cfg(windows)]
    pub async fn start(&self, server_address: &str, socks_port: u16, log: LogFn) -> Result<(), String> {
        use tokio::io::{AsyncBufReadExt, BufReader};
        use tokio::process::Command;

        if !self.tun2socks_path.exists() {
            return Err(format!("tun2socks.exe не найден: {}", self.tun2socks_path.display()));
        }

        // 1. Резолвим адрес → IPv4
        let server_ip = resolve_ipv4(server_address)
            .ok_or_else(|| format!("не удалось резолвить {server_address} в IPv4"))?;
        log(format!("[BearNest] 🌐 VPN-сервер: {server_address} → {server_ip}"));
        *self.server_ip.lock().await = Some(server_ip.clone());

        // 2. Запоминаем текущий шлюз (исключая TUN)
        let gateway = default_gateway().await.ok_or("не удалось определить шлюз по умолчанию")?;
        log(format!("[BearNest] 🌐 Шлюз по умолчанию: {gateway}"));
        *self.original_gateway.lock().await = Some(gateway.clone());

        // 3. Прямой маршрут к VPN-серверу ДО поднятия TUN
        run_cmd(&format!("route add {server_ip} mask 255.255.255.255 {gateway} metric 1")).await;
        log(format!("[BearNest] 🌐 Прямой маршрут к серверу: {server_ip} → {gateway}"));

        // 4. Запускаем tun2socks (длинные флаги — с двумя дефисами!)
        let mut cmd = Command::new(&self.tun2socks_path);
        cmd.arg("--device").arg(format!("tun://{TUN_NAME}"))
            .arg("--proxy").arg(format!("socks5://127.0.0.1:{socks_port}"))
            .arg("--udp-timeout").arg("300s")
            .arg("--loglevel").arg("warning")
            .kill_on_drop(true)
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::piped());
        if let Some(dir) = self.tun2socks_path.parent() {
            cmd.current_dir(dir);
        }
        no_window(&mut cmd);

        let mut child = cmd.spawn().map_err(|e| format!("tun2socks spawn error: {e}"))?;

        // Job Object (kill-on-close): привязываем tun2socks к времени жизни
        // приложения — при крахе/kill приложения ОС убьёт tun2socks сама.
        *self.win_job.lock().await = child
            .raw_handle()
            .and_then(|h| assign_process_to_job(windows::Win32::Foundation::HANDLE(h)));

        if let Some(out) = child.stdout.take() {
            let log = log.clone();
            tokio::spawn(async move {
                let mut lines = BufReader::new(out).lines();
                while let Ok(Some(l)) = lines.next_line().await {
                    if !l.trim().is_empty() { log(format!("[tun2socks] {l}")); }
                }
            });
        }
        if let Some(err) = child.stderr.take() {
            let log = log.clone();
            tokio::spawn(async move {
                let mut lines = BufReader::new(err).lines();
                while let Ok(Some(l)) = lines.next_line().await {
                    if !l.trim().is_empty() { log(format!("[tun2socks] {l}")); }
                }
            });
        }
        *self.child.lock().await = Some(child);
        log("[BearNest] 🌐 tun2socks запущен, жду создания адаптера...".into());

        // 5. Ждём появления адаптера
        if !wait_for_adapter(std::time::Duration::from_secs(10)).await {
            return Err(format!(
                "адаптер {TUN_NAME} не появился за 10 сек. Проверь wintun.dll рядом с tun2socks.exe и запуск от администратора."
            ));
        }
        log(format!("[BearNest] 🌐 Адаптер {TUN_NAME} создан"));

        // 6. IP + DNS адаптеру
        run_process("netsh.exe", &["interface", "ip", "set", "address",
            &format!("name={TUN_NAME}"), "static", TUN_IP, TUN_MASK, TUN_GATEWAY]).await;
        run_process("netsh.exe", &["interface", "ip", "set", "dns",
            &format!("name={TUN_NAME}"), "static", "1.1.1.1"]).await;
        run_process("netsh.exe", &["interface", "ip", "add", "dns",
            &format!("name={TUN_NAME}"), "8.8.8.8", "index=2"]).await;
        log(format!("[BearNest] 🌐 IP {TUN_IP} и DNS назначены адаптеру"));

        // 7. Заворачиваем весь трафик двумя /1-сетями
        run_cmd(&format!("route add 0.0.0.0 mask 128.0.0.0 {TUN_GATEWAY} metric 1")).await;
        run_cmd(&format!("route add 128.0.0.0 mask 128.0.0.0 {TUN_GATEWAY} metric 1")).await;
        log("[BearNest] 🌐 TUN-режим активен — весь трафик через туннель".into());

        // 8. Сторож: переживает смерть приложения. Запускается ПОСЛЕ успешной
        //    настройки, чтобы при неудачном старте не было ложной очистки.
        self.spawn_route_watchdog().await;

        Ok(())
    }

    #[cfg(not(windows))]
    pub async fn start(&self, _server_address: &str, _socks_port: u16, _log: LogFn) -> Result<(), String> {
        Err("TUN-режим поддерживается только на Windows".into())
    }

    // ── ОСТАНОВКА (порт StopAsync) ──────────────────────────────────────────
    #[cfg(windows)]
    pub async fn stop(&self, log: LogFn) {
        // Порядок обратный: маршруты → процесс → сторож → Job Object
        run_cmd("route delete 0.0.0.0 mask 128.0.0.0").await;
        run_cmd("route delete 128.0.0.0 mask 128.0.0.0").await;

        if let Some(ip) = self.server_ip.lock().await.clone() {
            run_cmd(&format!("route delete {ip} mask 255.255.255.255")).await;
        }
        log("[BearNest] 🌐 Маршруты TUN сняты".into());

        if let Some(mut ch) = self.child.lock().await.take() {
            let _ = ch.kill().await;
            let _ = ch.wait().await;
        }
        // Сторож больше не нужен — гасим его ДО закрытия Job Object'а.
        self.stop_watchdog().await;
        self.dispose_win_job().await;
        *self.server_ip.lock().await = None;
        log("[BearNest] 🌐 TUN-режим выключен".into());
    }

    #[cfg(not(windows))]
    pub async fn stop(&self, _log: LogFn) {}

    // ── Сторож-процесс (самоочистка при смерти приложения) ──────────────────
    // Отдельный лёгкий powershell, у которого мы держим stdin открытым.
    // Смерть приложения закрывает пайп → Peek() даёт EOF → сторож:
    //   1) снимает /1-маршруты (иначе у пользователя «сломан» интернет),
    //   2) добивает tun2socks/xray,
    //   3) снимает системный прокси (ProxyEnable=0).
    // При штатном stop() мы гасим сторожа раньше закрытия пайпа (start_kill).
    #[cfg(windows)]
    async fn spawn_route_watchdog(&self) {
        // Сначала гасим предыдущего сторожа, если он остался
        self.stop_watchdog().await;

        let ps = r#"
$routeDeleted = $false
while ($true) {
    # Peek() блокируется, пока пайп пуст; -1 (EOF) = приложение умерло
    if ([Console]::In.Peek() -lt 0) {
        if (-not $routeDeleted) {
            $routeDeleted = $true
            Start-Process -WindowStyle Hidden -FilePath 'route.exe' -ArgumentList 'delete','0.0.0.0','mask','128.0.0.0'
            Start-Process -WindowStyle Hidden -FilePath 'route.exe' -ArgumentList 'delete','128.0.0.0','mask','128.0.0.0'
            Start-Process -WindowStyle Hidden -FilePath 'taskkill.exe' -ArgumentList '/F','/IM','tun2socks.exe'
            Start-Process -WindowStyle Hidden -FilePath 'taskkill.exe' -ArgumentList '/F','/IM','xray.exe'
            Set-ItemProperty -Path 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Internet Settings' -Name ProxyEnable -Value 0
        }
        break
    }
    Start-Sleep -Milliseconds 500
}
"#;
        let mut cmd = tokio::process::Command::new("powershell");
        cmd.args(["-NoProfile", "-NonInteractive", "-Command", ps])
            .kill_on_drop(true)
            .stdin(std::process::Stdio::piped())
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null());
        no_window(&mut cmd);

        let Ok(mut child) = cmd.spawn() else {
            // сторож не критичен: Job Object всё равно убьёт tun2socks
            return;
        };
        if let Some(si) = child.stdin.take() {
            *self.watchdog_stdin.lock().await = Some(si);
        }
        *self.watchdog.lock().await = Some(child);
    }

    #[cfg(windows)]
    async fn stop_watchdog(&self) {
        // Сначала гасим процесс (до закрытия stdin-пайпа!), чтобы сторож не
        // успел запустить очистку при штатной остановке — маршруты уже сняты.
        if let Some(mut ch) = self.watchdog.lock().await.take() {
            let _ = ch.start_kill();
            let _ = ch.wait().await;
        }
        *self.watchdog_stdin.lock().await = None;
    }

    // ── Освобождение Job Object при штатной остановке ────────────────────────
    // Вызывается ТОЛЬКО после kill() tun2socks: закрытие хендла Job'а — это
    // триггер kill-on-close, живой процесс будет убит немедленно.
    #[cfg(windows)]
    async fn dispose_win_job(&self) {
        if let Some(h) = self.win_job.lock().await.take() {
            unsafe {
                let _ = windows::Win32::Foundation::CloseHandle(handle_from_isize(h));
            }
        }
    }
}

// Drop-страховка: штатные пути всегда проходят через stop(). Если TunManager
// выброшен без stop() — закрываем Job Object (ОС убьёт tun2socks сама).
// tokio Mutex в Drop: токио-лок не блокирует в sync-контексте при отсутствии
// конкурентов, но чтобы не ждать, берём только незанятые локи (try_lock).
#[cfg(windows)]
impl Drop for TunManager {
    fn drop(&mut self) {
        if let Ok(mut g) = self.win_job.try_lock() {
            if let Some(h) = g.take() {
                unsafe {
                    let _ = windows::Win32::Foundation::CloseHandle(handle_from_isize(h));
                }
            }
        }
        if let Ok(mut g) = self.watchdog_stdin.try_lock() {
            *g = None; // пайп закроется → сторож сработает как «приложение умерло»
        }
    }
}

#[cfg(not(windows))]
impl Drop for TunManager {
    fn drop(&mut self) {}
}

// ── Startup sweep при запуске приложения ─────────────────────────────────────
// Хвосты прошлого аварийного запуска: осиротевшие tun2socks/xray, /1-маршруты
// в никуда, включенный системный прокси на наш порт. Чистим при старте
// (вызывается из lib.rs setup). Безопасно, если чистить нечего.
#[cfg(windows)]
pub async fn startup_sweep() {
    // 1. Убить осиротевшие процессы прошлой сессии
    run_process("taskkill.exe", &["/F", "/IM", "tun2socks.exe"]).await;
    run_process("taskkill.exe", &["/F", "/IM", "xray.exe"]).await;

    // 2. Снять leftover /1-маршруты (остатки мёртвого TUN-шлюза 10.255.0.1)
    run_cmd("route delete 0.0.0.0 mask 128.0.0.0").await;
    run_cmd("route delete 128.0.0.0 mask 128.0.0.0").await;

    // 3. Системный прокси: если он указывает на 127.0.0.1:19809 — это хвост
    //    от краха приложения, сбрасываем. Чужой прокси не трогаем.
    if proxy_state().is_ours() {
        crate::system_proxy::disable();
    }

    crate::logger::write("[BearNest] startup sweep: хвосты прошлой сессии почищены");
}

// ── Платформенные хелперы ────────────────────────────────────────────────────
#[cfg(windows)]
fn resolve_ipv4(address: &str) -> Option<String> {
    use std::net::ToSocketAddrs;
    if let Ok(ip) = address.parse::<std::net::Ipv4Addr>() {
        return Some(ip.to_string());
    }
    (address, 0u16)
        .to_socket_addrs()
        .ok()?
        .find(|a| a.is_ipv4())
        .map(|a| a.ip().to_string())
}

// Шлюз по умолчанию через PowerShell Get-NetRoute, исключая TUN-адаптер.
#[cfg(windows)]
async fn default_gateway() -> Option<String> {
    let ps = "(Get-NetRoute -DestinationPrefix '0.0.0.0/0' -ErrorAction SilentlyContinue | \
              Where-Object { $_.NextHop -ne '0.0.0.0' -and $_.InterfaceAlias -notlike '*BearNest*' } | \
              Sort-Object RouteMetric | Select-Object -First 1).NextHop";
    let out = run_capture("powershell", &["-NoProfile", "-Command", ps]).await?;
    let gw = out.trim().to_string();
    if gw.is_empty() { None } else { Some(gw) }
}

#[cfg(windows)]
async fn wait_for_adapter(timeout: std::time::Duration) -> bool {
    let deadline = std::time::Instant::now() + timeout;
    while std::time::Instant::now() < deadline {
        if let Some(out) = run_capture("netsh.exe", &["interface", "show", "interface"]).await {
            if out.contains(TUN_NAME) {
                return true;
            }
        }
        tokio::time::sleep(std::time::Duration::from_millis(300)).await;
    }
    false
}

#[cfg(windows)]
async fn run_cmd(args: &str) {
    run_process("cmd.exe", &["/c", args]).await;
}

#[cfg(windows)]
async fn run_process(file: &str, args: &[&str]) {
    use tokio::process::Command;
    let mut cmd = Command::new(file);
    cmd.args(args);
    no_window(&mut cmd);
    let _ = cmd.output().await;
}

#[cfg(windows)]
async fn run_capture(file: &str, args: &[&str]) -> Option<String> {
    use tokio::process::Command;
    let mut cmd = Command::new(file);
    cmd.args(args);
    no_window(&mut cmd);
    let out = cmd.output().await.ok()?;
    Some(String::from_utf8_lossy(&out.stdout).to_string())
}

#[cfg(windows)]
fn no_window(cmd: &mut tokio::process::Command) {
    // tokio::process::Command имеет собственный creation_flags на Windows.
    const CREATE_NO_WINDOW: u32 = 0x0800_0000;
    cmd.creation_flags(CREATE_NO_WINDOW);
}

// Текущее состояние системного прокси из реестра. is_ours = включен и
// указывает на 127.0.0.1:19809 (тот же хост:порт, что пишет system_proxy::enable).
#[cfg(windows)]
fn proxy_state() -> ProxyState {
    use winreg::enums::*;
    use winreg::RegKey;

    const INTERNET_SETTINGS: &str =
        r"Software\Microsoft\Windows\CurrentVersion\Internet Settings";

    let hkcu = RegKey::predef(HKEY_CURRENT_USER);
    let (enabled, server) = match hkcu.open_subkey(INTERNET_SETTINGS) {
        Ok(k) => (
            k.get_value::<u32, _>("ProxyEnable").unwrap_or(0) == 1,
            k.get_value::<String, _>("ProxyServer").unwrap_or_default(),
        ),
        Err(_) => (false, String::new()),
    };
    ProxyState { enabled, server }
}

#[cfg(windows)]
struct ProxyState {
    enabled: bool,
    server: String,
}

#[cfg(windows)]
impl ProxyState {
    fn is_ours(&self) -> bool {
        self.enabled && self.server == "127.0.0.1:19809"
    }
}

// ── Job Object (kill-on-close) ───────────────────────────────────────────────
// Каждый tun2socks привязывается к Job Object с флагом JOB_OBJECT_LIMIT_
// KILL_ON_JOB_CLOSE. Хендл Job'а возвращается вызывающему (тот хранит его в
// TunManager); смерть приложения закрывает хендл → ОС убивает tun2socks.
// Хендл НЕЛЬЗЯ закрывать, пока TUN активен — закрытие и есть триггер.
#[cfg(windows)]
fn assign_process_to_job(child_process: windows::Win32::Foundation::HANDLE) -> Option<isize> {
    use windows::core::PCWSTR;
    use windows::Win32::System::JobObjects::{
        AssignProcessToJobObject, CreateJobObjectW, JobObjectExtendedLimitInformation,
        SetInformationJobObject, JOBOBJECT_EXTENDED_LIMIT_INFORMATION,
        JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
    };

    unsafe {
        let Ok(job) = CreateJobObjectW(None, PCWSTR::null()) else {
            return None;
        };
        let mut info = JOBOBJECT_EXTENDED_LIMIT_INFORMATION::default();
        info.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
        if SetInformationJobObject(
            job,
            JobObjectExtendedLimitInformation,
            &info as *const _ as *const std::ffi::c_void,
            std::mem::size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32,
        )
        .is_err()
        {
            let _ = windows::Win32::Foundation::CloseHandle(job);
            return None;
        }
        if AssignProcessToJobObject(job, child_process).is_err() {
            let _ = windows::Win32::Foundation::CloseHandle(job);
            return None;
        }
        Some(job.0 as isize)
    }
}

#[cfg(windows)]
fn handle_from_isize(h: isize) -> windows::Win32::Foundation::HANDLE {
    windows::Win32::Foundation::HANDLE(h as *mut std::ffi::c_void)
}
