// ============================================================================
//  config.rs — перенос ConfigGenerator.cs
//
//  Генерирует config.json для xray. Логика 1:1 с C#-версией, включая три
//  критичных момента, которые Вы отлаживали:
//    1) sniffing на socks-inbound (destOverride http/tls/quic) — иначе в
//       TUN-режиме правила по доменам не срабатывают: tun2socks отдаёт xray
//       уже резолвнутые IP, а не домены.
//    2) DNS-секция + правило "port 53 → proxy" ТОЛЬКО в TUN-режиме — иначе
//       резолв уходит в петлю через сам туннель.
//    3) sockopt.interface на direct-outbound в TUN-режиме — иначе bypass
//       зацикливается: маршруты 0.0.0.0/1 и 128.0.0.0/1 заворачивают freedom
//       обратно в TUN.
// ============================================================================

use crate::models::{ServerConfig, SplitTunnelSettings};
use serde_json::{json, Value};

// ── ГЛАВНЫЙ МЕТОД ────────────────────────────────────────────────────────────
// split = None → поведение как раньше (только bittorrent → direct).
pub fn generate(s: &ServerConfig, split: Option<&SplitTunnelSettings>) -> String {
    let tun_mode = split.map(|x| x.tun_mode).unwrap_or(false);

    let mut config = json!({
        "log": { "loglevel": "error" },
        "inbounds": [
            {
                "listen": "127.0.0.1",
                "port": 19808,
                "protocol": "socks",
                "settings": { "auth": "noauth", "udp": true },
                // sniffing нужен для TUN-режима (см. шапку файла)
                "sniffing": {
                    "enabled": true,
                    "destOverride": ["http", "tls", "quic"],
                    "routeOnly": false
                },
                "tag": "socks"
            },
            {
                "listen": "127.0.0.1",
                "port": 19809,
                "protocol": "http",
                "tag": "http"
            }
        ],
        "outbounds": [
            build_outbound(s),
            build_direct_outbound(split),
            { "protocol": "blackhole", "tag": "block" }
        ],
        "routing": {
            "domainStrategy": "AsIs",
            "rules": build_routing_rules(split)
        }
    });

    // DNS-секция только в TUN-режиме
    if tun_mode {
        config["dns"] = json!({
            "servers": ["1.1.1.1", "8.8.8.8"],
            "queryStrategy": "UseIPv4",
            "disableCache": false
        });
    }

    serde_json::to_string_pretty(&config).unwrap_or_else(|_| "{}".into())
}

// ── Валидация домена (порт IsValidXrayDomain) ────────────────────────────────
fn is_valid_xray_domain(d: &str) -> bool {
    let dl = d.to_ascii_lowercase();
    if dl.starts_with("geosite:")
        || dl.starts_with("regexp:")
        || dl.starts_with("keyword:")
        || dl.starts_with("full:")
    {
        return true;
    }
    // обычный домен: буквы, цифры, точки, дефисы, звёздочки
    d.chars()
        .all(|c| c.is_ascii_alphanumeric() || c == '.' || c == '-' || c == '*')
        && !d.is_empty()
}

// ── DIRECT OUTBOUND (порт BuildDirectOutbound) ───────────────────────────────
fn build_direct_outbound(split: Option<&SplitTunnelSettings>) -> Value {
    let mut direct = json!({ "protocol": "freedom", "tag": "direct" });

    if let Some(sp) = split {
        if sp.tun_mode && !sp.physical_interface.trim().is_empty() {
            direct["streamSettings"] = json!({
                "sockopt": { "interface": sp.physical_interface }
            });
        }
    }
    direct
}

// ── ROUTING RULES (порт BuildRoutingRules) ───────────────────────────────────
fn build_routing_rules(split: Option<&SplitTunnelSettings>) -> Value {
    let mut rules: Vec<Value> = Vec::new();

    let tun_mode = split.map(|x| x.tun_mode).unwrap_or(false);

    // 0. DNS через прокси — ПЕРВЫМ правилом (только TUN)
    if tun_mode {
        rules.push(json!({
            "type": "field",
            "outboundTag": "proxy",
            "port": 53,
            "network": "udp"
        }));
    }

    // 1. Bittorrent всегда напрямую
    rules.push(json!({
        "type": "field",
        "outboundTag": "direct",
        "protocol": ["bittorrent"]
    }));

    let sp = match split {
        Some(s) => s,
        None => return Value::Array(rules),
    };

    // 2. Bypass LAN
    if sp.bypass_lan {
        rules.push(json!({
            "type": "field",
            "outboundTag": "direct",
            "ip": ["geoip:private"]
        }));
    }

    // 3. Bypass домены (с той же фильтрацией, что в C#: split по '|', trim,
    //    без пробелов, только валидные, distinct)
    let mut seen = std::collections::HashSet::new();
    let domains: Vec<String> = sp
        .bypass_domains
        .iter()
        .flat_map(|d| d.split('|'))
        .map(|d| d.trim().to_string())
        .filter(|d| !d.is_empty())
        .filter(|d| !d.contains(' '))
        .filter(|d| is_valid_xray_domain(d))
        .filter(|d| seen.insert(d.clone()))
        .collect();

    if !domains.is_empty() {
        rules.push(json!({
            "type": "field",
            "outboundTag": "direct",
            "domain": domains
        }));
    }

    // 4. Bypass IP / CIDR
    let ips: Vec<String> = sp
        .bypass_ips
        .iter()
        .map(|ip| ip.trim().to_string())
        .filter(|ip| !ip.is_empty())
        .collect();

    if !ips.is_empty() {
        rules.push(json!({
            "type": "field",
            "outboundTag": "direct",
            "ip": ips
        }));
    }

    Value::Array(rules)
}

