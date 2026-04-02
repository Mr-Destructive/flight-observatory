import { loadArchiveDbRaw, summarizeDb } from "./history-archive.mjs";

const charts = new Map();
const MAX_REALISTIC_SPEED = 300;
Chart.defaults.color = "#dce3f0";
Chart.defaults.font = {
  family: "Space Grotesk, Inter, system-ui, sans-serif",
  size: 11,
};
Chart.defaults.plugins.legend.labels.usePointStyle = true;

const sqlArchiveLoader = () =>
  initSqlJs({
    locateFile: (file) => `https://cdnjs.cloudflare.com/ajax/libs/sql.js/1.10.2/${file}`,
  });
const ASSET_ROOT = window.location.pathname.includes("/archive/") ? "/" : "./";
const ARCHIVE_BASE_DIR = window.location.pathname.includes("/archive/") ? "/archives" : "archives";
const archiveDbCache = new Map();
let historicalMap;
let historicalLayer;
let historicalAirportLayer;
let historicalTraceLayer;
let historicalClusterLayer;
let historicalTraceIndex = new Map();
let currentArchiveDb = null;
let historicalDensityVisible = true;
let historicalLastRows = [];
let historicalLastDay = null;
let historicalSelectedTraceKey = null;
let historicalSummary = null;
let historicalDetailed = null;
let historicalSky = null;
let historicalScopeLabel = "Full history";

function refreshHistoricalTheme() {
  if (!window.CHART_THEME?.applyTheme) return;
  window.CHART_THEME.applyTheme();
  if (!historicalSummary) return;
  renderHistoricalPage(historicalSummary, historicalDetailed, historicalSky, historicalScopeLabel);
  renderHistoricalMap(historicalLastRows, historicalLastDay);
}

window.addEventListener("themechange", refreshHistoricalTheme);

async function fetchJson(path) {
  try {
    const normalized = String(path).replace(/^\.\//, "");
    const res = await fetch(new URL(`${ASSET_ROOT}${normalized}`, window.location.origin).toString());
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json();
  } catch (err) {
    console.error(`Fetch error for ${path}:`, err);
    return null;
  }
}

async function fetchArchiveDaysFromListing() {
  try {
    const res = await fetch(new URL(`${ARCHIVE_BASE_DIR}/`, window.location.origin).toString());
    if (!res.ok) return [];
    const html = await res.text();
    const matches = Array.from(html.matchAll(/flights_(\d{4}-\d{2}-\d{2})\.sqlite\.gz/g)).map((m) => m[1]);
    if (!matches.length) return [];
    return Array.from(new Set(matches)).sort((a, b) => String(b).localeCompare(String(a)));
  } catch (err) {
    console.warn("Archive listing lookup failed:", err);
    return [];
  }
}

function createChart(canvasId, type, labels, data, color, yLabel = "", options = {}) {
  const canvas = document.getElementById(canvasId);
  if (!canvas) return null;
  const parent = canvas.parentElement;

  const existing = Chart.getChart(canvas) || charts.get(canvasId);
  if (existing) {
    existing.destroy();
    charts.delete(canvasId);
  }

  const hasData = data && data.length > 0 && data.some(v => v !== null && v !== undefined);
  
  if (!hasData) {
    if (parent) {
      canvas.style.display = 'none';
      let empty = parent.querySelector(".chart-empty");
      if (!empty) {
        empty = document.createElement("div");
        empty.className = "chart-empty";
        parent.appendChild(empty);
      }
      empty.textContent = "No data for this archive view.";
    }
    return null;
  }

  const ctx = canvas.getContext("2d");
  canvas.style.display = "";
  parent?.querySelector(".chart-empty")?.remove();

  // Create gradient if it's a line chart
  const background = type === 'line'
    ? CHART_THEME.getGradient(ctx, color)
    : CHART_THEME.withAlpha(color, 0.22);

  const chart = new Chart(ctx, {
    type,
    data: {
      labels,
      datasets: [{
        label: yLabel || "Value",
        data,
        ...CHART_THEME.applyDatasetDefaults(type, color),
        backgroundColor: background,
        spanGaps: true,
        ...options.dataset,
      }],
    },
    options: {
      ...CHART_THEME.defaults,
      ...options.chart,
      plugins: {
        ...CHART_THEME.defaults.plugins,
        ...(options.chart?.plugins || {}),
        tooltip: {
          ...CHART_THEME.defaults.plugins.tooltip,
          ...(options.chart?.plugins?.tooltip || {}),
        }
      },
      scales: {
        ...CHART_THEME.defaults.scales,
        ...(options.chart?.scales || {}),
        y: {
          ...CHART_THEME.defaults.scales.y,
          beginAtZero: type === "bar",
          ...(options.chart?.scales?.y || {}),
        }
      },
    },
  });

  charts.set(canvasId, chart);
  return chart;
}

function upsertChart(canvasId, type, labels, data, color, yLabel = "", options = {}) {
  const existing = charts.get(canvasId);
  if (existing) {
    existing.destroy();
    charts.delete(canvasId);
  }
  return createChart(canvasId, type, labels, data, color, yLabel, options);
}

function formatNumber(val) {
  if (val === null || val === undefined) return "--";
  if (typeof val === "number") {
    if (Number.isInteger(val)) return val.toLocaleString();
    return val.toFixed(1);
  }
  return String(val);
}

function escapeHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function isUnknownLabel(value) {
  const text = String(value ?? "").trim().toLowerCase();
  return !text || text === "unknown" || text === "unkonw" || text === "n/a" || text === "na" || text === "none";
}

function isRealisticSpeed(speed) {
  return Number.isFinite(speed) && speed >= 0 && speed <= MAX_REALISTIC_SPEED;
}

function cleanLabel(value, fallback = "--") {
  return isUnknownLabel(value) ? fallback : String(value);
}

async function getLatestArchiveDay() {
  const listedDays = await fetchArchiveDaysFromListing();
  if (listedDays.length) return listedDays[0];
  const manifest = await fetchJson("./data/archive_days.json");
  if (Array.isArray(manifest) && manifest.length) {
    const sorted = Array.from(new Set(manifest.filter(Boolean))).sort((a, b) => String(b).localeCompare(String(a)));
    return sorted[0];
  }
  const now = new Date();
  const yesterday = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - 1));
  return yesterday.toISOString().slice(0, 10);
}

