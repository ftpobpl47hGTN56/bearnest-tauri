// ============================================================================
//  main.js — вся логика фронтенда BearNest.
//  Общается с Rust-бэкендом через window.__TAURI__.core.invoke(...) и слушает
//  события "log" / "status" / "tun-status" / "toast".
// ============================================================================

const T = window.__TAURI__;
const invoke = T.core.invoke;
const listen = T.event.listen;
const appWindow = T.window.getCurrentWindow();

// ── Состояние UI (сервера и выбор живут на фронте, как в WPF) ────────────────
// МУЛЬТИПОДПИСКА: subs — источник правды (список подписок, каждая со своими
// серверами), servers — плоский вид ВСЕХ серверов (объекты-ссылки на элементы
// sub.servers, поэтому пинг/сортировка пишут прямо в подписку).
let subs = [];            // [{id, name, url, servers[], info, collapsed}]
let servers = [];         // плоский список всех серверов всех подписок
let selectedIndex = -1;
let selectedSubId = null;  // подписка ВЫБРАННОГО сервера
let connectedSubId = null;// подписка ПОДКЛЮЧЁННОГО сервера
let connectedName = null; // имя реально подключённого сервера (для 🟢 в списке)
let connected = false;
let connectTime = null;
let timerHandle = null;

const $ = (id) => document.getElementById(id);

// ── Хелперы настроек (обёртки над командами get_setting/set_setting) ─────────
function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }
// Безопасно повесить обработчик (не падаем, если элемента нет в разметке)
function on(id, ev, fn) { const el = $(id); if (el) el.addEventListener(ev, fn); }
// Ждём, пока Rust поднимет состояние/IPC: пингуем лёгкую команду, пока не ответит.
async function waitBackendReady() {
  for (let i = 0; i < 40; i++) {
    try { await invoke("get_setting", { key: "__ping" }); return; }
    catch (e) { await sleep(150); }
  }
}
async function getSetting(key) {
  for (let i = 0; i < 20; i++) {
    try { return await invoke("get_setting", { key }); }
    catch (e) { await sleep(150); }
  }
  return null;
}
async function setSetting(key, value) {
  for (let i = 0; i < 5; i++) {
    try { await invoke("set_setting", { key, value }); return; }
    catch (e) { await sleep(150); }
  }
}

// ── ЛОГ ──────────────────────────────────────────────────────────────────────
let logFilter = "all";
function classifyLog(line) {
  const l = line.toLowerCase();
  if (l.includes("error") || l.includes("❌") || l.includes("failed") || l.includes("упал")) return "err";
  if (l.includes("✅") || l.includes("started") || l.includes("активен")) return "ok";
  if (line.includes("[BearNest]") || line.includes("[tun2socks]")) return "bn";
  return "";
}
function matchesFilter(line) {
  if (logFilter === "all") return true;
  if (logFilter === "bearnest") return line.includes("[BearNest]") || line.includes("[tun2socks]");
  if (logFilter === "error") return classifyLog(line) === "err";
  return true;
}
function renderLine(line) {
  if (!matchesFilter(line)) return;
  const box = $("logBox");
  const div = document.createElement("div");
  div.className = "log-line " + classifyLog(line);
  div.textContent = line;
  box.appendChild(div);
  while (box.childElementCount > 500) box.removeChild(box.firstChild);
  box.scrollTop = box.scrollHeight;
}

// ── Пауза лога ───────────────────────────────────────────────────────────────
let logPaused = false;
const pausedBuffer = [];
const ICON_PAUSE = '<rect x="6" y="4" width="4" height="16"/><rect x="14" y="4" width="4" height="16"/>';
const ICON_PLAY = '<polygon points="6 4 20 12 6 20 6 4"/>';

function addLog(line) {
  if (logPaused) {
    pausedBuffer.push(line);
    if (!fromBackend) invoke("log_write", { line }).catch(() => {}); // в файл — до паузы/фильтра
    if (pausedBuffer.length > 500) pausedBuffer.shift();
    setPauseLabel(true);
    return;
  }
  renderLine(line);
}
function setPauseLabel(paused) {
  const btn = $("btnPauseLog");
  if (!btn) return;
  const svg = btn.querySelector("svg");
  const span = btn.querySelector("span");
  if (paused) {
    svg.innerHTML = ICON_PLAY;
    const n = pausedBuffer.length;
    span.textContent = I18N.t("BtnResume") + (n ? ` (${n})` : "");
  } else {
    svg.innerHTML = ICON_PAUSE;
    span.textContent = I18N.t("BtnPause");
  }
}
function togglePause() {
  logPaused = !logPaused;
  $("btnPauseLog").classList.toggle("paused", logPaused);
  if (!logPaused) {
    const buffered = pausedBuffer.splice(0, pausedBuffer.length);
    buffered.forEach(renderLine);
  }
  setPauseLabel(logPaused);
}

// ── ТОСТ ─────────────────────────────────────────────────────────────────────
let toastTimer = null;
function showToast(icon, message) {
  $("toastIcon").textContent = icon;
  $("toastText").textContent = message;
  const t = $("toast");
  t.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove("show"), 3000);
}

// ── WINDOWS-УВЕДОМЛЕНИЯ (Action Center, tauri-plugin-notification) ───────────
// Шлём нативный тост Windows, когда туннель падает (таймаут/TLS/DNS/...) и
// когда автопереключение молча меняет сервер — иначе юзер узнаёт о смене
// только по «сайт вдруг перезагрузился».
let notifAllowed = false;
async function initNotifications() {
  try {
    const n = T.notification;
    if (!n) return;
    notifAllowed = await n.isPermissionGranted();
    if (!notifAllowed) {
      const p = await n.requestPermission();
      notifAllowed = p === "granted";
    }
  } catch (_) { notifAllowed = false; }
}
function notifyWindows(title, body) {
  // Основной путь — Rust-команда notify_native: тост шлёт сам процесс через
  // WinRT от имени нашего AUMID (не зависит от наличия JS-плагина).
  // Фолбэк — tauri-plugin-notification, если команда вдруг недоступна.
  try {
    invoke("notify_native", { title, body }).catch(() => {
      if (notifAllowed) { try { T.notification.sendNotification({ title, body }); } catch (_) {} }
    });
  } catch (_) {
    if (notifAllowed) { try { T.notification.sendNotification({ title, body }); } catch (_) {} }
  }
}

// ── ТАЙМЕР СЕССИИ ────────────────────────────────────────────────────────────
function startTimer() {
  connectTime = Date.now();
  clearInterval(timerHandle);
  timerHandle = setInterval(tickTimer, 1000);
  tickTimer();
}
function stopTimer() {
  clearInterval(timerHandle);
  connectTime = null;
  $("timerText").textContent = "";
}
function tickTimer() {
  if (!connectTime) return;
  let s = Math.floor((Date.now() - connectTime) / 1000);
  const d = Math.floor(s / 86400); s -= d * 86400;
  const h = Math.floor(s / 3600); s -= h * 3600;
  const m = Math.floor(s / 60); s -= m * 60;
  const pad = (n) => String(n).padStart(2, "0");
  $("timerText").textContent = (d > 0 ? `${d}д ` : "") + `${pad(h)}:${pad(m)}:${pad(s)}`;
}

// ── СТАТУС ───────────────────────────────────────────────────────────────────
function setConnectedUI(isOn) {
  connected = isOn;
  const pill = $("statusPill");
  pill.classList.toggle("on", isOn);
  pill.classList.toggle("off", !isOn);
  $("statusText").textContent = isOn ? I18N.t("StatusConnected") : I18N.t("StatusStopped");
  $("btnConnect").disabled = isOn;
  $("btnDisconnect").disabled = !isOn;
  $("btnSwitch").disabled = !isOn || servers.length < 2;
}

