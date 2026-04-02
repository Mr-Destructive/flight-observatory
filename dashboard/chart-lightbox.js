(function () {
  const TARGET_SELECTOR = [
    "figure.chart-frame",
    ".research-chart",
    ".chart-card",
    ".behavior-card"
  ].join(", ");

  let overlay = null;
  let activeSource = null;
  let activePlaceholder = null;
  let activeCanvasChart = null;

  function mediaLabel(el) {
    const explicit = String(el?.dataset?.chartTitle || "").trim();
    if (explicit) return explicit;
    const title = el?.closest("figure, .research-chart, .chart-card, .behavior-card")?.querySelector(".chart-title, h3");
    if (title?.textContent) return title.textContent.trim();
    if (el?.alt) return el.alt.trim();
    return "Chart";
  }

  function mediaCaption(el) {
    const figure = el?.closest("figure.chart-frame, .research-chart, .chart-card, .behavior-card");
    if (!figure) return "";
    const caption = figure.querySelector("figcaption, .chart-caption, p");
    return caption?.textContent?.trim() || "";
  }

  function ensureOverlay() {
    if (overlay) return overlay;

    overlay = document.createElement("div");
    overlay.className = "chart-lightbox";
    overlay.setAttribute("aria-hidden", "true");
    overlay.innerHTML = `
      <div class="chart-lightbox__backdrop" data-close="1"></div>
      <section class="chart-lightbox__panel" role="dialog" aria-modal="true" aria-label="Chart viewer">
        <div class="chart-lightbox__header">
          <div class="chart-lightbox__meta">
            <div class="chart-lightbox__kicker">Chart viewer</div>
            <div class="chart-lightbox__title" data-role="title">Chart</div>
            <div class="chart-lightbox__caption" data-role="caption"></div>
          </div>
          <div class="chart-lightbox__actions">
            <button class="chart-lightbox__button" type="button" data-action="download">Download</button>
            <button class="chart-lightbox__button" type="button" data-action="open">Open</button>
            <button class="chart-lightbox__button chart-lightbox__close" type="button" data-close="1" aria-label="Close chart viewer">✕</button>
          </div>
        </div>
        <div class="chart-lightbox__body" data-role="body"></div>
      </section>
    `;

    overlay.addEventListener("click", (event) => {
      const close = event.target.closest?.("[data-close='1']");
      if (close) {
        event.preventDefault();
        closeViewer();
        return;
      }
      const action = event.target.closest?.("[data-action]");
      if (!action) return;
      event.preventDefault();
      const role = action.getAttribute("data-action");
      if (role === "download") downloadActiveMedia();
      if (role === "open") openActiveMedia();
    });

    document.addEventListener("keydown", (event) => {
      if (event.key === "Escape" && overlay?.classList.contains("is-visible")) {
        closeViewer();
      }
    });

    document.body.appendChild(overlay);
    return overlay;
  }

  function getActiveBody() {
    return overlay?.querySelector("[data-role='body']");
  }

  function getTitleNode() {
    return overlay?.querySelector("[data-role='title']");
  }

  function getCaptionNode() {
    return overlay?.querySelector("[data-role='caption']");
  }

  function downloadHref(url, filename) {
    const link = document.createElement("a");
    link.href = url;
    link.download = filename;
    document.body.appendChild(link);
    link.click();
    link.remove();
  }

  function openActiveMedia() {
    if (!activeSource) return;
    if (activeSource.tagName === "IMG") {
      window.open(activeSource.currentSrc || activeSource.src, "_blank", "noopener,noreferrer");
      return;
    }
    if (activeSource.tagName === "CANVAS") {
      const chart = window.Chart?.getChart?.(activeSource);
      if (chart) {
        chart.resize();
        chart.update?.("none");
      }
    }
  }

  function downloadActiveMedia() {
    if (!activeSource) return;
    if (activeSource.tagName === "IMG") {
      const src = activeSource.currentSrc || activeSource.src;
      const ext = src.split("?")[0].split(".").pop() || "png";
      downloadHref(src, `${mediaLabel(activeSource).toLowerCase().replace(/[^a-z0-9]+/g, "-")}.${ext}`);
      return;
    }

    if (activeSource.tagName === "CANVAS") {
      const chart = window.Chart?.getChart?.(activeSource);
      if (chart) {
        chart.resize();
        chart.update?.("none");
      }
      const url = activeSource.toDataURL("image/png");
      downloadHref(url, `${mediaLabel(activeSource).toLowerCase().replace(/[^a-z0-9]+/g, "-")}.png`);
    }
  }

  function restoreActiveCanvas() {
    if (activeSource && activePlaceholder && activePlaceholder.parentNode) {
      activePlaceholder.replaceWith(activeSource);
      activePlaceholder = null;
      requestAnimationFrame(() => {
        const chart = window.Chart?.getChart?.(activeSource);
        if (chart) {
          chart.resize();
          chart.update?.("none");
        }
      });
    }
  }

  function closeViewer() {
    if (!overlay) return;
    restoreActiveCanvas();
    overlay.classList.remove("is-visible");
    overlay.setAttribute("aria-hidden", "true");
    getActiveBody().textContent = "";
    activeSource = null;
    activeCanvasChart = null;
  }

  function openViewer(source) {
    if (!source) return;
    const root = ensureOverlay();
    const body = getActiveBody();
    const title = getTitleNode();
    const caption = getCaptionNode();
    const isCanvas = source.tagName === "CANVAS";

    closeViewer();
    activeSource = source;
    activeCanvasChart = isCanvas ? window.Chart?.getChart?.(source) || null : null;

    title.textContent = mediaLabel(source);
    caption.textContent = mediaCaption(source);
    body.textContent = "";

    if (isCanvas) {
      const rect = source.getBoundingClientRect();
      activePlaceholder = document.createElement("div");
      activePlaceholder.className = "chart-lightbox__placeholder";
      activePlaceholder.style.minHeight = `${Math.max(rect.height, 260)}px`;
      source.parentNode?.replaceChild(activePlaceholder, source);

      const shell = document.createElement("div");
      shell.className = "chart-lightbox__canvas-shell";
      shell.appendChild(source);
      body.appendChild(shell);
      requestAnimationFrame(() => {
        const chart = window.Chart?.getChart?.(source) || activeCanvasChart;
        if (chart) {
          chart.resize();
          chart.update?.("none");
        }
      });
    } else {
      const clone = source.cloneNode(true);
      clone.classList.add("chart-lightbox__media");
      clone.removeAttribute("loading");
      body.appendChild(clone);
    }

    root.classList.add("is-visible");
    root.setAttribute("aria-hidden", "false");
  }

  function attachViewer(target) {
    if (!target || target.dataset.lightboxBound) return;
    const media = target.matches("figure.chart-frame, .research-chart, .chart-card, .behavior-card")
      ? target.querySelector("img, canvas")
      : null;
    if (!media) return;

    target.dataset.lightboxBound = "1";
    target.tabIndex = target.tabIndex >= 0 ? target.tabIndex : 0;
    target.setAttribute("role", "button");
    target.setAttribute("aria-label", `Open ${mediaLabel(media)}`);

    const open = () => openViewer(media);
    target.addEventListener("click", (event) => {
      if (event.target.closest?.("a, button, input, select, textarea")) return;
      open();
    });
    target.addEventListener("keydown", (event) => {
      if (event.key === "Enter" || event.key === " ") {
        event.preventDefault();
        open();
      }
    });
  }

  function scan() {
    document.querySelectorAll(TARGET_SELECTOR).forEach(attachViewer);
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", scan, { once: true });
  } else {
    scan();
  }

  window.addEventListener("themechange", () => {
    if (overlay?.classList.contains("is-visible") && activeSource?.tagName === "CANVAS") {
      requestAnimationFrame(() => {
        const chart = window.Chart?.getChart?.(activeSource) || activeCanvasChart;
        if (chart) {
          chart.resize();
          chart.update?.("none");
        }
      });
    }
  });
})();