function percentile(values, pct) {
  if (!Array.isArray(values) || !values.length) return null;
  const sorted = values.slice().sort((a, b) => a - b);
  const idx = (sorted.length - 1) * pct;
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  if (lo === hi) return sorted[lo];
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (idx - lo);
}

function normalizeSnapshotFlight(row) {
  if (!row) return null;
  return {
    timestamp: row.timestamp || row.observed_at || row.time || null,
    icao24: row.icao24 || row.icao || row.hex || "",
    callsign: row.callsign || "",
    airline: row.airline || "",
    origin_country: row.origin_country || row.country || "",
    lat: Number(row.lat),
    lon: Number(row.lon),
    altitude: Number(row.altitude ?? row.alt),
    on_ground: Boolean(row.on_ground),
    velocity: Number(row.velocity ?? row.speed),
    heading: Number(row.heading),
    airport: row.airport || row.nearest_airport || "unknown",
  };
}

function buildSnapshotFallback(source) {
  const flightsRaw = Array.isArray(source) ? source : Array.isArray(source?.flights) ? source.flights : [];
  const flights = flightsRaw.map(normalizeSnapshotFlight).filter((row) => row && Number.isFinite(row.lat) && Number.isFinite(row.lon));
  const totalRows = flights.length;
  const uniqueAircraft = new Set(flights.map((row) => row.icao24).filter(Boolean)).size;
  const onGround = flights.filter((row) => row.on_ground).length;
  const airborne = totalRows - onGround;
  const altitudes = flights.map((row) => row.altitude).filter((v) => Number.isFinite(v));
  const speeds = flights.map((row) => row.velocity).filter((v) => Number.isFinite(v));
  const hourlyMap = new Map();
  const weekdayMap = new Map();
  const altBands = new Map();
  const speedBands = new Map();
  const airlineMap = new Map();
  const airportMap = new Map();

  for (const row of flights) {
    const dt = row.timestamp ? new Date(row.timestamp) : null;
    if (dt && !Number.isNaN(dt.getTime())) {
      hourlyMap.set(dt.getUTCHours(), (hourlyMap.get(dt.getUTCHours()) || 0) + 1);
      weekdayMap.set(dt.getUTCDay(), (weekdayMap.get(dt.getUTCDay()) || 0) + 1);
    }
    const altBand = Number.isFinite(row.altitude) ? Math.floor(row.altitude / 1000) * 1000 : null;
    if (altBand !== null) altBands.set(altBand, (altBands.get(altBand) || 0) + 1);
    const speedBand = Number.isFinite(row.velocity) ? Math.floor(row.velocity / 50) * 50 : null;
    if (speedBand !== null) speedBands.set(speedBand, (speedBands.get(speedBand) || 0) + 1);
    if (row.airline && !isUnknownLabel(row.airline)) airlineMap.set(row.airline, (airlineMap.get(row.airline) || 0) + 1);
    if (row.airport && !isUnknownLabel(row.airport)) airportMap.set(row.airport, (airportMap.get(row.airport) || 0) + 1);
  }

  return {
    summary: {
      total_rows: totalRows,
      top_airlines: Array.from(airlineMap.entries()).map(([airline, count]) => ({ airline, count })).sort((a, b) => b.count - a.count),
      top_models: [],
      altitude_bins: Array.from(altBands.entries()).map(([band, count]) => ({ altitude_band: `${band}m`, count })).sort((a, b) => Number(a.altitude_band) - Number(b.altitude_band)),
      speed_bins: Array.from(speedBands.entries()).map(([band, count]) => ({ speed_band: `${band}m/s`, count })).sort((a, b) => Number(a.speed_band) - Number(b.speed_band)),
      metrics: {
        total_records: totalRows,
        unique_aircraft: uniqueAircraft,
        airborne,
        on_ground: onGround,
      },
    },
    detailed: {
      unique_aircraft: uniqueAircraft,
      hourly_distribution: Array.from(hourlyMap.entries()).sort((a, b) => a[0] - b[0]).map(([hour, count]) => ({ hour, count })),
      weekday_distribution: Array.from(weekdayMap.entries()).sort((a, b) => a[0] - b[0]).map(([dow, count]) => ({
        day: ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"][dow],
        count,
      })),
      altitude_stats: {
        median: percentile(altitudes, 0.5),
        p90: percentile(altitudes, 0.9),
        avg: altitudes.length ? altitudes.reduce((sum, value) => sum + value, 0) / altitudes.length : null,
      },
      speed_stats: {
        median: percentile(speeds, 0.5),
        p90: percentile(speeds, 0.9),
        max: speeds.length ? Math.max(...speeds) : null,
      },
      metrics: {
        total_records: totalRows,
        unique_aircraft: uniqueAircraft,
        airborne,
        on_ground: onGround,
      },
      ground_airborne: { airborne, on_ground: onGround },
    },
    sky: {
      busiest_corridors: [],
      speed_leaderboard: [],
    },
    rows: flights
      .map((row) => [row.icao24, row.callsign, row.airline, row.lat, row.lon, row.altitude, row.velocity, row.timestamp, row.airport])
      .filter((row) => Number.isFinite(Number(row[3])) && Number.isFinite(Number(row[4]))),
    airports: Array.from(airportMap.entries()).map(([airport, flights]) => ({ airport, flights })).sort((a, b) => b.flights - a.flights),
  };
}

function renderInsights(elementId, insights, summary, detailed) {
  const el = document.getElementById(elementId);
  if (!el) return;
  const scoped = (insights || []).filter((insight) => {
    const title = String(insight?.title || "").toLowerCase();
    const detail = String(insight?.detail || "").toLowerCase();
    const badSpeedStory = detail.includes("supersonic") || detail.includes("ft on average");
    return !title.includes("unknown") && !title.includes("unkonw") && !detail.includes("unknown") && !detail.includes("unkonw") && !badSpeedStory;
  });
  const finalInsights = scoped.length ? scoped : buildFallbackInsights(summary, detailed);
  el.innerHTML = finalInsights.map(insight => `
    <article class="insight-card">
      <div class="insight-content">
        <h4>${insight.title}</h4>
        <p>${insight.detail}</p>
      </div>
    </article>
  `).join('');
}