// ── СПИСОК СЕРВЕРОВ ───────────────────────────────────────────────────────────
function pingDisplay(ms) {
  if (ms === -1 || ms === undefined) return "—";
  if (ms === -2) return "❌";
  const color = ms < 80 ? "🟢" : ms < 150 ? "🟡" : "🔴";
  return `${color} ${ms}`;
}
// ── Флаги стран: inline-SVG (без внешних файлов — надёжно в dev и release).
//   "NL Netherlands" → [флаг] Netherlands. Нет в наборе → буквенный бейдж.
const FLAG_SVG = {
  eu: `<svg xmlns:xlink="http://www.w3.org/1999/xlink" id="flag-icons-eu" viewBox="0 0 640 480"><defs><g id="eu-d"><g id="eu-b"><path id="eu-a" d="m0-1-.3 1 .5.1z"/><use xlink:href="#eu-a" transform="scale(-1 1)"/></g><g id="eu-c"><use xlink:href="#eu-b" transform="rotate(72)"/><use xlink:href="#eu-b" transform="rotate(144)"/></g><use xlink:href="#eu-c" transform="scale(-1 1)"/></g></defs><path fill="#039" d="M0 0h640v480H0z"/><g fill="#fc0" transform="translate(320 242.3)scale(23.7037)"><use xlink:href="#eu-d" width="100%" height="100%" y="-6"/><use xlink:href="#eu-d" width="100%" height="100%" y="6"/><g id="eu-e"><use xlink:href="#eu-d" width="100%" height="100%" x="-6"/><use xlink:href="#eu-d" width="100%" height="100%" transform="rotate(-144 -2.3 -2.1)"/><use xlink:href="#eu-d" width="100%" height="100%" transform="rotate(144 -2.1 -2.3)"/><use xlink:href="#eu-d" width="100%" height="100%" transform="rotate(72 -4.7 -2)"/><use xlink:href="#eu-d" width="100%" height="100%" transform="rotate(72 -5 .5)"/></g><use xlink:href="#eu-e" width="100%" height="100%" transform="scale(-1 1)"/></g></svg>`,
  nl: `<svg id="flag-icons-nl" viewBox="0 0 640 480"><path fill="#ae1c28" d="M0 0h640v160H0z"/><path fill="#fff" d="M0 160h640v160H0z"/><path fill="#21468b" d="M0 320h640v160H0z"/></svg>`,
  de: `<svg id="flag-icons-de" viewBox="0 0 640 480"><path fill="#fc0" d="M0 320h640v160H0z"/><path fill="#000001" d="M0 0h640v160H0z"/><path fill="red" d="M0 160h640v160H0z"/></svg>`,
  se: `<svg id="flag-icons-se" viewBox="0 0 640 480"><path fill="#005293" d="M0 0h640v480H0z"/><path fill="#fecb00" d="M176 0v192H0v96h176v192h96V288h368v-96H272V0z"/></svg>`,
  lv: `<svg id="flag-icons-lv" viewBox="0 0 640 480"><g fill-rule="evenodd"><path fill="#981e32" d="M0 0h640v192H0z"/><path fill="#fff" d="M0 192h640v96H0z"/><path fill="#981e32" d="M0 288h640v192H0z"/></g></svg>`,
  lt: `<svg id="flag-icons-lt" viewBox="0 0 640 480"><g fill-rule="evenodd" stroke-width="1pt" transform="scale(.64143 .96773)"><rect width="1063" height="708.7" fill="#006a44" rx="0" ry="0" transform="scale(.93865 .69686)"/><rect width="1063" height="236.2" y="475.6" fill="#c1272d" rx="0" ry="0" transform="scale(.93865 .69686)"/><path fill="#fdb913" d="M0 0h997.8v164.6H0z"/></g></svg>`,
  fr: `<svg id="flag-icons-fr" viewBox="0 0 640 480"><path fill="#000091" d="M0 0h213.3v480H0z"/><path fill="#fff" d="M213.3 0h213.4v480H213.3z"/><path fill="#e1000f" d="M426.7 0H640v480H426.7z"/></svg>`,
  ru: `<svg id="flag-icons-ru" viewBox="0 0 640 480"><path fill="#fff" d="M0 0h640v160H0z"/><path fill="#0039a6" d="M0 160h640v160H0z"/><path fill="#d52b1e" d="M0 320h640v160H0z"/></svg>`,
  us: `<svg id="flag-icons-us" viewBox="0 0 640 480"><path fill="#bd3d44" d="M0 0h640v480H0"/><path stroke="#fff" stroke-width="37" d="M0 55.3h640M0 129h640M0 203h640M0 277h640M0 351h640M0 425h640"/><path fill="#192f5d" d="M0 0h364.8v258.5H0"/><marker id="us-a" markerHeight="30" markerWidth="30"><path fill="#fff" d="m14 0 9 27L0 10h28L5 27z"/></marker><path fill="none" marker-mid="url(#us-a)" d="m0 0 16 11h61 61 61 61 60L47 37h61 61 60 61L16 63h61 61 61 61 60L47 89h61 61 60 61L16 115h61 61 61 61 60L47 141h61 61 60 61L16 166h61 61 61 61 60L47 192h61 61 60 61L16 218h61 61 61 61 60z"/></svg>`,
  kz: `<svg xmlns:xlink="http://www.w3.org/1999/xlink" id="flag-icons-kz" viewBox="0 0 640 480"><path fill="#00abc2" d="M0 0h640v480H0z"/><g fill="#ffec2d"><g transform="matrix(.48 0 0 .48 345.8 201.6)"><circle r="134.6"/><g id="kz-c"><g id="kz-b"><path id="kz-a" d="M0-152.9c8-.1 11-5.1 11-11.1 0-8-11-46.1-11-46.1S-11-172-11-164c0 6 3 11.1 11 11.1"/><use xlink:href="#kz-a" width="100%" height="100%" transform="rotate(90)"/><use xlink:href="#kz-a" width="100%" height="100%" transform="scale(-1)"/><use xlink:href="#kz-a" width="100%" height="100%" transform="rotate(-90)"/></g><use xlink:href="#kz-b" width="100%" height="100%" transform="rotate(22.5)"/><use xlink:href="#kz-b" width="100%" height="100%" transform="rotate(45)"/><use xlink:href="#kz-b" width="100%" height="100%" transform="rotate(67.5)"/></g><use xlink:href="#kz-c" width="100%" height="100%" transform="rotate(11.3)"/></g><g transform="translate(-172.8)scale(.48)"><path d="M1075.8 655c-3.5 6.3-5.6 13.6-10 19.3-13.6-12.3-33.2-12-50.4-12.7-14.2-.8-29.6-2.1-40.6-12.2-11.5-9.5-21-21.7-33.8-29.4a83 83 0 0 1-33.1-15.3c-20.2-16.5-31.8-41-51.6-58-3.7-3.6-8.2-6.5-12.4-9.6-4 1-2.2 9.6-7.1 5.2-2.7-2-9.4-2.1-10 .6 6 8 12.1 17 13 27.2-4.2.4-11.5-.9-13.5.6a84 84 0 0 0 20.4 21.3c-3.8.6-11.3.3-12.8 1.8a59 59 0 0 0 26.8 14.7c2 2.8-3.1 8.2 1.3 10.6 2.5 1 10.9 2.8 5.1 5.7-4 2.6-2.5 8.9 2.6 8.7 3.2 1.7 10.4 2 11 5-2.9 2.8-11.7 6.2-4.2 9a52 52 0 0 0 23.1 6.7c-4 3.4-9 5.3-13.1 8.5 18.5 10.9 39 18 59.4 25 8 2.6 16.3 5.1 24.7 6.7-24.4-1.4-48-8.6-70.2-18.5q-17.2-7.6-34.8-14.2c5.1-2.7 11.1-3.4 16.5-5.7-11.2-2.2-23.3-3-33-9 1.4-2.8 7-2.9 10.2-4.3 6-1.4 9.6-3 1.3-3.6-8.4-2.3-18-1.3-25.5-6.3.5-3 8.3-2 11.4-3.3 4-.7 8.4-1.3 11.6-4-13-5.3-30-1.5-40.2-13-2.3-4.4 7.3-.9 10-1.6 7 0 14.5 2.2 21.2-.6-19-8.3-39.3-16-53.7-31.4-1.6-2.5-6.4-9.3-2.5-10.1 11.2 1.5 19.3 13.7 31.4 11.8 1.6-2.1-7-5.6-9.2-8.7a229 229 0 0 1-46.8-51c-.8-6.7 9.5-7.7 12.2-2.6 13.4 13 25.5 28 42.2 36.8 6 2.9-3.4-3.4-4.6-5.7a299 299 0 0 1-40.9-57.9c-2-3.8-5.1-10.7.7-12.7 5.7-2.9 11.5 1 14.4 6 11.3 14.3 19.7 31.3 33.8 43.2-12-23.3-24.9-48-25.2-74.8.3-5.2.6-13 7.7-12.9 6-.9 5 6.7 7 10.3 5.8 19.8 8.3 41.2 20 58.6-2.5-14.6-6.4-29.7-3.8-44.6.6-5 6-6.4 9.7-3.4 2.9 7 3.5 15.9 6.1 23.5a237 237 0 0 0 93 127.2 245 245 0 0 0 123.3 42.3q6 .5 11.9.7m136.4 91.1c-7.2 4.4-12.8-3.4-18.8-5.7-4.4 2.4-4.8 10.2-8.8 14-4.8 5.5-10.8-1.6-10.3-7-5.8 4.9-8.7 16-18 14.4-4.5-3.6-7.8-11.2-11.2-2.5-2.7 4.2-10 10.2-13.9 3.8-1.2-5.6-4-12.2-7-3.3-2.2 6.4-9 11-15.4 8.2-3.6-2.9 2.8-13.7-1.7-13-6.8 4.6-10.8 15.7-20.3 14.8-3.7-4 2.3-11.1-1.8-15.7-4.7 6.1-10 15.1-18.3 15.7-4-3.2.2-12.5-2.4-13.8-8.4 5-17.4 14.1-28 11.3 4.1-16 21.5-21.5 36-22.7 25.1-3.1 51.5 2.6 75.7-6.5 3.9-2.4 13.3-5.7 10-11.2-3-4.4 7.7-2.7 8.7-7.8-.6-6.4 5-5.5 10.4-6 24.4-1.1 48.5 4 72.8 4.9 1.8 11.8-11.3 20.1-22 16.5-5 .8-12.5-11.6-11-2.6-1 4.8-.4 11-4.7 14.2m-207.4-24.2c5.6 5.1 9.6-1 14.9-3.3a197 197 0 0 0 48.3-27.3c9.2-7.6 17.2-17.5 29.6-20 24.2-7.3 49.9-6.4 74.1-13.2 18.5-25.2 49.8-34.3 76.1-48.8 5.9-1.8 8.2-6.7 10-12 10-15.9 23.7-29.9 39.9-39.5a37 37 0 0 1 25.4-4.6 42 42 0 0 1-13.7 26.5c5.9-.1 11-3.8 16.8-3.6 2 10.6-9.4 16.1-15.5 22.7 3.4.8 16.4 1.8 9.3 5.2-9 6.2-19.3 10.5-27.6 17.8 7.7 1.4 8.6 3 .8 5.8-4.3 2.8-12.4 3.8-13.2 9.4 5.8 3.6-2.6 7-5.9 8.2-6.2 1.5-12.8 4.2-4.5 9-3.1 4.7-9.9 5.7-15.4 5.2 1.7 5.4 4.1 11.4-2.8 13.8a108 108 0 0 1-53.6 22.4c24.5 1.8 49.8-2.7 70.7-16 2.8-3.3 17.3-6.9 9.2-9.6-3.8-1.6-12-3.4-12.6-6.3 11.4-7 25.7-4.5 37.9-8.6.3-4-9.3-2.9-12.9-3.8-8.5-.7-8-2.9.2-3.7 10.4-2.8 22.2-3.3 31-10-7.1-3.4-16.1-.5-23.7-3.2 12.9-5.6 28.1-6.2 39.7-14.7 5.3-5.9-6.8-4-10.3-3.9-7.1 1.3-10.4-2.2-2.3-5.1 13.9-10.3 31.4-16.9 41.2-31.7 2.3-3.3 5.4-13.3-2-9.8-9.6 3.3-18.1 14.1-29.2 10.8 21.8-16.9 42.4-36 57.3-59.3.8-6.8-9.8-7.5-12.5-2.2-14 13.4-26.6 29.3-44.5 37.8a281 281 0 0 0 43.6-56.4c2.7-6 9.8-13.3 6-20-6.3-5.2-14.1-.4-17.3 5.7-10.9 14.2-19.1 30.7-33 42.3 12.1-23.3 24.8-48.2 25-75 0-5.6-1-13.8-8.6-12.7-6 1-4.5 10-7 14.5-5.4 18.4-8 38.3-19 54.3 2.5-14.9 6.8-30.5 3.5-45.5-1.6-6.8-12.5-3.9-11 2.8-13 65.9-57.3 123.5-115 156.8-26.5 15-56 24.6-86.2 29-8 1.7-16.8.7-24.5 3.5-18.8 14.3-30.1 38.4-53.8 45.9-10.7 5.3-24.5 6.4-32.1 16.2a9 9 0 0 0-.8 4.2m51.7-10.3q-5.4.2-10.6 1.7c-4.7.7-9.2 2.3-13.8 3l-1.9.4-3.1.3a11 11 0 0 1 0 5.1 6 6 0 0 1-1.4 2q-.9 1.2-2.2 1.8a7 7 0 0 1-2.6.7q-1.3.1-2.7-.4-1.3-.4-2.5-1.5l-2.8.5h-2.6l-2.8-1-2.6-1.3c-3.4 2-7.2 3.9-9.3 7.4a11 11 0 0 0-1.6 5.3q-.2 3.6 1.4 7c.4.6.7-2.3 1.8-2.7q3-2.4 6.7-3.3c2-1 1.7 0 .9 1.6-.2.9-1.3 4 .2 2.4a65 65 0 0 1 21.6-4.1q15.9-1.5 31.8-1.5l30 .6c4.8.2 9.6 1.2 14.3.4 1.1-.3 2.9-.3 3.6-1-2.2-1.2-4.7-1.3-7-1.6h-19.1c-5.3-.5-10.8-.6-15.8-2.6-1.4-.5-2.6-1.8-3.9-.4a24 24 0 0 1-5.9 1.3q-5.3.2-10.2-1.8 3.6-4.7 7.7-9l-6.2-1.3z"/><circle cx="1020" cy="720.9" r="2.4"/><circle cx="1019.8" cy="720.5" r="1" stroke="#ffec2d" stroke-width=".4"/></g><g transform="scale(.48)"><g id="kz-f"><g id="kz-e"><path d="M120 73s-9.6-8.2-12.9-4.1c-5.2 6.5 16.2 39 16.2 50.4 0 18.8-12.6 23.9-28 26.5-10.4 1.8-27.3-.7-27.3-.7 3.2-4.3 5.3-5.6 10.6-5.9-6-3-12-9.8-12-20.3 0-16.1 6.6-22.8 6.6-41C73.2 68 65 55 65 55c14.6 1.5 21.8 15 17.7 25.8a7 7 0 0 0 6.3-1.9c1 3-.6 6.5-2.9 9.5 1.8 1 3.2.4 6-.2-.2 3-2 6.4-6.6 9.5 13.2-3.4 21.2 5.7 21.2 15.3 0 7.3-5 12.5-10 12.5-1.6 0-4-.7-5.3-1.7-1 2-.4 4.7.5 6.7-3.6-1-6-3.2-4.3-7.7q-4.2-.3-6.5-3 2.3-3 6.5-3c-2-4.2.3-6.5 3.6-8.4 0 0-2.1 8.4 3.2 8.4 2.4 0 4.6-.7 4.6-4.3 0-3.1-2.7-7.4-9-7.1s-11.3 4.3-11.3 14.3c0 9.2 7.5 13.8 17.3 14 8.8.4 15.5-4.4 15.5-13.5C111.5 108 94 80.4 94 69.6c0-8.1 7.2-12.7 14.4-12.7 9.2 0 17 9.2 17 9.2l-5.4 6.8z"/><path id="kz-d" d="M122 292.1c0 20.3-18.2 30.7-32.5 30.7-19.2 0-29.5-11.5-29.5-26.6 0-8.5 1.6-13.9 5.5-22l44.2-91.7a27 27 0 0 0 2-12.2c0-8.2-8-14.9-16.3-15-7.6-.3-16 7-16 15.3 0 10.1 5.3 14.6 10.7 14.6 6.6 0 9.2-2.7 9.2-7.4q-.2-4.7-3.8-4.6c-5.7 0-4 7.6-4 7.6a5.2 5.2 0 0 1-3.9-7 10 10 0 0 1-5.5-3.3q2.2-2.3 5.5-3c-1.3-4.4.5-6.5 4.3-7.5a8 8 0 0 0-.5 4.8c6-1.8 15.3 1 15.3 11.4s-7.2 19.1-20.7 17c3.2 1.5 4.8 4.6 5.2 8.1-2.5-1-5.2-1-5.2-1 1.6 2.7 3.8 5 3.7 10.6-2.5-1.2-4.9-3.3-8-2 5 10-1.2 23.6-17 26.8q8.6-10.3 8.6-21.3c0-23.5-6.5-27.4-6.5-43.8a24 24 0 0 1 10.5-19.2v.3A14 14 0 0 1 68 145a62 62 0 0 1 34 .3 25 25 0 0 1 18 12 36 36 0 0 1 0 28.9c-6.3 13-35.7 75.6-44.9 95.2q-3 6.3-3.1 13.4c0 12 11 16.2 17.2 16.2 7.5 0 15.2-5.7 15.2-12.8 0-4.5-2.5-7.3-6-7.3-8.5 0-8 7.2-6.3 11.8-5.3-2.4-8.3-6.6-7.5-11a14 14 0 0 1-8.4-4.8c2-2.6 4.6-4.6 8.4-4.7-1.7-6.9 3-9.8 7.5-11.4-1.4 5-2.4 10.9 6.3 10.9 6.3 0 11.2 1 14.1 5.2l.7-27c.4-8.1-10.8-8-18-5.5 2.7-9.3 8.2-14.4 21-13.1a10 10 0 0 1-6.4-9.8c0-7.6 6.2-16 10.2-18.5l2 79z"/><use xlink:href="#kz-d" width="100%" height="100%" transform="matrix(1 0 0 -1 0 645)"/></g><use xlink:href="#kz-e" width="100%" height="100%" transform="matrix(-1 0 0 1 240 0)"/></g><use xlink:href="#kz-f" width="100%" height="100%" transform="matrix(1 0 0 -1 0 1000)"/></g></g></svg>`,
  tr: `<svg id="flag-icons-tr" viewBox="0 0 640 480"><g fill-rule="evenodd"><path fill="#e30a17" d="M0 0h640v480H0z"/><path fill="#fff" d="M407 247.5c0 66.2-54.6 119.9-122 119.9s-122-53.7-122-120 54.6-119.8 122-119.8 122 53.7 122 119.9"/><path fill="#e30a17" d="M413 247.5c0 53-43.6 95.9-97.5 95.9s-97.6-43-97.6-96 43.7-95.8 97.6-95.8 97.6 42.9 97.6 95.9z"/><path fill="#fff" d="m430.7 191.5-1 44.3-41.3 11.2 40.8 14.5-1 40.7 26.5-31.8 40.2 14-23.2-34.1 28.3-33.9-43.5 12-25.8-37z"/></g></svg>`,
  ae: `<svg id="flag-icons-ae" viewBox="0 0 640 480"><path fill="#00732f" d="M0 0h640v160H0z"/><path fill="#fff" d="M0 160h640v160H0z"/><path fill="#000001" d="M0 320h640v160H0z"/><path fill="red" d="M0 0h220v480H0z"/></svg>`,
  gb: `<svg id="flag-icons-gb" viewBox="0 0 640 480"><path fill="#012169" d="M0 0h640v480H0z"/><path fill="#FFF" d="m75 0 244 181L562 0h78v62L400 241l240 178v61h-80L320 301 81 480H0v-60l239-178L0 64V0z"/><path fill="#C8102E" d="m424 281 216 159v40L369 281zm-184 20 6 35L54 480H0zM640 0v3L391 191l2-44L590 0zM0 0l239 176h-60L0 42z"/><path fill="#FFF" d="M241 0v480h160V0zM0 160v160h640V160z"/><path fill="#C8102E" d="M0 193v96h640v-96zM273 0v480h96V0z"/></svg>`,
  fi: `<svg id="flag-icons-fi" viewBox="0 0 640 480"><path fill="#fff" d="M0 0h640v480H0z"/><path fill="#002f6c" d="M0 174.5h640v131H0z"/><path fill="#002f6c" d="M175.5 0h130.9v480h-131z"/></svg>`,
  pl: `<svg id="flag-icons-pl" viewBox="0 0 640 480"><g fill-rule="evenodd"><path fill="#fff" d="M0 0h640v240H0z"/><path fill="#dc143c" d="M0 240h640v240H0z"/></g></svg>`,
  ua: `<svg id="flag-icons-ua" viewBox="0 0 640 480"><g fill-rule="evenodd" stroke-width="1pt"><path fill="#0057b8" d="M0 0h640v240H0z"/><path fill="gold" d="M0 240h640v240H0z"/></g></svg>`,
  by: `<svg xmlns:xlink="http://www.w3.org/1999/xlink" xml:space="preserve" id="flag-icons-by" viewBox="0 0 640 480"><defs><clipPath id="by-a"><path d="M0 0h200v608h8v284l-8 8H0z"/></clipPath></defs><path fill="#ce1720" d="M0 0h640v480H0Z"/><g fill="#fff" clip-path="url(#by-a)" transform="matrix(.52885 0 0 .53333 5 0)"><g id="by-c"><path id="by-b" d="M36 0v14h-9v14H16v16H8v13H-8V24H8V6H-8V0Zm26 77v15h-8v12h-8V92h-8V77h-8V57h8V42h8V30h8v12h8v15h8v20Zm-17-1h10V58H45ZM19 183h8v-18h-8zm54 0h8v-18h-8ZM-8 305H6v13h6v16h9v15h12v-15h9v-16h8v-13H38v-15h21v10h13v17h11v19h-8v14h-7v13h-6v14h-9v12h-7v11h-9v14H24v-15h-9v-14H8v-9H-8v-23H8v-20H-8Z"/><use xlink:href="#by-b" transform="matrix(-1 0 0 1 200 0)"/><path d="M96 0v32h8V0h32v14h-8v14h-12v16h-8v13H92V44h-8V28H72V14h-8V0Zm-2 274v-11h-6v-13h-7v-14h-8v-14h-8v-10h-9v-14H44v14h-9v10h-7v14h-8v14h-6v13H8v17H-8v-44H8v-20H-8v-33H8v14h10v14h10v-14h10v-14h8v-18h-8v-14H28v-14H18v14H8v14H-8v-41H8v-19H-8V77H8v13h8v16h11v13h9v15h7v12h14v-12h7v-15h9v-13h11V90h8V77h16v13h8v16h11v13h9v15h7v12h14v-12h7v-15h9v-13h11V90h8V77h16v28h-16v19h16v41h-16v-14h-10v-14h-10v14h-10v14h-8v18h8v14h10v14h10v-14h10v-14h16v33h-16v20h16v44h-16v-17h-6v-13h-6v-14h-8v-14h-7v-10h-9v-14h-12v14h-9v10h-8v14h-8v14h-7v13h-6v11zm2-167v27h8v-27zm-4 58v-14H82v-14H72v14H62v14h-8v18h8v14h10v14h10v-14h10v-14h16v14h10v14h10v-14h10v-14h8v-18h-8v-14h-10v-14h-10v14h-10v14zm4 46v27h8v-27z"/></g><use xlink:href="#by-c" transform="matrix(1 0 0 -1 0 900)"/><path d="M-8 408H8v14h7v8h8v14h7v12h-7v14h-8v8H8v14H-8Zm216 0v84h-16v-14h-7v-8h-8v-14h-7v-12h7v-14h8v-8h7v-14ZM62 459h8v-18h-8zm76 0v-18h-8v18zm-42-59h8v-18h-8zm0 100v18h8v-18Zm-50-75h14v-11h10v-10h5v-10h6v-14h8v-14h4v-13h14v13h4v14h8v14h6v10h5v10h10v11h14v50h-14v11h-10v10h-5v10h-6v14h-8v14h-4v13H93v-13h-4v-14h-8v-14h-6v-10h-5v-10H60v-11H46Zm50 9v-15h-8v-10h-8v25h8v9h5v14h-5v9h-8v25h8v-10h8v-15h8v15h8v10h8v-25h-8v-9h-5v-14h5v-9h8v-25h-8v10h-8v15z"/></g><path fill="#007c30" d="M110 320h530v160H110Z"/></svg>`,
  md: `<svg id="flag-icons-md" viewBox="0 0 640 480"><g fill-rule="evenodd" stroke-width="1pt"><path fill="#00319c" d="M0 0h213.3v480H0z"/><path fill="#ffde00" d="M213.3 0h213.4v480H213.3z"/><path fill="#de2110" d="M426.7 0H640v480H426.7z"/></g><path fill="#ff1900" fill-rule="evenodd" stroke="#000" stroke-width=".7" d="m360.4 320.4 24.2 35c1.4 2 2.7 3.9.7 5.2s-1.4 6.4 0 8.4c2.7 3.9 6 4.5 8 3.2l18.4-11.6c2-1.2 2.7-4.5 0-8.4-1.5-2-6-4.5-8-3.2-2.1 1.3-3.5-.7-4.8-2.6l-24.3-35"/><path fill="#a77b3b" fill-rule="evenodd" stroke="#000" stroke-width="2.5" d="M177.2 696.3c0 24.4-9.6 44.3-21.3 44.3s-21.3-19.9-21.3-44.3S144.3 652 156 652s21.3 19.8 21.3 44.3z" transform="matrix(.52728 -.42386 .44358 .50386 -32.4 20)"/><path fill="#ff1900" fill-rule="evenodd" stroke="#000" stroke-width=".7" d="m262 306.1-21.5 36.7c-1.2 2-2.4 4-4.5 3-2.1-1.2-6.6 1.7-7.8 3.8-2.4 4-1.5 7.2.7 8.4l19.2 10.2c2 1.1 5.4.2 7.8-3.8 1.1-2.2 1.4-7.3-.7-8.4s-1-3.2.3-5.2l21.4-36.7"/><path fill="#a77b3b" fill-rule="evenodd" stroke="#000" stroke-width="1.7" d="M331.2 280.6h-19.6c-.6.6-6.2 35.6-12.2 49-7.3 16.3-29.2 30.7-29.2 30.7s13.1 4 17 6.6c1-.3 22-4.7 24.4-30.3 2.4 25.6-14.6 37.3-14.6 37.3s24.4 7 24.4 23.3c0-16.3 24.4-23.3 24.4-23.3s-12.2-11.7-14.7-37.3c5 25.6 23.5 30 24.5 30.3 3.9-2.6 17-6.6 17-6.6s-21.9-14.4-29.2-30.7c-6-13.4-11.6-48.4-12.2-49zm-83-116.7 36.6 11.7c12.1 0 24.4-11.7 24.4-23.4.4-26-9.8-35-12.2-35l4.8-4.6-7.3-7s2.5-12.1 26.9-11.7 24.4 11.7 24.4 23.3-12.2 11.7-12.2 35c0 11.7 12.2 23.4 24.4 23.4l36.6-11.7v116.7H248.1z"/><g fill="none" stroke="#000"><path stroke-width=".5" d="m302.2 292.2 14.6 15 14.7-15 14.6 15 29.3-15 14.3 15.8 15-15.8 21.6 15.8 22.3-15.8 14.6 15 14.7-15" transform="matrix(.16672 0 0 .46773 253.9 31.9)"/><path stroke-width=".2" d="m432.3 435.8-7.1 39m10.6-39v39m7.1-39v39m7.1-39 3.5 39m3.6-39 3.5 39" transform="matrix(.68905 0 0 .65843 16.2 -144)"/></g><g stroke="#000" stroke-width="2.5"><path fill="#a77b3b" fill-rule="evenodd" d="M318.9 361.4c35.4 17.7 35.4 53.2 35.4 70.9-1.2 16.1 0 354.3 0 354.3s-2.3-20-17.7-35.4L319 733.5l-17.7-17.7c-13-11.8-17.7-35.5-17.7-53.2v-248s0-17.8 35.4-53.2z" transform="matrix(-.68905 0 0 .65843 443.4 -144)"/><path fill="none" d="M283.5 574c.4 0 17.7-17.7 17.7-17.7l17.7 17.7 17.7-17.7 17.7 17.7" transform="matrix(-.68905 0 0 .65843 443.4 -237.3)"/><path fill="none" d="M283.5 574c.4 0 17.7-17.7 17.7-17.7l17.7 17.7 17.7-17.7 17.7 17.7" transform="matrix(-.68905 0 0 -.65843 443.4 530.2)"/><path fill="none" d="M283.5 574c.4 0 17.7-17.7 17.7-17.7l17.7 17.7 17.7-17.7 17.7 17.7" transform="matrix(-.68905 0 0 .65843 443.4 -190.7)"/><path fill="none" d="m301.4 557-.2 158.8" transform="matrix(-.68905 0 0 1.24911 443.4 -566.8)"/><path fill="none" d="m301.4 539.3-.2 176.5" transform="matrix(-.68905 0 0 1.12111 431.4 -464)"/><path fill="none" d="m301.4 539.3-.2 176.5" transform="matrix(-.68905 0 0 1.2559 419.2 -548.3)"/></g><g stroke="#000" stroke-width="2.5"><path fill="#a77b3b" fill-rule="evenodd" d="M318.9 361.4c35.4 17.7 35.4 53.2 35.4 70.9-1.2 16.1 0 354.3 0 354.3s-2.3-20-17.7-35.4L319 733.5l-17.7-17.7c-13-11.8-17.7-35.5-17.7-53.2v-248s0-17.8 35.4-53.2z" transform="matrix(.68905 0 0 .65843 199.3 -144)"/><path fill="none" d="M283.5 574c.4 0 17.7-17.7 17.7-17.7l17.7 17.7 17.7-17.7 17.7 17.7" transform="matrix(.68905 0 0 .65843 199.3 -237.3)"/><path fill="none" d="M283.5 574c.4 0 17.7-17.7 17.7-17.7l17.7 17.7 17.7-17.7 17.7 17.7" transform="matrix(.68905 0 0 -.65843 199.3 530.2)"/><path fill="none" d="M283.5 574c.4 0 17.7-17.7 17.7-17.7l17.7 17.7 17.7-17.7 17.7 17.7" transform="matrix(.68905 0 0 .65843 199.3 -190.7)"/><path fill="none" d="m301.4 557-.2 158.8" transform="matrix(.68905 0 0 1.24911 199.3 -566.8)"/><path fill="none" d="m301.4 539.3-.2 176.5" transform="matrix(.68905 0 0 1.12111 211.4 -464)"/><path fill="none" d="m301.4 539.3-.2 176.5" transform="matrix(.68905 0 0 1.2559 223.6 -548.3)"/></g><path fill="#a77b3b" fill-rule="evenodd" stroke="#000" stroke-width="2.5" d="M177.2 696.3c0 24.4-9.6 44.3-21.3 44.3s-21.3-19.9-21.3-44.3S144.3 652 156 652s21.3 19.8 21.3 44.3z" transform="matrix(.63605 .25323 -.26502 .60778 361.1 -165.2)"/><path fill="red" fill-rule="evenodd" d="M248.1 175.6h146.5v70H248.1z"/><path fill="#564dff" fill-rule="evenodd" d="M248.1 245.6h146.5v35c0 23.3-36.6 23.3-73.2 46.6C284.7 304 248 304 248 280.6z"/><path fill="none" stroke="#ff0" stroke-width="2" d="M336.6 485.4h212.6V645c0 35.4-53.1 35.4-106.3 70.9-53.1-35.5-106.3-35.5-106.3-71V485.5z" transform="matrix(.68905 0 0 .65843 16.2 -144)"/><path fill="#ff0" fill-rule="evenodd" stroke="#000" stroke-width="2.5" d="M385.6 129.9S335 185.4 335 238.5s53.1 70.9 53.1 70.9-17.7 0-17.7 70.8c0 35.5 53.1 17.8 53.1 35.5s-.7 60.5 0 88.6c0 17.7-35.4 0-35.4 17.7 0 8.8 26.6 53.1 53.2 53.1s53.1-44.3 53.1-53.1c0-17.7-35.4 0-35.4-17.7v-88.6c0-17.7 53.1 0 53.1-35.5 0-70.8-17.7-70.8-17.7-70.8s53.2-17.7 53.2-70.9-50.7-108.6-50.7-108.6 28.5 73.2 28.5 108.6c0 17.7-13.3 53.2-48.7 53.2 0 0-9-17.8-17.7 0 0 0-10.2-17.8-17.7 0-2.6 6-7.2-17.8-17.8 0-4.4 4.7-8-17.8-17.7 0-17.7 0-53.1-17.8-53.1-53.2s32.9-108.6 32.9-108.6z" transform="matrix(.48234 0 0 .30917 108.5 140.1)"/><path fill="#ff0" fill-rule="evenodd" stroke="#000" stroke-width="2.5" d="M382.7 248c-3.6 3.6 4.6 61.3 7 63.8 3.6 3.5 24.9 3.5 28.4 0 2.5-2.5 0-56.7-3.5-60.2-3.6-3.6-29.4-6-32-3.6z" transform="matrix(.48234 0 0 .30917 110.4 201.6)"/><path fill="#ff0" fill-rule="evenodd" stroke="#000" stroke-width="2.5" d="M382.7 248c-3.6 3.6 4.6 61.3 7 63.8 3.6 3.5 24.9 3.5 28.4 0 2.5-2.5 0-56.7-3.5-60.2-3.6-3.6-29.4-6-32-3.6z" transform="matrix(-.48234 0 0 .30917 532.4 201.6)"/><path fill="#ff0" fill-rule="evenodd" stroke="#000" stroke-width="2.5" d="M414.6 228.5a16 16 0 1 1-32 0 16 16 0 0 1 32 0z" transform="matrix(.5544 0 0 .38542 82.7 183.7)"/><path fill="#ff0" fill-rule="evenodd" stroke="#000" stroke-width="2.5" d="M414.6 228.5a16 16 0 1 1-32 0 16 16 0 0 1 32 0z" transform="matrix(.55441 0 0 .38543 118 183.7)"/><path fill-rule="evenodd" d="M336.8 307.5c0 1.5-2 2.7-4.3 2.7-2.4 0-4.3-1.2-4.3-2.7s2-2.7 4.3-2.7 4.3 1.2 4.3 2.7m-22.3 0c0 1.5-1.9 2.7-4.2 2.7s-4.3-1.2-4.3-2.7 1.9-2.7 4.3-2.7c2.3 0 4.2 1.2 4.2 2.7"/><path fill="#ff0" fill-rule="evenodd" stroke="#000" stroke-width="1.1" d="m439.4 550-7.8-10.3-12.8 1.7 1.8-12.8-10.3-7.7 10.3-7.8-1.8-12.8 12.8 1.8 7.8-10.3 7.8 10.3 12.7-1.8-1.7 12.8 10.2 7.8-10.2 7.8 1.7 12.7-12.8-1.7z" transform="matrix(.67225 0 0 .64237 26 -133.3)"/><path fill="#ff0" fill-rule="evenodd" stroke="#000" stroke-width="1.1" d="m496 591.7 21.3 10.7 21.3-10.7-21.3-10.6z" transform="matrix(.68905 0 0 .65843 16.2 -144)"/><path fill="#ff0" fill-rule="evenodd" stroke="#000" stroke-width="1.1" d="m496 591.7 21.3 10.7 21.3-10.7-21.3-10.6z" transform="matrix(.68905 0 0 .65843 -88.8 -144)"/><path fill="#ff0" fill-rule="evenodd" stroke="#000" stroke-width="1.1" d="M535 659c-3.5-7-14.1-10.6-21.2-10.6s-14.2 0-21.3 10.7c0-14.2 10.5-21.3 21.3-21.3a23 23 0 0 1 21.2 21.3z" transform="matrix(.59753 -.3279 .34316 .57097 -165.2 86.5)"/><path fill="#ff0" fill-rule="evenodd" stroke="#000" stroke-width="1.1" d="M386.2 652a7 7 0 1 1-14.1 0 7 7 0 0 1 14.1 0z" transform="matrix(.68905 0 0 .65843 13.7 -155.7)"/><path fill="#ff0" fill-rule="evenodd" stroke="#000" stroke-width="1.1" d="M386.2 652a7 7 0 1 1-14.1 0 7 7 0 0 1 14.1 0z" transform="matrix(.68905 0 0 .65843 8.8 -139.4)"/><path fill="#ff0" fill-rule="evenodd" stroke="#000" stroke-width="1.1" d="M386.2 652a7 7 0 1 1-14.1 0 7 7 0 0 1 14.1 0z" transform="matrix(.68905 0 0 .65843 6.4 -148.7)"/><path fill="#ff0" fill-rule="evenodd" stroke="#000" stroke-width="1.1" d="M386.2 652a7 7 0 1 1-14.1 0 7 7 0 0 1 14.1 0z" transform="matrix(.68905 0 0 .65843 18.6 -139.4)"/><path fill="#ff0" fill-rule="evenodd" stroke="#000" stroke-width="1.1" d="M386.2 652a7 7 0 1 1-14.1 0 7 7 0 0 1 14.1 0z" transform="matrix(.68905 0 0 .65843 21 -148.7)"/><path fill="#ff0" fill-rule="evenodd" stroke="#000" stroke-width="1.1" d="M386.2 652a7 7 0 1 1-14.1 0 7 7 0 0 1 14.1 0z" transform="matrix(.68905 0 0 .65843 13.7 -146.4)"/><g fill-rule="evenodd"><path fill="#da4500" d="M297.8 120.4c-12.4 0-14 2-19.6 3.9 0-5.4 13.8-11.7 26-11.7 0 3.9-3.2 7.8-6.4 7.8"/><path fill="#cac9c7" d="M316.5 108c0 2.5-2.2 4.6-4.9 4.6s-4.9-2.1-4.9-4.7 2.2-4.6 4.9-4.6 4.9 2 4.9 4.6z"/><path fill="#ff0" stroke="#000" stroke-width="1.1" d="M361.4 357.9v10.6h17.7v53.1h10.7v-53.1h17.7v-10.6h-17.7v-14.2H379v14.2z" transform="matrix(.68905 0 0 .65843 16.2 -144)"/><path fill="#da4500" d="M304.3 112.6a79 79 0 0 0-29.3 3.9c0-7.2 8.4-15.6 22.8-15.6 3.2 0 6.5 7.8 6.5 11.7"/></g><g fill-rule="evenodd"><path fill="#008500" stroke="#000" stroke-width=".7" d="M67.3 613c-14.2-14.2-16.6-21.4 3.6-10.1l283.7 247.5-3.4 7L67.4 613z" transform="matrix(.38821 .29653 -.14073 .23692 237.4 71.3)"/><path fill="#008f00" d="M228.4 330.4c.8-10.6-18.6-22-19.4-21.3-.7.8 1.2 7 4.9 10.1-7-3.6-14.4-5.8-14.6-4.3-.6 2.2 11 7.2 12 9.2 0 1.4-8.6 1.2-8.4 2.6s24.3 13.6 25.5 3.7M209 299.6c.8-10.6-18.6-22-19.3-21.3-.8.7 1.1 6.9 4.8 10.1-7-3.6-14.4-5.9-14.6-4.3-.5 2.1 11 7.2 12 9.2.1 1.4-8.5 1.2-8.4 2.6.2 1.4 24.3 13.5 25.5 3.7m-14.8-28c.8-10.6-18.6-22-19.4-21.3s1.2 6.9 4.9 10.1c-7-3.6-14.4-5.9-14.6-4.3-.5 2.1 11 7.2 12 9.2 0 1.4-8.5 1.2-8.4 2.6.2 1.4 24.3 13.6 25.5 3.7m-14.6-30.4c.7-10.5-18.6-22-19.4-21.3-.8.8 1.2 7 4.8 10.2-7-3.7-14.4-5.9-14.5-4.3-.6 2.1 11 7.2 11.9 9.1.1 1.4-8.5 1.3-8.3 2.7s24.2 13.5 25.5 3.6"/><path fill="#008f00" d="M184.6 239.9c9.4-5.7 7.5-27.4 6.5-27.6-1.1-.1-5.2 5-5.7 9.8-1.1-7.6-3.6-14.6-5-13.8-2.1.8.4 12.7-.7 14.6-1 1-6-5.8-7-4.8-1.2 1 2.8 26.7 12 21.8zm13.6 26.6c10.8-2.4 16.7-23.4 15.7-23.9s-6.6 3-8.7 7.4c1.6-7.5 1.7-14.9 0-14.6-2.3.1-4 12.1-5.7 13.5-1.3.6-3.7-7.3-5-6.8-1.4.6-6.6 26.1 3.7 24.4m16.2 27.2c9.9-4.8 10-26.6 9-26.8-1-.3-5.5 4.5-6.5 9.2-.4-7.7-2.2-14.8-3.7-14.1-2.2.6-.8 12.6-2 14.4-1.2.9-5.5-6.3-6.7-5.4s.4 26.8 10 22.7zm17.6 35.6c10.3-3.9 12.8-25.5 11.8-25.9s-6 4-7.5 8.6c.4-7.7-.6-15-2.2-14.4-2.3.4-2.1 12.5-3.5 14.2-1.3.7-4.8-6.8-6-6-1.3.6-2.5 26.7 7.4 23.5"/></g><path fill="#ff1900" fill-rule="evenodd" stroke="#000" stroke-width="1.1" d="M209 776c0 7.8-10.2 14.2-23 14.2s-23-6.4-23-14.2 10.3-14.2 23-14.2 23 6.4 23 14.2z" transform="matrix(.60164 .32097 -.3359 .5749 389.6 -146.8)"/><g fill="#ff0" fill-rule="evenodd" stroke="#000" stroke-width=".5"><path d="M156 414.6v-7.1h7v-7.1h7v7h7.2v7.2H170v17.7h-7v-17.7zm7 60.2h7v205.5h-7z" transform="matrix(.49887 .1571 -.1826 .4713 451.4 -3.7)"/><path d="M159.4 676.8h14.2v56.7h-14.2zM156 439.4h21.3c14.1 0-3.6 39-3.6 39h-14.1s-17.8-39-3.6-39zm17.6-5.4c0 3-3.1 5.4-7 5.4s-7.1-2.4-7.1-5.3 3.1-5.4 7-5.4 7.1 2.4 7.1 5.4z" transform="matrix(.49887 .1571 -.1826 .4713 451.4 -3.7)"/></g><path fill="#ff1900" fill-rule="evenodd" stroke="#000" stroke-width="1.1" d="M209 776c0 7.8-10.2 14.2-23 14.2s-23-6.4-23-14.2 10.3-14.2 23-14.2 23 6.4 23 14.2z" transform="matrix(.57449 -.36357 .38048 .54895 -2.3 4.2)"/></svg>`,
  ge: `<svg id="flag-icons-ge" viewBox="0 0 640 480"><path fill="#fff" d="M0 0h640v480H0z"/><path fill="red" d="M272 0h96v480h-96z"/><path fill="red" d="M0 192h640v96H0z"/><path fill="red" fill-rule="evenodd" d="M146.8 373.1c1-16.8 4-31.1 4-31.1s-9.8 1-14.8 1-14.8-1-14.8-1 3 14.3 4 31.2c-16.9-1-31.2-4-31.2-4s1 7.4 1 14.8-1 14.8-1 14.8 14.3-3 31.2-4c-1 16.9-4 31.2-4 31.2s7.4-1 14.8-1 14.8 1 14.8 1-3-14.3-4-31.2c16.9 1 31.2 4 31.2 4s-1-9.8-1-14.8 1-14.8 1-14.8-14.3 3-31.1 4zm368-288c1-16.8 4-31.1 4-31.1s-9.8 1-14.8 1-14.8-1-14.8-1 3 14.3 4 31.1c-16.9-1-31.2-3.9-31.2-3.9s1 7.4 1 14.8-1 14.8-1 14.8 14.3-3 31.2-4c-1 16.9-4 31.2-4 31.2s7.4-1 14.8-1 14.8 1 14.8 1-3-14.3-4-31.1c16.9 1 31.2 4 31.2 4s-1-10-1-14.9 1-14.8 1-14.8-14.3 3-31.2 4zm-368 0c1-16.8 4-31.1 4-31.1s-9.8 1-14.8 1-14.8-1-14.8-1 3 14.3 4 31.2c-16.9-1-31.2-4-31.2-4s1 7.4 1 14.8-1 14.8-1 14.8 14.3-3 31.2-4c-1 16.9-4 31.2-4 31.2s7.4-1 14.8-1 14.8 1 14.8 1-3-14.3-4-31.2c16.9 1 31.2 4 31.2 4s-1-9.8-1-14.8 1-14.8 1-14.8-14.3 3-31.1 4zm368 288c1-16.8 4-31.1 4-31.1s-9.8 1-14.8 1-14.8-1-14.8-1 3 14.3 4 31.2c-16.9-1-31.2-4-31.2-4s1 7.4 1 14.8-1 14.8-1 14.8 14.3-3 31.2-4c-1 16.9-4 31.2-4 31.2s7.4-1 14.8-1 14.8 1 14.8 1-3-14.3-4-31.2c16.9 1 31.2 4 31.2 4s-1-9.8-1-14.8 1-14.8 1-14.8-14.3 3-31.2 4z"/></svg>`,
  am: `<svg id="flag-icons-am" viewBox="0 0 640 480"><path fill="#d90012" d="M0 0h640v160H0z"/><path fill="#0033a0" d="M0 160h640v160H0z"/><path fill="#f2a800" d="M0 320h640v160H0z"/></svg>`,
  az: `<svg id="flag-icons-az" viewBox="0 0 640 480"><path fill="#3f9c35" d="M.1 0h640v480H.1z"/><path fill="#ed2939" d="M.1 0h640v320H.1z"/><path fill="#00b9e4" d="M.1 0h640v160H.1z"/><circle cx="304" cy="240" r="72" fill="#fff"/><circle cx="320" cy="240" r="60" fill="#ed2939"/><path fill="#fff" d="m384 200 7.7 21.5 20.6-9.8-9.8 20.7L424 240l-21.5 7.7 9.8 20.6-20.6-9.8L384 280l-7.7-21.5-20.6 9.8 9.8-20.6L344 240l21.5-7.7-9.8-20.6 20.6 9.8z"/></svg>`,
  kg: `<svg xml:space="preserve" id="flag-icons-kg" viewBox="0 0 640 480"><path fill="red" d="M0 0h640v480H0Z"/><path fill="#ff0" fill-rule="evenodd" d="m340.7 146.6 2.7-52q0-.4-.4-.5-.3 0-.5.4l-13.3 50.1-.1.5a5.9 5.9 0 1 0 11.6 1.5m14.4 4.4 10.8-51q.2-.3-.3-.5-.3 0-.5.3L344 147.2l-.2.5a5.9 5.9 0 1 0 11.3 3.3m13.5 6.6 18.7-48.6a.5.5 0 0 0-.8-.4L358.2 152l-.2.4a5.9 5.9 0 1 0 10.6 5m12.3 8.7 26-45a.5.5 0 0 0-.7-.6l-34.7 38.6-.3.4a5.9 5.9 0 1 0 9.7 6.6m10.8 10.4 32.8-40.4v-.6h-.7l-40.3 32.6-.4.4a5.9 5.9 0 1 0 8.6 8m9 12 38.7-34.8q.3-.3 0-.7h-.6L394 179l-.4.2a5.9 5.9 0 1 0 7.2 9.3m7 13.3 43.7-28.4a.5.5 0 0 0-.4-.8l-48.4 18.6-.5.3a5.9 5.9 0 1 0 5.6 10.3m5 14.2 47.5-21.2a.5.5 0 0 0-.3-.8l-50.7 10.8-.5.1a5.9 5.9 0 1 0 4 11m2.5 14.9 50.4-13.4q.3-.1.3-.5-.1-.4-.5-.4l-51.8 2.7h-.5a5.9 5.9 0 1 0 2.1 11.6m.3 15 51.8-5.4q.4-.1.4-.5 0-.3-.4-.5l-51.6-5.4h-.5a5.9 5.9 0 1 0 .3 11.8m-2.1 14.8 52 2.7a.5.5 0 0 0 .1-.9l-50.1-13.3-.5-.1a5.9 5.9 0 1 0-1.5 11.6m-4.4 14.4 51 10.8q.3.2.5-.3 0-.3-.3-.5l-47.5-21-.5-.2a5.9 5.9 0 1 0-3.3 11.3m-6.6 13.5 48.6 18.7a.5.5 0 0 0 .4-.8L408 278.2l-.4-.2a5.9 5.9 0 1 0-5 10.6m-8.7 12.3 45 26a.5.5 0 0 0 .6-.7l-38.6-34.7-.4-.3a5.9 5.9 0 1 0-6.6 9.7m-10.4 10.8 40.4 32.8a.5.5 0 0 0 .7-.7l-32.7-40.3-.4-.4a5.9 5.9 0 1 0-8 8.6m-12 9 34.8 38.7a.5.5 0 0 0 .8-.6L381 314l-.3-.4a5.9 5.9 0 1 0-9.3 7.2m-13.3 7 28.4 43.7q.2.3.6.2.3-.2.2-.6l-18.6-48.4-.3-.5a5.9 5.9 0 1 0-10.3 5.6m-14.2 5 21.2 47.5q.1.5.5.3.4 0 .3-.6l-10.8-50.7-.1-.5a5.9 5.9 0 1 0-11 4m-14.9 2.5 13.4 50.4q.1.3.5.3.4-.1.4-.5l-2.7-51.8v-.5a5.9 5.9 0 1 0-11.6 2.1m-15 .3 5.4 51.8a.5.5 0 0 0 1 0l5.4-51.6a6 6 0 0 0-5.9-6.4 6 6 0 0 0-5.9 6.2m-14.8-2.1-2.7 52a.5.5 0 0 0 .9.1l13.3-50.1.1-.5a5.9 5.9 0 1 0-11.6-1.5m-14.4-4.4-10.8 51a.5.5 0 0 0 .8.2l21.1-47.4.2-.5a5.9 5.9 0 1 0-11.3-3.3m-13.5-6.6L252.7 371q-.1.4.2.6t.6-.2l28.3-43.5a6 6 0 0 0-2.3-8.3 6 6 0 0 0-8 2.8m-12.4-8.6-26 45a.5.5 0 0 0 .7.6l34.7-38.6.3-.4a5.9 5.9 0 1 0-9.7-6.6m-10.8-10.4-32.8 40.4v.6q.4.3.7 0l40.3-32.6.4-.4a5.9 5.9 0 1 0-8.6-8m-9-12-38.7 34.8a.5.5 0 0 0 .6.8l44.9-26 .4-.3a5.9 5.9 0 1 0-7.2-9.3m-7-13.3-43.7 28.4a.5.5 0 0 0 .4.8l48.4-18.6.5-.3a5.9 5.9 0 1 0-5.6-10.3m-5-14.2-47.5 21.2q-.5.1-.3.5 0 .4.6.3l50.7-10.8.5-.1a5.9 5.9 0 1 0-4-11m-2.5-14.9-50.4 13.4a.5.5 0 0 0 .2 1l51.8-2.8h.5a5.9 5.9 0 1 0-2.1-11.6m-.3-15-51.8 5.4a.5.5 0 0 0 0 1l51.6 5.4h.5a5.9 5.9 0 1 0-.3-11.8m2.1-14.8-52-2.7a.5.5 0 0 0-.1.9l50.1 13.3.5.1a5.9 5.9 0 1 0 1.5-11.6m4.4-14.4-51-10.8q-.3-.2-.5.3 0 .3.3.5l47.4 21.1.5.2a5.9 5.9 0 1 0 3.3-11.3m6.6-13.5L189 172.7a.5.5 0 0 0-.4.8l43.5 28.3.4.2a5.9 5.9 0 1 0 5-10.6m8.7-12.3-45-26h-.7q-.1.3.1.7l38.6 34.7.4.3a5.9 5.9 0 1 0 6.6-9.7m10.4-10.8-40.4-32.8h-.6q-.3.3 0 .7l32.6 40.3.4.4a5.9 5.9 0 1 0 8-8.6m12-9-34.8-38.7a.5.5 0 0 0-.7.6l26 44.9.2.4a5.9 5.9 0 1 0 9.3-7.2m13.3-7-28.4-43.7a.5.5 0 0 0-.8.4l18.6 48.4.3.5a5.9 5.9 0 1 0 10.3-5.6m14.2-5-21.2-47.5a.5.5 0 0 0-.8.3l10.8 50.7.1.5a5.9 5.9 0 1 0 11-4m14.9-2.5-13.4-50.4q-.1-.3-.5-.3-.4.1-.4.5l2.7 51.8v.5a5.9 5.9 0 1 0 11.6-2.1m15-.3-5.4-51.8a.5.5 0 0 0-1 0l-5.4 51.6v.5a5.9 5.9 0 1 0 11.8-.3m-5.9 6.3a89.2 89.2 0 1 1 0 178.4 89.2 89.2 0 0 1 0-178.4m0 10.7a78.5 78.5 0 1 1 0 157 78.5 78.5 0 0 1 0-157m-65.6 102a155 155 0 0 1 32-44l6 4a155 155 0 0 0-34.1 48.4 70 70 0 0 1-3.9-8.3m71.1-40.6q2.8 2.3 5.4 4.8l5.8-4.5-5.4-4.7zm-11.4-8.7 5.9 4.3 5.9-4.3-5.9-4.3zm.6 18.3 5.3 5 5.3-5-5.3-5zm-11.4-9.3q3 2.2 5.8 4.5l5.4-4.8-5.8-4.4q-2.7 2.2-5.4 4.7m35.2-16.9q-3-2.3-6-4.3l-6.7 4 6 4.3zm10.4 8.6-5.3-4.6-6.4 4 5.5 4.6zm-36-16.6q3.5-2.3 7.1-4.3l7 4.3-7 4zm-11.5 8q3-2.3 6-4.3l6.7 4-6 4.3zM291 215l5.3-4.6 6.4 4-5.5 4.6zm-32.7-10.2a157 157 0 0 1 21.5 10.6 153 153 0 0 0-28.6 37.4 71 71 0 0 1 7-48m6-9.2q13 4.2 25.6 11l-5.3 4.6q-11.6-6.4-23.6-10.8 1.6-2.6 3.3-4.8m7.5-8.3q14.6 4 29.2 11.3l-6 4.2q-13.5-6.7-27.3-11.2zm11-8.4.6.2.8.2q14.8 4 29.7 11.5l-7.4 4.3a187 187 0 0 0-30.2-11.6q3-2.5 6.4-4.6m68.6-3.4-.8.3q-15.4 4.5-30.5 11.8-14.8-7.2-30-11.7l-.5-.1q-.5 0-.8-.3a70 70 0 0 1 62.6 0m12.5 8-.7.2q-15 4.4-29.6 11.4-3.6-2.3-7.4-4.3a145 145 0 0 1 31.3-11.9q3.4 2.2 6.4 4.6m8.5 8q-13.8 4.5-27.2 11.3l-6-4.2q14.5-7.4 29-11.3zm6.7 8.8q-12 4.4-23.6 10.8l-5.3-4.5q12.6-7 25.6-11 1.8 2.1 3.3 4.7m9.7 52.4a153 153 0 0 0-28.6-37.4 157 157 0 0 1 21.5-10.6 70 70 0 0 1 7.1 48m-7 19.1a155 155 0 0 0-34-48.3q3-2.2 6-4.1a157 157 0 0 1 31.9 44 70 70 0 0 1-3.9 8.4m-10.9 15c-8.6-22-20.6-39.9-34.7-54.2l5.6-4.7c14.6 14.4 27 32 35 51.9a71 71 0 0 1-5.9 7m-13.3 10.9-.9-2.5c-7.7-21-18.6-38.2-31.4-52.3l5.3-5.3a151 151 0 0 1 34 55 71 71 0 0 1-7 5m-67.9 4 .9-2.8c6.5-19 16.8-36 29.5-50.3 12.7 14.4 23 31.3 29.5 50.3l1 2.8a70 70 0 0 1-60.9 0m-14.1-9a151 151 0 0 1 34-55l5.3 5.3a158 158 0 0 0-31.4 52.3l-1 2.5a70 70 0 0 1-7-5m-12-13c8-19.9 20.3-37.4 34.9-51.8l5.6 4.7a157 157 0 0 0-34.7 54.2q-3.1-3.4-5.9-7"/></svg>`,
  uz: `<svg xmlns:xlink="http://www.w3.org/1999/xlink" id="flag-icons-uz" viewBox="0 0 640 480"><path fill="#1eb53a" d="M0 320h640v160H0z"/><path fill="#0099b5" d="M0 0h640v160H0z"/><path fill="#ce1126" d="M0 153.6h640v172.8H0z"/><path fill="#fff" d="M0 163.2h640v153.6H0z"/><circle cx="134.4" cy="76.8" r="57.6" fill="#fff"/><circle cx="153.6" cy="76.8" r="57.6" fill="#0099b5"/><g fill="#fff" transform="translate(261.1 122.9)scale(1.92)"><g id="uz-e"><g id="uz-d"><g id="uz-c"><g id="uz-b"><path id="uz-a" d="M0-6-1.9-.3 1 .7"/><use xlink:href="#uz-a" width="100%" height="100%" transform="scale(-1 1)"/></g><use xlink:href="#uz-b" width="100%" height="100%" transform="rotate(72)"/></g><use xlink:href="#uz-b" width="100%" height="100%" transform="rotate(-72)"/><use xlink:href="#uz-c" width="100%" height="100%" transform="rotate(144)"/></g><use xlink:href="#uz-d" width="100%" height="100%" y="-24"/><use xlink:href="#uz-d" width="100%" height="100%" y="-48"/></g><use xlink:href="#uz-e" width="100%" height="100%" x="24"/><use xlink:href="#uz-e" width="100%" height="100%" x="48"/><use xlink:href="#uz-d" width="100%" height="100%" x="-48"/><use xlink:href="#uz-d" width="100%" height="100%" x="-24"/><use xlink:href="#uz-d" width="100%" height="100%" x="-24" y="-24"/></g></svg>`,
  tj: `<svg xmlns:xlink="http://www.w3.org/1999/xlink" id="flag-icons-tj" viewBox="0 0 640 480"><path fill="#060" d="M0 0h640v480H0z"/><path fill="#fff" d="M0 0h640v342.9H0z"/><path fill="#c00" d="M0 0h640v137.1H0z"/><path fill="#f8c300" d="M300.8 233.6a8.6 8.6 0 0 1 16 4V272h6.4v-34.3a8.6 8.6 0 0 1 16-4 20.2 20.2 0 1 0-38.4 0"/><path fill="#fff" d="M305.4 224.7a14 14 0 0 1 14.6 6.5 14 14 0 0 1 14.6-6.5 14.7 14.7 0 0 0-29.2 0"/><path id="tj-a" fill="#f8c300" d="M316.8 258.3a26 26 0 0 1-43.8 16.6 27 27 0 0 1-41 12c2.5 25 40 19.9 42.8-4.4 11.7 20.7 37.6 14.7 45.2-10.6z"/><use xlink:href="#tj-a" width="100%" height="100%" fill="#f8c300" transform="matrix(-1 0 0 1 640 0)"/><path id="tj-b" fill="#f8c300" d="M291.8 302.6c-5.3 11.3-15.7 13.2-24.8 4.1 0 0 3.6-2.6 7.6-3.3-.8-3.1.7-7.5 2.9-9.8a15 15 0 0 1 6.1 8.1c5.5-.7 8.2 1 8.2 1z"/><use xlink:href="#tj-b" width="100%" height="100%" fill="#f8c300" transform="rotate(9.4 320 551.3)"/><use xlink:href="#tj-b" width="100%" height="100%" fill="#f8c300" transform="rotate(18.7 320 551.3)"/><path fill="none" stroke="#f8c300" stroke-width="11" d="M253.5 327.8a233 233 0 0 1 133 0"/><g fill="#f8c300" transform="translate(320 164.6)scale(.68571)"><path id="tj-c" d="m301930 415571-790463-574305h977066l-790463 574305L0-513674z" transform="scale(.00005)"/></g><g id="tj-d" fill="#f8c300" transform="translate(320 260.6)scale(.68571)"><use xlink:href="#tj-c" width="100%" height="100%" transform="translate(-70 -121.2)"/><use xlink:href="#tj-c" width="100%" height="100%" transform="translate(-121.2 -70)"/><use xlink:href="#tj-c" width="100%" height="100%" transform="translate(-140)"/></g><use xlink:href="#tj-d" width="100%" height="100%" fill="#f8c300" transform="matrix(-1 0 0 1 640 0)"/></svg>`,
  tm: `<svg id="flag-icons-tm" viewBox="0 0 640 480"><path fill="#00843d" d="M0 0h640v480H0Z"/><path fill="#fff" d="M357.6 53A59.7 59.7 0 1 1 295 153.7a59.7 59.7 0 0 0 62.3-100.1ZM301 97l6.4-20.8-17.7 12.9h21.9l-17.8-12.9Zm0-30.6 6.4-20.8-17.7 12.9h21.9l-17.8-13.2ZM331.2 82l6.4-20.8-17.8 12.9h22L324 61.2Zm-61 30.3 6.9-20.8-17.8 12.8h22l-17.8-12.8Zm30.3 15.4 6.8-20.7-17.7 12.8h21.9L293.7 107z"/><path fill="#d22630" d="M86.6 0h129.6v480H86.6Z"/><g fill="#383739"><path d="M118 0h-4.2l-8.3 7.6-3-3.4h3l-.8-3h-4.9l-10.2 9V14h5v-3l2.2 2.2-5.3 4.6L94 20l-7.5 6.8v5L99 20.3l-2.2-2.6 4.9-4.6L97.5 9l2.7-3 5.6 5.2ZM87 0v8.7L89.5 6V2.3h3L95.3 0Zm22.6 0h-3l.4 2.3z"/><path fill="#ffc72c" d="M117.6 0h-3.8l-8 7.6-3.7-3.8h3.4l-.8-2.7h-4.5l-9.9 9.5v3h3.8V9.8l3.4 3.4-5.3 4.6 2.3 2.2-7.6 7.6v3.8L98.3 20 96 17.8l5.3-4.6-4.5-4.1 3.8-3.4 5.2 5.3 11.4-11Zm-31 0v8.3l2.2-2.6V1.9h3.4L94.5 0Zm22.6 0h-1.8v1.5z"/></g><g fill="#383739"><path d="M86.6 55.6v4.9l7.2 6.8-2.7 2.2 5.3 5-2.3 1.8v-3h-4.5v3.8l10.2 9.5h5l.7-3.8H102l3-2.7 8.3 7.6-8.3 6.8-3-2.7h3l-.8-3.7h-4.9l-9.8 10.2v3.7h5v-3.7l2.2 2.2-5.3 4.6 2.6 2.6-7.5 6.8v4.6L99 107.7l-2.2-2.6 4.9-4.6-4.2-4.1 2.7-2.7 5.6 4.6 12.5-11.4-12.5-11.3-5.6 5.3-2.7-2.7 4.2-4.1-5-5L99 67 87 55.6zm0 22.6v18.2l2.6-3v-3.8h3l2.7-2.3-2.7-2.3h-3v-3.7zm20.8 6.5v4.9l2.6-2.3z"/><path fill="#ffc72c" d="M86.6 56.3v3.8l7.5 7.2-2.2 2.2 5.3 5-3.4 2.6v-3.4H90v3l9.8 9.5h4.5l.8-2.7h-3.8l4.2-3.8 8.7 7.6-8.7 7.6-3.8-3.8h3.4l-.8-2.3h-4.5l-9.8 9v3.1h3.8v-3.8l3.4 3.4-5.3 4.6 2.2 2.6-7.5 7.2v3.8l11.3-11.4-2.3-2.2 5.3-4.6-4.5-4.1 3.8-3.4 5.6 5.3 11.8-11-12.1-11-5.7 5.3-3.4-3 4.5-4.1-5.3-5 2.7-2.2zm0 22.7v16.6l2.2-2.2v-3.8h3.4l2.3-2.3-2.3-1.9h-3.4v-3.8zm21.1 6.4v3.4l2-1.5Z"/></g><g fill="#383739"><path d="M86.6 145.9v5.3l7.2 6.8-2.7 2.3 5.3 4.5-2.3 2.3v-3h-4.5v3.7l10.2 9h5l.7-3H102l3-3 8.3 7.2-8.3 7.6-3-3.4h3l-.8-3.4h-4.9l-10.2 9.4v3.8h5.3v-3l2.3 1.9-5.3 4.9L94 198l-7.5 6.9v4.9L99 198.4l-2.2-2.6 4.9-5-4.2-3.7 2.7-3 5.6 4.9 12.5-11.4-12.5-11.3-5.6 5.3-2.7-3 4.2-3.8-5-5 2.3-2.2-12-11.3zm0 22.7v17.7l2.6-2.6v-3.8h3l2.7-2.3-2.7-2.6h-3v-3.4zm20.8 6.4v5l2.6-2.7z"/><path fill="#ffc72c" d="M86.6 146.3v3.7l7.5 7.6L92 160l5.3 4.5-3.4 3v-3.7H90v3.7l9.8 8.7h4.5l.8-2.6h-3.8l4.2-3.8 8.7 7.6-8.7 7.9-3.8-3.8h3.4l-.8-2.6h-4.5l-9.8 9.4v3h3.8v-3.7l3.4 3-5.3 4.9 2.2 2.3-7.5 7.5v3.8l11.3-11.3-2.3-2.3 5.3-5-4.5-3.7 3.8-3.8 5.6 6 11.8-11.3-12.1-10.5-5.7 5.2-3.4-3.4 4.5-3.7-5.3-5 2.7-2.2zm0 22.6v17l2.2-2.6v-3.8h3.4l2.3-1.9-2.3-2.2h-3.4v-3.8l-2.2-2.3zm21.1 6.8v3.4l2-1.8Z"/></g><g fill="#383739"><path d="M86.6 236.2v4.6l7.2 6.8-2.7 2.2 5.3 5-2.3 2.2v-3h-4.5v3.8l10.2 9h5l.7-3.4H102l3-2.6 8.3 7.2-8.3 7.1-3-3h3l-.8-3.4h-4.9l-10.2 9.5v3.8h5.3v-3l2.3 1.8-5.3 5L94 288l-7.5 6.8v5L99 288.3l-2.2-2.7 4.9-4.9-4.2-3.8 2.7-3 5.6 5.3 12.5-11.3-12.5-11.4-5.6 5-2.7-2.7 4.2-3.8-5-5.3 2.3-2.2-12-11.4zm0 22.7v17.8l2.6-3v-3.5h3L95 268l-2.7-2.7h-3V262zm20.8 6.4v5l2.6-2.7z"/><path fill="#ffc72c" d="M86.6 236.6v3.8l7.5 7.5-2.2 2 5.3 4.8-3.4 3V254H90v3.4l9.8 9h4.5l.8-2.6h-3.8l4.2-3.8 8.7 7.6-8.7 8-3.8-3.9h3.4l-.8-2.6h-4.5l-9.8 9v3.5h3.8v-3.8l3.4 3-5.3 5L94 288l-7.5 7.6v3.7L97.9 288l-2.3-2.3 5.3-4.9-4.5-3.8 3.8-3.7 5.6 5.6 11.8-11.3-12.1-10.6-5.7 5.3-3.4-3.4 4.5-3.8-5.3-5.3 2.7-2.2zm0 22.7v17l2.2-2.7V270h3.4l2.3-2-2.3-2.2h-3.4V262l-2.2-2.2zm21.1 6.8v3.4l2-2Z"/></g><g fill="#383739"><path d="M86.6 326.6v4.5l7.2 6.8-2.7 2.3 5.3 4.9-2.3 1.9v-3h-4.5v3.7l10.2 9.5h5l.7-3.4H102l3-3 8.3 7.5-8.3 7.2-3-3h3l-.8-3.4h-4.9l-10.2 9.4v3.8h5.3v-3.4l2.3 2.2-5.3 5 2.6 2.2-7.5 6.8v4.6L99 378.3l-2.2-2.2 4.9-5-4.2-4.1 2.7-2.7 5.6 5.3 12.5-11.3-12.5-11.3-5.6 4.9-2.7-2.7 4.2-4.1-5-5L99 338zm0 22.6V367l2.6-3v-3.4h3l2.7-2.7-2.7-2.2h-3v-3.8zm20.8 6.5v4.5l2.6-2.3z"/><path fill="#ffc72c" d="M86.6 327v3.7L94 338l-2.2 2.3 5.3 4.9-3.4 3v-3.8H90v3.4l9.8 9h4.5l.8-2.6h-3.8l4.2-3.7 8.7 7.5-8.7 8-3.8-3.8h3.4l-.8-2.7h-4.5l-9.8 9.1v3.4h3.8v-3.8l3.4 3-5.3 5 2.2 2.2-7.5 7.6v3.4L97.9 378l-2.3-2 5.3-4.9-4.5-4.1 3.8-3.4 5.6 5.3 11.8-11-12.1-11-5.7 5.4-3.4-3 4.5-4.2-5.3-5 2.7-2.2Zm0 22.6v17l2.2-2.3v-3.7h3.4l2.3-2.3-2.3-1.9h-3.4v-3.8l-2.2-2.6zm21.1 6.4v3.8l2-1.9Z"/></g><g fill="#383739"><path d="M184.5 0h4.5l7.6 7.6 3.8-3.8h-3l.7-3h4.9l10.2 9v3.8H208v-3l-2.3 2.3 5.3 4.5-2.6 2.3 7.6 6.8v4.9L203.4 20l2.2-2.6-4.9-4.5 4.2-4.2-2.7-3-5.6 5.6Zm31.7 0v8.7l-3-2.7V2.3h-3L207.5 0Zm-23.8 0h3l-.3 2.3z"/><path fill="#ffc72c" d="M185.2 0h3l8.8 7.6 3.7-3.8h-3.4l.8-2.7h4.5l9.9 9.5v3h-3.8V9.8l-3 3.4 4.9 4.6-2.3 2.6 7.6 7.2v3.8L204.5 20l2.3-2.2-5.3-4.6 4.5-4.1-3.8-3.4-4.9 5.6L185 0Zm31 0v8.3l-2.6-2.6V1.9h-3.4l-2-1.9Zm-23.4 0h2.3v1.5z"/><path d="M216.2 55.6v4.9l-7.5 6.8 2.6 2.2-5.3 5 2.3 1.8v-3h4.5v3.8l-10.2 9.5h-4.9l-.7-3.8h3l-3-2.7-8 7.6 7.6 6.8 3.4-2.7h-3l.7-3.7h5l10.1 9.8v3.8H208v-3.4l-2.3 2.2 5.3 4.6-2.6 2.6 7.6 6.8v4.6l-12.5-11.4 2.2-2.6-4.9-4.6 4.2-4.1-2.7-2.7-5.6 4.6L184 86.9l12.5-11.3 5.6 5.3 2.7-2.7-4.2-4.1 5-5-2.3-2.2 12.5-11.3zm0 22.6v18.2l-3-3v-3.8h-3l-2.7-2.3 2.7-2.3h3v-3.7zm-21.1 6.5.3 2.6-.3 2.3-2.7-2.3z"/><path fill="#ffc72c" d="M216.2 56.3v3.8l-8.3 6.8 2.3 2.3-5 4.9 3 2.6v-3.4h3.9v3l-9.9 9.5h-4.5l-.7-2.7h3.7l-4.1-3.7-8.7 7.5 8.7 7.6 3.8-3.8H197l.7-2.3h4.5l9.9 9.1v3h-3.8v-3.7l-3 3.4 4.9 4.5-2.3 2.6 7.6 7.2v3.8L204 107l2.3-2.3-5.3-4.5 4.5-4.2-3.7-3.4-5.3 5.3-12.1-11 12-11 5.7 5.4 3.4-3-4.5-4.2 5.3-5-2.6-2.2zm0 22.7v16.6l-2.6-2.2v-3.8h-3.4l-2-2.3 2-1.9h3.4v-3.8zm-21.5 6.4.4 2v1.4l-2.3-1.5Z"/><path d="M216.2 145.9v5.3l-7.5 6.8 2.6 2.3-5.3 4.5 2.3 2.3v-3h4.5v3.7l-10.2 9h-4.9l-1.1-3h3l-3-3-7.6 6.8 7.6 7.6 3.4-3.4h-3l.7-3.4h5l10.1 9.4v3.8H208v-3l-2.3 1.9 5.3 4.9-2.6 2.3 7.6 6.8v4.9L203.4 198l2.2-2.6-4.9-5 4.2-3.7-2.7-3-5.6 5.3-12.5-11.4 12.5-11.3 5.6 5.3 2.7-3-4.2-3.8 5-5-2.3-2.2 12.5-11.3zm0 22.7v17.7l-3-2.6v-3.8h-3l-2.7-2.3 2.7-2.6h3v-3.4zm-21.1 6.4.3 2.3-.3 2.6-2.7-2.6z"/><path fill="#ffc72c" d="M216.2 146.3v3.7l-8 7.6 2.4 2.3-5 4.5 3 3v-3.7h3.9v3.7l-9.9 8.7h-4.5l-.8-2.6h3.8l-4.5-3.4-8.7 7.5 8.7 8 3.8-3.8H197l.7-2.7h4.5l9.9 9.5v3h-3.8v-3.8l-3 3 4.9 5-2.3 2.2 7.6 7.6v3.8L204 198l2.3-2.2-5.3-5 4.5-3.7-3.7-3.8-5.3 5.7-12.1-11.4 12-10.5 5.7 5.2 3.4-3.4-4.5-3.7 5.3-5-2.6-2.2zm0 22.6v17l-2.6-2.6v-3.8h-3.4l-2-1.9 2-2.2h3.4v-3.8l2.6-2.3zm-21.5 6.8.4 1.6v1.8l-2.3-1.8Z"/><path d="M216.2 236.2v4.6l-7.5 6.8 2.6 2.2-5.3 5 2.3 2.2v-3h4.5v3.8l-10.2 9h-4.9l-.7-3.4h3l-3-2.6-8 7.2 7.6 7.1 3.4-3h-3l.7-3.4h5l10.1 9.5v3.8H208v-3l-2.3 1.8 5.3 5-2.6 2.2 7.6 6.8v5l-12.5-11.4 2.2-2.7-4.9-4.9 4.2-3.8-2.7-3-5.6 5.3L184 268l12.5-11.4 5.6 5 2.7-2.7-4.2-3.8 5-5.3-2.3-2.2 12.5-11.4zm0 22.7v17.8l-3-3v-3.5h-3l-2.7-2.2 2.7-2.7h3V262zm-21.1 6.4.3 2.3-.3 2.6-2.7-2.6z"/><path fill="#ffc72c" d="M216.2 236.6v3.8l-8 7.5 2.4 2-5 4.8 3 3V254h3.9v3.4l-9.9 9h-4.5l-.8-2.6h3.8L197 260l-8.7 7.6 8.7 8 3.7-3.9h-3.4l.8-2.6h4.5l9.9 9v3.5h-3.8v-3.8l-3 3 4.9 5-2.3 2.2 7.6 7.6v3.7L204.5 288l2.3-2.3-5.3-4.9 4.5-3.8-3.8-3.7-5.2 5.6-12.1-11.3 12-10.6 5.7 5.3 3.4-3.4-4.5-3.8 5.3-5.3-2.7-2.2zm0 22.7v17l-2.6-2.7V270h-3.4l-2-2 2-2.2h3.4V262l2.6-2.2zm-21.5 6.8.4 1.5v1.9l-2.3-2Z"/><path d="M216.2 326.6v4.5l-7.5 6.8 2.6 2.3-5.3 4.9 2.3 1.9v-3h4.5v3.7l-10.2 9.5h-4.9l-.7-3.4h3l-3-3-8 7.5 7.6 7.2 3.4-3h-3l.7-3.4h5l10.1 9.4v3.8H208v-3.4l-2.3 2.2 5.3 5-2.6 2.2 7.6 6.8v4.6l-12.5-11.4 2.2-2.2-4.9-5 4.2-4.1-2.7-2.7-5.6 5.3-12.5-11.3 12.5-11.3 5.6 4.9 2.7-2.7-4.2-4.1 5-5-2.3-2.2zm0 22.6V367l-3-3v-3.4h-3l-2.7-2.7 2.7-2.2h3v-3.8zm-21.1 6.5.3 2.2-.3 2.3-2.7-2.3z"/><path fill="#ffc72c" d="M216.2 327v3.7L208 338l2.3 2.3-5 4.9 3 3v-3.8h3.9v3.4l-9.9 9h-4.5l-.7-2.6h3.7l-4.1-3.7-8.7 7.5 8.7 8 3.8-3.8H197l.7-2.7h4.5l9.9 9.1v3.4h-3.8v-3.8l-3 3 4.9 5-2.3 2.2 7.6 7.6v3.4L204 378l2.3-2-5.3-4.9 4.5-4.1-3.7-3.4-5.3 5.3-12.1-11 12-11 5.7 5.4 3.4-3-4.5-4.2 5.3-5-2.6-2.2zm0 22.6v17l-2.6-2.3v-3.7h-3.4l-2-2.3 2-1.9h3.4v-3.8l2.6-2.6zm-21.5 6.4.4 2v1.8l-2.3-1.9Z"/></g><path fill="#ffc72c" d="M96.8 424.8c.7 2.7 3 4.6 3.8 7.6.7-3 1.5-5.7 1-8.7-.7-2.3-2.6-3.8-2.6-6.4-2.2 1.8-2.6 4.5-2.2 7.5m-.4 11.4a18 18 0 0 0 7.2 5.6c-.8-2.2 0-3.8 1.5-5.6 1.1-2 1.9-3.8.7-6.5a14 14 0 0 1-1.8 3.4 10 10 0 0 0-2.3 5.3c-1.5-1.1-1.9-2.6-2.7-4.1a13 13 0 0 0-5.2-5.3c.7 2.6 1 4.9 2.6 7.2m10.2 7.5-.8 3.8-4.1-3c-1.9-2-4.2-2.7-5.7-5a9 9 0 0 0 3.8 7.2l8 5c-.4-2.7.7-5 1.4-7.6a7 7 0 0 0-1.5-6c0 1.8-.7 3.7-1.1 5.2zm5.3 8.7 3 5.3q-3.7-1.4-7.5-3.8c-2.7-1.5-5.7-2.2-8.4-4.5a13 13 0 0 0 9.1 9c3.4.8 6 .4 9.8 2a27 27 0 0 0-2.6-7.6l-2.3-5.3a6 6 0 0 0-1.1 5zm9.8 7.2a12 12 0 0 0 3.8 3.8c-3.8 0-6.8-2-10.6-2.3-2.2 0-4.5.8-6.8.4 3 1.9 5.7 3.8 9 3.8 4.2.7 8.4 0 13.3 0a17 17 0 0 1-4.9-5.7c-1.9-3-3.8-5-7.2-5.3l3.8 5.3zm13.3 6c-6.5 1.2-12.9 2.7-19.7 2.7a30 30 0 0 0 22.3.4c3.8-1.2 7.2-2.3 10.2-2 4.5 0 9.8 2.3 15.9 8.4l2.3-1.9a36 36 0 0 0-31-7.6"/><path fill="#383739" d="M102.8 56.3 92.2 50V34.8l10.6-6.5V20l9.5-5.6h8l15-8.7h31.8l15.1 8.7h7.6l10.6 5.6v8.3l10.2 6.5v15l-10.2 6.5v8l-9.9 6h-8l-15 8.3h-31.8l-15.1-8.3H113l-10.6-6z"/><path fill="#00843d" d="m135.3 6-15 8.7h-7.6l-9.9 5.7v8l-10.2 6.4v15l10.2 6.1v8.4l9.9 5.6h7.5l15.1 8.3h31.8l15.1-8.3h7.6l9.8-5.6v-8.4l10.2-6V34.8l-10.2-6.5v-7.9l-9.8-5.7h-7.6L167.1 6Zm.8 3.4h30.2l15.2 8.4h7.5l7.6 4.1v8.3l10.2 6.5V48l-10.6 6.4v8l-7.2 4.5h-7.5l-15.2 8.3h-30.2L121 67h-7.6l-7.6-4.5v-8L95.6 48V36.7l10.6-6.5V22l7.6-4.1h7.5z"/><path fill="#ffc72c" d="M151.2 42.3V9.4h-15.1l-14.8 8.7h-7.5l-7.6 3.8v8.3L96 36.7V42h55.2v32.8h15.1l15.2-8.3h7.5l6.8-4.1V54l10.6-6.4v-5.3z"/><path fill="#fff" d="M96 42.3v5.3l10.6 6.4v8.4l6.8 3.7h8l15 8.7h14.8V42h55.2v-5.3l-10.6-6.5v-7.5L189 18h-7.5l-15.2-8.7h-15v33Z"/><g fill="#383739"><path d="m118.7 21.2-2.6-2.7-2.3 1.5 2.6 2.7-3.7 1.9h7.5l6 6 2-2.3-6.1-5.6v-3.8Z"/><path d="m130.8 20-2.6-2.2-2.3 1.5 2.6 2.2-3.8 2h7.6l6 6 2-2.3-5.7-5.7v-3.7zm-12.9 7.6-2.6-2.3-2.6 2 2.6 2.2-3.4 1.9h7.6l6 6 1.9-2.3-6-5.6v-3.8z"/><path d="M151.2 9.4h-6.4l-3.4 3h-6.8l-4.6 2.7 1.2 2.7 4.1-2.3h2l6.7 7.6 7.2-4.2Z"/><path fill="#d22630" d="m116 18.9 2.3 2.3-1.9 1.1-2.2-1.9zm6.1.8v3l5.7 5.6-1.5 1.6-6-5.7h-6.1l7.5-5zm6-1.6 2.3 2-1.9 1.4-2.2-2.2Zm6.1 0V22l5.7 5.3-1.5 1.9-6-6.4h-6.1l7.5-4.6z"/><path fill="#d22630" d="m115.3 26 2.3 2-2 1.1-2.2-1.9Zm5.7 0v4l6 5.2-1.5 1.6-6-5.7h-6Zm30.2-16.6h-6.4l-3.4 3.8H135l-4.6 2 .8 2.2L135 15h2.6l6 7.6 7.6-3.8Z"/><path d="m118.7 63.5-2.6 2.3-2.3-1.5 2.6-2.3-3.7-2.3h7.5l6-5.7 2 2.3L122 62v3.8z"/><path d="m130.8 64.3-2.6 2.6-2.3-1.5 2.6-2.3-3.8-2.2h7.6l6-5.7 2 1.9-5.7 5.6v3.8zm-12.9-7.6-2.6 2.3-2.6-1.6 2.6-2.2-3.4-2.3h7.6l6-5.7 1.9 2-6 5.6v3.8z"/><path d="M151.2 75.2h-6.4l-3.4-3.4h-6.8l-4.6-2.3 1.2-3 4.1 2.3h2l6.7-7.6 7.6 4.6z"/><path fill="#d22630" d="m116 65.4 2.3-2.3-1.9-1.1-2.2 2.3zm6.1-.4v-3.4l5.7-5.7-1.5-1.5-6 5.7h-6.1l7.5 5zm6 1.5 2.3-2.2-1.9-1.2-2.2 2.3zm6.1-.4v-3.7l5.7-5.3-1.5-1.5-6 5.6h-6.1l7.5 5z"/><path fill="#d22630" d="m115.3 58.6 2.3-2.3-2-1.1-2.2 2.2Zm5.7-.4v-3.4l6-5.7-1.5-1.5-6 5.7h-6Zm30.2 16.6h-6.4l-3.4-3.4H135l-4.6-2.2.8-2 3.8 2h2.6l6.4-7.6 7.2 4.2z"/><path d="m114.5 31.7-3-1-4.1 2.6v.7l-6.5 8.3 6.5 8v.7l3.7 3 3.4-1-1.8-1.6v-2.3l.7-.7h3.4V36.3H113l-.3-.8V33Z"/><path fill="#d22630" d="m107.7 33.6 3.8-2.6 2.3.7-1.5 1.2v2.6l.7 1.2h3.4V48H113l-.7 1.1v2.7l1.5.7-2.3 1.2-3.8-2.7v-.7l-6.4-8 6.4-8.3Z"/></g><g fill="#383739"><path d="m183.7 21.2 2.7-2.7 2.2 1.5-2.2 2.7 3 1.9h-7.2l-6 6-2-2.3 6.1-5.6v-3.8Z"/><path d="m171.6 20 2.7-2.2 2.2 1.5-2.2 2.2 3 2H170l-6 6-2-2.3 6.1-5.7v-3.7zm12.9 7.6 2.6-2.3 2.7 2-2.7 2.2 3.4 1.9H183l-5.7 6.4-1.9-2.3 6-5.6V26z"/><path d="M151.2 9.4h6.4l3.8 3h6.4l5 2.7-1.2 2.7-4.5-2.3h-1.9l-6.8 7.6-7.2-4.2Z"/><path fill="#d22630" d="m186.4 18.9-2.3 2.3 1.9 1.1 2.3-1.9zm-5.7.8v3l-6 5.6 1.5 1.6 6-5.7h6l-7.5-5zm-6.8-1.6-2.3 2 2 1.4 2.2-2.2Zm-5.7 0V22l-5.6 5.3 1.5 1.9 6-6.4h6l-7.5-4.6z"/><path fill="#d22630" d="m187.1 26-2.2 2 1.8 1.1 2.3-1.9Zm-5.6 0v4l-6.1 5.2 1.5 1.6 6-5.7h6.1ZM151.2 9.5h6.4l3.4 3.8h6.5l4.5 2-.8 2.2-3.7-2.3h-2.3l-6.8 7.6-7.2-3.8Z"/><path d="m183.7 63.5 2.7 2.3 2.2-1.5-2.2-2.3 3-2.3h-7.2l-6-5.7-2 2.3 6.1 5.7v3.8z"/><path d="m171.6 64.3 2.7 2.6 2.2-1.5-2.2-2.3 3-2.2H170l-6-5.7-2 1.9 6.1 5.6v3.8zm12.9-7.6L187 59l2.7-1.6-2.7-2.2 3.4-2.3H183l-6-5.7-2 2 6 5.6v3.8z"/><path d="M151.2 75.2h6.4l3.8-3.4h6.4l5-2.3-1.2-3-4.5 2.3h-1.9l-6.8-7.6-7.2 4.6z"/><path fill="#d22630" d="M186.4 65.4 184 63l2-1 2.3 2.3zm-5.7-.4v-3.4l-6-5.7 1.5-1.5 6 5.7h6zm-6.4 1.5-2.3-2.2 1.9-1.2 2.3 2.3zm-5.7-.4v-3.7l-6-5L164 56l6 5.7h6l-7.5 5z"/><path fill="#d22630" d="m187.1 58.6-2.2-2.3 1.8-1.1 2.3 2.2zm-5.6-.4v-3.4l-6.1-5.7 1.5-1.5 6 5.7h6.1Zm-30.3 16.6h6.4l3.4-3.4h6.5l4.5-2.2-.8-2-3.7 2h-2.3l-6.8-7.6-7.2 4.2z"/><path d="m187.9 31.7 3-1 4.2 2.6v.7l6.4 8.3-6.4 8v.7l-3.8 3-3.4-1 1.9-1.6v-2.3l-.8-.7h-3.4V36.3h3.8l.4-.8V33Z"/><path fill="#d22630" d="m194.7 33.6-3.8-2.6-2.3.7 1.5 1.2v2.6l-.7 1.2H186V48h3.4l.7 1.1v2.7l-1.5.7 2.3 1.2 3.8-2.7v-.7l6.4-8-6.4-8.3Z"/></g><path fill="#383739" d="m108.9 49.1-1.5-1.5V47l-3.8-4.6 3.8-4.5V37l1.5-1.5 3.4 2.7h-2l2.7 2.6h6l5-3.8v-9.8h11.7l14-8.7v-2.2l-2.3-1.2-2.6 2v1l-2-2.6 3.9-3 4.1-2.7h1.5l3.8 2.7h.8l3.8 3-2 2.6-.3-1-2.7-2h-.7l-2.3 1.5V19l14 8.7h12.1v9.8l4.5 3.8h6l2.7-2.6h-1.5l3-2.7 1.6 1.5v.8l3.7 4.5-3.7 4.5v.8l-1.6 1.5-3-2.6h1.5l-2.6-2.7h-6l-4.6 3.8v9.8h-12.5l-14 8.3v2.3l2.3 1.5h.4l2.6-1.5v-1.1l2 2.6-3.5 2.7h-.4l-4.1 3H150l-3.8-3h-.8l-3.7-3 2.2-2.3v1.1l2.7 1.5h.4l2.2-1.5v-2.3l-14-8.3h-11.7V48l-4.9-3.8h-6L110 47h1.9z"/><path fill="#ffc72c" d="m151.2 70 1.9 1-1.9 1.2zm-4.5 1.8 3.8 3h.7v-2.2L149 71l2.3-1.6V65l-15.1-9h-11v-9.1l-5.6-4.6h-8.7l-2 2.7-2.2-2.7H104l3.7 4.2v.7l1.2 1.6 2.2-2h-1v-.3l2.6-3h6.4l5.3 3.7v9.9h11.3l14.4 8.7v2.6l-2.3 1.5h-1.1l-2.3-1.5v-.7l-1.5 1.5 3 2.6zm-37.8-31.7 1.5 1.9H107zm42.3-27.6-1.5 1.1 1.5 1.1zM192 42.7l1.5 1.5 2-1.9zm-36.3-30.2-3.7-3h-.8v2.2l2.3 2-2.3 1.4V19l15.1 9h11v9.9L183 42h8.7l1.8-2.3 2.3 2.3h2.7l-3.8-3.8V37l-1.2-1-2.2 1.8h1.1l-2.6 3.4h-6.5l-4.9-3.8V27.2h-12l-14-8.3v-2.6l2.2-1.6h1.1l2.3 1.6v.7l1.5-1.9-3-2.6z"/><path fill="#fff" d="m151.2 72.2-1.5-1.1 1.5-1.2zm-40.8-29.9-1.5 2-2-2zm45.3 29.5-3.7 3h-.8v-2.2l2.3-1.5-2.3-1.6V65l15.1-9h11v-9.1l5.7-4.6h8.7l1.8 2.7 2.3-2.7h2.7l-3.8 4.2v.7l-1.2 1.6-2.2-2h1.1v-.3l-2.6-3h-6.5l-4.9 3.7v9.9h-12L152 65.8v2.6l2.2 1.5h1.2l2.2-1.5v-.7l1.5 1.5-3 2.6zm37.8-31.7L192 42h3.4zm-46.8-27.6 3.8-3h.7v2.2l-2.3 2 2.3 1.4V19l-15.1 9h-11v9.9l-5.6 3.8h-8.7l-2-2.3-2.2 2.3H104l3.7-3.8v-1.1l1.2-1.2 2.2 2h-1l2.6 3.3h6.4l5.3-3.8v-9.8h11.3l14.8-8.3v-2.6l-2.3-1.6H147l-2.3 1.6v.7l-1.5-1.9 3-2.6h.8zm4.5 2.6 1.9-1.1-1.9-1.1z"/><path fill="#00843d" d="M151.2 42.3V19.7l-15.1 9h-10.6v9.1l-5.3 4.2h31v22.6l15.1-9H177v-8.7l5.3-4.6z"/><path fill="#d22630" d="m120.2 42.3 5.3 4.6v8.7h10.6l15.1 9V42h31l-5.3-4.2v-9h-10.6l-15-9.1v22.6z"/><path fill="#383739" d="m135.3 31.4-2.6-2.7-2.3 2 2.3 2.2-3 1.9h7.1l6 6 2-2.2-6-5.7V29zm31.8 21.9 2.6 2.3 2.7-1.6-2.7-2.2 3-2.3h-6.4l-6.4-5.7-1.9 2 6 5.6v3.8zm-31.8 0-2.6 2.3-2.3-1.6 2.3-2.2-3-2.3h7.1l6-5.7 2 2-6 5.6v3.8zm31.8-22 2.6-2.6 2.7 2-2.7 2.2 3 1.9h-6.4l-6.4 6-1.9-2.2 6-5.7V29z"/><path fill="#d22630" d="m169.7 55.2-2.2-2.3 1.9-1.1 2.2 2.2zm-5.6-.4v-3.4l-6-5.7 1.4-1.5 6 5.7h6.1zm-31.8-25.3 2.3 1.9-2 1.1-2.2-1.9zm5.7 0v3.8l6 5.3-1.5 1.5-6-5.7h-6l7.5-4.5z"/><path fill="#00843d" d="m169.7 29.5-2.2 1.9 1.9 1.1 2.2-1.9zm-5.6 0v3.8l-6 5.3 1.4 1.5 6-5.7h6.1zm-31.8 26 2.3-2.2-2-1.1-2.2 2.2zm5.7-.3v-3.4l6-5.7-1.5-1.5-6 5.7h-6z"/><path fill="#383739" d="M167 42.3 151.3 53l-15.9-10.6 16-10.6Z"/><path fill="#fff" d="M151.2 32.1 136.1 42h30.2zv20l15-9.8H136l15.1 9.9z"/><path fill="#383739" d="M155.4 45.7v3h-8v-3h-5.6v-7.1h5.6v-3h7.6v3h5.7V46z"/><path fill="#d22630" d="M147.4 36v3h-5.6v3h9.4v-6zm3.8 6h9.5v-3H155v-3h-3.8zm-9.4.3v3.4h5.6v2.7h3.8v-6zm9.4 6h3.8v-2.6h5.7v-3.4h-9.5z"/><path fill="#383739" d="M178.4 162.9v-4.5h12.9v-5h12.5v-41.9h-12.5v-5h-12.9V102h-12.8v-4.5h-28.8v4.5H124v4.6h-13v4.9H98.7v42H111v5.2h13v3.8h12.8v4.6h28.8v-4.6z"/><path fill="#ffc72c" d="M137.2 97.9v4.1h-12.5v4.6H112v4.9H99.4v41.6H112v4.5h12.8v5h12.9v4.5h28v-4.6h12.8V158h12.9v-5H204v-41.5h-12.8V107h-13.6v-4.6h-12.9V98zm3.8 3.4h20.8v4.5h12.8v4.6h12.9v4.9h12.9v34.4h-12.9v5.3h-12.9v3.7h-12.8v4.6h-21.2v-4.6h-12.8V155h-12.9v-5h-12.5v-34.3H115v-5h12.9v-4.9h12.8z"/><path fill="#d22630" d="M128.5 158.7v-4.5h-13.2v-4.5h-12.9v-34h12.9v-5h13.2v-4.5h12.9v-4.5h20.4v4.1h12.8v4.6h12.9v4.9h12.9v34h-12.9v4.5h-13.6v5H161v4.9h-20.4v-5z"/><path fill="#383739" d="m131.2 109.6-3.4-2.6v4.9l-3 1.9v-3l-3 3-3.1-3v3l-3.8-2v4.2l-2.6 2.3v-2.6l-3.8 2.2-3-2.2v2.6L102 116v13.3h-3.8v6.8h3.8v13.2l3.4-2.3v3l3.4-2.6 3.4 2.6v-3l2.6 2.3v4.5l3.8-2.2v3l3-3 3 3v-3.4l3 1.9v4.9l3.5-2.7v3.4l3.4-3 3 3V155l3 2.2v5.3l4.6-4.1v4.5l6-3.8 6 3.8v-4.2l4.6 3.8v-4.9l3-2.3v3.4l3-3 3.8 3V155l3 2.6v-5l3-1.8v3l3.1-3 3 3v-2.6l3.8 2.2V149l2.6-2.3v3l3.8-2.6 3 2.7v-3l3.5 2.2v-12.8h3.7v-6.5h-3.7v-13.2l-3.4 2.3V116l-3.5 2.3-3.4-2.3v2.7l-2.6-2.3v-4.1l-3.8 1.8v-3l-3 3-3-3v3l-3-1.8v-5l-3.5 2.7v-3.4l-3 3-3.8-3v3.4l-2.6-2.3v-4.9l-4.5 3.8V102l-6 3.8-6.1-3.8v3.8l-4.6-3.8v5l-3 2.2v-3.4l-3 3-3.4-3z"/><path fill="#00843d" d="M105.8 119v-3l3 2.3 3.1-2.3v3l3-2.6v32.1l-3-2.2v2.6l-3-2.3-3 2.3v-2.6l-3.5 2.2v-13.2h-3.7v-5.7h3.7v-13.2zm25.8-12 3 2.6 2.6-2.6v3.4l3.4-2.7V157l-3.4-2.3v3.4l-2.6-2.7-3 2.7v-3.4l-3.4 2.6v-49.1l3.4 2.3zm39.3 0-2.7 2.6-3-2.6v3.4l-3.4-2.7V157l3.4-2.3v3.4l3-2.7 2.7 2.7v-3.4l3.4 2.6v-49.1l-3.4 2.3zm25.7 12v-3l-3 2.3-3-2.3v3l-3.1-2.6v32.1l3-2.2v2.6l3-2.3 3 2.3v-2.6l3.5 2.2v-13.2h3.8v-5.7H200v-13.2z"/><path fill="#ffc72c" d="m119 111.9 2.7 2.2 2.7-2.2v2.6l3.8-2.2v40.4l-3.8-2.3v3l-2.7-2.6-2.6 2.6v-3l-3.8 2.3v-40.4l3.8 2.2zm26.5-5-4.5-3.7v59l4.5-4.2v4.5l5.7-3.8 5.7 3.8v-4.9l4.5 3.8v-57.8l-4.5 3.7V102l-5.7 3.8-5.7-3.8zm37.8 5-2.6 2.2-2.6-2.2v2.6l-3.8-2.2v40.4l3.8-2.3v3l2.6-2.6 3 2.6v-3l3.4 2.3v-40.4l-3.8 2.2z"/><g fill="#383739"><path d="m107.4 126.6 1.5.8c.3 0 1.1 0 1.5-.8 1.1-1.1 1.1-3.4 1.1-4.9l-1.9 1.9-.7-1.9-1.2 1.9-1.5-1.9c0 1.5 0 3.8 1.2 5zm13.6-3.4-1.2-1.1v-2l-2.2 2.4 3.7 3.7 4.6-3.7-2.3-2.3v1.9l-1.1 1.1v-3.8l1.9-1.5-2.7-2.2-2.6 2.2 1.9 2zm12.4-3.8-.7-1.1V116l-2.7 2.3 4.6 4.2 3.8-3.8-2.3-2.7v2.3l-.8.8v-3.8l2-1.2-2.7-2.2-2.7 2.2 1.5 1.6z"/><path fill="#fff" d="m108.9 122.5.7 1.5 1.5-1.5c0 1.8-.3 3.4-1 3.7a1.5 1.5 0 0 1-2.4 0c-.7-.3-1.1-1.9-1.1-3.7l1.5 1.5zm26-7.2v4.9l1.6-1.9v-1.1l1.5 1.5-3.8 3.8-3.8-3.8 2-1.5v1.5l1.4 1.9v-5l-1.5-1 2.3-2 1.9 2z"/><path fill="#d22630" d="M122.1 119.4v4.6l1.9-1.5v-1.6l1.5 1.6-3.8 3.7-3.8-3.7 1.6-1.6v1.6l1.5 1.5v-4.6l-1.5-1.5 2.2-1.5 2 1.5z"/><path d="m195 126.6-1.5.8q-.5.2-1-.8c-1.6-1.1-1.6-3.4-1.6-4.9l1.9 1.9.7-1.9 1.2 1.9 1.5-1.9c0 1.5 0 3.8-1.1 5zm-13.2-3.4.8-1.1v-2l2.3 2.4-3.8 3.7-4.6-3.7 2.3-2.3v1.9l1.1 1.1v-3.8l-1.8-1.5 2.6-2.2 2.6 2.2-1.5 2zm-12.8-3.8.7-1.1V116l2.7 2.3-4.2 4.2-4.5-3.8 2.6-2.7v2.3l.8.8v-3.8l-1.5-1.2 2.6-2.2 2.7 2.2-2 1.6z"/><path fill="#fff" d="m193.5 122.5-.7 1.5-1.5-1.5c0 1.8.4 3.4 1.1 3.7a1.5 1.5 0 0 0 2.3 0c.7-.3 1.1-1.9 1.1-3.7l-1.1 1.5zm-26-7.2v4.9l-1.5-1.9v-1.1l-1.6 1.5 3.8 3.8 3.8-3.8-1.9-1.5v1.5l-1.5 1.9v-5l1.5-1-1.9-2-2.2 2z"/><path fill="#d22630" d="M180.3 119.4v4.6l-1.5-1.5v-1.6l-1.5 1.6 3.8 3.7 3.8-3.7-2-1.6v1.6l-1.4 1.5v-4.6l1.5-1.5-2.3-1.5-1.9 1.5z"/><path d="m156.1 121-1.1-2.3 3.4-3-3.4-2.7v1.9l-1.1 1.1v-3.7l3-2-5.7-4.5-5.7 3.8 3 2.7v3.4l-1-1.2v-1.9l-3.5 2.7 3.8 3-1.5 1.9z"/><path fill="#d22630" d="m147 120.6 1.2-2-3.8-3 2.7-1.8v1.1l1.8 1.9v-4.5l-2.6-2 5-3.7 4.8 3.8-2.6 1.9v4.9l1.9-2v-1l2.6 1.8-3.8 3 1.5 2z"/><path d="m148.6 110.4 2.6 1.9 2.7-2-2.7-1.8Z"/><path fill="#00843d" d="m151.2 108.9 1.9 1.5-1.9 1.1-1.9-1.1z"/></g><g fill="#383739"><path d="M107.4 138.3a2 2 0 0 1 1.5-.7c.3 0 1.1 0 1.5.7 1.1 1.2 1.1 3.4 1.1 5l-1.9-1.6-.7 1.5-1.2-1.5-1.5 1.5c0-1.5 0-3.7 1.2-4.9m13.6 3.4-1.2 1.2v1.9l-2.2-2.3 3.7-3.8 4.6 3.8-2.3 2.3v-2l-1.1-1v3.7l1.9 1.5-2.7 2.3-2.6-2.3 1.9-1.9zm12.4 3.8-.7 1.1v2.3l-2.7-2.3 4.6-4.1 3.8 4.1-2.3 2.3v-2.3l-.8-.7v3.8l2 1.1-2.7 2.3-2.7-2.3 1.5-1.5z"/><path fill="#fff" d="m108.9 142.5.7-1.5 1.5 1.5q0-3-1-3.8a1.5 1.5 0 0 0-2.4 0q-1 .8-1.1 3.8l1.5-1.5zm26 7.2v-5l1.6 2v1.5l1.5-1.6-3.8-3.7-3.8 3.7 2 1.6v-1.6l1.4-1.8v4.9l-1.5 1.1 2.3 1.9 1.9-1.9z"/><path fill="#d22630" d="M122.1 145.5V141l1.9 1.5v1.5l1.5-1.5-3.8-3.8-3.8 3.8 1.6 1.5v-1.5l1.5-1.5v4.5l-1.5 1.5 2.2 1.5 2-1.5z"/><path d="M195 138.3a2 2 0 0 0-1.5-.7q-.5-.2-1 .7c-1.6 1.2-1.6 3.4-1.6 5l1.9-1.6.7 1.5 1.2-1.5 1.5 1.5c0-1.5 0-3.7-1.1-4.9zm-13.2 3.4.8 1.2v1.9l2.3-2.3-3.8-3.8-4.6 3.8 2.3 2.3v-2l1.1-1v3.7l-1.8 1.5 2.6 2.3 2.6-2.3-1.5-1.9zm-12.8 3.8.7 1.1v2.3l2.7-2.3-4.2-4.1-4.5 4.1 2.6 2.3v-2.3l.8-.7v3.8l-1.5 1.1 2.6 2.3 2.7-2.3-2-1.5z"/><path fill="#fff" d="m193.5 142.5-.7-1.5-1.5 1.5q0-3 1.1-3.8a1.5 1.5 0 0 1 2.3 0q1 .8 1.1 3.8l-1.1-1.5zm-26 7.2v-5l-1.5 2v1.5l-1.6-1.6 3.8-3.7 3.8 3.7-1.9 1.6v-1.6l-1.5-1.8v4.9l1.5 1.1-1.9 1.9-2.2-1.9z"/><path fill="#d22630" d="M180.3 145.5V141l-1.5 1.5v1.5l-1.5-1.5 3.8-3.8 3.8 3.8-2 1.5v-1.5l-1.4-1.5v4.5l1.5 1.5-2.3 1.5-1.9-1.5z"/><path d="m156.1 144.4-1.1 1.9 3.4 3-3.4 2.6V150l-1.1-1v3.7l3 1.9-5.7 4.1-5.7-3.7 3-2.7V149l-1 1.1v2l-3.5-2.7 3.8-3-1.5-2z"/><path fill="#d22630" d="m147 144.8 1.2 1.5-3.8 3 2.7 1.9V150l1.8-1.8v4.5l-2.6 1.9 5 3.8 4.8-3.8-2.6-2v-4.4l1.9 1.8v1.2l2.6-2-3.8-3 1.5-1.4z"/><path d="m148.6 155 2.6-2.3 2.7 1.9-2.7 1.9Z"/><path fill="#00843d" d="m151.2 156 1.9-1.4-1.9-1.2-1.9 1.2Z"/></g><path fill="#383739" d="M196.6 130.4h-5.3v-1.9h-17.4l-12.1-7.6h-21.2l-12 7.6H111v2.3h-5.3v3.8h5.3v2.6h17.4l12.1 7.6h21.2l12-7.6h17.5v-2.3h5.3z"/><path fill="#d22630" d="m140.6 121-12 7.5h-17v2.3h-5.4v3.4h5.3v2.2h17l12.1 7.6h21.2l12-7.6H191v-2.2h5.7v-3.4H191v-2.3h-17l-12.1-7.6zm0 1h20.8l11.4 7.3v1h12v4.6h-12.4v1.2l-11 6.8H141l-11.3-6.8v-1.2h-12.1v-4.5H130v-1.1z"/><path fill="#d22630" d="m161.4 122 10.6 7.6v.8h12.5v3.8H172v1.5l-10.6 7.2H141l-10.6-7.2v-1.1H118v-3.8h12.5v-1.5L141 122z"/><g fill="#383739"><path d="m135.7 136.4 4.5 3.8 3-2.6-1.4-1.2-1.6.8-1-.8 17.3-13.2h-3.4zm10.2 5.3h3.4l17.4-13.2-4.5-3.8-3 2.7 1.8 1.1 1.2-.8 1.1.8zm7.6 0h3l-17.4-13.2 1.1-.8 1.6.8 1.5-1.1-3-2.3-4.6 3.4Zm9.8-5.3-1.1.8-1.2-.8-1.9 1.2 3 2.2 4.6-3.4-17.4-13.2h-3.8zm-31-3.7 3 1.9 3-2-3-2.2zm15.9-.4 3 2.3 3-2-3-2.2Zm22 0-3.1 2.3-3-2 3-2.2z"/><path fill="#ffc72c" d="m166.3 136.4-4.1 3-2.7-1.8 1.5-.8 1.2.8 1.5-1.2-17-12.8h2.6zm-10.6 5h-2.6l-17-12.9 4.1-3 2.7 1.9-1.1.7-1.6-.7-1.5 1.1zm-6.4 0h-2.6l17-12.9-1.5-1.1-1.2.7-1.5-.7 2.7-2 3.8 3.1zm3.8-17.8h2.6l-17 12.8 1.5 1.2 1.6-.8 1 .8-2.6 1.9-3.7-3z"/><path fill="#00843d" d="m135.3 130.8 2.3 1.9-2.3 1.5-2.6-1.5zm16 0 2.6 1.9-2.7 1.5-2.6-1.5zm15.8 0-2.3 1.9 2.3 1.5 2.6-1.5z"/></g><path fill="#383739" d="m96.4 219.2-1.1 1.9 2.2 1.5-2.2 1.9 1.1 1.5 2.6.4 2.3-1.9 6.4 3.8v-3l-3.7-2.7 3.7-2.3V217l-6.4 3.8-2.3-1.5zm0-11.3-1.1 1.9 2.2 1.5-2.2 1.9 1.1 1.5 2.6.4 2.3-2 6.4 3.8v-3l-3.7-2.6 3.7-2.3v-3.4l-6.4 3.8-2.3-1.5zm0 29.5-1.1-1.6 2.2-1.8-2.2-1.6 1.1-1.8H99l2.3 1.5 6.4-3.8v3.4L104 234l3.7 2.6v3l-6.4-3.8-2.3 2zM206 219.2l1.2 1.9-2.3 1.5 2.3 1.9-1.2 1.5-2.6.4-2.3-1.9-6.4 3.8v-3l3.8-2.7-3.8-2.3V217l6.4 3.8 2.3-1.5zm0-11.3 1.2 1.9-2.3 1.5 2.3 1.9-1.2 1.5-2.6.4-2.3-2-6.4 3.8v-3l3.8-2.6-3.8-2.3v-3.4l6.4 3.8 2.3-1.5zm0 29.5 1.2-1.6-2.3-1.8 2.3-1.6-1.2-1.8h-2.6L201 232l-6.4-3.8v3.4l3.8 2.3-3.8 2.6v3l6.4-3.8 2.3 2zM181.5 189v4.5h3.4v2.3h3.4V192h-3v-3Zm9.8 7.5v3.8h3.8v1.9h3v-3.8h-3v-1.9ZM121 189v4.5h-3.4v2.3h-3.4V192h3v-3Zm60.5 68v-4.5h3.4v-2h3.4v3.9h-3v3zm-60.5 0v-4.5h-3.4v-2h-3.4v3.9h3v3zm70.3-7.6V245h3.8v-2.3h3v3.8h-3v3ZM111 196.5v3.8h-3.7v1.9h-3v-3.8h3v-1.9Zm0 53.3v-4.5h-3.7V243h-3v3.8h3v3zm53-60.8-2.7-2.7-2.6 2.3 2.2 2.3-3 2.6h4.2l1.5-1.5 1.5 1.5h5L167 191l2.3-2.3-2.7-2.3zm-12.9 0-2.6-2.7-2.7 2.3 2.3 2.3-2.7 2.6h4.2l1.5-1.5 1.5 1.5h4.2l-2.7-2.6 2.3-2.3-2.6-2.3zm-12.5 0 2.7-2.7 2.3 2.3-2.3 2.3 3 2.6h-4.2l-1.5-1.5-1.5 1.5h-4.9l3-2.6-2.2-2.3 2.6-2.3 2.7 2.7zm25 68-2.3 3-2.6-2.6 2.2-1.9-3-3h4.2l1.5 1.5 1.5-1.5h5l-3.1 3 2.3 1.9-2.7 2.6zm-12.5 0-2.6 3-2.7-2.6 2.3-1.9-2.7-3h4.2l1.5 1.5 1.5-1.5h4.2l-2.7 3 2.3 1.9-2.6 2.6zm-12.5 0 2.7 3 2.3-2.6-2.3-1.9 3-3h-4.2l-1.5 1.5-1.5-1.5h-4.9l3 3-2.2 1.9 2.6 2.6 2.7-2.6z"/><path fill="#00843d" d="M107.4 225.3v2.6l-6-3.8-2.4 2h-2.2l-1.2-1.6 2.3-1.9-2.3-1.5 1.2-1.5H99l2.3 1.9 6-3.8v2.3l-4.1 2.6zm0-11.4v2.7l-6-3.8-2.4 1.9h-2.2l-1.2-1.5 2.3-2-2.3-1.4 1.2-1.5H99l2.3 1.8 6-3.7v2.2l-4.1 2.7zm0 17.4V229l-6 3.8-2.4-2.2h-2.2l-1.2 1.5L98 234l-2.3 1.8 1.2 1.2H99l2.3-1.5 6 3.7v-2.6l-4.1-2.6zm87.7-6v2.6l6-3.8 2.7 2h1.8l1.2-1.6-2.3-1.9 2.3-1.5-1.2-1.5h-1.5l-2.6 1.9-6-3.8v2.3l4.1 2.6zm0-11.4v2.7l6-3.8 2.7 1.9h1.8l1.2-1.5-2.3-2 2.3-1.4-1.2-1.5h-1.5l-2.6 1.8-6-3.7v2.2l4.1 2.7zm0 17.4V229l6 3.8 2.7-2.2h1.8l1.2 1.5-2.3 1.9 2.3 1.8-1.2 1.2h-1.5l-2.6-1.5-6 3.7v-2.6l4.1-2.6zm-9.9-42.3v3h3v3h-3v-2.2h-3.7V189zm10.2 7.5v2.7h2.7v3h-2.7v-1.9H192v-3.8zm-78.2-7.5v3h-3v3h2.6v-2.2h3.8V189zm68 67.6v-3.4h3v-3h-3v1.9h-3.7v3.8zm-67.3 0v-3.4h-3v-3h2.7v1.9h3.7v3.8zm77.5-7.5v-3h2.7v-3h-2.7v2.2H192v3.8zm-87.7-52.6v3h-3v3h2.7v-2.2h3.4v-3.8zm0 53v-3h-3v-3.1h2.7v2.3h3.4v3.7zm53.7-62.8 2.3 2.7 2.6-2.7 2.3 1.9-2.3 2.3 2.7 2.2h-3.8l-1.5-1.5-1.5 1.5h-3.4l2.6-2.2-2.3-2.3zm-12.8 0 2.6 2.7 2.7-2.7 1.8 1.9-2.2 2.3 2.6 2.2h-3.4l-1.5-1.5-1.5 1.5h-3.8l3-2.2-2.2-2.3zm-7.6 0-2.3 2.7-2.6-2.7-2.3 1.9 2.3 2.3-2.3 2.2h3l2-1.5 1.4 1.5h3.5L141 191l2.3-2.3zm20.4 72.6 2.3-2.3 2.6 2.3 2.3-2-2.3-1.8 2.7-2.6h-3.8l-1.5 1.5-1.5-1.5h-3.4l2.6 2.6-2.3 1.9zm-12.8 0 2.6-2.3 2.7 2.3 1.8-2-2.2-1.8 2.6-2.6h-3.4l-1.5 1.5-1.5-1.5h-3.8l3 2.6-2.2 1.9zm-7.6 0-2.3-2.3-2.6 2.3-2.3-2 2.3-1.8-2.3-2.6h3l2 1.5 1.4-1.5h3.5l-2.7 2.6 2.3 1.9z"/><path fill="#383739" d="M117.2 245.3v7.6h68v-7.6h9.9v-45h-9.9v-7.5h-68v7.5h-9.8v45z"/><path fill="#ffc72c" d="M117.6 193.1v7.6h-9.9v44.2h9.5v7.6h68v-7.6h9.9v-44.6h-9.9v-7.5h-68zm4.5 3h58.2v7.2l2.7 1.6h9v35.5h-9l-2.7 1.9v7.1h-58.2V242l-2.6-1.5h-9.1V205h9l2.7-1.6v-7.5z"/><path fill="#d22630" d="M122.5 196.5v6.5l8.7-6.5zm49.1 0 8.3 6.5v-6.5zm-60.5 8.7v6.5l8-6zm72.2 0 8.4 6.5v-6.5zm8.4 28.8-8.4 6h8.4zm-81 0v6h8.4zm11.4 8.6v6.5h9zm57.8 0-8.7 6.5h8.7z"/><path fill="#00843d" d="m170.9 196.5 20.8 15.2v21.9l-20.8 15h-39.3l-20.8-15v-22l20.8-15.4z"/><path fill="#383739" d="m115.7 235.8-2.3-2.6 2.3-2.6-2.3-2.7 2.3-2.6-2.3-2.7 2.3-2.6-2.3-2.7 2.3-2.6-2.3-2.3 2.3-3h71l2.3 3-2.3 2.3 2.3 2.6-2.3 2.7 2.3 2.6-2.3 2.7 2.3 2.6-2.3 2.7 2.3 2.6-2.3 2.6zm49.1-35.9-3-2.6-2.7 2.3-2.6-2.3-2.6 2.3-2.7-2.3-2.6 2.3-2.7-2.3-2.6 2.3-2.7-2.3-2.6 2.6v45.4l2.6 2.6 2.7-2.2 2.6 2.2 2.7-2.2 2.6 2.2 2.7-2.2 2.6 2.2 2.6-2.2 2.7 2.2 2.6-2.2z"/><g fill="#ffc72c"><path d="m158.8 200.3-2.3-2.3-2.6 2v45.3l2.6 2.3 2.3-2.3zm-10.2 0-2.7-2.3-2.2 2v45.3l2.2 2.3 2.7-2.3z"/><path d="m116 235.8-2.2-2.6 2.3-2.3h70.3l2.2 2.3-2.2 2.6zm70.4-15.5 2.2 2.3-2.2 2.7H116l-2.3-2.7 2.3-2.3zm0-5.6 2.2-2.3-2.2-2.6H116l-2.3 2.6 2.3 2.3z"/></g><g fill="#d22630"><path d="m164 200.3-2.2-2.3-2.7 2v45.3l2.7 2.3 2.3-2.3zm-20.3 0L141 198l-2.3 2v45.3l2.3 2.3 2.7-2.3z"/><path d="m116 230.6-2.2-2.7 2.3-2.3h70.3l2.2 2.3-2.2 2.7zm0-10.6-2.2-2.7 2.3-2.2h70.3l2.2 2.2-2.2 2.7z"/><path d="m153.9 245.7-2.7 1.9-2.3-2.3v-45l2.3-1.9 2.7 2Z"/></g><path fill="#383739" d="M175 200.7h-47.6v3.8H121v36.3h6v3.7h47.6v-3.7h6.9v-36.3h-6.1v-3.8z"/><path fill="#d22630" d="M127.8 201v3.9h-6v35.5h6v3.8h4.5l-9.8-8.4v-26.4l9.8-8.3h-4.9zm42 0 9.8 8.8v26.4l-9.5 7.6h5V240h6v-35.5h-6v-3.8h-5z"/><g fill="#00843d"><path d="m133 201-9.8 8.8v26l9.9 8.4h36.3l9.8-8.4v-26.4l-9.8-8.3zm.8 1.6h34.8l9.5 7.5v25l-9.5 7.5h-34.8l-9.4-7.5v-24.6z"/><path d="m142.9 235.5 1.5.7.4 2-2 1.4 3.1 2.7h-3l-1.9-2-1.9 2h-3l2.6-2.7-1.9-1.5v-1.9l2-.7 1.8 1.5zm10.2 0 1.5.7.4 2-1.9 1.4 3 2.7h-3l-1.9-2-1.9 2h-2.6l2.6-2.7-1.9-1.5v-1.9l2-.7 1.8 1.5zm6.4 0-1.5.7-.4 2 2 1.4-2.7 2.7h2.6l2-2 1.8 2h3l-3-2.7 1.9-1.5v-1.9l-1.9-.7-1.9 1.5zM143 210l1.5-.7.4-1.9-2-1.9 3.1-2.6h-3l-1.9 1.9-1.9-2h-3l2.6 2.7-1.9 1.9v1.9l2 .7 1.8-1.8zm10.2 0 1.5-.7.4-1.9-1.9-1.9 3-2.6h-3l-1.9 1.9-1.9-2h-2.6l2.6 2.7-1.9 1.9v1.9l2 .7 1.8-1.8zm6.4 0-1.5-.7-.4-1.9 2-1.9-2.7-2.6h2.6l2 1.9 1.8-2h3l-3 2.7 1.9 1.9v1.9l-1.9.7-1.9-1.8zm18.2 2.7-1.5 1.5 1.5 1.1v2.3l-2.7-1.9-1.5 1.5h-1.9l-.7-1.5 1.5-1.5-1.5-1.5.7-1.5h2l1.4 1.5 2.7-1.9zm0 8.7-1.5 1.1 1.5 1.5v2l-2.7-2-1.5 1.5h-1.9l-.7-1.5 1.5-1.5-1.5-1.5.7-1.1h2l1.4 1.1 2.7-1.9Zm0 11.3-1.5-1.5 1.5-1.5v-1.9l-2.7 1.9-1.5-1.5h-1.9l-.7 1.5 1.5 1.5-1.5 1.5.7 1.2h2l1.4-1.2 2.7 2zm-53-20 2 1.5-2 1.1v2.3l2.7-1.9 1.5 1.5h1.9l.8-1.5-1.6-1.5 1.6-1.5-.8-1.5H129l-1.5 1.5-2.7-1.9Zm0 8.7 2 1.1-2 1.5v2l2.7-2 1.5 1.5h1.9l.8-1.5-1.6-1.5 1.6-1.5-.8-1.1H129l-1.5 1.1-2.7-1.9Zm0 11.3 2-1.5-2-1.5v-1.9l2.7 1.9 1.5-1.5h1.9l.8 1.5-1.6 1.5 1.6 1.5-.8 1.2H129l-1.5-1.2-2.7 2Z"/></g><path fill="#d22630" d="m133.8 203-8.7 7.5 2.3 2 1.5-1.6h2.3l.7 1.9-1.5 1.5 1.5 1.5-.7 1.5h-2.7l-1.5-1.1-2.6 1.9v.7l2.6 2 1.5-1.6 2.3.4.8 1.5-1.6 1.5 1.6 1.5-.8 2h-2.3l-1.5-1.6-2.6 2.3v.3l2.6 2.3 1.5-1.5h2.3l.8 1.9-1.6 1.5 1.6 1.5-.8 1.5h-2.3l-1.5-1.1-2.3 1.9 8.7 7.5h2l3-3-2-1.5v-2.3l2.3-.7 2 1.5 1.8-1.5 2 .7.3 2.3-2 1.5 3.1 2.7 2.7-2.7-2-1.5v-2.3l2.3-.7 2 1.5 1.8-1.5 2 .7.3 2.3-1.9 1.5 2.6 2.7 3-2.7-1.8-1.5v-2.3l2.2-.7 2 1.5 1.8-1.5 2 .7.3 2.3-1.9 1.5 3 2.7h2l8.6-7.6-2.3-1.5-1.5 1.5-2.2-.4-.8-1.5 1.5-1.5-1.5-1.5.8-1.5 2.2-.4 1.5 1.5 2.7-2.3v-.3l-2.7-2.3-1.5 1.5H171l-.8-1.9 1.5-1.5-1.5-1.5.8-1.5h2.2l1.5 1.1 2.7-1.9v-.7l-2.7-2-1.5 1.6-2.2-.4-.8-1.5 1.5-1.5-1.5-1.5.8-1.5 2.2-.4 1.5 1.5 2.3-1.9-8.7-7.5h-1.9l-3 2.6 1.9 1.9v2.3l-2.3.7-1.9-1.5-1.9 1.5-1.8-.7-.4-2.3 1.9-1.9-2.7-2.6-3 2.6 1.9 1.9v2.3l-2.3.7-1.9-1.5-1.9 1.5-1.8-.7-.4-2.3 1.9-1.9-2.7-2.6-3 2.6 1.9 1.9v2.3l-2.3.7-1.9-1.5-1.9 1.5-1.9-.7-.3-2.3 1.9-1.9-3-2.6zm-9 18.9v1.8l1-1z"/><path fill="#fff" d="m141 241.1-1.5 1.2h3zm10.2 0-1.5 1.2h3zm10.2 0-1.5 1.2h3zm-22-37.8 1.6 1.2 1.5-1.5zm10.3 0 1.5 1.2 1.5-1.5zm10.2 0 1.5 1.2 1.5-1.5zm17.8 10.2-1.2.8 1.2.8zm0 8.4-1.2.7 1.2 1.1zm0 8.7-1.2.7 1.2.8zm-53-17.4v1.9l1.2-.8zm0 8.7v1.8l1.2-1zm0 8.3v1.9l1.2-.8z"/><g fill="#383739"><path d="M160 220v-3h-3.1v-3.5h-11.4v3.4h-3v3h-4.1v5.7h4.1v3h3v3.5H157v-3.8h3v-2.7h4.2V220z"/><path fill="#ffc72c" d="M151.2 214v3.3l-4.9 2.7v2.6h-7.6v-2.3h3.8v-3h3.4v-3.8zm0 17.7v-3.8l5-2.6V223h7.5v2.3h-3.8v3h-3.4v3.4z"/><path fill="#fff" d="M156.1 222.6V220l-4.9-2.7v-3.8h5.3v3.8h3v3h4.2v2.3zm-17.4 0h7.6v2.7l5 3v3.4h-5.4v-3.8h-3v-2.6h-4.2z"/><path fill="#d22630" d="M146.7 223v2.3l4.5 2.6v-5Z"/><path fill="#00843d" d="m151.2 217.7-4.5 2.6v2.3h4.5Z"/><path fill="#d22630" d="M155.7 222.6v-2.3l-4.5-2.6v5z"/><path fill="#00843d" d="m151.2 228 4.5-2.7V223h-4.5Z"/></g><path fill="#d22630" d="M110 283v9.5h-8.7v8.4h-9V325h9v8.7h8.3v9.1h32.5l5.7 3.8-2.6 1.5h-11.4l-1.1-1.1h11l-3-3h-15.2l6.8 7.1h14l5-3.4 4.8 3h14l6.8-7.1h-15.1l-3 3h10.6l-.8 1.1h-11.7l-2.7-1.9 5.7-3.4h32.5v-9h8.7V325h9v-24h-9v-8.4h-8.3v-9.4h-32.5l-5.7-3.8 2.7-1.5h11.3l1.1 1.1h-11l3.1 3h15.1l-6.8-7.1h-14l-4.9 3-4.9-3h-14l-6.8 7.5h15.1l3-3.4h-10.5l.7-1.1h11.7l2.7 1.9-5.7 3.4z"/><path fill="#ffc72c" d="M160 342.4h32v-9h8.4v-8.7h9v-23.5h-9v-8.7h-8.7v-9h-32.2L146 275h-13.6l-6 6.5h14l2.2-2.3h-10.2l1.5-1.9h11.7l15.2 9.5H189v9h9v8.7h9.2v16.7H198v8.7h-9v9.4h-27.7l-15.1 9h-12.1l-1.5-1.8h10.2l-2.3-2.3h-14l6 6.4h14zm-18.6-3h-27.6V330H105v-8.7h-9v-16.7h9V296h8.3v-8.7H141l15.1-9.4h12.1l1.5 1.9h-10.2l2.3 2.3h14L170 275h-14l-13.2 8.4h-32.5v9H102v8.7h-9v23.5h9v8.7h8.8v9h32.5l13.2 8.3h13.6l6-6.4h-14l-2.2 2.3h10.2l-1.5 1.9h-11.7z"/><path fill="none" d="m151.2 281.2-9.4 6h-27.6v9.5h-8.7v8.7h-9.1v15.9h9v8.7h8.8v9.4h27.6l9.4 5.7 9.5-5.7h27.6V330h9v-8.7h9.1v-16h-9v-8.6h-9.1v-9.5h-27.6zm0 2.3 9 5.6h26.2v9.5h8.7v8.3h9v12h-9v8.8h-8.7v8.7h-26.5l-8.7 6-9-6H116v-9h-8.7v-8.8h-9.1v-12h9v-8h8.8V289h26.4z"/><path fill="#00843d" d="M186 327.3v9h-25.7l-9 5.7-9.2-5.6h-25.7v-9h-8.7v-8.8h-9.4v-11.3h9v-8.7h8.8v-9h25.7l9-5.4 9.1 5.3h25.7v9h8.7v8.8h9.8v11.3h-9v8.7z"/><g fill="#383739"><path d="M119.8 324v8.6h14.4l-14.4-9.5zm0-22v-9h14.4l-14.4 9.4Zm62.8 22v8.6h-14.4l14.4-9.5zm0-22v-9h-14.4l14.4 9.4z"/><path fill="#d22630" d="m120.2 324.3 12.9 8.3h-12.9zm0-22.7 12.9-8.3h-12.9zm62 22.7-12.8 8.3h12.8zm0-22.7-12.8-8.3h12.8z"/></g><g fill="#383739"><path d="M138 310.3v-4.2h-1.5l-7.6-4.5-7.6 4.5h-1.5v4.6h-3.7v5.3h3.7v4.5h1.5l7.6 4.5 7.6-4.5h1.5V316h5.3v-6Z"/><path fill="#d22630" d="m128.5 301.6 7.6 4.2h-14.4zm7.6 18.5-7.6 4.2-6.8-4.2zm-1.9-9.4v4.5h-8.7v-4.5z"/><path fill="#ffc72c" d="M137.6 315.6v4.1h-8.7v-4.1zm-9 0v4.1h-8.8v-4.1zm14.3-5v4.6h-8.3v-4.5zm-17.8 0v4.6h-8.7v-4.5Zm12.5-4.5v4.2h-8.7v-3.8zm-9 0v4.2h-8.8v-3.8z"/><path d="M122.9 311.8v2.3H119v-2.3zm3.4-4.5v2.2h-3.8v-2.2zm9 0v2.2h-3.7v-2.2zm-3.7 4.5v2.3h-3.8v-2.3zm9 0v2.3h-3.8v-2.3zm-5.3 4.5v2.3h-3.7v-2.3zm-9 0v2.3h-3.8v-2.3z"/><path fill="#fff" d="M122.5 312.2H119v1.5h3.4zm3.8-4.5h-3.8v1.5h3.8zm8.7 0h-3.4v1.5h3.4zm-3.8 4.5h-2.7v1.5h3zm9 0h-3v1.5h3zm-5.2 4.5h-3.4v1.5h3.4zm-9.1 0h-3v1.5h3z"/></g><g fill="#383739"><path d="M164.4 310.3v-4.2h1.6l7.5-4.5 7.6 4.5h1.9v4.6h3.4v5.3h-3.8v4.5h-1.1l-7.6 4.5-7.6-4.5h-1.5V316h-5.3v-6Z"/><path fill="#d22630" d="m173.9 301.6-7.6 4.2h14zm-7.6 18.5 6.8 4.2 7.2-4.2zm1.5-9.4v4.5h8.7v-4.5z"/><path fill="#ffc72c" d="M164.8 315.6v4.1h8.7v-4.1zm9 0v4.1h8.8v-4.1zm-14.3-5v4.6h8.7v-4.5zm17.8 0v4.6h8.7v-4.5Zm-12.5-4.5v4.2h8.7v-3.8zm9 0v4.2h8.8v-3.8z"/><path d="M180 311.8v2.3h3.7v-2.3zm-3.8-4.5v2.2h3.7v-2.2zm-9.1 0v2.2h3.8v-2.2zm3.8 4.5v2.3h3.7v-2.3zm-9.1 0v2.3h3.8v-2.3zm5.3 4.5v2.3h3.8v-2.3zm9 0v2.3h3.8v-2.3z"/><path fill="#fff" d="M180 312.2h3.3v1.5H180zm-3.5-4.5h3v1.5h-3zm-9 0h3.4v1.5h-3.4zm3.7 4.5h3v1.5h-3zm-9 0h3v1.5h-2.6Zm5.3 4.5h3.4v1.5h-3.4zm9 0h3v1.5h-3z"/></g><g fill="#383739"><path d="M160.3 302.7v4.6h-1.5l-7.6 4.9-7.5-5H142v-4.5h-4.5v-4.9h4.5v-4.5h1.6l7.5-5 7.6 5h1.5v4.5h4.5v4.6Z"/><path fill="#ffc72c" d="m151.2 311.8 6.8-4.5h-13.6zM158 293l-6.8-3.8-6.8 3.8z"/><path fill="#d22630" d="M160 297.8v-4.5h-8.4v4.5zm-8.8 0v-4.5h-8.7v4.5zm13.2 4.6v-3.8h-8.7v3.8zm-9 0v-3.8h-8v3.8zm-8.7 0v-3.8H138v3.8zm13.2 4.5v-4.2h-8.3v4.2zm-8.7 0v-4.2h-8.7v4.2z"/><path d="M148.6 294.4v2.3h-3.8v-1.9Zm9 0v2.3H154v-1.9ZM144 299v2.6h-3.8v-3Zm9.1 0v2.6h-3.8v-3Zm9 0v2.6h-3.7v-3Zm-13.5 4.9v2.2h-3.8V304zm9 0v2.2H154V304z"/><path fill="#fff" d="M148.2 294.8h-3v1.5h3zm9 0h-3v1.5h3zm-13.5 4.5h-3v2h3Zm9 0h-3v2h3zm9.1 0h-3v2h3zm-13.6 4.6h-3v1.9h3zm9 0h-3v1.9h3z"/></g><g fill="#383739"><path d="M160.3 328v5h-1.5l-7.6 4.5-7.5-4.5H142v-5h-4.5v-4.9h4.5v-4.5h1.6l7.5-4.9 7.6 5h1.5v4.4h4.5v5z"/><path fill="#ffc72c" d="m151.2 337.1 6.8-4.1h-13.6zm6.8-18.9-6.8-3.7-6.8 3.7z"/><path fill="#d22630" d="M160 323.1V319h-8.4v4.1zm-8.8 0V319h-8.7v4.1zm13.2 4.6v-4.2h-8.7v4.2zm-9 0v-4.2h-8v4.2zm-8.7 0v-4.2H138v4.2zm13.2 4.9v-4.5h-8.3v4.5Zm-8.7 0v-4.5h-8.7v4.5Z"/><path d="M148.6 319.7v2.7h-3.8v-2.7zm9 0v2.7H154v-2.7ZM144 325v2.3h-3.8V325Zm9.1 0v2.3h-3.8V325Zm9 0v2.3h-3.7V325Zm-13.5 3.8v2.3h-3.8v-2.3Zm9 0v2.3H154v-2.3Z"/><path fill="#fff" d="M148.2 320.1h-3v2h3zm9 0h-3v2h3zm-13.5 5h-3v1.5h3Zm9 0h-3v1.5h3zm9.1 0h-3v1.5h3zm-13.6 4.5h-3v1.5h3zm9 0h-3v1.5h3z"/></g><path fill="#383739" d="m102 383.6 34-18.1h30.3l34 18.1v29.9l-34 17.7h-30.2l-34-17.7z"/><path fill="#00843d" d="m136 365.9-33.6 17.7v29.5l33.7 18.1h30.2l33.7-18.1v-29.5L166.7 366zm.5 2.2h29.8l31.8 17v26.5l-31.8 17h-29.5l-31.7-17V385z"/><path fill="#ffc72c" d="M151.2 398.4v30.2h15.1l31.4-17v-12.9h-46.5v-30.2h-15.1l-31.4 16.6v13.3z"/><path fill="#fff" d="M151.2 398.4v30.2h-15.1l-31.4-17v-12.9h46.5v-30.2h15.1l31.4 16.6v13.3z"/><path fill="#383739" d="M153.9 426.7V418l-2.7 2-2.6-2v8.7h-9.1l6-4.5v-6l-9-5.7h-6v-24.2h5.6l9-5.7v-6L140 370h9v8.7l2.7-1.5 2.6 1.5v-8.3h9.1l-6 4.5v6l9 5.7h6.5v24.2h-6.5l-9 5.7v6l6 4.6z"/><path fill="#ffc72c" d="M154.2 370.4v9l-3-1.8v2.6l14 8.7h4.5v9.5h2.3V387h-6l-9.5-6v-6.8l5.3-3.8zm-23.4 28.3v11.4h5.3l9.4 6v6.5l-5.3 3.7h7.6v-9l3 1.8v-2.6l-14-8.7h-4.5v-9z"/><path fill="#fff" d="m140.6 370.4 5.3 3.8v6.8l-9.4 5.6h-5.7V398h1.9v-8.7h4.5l14-8.7V378l-3 1.8v-9.4zm29.1 28.3v9.1h-4.5l-14 8.7v2.6l3-1.8v9h7.6l-5.3-3.7v-6.9l9.5-6h6v-11.3Z"/><path fill="#d22630" d="M133 407.4h4.2l14 9.1 14-9h4.2v-18.2h-4.2l-14-8.7-14 8.7h-3.8z"/><path fill="#383739" d="M160.7 402.9h3v-1.5h-2.3v-2.7h5v6.5h-4.6v4.5h-9.5v-6.4h4.2v2.6H155v1.2h3.8v-2.3l-17.4-10.6h-3v1.1h2.2v2.7h-4.5v-6.4h4.5V387h9.5v6.4h-3.8v-2.6h1.1v-1.1h-3.7v2.2zm-1.6-11v-2.2H155v1.1h1.5v2.6h-4.2V387h9.5v4.6h4.5v6.4h-4.9v-2.7h2.3v-1.1h-3l-17 10.2v2.3h3.7v-1.2H146V403h4.2v6.4h-9.5v-4.5h-4.5v-6.4h4.9v2.6h-2.3v1.5h3z"/><path fill="#fff" d="M159.5 404.4v3H155v-1.9h1.5v-1.8h-3.4v5.6h8.7v-4.5h4.5V399h-3.7v2h1.8v2.2H161l-17.7-11.4v-2.6h4.9v1.9h-1.5v1.9h3.8v-5.7h-9.1v4.5h-4.6v5.7h3.8v-1.9h-1.9v-1.9h3.4zm1.2-10.6h3.7v2h-2.6v1.8h4.5V392h-4.5v-4.5h-8.7v5.7h3.4v-2H155v-1.8h5v3l-17.9 11h-3.4V401h2.3v-1.9h-3.8v5.7h4.2v4.5h8.7v-5.6h-3.4v1.8h1.5v2h-5v-3z"/><path fill="#383739" d="M190.5 399.9v9.4h-3.8V406h-4.1v3.4h-4.2V400h3.8v3.4h4.2V400zm-14.3 12.4v9.5h-3.8v-3.4h-4.2v3.4h-3.8v-9.5h3.8v3.4h3.8v-3.4zm14.3-15v-9.9h-3.8v3.4h-4.1v-3.4h-4.2v9.5h3.8v-3.5h4.2v3.8zm-78.6 2.6v9.4h3.8V406h4.1v3.4h4.2V400h-3.8v3.4h-4.1V400zm0-3v-9.5h3.8v3.4h4.1v-3.4h4.2v9.5h-3.8v-3.5h-4.1v3.8zm64.3-12.5v-9.5h-3.8v3.4h-4.2V375h-3.8v9.5h3.8V381h3.8v3.8zm-50 28v9.4h3.8v-3.4h4.2v3.4h4.2v-9.5h-3.8v3.4h-4.2v-3.4zm0-28v-9.5h3.8v3.4h4.2V375h4.2v9.5h-3.8V381h-4.2v3.8zm52.2-6.4v7.1h13.3zM124 419v-7.5h-13.2zm0-41.5v7.5h-13.2zm54.4 41.5v-7.5h13.3z"/><path fill="#d22630" d="M186.7 405.5v3.8h3.4v-9h-3.4v3.4h-4.5v-3.4h-3.8v8.6h3.8v-3.4zM172.4 418v3.8h3.4v-9h-3.4v3.3h-4.6v-3.4h-3.4v8.7h3.4V418zm14.3-26.8v-3.4h3.4v8.7h-3.4V393h-4.5v3.8h-3.8v-9.1h3.8v3.4zm-71 14.3v3.8h-3.4v-9h3.4v3.4h4.5v-3.4h3.8v8.6h-3.8v-3.4zm0-14.3v-3.4h-3.4v8.7h3.4V393h4.5v3.8h3.8v-9.1h-3.8v3.4zm56.7-12.5v-3.4h3.4v8.7h-3.4v-3.4h-4.6v3.8h-3.4v-9h3.4v3.3zM130 418v3.8h-3.4v-9h3.4v3.3h4.6v-3.4h3.8v8.7h-3.8V418zm0-39.3v-3.4h-3.4v8.7h3.4v-3.4h4.6v3.8h3.8v-9h-3.8v3.3z"/><path fill="#ffc72c" d="M178.8 378.3v6.5h11.3zm-66.9 34 11.3 6v-6z"/><path fill="#fff" d="m123.6 378.3-11.3 6.5h11.3zm55.2 34v6l11.3-6z"/><path fill="#ffc72c" d="M205.6 424.8c-.7 2.7-3 4.6-3.4 7.6-1-3-1.8-5.7-1-8.7 0-2.3 2.2-3.8 2.6-6.4q2.5 2.8 1.8 7.5m.4 11.4a18 18 0 0 1-6.8 5.6c.4-2.2-.7-3.8-1.9-5.6-1.1-2-1.9-3.8-.7-6.5a14 14 0 0 0 1.9 3.4c1.1 1.5 2.2 3 2.2 5.3 1.5-1.1 2-2.6 2.7-4.1a13 13 0 0 1 5.3-5.3c-.8 2.6-1.2 4.9-2.7 7.2m-9.8 7.5.4 3.8 4.1-3c2-2 4.2-2.7 5.7-5a10 10 0 0 1-3.8 7.2l-7.5 5q-.1-3.9-2-7.6a7 7 0 0 1 2-6q0 2.8 1.1 5.2zm-5.7 8.7-3 5.3q3.8-1.4 7.6-3.8c2.6-1.5 5.6-2.2 8.3-4.5-1.2 4.9-4.6 7.5-9 9-3.1.8-6.1.4-10 2a27 27 0 0 1 2.7-7.6l2.7-5.3q1.2 2.1.7 5zm-9.8 7.2a12 12 0 0 1-3.8 3.8c3.8 0 6.8-2 10.6-2.3 2.3 0 4.5.8 6.8.4-2.6 1.9-5.7 3.8-9 3.8-4.2.7-8.4 0-13 0 2.3-1.6 3.5-3.8 4.6-5.7 2-3 3.8-5 7.2-5.3-1.5 1.5-2.3 3.8-3.4 5.3m-13.2 6c6.4 1.2 12.8 2.7 19.6 2.7a30 30 0 0 1-22.3.4c-3.8-1.2-7.2-2.3-10.2-2-4.1 0-9.8 2.3-15.9 8.4l-2.2-1.9c8.7-7.6 20-9.5 31-7.6"/></svg>`,
  hk: `<svg xmlns:xlink="http://www.w3.org/1999/xlink" id="flag-icons-hk" viewBox="0 0 640 480"><path fill="#EC1B2E" d="M0 0h640v480H0"/><path id="hk-a" fill="#fff" d="M346.3 103.1C267 98 230.6 201.9 305.6 240.3c-26-22.4-20.6-55.3-10.1-72.4l1.9 1.1c-13.8 23.5-11.2 52.7 11.1 71-12.7-12.3-9.5-39 12.1-48.9s23.6-39.3 16.4-49.1q-14.7-25.6 9.3-38.9M307.9 164l-4.7 7.4-1.8-8.6-8.6-2.3 7.8-4.3-.6-8.9 6.5 6.1 8.3-3.3-3.7 8.1 5.6 6.8z"/><use xlink:href="#hk-a" transform="rotate(72 312.5 243.5)"/><use xlink:href="#hk-a" transform="rotate(144 312.5 243.5)"/><use xlink:href="#hk-a" transform="rotate(216 312.5 243.5)"/><use xlink:href="#hk-a" transform="rotate(288 312.5 243.5)"/></svg>`,
  sg: `<svg id="flag-icons-sg" viewBox="0 0 640 480"><defs><clipPath id="sg-a"><path fill-opacity=".7" d="M0 0h640v480H0z"/></clipPath></defs><g fill-rule="evenodd" clip-path="url(#sg-a)"><path fill="#fff" d="M-20 0h720v480H-20z"/><path fill="#df0000" d="M-20 0h720v240H-20z"/><path fill="#fff" d="M146 40.2a84.4 84.4 0 0 0 .8 165.2 86 86 0 0 1-106.6-59 86 86 0 0 1 59-106c16-4.6 30.8-4.7 46.9-.2z"/><path fill="#fff" d="m133 110 4.9 15-13-9.2-12.8 9.4 4.7-15.2-12.8-9.3 15.9-.2 5-15 5 15h15.8zm17.5 52 5 15.1-13-9.2-12.9 9.3 4.8-15.1-12.8-9.4 15.9-.1 4.9-15.1 5 15h16zm58.5-.4 4.9 15.2-13-9.3-12.8 9.3 4.7-15.1-12.8-9.3 15.9-.2 5-15 5 15h15.8zm17.4-51.6 4.9 15.1-13-9.2-12.8 9.3 4.8-15.1-12.9-9.4 16-.1 4.8-15.1 5 15h16zm-46.3-34.3 5 15.2-13-9.3-12.9 9.4 4.8-15.2-12.8-9.4 15.8-.1 5-15.1 5 15h16z"/></g></svg>`,
  jp: `<svg id="flag-icons-jp" viewBox="0 0 640 480"><defs><clipPath id="jp-a"><path fill-opacity=".7" d="M-88 32h640v480H-88z"/></clipPath></defs><g fill-rule="evenodd" stroke-width="1pt" clip-path="url(#jp-a)" transform="translate(88 -32)"><path fill="#fff" d="M-128 32h720v480h-720z"/><circle cx="523.1" cy="344.1" r="194.9" fill="#bc002d" transform="translate(-168.4 8.6)scale(.76554)"/></g></svg>`,
  kr: `<svg xmlns:xlink="http://www.w3.org/1999/xlink" id="flag-icons-kr" viewBox="0 0 640 480"><defs><clipPath id="kr-a"><path fill-opacity=".7" d="M-95.8-.4h682.7v512H-95.8z"/></clipPath></defs><g fill-rule="evenodd" clip-path="url(#kr-a)" transform="translate(89.8 .4)scale(.9375)"><path fill="#fff" d="M-95.8-.4H587v512H-95.8Z"/><g transform="rotate(-56.3 361.6 -101.3)scale(10.66667)"><g id="kr-c"><path id="kr-b" fill="#000001" d="M-6-26H6v2H-6Zm0 3H6v2H-6Zm0 3H6v2H-6Z"/><use xlink:href="#kr-b" width="100%" height="100%" y="44"/></g><path stroke="#fff" d="M0 17v10"/><path fill="#cd2e3a" d="M0-12a12 12 0 0 1 0 24Z"/><path fill="#0047a0" d="M0-12a12 12 0 0 0 0 24A6 6 0 0 0 0 0Z"/><circle cy="-6" r="6" fill="#cd2e3a"/></g><g transform="rotate(-123.7 191.2 62.2)scale(10.66667)"><use xlink:href="#kr-c" width="100%" height="100%"/><path stroke="#fff" d="M0-23.5v3M0 17v3.5m0 3v3"/></g></g></svg>`,
  cn: `<svg xmlns:xlink="http://www.w3.org/1999/xlink" id="flag-icons-cn" viewBox="0 0 640 480"><defs><path id="cn-a" fill="#ff0" d="M-.6.8 0-1 .6.8-1-.3h2z"/></defs><path fill="#ee1c25" d="M0 0h640v480H0z"/><use xlink:href="#cn-a" width="30" height="20" transform="matrix(71.9991 0 0 72 120 120)"/><use xlink:href="#cn-a" width="30" height="20" transform="matrix(-12.33562 -20.5871 20.58684 -12.33577 240.3 48)"/><use xlink:href="#cn-a" width="30" height="20" transform="matrix(-3.38573 -23.75998 23.75968 -3.38578 288 95.8)"/><use xlink:href="#cn-a" width="30" height="20" transform="matrix(6.5991 -23.0749 23.0746 6.59919 288 168)"/><use xlink:href="#cn-a" width="30" height="20" transform="matrix(14.9991 -18.73557 18.73533 14.99929 240 216)"/></svg>`,
  no: `<svg id="flag-icons-no" viewBox="0 0 640 480"><path fill="#ed2939" d="M0 0h640v480H0z"/><path fill="#fff" d="M180 0h120v480H180z"/><path fill="#fff" d="M0 180h640v120H0z"/><path fill="#002664" d="M210 0h60v480h-60z"/><path fill="#002664" d="M0 210h640v60H0z"/></svg>`,
  at: `<svg id="flag-icons-at" viewBox="0 0 640 480"><path fill="#ed2939" d="M0 0h640v480H0z"/><path fill="#fff" d="M0 160h640v160H0z"/></svg>`,
  be: `<svg id="flag-icons-be" viewBox="0 0 640 480"><path d="M0 0h213.3v480H0z"/><path fill="#ffd90c" d="M213.3 0h213.4v480H213.3z"/><path fill="#ef3340" d="M426.7 0H640v480H426.7z"/></svg>`,
  bg: `<svg id="flag-icons-bg" viewBox="0 0 640 480"><path fill="#fff" d="M0 0h640v160H0z"/><path fill="#00966e" d="M0 160h640v160H0z"/><path fill="#d62612" d="M0 320h640v160H0z"/></svg>`,
  cz: `<svg id="flag-icons-cz" viewBox="0 0 640 480"><path fill="#fff" d="M0 0h640v240H0z"/><path fill="#d7141a" d="M0 240h640v240H0z"/><path fill="#11457e" d="M0 0l320 240L0 480z"/></svg>`,
  dk: `<svg id="flag-icons-dk" viewBox="0 0 640 480"><path fill="#c8102e" d="M0 0h640v480H0z"/><path fill="#fff" d="M213.3 0h85.4v480h-85.4z"/><path fill="#fff" d="M0 213.3h640v85.4H0z"/></svg>`,
  ee: `<svg id="flag-icons-ee" viewBox="0 0 640 480"><path fill="#0072ce" d="M0 0h640v160H0z"/><path d="M0 160h640v160H0z"/><path fill="#fff" d="M0 320h640v160H0z"/></svg>`,
  gr: `<svg id="flag-icons-gr" viewBox="0 0 640 480"><path fill="#0d5eaf" d="M0 0h640v480H0z"/><path fill="#fff" d="M0 53.3h640v53.4H0zM0 160h640v53.3H0zM0 266.7h640V320H0zM0 373.3h640v53.4H0zM0 426.7h640V480H0z"/><path fill="#0d5eaf" d="M0 0h266.7v266.7H0z"/><path fill="#fff" d="M106.7 0h53.3v266.7h-53.3zM0 106.7h266.7V160H0z"/></svg>`,
  hu: `<svg id="flag-icons-hu" viewBox="0 0 640 480"><path fill="#ce2939" d="M0 0h640v160H0z"/><path fill="#fff" d="M0 160h640v160H0z"/><path fill="#477050" d="M0 320h640v160H0z"/></svg>`,
  id: `<svg id="flag-icons-id" viewBox="0 0 640 480"><path fill="#e70011" d="M0 0h640v240H0z"/><path fill="#fff" d="M0 240h640v240H0z"/></svg>`,
  ie: `<svg id="flag-icons-ie" viewBox="0 0 640 480"><path fill="#169b62" d="M0 0h213.3v480H0z"/><path fill="#fff" d="M213.3 0h213.4v480H213.3z"/><path fill="#ff883e" d="M426.7 0H640v480H426.7z"/></svg>`,
  il: `<svg id="flag-icons-il" viewBox="0 0 640 480"><path fill="#fff" d="M0 0h640v480H0z"/><path fill="#0038b8" d="M0 75h640v55H0zM0 350h640v55H0z"/><path fill="#0038b8" d="M320 193l33.7 58.3h-67.4zM320 287l-33.7-58.3h67.4z"/></svg>`,
  it: `<svg id="flag-icons-it" viewBox="0 0 640 480"><path fill="#009246" d="M0 0h213.3v480H0z"/><path fill="#fff" d="M213.3 0h213.4v480H213.3z"/><path fill="#ce2b37" d="M426.7 0H640v480H426.7z"/></svg>`,
  ro: `<svg id="flag-icons-ro" viewBox="0 0 640 480"><path fill="#002b7f" d="M0 0h213.3v480H0z"/><path fill="#fcd116" d="M213.3 0h213.4v480H213.3z"/><path fill="#ce1126" d="M426.7 0H640v480H426.7z"/></svg>`,
  ch: `<svg id="flag-icons-ch" viewBox="0 0 640 480"><path fill="#da291c" d="M0 0h640v480H0z"/><path fill="#fff" d="M256 128h128v224H256z"/><path fill="#fff" d="M128 224h384v128H128z"/></svg>`,
  es: `<svg id="flag-icons-es" viewBox="0 0 640 480"><path fill="#c60b1e" d="M0 0h640v480H0z"/><path fill="#ffc400" d="M0 120h640v240H0z"/></svg>`,
  ar: `<svg id="flag-icons-ar" viewBox="0 0 640 480"><path fill="#74acdf" d="M0 0h640v480H0z"/><path fill="#fff" d="M0 160h640v160H0z"/></svg>`,
  br: `<svg id="flag-icons-br" viewBox="0 0 640 480"><path fill="#009c3b" d="M0 0h640v480H0z"/><path fill="#ffdf00" d="M320 55 590 240 320 425 50 240z"/><circle cx="320" cy="240" r="85" fill="#002776"/></svg>`,
  "in": `<svg id="flag-icons-in" viewBox="0 0 640 480"><path fill="#f93" d="M0 0h640v160H0z"/><path fill="#fff" d="M0 160h640v160H0z"/><path fill="#128807" d="M0 320h640v160H0z"/><circle cx="320" cy="240" r="40" fill="none" stroke="#008" stroke-width="14"/></svg>`,
  ca: `<svg id="flag-icons-ca" viewBox="0 0 640 480"><path fill="#fff" d="M150.1 0h339.7v480H150z"/><path fill="#d52b1e" d="M-19.7 0h169.8v480H-19.7zm509.5 0h169.8v480H489.9zM201 232l-13.3 4.4 61.4 54c4.7 13.7-1.6 17.8-5.6 25l66.6-8.4-1.6 67 13.9-.3-3.1-66.6 66.7 8c-4.1-8.7-7.8-13.3-4-27.2l61.3-51-10.7-4c-8.8-6.8 3.8-32.6 5.6-48.9 0 0-35.7 12.3-38 5.8l-9.2-17.5-32.6 35.8c-3.5.9-5-.5-5.9-3.5l15-74.8-23.8 13.4q-3.2 1.3-5.2-2.2l-23-46-23.6 47.8q-2.8 2.5-5 .7L264 130.8l13.7 74.1c-1.1 3-3.7 3.8-6.7 2.2l-31.2-35.3c-4 6.5-6.8 17.1-12.2 19.5s-23.5-4.5-35.6-7c4.2 14.8 17 39.6 9 47.7"/></svg>`
};
function serverParts(name) {
  let s = (name || "").trim();
  // 1) Имя начинается с ЭМОДЗИ-ФЛАГА (два regional indicator символа), как у AID:
  //    "🇳🇱 Netherlands". Переводим пару в ISO-код (🇳🇱 → nl).
  const cps = Array.from(s);
  if (cps.length >= 2) {
    const a = cps[0].codePointAt(0), b = cps[1].codePointAt(0);
    const RI0 = 0x1F1E6, RI25 = 0x1F1FF;
    if (a >= RI0 && a <= RI25 && b >= RI0 && b <= RI25) {
      const cc = String.fromCharCode(97 + (a - RI0)) + String.fromCharCode(97 + (b - RI0));
      const rest = cps.slice(2).join("").trim();
      if (FLAG_SVG[cc]) return { flag: `<span class="s-flag">${FLAG_SVG[cc]}</span>`, rest };
      return { flag: `<span class="s-badge">${escapeHtml(cc.toUpperCase())}</span>`, rest };
    }
  }
  // 2) Имя начинается с буквенного кода: "NL Netherlands" (другие провайдеры)
  const m = /^([A-Za-z]{2})\s+(.+)/.exec(s);
  if (m) {
    const cc = m[1].toLowerCase();
    if (FLAG_SVG[cc]) return { flag: `<span class="s-flag">${FLAG_SVG[cc]}</span>`, rest: m[2] };
    return { flag: `<span class="s-badge">${escapeHtml(m[1].toUpperCase())}</span>`, rest: m[2] };
  }
  return { flag: "", rest: name || "" };
}
// Текстовый вариант (для строки «выбранного сервера», где нельзя вставить разметку)
function serverLabel(name) { return name || ""; }