// ── OUTBOUND (порт BuildOutbound) ────────────────────────────────────────────
fn build_outbound(s: &ServerConfig) -> Value {
    let mut outbound = json!({ "tag": "proxy" });

    match s.protocol.as_str() {
        "vless" => {
            outbound["protocol"] = json!("vless");
            outbound["settings"] = json!({
                "vnext": [{
                    "address": s.address,
                    "port": s.port,
                    "users": [{
                        "id": s.id,
                        "encryption": "none",
                        "flow": s.flow
                    }]
                }]
            });

            let mut stream = json!({ "network": s.network });

            // TLS / Reality
            if s.security == "reality" {
                stream["security"] = json!("reality");
                stream["realitySettings"] = json!({
                    "serverName": s.server_name,
                    "fingerprint": s.fingerprint,
                    "publicKey": s.public_key,
                    "shortId": s.short_id
                });
            } else if s.security == "tls" {
                stream["security"] = json!("tls");
                stream["tlsSettings"] = json!({
                    "serverName": s.server_name,
                    "fingerprint": s.fingerprint
                });
            }

            // Transport
            match s.network.as_str() {
                "ws" => {
                    stream["wsSettings"] = json!({
                        "path": s.path,
                        "headers": { "Host": s.server_name }
                    });
                }
                "xhttp" => {
                    let host = if !s.xhttp_host.is_empty() {
                        s.xhttp_host.clone()
                    } else {
                        s.server_name.clone()
                    };
                    let mode = if !s.xhttp_mode.is_empty() {
                        s.xhttp_mode.clone()
                    } else {
                        "auto".to_string()
                    };
                    let mut xhttp = json!({
                        "path": s.path,
                        "host": host,
                        "mode": mode
                    });
                    if s.has_xmux {
                        xhttp["extra"] = json!({
                            "xmux": {
                                "cMaxLifetimeMs": s.xmux_max_lifetime,
                                "cMaxReuseTimes": s.xmux_max_reuse,
                                "maxConcurrency": s.xmux_concurrency,
                                "maxConnections": 0,
                                "hKeepAlivePeriod": 30
                            }
                        });
                    }
                    stream["xhttpSettings"] = xhttp;
                }
                "grpc" => {
                    stream["grpcSettings"] = json!({ "serviceName": s.path });
                }
                _ => {}
            }

            outbound["streamSettings"] = stream;
        }
        "vmess" => {
            outbound["protocol"] = json!("vmess");
            outbound["settings"] = json!({
                "vnext": [{
                    "address": s.address,
                    "port": s.port,
                    "users": [{
                        "id": s.id,
                        "alterId": 0,
                        "security": "auto"
                    }]
                }]
            });
        }
        "trojan" => {
            outbound["protocol"] = json!("trojan");
            outbound["settings"] = json!({
                "servers": [{
                    "address": s.address,
                    "port": s.port,
                    "password": s.id
                }]
            });
        }
        _ => {}
    }

    outbound
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn vless_reality_basic() {
        let s = ServerConfig {
            protocol: "vless".into(),
            address: "example.com".into(),
            port: 443,
            id: "uuid-1".into(),
            security: "reality".into(),
            network: "tcp".into(),
            public_key: "pbk".into(),
            short_id: "sid".into(),
            server_name: "sni.example".into(),
            flow: "xtls-rprx-vision".into(),
            ..Default::default()
        };
        let out = generate(&s, None);
        assert!(out.contains("\"protocol\": \"vless\""));
        assert!(out.contains("realitySettings"));
        assert!(out.contains("bittorrent"));
        // без split нет DNS-секции
        assert!(!out.contains("\"dns\""));
    }

    #[test]
    fn tun_mode_adds_dns_and_sockopt() {
        let s = ServerConfig {
            protocol: "vless".into(),
            address: "1.2.3.4".into(),
            port: 443,
            id: "uuid".into(),
            security: "tls".into(),
            network: "tcp".into(),
            ..Default::default()
        };
        let split = SplitTunnelSettings {
            tun_mode: true,
            physical_interface: "Ethernet 2".into(),
            bypass_domains: vec!["google.com".into(), "bad domain".into(), "geosite:ru".into()],
            bypass_ips: vec!["10.0.0.0/8".into()],
            ..Default::default()
        };
        let out = generate(&s, Some(&split));
        assert!(out.contains("\"dns\""));
        assert!(out.contains("\"interface\": \"Ethernet 2\""));
        assert!(out.contains("geosite:ru"));
        assert!(out.contains("google.com"));
        // домен с пробелом должен быть отфильтрован
        assert!(!out.contains("bad domain"));
    }
}