function buildFallbackInsights(summary, detailed) {
  const hourly = detailed?.hourly_distribution || [];
  const peak = hourly.reduce((best, h) => (h.count > (best?.count || 0) ? h : best), null);
  const topAirline = (summary?.top_airlines || []).find((row) => !isUnknownLabel(row?.airline)) || null;
  const topBand = (summary?.altitude_bins || []).reduce((best, b) => (best === null || b.count > best.count ? b : best), null);
  const totalRecords = summary?.total_rows || detailed?.metrics?.total_records;
  const uniqueAircraft = detailed?.unique_aircraft || detailed?.metrics?.unique_aircraft;
  const airborne = detailed?.metrics?.airborne ?? detailed?.ground_airborne?.airborne;
  const onGround = detailed?.metrics?.on_ground ?? detailed?.ground_airborne?.on_ground;
  const airborneShare = typeof airborne === "number" && typeof onGround === "number" && airborne + onGround > 0
    ? Math.round((airborne / (airborne + onGround)) * 100)
    : null;

  return [
    {
      icon: "",
      title: "Current view",
      detail: `You are looking at ${historicalScopeLabel}.`,
    },
    {
      icon: "✦",
      title: "Scale",
      detail: totalRecords && uniqueAircraft
        ? `${formatNumber(totalRecords)} records across ${formatNumber(uniqueAircraft)} aircraft.`
        : "This selection is too small to read confidently.",
    },
    {
      icon: "⏱",
      title: "Traffic rhythm",
      detail: peak
        ? `The busiest hour is ${String(peak.hour).padStart(2, "0")}:00.`
        : "The selected dataset is too sparse to call a clear peak hour.",
    },
    {
      icon: "✈",
      title: "Main carrier",
      detail: topAirline
        ? `${topAirline.airline} carries the largest share of the current selection.`
        : "No carrier clearly stands out in this selection.",
    },
    {
      icon: "↟",
      title: "Altitude shape",
      detail: topBand
        ? `The densest altitude band sits around ${topBand.altitude_band}.`
        : "Altitude data is too thin to summarize cleanly here.",
    },
    {
      icon: "",
      title: "Filters",
      detail: "No extra filter is applied on the historical page.",
    },
    {
      icon: "≈",
      title: "Airborne share",
      detail: airborneShare !== null
        ? `${airborneShare}% of the loaded rows are airborne.`
        : "Airborne share is unavailable for this selection.",
    },
  ];
}

function renderQuickStats(summary, detailed, sky) {
  const grid = document.getElementById("quickStats");
  if (!grid) return;

  const stats = [];
  
  if (detailed?.unique_aircraft) {
    stats.push({ label: "Unique Aircraft", value: formatNumber(detailed.unique_aircraft), color: "--accent-purple" });
  }
  if (detailed?.altitude_stats?.avg) {
    stats.push({ label: "Avg Altitude", value: Math.round(detailed.altitude_stats.avg) + "m", color: "--accent-orange" });
  }
  if (detailed?.speed_stats?.max) {
    if (isRealisticSpeed(detailed.speed_stats.max)) {
      stats.push({ label: "Max Speed", value: Math.round(detailed.speed_stats.max) + "m/s", color: "--accent-cyan" });
    } else if (sky?.speed_leaderboard?.some((item) => isRealisticSpeed(item.max_speed))) {
      const safe = sky.speed_leaderboard.find((item) => isRealisticSpeed(item.max_speed));
      stats.push({ label: "Max Speed", value: Math.round(safe.max_speed) + "m/s", color: "--accent-cyan" });
    }
  }
  if (sky?.busiest_corridors?.[0]) {
    stats.push({ label: "Busiest FL", value: Math.round(sky.busiest_corridors[0].altitude_band / 1000) + "km", color: "--accent-green" });
  }
  if (detailed?.ground_airborne) {
    const pct = Math.round(100 * detailed.ground_airborne.airborne / (detailed.ground_airborne.airborne + detailed.ground_airborne.on_ground));
    stats.push({ label: "Airborne %", value: pct + "%", color: "--accent-pink" });
  }
  if (detailed?.ghost_planes) {
    stats.push({ label: "Stationary Aircraft", value: formatNumber(detailed.ghost_planes.aircraft), color: "--accent-purple" });
  }

  grid.innerHTML = stats.map(s => `
    <div class="metric-card">
      <div class="metric-label">${s.label}</div>
      <div class="metric-value" style="color: var(${s.color})">${s.value}</div>
    </div>
  `).join('');
}

function renderDerivedStats(summary, detailed) {
  const grid = document.getElementById("derivedStats");
  if (!grid) return;

  const hourly = detailed?.hourly_distribution || [];
  const peak = hourly.reduce((best, h) => (h.count > (best?.count || 0) ? h : best), null);
  const trough = hourly.reduce((best, h) => (best === null || h.count < best.count ? h : best), null);
  const peakToTrough = peak && trough && trough.count > 0 ? (peak.count / trough.count) : null;

  const mean = hourly.length ? hourly.reduce((s, h) => s + h.count, 0) / hourly.length : null;
  const variance = hourly.length
    ? hourly.reduce((s, h) => s + Math.pow(h.count - mean, 2), 0) / hourly.length
    : null;
  const volatility = variance !== null ? Math.sqrt(variance) : null;

  const weekdays = detailed?.weekday_distribution || [];
  const weekend = weekdays.filter((d) => d.day === "Sat" || d.day === "Sun")
    .reduce((s, d) => s + d.count, 0);
  const weekdayTotal = weekdays.filter((d) => d.day !== "Sat" && d.day !== "Sun")
    .reduce((s, d) => s + d.count, 0);
  const weekendPenalty = weekdayTotal ? Math.round((weekend / weekdayTotal) * 100) : null;

  const altitudeBins = summary?.altitude_bins || [];
  const topBand = altitudeBins.reduce(
    (best, b) => (best === null || b.count > best.count ? b : best),
    null
  );
  const cruiseDominance = topBand && summary?.total_rows
    ? Math.round((topBand.count / summary.total_rows) * 100)
    : null;

  const heading = detailed?.heading_distribution || [];
  const maxHeading = heading.reduce((best, h) => (best === null || h.count > best ? h.count : best), null);
  const headingShare = maxHeading && summary?.total_rows
    ? Math.round((maxHeading / summary.total_rows) * 100)
    : null;

  const derived = [
    { label: "Peak/Trough Ratio", value: peakToTrough ? peakToTrough.toFixed(2) : "--" },
    { label: "Hourly Volatility", value: volatility ? Math.round(volatility).toLocaleString() : "--" },
    { label: "Weekend vs Weekday %", value: weekendPenalty !== null ? `${weekendPenalty}%` : "--" },
    { label: "Cruise Band Share", value: cruiseDominance !== null ? `${cruiseDominance}%` : "--" },
    { label: "Heading Dominance", value: headingShare !== null ? `${headingShare}%` : "--" },
  ];

  grid.innerHTML = derived.map(d => `
    <div class="metric-card">
      <div class="metric-label">${d.label}</div>
      <div class="metric-value">${d.value}</div>
    </div>
  `).join("");
}