// ── Сортировка списка (применяется ВНУТРИ каждой подписки) ──────────────────
let sortField = "default"; // default | name | proto | ping
let sortDir = 1; // 1 = ↑, -1 = ↓
let selectedName = null; // выбор храним по имени, чтобы переживал сортировку

function sortKey(s) {
  if (sortField === "name") return (s.name || "").toLowerCase();
  if (sortField === "proto") return (s.protocol || "").toLowerCase();
  if (sortField === "ping") {
    const p = s.pingMs;
    return (p === undefined || p < 0) ? Infinity : p; // непроверенные/недоступные — в конец
  }
  return s._ord ?? 0; // default — порядок загрузки
}
// Отсортированная КОПИЯ серверов подписки (сам массив sub.servers не трогаем,
// чтобы «по умолчанию» всегда был исходный порядок из подписки).
function sortedServers(sub) {
  const arr = (sub.servers || []).slice();
  if (sortField === "default") return arr;
  arr.sort((a, b) => {
    const ka = sortKey(a), kb = sortKey(b);
    // "конец списка" для ping не переворачиваем направлением
    if (sortField === "ping") {
      if (ka === Infinity && kb !== Infinity) return 1;
      if (kb === Infinity && ka !== Infinity) return -1;
    }
    if (ka < kb) return -1 * sortDir;
    if (ka > kb) return 1 * sortDir;
    return 0;
  });
  return arr;
}
// Пересобрать плоский список servers из подписок + восстановить selectedIndex.
function subEnabled(sub) { return !sub || sub.enabled !== false; }

