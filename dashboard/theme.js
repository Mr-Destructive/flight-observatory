(function () {
  const KEY = "theme";
  const IMAGE_SELECTORS = [
    "figure.chart-frame img",
    ".research-chart img",
    ".chart-card img",
  ].join(",");

  function readTheme() {
    return localStorage.getItem(KEY) === "light" ? "light" : "dark";
  }

  function syncMediaTheme(theme) {
    const isLight = theme === "light";
    const images = document.querySelectorAll(IMAGE_SELECTORS);
    images.forEach((img) => {
      if (img.dataset.themeLight && img.dataset.themeDark) {
        const nextSrc = isLight ? img.dataset.themeLight : img.dataset.themeDark;
        if (nextSrc && img.getAttribute("src") !== nextSrc) {
          img.setAttribute("src", nextSrc);
        }
      }

      const shouldInvert = img.dataset.themeAdjust !== "none";
      img.classList.toggle("theme-media-invert", isLight && shouldInvert);
    });
  }

  function titleFromFigure(img) {
    const raw = String(img?.dataset?.chartTitle || img?.alt || "").trim();
    if (!raw) return "Chart";
    return raw.replace(/\s+/g, " ");
  }

  function syncChartTitles() {
    const figures = document.querySelectorAll("figure.chart-frame, .research-chart");
    figures.forEach((figure) => {
      const img = figure.querySelector("img");
      if (!img) return;
      if (figure.querySelector(".chart-title")) return;
      const title = document.createElement("h3");
      title.className = "chart-title";
      title.textContent = titleFromFigure(img);
      figure.insertBefore(title, figure.firstChild);
    });
  }

  function applyTheme(theme) {
    const next = theme === "light" ? "light" : "dark";
    const isLight = next === "light";
    document.body.classList.toggle("light-mode", isLight);
    document.documentElement.dataset.theme = next;
    document.documentElement.style.colorScheme = next;
    if (window.CHART_THEME?.applyTheme) {
      window.CHART_THEME.applyTheme(next);
    }
    syncMediaTheme(next);

    const icon = document.getElementById("theme-icon");
    const text = document.getElementById("theme-text");
    if (icon) icon.textContent = isLight ? "☀️" : "🌙";
    if (text) text.textContent = isLight ? "Light Mode" : "Dark Mode";
    syncChartTitles();

    window.dispatchEvent(
      new CustomEvent("themechange", {
        detail: { theme: next },
      })
    );
  }

  function toggleTheme() {
    const next = readTheme() === "light" ? "dark" : "light";
    localStorage.setItem(KEY, next);
    applyTheme(next);
  }

  function init() {
    applyTheme(readTheme());
    const buttons = document.querySelectorAll("[data-theme-toggle]");
    buttons.forEach((btn) => {
      if (btn.dataset.bound) return;
      btn.dataset.bound = "1";
      btn.addEventListener("click", () => {
        if (typeof window.toggleTheme === "function") {
          window.toggleTheme();
          return;
        }
        toggleTheme();
      });
    });
  }

  window.toggleTheme = window.toggleTheme || toggleTheme;
  window.applyTheme = window.applyTheme || applyTheme;
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init, { once: true });
  } else {
    init();
  }
})();