function renderSpeedLeaderboard(leaderboard) {
  const el = document.getElementById("speedLeaderboard");
  if (!el || !leaderboard?.length) return;
  const safeLeaderboard = leaderboard.filter((item) => isRealisticSpeed(item.max_speed)).slice(0, 15);

  if (!safeLeaderboard.length) {
    el.innerHTML = '<div class="hint">No realistic speed records in this selection.</div>';
    return;
  }

  el.innerHTML = `
    <table class="leaderboard-table">
      <thead>
        <tr>
          <th>Rank</th>
          <th>ICAO24</th>
          <th>Max Speed</th>
          <th>Speed (knots)</th>
          <th>Avg Alt</th>
          <th>Region</th>
        </tr>
      </thead>
      <tbody>
        ${safeLeaderboard.map((item, i) => `
          <tr>
            <td class="rank">#${i + 1}</td>
            <td class="icao">${item.icao24?.toUpperCase() || '--'}</td>
            <td class="speed">${Math.round(item.max_speed)} m/s</td>
            <td class="knots">${Math.round(item.max_speed * 1.944)} kt</td>
            <td>${Math.round(item.avg_alt || 0)}m</td>
            <td>${item.region || '--'}</td>
          </tr>
        `).join('')}
      </tbody>
    </table>
  `;
}

function renderTable(elementId, rows, columns) {
  const el = document.getElementById(elementId);
  if (!el || !rows?.length) return;

  const header = columns.map(c => `<th>${c.toUpperCase()}</th>`).join("");
  const body = rows.map(r => 
    `<tr>${columns.map(c => {
      if (c === "airline" || c === "model" || c === "region") {
        const airline = cleanLabel(r[c], "Other");
        return `<td>${window.AirlineLogos?.render ? window.AirlineLogos.render(airline) : escapeHtml(airline)}</td>`;
      }
      return `<td>${escapeHtml(formatNumber(r[c]))}</td>`;
    }).join('')}</tr>`
  ).join("");

  el.innerHTML = `<table><thead><tr>${header}</tr></thead><tbody>${body}</tbody></table>`;
}

function renderGroundAirborne(data) {
  if (!data) return;
  const ctx = document.getElementById("groundAirborne");
  if (!ctx) return;
  const existing = charts.get("groundAirborne");
  if (existing) {
    existing.destroy();
    charts.delete("groundAirborne");
  }
  
  const chart = new Chart(ctx.getContext("2d"), {
    type: "doughnut",
    data: {
      labels: ["On Ground", "Airborne"],
      datasets: [{
        data: [data.on_ground || 0, data.airborne || 0],
        ...CHART_THEME.applyDatasetDefaults("doughnut"),
        backgroundColor: ["rgb(249, 115, 22)", "rgb(16, 185, 129)"],
      }],
    },
    options: {
      ...CHART_THEME.defaults,
      plugins: {
        ...CHART_THEME.defaults.plugins,
        legend: { display: true, position: "bottom", labels: { color: "#9ca3af", font: { family: "'Space Grotesk', sans-serif", size: 10 } } },
      },
      cutout: "70%",
    },
  });
  charts.set("groundAirborne", chart);
}