function refreshFlat() {
  servers = [];
  subs.forEach((sub) => {
    (sub.servers || []).forEach((s, i) => { s._subId = sub.id; if (s._ord === undefined) s._ord = i; });
    if (!subEnabled(sub)) return;
    servers.push(...sortedServers(sub));
  });
  if (selectedName) selectedIndex = servers.findIndex((s) => s.name === selectedName && s._subId === selectedSubId);
}
function applySort(field, dir) {
  if (field !== undefined) sortField = field;
  if (dir !== undefined) sortDir = dir;

  // UI индикаторы
  const sel = $("sortSelect"); if (sel) sel.value = sortField;
  const db = $("sortDirBtn"); if (db) db.textContent = sortDir > 0 ? "▲" : "▼";
  document.querySelectorAll(".server-head .col").forEach((c) => {
    const ar = c.querySelector(".ar");
    ar.textContent = (c.dataset.sort === sortField && sortField !== "default") ? (sortDir > 0 ? " ▲" : " ▼") : "";
  });

  renderServers();
}

// ── МУЛЬТИПОДПИСКА: хранение и CRUD ─────────────────────────────────────────
function newSubId() { return "sub_" + Date.now().toString(36) + "_" + Math.random().toString(36).slice(2, 7); }
function hostFromUrl(u) { try { return new URL(u).host; } catch (_) { return ""; } }

