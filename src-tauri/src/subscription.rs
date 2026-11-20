// ============================================================================
//  subscription.rs — перенос SubscriptionParser.cs
//
//  Поддерживает те же форматы, что и C#-версия:
//    • Happ xray-массив (JSON начинается с '[')
//    • Clash / Mihomo YAML (содержит "proxies:")
//    • base64-обёртка над списком ссылок
//    • построчный список URI: vless:// vmess:// trojan:// ss://
//
//  DownloadWithInfo дополнительно читает заголовки подписки:
//    profile-title (+ base64:), subscription-userinfo (upload/download/total/expire).
//  Те же кастомные заголовки Happ, что и в оригинале (User-Agent, X-Hwid ...).
// ============================================================================

use crate::models::{ServerConfig, SubscriptionInfo};
use base64::Engine;
use serde_json::Value;

// ── ЗАГРУЗКА + ИНФО О ПОДПИСКЕ (порт DownloadWithInfoAsync) ───────────────────
// proxy_port > 0 → тянем через локальный SOCKS5 xray (нужно, когда сама
// подписка заблокирована ISP и доступна только под VPN).
pub async fn download_with_info(
    url: &str,
    proxy_port: u16,
) -> Result<(String, SubscriptionInfo), String> {
    let mut builder = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(15))
        .user_agent("Happ/2.16.2/Windows/2605221224603");

    if proxy_port > 0 {
        let proxy = reqwest::Proxy::all(format!("socks5://127.0.0.1:{proxy_port}"))
            .map_err(|e| format!("proxy error: {e}"))?;
        builder = builder.proxy(proxy);
    } else {
        builder = builder.no_proxy();
    }

    let client = builder.build().map_err(|e| e.to_string())?;

    let resp = client
        .get(url)
        .header("Accept", "application/json")
        .header("X-Device-Os", "Windows")
        .header("X-Ver-Os", "10_10.0.19045")
        .header("X-Hwid", "4c7f17cb-05b4-4ec0-b254-275442c3c71d")
        .send()
        .await
        .map_err(|e| format!("request failed: {e}"))?;

    let mut info = SubscriptionInfo::default();

    // profile-title (+ base64:)
    if let Some(raw) = resp
        .headers()
        .get("profile-title")
        .and_then(|v| v.to_str().ok())
    {
        let mut title = raw.to_string();
        if let Some(b64) = title.strip_prefix("base64:") {
            if let Ok(decoded) = b64_decode(b64) {
                if let Ok(s) = String::from_utf8(decoded) {
                    title = s;
                }
            }
        }
        info.title = urlencoding::decode(&title)
            .map(|c| c.into_owned())
            .unwrap_or(title);
    }

    // subscription-userinfo: upload=..; download=..; total=..; expire=..
    if let Some(raw) = resp
        .headers()
        .get("subscription-userinfo")
        .and_then(|v| v.to_str().ok())
    {
        for part in raw.split(';') {
            let kv: Vec<&str> = part.trim().splitn(2, '=').collect();
            if kv.len() != 2 {
                continue;
            }
            if let Ok(v) = kv[1].trim().parse::<i64>() {
                match kv[0].trim() {
                    "upload" => info.upload = v,
                    "download" => info.download = v,
                    "total" => info.total = v,
                    "expire" => info.expire_unix = v,
                    _ => {}
                }
            }
        }
    }

    let content = resp.text().await.map_err(|e| e.to_string())?;
    Ok((content, info))
}