function renderHistoricalPage(summary, detailed, sky, scopeLabel = "Full history") {
  historicalSummary = summary;
  historicalDetailed = detailed;
  historicalSky = sky;
  historicalScopeLabel = scopeLabel;

  const description = document.getElementById("dataDescription");
  if (description) {
    description.textContent = scopeLabel === "Full history"
      ? "Deep dive into flight patterns and airspace insights."
      : `Viewing ${scopeLabel.toLowerCase()}.`;
  }
  if (summary?.total_rows) {
    document.getElementById("totalRows").textContent = summary.total_rows.toLocaleString();
  }
  document.getElementById("timeSpan").textContent = scopeLabel;
  if (detailed?.unique_aircraft || detailed?.metrics?.unique_aircraft) {
    document.getElementById("uniqueAircraft").textContent = formatNumber(
      detailed.unique_aircraft || detailed.metrics.unique_aircraft,
    );
  }
  const archiveLoadProgress = document.getElementById("archiveLoadProgress");
  if (archiveLoadProgress) {
    archiveLoadProgress.textContent = scopeLabel === "Full history"
      ? "Archive ready."
      : `${scopeLabel} loaded.`;
  }
  const archiveMapStats = document.getElementById("archiveMapStats");
  if (archiveMapStats) {
    archiveMapStats.textContent = `Rows ${formatNumber(summary?.total_rows)}, span ${scopeLabel.toLowerCase()}, aircraft ${formatNumber(detailed?.unique_aircraft || detailed?.metrics?.unique_aircraft)}.`;
  }
  const archiveFilterState = document.getElementById("archiveFilterState");
  if (archiveFilterState) {
    archiveFilterState.textContent = `Current view: ${scopeLabel}.`;
  }

  renderQuickStats(summary, detailed, sky);
  renderDerivedStats(summary, detailed);
  renderInsights("insightsContainer", detailed?.insights, summary, detailed);

  if (detailed?.hourly_distribution?.length) {
    upsertChart(
      "trafficWave",
      "line",
      detailed.hourly_distribution.map((d) => `${d.hour}:00`),
      detailed.hourly_distribution.map((d) => d.count),
      "rgb(6, 182, 212)",
      "Flights"
    );
  }
  if (summary?.altitude_bins?.length) {
    upsertChart(
      "altitudeDistribution",
      "bar",
      summary.altitude_bins.map((d) => d.altitude_band),
      summary.altitude_bins.map((d) => d.count),
      "rgb(168, 85, 247)",
      "Flights"
    );
  }
  if (summary?.speed_bins?.length) {
    upsertChart(
      "speedDistribution",
      "bar",
      summary.speed_bins.map((d) => d.speed_band),
      summary.speed_bins.map((d) => d.count),
      "rgb(236, 72, 153)",
      "Flights"
    );
  }
  if (detailed?.weekday_distribution?.length) {
    upsertChart(
      "weekdayPattern",
      "bar",
      detailed.weekday_distribution.map((d) => d.day),
      detailed.weekday_distribution.map((d) => d.count),
      "rgb(139, 92, 246)",
      "Flights"
    );
  }
  if (detailed?.metrics) {
    upsertChart(
      "dataQuality",
      "bar",
      ["Altitude", "Speed", "Track", "Position", "Time"],
      [
        detailed.metrics.data_completeness_altitude ?? 0,
        detailed.metrics.data_completeness_speed ?? 0,
        detailed.metrics.data_completeness_track ?? 0,
        detailed.metrics.data_completeness_position ?? 0,
        detailed.metrics.data_completeness_time ?? 0,
      ],
      "rgb(251, 146, 60)",
      "Completeness %"
    );
  }
  if (detailed?.heading_distribution?.length) {
    upsertChart(
      "headingDistribution",
      "bar",
      detailed.heading_distribution.map((d) => d.direction),
      detailed.heading_distribution.map((d) => d.count),
      "rgb(59, 130, 246)",
      "Flights"
    );
  }

  if (detailed?.ground_airborne || detailed?.metrics) {
    renderGroundAirborne(
      detailed.ground_airborne || {
        airborne: detailed.metrics?.airborne || 0,
        on_ground: detailed.metrics?.on_ground || 0,
      },
    );
  }

  if (sky?.speed_leaderboard?.length) {
    renderSpeedLeaderboard(sky.speed_leaderboard);
  } else {
    const leaderboard = document.getElementById("speedLeaderboard");
    if (leaderboard) leaderboard.innerHTML = '<div class="hint">No speed records for this selection.</div>';
  }

  const ghostAircraft = document.getElementById("ghostAircraft");
  const ghostSightings = document.getElementById("ghostSightings");
  if (detailed?.ghost_planes) {
    if (ghostAircraft) ghostAircraft.textContent = formatNumber(detailed.ghost_planes.aircraft);
    if (ghostSightings) ghostSightings.textContent = formatNumber(detailed.ghost_planes.sightings);
  } else {
    if (ghostAircraft) ghostAircraft.textContent = "--";
    if (ghostSightings) ghostSightings.textContent = "--";
  }

  if (summary?.top_airlines?.length) {
    renderTable("topAirlines", summary.top_airlines.slice(0, 15), ["airline", "flights"]);
  } else {
    const topAirlines = document.getElementById("topAirlines");
    if (topAirlines) topAirlines.innerHTML = '<div class="hint">No airline data for this selection.</div>';
  }

  if (summary?.top_models?.length) {
    renderTable("topModels", summary.top_models.slice(0, 15), ["model", "flights"]);
  } else {
    const topModels = document.getElementById("topModels");
    if (topModels) topModels.innerHTML = '<div class="hint">Aircraft model data is not available for this selection.</div>';
  }
}

function initHistoricalMap() {
  if (historicalMap || typeof L === "undefined") return;
  const mapEl = document.getElementById("historicalMap");
  if (!mapEl) return;
  historicalMap = L.map(mapEl, {
    zoomControl: true,
    attributionControl: false,
  }).setView([20, 0], 2);
  historicalMap.createPane("densityPane");
  historicalMap.getPane("densityPane").style.zIndex = 350;
  historicalMap.createPane("tracePane");
  historicalMap.getPane("tracePane").style.zIndex = 450;
  historicalMap.createPane("markerPane");
  historicalMap.getPane("markerPane").style.zIndex = 650;
  L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
    maxZoom: 12,
    minZoom: 2,
  }).addTo(historicalMap);
  historicalLayer = L.layerGroup().addTo(historicalMap);
  historicalAirportLayer = L.layerGroup().addTo(historicalMap);
  historicalTraceLayer = L.layerGroup().addTo(historicalMap);
  historicalClusterLayer = L.layerGroup().addTo(historicalMap);
  L.control.scale({ imperial: false }).addTo(historicalMap);
  historicalMap.on("click", () => {
    historicalSelectedTraceKey = null;
    historicalTraceLayer?.clearLayers();
  });
  const toggle = document.getElementById("historicalDensityToggle");
  toggle?.addEventListener("click", () => {
    historicalDensityVisible = !historicalDensityVisible;
    toggle.textContent = `Density: ${historicalDensityVisible ? "On" : "Off"}`;
    if (!historicalMap || !historicalClusterLayer) return;
    if (historicalDensityVisible) {
      historicalMap.addLayer(historicalClusterLayer);
      if (historicalLastRows.length && historicalLastDay) {
        renderHistoricalMap(historicalLastRows, historicalLastDay);
      }
    } else {
      historicalMap.removeLayer(historicalClusterLayer);
    }
  });
}

async function getArchiveDb(day) {
  if (archiveDbCache.has(day)) return archiveDbCache.get(day);
  const db = await loadArchiveDbRaw(day, {
    initSqlJs: sqlArchiveLoader,
    baseDir: ARCHIVE_BASE_DIR,
  });
  archiveDbCache.set(day, db);
  return db;
}

