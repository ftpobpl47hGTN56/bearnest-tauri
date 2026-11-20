// themes.js — применение темы.
//  • Пресет (dark/light/nord/bear) → выставляем data-theme на <html>.
//  • Своя тема ("custom:<name>") → выставляем все 15 переменных инлайново
//    (они перекрывают значения из [data-theme]).
//  Список своих тем передаётся из main.js через Themes.setCustom(map).
window.Themes = {
  PRESETS: ["dark", "light", "nord", "bear"],
  VARS: [
    "--bg", "--bg-2", "--card", "--card-2", "--text", "--text-dim", "--border",
    "--accent", "--accent-2", "--green", "--red", "--yellow", "--orange", "--mauve", "--shadow", "--btn-text",
  ],
  custom: {}, // name -> {"--var": val}

  setCustom(map) { this.custom = map || {}; },

  apply(name) {
    const root = document.documentElement;
    // сбрасываем инлайновые переменные темы (скролл --sb-* не трогаем)
    this.VARS.forEach((v) => root.style.removeProperty(v));

    if (name && name.indexOf("custom:") === 0) {
      const vars = this.custom[name.slice(7)];
      root.setAttribute("data-theme", "dark"); // база на случай отсутствующих переменных
      if (vars) {
        Object.keys(vars).forEach((v) => { if (vars[v]) root.style.setProperty(v, vars[v]); });
      }
    } else {
      const t = this.PRESETS.indexOf(name) >= 0 ? name : "dark";
      root.setAttribute("data-theme", t);
    }
  },
};