// Сохранить подписки в SQLite (settings.subscriptions). sub_url продолжаем
// писать (URL первой подписки) для совместимости со старыми версиями/экспортом.
function persistSubs() {
  const lite = subs.map((s) => ({
    id: s.id, name: s.name, url: s.url, collapsed: !!s.collapsed,
    enabled: s.enabled !== false,
    info: s.info || null, servers: s.servers || [],
  }));
  setSetting("subscriptions", JSON.stringify(lite));
  if (subs.length) setSetting("sub_url", subs[0].url);
}

// Прочитать подписки из хранилища; если их нет, но есть старый sub_url —
// мигрируем его в первую подписку.
async function loadSubs() {
  subs = [];
  const raw = await getSetting("subscriptions");
  if (raw) {
    try {
      const arr = JSON.parse(raw);
      if (Array.isArray(arr)) {
        subs = arr.filter((s) => s && s.url).map((s) => ({
          id: s.id || newSubId(),
          name: s.name || "",
          url: s.url,
          collapsed: !!s.collapsed,
          enabled: s.enabled !== false,
          info: s.info || null,
          servers: Array.isArray(s.servers) ? s.servers : [],
        }));
      }
    } catch (_) { subs = []; }
  }
  if (!subs.length) {
    const url = (await getSetting("sub_url")) || "";
    if (url) subs = [{ id: newSubId(), name: "", url, collapsed: false, enabled: true, info: null, servers: [] }];
  }
  subs.forEach((sub) => (sub.servers || []).forEach((s, i) => { s._ord = i; s._subId = sub.id; }));
}