async function loadHistoricalArchive(day) {
  if (!day) return;
  const status = document.getElementById("historicalMapStatus");
  if (status) status.textContent = `Loading ${day}...`;
  historicalSelectedTraceKey = null;
  try {
    const db = await getArchiveDb(day);
    currentArchiveDb = db;
    const res = db.exec(`
      SELECT icao24, callsign, airline, lat, lon, altitude, velocity, observed_at, nearest_airport
      FROM flight_positions_archive
      WHERE lat IS NOT NULL AND lon IS NOT NULL
      ORDER BY icao24 ASC, observed_at ASC
      LIMIT 1200
    `);
    historicalLastRows = res?.[0]?.values || [];
    historicalLastDay = day;
    const selection = summarizeDb(db);
    const scopedSummary = {
      ...selection.summary,
      top_models: selection.summary?.top_models?.length
        ? selection.summary.top_models
        : historicalSummary?.top_models || [],
    };
    renderHistoricalPage(scopedSummary, selection.detailed, historicalSky || null, `Day archive - ${day}`);
    renderHistoricalMap(historicalLastRows, day);
  } catch (err) {
    console.warn("Archive load failed", err);
    await loadLatestSnapshotFallback(`Archive ${day} unavailable`);
  }
}

window.loadHistoricalArchive = loadHistoricalArchive;

async function loadLatestSnapshotFallback(message = "Showing the archived snapshot.") {
  const [latest, snapshot] = await Promise.all([
    fetchJson("./data/snapshot.json"),
    fetchJson("./data/latest.json"),
  ]);
  const source = snapshot || latest;
  const fallback = buildSnapshotFallback(source);
  historicalSummary = fallback.summary;
  historicalDetailed = fallback.detailed;
  historicalSky = fallback.sky;
  historicalLastRows = fallback.rows;
  historicalLastDay = "latest snapshot";
  currentArchiveDb = null;
  if (message) {
    const status = document.getElementById("historicalMapStatus");
    if (status) status.textContent = message;
  }
  renderHistoricalPage(historicalSummary, historicalDetailed, historicalSky, "Archived snapshot");
  renderHistoricalMap(historicalLastRows, "archived snapshot");
}

function renderHistoricalMap(rows, day) {
  initHistoricalMap();
  if (!historicalLayer) return;
  historicalLayer.clearLayers();
  historicalAirportLayer?.clearLayers();
  historicalTraceLayer?.clearLayers();
  historicalClusterLayer?.clearLayers();
  historicalTraceIndex = new Map();
  const bounds = [];
  const airportClusters = new Map();
  const markers = [];
  const trailsByFlight = new Map();

  rows.forEach((row, index) => {
    const [icao, callsign, airline, lat, lon, altitude, velocity, observed, airport] = row;
    const latNum = Number(lat);
    const lonNum = Number(lon);
    if (!Number.isFinite(latNum) || !Number.isFinite(lonNum)) return;
    const marker = L.circleMarker([latNum, lonNum], {
      radius: 7,
      fillColor: "#fb7185",
      color: "#ebffe2",
      weight: 2,
      opacity: 0.95,
      fillOpacity: 1,
      pane: "markerPane",
    });
    const label = [callsign, airline, icao].filter(Boolean).join(" | ");
    marker.bindPopup(
      `<strong>${label || icao || "Unknown"}</strong><br/>${new Date(observed).toLocaleString()}<br/>${Math.round(
        altitude || 0
      )}m - ${Math.round(velocity || 0)}m/s`
    );
    const trailKey = icao || callsign || `flight-${index}`;
    marker.on("click", () => highlightHistoricalTrace(trailKey));
    marker.addTo(historicalLayer);
    markers.push(marker);
    bounds.push([latNum, lonNum]);

    const trail = trailsByFlight.get(trailKey) || [];
    trail.push({
      lat: latNum,
      lon: lonNum,
      observed: observed ? Date.parse(observed) || index : index,
    });
    trailsByFlight.set(trailKey, trail);

    if (airport && !isUnknownLabel(airport)) {
      const cluster = airportClusters.get(airport) || { count: 0, latSum: 0, lonSum: 0 };
      cluster.count += 1;
      cluster.latSum += latNum;
      cluster.lonSum += lonNum;
      airportClusters.set(airport, cluster);
    }
  });

  if (historicalDensityVisible) {
    airportClusters.forEach((cluster, airport) => {
      const latAvg = cluster.latSum / cluster.count;
      const lonAvg = cluster.lonSum / cluster.count;
      addHeatBlob(historicalClusterLayer, latAvg, lonAvg, cluster.count, airport);
    });
  }
  if (historicalAirportLayer) {
    airportClusters.forEach((cluster, airport) => {
      const latAvg = cluster.latSum / cluster.count;
      const lonAvg = cluster.lonSum / cluster.count;
      addAirportMarker(historicalAirportLayer, latAvg, lonAvg, airport);
    });
  }

  trailsByFlight.forEach((trail, key) => {
    const points = trail
      .slice()
      .sort((a, b) => a.observed - b.observed)
      .map(({ lat, lon }) => [lat, lon]);
    historicalTraceIndex.set(key, points);
  });

  if (historicalSelectedTraceKey && historicalTraceIndex.has(historicalSelectedTraceKey)) {
    drawRoute(historicalTraceLayer, historicalTraceIndex.get(historicalSelectedTraceKey), "#fb7185");
  }

  markers.forEach((marker) => marker.bringToFront?.());

  if (bounds.length && historicalMap) {
    historicalMap.fitBounds(bounds, { padding: [60, 60], maxZoom: 7 });
  }
  const status = document.getElementById("historicalMapStatus");
  if (status) status.textContent = `Loaded ${rows.length} points - ${day}`;
  historicalLastRows = rows;
  historicalLastDay = day;
}

function highlightHistoricalTrace(key) {
  if (!key || !historicalTraceLayer) return;
  historicalSelectedTraceKey = key;
  historicalTraceLayer.clearLayers();
  const indexed = historicalTraceIndex.get(key);
  if (indexed?.length >= 2) {
    drawRoute(historicalTraceLayer, indexed, "#fb7185");
    return;
  }
  if (!currentArchiveDb) return;
  const res = currentArchiveDb.exec(
    "SELECT lat, lon FROM flight_positions_archive WHERE icao24 = ? AND lat IS NOT NULL AND lon IS NOT NULL ORDER BY observed_at ASC",
    [key]
  );
  const points = (res?.[0]?.values || [])
    .map(([lat, lon]) => [Number(lat), Number(lon)])
    .filter(([lat, lon]) => Number.isFinite(lat) && Number.isFinite(lon));
  if (points.length < 2) return;
  drawRoute(historicalTraceLayer, points, "#fb7185");
}

