// ============================================================================
//  editor.js — окно «Редактор темы» (label: "editor").
//  Тонкий UI: строит палитру из снимка, присланного главным окном, и шлёт
//  ему события. Источник правды и запись в SQLite — в главном окне (main.js).
//    editor-ready  → просим у главного снимок
//    editor-load   ← снимок {vars, dataTheme, lang, isCustom, scroll}
//    editor-preview→ {v, val}  живой предпросмотр
//    editor-scroll → {size, mode, custom}
//    editor-save   → {name}
//    editor-reset / editor-cancel / editor-delete
//    editor-done   ← закрыть окно
// ============================================================================

const T = window.__TAURI__;
const emit = T.event.emit;
const listen = T.event.listen;
const win = T.window.getCurrentWindow();
const $ = (id) => document.getElementById(id);

// Редактируемые переменные по группам (без --shadow: rgba, color-picker не умеет)
const EDIT_GROUPS = [
  { title: "GrpBg", vars: [
    ["--bg", "LblBg"], ["--bg-2", "LblBg2"], ["--card", "LblCard"], ["--card-2", "LblCard2"], ["--border", "LblBorder"],
  ]},
  { title: "GrpText", vars: [
    ["--text", "LblText"], ["--text-dim", "LblTextDim"], ["--btn-text", "LblBtnText"],
  ]},
  { title: "GrpAccent", vars: [
    ["--accent", "LblAccent"], ["--accent-2", "LblAccent2"], ["--mauve", "LblMauve"],
  ]},
  { title: "GrpStatus", vars: [
    ["--green", "LblGreen"], ["--red", "LblRed"], ["--yellow", "LblYellow"], ["--orange", "LblOrange"],
  ]},
];

let currentName = ""; // имя редактируемой темы (пусто = новая)

function normHex(c) {
  c = (c || "").trim();
  return /^#([0-9a-fA-F]{6})$/.test(c) ? c.toLowerCase() : "#000000";
}

// Применяем снимок из главного окна: свой вид редактора + палитра + скролл
function applySnapshot(snap) {
  const root = document.documentElement;
  // редактор выглядит в тех же цветах, что и приложение
  root.setAttribute("data-theme", snap.dataTheme || "dark");
  Object.keys(snap.vars || {}).forEach((v) => {
    if (snap.vars[v]) root.style.setProperty(v, snap.vars[v]);
  });
  // язык
  if (window.I18N) I18N.apply(snap.lang || "ru");
  // скролл
  const sc = snap.scroll || {};
  $("edSbSize").value = sc.size || "8";
  $("edSbColorMode").value = sc.mode || "neutral";
  $("edSbColorCustom").value = normHex(sc.custom || "#89b4fa");
  $("edSbColorCustom").hidden = (sc.mode || "neutral") !== "custom";
  applyScrollLocal(sc.size, sc.mode, sc.custom);
  // кнопка удаления — только для своей темы
  $("edDelete").hidden = !snap.isCustom;
  currentName = snap.name || ""; // имя для подстановки в диалог сохранения
  // строки цветов
  buildRows();
}

function cssVar(v) {
  return getComputedStyle(document.documentElement).getPropertyValue(v).trim();
}

