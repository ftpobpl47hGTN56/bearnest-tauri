// ============================================================================
//  selftest.rs — «честная» проверка состояния жизни туннеля с КОНКРЕТНОЙ причиной сбоя.
//
//  Зачем: пинг (pinger.rs) отвечает только «дошёл TCP до порта или нет» и не
//  видит, реально ли ходит трафик ЧЕРЕЗ прокси. Отсюда и обидная ситуация:
//  «подключено», а интернета нет — а уведомление лишь про «низкий пинг».
//
//  Что делает: гоняет короткий HTTP-запрос (generate_204) НАПРЯМУЮ через
//  локальный SOCKS-inbound xray (127.0.0.1:19808 — тот же порт, что в
//  config.rs), т.е. по тому же пути, что и реальный трафик браузера. По
//  результату возвращает категорию причины:
//
//    ok         — трафик проходит (есть latencyMs);
//    proxy_down — локальный SOCKS не слушает → xray не запущен/упал;
//    timeout    — прокси есть, но сервер молчит (таймаут);
//    tls        — ошибка TLS/handshake (сервер оборвал шифрование);
//    dns        — не резолвится имя через туннель;
//    upstream   — сервер отклонил соединение (refused/unreachable);
//    unknown    — прочее (detail с текстом ошибки).
//
//  Новых зависимостей НЕ требует: reqwest (socks + rustls-tls) и tokio уже в
//  Cargo.toml. Порт SOCKS совпадает с config.rs (19808).
// ============================================================================

use std::time::{Duration, Instant};

// Порт локального SOCKS-inbound xray (см. config.rs, inbound tag "socks").
const SOCKS_ADDR: &str = "127.0.0.1:19808";
// Лёгкие эндпоинты «204 No Content» — пробуем по очереди, успех любого = ok.
const TEST_URLS: [&str; 2] = [
    "https://cp.cloudflare.com/generate_204",
    "https://www.gstatic.com/generate_204",
];
const HTTP_TIMEOUT: Duration = Duration::from_secs(6);
const SOCKS_PROBE_TIMEOUT: Duration = Duration::from_millis(1200);

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SelfTest {
    pub ok: bool,
    pub category: String, // ok | proxy_down | timeout | tls | dns | upstream | unknown
    pub detail: String,   // короткий текст ошибки для лога/тултипа
    pub latency_ms: i64,  // время успешного запроса; -1 если не мерили
}

impl SelfTest {
    fn fail(category: &str, detail: impl Into<String>) -> Self {
        SelfTest { ok: false, category: category.into(), detail: detail.into(), latency_ms: -1 }
    }
    fn good(latency_ms: i64) -> Self {
        SelfTest { ok: true, category: "ok".into(), detail: String::new(), latency_ms }
    }
}

// Разбор ошибки reqwest → наша категория. Порядок важен: сначала таймаут,
// затем TLS/DNS (по тексту), затем connect/refused, иначе unknown.
fn categorize(e: &reqwest::Error) -> &'static str {
    if e.is_timeout() {
        return "timeout";
    }
    // Полная цепочка причин в нижнем регистре — надёжнее, чем один слой.
    let s = format!("{e:#}").to_lowercase();

    if s.contains("timed out") || s.contains("timeout") {
        return "timeout";
    }
    if s.contains("certificate") || s.contains("tls") || s.contains("handshake") || s.contains("ssl") {
        return "tls";
    }
    if s.contains("dns")
        || s.contains("resolve")
        || s.contains("resolution")
        || s.contains("lookup")
        || s.contains("name or service")
    {
        return "dns";
    }
    if e.is_connect()
        || s.contains("refused")
        || s.contains("unreachable")
        || s.contains("not allowed")
        || s.contains("socks")
    {
        return "upstream";
    }
    "unknown"
}

// Обрезка текста ошибки, чтобы тост/лог не разрастались.
fn short(s: &str) -> String {
    let s = s.trim();
    if s.chars().count() > 160 {
        let cut: String = s.chars().take(160).collect();
        format!("{cut}…")
    } else {
        s.to_string()
    }
}

#[tauri::command]
pub async fn proxy_selftest() -> Result<SelfTest, String> {
    // 1) Жив ли локальный SOCKS? Если порт не слушает — xray не поднят/упал.
    let probe = tokio::time::timeout(
        SOCKS_PROBE_TIMEOUT,
        tokio::net::TcpStream::connect(SOCKS_ADDR),
    )
    .await;
    let socks_alive = matches!(probe, Ok(Ok(_)));
    if !socks_alive {
        return Ok(SelfTest::fail("proxy_down", "local SOCKS 127.0.0.1:19808 is not listening"));
    }

    // 2) HTTP-запрос через SOCKS (socks5h → DNS резолвится на стороне прокси,
    //    как и у реального трафика). reqwest уже есть в зависимостях.
    let proxy = reqwest::Proxy::all(format!("socks5h://{SOCKS_ADDR}"))
        .map_err(|e| format!("proxy build error: {e}"))?;
    let client = reqwest::Client::builder()
        .proxy(proxy)
        .timeout(HTTP_TIMEOUT)
        .user_agent("BearNest-selftest")
        .build()
        .map_err(|e| format!("client build error: {e}"))?;

    let mut last: Option<reqwest::Error> = None;
    for url in TEST_URLS {
        let start = Instant::now();
        match client.get(url).send().await {
            Ok(resp) => {
                // Любой ответ (204/2xx/3xx) означает, что трафик прошёл сквозь туннель.
                let _ = resp.status();
                return Ok(SelfTest::good(start.elapsed().as_millis() as i64));
            }
            Err(e) => last = Some(e),
        }
    }

    // 3) Все эндпоинты не ответили — категоризируем последнюю ошибку.
    match last {
        Some(e) => {
            let cat = categorize(&e);
            Ok(SelfTest::fail(cat, short(&format!("{e:#}"))))
        }
        None => Ok(SelfTest::fail("unknown", "no endpoints tried")),
    }
}