function drawRoute(layer, points, color) {
  if (!layer || !Array.isArray(points) || points.length < 2) return;
  const route = points
    .map((point) => [Number(point[0]), Number(point[1])])
    .filter(([lat, lon]) => Number.isFinite(lat) && Number.isFinite(lon));
  if (route.length < 2) return;
  L.polyline(route, {
    color: "rgba(8, 15, 24, 0.95)",
    weight: 6,
    opacity: 0.8,
    lineCap: "round",
    lineJoin: "round",
    smoothFactor: 1.25,
    pane: "tracePane",
  }).addTo(layer);
  L.polyline(route, {
    color,
    weight: 3,
    opacity: 0.95,
    lineCap: "round",
    lineJoin: "round",
    smoothFactor: 1.25,
    pane: "tracePane",
  }).addTo(layer);
  const start = route[0];
  const end = route[route.length - 1];
  L.circleMarker(start, {
    radius: 3.5,
    color: "#0d141d",
    fillColor: "#00e639",
    fillOpacity: 1,
    weight: 1,
    pane: "tracePane",
  }).addTo(layer);
  L.circleMarker(end, {
    radius: 3.5,
    color: "#0d141d",
    fillColor: "#fbbc00",
    fillOpacity: 1,
    weight: 1,
    pane: "tracePane",
  }).addTo(layer);
}

function addHeatBlob(layer, lat, lon, count, label, pane = "densityPane") {
  const base = Math.min(26000, Math.max(4000, count * 140));
  const rings = [
    { radius: base * 1.35, color: "rgba(239,68,68,0.12)", fill: "rgba(239,68,68,0.08)", opacity: 0.08, fillOpacity: 0.04 },
    { radius: base * 0.9, color: "rgba(251,113,133,0.24)", fill: "rgba(251,113,133,0.16)", opacity: 0.16, fillOpacity: 0.1 },
    { radius: base * 0.45, color: "rgba(255,255,255,0.26)", fill: "rgba(255,99,99,0.42)", opacity: 0.34, fillOpacity: 0.24 },
  ];
  rings.forEach((ring, idx) => {
    L.circle([lat, lon], {
      radius: ring.radius,
      weight: 1,
      color: ring.color,
      fillColor: ring.fill,
      fillOpacity: ring.fillOpacity,
      opacity: ring.opacity,
      pane,
      interactive: false,
      className: idx === 2 ? "density-heat-core" : "density-heat-ring",
    })
      .bindTooltip(`${label} | ${count} pts`, { direction: "top" })
      .addTo(layer);
  });
}

function addAirportMarker(layer, lat, lon, label) {
  if (!layer || !Number.isFinite(lat) || !Number.isFinite(lon)) return;
  L.circleMarker([lat, lon], {
    radius: 5,
    fillColor: "#ffffff",
    color: "#ef4444",
    weight: 2,
    opacity: 0.95,
    fillOpacity: 1,
    pane: "markerPane",
  })
    .bindTooltip(`${label}`, { direction: "top" })
    .addTo(layer);
}

function setupHistoricalMapControls() {
  const input = document.getElementById("historicalMapDate");
  const linkedInput = document.getElementById("sqliteDate");
  if (!input) return;
  getLatestArchiveDay().then((defaultDay) => {
    input.value = defaultDay;
    if (linkedInput) linkedInput.value = defaultDay;
    input.addEventListener("change", () => {
      if (linkedInput) linkedInput.value = input.value;
      if (typeof window.loadSqliteDay === "function" && input.value) {
        window.loadSqliteDay(input.value);
      }
      loadHistoricalArchive(input.value);
    });
    loadHistoricalArchive(input.value);
  });
}