function buildRows() {
  const box = $("edColorRows");
  box.innerHTML = "";
  EDIT_GROUPS.forEach((grp) => {
    const h = document.createElement("div");
    h.className = "grp-title";
    h.textContent = window.I18N ? I18N.t(grp.title) : grp.title;
    box.appendChild(h);

    grp.vars.forEach(([v, key]) => {
      const row = document.createElement("div");
      row.className = "color-row";

      const label = document.createElement("span");
      label.textContent = window.I18N ? I18N.t(key) : key;

      const hex = document.createElement("input");
      hex.type = "text";
      hex.className = "hex-inp";
      hex.spellcheck = false;

      const color = document.createElement("input");
      color.type = "color";
      color.className = "color-inp";

      const start = normHex(cssVar(v));
      color.value = start;
      hex.value = start;

      const preview = (val) => {
        document.documentElement.style.setProperty(v, val); // локально
        emit("editor-preview", { v, val }); // и в главное окно
      };
      color.addEventListener("input", () => { hex.value = color.value; preview(color.value); });
      hex.addEventListener("input", () => { const hh = normHex(hex.value); color.value = hh; preview(hh); });

      // ховер-превью
      const showPrev = (e) => {
        const box2 = $("edPreview");
        box2.style.background = color.value;
        box2.querySelector(".cp-hex").textContent = color.value;
        box2.hidden = false;
        box2.style.left = Math.min(e.clientX + 16, window.innerWidth - 90) + "px";
        box2.style.top = Math.max(e.clientY - 44, 8) + "px";
      };
      row.addEventListener("mouseenter", showPrev);
      row.addEventListener("mousemove", showPrev);
      row.addEventListener("mouseleave", () => { $("edPreview").hidden = true; });

      row.append(label, hex, color);
      box.appendChild(row);
    });
  });
}

// Локальное применение скролла к самому окну редактора (для консистентности)
function applyScrollLocal(size, mode, custom) {
  const root = document.documentElement;
  root.style.setProperty("--sb-size", (size || "8") + "px");
  if (mode === "accent") root.style.setProperty("--sb-thumb", "var(--accent)");
  else if (mode === "custom") root.style.setProperty("--sb-thumb", normHex(custom));
  else root.style.removeProperty("--sb-thumb");
}
function onScroll() {
  const size = $("edSbSize").value;
  const mode = $("edSbColorMode").value;
  const custom = $("edSbColorCustom").value;
  $("edSbColorCustom").hidden = mode !== "custom";
  applyScrollLocal(size, mode, custom);
  emit("editor-scroll", { size, mode, custom });
}

// Диалог названия темы (Promise<string|null>)
function askName(def) {
  return new Promise((resolve) => {
    const modal = $("edNameModal");
    const input = $("edNameInput");
    input.value = def || "";
    modal.hidden = false;
    setTimeout(() => { input.focus(); input.select(); }, 0);
    const ok = () => { cleanup(); resolve(input.value.trim() || null); };
    const cancel = () => { cleanup(); resolve(null); };
    const onKey = (e) => { if (e.key === "Enter") ok(); else if (e.key === "Escape") cancel(); };
    const onBg = (e) => { if (e.target.id === "edNameModal") cancel(); };
    function cleanup() {
      modal.hidden = true;
      $("edNameOk").removeEventListener("click", ok);
      $("edNameCancel").removeEventListener("click", cancel);
      input.removeEventListener("keydown", onKey);
      modal.removeEventListener("click", onBg);
    }
    $("edNameOk").addEventListener("click", ok);
    $("edNameCancel").addEventListener("click", cancel);
    input.addEventListener("keydown", onKey);
    modal.addEventListener("click", onBg);
  });
}

async function hideSelf() { await win.hide(); }

function wire() {
  $("edClose").addEventListener("click", () => { emit("editor-cancel"); hideSelf(); });
  $("edCancel").addEventListener("click", () => { emit("editor-cancel"); hideSelf(); });
  $("edReset").addEventListener("click", () => emit("editor-reset"));
  $("edDelete").addEventListener("click", () => emit("editor-delete"));
  $("edSave").addEventListener("click", async () => {
    const name = await askName(currentName);
    if (name) emit("editor-save", { name });
  });
  $("edSbSize").addEventListener("change", onScroll);
  $("edSbColorMode").addEventListener("change", onScroll);
  $("edSbColorCustom").addEventListener("input", onScroll);

  // главное окно отвечает снимком / просит закрыться
  listen("editor-load", (e) => applySnapshot(e.payload || {}));
  listen("editor-done", () => hideSelf());

  emit("editor-ready"); // сообщаем главному, что готовы принять снимок
}

window.addEventListener("DOMContentLoaded", wire);
