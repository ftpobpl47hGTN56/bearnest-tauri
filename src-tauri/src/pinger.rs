// ============================================================================
//  pinger.rs — перенос ServerPinger (ServerPinger.cs / Class1.cs)   [Fixed]
//
//  Проблема TUN-режима, которую Вы отлаживали:
//  при активном туннеле таблица маршрутизации отправляет ВЕСЬ трафик в
//  TUN-адаптер. Любой обычный TcpStream/TcpClient подчиняется этой таблице →
//  probe уходит ЧЕРЕЗ туннель и показывает 500–600 ms (или 0/-2, если сервер
//  недоступен через exit-ноду) вместо реальных ~90 ms.
//
//  Почему старый способ определения адаптера ломался:
//  он спрашивал маршрут («через какой адаптер пойти к 1.1.1.1?»), а маршрут —
//  это ровно то, что подменяет TUN. В итоге возвращался адрес туннеля
//  10.255.0.x, фильтр отдавал None, bind не делался, и замер снова уходил в TUN.
//
//  Решение (как в WPF-версии):
//  читаем СПИСОК адаптеров напрямую (netdev), находим ФИЗИЧЕСКИЙ адаптер
//  (Ethernet/Wi-Fi, у которого есть шлюз), исключаем наш TUN, и привязываем
//  (bind) исходящий сокет именно к его локальному IPv4. Тогда TCP-connect идёт
//  напрямую мимо TUN — и при включённом туннеле тоже.
//
//  Возвращает миллисекунды, либо -2 при недоступности (та же семантика PingMs).
//
//  Зависимости (Cargo.toml):
//      netdev  = "0.28"
//      socket2 = "0.5"
// ============================================================================

use std::net::{IpAddr, Ipv4Addr, SocketAddr, TcpStream, ToSocketAddrs};
use std::time::{Duration, Instant};

const TIMEOUT: Duration = Duration::from_millis(2000);
const UNREACHABLE: i64 = -2;

// ---------------------------------------------------------------------------
//  Публичный API (без изменений семантики)
// ---------------------------------------------------------------------------

/// Пинг одного сервера. Локальный IP физического адаптера определяется здесь.
pub fn ping(address: &str, port: u16) -> i64 {
    let local = physical_local_ip();
    ping_with_local(address, port, local)
}

/// Пингуем все сервера параллельно (порт PingAllAsync).
///
/// Физический адаптер определяем ОДИН раз и переиспользуем во всех потоках —
/// иначе каждый поток заново перечислял бы адаптеры (лишняя нагрузка и гонки).
pub fn ping_all(servers: &[(String, u16)]) -> Vec<i64> {
    use std::thread;

    let local = physical_local_ip();

    let handles: Vec<_> = servers
        .iter()
        .cloned()
        .map(|(addr, port)| thread::spawn(move || ping_with_local(&addr, port, local)))
        .collect();

    handles
        .into_iter()
        .map(|h| h.join().unwrap_or(UNREACHABLE))
        .collect()
}

// ---------------------------------------------------------------------------
//  Общая логика замера
// ---------------------------------------------------------------------------

/// Резолвим адрес, привязываемся к физическому адаптеру (если он найден) и
/// замеряем время TCP-connect. Порядок такой же, как в C#.
fn ping_with_local(address: &str, port: u16, local_ip: Option<IpAddr>) -> i64 {
    let target = match resolve(address, port) {
        Some(a) => a,
        None => return UNREACHABLE,
    };

    let start = Instant::now();

    let result = match local_ip {
        // bind к физическому адаптеру → probe идёт мимо TUN
        Some(local) => connect_bound(local, target),
        // адаптер не нашли (не Windows / нет шлюза) — обычный connect
        None => TcpStream::connect_timeout(&target, TIMEOUT)
            .map(|_| ())
            .map_err(|e| e.to_string()),
    };

    match result {
        Ok(_) => start.elapsed().as_millis() as i64,
        Err(_) => UNREACHABLE,
    }
}

/// DNS-резолв (готовый IP тоже корректно проходит через to_socket_addrs).
/// Предпочитаем IPv4, иначе первый доступный адрес.
fn resolve(address: &str, port: u16) -> Option<SocketAddr> {
    let all: Vec<SocketAddr> = (address, port).to_socket_addrs().ok()?.collect();
    all.iter()
        .find(|a| a.is_ipv4())
        .copied()
        .or_else(|| all.first().copied())
}