// ── ГЛАВНЫЙ ПАРСЕР (порт Parse) ──────────────────────────────────────────────
pub fn parse(content: &str) -> Vec<ServerConfig> {
    // 1) Happ xray-массив — проверяем В САМОМ НАЧАЛЕ
    if content.trim_start().starts_with('[') {
        let from_happ = parse_happ_xray_array(content);
        if !from_happ.is_empty() {
            return from_happ;
        }
    }

    let mut result = Vec::new();
    let mut content = content.replace("\r\n", "\n").replace('\r', "\n");
    content = content.trim().to_string();

    if content.contains("proxies:") {
        // Clash / Mihomo YAML
        result.extend(parse_clash_yaml(&content));
    } else {
        // base64-обёртка, если нет "://"
        if !content.contains("://") {
            if let Ok(decoded) = b64_decode(&content) {
                if let Ok(s) = String::from_utf8(decoded) {
                    content = s;
                }
            }
        }

        for line in content.split('\n').filter(|l| !l.trim().is_empty()) {
            let trimmed = line.trim();
            let cfg = if trimmed.starts_with("vless://") {
                parse_vless(trimmed)
            } else if trimmed.starts_with("vmess://") {
                parse_vmess(trimmed)
            } else if trimmed.starts_with("trojan://") {
                parse_trojan(trimmed)
            } else if trimmed.starts_with("ss://") {
                parse_shadowsocks(trimmed)
            } else {
                None
            };
            if let Some(c) = cfg {
                result.push(c);
            }
        }
    }

    result
}

// ── Happ xray-массив (порт ParseHappXrayArray) ───────────────────────────────
fn parse_happ_xray_array(json: &str) -> Vec<ServerConfig> {
    let mut result = Vec::new();
    let arr: Value = match serde_json::from_str(json) {
        Ok(v) => v,
        Err(_) => return result,
    };
    let arr = match arr.as_array() {
        Some(a) => a,
        None => return result,
    };

    for item in arr {
        let remarks = item
            .get("remarks")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string();

        let outbounds = match item.get("outbounds").and_then(|v| v.as_array()) {
            Some(o) => o,
            None => continue,
        };

        // Первый outbound с тегом, начинающимся на "proxy"
        let proxy_out = outbounds.iter().find(|o| {
            o.get("tag")
                .and_then(|v| v.as_str())
                .map(|t| t.starts_with("proxy"))
                .unwrap_or(false)
        });
        let proxy_out = match proxy_out {
            Some(p) => p,
            None => continue,
        };

        let protocol = proxy_out
            .get("protocol")
            .and_then(|v| v.as_str())
            .unwrap_or("");
        if !matches!(protocol, "vless" | "vmess" | "trojan") {
            continue;
        }

        let settings = proxy_out.get("settings");
        let stream = proxy_out.get("streamSettings");
        if settings.is_none() {
            continue;
        }

        let vnext = settings
            .and_then(|s| s.get("vnext"))
            .and_then(|v| v.as_array())
            .and_then(|a| a.first());
        let vnext = match vnext {
            Some(v) => v,
            None => continue,
        };

        let address = vnext.get("address").and_then(|v| v.as_str()).unwrap_or("");
        let port = vnext
            .get("port")
            .and_then(|v| v.as_u64())
            .unwrap_or(0) as u16;

        let users = vnext.get("users").and_then(|v| v.as_array()).and_then(|a| a.first());
        let id = users.and_then(|u| u.get("id")).and_then(|v| v.as_str()).unwrap_or("");
        let flow = users.and_then(|u| u.get("flow")).and_then(|v| v.as_str()).unwrap_or("");

        let network = stream
            .and_then(|s| s.get("network"))
            .and_then(|v| v.as_str())
            .unwrap_or("tcp");
        let security = stream
            .and_then(|s| s.get("security"))
            .and_then(|v| v.as_str())
            .unwrap_or("none");

        let mut cfg = ServerConfig {
            protocol: protocol.into(),
            name: remarks,
            address: address.into(),
            port,
            id: id.into(),
            flow: flow.into(),
            network: network.into(),
            security: security.into(),
            ..Default::default()
        };

        if security == "reality" {
            let rs = stream.and_then(|s| s.get("realitySettings"));
            cfg.server_name = str_at(rs, "serverName");
            cfg.public_key = str_at(rs, "publicKey");
            cfg.short_id = str_at(rs, "shortId");
            cfg.fingerprint = str_or(rs, "fingerprint", "chrome");
        } else if security == "tls" {
            let ts = stream.and_then(|s| s.get("tlsSettings"));
            cfg.server_name = str_at(ts, "serverName");
            cfg.fingerprint = str_or(ts, "fingerprint", "chrome");
        }

        if network == "xhttp" {
            let xh = stream.and_then(|s| s.get("xhttpSettings"));
            cfg.path = str_or(xh, "path", "/");
            cfg.xhttp_host = str_at(xh, "host");
            cfg.xhttp_mode = str_or(xh, "mode", "auto");

            let xmux = xh.and_then(|x| x.get("extra")).and_then(|e| e.get("xmux"));
            if let Some(xmux) = xmux {
                cfg.has_xmux = true;
                if let Some(lt) = xmux.get("cMaxLifetimeMs").and_then(|v| v.as_i64()) {
                    cfg.xmux_max_lifetime = lt;
                }
                cfg.xmux_max_reuse = value_to_string(xmux.get("cMaxReuseTimes"));
                cfg.xmux_concurrency = value_to_string(xmux.get("maxConcurrency"));
            }
        } else if network == "ws" {
            let ws = stream.and_then(|s| s.get("wsSettings"));
            cfg.path = str_or(ws, "path", "/");
        }

        if cfg.address.is_empty() || port == 0 {
            continue;
        }
        result.push(cfg);
    }

    result
}