// Скачать и распарсить подписку (обновление серверов и info карточки).
async function fetchSub(sub) {
  sub._busy = true;
  renderServers();
  try {
    const res = await invoke("load_subscription", { url: sub.url, useProxy: connected });
    res.servers.forEach((s, i) => { s._ord = i; s._subId = sub.id; });
    sub.servers = res.servers;
    sub.info = res.info || null;
    if (sub.info && sub.info.title) sub.name = sub.info.title;
    if (!sub.name) sub.name = hostFromUrl(sub.url);
    addLog(`[BearNest] ${I18N.t("Loaded")} ${sub.servers.length} (${sub.name})`);
    persistSubs();
    return true;
  } catch (e) {
    addLog("[BearNest] ❌ " + e);
    showToast("❌", String(e));
    return false;
  } finally {
    sub._busy = false;
    renderServers();
    const selSub = subs.find((x) => x.id === selectedSubId);
    if (selSub) updateSubPanelFor(selSub);
  }
}
async function refreshSub(id) {
  const sub = subs.find((s) => s.id === id);
  if (sub) await fetchSub(sub);
}

// Клонировать подписку (копия URL, серверов и info; имя + «копия»).
function cloneSub(id) {
  const i = subs.findIndex((s) => s.id === id);
  if (i < 0) return;
  const orig = subs[i];
  const copy = JSON.parse(JSON.stringify({
    id: orig.id, name: orig.name, url: orig.url,
    collapsed: false, enabled: orig.enabled !== false,
    info: orig.info, servers: orig.servers,
  }));
  copy.id = newSubId();
  const base = (orig.name || hostFromUrl(orig.url) || orig.url) + " — " + I18N.t("SubCopy");
  let name = base, n = 2;
  while (subs.some((s) => s.name === name)) name = `${base} ${n++}`;
  copy.name = name;
  copy.servers.forEach((s, j) => { s._ord = j; s._subId = copy.id; s.pingMs = -1; });
  subs.splice(i + 1, 0, copy);
  persistSubs();
  renderServers();
  showToast("⧉", I18N.t("SubCloned"));
  addLog(`[BearNest] ⧉ ${name}`);
}