/// Connect с привязкой исходящего сокета к конкретному локальному адресу.
/// Корректен и для IPv4, и для IPv6.
fn connect_bound(local: IpAddr, target: SocketAddr) -> Result<(), String> {
    use socket2::{Domain, Protocol, Socket, Type};

    // Домен сокета должен совпадать с семейством цели.
    let domain = if target.is_ipv4() { Domain::IPV4 } else { Domain::IPV6 };
    let sock = Socket::new(domain, Type::STREAM, Some(Protocol::TCP)).map_err(|e| e.to_string())?;

    // bind делаем только если семейство локального адреса совпадает с целью,
    // иначе bind IPv4-адреса к IPv6-цели (или наоборот) уронил бы connect.
    let bind_ok = matches!(
        (local, target.is_ipv4()),
        (IpAddr::V4(_), true) | (IpAddr::V6(_), false)
    );
    if bind_ok {
        let bind_addr = SocketAddr::new(local, 0);
        sock.bind(&bind_addr.into()).map_err(|e| e.to_string())?;
    }

    sock.connect_timeout(&target.into(), TIMEOUT).map_err(|e| e.to_string())?;
    Ok(())
}

// ---------------------------------------------------------------------------
//  Определение физического адаптера (ключевое исправление)
// ---------------------------------------------------------------------------

/// Локальный IPv4 ФИЗИЧЕСКОГО адаптера (Ethernet/Wi-Fi со шлюзом), исключая наш
/// TUN. Работает КОРРЕКТНО и при активном TUN, т.к. читаем список адаптеров
/// напрямую, а не через маршрут (который в TUN-режиме врёт).
#[cfg(windows)]
fn physical_local_ip() -> Option<IpAddr> {
    let interfaces = netdev::get_interfaces();

    // Кандидаты — не-loopback, не-TUN интерфейсы СО ШЛЮЗОМ и валидным IPv4.
    // Флаг bool = помечен ли интерфейс ОС как основной (default route).
    let mut candidates: Vec<(bool, Ipv4Addr)> = Vec::new();

    for iface in &interfaces {
        if iface.is_loopback() {
            continue;
        }
        if is_tun_interface(iface) {
            continue;
        }
        // Наличие шлюза = это выход в интернет (физический аплинк).
        if iface.gateway.is_none() {
            continue;
        }
        for net in &iface.ipv4 {
            let ip = net.addr;
            if ip.is_loopback() || ip.is_link_local() || ip.is_unspecified() {
                continue;
            }
            if is_tun_subnet(ip) {
                continue;
            }
            candidates.push((iface.default, ip));
        }
    }

    candidates
        .iter()
        .find(|(is_default, _)| *is_default) // сначала основной адаптер ОС
        .or_else(|| candidates.first())      // иначе — первый подходящий
        .map(|(_, ip)| IpAddr::V4(*ip))
        .or_else(fallback_udp_local_ip)      // фолбэк на старый UDP-трюк
}

/// TUN-адаптер определяем двумя признаками: по нашей подсети (10.255.0.0/24 из
/// TunManager) и по имени/описанию (wintun / tun).
#[cfg(windows)]
fn is_tun_interface(iface: &netdev::Interface) -> bool {
    // 1) по IPv4-подсети TUN
    if iface.ipv4.iter().any(|n| is_tun_subnet(n.addr)) {
        return true;
    }
    // 2) по имени/описанию адаптера
    let mut names: Vec<String> = vec![iface.name.to_ascii_lowercase()];
    if let Some(f) = &iface.friendly_name {
        names.push(f.to_ascii_lowercase());
    }
    if let Some(d) = &iface.description {
        names.push(d.to_ascii_lowercase());
    }
    names.iter().any(|n| n.contains("wintun") || n.contains("tun"))
}

/// Подсеть TUN из TunManager: 10.255.0.0/24.
/// ВАЖНО: если в TunManager подсеть иная — поправьте здесь же (одно место).
#[cfg(windows)]
fn is_tun_subnet(ip: Ipv4Addr) -> bool {
    let o = ip.octets();
    o[0] == 10 && o[1] == 255 && o[2] == 0
}

/// Фолбэк: старый способ через UDP-«connect». Оставлен на случай, если
/// перечисление адаптеров ничего не вернуло. При активном TUN отдаёт None
/// (адрес туннеля отфильтровывается) — это корректно.
#[cfg(windows)]
fn fallback_udp_local_ip() -> Option<IpAddr> {
    use std::net::UdpSocket;
    let sock = UdpSocket::bind("0.0.0.0:0").ok()?;
    sock.connect("1.1.1.1:80").ok()?;
    let ip = sock.local_addr().ok()?.ip();
    match ip {
        IpAddr::V4(v4) if !is_tun_subnet(v4) => Some(IpAddr::V4(v4)),
        _ => None,
    }
}

// На не-Windows платформах привязку не делаем (сборка под другую ОС остаётся ок).
#[cfg(not(windows))]
fn physical_local_ip() -> Option<IpAddr> {
    None
}