// ── Clash YAML (порт ParseClashYaml / ParseClashProxy) ───────────────────────
fn parse_clash_yaml(yaml: &str) -> Vec<ServerConfig> {
    let mut result = Vec::new();

    let idx = yaml
        .find("\nproxies:")
        .or_else(|| yaml.find("proxies:"));
    let idx = match idx {
        Some(i) => i,
        None => return result,
    };

    let line_end = yaml[idx + 1..].find('\n').map(|p| idx + 1 + p).unwrap_or(yaml.len());
    let start = (line_end + 1).min(yaml.len());

    let mut proxy_lines: Vec<&str> = Vec::new();
    for line in yaml[start..].split('\n') {
        let t = line.trim_start();
        if t.starts_with("rules:") || t.starts_with("rule-providers:") {
            break;
        }
        proxy_lines.push(line);
    }

    // Разбиваем на блоки по "- " (начало новой записи прокси)
    let mut blocks: Vec<String> = Vec::new();
    let mut current = String::new();
    for line in proxy_lines {
        if line.trim_start().starts_with("- ") && !current.is_empty() {
            blocks.push(std::mem::take(&mut current));
        }
        current.push_str(line);
        current.push('\n');
    }
    if !current.is_empty() {
        blocks.push(current);
    }

    for block in blocks {
        if let Some(cfg) = parse_clash_proxy(&block) {
            result.push(cfg);
        }
    }

    result
}

