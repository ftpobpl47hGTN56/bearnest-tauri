// ============================================================================
//  models.rs — перенос моделей данных из C#:
//    ServerConfig.cs, SplitTunnelSettings.cs, SubscriptionInfo.cs
//
//  Все структуры сериализуются в JSON и уходят на фронтенд как есть.
//  serde(rename_all = "camelCase") даёт во фронтенде привычные поля:
//  server.protocol, server.serverName, split.tunMode и т.д.
// ============================================================================

use serde::{Deserialize, Serialize};

// ── ServerConfig ────────────────────────────────────────────────────────────
// 1:1 соответствие полям ServerConfig.cs. Значения по умолчанию заданы через
// Default, чтобы serde_json::from_* не падал на отсутствующих полях.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ServerConfig {
    #[serde(default)]
    pub name: String,
    #[serde(default)]
    pub protocol: String,
    #[serde(default)]
    pub address: String,
    #[serde(default)]
    pub port: u16,
    #[serde(default)]
    pub id: String,
    #[serde(default)]
    pub security: String,
    #[serde(default)]
    pub network: String,
    #[serde(default)]
    pub public_key: String,
    #[serde(default)]
    pub short_id: String,
    #[serde(default)]
    pub server_name: String,
    #[serde(default = "default_path")]
    pub path: String,
    #[serde(default)]
    pub flow: String,
    #[serde(default = "default_fingerprint")]
    pub fingerprint: String,

    // xmux
    #[serde(default)]
    pub has_xmux: bool,
    #[serde(default = "default_xmux_lifetime")]
    pub xmux_max_lifetime: i64,
    #[serde(default = "default_xmux_reuse")]
    pub xmux_max_reuse: String,
    #[serde(default = "default_xmux_concurrency")]
    pub xmux_concurrency: String,

    // xhttp
    #[serde(default = "default_xhttp_mode")]
    pub xhttp_mode: String,
    #[serde(default)]
    pub xhttp_host: String,

    // Пинг в мс: -1 = не проверен, -2 = недоступен (как в C#)
    #[serde(default = "default_ping")]
    pub ping_ms: i64,
}

fn default_path() -> String { "/".into() }
fn default_fingerprint() -> String { "chrome".into() }
fn default_xmux_lifetime() -> i64 { 30000 }
fn default_xmux_reuse() -> String { "64-128".into() }
fn default_xmux_concurrency() -> String { "4-8".into() }
fn default_xhttp_mode() -> String { "auto".into() }
fn default_ping() -> i64 { -1 }

impl Default for ServerConfig {
    fn default() -> Self {
        ServerConfig {
            name: String::new(),
            protocol: String::new(),
            address: String::new(),
            port: 0,
            id: String::new(),
            security: String::new(),
            network: String::new(),
            public_key: String::new(),
            short_id: String::new(),
            server_name: String::new(),
            path: default_path(),
            flow: String::new(),
            fingerprint: default_fingerprint(),
            has_xmux: false,
            xmux_max_lifetime: default_xmux_lifetime(),
            xmux_max_reuse: default_xmux_reuse(),
            xmux_concurrency: default_xmux_concurrency(),
            xhttp_mode: default_xhttp_mode(),
            xhttp_host: String::new(),
            ping_ms: default_ping(),
        }
    }
}

// ── SplitTunnelSettings ─────────────────────────────────────────────────────
// Порт SplitTunnelSettings.cs. bypass_lan по умолчанию true, как в оригинале.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SplitTunnelSettings {
    #[serde(default)]
    pub bypass_domains: Vec<String>,
    #[serde(default)]
    pub bypass_ips: Vec<String>,
    #[serde(default = "default_true")]
    pub bypass_lan: bool,
    #[serde(default)]
    pub tun_mode: bool,
    #[serde(default)]
    pub physical_interface: String,
}

fn default_true() -> bool { true }

impl Default for SplitTunnelSettings {
    fn default() -> Self {
        SplitTunnelSettings {
            bypass_domains: Vec::new(),
            bypass_ips: Vec::new(),
            bypass_lan: true,
            tun_mode: false,
            physical_interface: String::new(),
        }
    }
}

// ── SubscriptionInfo ────────────────────────────────────────────────────────
// Порт SubscriptionInfo.cs. Байты в UI форматируются на фронтенде, здесь —
// только «сырые» числа плюс готовый вычисленный days_left для удобства.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SubscriptionInfo {
    #[serde(default)]
    pub title: String,
    #[serde(default)]
    pub upload: i64,
    #[serde(default)]
    pub download: i64,
    #[serde(default)]
    pub total: i64, // 0 = безлимит
    #[serde(default)]
    pub expire_unix: i64,
}

impl SubscriptionInfo {
    pub fn is_empty(&self) -> bool {
        self.title.is_empty() && self.expire_unix == 0
    }
}
