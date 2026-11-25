# BearNest VPN

A lightweight Windows desktop client for [Xray-core](https://github.com/XTLS/Xray-core), built with **Tauri 2 + Rust**. Import a subscription link, pick a server, and connect through a system proxy or a full TUN tunnel. Split tunneling, auto-switching and custom themes are built in.

> Version 2.10.0 · Windows 10/11

<!-- Add screenshots here, e.g.:
![Servers](docs/screenshots/servers.png)
-->

## Features

**Connection**
- Import servers from a subscription URL; shows the provider's title, traffic usage and expiry date when available
- Protocols: VLESS, VMess, Trojan
- Security and transports: Reality, TLS, TCP, WebSocket, gRPC, XHTTP (with xmux options)
- Two modes:
  - **System proxy**: local HTTP/SOCKS inbound, set as the Windows proxy
  - **TUN**: all traffic, including UDP and DNS, routed through a virtual adapter (tun2socks + Wintun). Requires administrator rights
- TCP ping for every server, with sorting by name, protocol or ping
- Soft server switching without dropping the session timer

**Reliability**
- Connection self-test through the local SOCKS port
- Optional auto-switch to another live server when the connection fails
- Native Windows notifications for failures and automatic switches
- Auto-connect on start; the window hides to the system tray, and exiting from the tray cleans up the proxy, routes and processes

**Split tunneling**
- Bypass the VPN for domains, IP/CIDR ranges and the local network
- Supports plain domains and the `geosite:`, `regexp:`, `keyword:` and `full:` prefixes
- Bittorrent traffic always goes direct

**Interface**
- Custom title bar, splash screen, tray menu
- Built-in themes (Dark, Light, Nord, Bear) plus a theme editor with import/export, scrollbar customization
- Russian and English
- Import/export of client settings
- Live log view with filtering and pause; logs are also written to rolling files

## Requirements

- Windows 10 or 11 (x64)
- [WebView2 runtime](https://developer.microsoft.com/microsoft-edge/webview2/) (preinstalled on current Windows versions)
- Administrator rights for TUN mode only

## Installation

Download the latest build from the [Releases](../../releases) page and run the installer, or unpack the portable build.

The app expects a `core` folder next to the executable:

```
core/
├── xray.exe
├── tun2socks.exe
├── wintun.dll
├── geoip.dat
└── geosite.dat
```

These files are third-party binaries and are not part of this repository. Get them from their official releases (see [Credits](#credits)).

## Usage

1. Paste your subscription URL and press **Load**.
2. Select a server in the **Servers** tab (use **Ping** to compare).
3. Press **Connect**. Enable **TUN** first if you want all traffic, including UDP, to go through the VPN.
4. Add domains or IP ranges that should skip the VPN in the **Bypass** tab.
5. Configure language, theme, auto-connect and auto-switch in **Settings**.

## Data and logs

| What | Where |
|---|---|
| Settings (SQLite) | `%LOCALAPPDATA%\BearNest\settings.db` |
| Log files | `%LOCALAPPDATA%\BearNest\logs\bearnest_*.log` |

Local listeners used by the app: SOCKS `127.0.0.1:19808` and HTTP `127.0.0.1:19809`.

## Building from source

Prerequisites: [Rust](https://rustup.rs/), the [Tauri 2 prerequisites for Windows](https://tauri.app/start/prerequisites/) (MSVC build tools, WebView2), and the Tauri CLI.

```powershell
cargo install tauri-cli --version "^2" --locked

# development
cargo tauri dev

# release build with installer
cargo tauri build

# executable only, no installer
cargo tauri build --no-bundle
```

Put the `core` folder next to the built executable (for `cargo tauri dev`, `src-tauri/core` also works). Run the terminal as administrator if you want to test TUN mode.

## Project layout
<img width="388" height="450" alt="image" src="https://github.com/user-attachments/assets/c6560209-8778-4883-b256-8344e2b38db6" />

```
.
├── index.html, editor.html, splash.html   UI windows
├── main.js, editor.js, i18n.js, themes.js  frontend logic
├── styles.css
└── src-tauri/src
    ├── lib.rs        app setup, tray, window events
    ├── commands.rs   connect / disconnect / switch / ping / settings
    ├── config.rs     Xray config generator
    ├── xcore.rs      Xray process manager
    ├── tun.rs        TUN setup (routes, adapter, DNS)
    ├── storage.rs    SQLite settings store
    └── ...           subscription, pinger, system proxy, notifications
```


The project is a Rust/Tauri port of an earlier C#/WPF client.

## Disclaimer

BearNest is a client for connecting to servers you have the right to use. You are responsible for complying with the laws that apply to you and with the terms of your server or subscription provider.

## Credits

- [Xray-core](https://github.com/XTLS/Xray-core): proxy core
- [tun2socks](https://github.com/xjasonlyu/tun2socks): TUN to SOCKS bridge
- [Wintun](https://www.wintun.net/): Windows TUN driver
- [Tauri](https://tauri.app/)

## License

MIT. See [LICENSE](LICENSE)
