const REFRESH_INTERVAL = 60000; // 60 seconds
const STALE_THRESHOLD = 30 * 60000; // 30 minutes
let currentAirportFilter = "";
let charts = new Map();

// ============================================================================
// Data Fetching
// ============================================================================

async function fetchJson(path, optional = false) {
  try {
    const basePath = window.location.pathname.split('/').slice(0, -1).join('/');
    const url = new URL(basePath + '/' + path, window.location.origin);
    url.searchParams.set("_t", Date.now());
    const res = await fetch(url.toString(), { cache: "no-store" });
    if (!res.ok) {
      if (optional) return null;
      throw new Error(`HTTP ${res.status}`);
    }
    return await res.json();
  } catch (err) {
    if (!optional) console.error(`Fetch error for ${path}:`, err);
    return null;
  }
}

// ============================================================================
// Metrics & Stats
// ============================================================================

function renderMetrics(summary) {
  const grid = document.getElementById("metricsGrid");
  if (!grid || !summary) return;

  const metrics = [
    {
      label: "Total Flights",
      value: summary.total_flights,
      color: "--accent-cyan",
    },
    {
      label: "Airborne",
      value: summary.airborne,
      color: "--accent-green",
    },
    {
      label: "On Ground",
      value: summary.on_ground,
      color: "--accent-orange",
    },
    {
      label: "Unique Aircraft",
      value: summary.unique_aircraft,
      color: "--accent-purple",
    },
    {
      label: "Airlines",
      value: summary.unique_airlines,
      color: "--accent-pink",
    },
    {
      label: "Airports",
      value: summary.unique_airports,
      color: "--accent-cyan",
    },
    {
      label: "Median Alt (m)",
      value: formatNumber(summary.altitude_median),
      color: "--accent-orange",
    },
    {
      label: "Median Spd (m/s)",
      value: formatNumber(summary.speed_median),
      color: "--accent-purple",
    },
  ];

  grid.innerHTML = metrics
    .map(
      (m) => `
    <div class="metric-card">
      <div class="metric-label">${m.label}</div>
      <div class="metric-value">${m.value}</div>
    </div>
  `
    )
    .join("");
}

function formatNumber(val) {
  if (val === null || val === undefined) return "--";
  if (typeof val === "number") {
    if (Number.isInteger(val)) return val.toLocaleString();
    return val.toFixed(1);
  }
  return String(val);
}

// ============================================================================
// Chart Building
// ============================================================================

function destroyCharts() {
  charts.forEach((chart) => {
    if (chart && typeof chart.destroy === "function") {
      chart.destroy();
    }
  });
  charts.clear();
}

function createChart(canvasId, type, labels, data, label, color, options = {}) {
  const canvas = document.getElementById(canvasId);
  if (!canvas) return null;

  const ctx = canvas.getContext("2d");
  const chart = new Chart(ctx, {
    type,
    data: {
      labels,
      datasets: [
        {
          label,
          data,
          borderColor: color,
          backgroundColor:
            type === "line"
              ? color.replace(/[^,]+(?=\))/, "0.1")
              : color + "40",
          fill: type === "line",
          tension: type === "line" ? 0.3 : 0,
          borderWidth: 2,
          pointRadius: 2,
          pointHoverRadius: 4,
          pointBackgroundColor: color,
        },
      ],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: {
        legend: { display: false },
        tooltip: {
          backgroundColor: "rgba(15, 23, 42, 0.95)",
          titleColor: "#f3f4f6",
          bodyColor: "#9ca3af",
          borderColor: "rgba(255, 255, 255, 0.1)",
          borderWidth: 1,
          padding: 10,
          displayColors: false,
        },
      },
      interaction: { mode: "index", intersect: false },
      scales: {
        x: {
          ticks: { color: "#6b7280", maxRotation: 0 },
          grid: { color: "rgba(255, 255, 255, 0.05)", drawBorder: false },
        },
        y: {
          ticks: { color: "#6b7280" },
          grid: { color: "rgba(255, 255, 255, 0.05)", drawBorder: false },
        },
      },
      ...options,
    },
  });

  charts.set(canvasId, chart);
  return chart;
}

// ============================================================================
// Table Rendering
// ============================================================================

function renderTable(elementId, rows, columns) {
  const el = document.getElementById(elementId);
  if (!el) return;

  if (!rows || !Array.isArray(rows) || rows.length === 0) {
    el.innerHTML = '<div class="hint">No data available</div>';
    return;
  }

  const header = columns.map((c) => `<th>${c.toUpperCase()}</th>`).join("");
  const body = rows
    .map(
      (r) =>
        `<tr>${columns.map((c) => `<td>${formatNumber(r[c])}</td>`).join("")}</tr>`
    )
    .join("");

  el.innerHTML = `<table><thead><tr>${header}</tr></thead><tbody>${body}</tbody></table>`;
}

// ============================================================================
// Data Processing
// ============================================================================

function computeTopN(rows, key, limit = 10) {
  const counts = new Map();
  for (const row of rows) {
    const val = String(row[key] || "unknown");
    counts.set(val, (counts.get(val) || 0) + 1);
  }
  return Array.from(counts.entries())
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit);
}

function computeBins(rows, key, binSize) {
  const bins = new Map();
  for (const row of rows) {
    const val = row[key];
    if (typeof val !== "number") continue;
    const bin = Math.floor(val / binSize) * binSize;
    bins.set(bin, (bins.get(bin) || 0) + 1);
  }
  return Array.from(bins.entries())
    .sort((a, b) => a[0] - b[0])
    .map(([bin, count]) => ({ bin, count }));
}