fn parse_clash_proxy(block: &str) -> Option<ServerConfig> {
    let lines: Vec<&str> = block.split('\n').collect();

    let get = |key: &str| -> String {
        for line in &lines {
            let trimmed = line.trim().trim_start_matches('-').trim();
            let prefix = format!("{key}:");
            if trimmed.to_ascii_lowercase().starts_with(&prefix.to_ascii_lowercase()) {
                return trimmed[prefix.len()..]
                    .trim()
                    .trim_matches(|c| c == '"' || c == '\'')
                    .to_string();
            }
        }
        String::new()
    };

    let get_nested = |parent: &str, child: &str| -> String {
        let mut in_parent = false;
        for line in &lines {
            let trimmed = line.trim();
            if trimmed
                .to_ascii_lowercase()
                .starts_with(&format!("{}:", parent.to_ascii_lowercase()))
            {
                in_parent = true;
                continue;
            }
            if in_parent {
                if !line.is_empty() && !line.starts_with(' ') && !line.starts_with("  ") {
                    break;
                }
                let cp = format!("{child}:");
                if trimmed
                    .to_ascii_lowercase()
                    .starts_with(&cp.to_ascii_lowercase())
                {
                    return trimmed[cp.len()..]
                        .trim()
                        .trim_matches(|c| c == '"' || c == '\'')
                        .to_string();
                }
            }
        }
        String::new()
    };

    let type_ = get("type").to_ascii_lowercase();
    if type_.is_empty() {
        return None;
    }
    if !matches!(type_.as_str(), "vless" | "vmess" | "trojan" | "ss" | "shadowsocks") {
        return None;
    }

    let port: u16 = get("port").parse().unwrap_or(0);

    let mut cfg = ServerConfig {
        protocol: if type_ == "shadowsocks" { "ss".into() } else { type_.clone() },
        name: get("name"),
        address: get("server"),
        port,
        id: get("uuid"),
        network: get("network"),
        server_name: get("servername"),
        flow: get("flow"),
        fingerprint: get("client-fingerprint"),
        path: get("ws-path"),
        public_key: get_nested("reality-opts", "public-key"),
        short_id: get_nested("reality-opts", "short-id"),
        ..Default::default()
    };

    // Security
    if block.contains("reality-opts:") {
        cfg.security = "reality".into();
    } else if get("tls") == "true" {
        cfg.security = "tls".into();
    } else {
        cfg.security = "none".into();
    }

    if type_ == "trojan" {
        cfg.security = "tls".into();
        cfg.id = get("password");
    }
    if type_ == "ss" || type_ == "shadowsocks" {
        cfg.id = get("password");
    }

    if cfg.network == "xhttp" {
        let mode = get_nested("xhttp-opts", "mode");
        if !mode.is_empty() {
            cfg.xhttp_mode = mode;
        }
        let host = get_nested("xhttp-opts", "host");
        if !host.is_empty() {
            cfg.xhttp_host = host;
        }
        let conc = get_nested("xmux", "maxConcurrency");
        if !conc.is_empty() {
            cfg.has_xmux = true;
            cfg.xmux_concurrency = conc;
            if let Ok(lt) = get_nested("xmux", "cMaxLifetimeMs").parse::<i64>() {
                cfg.xmux_max_lifetime = lt;
            }
            let reuse = get_nested("xmux", "cMaxReuseTimes");
            if !reuse.is_empty() {
                cfg.xmux_max_reuse = reuse;
            }
        }
    }

    if cfg.name.is_empty() {
        cfg.name = format!("{}://{}:{}", type_, cfg.address, cfg.port);
    }
    if cfg.network.is_empty() {
        cfg.network = "tcp".into();
    }
    if cfg.fingerprint.is_empty() {
        cfg.fingerprint = "chrome".into();
    }

    Some(cfg)
}

// ── URI-парсеры (порт ParseVless / ParseVmess / ParseTrojan / ParseShadowsocks)
fn parse_vless(uri: &str) -> Option<ServerConfig> {
    let u = url::Url::parse(uri).ok()?;
    let q = query_map(&u);
    Some(ServerConfig {
        protocol: "vless".into(),
        id: percent_decode(u.username()),
        address: u.host_str().unwrap_or("").into(),
        port: u.port().unwrap_or(443),
        security: q.get("security").cloned().unwrap_or_else(|| "none".into()),
        network: q.get("type").cloned().unwrap_or_else(|| "tcp".into()),
        server_name: q.get("sni").cloned().unwrap_or_else(|| u.host_str().unwrap_or("").into()),
        public_key: q.get("pbk").cloned().unwrap_or_default(),
        short_id: q.get("sid").cloned().unwrap_or_default(),
        flow: q.get("flow").cloned().unwrap_or_default(),
        fingerprint: q.get("fp").cloned().unwrap_or_else(|| "chrome".into()),
        path: q.get("path").cloned().unwrap_or_else(|| "/".into()),
        name: fragment_name(&u),
        ..Default::default()
    })
}

fn parse_vmess(uri: &str) -> Option<ServerConfig> {
    let payload = &uri[8..];
    let decoded = b64_decode(payload).ok()?;
    let json: Value = serde_json::from_slice(&decoded).ok()?;

    let get = |k: &str| json.get(k).map(value_to_string_inner).unwrap_or_default();

    let port = get("port").parse::<u16>().unwrap_or(443);
    Some(ServerConfig {
        protocol: "vmess".into(),
        id: get("id"),
        address: get("add"),
        port,
        network: get("net"),
        security: if get("tls") == "tls" { "tls".into() } else { "none".into() },
        server_name: get("sni"),
        path: get("path"),
        name: get("ps"),
        ..Default::default()
    })
}

