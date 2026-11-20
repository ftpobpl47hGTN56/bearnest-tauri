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
//      4) запускаем tun2socks (длинные флаги — с ДВУМЯ дефисами!)
//      5) ждём появления адаптера
//      6) назначаем IP + DNS адаптеру (netsh)
//      7) две /1-сети 0.0.0.0/1 и 128.0.0.0/1 заворачивают весь трафик
//
//    ОСТАНОВКА (обратный порядок): сначала маршруты, потом процесс — иначе на
//    пару секунд пропадёт интернет.
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
}

impl TunManager {
    pub fn new(tun2socks_path: std::path::PathBuf) -> Self {
        TunManager {
            tun2socks_path,
            child: Mutex::new(None),
            server_ip: Mutex::new(None),
            original_gateway: Mutex::new(None),
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
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::piped());
        if let Some(dir) = self.tun2socks_path.parent() {
            cmd.current_dir(dir);
        }
        no_window(&mut cmd);

        let mut child = cmd.spawn().map_err(|e| format!("tun2socks spawn error: {e}"))?;

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

        Ok(())
    }

    #[cfg(not(windows))]
    pub async fn start(&self, _server_address: &str, _socks_port: u16, _log: LogFn) -> Result<(), String> {
        Err("TUN-режим поддерживается только на Windows".into())
    }

    // ── ОСТАНОВКА (порт StopAsync) ──────────────────────────────────────────
    #[cfg(windows)]
    pub async fn stop(&self, log: LogFn) {
        // Порядок обратный: сначала маршруты, потом процесс
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
        *self.server_ip.lock().await = None;
        log("[BearNest] 🌐 TUN-режим выключен".into());
    }

    #[cfg(not(windows))]
    pub async fn stop(&self, _log: LogFn) {}
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
