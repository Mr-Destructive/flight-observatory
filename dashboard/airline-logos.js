(() => {
  const MANIFEST_PATH = "./data/airline_logos.json";
  let manifestPromise = null;
  let manifest = null;

  function normalize(value) {
    return String(value || "")
      .normalize("NFKD")
      .replace(/[\u0300-\u036f]/g, "")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "");
  }

  async function load() {
    if (manifest) return manifest;
    if (!manifestPromise) {
      manifestPromise = fetch(`${MANIFEST_PATH}?t=${Date.now()}`, { cache: "no-store" })
        .then((res) => (res.ok ? res.json() : {}))
        .catch(() => ({}))
        .then((data) => {
          manifest = data || {};
          return manifest;
        });
    }
    return manifestPromise;
  }

  function get(airline) {
    if (!airline) return null;
    if (manifest) {
      const key = normalize(airline);
      return manifest.byKey?.[key] || manifest.byIata?.[key] || manifest.byIcao?.[key] || null;
    }
    return null;
  }

  function initials(airline) {
    const clean = String(airline || "").trim();
    if (!clean) return "NA";
    const words = clean.split(/\s+/).filter(Boolean);
    const source = words.length > 1 ? words : [clean];
    return source
      .slice(0, 2)
      .map((part) => part.replace(/[^A-Za-z0-9]/g, "")[0] || "")
      .join("")
      .toUpperCase()
      .slice(0, 3) || "NA";
  }

  function escapeHtml(value) {
    return String(value ?? "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;");
  }

  function render(airline, { compact = false } = {}) {
    const label = escapeHtml(airline || "Unknown");
    const entry = get(airline);
    if (entry?.logo) {
      return `
        <span class="airline-cell ${compact ? "airline-cell-compact" : ""}">
          <img class="airline-logo" src="${escapeHtml(entry.logo)}" alt="${label} logo" loading="lazy" decoding="async" />
          <span class="airline-name">${label}</span>
        </span>
      `;
    }
    return `
      <span class="airline-cell ${compact ? "airline-cell-compact" : ""}">
        <span class="airline-fallback">${escapeHtml(initials(airline))}</span>
        <span class="airline-name">${label}</span>
      </span>
    `;
  }

  window.AirlineLogos = { load, get, render, normalize };
})();