function computeHeadingBins(rows) {
  const bins = new Map();
  const directions = ["N", "NE", "E", "SE", "S", "SW", "W", "NW"];
  for (const row of rows) {
    const heading = row.heading;
    if (typeof heading !== "number") continue;
    // Normalize heading to 0-360
    const h = (heading % 360 + 360) % 360;
    // Bin into 45-degree sectors
    const idx = Math.round(h / 45) % 8;
    bins.set(directions[idx], (bins.get(directions[idx]) || 0) + 1);
  }
  return directions.map((d) => ({ direction: d, count: bins.get(d) || 0 }));
}

// ============================================================================
// Main Load Function
// ============================================================================

async function loadDashboard() {
  destroyCharts();

  const [latest, snapshot, minuteTraffic] = await Promise.all([
    fetchJson("./data/latest.json", true),
    fetchJson("./data/snapshot.json", true),
    fetchJson("./data/minute_traffic.json", true),
  ]);

  const summary =
    latest?.summary ||
    (snapshot && snapshot.length
      ? {
          total_flights: snapshot.length,
          unique_aircraft: new Set(snapshot.map((r) => r.icao24)).size,
          unique_airlines: new Set(snapshot.map((r) => r.airline)).size,
          unique_airports: new Set(snapshot.map((r) => r.airport)).size,
          airborne: snapshot.filter((r) => !r.on_ground).length,
          on_ground: snapshot.filter((r) => r.on_ground).length,
          altitude_median: computeMedian(
            snapshot.map((r) => r.altitude).filter((v) => typeof v === "number")
          ),
          speed_median: computeMedian(
            snapshot.map((r) => r.velocity).filter((v) => typeof v === "number")
          ),
          generated_at: new Date().toISOString(),
        }
      : null);

  const flights = latest?.flights || snapshot || [];
  const filtered = currentAirportFilter
    ? flights.filter(
        (f) =>
          (f.airport || "").toUpperCase() === currentAirportFilter.toUpperCase()
      )
    : flights;

  // Update timestamp
  const lastUpdatedEl = document.getElementById("lastUpdated");
  if (lastUpdatedEl && summary?.generated_at) {
    const date = new Date(summary.generated_at);
    lastUpdatedEl.textContent = date.toLocaleTimeString(
      [],
      { hour: "2-digit", minute: "2-digit", second: "2-digit" }
    );
  }

  // Render metrics
  renderMetrics(summary);

  // Build charts
  if (minuteTraffic && Array.isArray(minuteTraffic) && minuteTraffic.length > 0) {
    createChart(
      "minuteTraffic",
      "line",
      minuteTraffic.map((d) => new Date(d.minute).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })),
      minuteTraffic.map((d) => d.flights),
      "Flights",
      "rgb(6, 182, 212)"
    );
  }

  if (flights.length > 0) {
    const topAirports = computeTopN(flights, "airport", 12);
    createChart(
      "topAirports",
      "bar",
      topAirports.map((t) => t[0]),
      topAirports.map((t) => t[1]),
      "Flights",
      "rgb(249, 115, 22)"
    );

    const altBins = computeBins(filtered, "altitude", 1000);
    createChart(
      "altitudeBands",
      "bar",
      altBins.map((d) => `${d.bin}m`),
      altBins.map((d) => d.count),
      "Flights",
      "rgb(168, 85, 247)"
    );

    const speedBins = computeBins(filtered, "velocity", 50);
    createChart(
      "speedBands",
      "bar",
      speedBins.map((d) => `${d.bin}m/s`),
      speedBins.map((d) => d.count),
      "Flights",
      "rgb(236, 72, 153)"
    );

    const topAirlines = computeTopN(filtered, "airline", 12);
    createChart(
      "topAirlines",
      "bar",
      topAirlines.map((t) => t[0]),
      topAirlines.map((t) => t[1]),
      "Flights",
      "rgb(16, 185, 129)"
    );

    const headingBins = computeHeadingBins(filtered);
    createChart(
      "headingBins",
      "bar",
      headingBins.map((d) => d.direction),
      headingBins.map((d) => d.count),
      "Flights",
      "rgb(59, 130, 246)"
    );
  }

  // Render tables
  if (flights.length > 0) {
    const topAirports = computeTopN(flights, "airport", 15);
    renderTable(
      "airportTable",
      topAirports.map(([a, c]) => ({ airport: a, flights: c })),
      ["airport", "flights"]
    );

    const topAirlines = computeTopN(filtered, "airline", 15);
    renderTable(
      "airlineTable",
      topAirlines.map(([a, c]) => ({ airline: a, flights: c })),
      ["airline", "flights"]
    );

    const topCountries = computeTopN(flights, "origin_country", 15);
    renderTable(
      "countryTable",
      topCountries.map(([c, n]) => ({ country: c, flights: n })),
      ["country", "flights"]
    );
  }
}

function computeMedian(arr) {
  if (!arr || arr.length === 0) return null;
  const sorted = arr.slice().sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 !== 0
    ? sorted[mid]
    : (sorted[mid - 1] + sorted[mid]) / 2;
}

// ============================================================================
// Event Listeners & Initialization
// ============================================================================

document.getElementById("applyFilter").addEventListener("click", () => {
  currentAirportFilter = document
    .getElementById("airportFilter")
    .value.trim()
    .toUpperCase();
  loadDashboard();
});

document.getElementById("clearFilter").addEventListener("click", () => {
  currentAirportFilter = "";
  document.getElementById("airportFilter").value = "";
  loadDashboard();
});

document.getElementById("airportFilter").addEventListener("keypress", (e) => {
  if (e.key === "Enter") {
    document.getElementById("applyFilter").click();
  }
});

// Initial load and periodic refresh
loadDashboard();
setInterval(loadDashboard, REFRESH_INTERVAL);