fn parse_trojan(uri: &str) -> Option<ServerConfig> {
    let u = url::Url::parse(uri).ok()?;
    let q = query_map(&u);
    Some(ServerConfig {
        protocol: "trojan".into(),
        id: percent_decode(u.username()),
        address: u.host_str().unwrap_or("").into(),
        port: u.port().unwrap_or(443),
        security: "tls".into(),
        network: q.get("type").cloned().unwrap_or_else(|| "tcp".into()),
        server_name: q.get("sni").cloned().unwrap_or_else(|| u.host_str().unwrap_or("").into()),
        name: fragment_name(&u),
        ..Default::default()
    })
}

fn parse_shadowsocks(uri: &str) -> Option<ServerConfig> {
    let u = url::Url::parse(uri).ok()?;
    Some(ServerConfig {
        protocol: "ss".into(),
        address: u.host_str().unwrap_or("").into(),
        port: u.port().unwrap_or(443),
        name: fragment_name(&u),
        ..Default::default()
    })
}

// ── ВСПОМОГАТЕЛЬНОЕ ──────────────────────────────────────────────────────────
fn query_map(u: &url::Url) -> std::collections::HashMap<String, String> {
    u.query_pairs()
        .map(|(k, v)| (k.into_owned(), v.into_owned()))
        .collect()
}

fn fragment_name(u: &url::Url) -> String {
    u.fragment()
        .map(|f| percent_decode(f))
        .unwrap_or_default()
}

fn percent_decode(s: &str) -> String {
    urlencoding::decode(s).map(|c| c.into_owned()).unwrap_or_else(|_| s.to_string())
}

// base64 с добивкой '=' и заменой url-safe символов (порт PadBase64)
fn b64_decode(s: &str) -> Result<Vec<u8>, base64::DecodeError> {
    let mut s = s.replace('-', "+").replace('_', "/");
    match s.len() % 4 {
        2 => s.push_str("=="),
        3 => s.push('='),
        _ => {}
    }
    base64::engine::general_purpose::STANDARD.decode(s)
}

fn str_at(node: Option<&Value>, key: &str) -> String {
    node.and_then(|n| n.get(key)).and_then(|v| v.as_str()).unwrap_or("").to_string()
}
fn str_or(node: Option<&Value>, key: &str, default: &str) -> String {
    let v = str_at(node, key);
    if v.is_empty() { default.to_string() } else { v }
}
fn value_to_string(v: Option<&Value>) -> String {
    v.map(value_to_string_inner).unwrap_or_default()
}
fn value_to_string_inner(v: &Value) -> String {
    match v {
        Value::String(s) => s.clone(),
        Value::Number(n) => n.to_string(),
        Value::Bool(b) => b.to_string(),
        _ => String::new(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_vless_uri() {
        let uri = "vless://11111111-2222-3333-4444-555555555555@example.com:443?security=reality&type=tcp&sni=sni.example&pbk=KEY&sid=ab&flow=xtls-rprx-vision&fp=chrome#My%20Server";
        let list = parse(uri);
        assert_eq!(list.len(), 1);
        let s = &list[0];
        assert_eq!(s.protocol, "vless");
        assert_eq!(s.address, "example.com");
        assert_eq!(s.port, 443);
        assert_eq!(s.security, "reality");
        assert_eq!(s.server_name, "sni.example");
        assert_eq!(s.name, "My Server");
    }

    #[test]
    fn parse_base64_list() {
        let raw = "vless://uuid@a.com:443?type=tcp#A\ntrojan://pass@b.com:8443?sni=b.com#B";
        let b64 = base64::engine::general_purpose::STANDARD.encode(raw);
        let list = parse(&b64);
        assert_eq!(list.len(), 2);
        assert_eq!(list[0].protocol, "vless");
        assert_eq!(list[1].protocol, "trojan");
    }
}