// Включить или выключить подписку. Выключенная остаётся в списке,
// но её серверы не пингуются, не выбираются и не участвуют в автопереключении.
async function toggleSub(id) {
  const sub = subs.find((s) => s.id === id);
  if (!sub) return;
  sub.enabled = sub.enabled === false;
  const on = subEnabled(sub);
  if (!on) {
    if (selectedSubId === id) {
      selectedSubId = null; selectedName = null; selectedIndex = -1;
      $("selectedServer").textContent = "";
      setSetting("last_server", "");
      updateSubPanelFor(null);
    }
    if (connectedSubId === id) await doDisconnect();
  }
  persistSubs();
  renderServers();
  showToast(on ? "▶" : "⏸", I18N.t(on ? "SubEnabled" : "SubDisabled"));
  addLog(`[BearNest] ${on ? "▶" : "⏸"} ${sub.name || sub.url}`);
}

// Удалить подписку вместе с её серверами.
function deleteSub(id) {
  const sub = subs.find((s) => s.id === id);
  if (!sub) return;
  subs = subs.filter((s) => s.id !== id);
  if (selectedSubId === id) {
    selectedSubId = null; selectedName = null; selectedIndex = -1;
    $("selectedServer").textContent = "";
    setSetting("last_server", "");
    updateSubPanelFor(null);
  }
  if (connectedSubId === id) { connectedSubId = null; connectedName = null; }
  persistSubs();
  renderServers();
  showToast("🗑", I18N.t("SubDeleted"));
  addLog(`[BearNest] 🗑 ${sub.name || sub.url}`);
}

// Восстановить выбор сервера из настроек (новый формат "subId::name",
// старый — просто имя сервера).
async function restoreSelection() {
  const last = await getSetting("last_server");
  let sid = null, name = last || "";
  if (name.includes("::")) { const p = name.split("::"); sid = p[0]; name = p.slice(1).join("::"); }
  let idx = -1;
  if (name) idx = servers.findIndex((s) => s.name === name && (!sid || s._subId === sid));
  if (idx < 0 && servers.length) idx = 0; // как раньше — первый сервер
  if (idx >= 0) selectServer(idx);
}

function subMetaText(sub) {
  const n = (sub.servers || []).length;
  let t = `${n} ${I18N.t("SubServers")}`;
  if (!subEnabled(sub)) t = `${I18N.t("SubOff")} • ${t}`;
  const info = sub.info;
  if (info && (info.upload || info.download)) {
    const used = (info.upload || 0) + (info.download || 0);
    const total = info.total > 0 ? formatBytes(info.total) : "∞";
    t += ` • ↑↓ ${formatBytes(used)} / ${total}`;
  }
  return t;
}

const SVG_CHEV = '<svg viewBox="0 0 24 24"><polyline points="9 18 15 12 9 6"/></svg>';
const SVG_POWER = '<svg viewBox="0 0 24 24"><path d="M18.36 6.64a9 9 0 1 1-12.73 0"/><line x1="12" y1="2" x2="12" y2="12"/></svg>';
const SVG_REFRESH = '<svg viewBox="0 0 24 24"><polyline points="23 4 23 10 17 10"/><polyline points="1 20 1 14 7 14"/><path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15"/></svg>';
const SVG_CLONE = '<svg viewBox="0 0 24 24"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>';
const SVG_TRASH = '<svg viewBox="0 0 24 24"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>';

function renderServers() {
  refreshFlat();
  const ul = $("serverList");
  ul.innerHTML = "";
  subs.forEach((sub) => {
    // ── Заголовок подписки (клик = свернуть/развернуть) ──
    const head = document.createElement("li");
    const on = subEnabled(sub);
    head.className = "sub-head" + (sub.collapsed ? " collapsed" : "") + (on ? "" : " disabled");
    head.innerHTML =
      `<span class="sub-chev">${SVG_CHEV}</span>` +
      `<span class="sub-name${sub._busy ? " busy" : ""}" title="${escapeHtml(sub.url)}">${escapeHtml(sub.name || hostFromUrl(sub.url) || sub.url)}</span>` +
      `<span class="sub-meta">${escapeHtml(subMetaText(sub))}</span>` +
      `<span class="sub-actions">` +
        `<button class="sub-btn${on ? " on" : ""}" data-act="toggle" data-tip="${I18N.t(on ? "TipSubDisable" : "TipSubEnable")}">${SVG_POWER}</button>` +
        `<button class="sub-btn" data-act="refresh" data-tip="${I18N.t("TipSubRefresh")}">${SVG_REFRESH}</button>` +
        `<button class="sub-btn" data-act="clone" data-tip="${I18N.t("TipSubClone")}">${SVG_CLONE}</button>` +
        `<button class="sub-btn danger" data-act="delete" data-tip="${I18N.t("TipSubDelete")}">${SVG_TRASH}</button>` +
      `</span>`;
    head.addEventListener("click", (e) => {
      const actBtn = e.target.closest("[data-act]");
      if (actBtn) {
        e.stopPropagation();
        if (actBtn.dataset.act === "toggle") toggleSub(sub.id);
        else if (actBtn.dataset.act === "refresh") refreshSub(sub.id);
        else if (actBtn.dataset.act === "clone") cloneSub(sub.id);
        else if (actBtn.dataset.act === "delete") deleteSub(sub.id);
        return;
      }
      sub.collapsed = !sub.collapsed;
      persistSubs();
      renderServers();
    });
    ul.appendChild(head);

    if (sub.collapsed) return;
    // ── Серверы подписки ──
    sortedServers(sub).forEach((s) => {
      const i = servers.indexOf(s);
      const isSel = s._subId === selectedSubId && s.name === selectedName;
      const isConn = connectedName && s.name === connectedName && s._subId === connectedSubId;
      const li = document.createElement("li");
      li.className = "server-item sub-server-item" + (on ? "" : " disabled") + (isSel ? " selected" : "") + (isConn ? " connected" : "");
      const parts = serverParts(s.name || s.address);
      li.innerHTML =
        `<span class="s-name"><span class="s-dot"></span>${parts.flag}${escapeHtml(parts.rest)}</span>` +
        `<span class="s-proto">${escapeHtml(s.protocol)}</span>` +
        `<span class="s-ping">${pingDisplay(s.pingMs)}</span>`;
      li.addEventListener("click", () => {
        if (!on) { showToast("⏸", I18N.t("SubDisabled")); return; }
        selectServer(i);
      });
      ul.appendChild(li);
    });
  });
}
function selectServer(i) {
  if (i < 0 || i >= servers.length) return;
  selectedIndex = i;
  const s = servers[i];
  selectedName = s.name;
  selectedSubId = s._subId;
  const sub = subs.find((x) => x.id === selectedSubId);
  const subName = sub ? (sub.name || hostFromUrl(sub.url)) : "";
  $("selectedServer").textContent = `${subName ? subName + " • " : ""}${serverLabel(s.name)} | ${s.protocol} | ${s.address}:${s.port}`;
  setSetting("last_server", `${selectedSubId}::${selectedName}`);
  updateSubPanelFor(sub || null);
  renderServers();
}
function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

// ── ПОСТРОЕНИЕ SplitTunnelSettings (порт BuildSplitTunnelSettings) ────────────
async function buildSplit() {
  const domains = $("bypassDomains").value.split("\n").map((x) => x.trim()).filter(Boolean);
  const ips = $("bypassIPs").value.split("\n").map((x) => x.trim()).filter(Boolean);
  const tun = $("chkTun").checked;
  let physical = "";
  if (tun) {
    try { physical = await invoke("get_physical_interface"); } catch (e) {}
  }
  return {
    bypassDomains: domains,
    bypassIps: ips,
    bypassLan: $("chkBypassLan").checked,
    tunMode: tun,
    physicalInterface: physical,
  };
}

// ── ДЕЙСТВИЯ ──────────────────────────────────────────────────────────────────
// Кнопка Load рядом с URL: если такой URL уже есть — обновляем эту подписку,
// иначе создаём НОВУЮ. Так поле ввода работает как «добавить подписку».
async function doLoad() {
  const url = $("subUrl").value.trim();
  if (!url) return;
  addLog("[BearNest] " + I18N.t("Loading"));
  $("btnLoad").disabled = true;
  try {
    let sub = subs.find((s) => s.url === url);
    const isNew = !sub;
    if (!sub) {
      sub = { id: newSubId(), name: "", url, collapsed: false, enabled: true, info: null, servers: [] };
      subs.push(sub);
    }
    const ok = await fetchSub(sub);
    if (ok) {
      showToast("✅", I18N.t(isNew ? "SubAdded" : "SubUpdated"));
      if (isNew) $("subUrl").value = "";
      persistSubs();
      refreshFlat();
      renderServers();
      restoreSelection();
    } else if (isNew) {
      // не удалось загрузить — убираем свежедобавленную пустую подписку
      subs = subs.filter((s) => s.id !== sub.id);
      persistSubs();
      renderServers();
    }
  } finally {
    $("btnLoad").disabled = false;
  }
}

async function doConnect() {
  if (selectedIndex < 0) { showToast("ℹ️", I18N.t("SelectServer")); return; }
  await connectTo(servers[selectedIndex]);
}

// Подключение к КОНКРЕТНОМУ серверу. Вынесено из doConnect(), чтобы
// переиспользовать при переподключении по смене режима TUN. buildSplit()
// читает живое состояние chkTun, поэтому новый режим применяется сам.
async function connectTo(server) {
  const split = await buildSplit();
  addLog(`[BearNest] ${I18N.t("Connecting")} ${server.name}`);
  $("btnConnect").disabled = true;
  try {
    await invoke("connect", { server, split });
    connectedName = server.name; // отметить активный сервер 🟢
    connectedSubId = server._subId || null;
    renderServers();
    // Нативный тост «подключено» — заодно это гарантирует, что BearNest
    // появится в «Параметры → Система → Уведомления» (Windows добавляет
    // приложение в список после первого реального уведомления).
    notifyWindows(I18N.t("NotifConnectedTitle"), server.name);
  } catch (e) {
    addLog("[BearNest] ❌ " + e);
    $("btnConnect").disabled = false;
  }
}

async function doDisconnect() {
  $("btnDisconnect").disabled = true;
  try { await invoke("disconnect"); } catch (e) { addLog("[BearNest] ❌ " + e); }
  stopTimer();
  $("tunStatus").textContent = "";
  connectedName = null;
  connectedSubId = null;
  renderServers();
}

// Переподключение со сменой режима TUN (вкл/выкл галки при активном соединении).
// Полностью гасим текущее соединение и поднимаем заново на ТОТ ЖЕ сервер
// (connectedName, а не selectedIndex — он мог уехать). Новый режим подхватится
// автоматически, т.к. buildSplit() внутри connectTo() читает живую галку chkTun.
let tunToggling = false;
async function reconnectApplyingTun() {
  let srv = connectedName ? servers.find((s) => s.name === connectedName) : null;
  if (!srv && selectedIndex >= 0) srv = servers[selectedIndex];
  if (!srv) return;
  showToast("🔄", I18N.t("TunReconnecting"));
  await doDisconnect();   // полный снос: гасит TUN/прокси и ядро (важен порядок)
  await sleep(600);       // дать маршрутам и TUN-адаптеру корректно сняться
  await connectTo(srv);   // поднимаем заново — split уже с новым состоянием chkTun
}

// Ручное переключение (кнопка Switch): мягкий рестарт xray ИМЕННО на выбранный
// сервер. Никаких "следующих по списку" — переключаемся на то, что выбрал юзер.
async function doSwitch() {
  if (selectedIndex < 0) { showToast("ℹ️", I18N.t("SelectServer")); return; }
  const server = servers[selectedIndex];
  $("btnSwitch").disabled = true;
  const split = await buildSplit();
  addLog(`[BearNest] ⇄ ${server.name}`);
  try {
    await invoke("switch_server", { server, split });
    connectedName = server.name; // 🟢 активный сервер = выбранный
    connectedSubId = server._subId || null;
    renderServers();
  } catch (e) {
    addLog("[BearNest] ❌ " + e);
  }
  $("btnSwitch").disabled = false;
}

// Авто-переключение при сбое связи: ТЕКУЩИЙ сервер мёртв, поэтому осознанно
// ищем СЛЕДУЮЩИЙ живой (начинаем со следующего за выбранным, step = 1).
async function autoSwitchToWorking() {
  if (servers.length < 2) return;
  const split = await buildSplit();
  const prevName = connectedName;
  for (let step = 1; step <= servers.length; step++) {
    const idx = (selectedIndex + step) % servers.length;
    const cand = servers[idx];
    const ms = await invoke("ping_server", { address: cand.address, port: cand.port });
    if (ms >= 0) {
      await invoke("switch_server", { server: cand, split });
      connectedName = cand.name; // 🟢 переезжаем на новый рабочий сервер
      connectedSubId = cand._subId || null;
      selectServer(idx);
      // Нативное уведомление Windows: «был сбой → сервер сменился сам»
      notifyWindows(
        I18N.t("NotifSwitchTitle"),
        (prevName ? prevName + " → " : "") + cand.name
      );
      return;
    }
  }
  // Живых серверов не нашлось — тоже сообщаем нативным уведомлением
  notifyWindows(I18N.t("NotifFailTitle"), I18N.t("NotifNoAlive"));
}

async function doPing() {
  if (servers.length === 0) return;
  $("btnPing").disabled = true;
  addLog(`[BearNest] ${I18N.t("Pinging")} ${servers.length}`);
  try {
    const pairs = servers.map((s) => [s.address, s.port]);
    const results = await invoke("ping_all", { servers: pairs });
    results.forEach((ms, i) => { servers[i].pingMs = ms >= 0 ? ms : -2; });
    persistSubs(); // закэшировать пинги вместе с подписками
    applySort();
  } catch (e) { addLog("[BearNest] ❌ " + e); }
  $("btnPing").disabled = false;
}

// ════════════════════════════════════════════════════════════════════════════
//  ДИАГНОСТИКА СОЕДИНЕНИЯ (self-test через локальный SOCKS)
//  Пинг говорит только «дошёл ли TCP до порта». А тут мы реально гоняем
//  трафик через туннель (Rust-команда proxy_selftest) и получаем КОНКРЕТНУЮ
//  причину: ядро не запущено / таймаут / TLS / DNS / сервер отклонил. Тост
//  показывает причину, а не абстрактный «низкий пинг».
// ════════════════════════════════════════════════════════════════════════════
let healthHandle = null;   // setInterval периодического мониторинга
let healthFails = 0;       // счётчик подряд идущих неудач
let healthBusy = false;    // защита от наложения проверок
let autoSwitchOnFail = false; // авто-переключение при сбое (настройка)
const HEALTH_INTERVAL_MS = 25000; // как часто проверять, пока подключены

// категория причины → {иконка, ключ i18n}
const SELFTEST_MAP = {
  ok:         { icon: "\u2705", key: "NetOk" },        // ✅
  proxy_down: { icon: "\u274c", key: "NetProxyDown" }, // ❌
  timeout:    { icon: "\u23f1\ufe0f", key: "NetTimeout" }, // ⏱️
  tls:        { icon: "\ud83d\udd12", key: "NetTls" },     // 🔒
  dns:        { icon: "\ud83c\udf10", key: "NetDns" },     // 🌐
  upstream:   { icon: "\ud83d\udeab", key: "NetUpstream" },// 🚫
  unknown:    { icon: "\u26a0\ufe0f", key: "NetUnknown" }, // ⚠️
};

async function runSelfTest() {
  try { return await invoke("proxy_selftest"); }
  catch (e) { return { ok: false, category: "unknown", detail: String(e), latencyMs: -1 }; }
}

function selfTestToast(res) {
  const m = SELFTEST_MAP[res.category] || SELFTEST_MAP.unknown;
  let msg = I18N.t(m.key);
  if (res.ok && res.latencyMs >= 0) msg += ` (${res.latencyMs} ms)`;
  showToast(m.icon, msg);
}

// Разовая проверка сразу после подключения (даём ядру ~1.5 с подняться).
async function checkAfterConnect() {
  await sleep(1500);
  if (!connected) return;
  const res = await runSelfTest();
  selfTestToast(res);
  if (!res.ok) addLog("[BearNest] \u274c self-test: " + res.category + " \u2014 " + (res.detail || ""));
}