async function loadHistoricalDashboard() {
  await window.AirlineLogos?.load?.();
  const archiveLoadProgress = document.getElementById("archiveLoadProgress");
  if (archiveLoadProgress) archiveLoadProgress.textContent = "Loading archive data...";
  const [monthly, summary, detailed, sky] = await Promise.all([
    fetchJson("./data/historical_monthly.json"),
    fetchJson("./data/historical_summary.json"),
    fetchJson("./data/historical_detailed.json"),
    fetchJson("./data/sky_analytics.json"),
  ]);

  if (!monthly || !summary) {
    console.warn("Missing historical data files");
    await loadLatestSnapshotFallback("Showing the archived snapshot.");
    return;
  }

  // Header info
  if (summary.total_rows) {
    document.getElementById("totalRows").textContent = summary.total_rows.toLocaleString();
  }
  if (summary.date_range?.length === 2) {
    const start = new Date(summary.date_range[0]);
    const end = new Date(summary.date_range[1]);
    const days = Math.ceil((end - start) / (1000 * 60 * 60 * 24));
    if (days <= 1) {
      document.getElementById("timeSpan").textContent = "1 day";
    } else if (days < 30) {
      document.getElementById("timeSpan").textContent = days + " days";
    } else if (days < 365) {
      document.getElementById("timeSpan").textContent = Math.ceil(days / 30) + " months";
    } else {
      document.getElementById("timeSpan").textContent = Math.ceil(days / 365) + " years";
    }
  }

  renderHistoricalPage(summary, detailed, sky, "Full history");

  // Stationary aircraft
  if (detailed?.ghost_planes) {
    document.getElementById("ghostAircraft").textContent = formatNumber(detailed.ghost_planes.aircraft);
    document.getElementById("ghostSightings").textContent = formatNumber(detailed.ghost_planes.sightings);
  }

  // Speed Leaderboard
  if (sky?.speed_leaderboard?.length) {
    renderSpeedLeaderboard(sky.speed_leaderboard);
  }

  // Sky Pulse Chart
  if (detailed?.hourly_pulse?.length) {
    createChart(
      "skyPulse", "bar",
      detailed.hourly_pulse.map(d => `${d.hour}:00`),
      detailed.hourly_pulse.map(d => d.pulse_index),
      "rgb(139, 92, 246)",
      "Pulse Index %"
    );
  }

  // Hourly traffic
  if (detailed?.hourly_distribution?.length) {
    createChart(
      "trafficWave", "line",
      detailed.hourly_distribution.map(d => `${d.hour}:00`),
      detailed.hourly_distribution.map(d => d.count),
      "rgb(6, 182, 212)",
      "Flights"
    );
  }

  // Altitude distribution
  if (sky?.altitude_tiers?.length) {
    createChart(
      "altitudeTiers", "doughnut",
      sky.altitude_tiers.map(d => d.tier),
      sky.altitude_tiers.map(d => d.flights),
      "rgb(249, 115, 22)",
      "Flights"
    );
  }

  // Flight Phases
  if (sky?.flight_phases?.length) {
    createChart(
      "flightPhases", "doughnut",
      sky.flight_phases.map(d => d.phase.replace('_', ' ')),
      sky.flight_phases.map(d => d.sightings),
      "rgb(16, 185, 129)",
      "Sightings"
    );
  }

  // Busiest Corridors
  if (sky?.busiest_corridors?.length) {
    createChart(
      "busiestCorridors", "bar",
      sky.busiest_corridors.map(d => `${d.altitude_band / 1000}km`),
      sky.busiest_corridors.map(d => d.flights),
      "rgb(168, 85, 247)",
      "Flights"
    );
  }

  // Efficiency Curve
  if (sky?.efficiency_curve?.length) {
    createChart(
      "efficiencyCurve", "line",
      sky.efficiency_curve.map(d => `${d.altitude / 1000}km`),
      sky.efficiency_curve.map(d => d.efficiency),
      "rgb(236, 72, 153)",
      "Efficiency"
    );
  }

  // In/Out Ratio
  if (detailed?.in_out_ratios?.length) {
    const arrivals = detailed.in_out_ratios.map(d => d.arrivals);
    const departures = detailed.in_out_ratios.map(d => d.departures);
    const labels = detailed.in_out_ratios.map(d => d.airport);
    
    const canvas = document.getElementById("inOutRatio");
    if (canvas) {
      new Chart(canvas.getContext("2d"), {
        type: "bar",
        data: {
          labels,
          datasets: [
            { 
              label: "Arrivals", 
              data: arrivals, 
              ...CHART_THEME.applyDatasetDefaults("bar", "rgb(16, 185, 129)")
            },
            { 
              label: "Departures", 
              data: departures, 
              ...CHART_THEME.applyDatasetDefaults("bar", "rgb(249, 115, 22)")
            },
          ],
        },
        options: {
          ...CHART_THEME.defaults,
          plugins: { 
            ...CHART_THEME.defaults.plugins,
            legend: { display: true, position: "bottom", labels: { color: "#9ca3af", font: { family: "'Space Grotesk', sans-serif", size: 10 } } } 
          },
        },
      });
    }
  }

  // Heading Distribution
  if (detailed?.heading_distribution?.length) {
    createChart(
      "headingDistribution", "bar",
      detailed.heading_distribution.map(d => d.direction),
      detailed.heading_distribution.map(d => d.count),
      "rgb(59, 130, 246)",
      "Flights"
    );
  }

  // Heading distribution stats
  if (sky?.directional_traffic?.length) {
    createChart(
      "directionalTraffic", "bar",
      sky.directional_traffic.map(d => d.direction),
      sky.directional_traffic.map(d => d.flights),
      "rgb(34, 197, 94)",
      "Flights"
    );
  }

  // Speed Tiers
  if (sky?.speed_tiers?.length) {
    createChart(
      "speedTiers", "bar",
      sky.speed_tiers.map(d => d.tier),
      sky.speed_tiers.map(d => d.flights),
      "rgb(251, 146, 60)",
      "Flights"
    );
  }

  // Wind Effect
  if (sky?.wind_effect?.length) {
    createChart(
      "windEffect", "bar",
      sky.wind_effect.map(d => d.route),
      sky.wind_effect.map(d => d.avg_speed),
      "rgb(6, 182, 212)",
      "Avg Speed (m/s)"
    );
  }

  // Holding Patterns
  if (sky?.holding_patterns?.length) {
    createChart(
      "holdingPatterns", "bar",
      sky.holding_patterns.map(d => d.airport),
      sky.holding_patterns.map(d => d.sightings),
      "rgb(236, 72, 153)",
      "Sightings"
    );
  }

  // Airline altitude mix
  if (sky?.airline_preferences?.length) {
    createChart(
      "airlinePreferences", "bar",
      sky.airline_preferences.map(d => d.airline.substring(0, 15)),
      sky.airline_preferences.map(d => d.avg_alt),
      "rgb(168, 85, 247)",
      "Avg Altitude (m)"
    );
  }

  // Regional Density
  if (sky?.regional_density?.length) {
    createChart(
      "regionalDensity", "bar",
      sky.regional_density.map(d => `${d.lat}° / ${d.lon}°`),
      sky.regional_density.map(d => d.flights),
      "rgb(251, 146, 60)",
      "Flights"
    );
  }

  // Weekday Pattern
  if (detailed?.weekday_distribution?.length) {
    createChart(
      "weekdayPattern", "bar",
      detailed.weekday_distribution.map(d => d.label),
      detailed.weekday_distribution.map(d => d.count),
      "rgb(139, 92, 246)",
      "Flights"
    );
  }

  // Ground vs Airborne
  if (detailed?.ground_airborne) {
    renderGroundAirborne(detailed.ground_airborne);
  }

  // Altitude Distribution
  if (summary?.altitude_bins?.length) {
    createChart(
      "altitudeDistribution", "bar",
      summary.altitude_bins.map(d => d.altitude_band),
      summary.altitude_bins.map(d => d.count),
      "rgb(168, 85, 247)",
      "Flights"
    );
  }

  // Speed Distribution
  if (summary?.speed_bins?.length) {
    createChart(
      "speedDistribution", "bar",
      summary.speed_bins.map(d => d.speed_band),
      summary.speed_bins.map(d => d.count),
      "rgb(236, 72, 153)",
      "Flights"
    );
  }

  // Data Quality
  if (detailed?.metrics) {
    const m = detailed.metrics;
    createChart(
      "dataQuality", "bar",
      ["Altitude", "Speed", "Track", "Position", "Time"],
      [
        m.data_completeness_altitude ?? 0,
        m.data_completeness_speed ?? 0,
        m.data_completeness_track ?? 0,
        m.data_completeness_position ?? 0,
        m.data_completeness_time ?? 0,
      ],
      "rgb(251, 146, 60)",
      "Completeness %"
    );
  }

  setupHistoricalMapControls();
}

loadHistoricalDashboard();