// Периодический мониторинг живости туннеля, пока подключены.
function startHealthMonitor() {
  stopHealthMonitor();
  healthFails = 0;
  healthHandle = setInterval(healthTick, HEALTH_INTERVAL_MS);
}
function stopHealthMonitor() {
  if (healthHandle) { clearInterval(healthHandle); healthHandle = null; }
  healthFails = 0;
  healthBusy = false;
}
async function healthTick() {
  if (!connected || healthBusy) return;
  healthBusy = true;
  try {
    const res = await runSelfTest();
    if (res.ok) {
      if (healthFails > 0) { healthFails = 0; selfTestToast(res); } // восстановилось
      return;
    }
    healthFails++;
    addLog("[BearNest] \u274c self-test #" + healthFails + ": " + res.category + " \u2014 " + (res.detail || ""));
    if (healthFails === 1) {
      selfTestToast(res); // при первом сбое — сразу причину
      // Нативное уведомление Windows: сервер «отвалился» на стороне провайдера
      const m = SELFTEST_MAP[res.category] || SELFTEST_MAP.unknown;
      notifyWindows(
        I18N.t("NotifFailTitle"),
        (connectedName ? connectedName + " — " : "") + I18N.t(m.key)
      );
    }

    // Авто-переключение (если включено) после 2-й неудачи подряд.
    if (healthFails >= 2 && autoSwitchOnFail && servers.length >= 2) {
      healthFails = 0;
      showToast("\ud83d\udd04", I18N.t("NetSwitching")); // 🔄
      try {
        await autoSwitchToWorking();
        await sleep(1500);
        if (connected) selfTestToast(await runSelfTest());
      } catch (_) {}
    }
  } finally {
    healthBusy = false;
  }
}

// ── ПАНЕЛЬ ПОДПИСКИ ───────────────────────────────────────────────────────────
function formatBytes(b) {
  if (!b || b <= 0) return "0 B";
  const u = ["B", "KB", "MB", "GB", "TB"];
  let i = 0, v = b;
  while (v >= 1024 && i < u.length - 1) { v /= 1024; i++; }
  return `${v.toFixed(i ? 1 : 0)} ${u[i]}`;
}
function updateSubPanelFor(sub) {
  const info = sub && sub.info;
  if (!sub) { $("subPanel").hidden = true; return; }
  if (!info || (!info.title && !info.expireUnix)) {
    // info нет (подписка без заголовков) — показываем хотя бы имя и число серверов
    $("subPanel").hidden = false;
    $("subTitle").textContent = sub.name || hostFromUrl(sub.url) || "VPN";
    $("subTraffic").textContent = `${(sub.servers || []).length} ${I18N.t("SubServers")}`;
    $("subExpire").textContent = "—";
    return;
  }
  $("subPanel").hidden = false;
  $("subTitle").textContent = sub.name || info.title || "VPN";
  const used = (info.upload || 0) + (info.download || 0);
  const total = info.total > 0 ? formatBytes(info.total) : "∞";
  $("subTraffic").textContent = `↑↓ ${formatBytes(used)} / ${total}`;
  if (info.expireUnix > 0) {
    const d = new Date(info.expireUnix * 1000);
    const days = Math.max(0, Math.floor((d - Date.now()) / 86400000));
    $("subExpire").textContent = `до ${d.toLocaleDateString()} (${days} дн.)`;
  } else {
    $("subExpire").textContent = "—";
  }
}

// ── СОБЫТИЯ БЭКЕНДА ───────────────────────────────────────────────────────────
async function wireEvents() {
  listen("log", (e) => addLog(e.payload, true));
  await listen("status", (e) => {
    const on = e.payload === true;
    setConnectedUI(on);
    if (on) {
      if (!connectTime) startTimer();
      startHealthMonitor();   // периодическая диагностика состояния жизни
      checkAfterConnect();    // разовая проверка сразу после подключения
    } else {
      stopTimer();
      stopHealthMonitor();
      connectedName = null;
      connectedSubId = null;
      renderServers();
    }
  });
  await listen("tun-status", (e) => {
    const txt = e.payload || "";
    $("tunStatus").textContent = txt;
    // connect() НЕ бросает ошибку, если TUN не поднялся — он молча откатывается
    // на системный прокси и шлёт этот маркер. Синхронизируем галку, чтобы UI не
    // показывал «TUN», когда по факту работает обычный прокси.
    if (txt.includes("прокси")) {
      const cb = $("chkTun");
      if (cb && cb.checked) {
        cb.checked = false;
        setSetting("tun_mode", "false");
        showToast("⚠️", I18N.t("TunReconnectFailed"));
      }
    }
  });
  await listen("toast", (e) => {
    const p = e.payload || {};
    showToast(p.icon || "✅", p.message || "");
  });
  await listen("tray-connect", () => { if (!connected) doConnect(); });
  await listen("tray-disconnect", () => { if (connected) doDisconnect(); });
}

// ── ВКЛАДКИ ───────────────────────────────────────────────────────────────────
function wireTabs() {
  document.querySelectorAll(".tab").forEach((tab) => {
    tab.addEventListener("click", () => {
      document.querySelectorAll(".tab").forEach((t) => t.classList.remove("active"));
      document.querySelectorAll(".panel").forEach((p) => p.classList.remove("active"));
      tab.classList.add("active");
      document.querySelector(`.panel[data-panel="${tab.dataset.tab}"]`).classList.add("active");
    });
  });
}

// ════════════════════════════════════════════════════════════════════════════
//  ТЕМЫ: пресеты + пользовательские (свои) темы
//  Источник правды — здесь (главное окно). Редактор — ОТДЕЛЬНОЕ окно "editor",
//  которое присылает события: editor-ready / editor-preview / editor-scroll /
//  editor-save / editor-reset / editor-cancel / editor-delete. Главное окно
//  применяет цвета к себе на лету и пишет темы в SQLite (custom_themes).
// ════════════════════════════════════════════════════════════════════════════
const THEME_ALL_VARS = [
  "--bg", "--bg-2", "--card", "--card-2", "--text", "--text-dim", "--border",
  "--accent", "--accent-2", "--green", "--red", "--yellow", "--orange", "--mauve", "--shadow", "--btn-text",
];

let customThemes = {}; // name -> {"--var": val}
let activeTheme = "dark"; // "dark" | "custom:<name>"
let editorBackup = "dark"; // тема на момент открытия редактора (для Отмена/Сброс)

// состояние скролла (контролы теперь в окне редактора; тут только применяем)
let scrollSize = "8", scrollMode = "neutral", scrollCustom = "#89b4fa";

function cssVar(v) {
  return getComputedStyle(document.documentElement).getPropertyValue(v).trim();
}
function normHex(c) {
  c = (c || "").trim();
  return /^#([0-9a-fA-F]{6})$/.test(c) ? c.toLowerCase() : "#000000";
}

async function loadCustomThemes() {
  try {
    const raw = await getSetting("custom_themes");
    customThemes = raw ? JSON.parse(raw) : {};
  } catch (e) { customThemes = {}; }
  Themes.setCustom(customThemes);
}
async function persistCustomThemes() {
  await setSetting("custom_themes", JSON.stringify(customThemes));
  Themes.setCustom(customThemes);
}
function rebuildThemeSelect() {
  const sel = $("themeSelect");
  const presets = [["dark", "🌙 Dark"], ["light", "☀️ Light"], ["nord", "🏔️ Nord"], ["bear", "🐻 Bear"]];
  sel.innerHTML = "";
  presets.forEach(([val, label]) => {
    const o = document.createElement("option");
    o.value = val; o.textContent = label; sel.appendChild(o);
  });
  Object.keys(customThemes).forEach((name) => {
    const o = document.createElement("option");
    o.value = "custom:" + name; o.textContent = "🎨 " + name; sel.appendChild(o);
  });
  sel.value = activeTheme;
}
function applyTheme(name) {
  Themes.apply(name);
  activeTheme = name;
  const sel = $("themeSelect");
  if (sel) sel.value = name;
  updateDelThemeBtn();
}
function updateDelThemeBtn() {
  const b = $("btnDelTheme");
  if (b) b.hidden = !String(activeTheme).startsWith("custom:");
}
async function deleteActiveTheme() {
  if (!String(activeTheme).startsWith("custom:")) return;
  const name = activeTheme.slice(7);
  delete customThemes[name];
  await persistCustomThemes();
  await setSetting("theme", "dark");
  applyTheme("dark");
  rebuildThemeSelect();
  showToast("🗑", I18N.t("Saved"));
}

// ── Скролл ─────────────────────────────────────────────────────────────────
function applyScroll(size, mode, custom) {
  const root = document.documentElement;
  root.style.setProperty("--sb-size", (size || "8") + "px");
  if (mode === "accent") root.style.setProperty("--sb-thumb", "var(--accent)");
  else if (mode === "custom") root.style.setProperty("--sb-thumb", normHex(custom));
  else root.style.removeProperty("--sb-thumb");
}

// ── Мост к окну редактора ──────────────────────────────────────────────────
function currentVarsSnapshot() {
  const o = {};
  THEME_ALL_VARS.forEach((v) => (o[v] = cssVar(v)));
  return o;
}
function sendEditorSnapshot() {
  T.event.emit("editor-load", {
    vars: currentVarsSnapshot(),
    dataTheme: document.documentElement.getAttribute("data-theme") || "dark",
    lang: I18N.lang,
    isCustom: String(activeTheme).startsWith("custom:"),
    name: String(activeTheme).startsWith("custom:") ? activeTheme.slice(7) : "",
    scroll: { size: scrollSize, mode: scrollMode, custom: scrollCustom },
  });
}
async function openEditorWindow() {
  editorBackup = activeTheme; // для отката по Отмена/Сброс
  const WW = T.webviewWindow && T.webviewWindow.WebviewWindow;
  if (!WW) { showToast("❌", "WebviewWindow API"); return; }
  const ed = await WW.getByLabel("editor");
  if (!ed) { showToast("❌", "editor window missing"); return; }
  await ed.show();
  await ed.setFocus();
  sendEditorSnapshot();
}
async function saveThemeFromEditor(name) {
  if (!name) return;
  const vars = currentVarsSnapshot(); // уже с учётом живого предпросмотра
  customThemes[name] = vars;
  await persistCustomThemes();
  await setSetting("theme", "custom:" + name);
  rebuildThemeSelect();
  applyTheme("custom:" + name);
  editorBackup = activeTheme;
  showToast("🎨", I18N.t("Saved"));
  T.event.emit("editor-done");
}
async function deleteCurrentThemeFromEditor() {
  if (String(activeTheme).startsWith("custom:")) {
    const name = activeTheme.slice(7);
    delete customThemes[name];
    await persistCustomThemes();
    await setSetting("theme", "dark");
    applyTheme("dark");
    rebuildThemeSelect();
    showToast("🗑", I18N.t("Saved"));
  }
  T.event.emit("editor-done");
}
async function wireEditorBridge() {
  // окно редактора загрузилось и просит данные
  await listen("editor-ready", () => sendEditorSnapshot());
  // живой предпросмотр цвета
  await listen("editor-preview", (e) => {
    const { v, val } = e.payload || {};
    if (v) document.documentElement.style.setProperty(v, val);
  });
  // изменение скролла
  await listen("editor-scroll", (e) => {
    const s = e.payload || {};
    scrollSize = s.size; scrollMode = s.mode; scrollCustom = s.custom;
    applyScroll(s.size, s.mode, s.custom);
    setSetting("sb_size", s.size);
    setSetting("sb_color_mode", s.mode);
    setSetting("sb_color_custom", s.custom);
  });
  await listen("editor-save", (e) => saveThemeFromEditor((e.payload || {}).name));
  await listen("editor-reset", () => { applyTheme(editorBackup); applyScroll(scrollSize, scrollMode, scrollCustom); sendEditorSnapshot(); });
  await listen("editor-cancel", () => { applyTheme(editorBackup); });
  await listen("editor-delete", () => deleteCurrentThemeFromEditor());
}

// ════════════════════════════════════════════════════════════════════════════
//  ЭКСПОРТ / ИМПОРТ  (портируемость настроек клиента и тем)
//  Файловый ввод/вывод — на стороне Rust (portability.rs): нативный «Проводник»
//  открывает диалог «Сохранить как / Открыть», а сериализацию/десериализацию
//  JSON делаем здесь. Настройки читаются/пишутся через уже готовые команды
//  get_setting / set_setting (источник правды — SQLite).
// ════════════════════════════════════════════════════════════════════════════

// Полный список ключей настроек клиента (совпадает с тем, что пишет init()).
const SETTINGS_KEYS = [
  "sub_url",
  "subscriptions",
  "split_domains",
  "split_ips",
  "split_bypass_lan",
  "tun_mode",
  "auto_connect",
  "auto_switch_fail",
  "theme",
  "lang",
  "sb_size",
  "sb_color_mode",
  "sb_color_custom",
  "custom_themes",
];

// Безопасное имя файла из произвольной строки (для темы с именем на любом языке).
function safeFileName(s) {
  return String(s || "").trim().replace(/[^\w.\-]+/g, "_").replace(/^_+|_+$/g, "") || "theme";
}

// ── ЭКСПОРТ НАСТРОЕК КЛИЕНТА ─────────────────────────────────────────────────
// Собираем снимок всех ключей и отдаём Rust'у на запись в выбранный файл.
async function exportSettings() {
  try {
    const settings = {};
    for (const k of SETTINGS_KEYS) {
      const v = await getSetting(k);
      settings[k] = (v === undefined) ? null : v;
    }
    const payload = {
      app: "BearNest",
      kind: "settings",
      version: "2.10.0",
      exportedAt: new Date().toISOString(),
      settings,
    };
    const saved = await invoke("export_to_file", {
      defaultName: "bearnest-settings.json",
      contents: JSON.stringify(payload, null, 2),
    });
    if (saved) showToast("\ud83d\udcbe", I18N.t("ExportOk")); // 💾
  } catch (e) {
    addLog("[BearNest] \u274c export settings: " + e);
    showToast("\u274c", I18N.t("ImportBad"));
  }
}

// ── ИМПОРТ НАСТРОЕК КЛИЕНТА ──────────────────────────────────────────────────
// Читаем файл через Rust, пишем известные ключи в SQLite и обновляем UI.
async function importSettings() {
  try {
    const raw = await invoke("import_from_file");
    if (!raw) return; // отмена
    let payload;
    try { payload = JSON.parse(raw); }
    catch (_) { showToast("\u274c", I18N.t("ImportBad")); return; }

    // Допускаем и «обёрнутый» формат {settings:{...}}, и «плоский» {...}.
    const data = (payload && typeof payload.settings === "object") ? payload.settings : payload;
    if (!data || typeof data !== "object") { showToast("\u274c", I18N.t("ImportBad")); return; }

    let wrote = 0;
    for (const k of SETTINGS_KEYS) {
      if (data[k] !== undefined && data[k] !== null) {
        await setSetting(k, String(data[k]));
        wrote++;
      }
    }
    if (!wrote) { showToast("\u274c", I18N.t("ImportBad")); return; }

    await applyImportedSettingsToUI();
    showToast("\u2705", I18N.t("ImportOk"));
  } catch (e) {
    addLog("[BearNest] \u274c import settings: " + e);
    showToast("\u274c", I18N.t("ImportBad"));
  }
}

// Перечитать настройки из хранилища и применить к UI (мини-версия init()).
async function applyImportedSettingsToUI() {
  I18N.apply((await getSetting("lang")) || "ru");
  await loadCustomThemes();
  activeTheme = (await getSetting("theme")) || "dark";
  rebuildThemeSelect();
  applyTheme(activeTheme);

  $("subUrl").value = "";
  await loadSubs();
  refreshFlat();
  renderServers();
  restoreSelection();
  $("bypassDomains").value = (await getSetting("split_domains")) || "";
  $("bypassIPs").value = (await getSetting("split_ips")) || "";
  $("chkBypassLan").checked = ((await getSetting("split_bypass_lan")) ?? "1") === "1";
  $("chkTun").checked = (await getSetting("tun_mode")) === "true";
  $("chkAutoConnect").checked = (await getSetting("auto_connect")) === "1";
  autoSwitchOnFail = (await getSetting("auto_switch_fail")) === "1";
  $("chkAutoSwitchFail").checked = autoSwitchOnFail;

  scrollSize = (await getSetting("sb_size")) || "8";
  scrollMode = (await getSetting("sb_color_mode")) || "neutral";
  scrollCustom = normHex((await getSetting("sb_color_custom")) || "#89b4fa");
  applyScroll(scrollSize, scrollMode, scrollCustom);

  setPauseLabel(logPaused);
  setConnectedUI(connected);
  renderServers();
}

// ── ЭКСПОРТ ТЕМЫ ─────────────────────────────────────────────────────────────
// Своя тема → её сохранённые переменные. Пресет → фактические цвета «как есть»
// (снимок вычисленных CSS-переменных) — так пресет тоже можно унести файлом.
async function exportTheme() {
  try {
    let name, vars;
    if (String(activeTheme).startsWith("custom:")) {
      name = activeTheme.slice(7);
      vars = customThemes[name] || currentVarsSnapshot();
    } else {
      name = activeTheme; // dark/light/nord/bear
      vars = currentVarsSnapshot();
    }
    const payload = {
      app: "BearNest",
      kind: "theme",
      version: "2.10.0",
      name,
      vars,
    };
    const saved = await invoke("export_to_file", {
      defaultName: "bearnest-theme-" + safeFileName(name) + ".json",
      contents: JSON.stringify(payload, null, 2),
    });
    if (saved) showToast("\ud83c\udfa8", I18N.t("ExportOk")); // 🎨
  } catch (e) {
    addLog("[BearNest] \u274c export theme: " + e);
    showToast("\u274c", I18N.t("ImportBad"));
  }
}

// ── ИМПОРТ ТЕМЫ ──────────────────────────────────────────────────────────────
// Кладём тему в память приложения (SQLite custom_themes), делаем её активной.
async function importTheme() {
  try {
    const raw = await invoke("import_from_file");
    if (!raw) return; // отмена
    let payload;
    try { payload = JSON.parse(raw); }
    catch (_) { showToast("\u274c", I18N.t("ImportBad")); return; }

    // Поддерживаем форматы: {name, vars:{...}} | «сырой» map {"--bg":...} |
    // словарь тем {"Имя": {"--bg":...}} (берём первую).
    let name = payload && payload.name;
    let vars = payload && payload.vars;

    if (!vars && payload && typeof payload === "object") {
      const keys = Object.keys(payload);
      if (keys.some((k) => k.startsWith("--"))) {
        vars = payload; // плоский map переменных
      } else {
        // возможно словарь тем name -> vars
        const first = keys.find((k) => payload[k] && typeof payload[k] === "object");
        if (first) { name = name || first; vars = payload[first]; }
      }
    }
    if (!vars || typeof vars !== "object") { showToast("\u274c", I18N.t("ImportBad")); return; }

    // Оставляем только известные переменные темы.
    const clean = {};
    THEME_ALL_VARS.forEach((v) => { if (vars[v]) clean[v] = vars[v]; });
    if (!Object.keys(clean).length) { showToast("\u274c", I18N.t("ImportBad")); return; }

    if (!name) name = "Imported " + new Date().toLocaleTimeString();

    // Не затираем существующую тему молча — при коллизии добавляем «(2)», «(3)»…
    let finalName = String(name), i = 2;
    while (customThemes[finalName]) finalName = name + " (" + (i++) + ")";

    customThemes[finalName] = clean;
    await persistCustomThemes();
    await setSetting("theme", "custom:" + finalName);
    rebuildThemeSelect();
    applyTheme("custom:" + finalName);
    showToast("\u2705", I18N.t("ImportOk"));
  } catch (e) {
    addLog("[BearNest] \u274c import theme: " + e);
    showToast("\u274c", I18N.t("ImportBad"));
  }
}

//  ── Создаем отдельную функцию (вставляем в конец файла )
function initGlobalTooltips() {
  const tooltip = document.createElement('div');
  tooltip.className = 'global-tooltip';
  document.body.appendChild(tooltip);

  document.addEventListener('mouseover', (e) => {
    const target = e.target.closest('[data-tip]');
    if (!target) return;
    tooltip.textContent = target.getAttribute('data-tip');
    tooltip.classList.add('visible');
  });

  document.addEventListener('mousemove', (e) => {
    if (!tooltip.classList.contains('visible')) return;
    let x = e.clientX + 12;
    let y = e.clientY - 30;
    const tooltipWidth = tooltip.offsetWidth;
    if (x + tooltipWidth > window.innerWidth) x = e.clientX - tooltipWidth - 12;
    if (y < 0) y = e.clientY + 20;
    tooltip.style.left = `${x}px`;
    tooltip.style.top = `${y}px`;
  });

  document.addEventListener('mouseout', (e) => {
    const target = e.target.closest('[data-tip]');
    if (target) tooltip.classList.remove('visible');
  });
  
}

// ── ИНИЦИАЛИЗАЦИЯ ─────────────────────────────────────────────────────────────

async function init() {
  try {
    // 1) DOM-обработчики (без IPC) — вешаем сразу, с защитой от отсутствующих элементов
    on("btnMin", "click", () => appWindow.minimize());
    on("btnClose", "click", () => appWindow.close());
    on("btnLoad", "click", doLoad);
    on("btnConnect", "click", doConnect);
    on("btnDisconnect", "click", doDisconnect);
    on("btnSwitch", "click", doSwitch);
    on("btnOpenLogs", "click", () => invoke("open_logs_dir").catch((e) => addLog("[BearNest] ❌ open logs: " + e)));
    on("btnPing", "click", doPing);
    on("btnClearLog", "click", () => ($("logBox").innerHTML = ""));
    on("btnPauseLog", "click", togglePause);
    on("logFilter", "change", (e) => (logFilter = e.target.value));
    on("btnAddDomain", "click", () => {
      const v = $("quickDomain").value.trim();
      if (!v) return;
      const ta = $("bypassDomains");
      ta.value = (ta.value ? ta.value + "\n" : "") + v;
      $("quickDomain").value = "";
    });
    on("btnSaveBypass", "click", async () => {
      await setSetting("split_domains", $("bypassDomains").value);
      await setSetting("split_ips", $("bypassIPs").value);
      await setSetting("split_bypass_lan", $("chkBypassLan").checked ? "1" : "0");
      $("splitStatus").textContent = "\u2705 " + I18N.t("Saved");
      showToast("\ud83d\udcbe", I18N.t("Saved"));
      if (connected && selectedIndex >= 0) {
        const split = await buildSplit();
        await invoke("switch_server", { server: servers[selectedIndex], split });
      }
    });
    on("themeSelect", "change", (e) => { applyTheme(e.target.value); setSetting("theme", e.target.value); });
    on("langSelect", "change", (e) => { I18N.apply(e.target.value); setSetting("lang", e.target.value); setPauseLabel(logPaused); setConnectedUI(connected); renderServers(); });
    on("chkTun", "change", async (e) => {
      const wantTun = e.target.checked;
      await setSetting("tun_mode", wantTun ? "true" : "false");
      if (!connected) return;      // не подключены → применится при следующем connect
      if (tunToggling) return;     // цикл переподключения уже идёт — игнор
      tunToggling = true;
      e.target.disabled = true;
      try {
        await reconnectApplyingTun();
      } catch (err) {
        addLog("[BearNest] ❌ " + err);
        showToast("⚠️", I18N.t("TunReconnectFailed"));
      } finally {
        e.target.disabled = false;
        tunToggling = false;
      }
    });
    on("chkAutoConnect", "change", (e) => setSetting("auto_connect", e.target.checked ? "1" : "0"));
    on("chkAutoSwitchFail", "change", (e) => { autoSwitchOnFail = e.target.checked; setSetting("auto_switch_fail", e.target.checked ? "1" : "0"); });
    // клик по статус-плашке (когда подключены) — ручная проверка соединения
    on("statusPill", "click", async () => { if (!connected) return; selfTestToast(await runSelfTest()); });
    on("btnThemeEdit", "click", openEditorWindow);
    on("btnDelTheme", "click", deleteActiveTheme);
    // экспорт/импорт тем (рядом со списком тем) и настроек клиента
    on("btnExportTheme", "click", exportTheme);
    on("btnImportTheme", "click", importTheme);
    on("btnExportSettings", "click", exportSettings);
    on("btnImportSettings", "click", importSettings);
    document.querySelectorAll(".server-head .col").forEach((col) => {
      col.addEventListener("click", () => {
        const f = col.dataset.sort;
        if (f === sortField) applySort(f, -sortDir);
        else applySort(f, 1);
      });
    });
    on("sortSelect", "change", (e) => applySort(e.target.value, sortDir));
    on("sortDirBtn", "click", () => applySort(sortField, -sortDir));
    wireTabs();

    // 2) Ждём готовности бэкенда (state + IPC), затем — всё, что использует invoke/listen
    await waitBackendReady();
    await wireEditorBridge();
    await wireEvents();
    await initNotifications(); // разрешение на нативные уведомления Windows

    // 3) Язык + темы + настройки (getSetting устойчив к сбоям)
    I18N.apply((await getSetting("lang")) || "ru");
    await loadCustomThemes();
    activeTheme = (await getSetting("theme")) || "dark";
    rebuildThemeSelect();
    applyTheme(activeTheme);

    // Приветственный тост ОДИН раз: Windows добавляет приложение в
    // «Параметры → Система → Уведомления» только после первого реального
    // уведомления — без этого юзеру негде включить/проверить тумблер.
    if ((await getSetting("notif_welcomed")) !== "1") {
      await setSetting("notif_welcomed", "1");
      notifyWindows("BearNest VPN", I18N.t("NotifWelcome"));
    }

    // Мультиподписка: читаем сохранённый список подписок (или мигрируем sub_url)
    $("subUrl").value = ""; // поле ввода теперь — добавление НОВОЙ подписки
    await loadSubs();
    refreshFlat();
    renderServers();
    restoreSelection();
    $("bypassDomains").value = (await getSetting("split_domains")) || "";
    $("bypassIPs").value = (await getSetting("split_ips")) || "";
    $("chkBypassLan").checked = ((await getSetting("split_bypass_lan")) ?? "1") === "1";
    $("chkTun").checked = (await getSetting("tun_mode")) === "true";
    $("chkAutoConnect").checked = (await getSetting("auto_connect")) === "1";
    autoSwitchOnFail = (await getSetting("auto_switch_fail")) === "1";
    $("chkAutoSwitchFail").checked = autoSwitchOnFail;

    setConnectedUI(false);

    scrollSize = (await getSetting("sb_size")) || "8";
    scrollMode = (await getSetting("sb_color_mode")) || "neutral";
    scrollCustom = normHex((await getSetting("sb_color_custom")) || "#89b4fa");
    applyScroll(scrollSize, scrollMode, scrollCustom);

    // Догружаем подписки без кэша серверов (например, только что мигрированную)
    const needFetch = subs.filter((s) => subEnabled(s) && !(s.servers || []).length);
    for (const sub of needFetch) await fetchSub(sub);
    if (needFetch.length) { refreshFlat(); renderServers(); restoreSelection(); }
  } catch (e) {
    try { addLog("[BearNest] init error: " + e); } catch (_) {}
    console.error("init error", e);
  }
   initGlobalTooltips();
}

window.addEventListener("DOMContentLoaded", init); 