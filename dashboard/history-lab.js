import {
  loadArchiveDb,
  loadArchiveDbRaw,
  mergeHistorical,
  summarizeDb,
  summarizeDbWithFilters,
} from "./history-archive.mjs";

const ARCHIVE_BASE_DIR = "archives";
const charts = new Map();
Chart.defaults.color = "#dce3f0";
Chart.defaults.font = {
  family: "Space Grotesk, Inter, system-ui, sans-serif",
  size: 11,
};
Chart.defaults.plugins.legend.labels.usePointStyle = true;
const state = {
  summary: null,
  monthly: [],
  detailed: null,
  sqlite: null,
  sqliteDb: null,
  sqliteMode: false,
  sqliteScope: "full",
  liveAirports: [],
  rangeDays: [],
  sqlModule: null,
  filters: {
    month: "all",
    hourStart: 0,
    hourEnd: 23,
    altMin: -1000,
    altMax: 14000,
    spdMin: 0,
    spdMax: 350,
  },
};
let labMap;
let labLayer;
let labAirportLayer;
let labTraceLayer;
let labClusterLayer;
let labTraceIndex = new Map();
let labCurrentArchiveDay = null;
let labArchiveDb = null;
const labArchiveCache = new Map();
let labFilterTimer = null;
let labLoadingCount = 0;
let labDensityVisible = true;
let labLastRows = [];
let labLastDay = null;
let labSelectedTraceKey = null;

function nextFrame() {
  return new Promise((resolve) => requestAnimationFrame(() => resolve()));
}

async function flushUi() {
  await nextFrame();
  await nextFrame();
}

async function fetchJson(path) {
  try {
    const basePath = window.location.pathname.split("/").slice(0, -1).join("/");
    const fullPath = basePath + "/" + path;
    const res = await fetch(fullPath);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json();
  } catch (err) {
    console.error(`Fetch error for ${path}:`, err);
    return null;
  }
}

function fmtNum(val, digits = 0) {
  if (val === null || val === undefined || Number.isNaN(val)) return "--";
  return Number(val).toLocaleString(undefined, { maximumFractionDigits: digits });
}

function isUnknownLabel(value) {
  const text = String(value ?? "").trim().toLowerCase();
  return !text || text === "unknown" || text === "unkonw" || text === "n/a" || text === "na" || text === "none";
}

function cleanLabel(value, fallback = "--") {
  return isUnknownLabel(value) ? fallback : String(value);
}

function parseBand(label) {
  if (!label) return null;
  const match = String(label).match(/-?\d+(\.\d+)?/);
  return match ? Number(match[0]) : null;
}

function updateLabel(id, text) {
  const el = document.getElementById(id);
  if (el) el.textContent = text;
}

function setLabLoading(visible, title = "Loading data", text = "Preparing archive and rebuilding the lab view.") {
  const overlay = document.getElementById("labLoadingOverlay");
  const titleEl = document.getElementById("labLoadingTitle");
  const textEl = document.getElementById("labLoadingText");
  if (!overlay) return;
  if (titleEl) titleEl.textContent = title;
  if (textEl) textEl.textContent = text;
  overlay.classList.toggle("is-visible", visible);
  overlay.setAttribute("aria-hidden", visible ? "false" : "true");
}

function beginLabLoading(title, text) {
  labLoadingCount += 1;
  setLabLoading(true, title, text);
}

function endLabLoading() {
  labLoadingCount = Math.max(0, labLoadingCount - 1);
  if (labLoadingCount === 0) {
    setLabLoading(false);
  }
}

function createChart(canvasId, type, labels, data, color, options = {}) {
  const canvas = document.getElementById(canvasId);
  if (!canvas) return null;

  const existing = Chart.getChart(canvas) || charts.get(canvasId);
  if (existing) {
    existing.destroy();
    charts.delete(canvasId);
  }

  const ctx = canvas.getContext("2d");
  canvas.style.display = "";
  const chart = new Chart(ctx, {
    type,
    data: {
      labels,
      datasets: [
        {
          data,
          borderColor: color,
          backgroundColor: color + "33",
          borderWidth: 2,
          fill: type === "line",
          tension: 0.35,
          pointRadius: 3,
          pointHoverRadius: 5,
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
          titleColor: "#f8fafc",
          bodyColor: "#cbd5f5",
          borderColor: "rgba(0, 218, 243, 0.2)",
          borderWidth: 1,
          padding: 10,
          displayColors: false,
        },
      },
      scales: {
        x: { ticks: { color: "#a3b3d1" }, grid: { color: "rgba(255,255,255,0.06)" } },
        y: { ticks: { color: "#a3b3d1" }, grid: { color: "rgba(255,255,255,0.06)" } },
      },
      ...options,
    },
  });

  charts.set(canvasId, chart);
  return chart;
}

function upsertChart(id, type, labels, data, color, options = {}) {
  if (charts.has(id)) {
    const chart = charts.get(id);
    chart.data.labels = labels;
    chart.data.datasets[0].data = data;
    chart.update();
    return;
  }
  createChart(id, type, labels, data, color, options);
}

function renderHero(summary, detailed) {
  updateLabel("labTotalRows", fmtNum(summary?.total_rows));
  const scopeLabel =
    state.sqliteMode
      ? state.sqliteScope === "day"
        ? `Day archive - ${labCurrentArchiveDay || "loaded"}`
        : state.sqliteScope === "range"
          ? `Range archive - ${state.rangeDays?.length || 0} days`
          : "Full history"
      : "Full history";
  updateLabel("labSpan", scopeLabel);
  updateLabel("labUnique", fmtNum(detailed?.unique_aircraft || detailed?.metrics?.unique_aircraft));
}

function renderMetrics(summary, detailed) {
  const grid = document.getElementById("labMetricGrid");
  if (!grid) return;

  const hourly = detailed?.hourly_distribution || [];
  const busiest = hourly.reduce(
    (best, h) => (h.count > (best?.count || 0) ? h : best),
    null,
  );

  const weekday = detailed?.weekday_distribution || [];
  const peakDay = weekday.reduce(
    (best, d) => (d.count > (best?.count || 0) ? d : best),
    null,
  );

  const altitude = detailed?.altitude_stats || {};
  const speed = detailed?.speed_stats || {};
  const peakHour = hourly.reduce((best, h) => (h.count > (best?.count || 0) ? h : best), null);
  const troughHour = hourly.reduce((best, h) => (best === null || h.count < best.count ? h : best), null);
  const peakToTrough = peakHour && troughHour && troughHour.count > 0
    ? (peakHour.count / troughHour.count)
    : null;
  const mean = hourly.length ? hourly.reduce((s, h) => s + h.count, 0) / hourly.length : null;
  const variance = hourly.length
    ? hourly.reduce((s, h) => s + Math.pow(h.count - mean, 2), 0) / hourly.length
    : null;
  const volatility = variance !== null ? Math.sqrt(variance) : null;

  const altitudeBins = summary?.altitude_bins || [];
  const topBand = altitudeBins.reduce(
    (best, b) => (best === null || b.count > best.count ? b : best),
    null
  );
  const cruiseDominance = topBand && summary?.total_rows
    ? Math.round((topBand.count / summary.total_rows) * 100)
    : null;
  const topAirline = (summary?.top_airlines || []).find((row) => !isUnknownLabel(row?.airline)) || null;
  const topAirlineShare = topAirline && summary?.total_rows
    ? Math.round((topAirline.count / summary.total_rows) * 100)
    : null;
  const onGround = summary?.metrics?.on_ground ?? detailed?.metrics?.on_ground;
  const airborne = summary?.metrics?.airborne ?? detailed?.metrics?.airborne;
  const airborneShare = typeof airborne === "number" && typeof onGround === "number" && airborne + onGround > 0
    ? Math.round((airborne / (airborne + onGround)) * 100)
    : null;

  const cards = [
    { label: "Peak Hour", value: busiest ? `${String(busiest.hour).padStart(2, "0")}:00` : "--" },
    { label: "Busiest Day", value: peakDay?.day || "--" },
    { label: "Largest Band", value: topBand?.altitude_band || "--" },
    { label: "Cruise Share", value: cruiseDominance !== null ? `${cruiseDominance}%` : "--" },
    { label: "Top Airline", value: cleanLabel(topAirline?.airline, "--") },
    { label: "Top Airline %", value: topAirlineShare !== null ? `${topAirlineShare}%` : "--" },
    { label: "Airborne Share", value: airborneShare !== null ? `${airborneShare}%` : "--" },
    { label: "Median Altitude", value: altitude.median ? `${Math.round(altitude.median)}m` : "--" },
    { label: "P90 Altitude", value: altitude.p90 ? `${Math.round(altitude.p90)}m` : "--" },
    { label: "Median Speed", value: speed.median ? `${Math.round(speed.median)}m/s` : "--" },
    { label: "P90 Speed", value: speed.p90 ? `${Math.round(speed.p90)}m/s` : "--" },
    { label: "Ghost Fleet", value: detailed?.ghost_planes?.aircraft ? fmtNum(detailed.ghost_planes.aircraft) : "--" },
  ];

  grid.innerHTML = cards
    .map(
      (card) => `
      <div class="stat-card">
        <div class="stat-label">${card.label}</div>
        <div class="stat-value">${card.value}</div>
      </div>
    `,
    )
    .join("");
}

function renderMonthly(monthly, filters) {
  const useMonthly = filters.month === "all"
    ? monthly
    : monthly.filter((m) => m.month === filters.month);

  const labels = useMonthly.map((m) => m.month);
  const counts = useMonthly.map((m) => m.count);
  const altMedian = useMonthly.map((m) => m.alt_median);
  const speedMedian = useMonthly.map((m) => m.speed_median);

  upsertChart("monthVolume", "line", labels, counts, "#a78bfa");
  upsertChart("monthAltitude", "bar", labels, altMedian, "#38bdf8");
  upsertChart("monthSpeed", "bar", labels, speedMedian, "#f97316");
}

function renderHourWeekday(detailed, filters) {
  const hourly = detailed?.hourly_distribution || [];
  const filteredHourly = hourly.filter(
    (h) => h.hour >= filters.hourStart && h.hour <= filters.hourEnd,
  );
  const hourLabels = filteredHourly.map((h) => String(h.hour).padStart(2, "0") + ":00");
  const hourCounts = filteredHourly.map((h) => h.count);
  upsertChart("hourlyDistribution", "bar", hourLabels, hourCounts, "#22d3ee");

  const weekday = detailed?.weekday_distribution || [];
  const weekdayLabels = weekday.map((d) => d.day);
  const weekdayCounts = weekday.map((d) => d.count);
  upsertChart("weekdaySplit", "bar", weekdayLabels, weekdayCounts, "#34d399");
}

function renderBands(summary, filters) {
  const altitudeBins = summary?.altitude_bins || [];
  const speedBins = summary?.speed_bins || [];

  const filteredAltitude = altitudeBins.filter((b) => {
    const val = parseBand(b.altitude_band);
    return val !== null && val >= filters.altMin && val <= filters.altMax;
  });
  const altLabels = filteredAltitude.map((b) => b.altitude_band);
  const altCounts = filteredAltitude.map((b) => b.count);
  upsertChart("altitudeBandsLab", "bar", altLabels, altCounts, "#818cf8");

  const filteredSpeed = speedBins.filter((b) => {
    const val = parseBand(b.speed_band);
    return val !== null && val >= filters.spdMin && val <= filters.spdMax;
  });
  const speedLabels = filteredSpeed.map((b) => b.speed_band);
  const speedCounts = filteredSpeed.map((b) => b.count);
  upsertChart("speedBandsLab", "bar", speedLabels, speedCounts, "#f472b6");
}

function renderLeaders(summary) {
  const airlines = summary?.top_airlines || [];
  const labels = airlines.map((a) => cleanLabel(a.airline, "Other"));
  const counts = airlines.map((a) => a.count);
  upsertChart("topAirlinesLab", "bar", labels, counts, "#60a5fa", {
    indexAxis: "y",
  });

  const list = document.getElementById("topAirlinesLabList");
  if (list) {
    const topRows = airlines.slice(0, 8);
    list.innerHTML = topRows.length
      ? topRows
          .map(
            (row, i) => `
              <div class="airline-leaderboard-item">
                <span class="airline-rank">#${i + 1}</span>
                ${window.AirlineLogos?.render ? window.AirlineLogos.render(cleanLabel(row.airline, "Other"), { compact: true }) : `<span class="airline-name">${cleanLabel(row.airline, "Other")}</span>`}
                <span class="airline-count">${fmtNum(row.count)}</span>
              </div>
            `,
          )
          .join("")
      : '<div class="hint">No airline data for this selection.</div>';
  }

  const models = summary?.top_models || [];
  const table = document.getElementById("topModelsLab");
  if (!table) return;
  if (!models.length) {
    table.innerHTML = `<div class="hint">Aircraft model data is not available for this selection.</div>`;
    return;
  }
  table.innerHTML = `
    <table>
      <thead>
        <tr>
          <th>Model</th>
          <th>Flights</th>
        </tr>
      </thead>
      <tbody>
        ${models
          .map(
            (m) => `
            <tr>
              <td>${m.model || "--"}</td>
              <td>${fmtNum(m.count)}</td>
            </tr>
          `,
          )
          .join("")}
      </tbody>
    </table>
  `;
}

function renderInsights(summary, detailed) {
  const container = document.getElementById("labInsights");
  if (!container) return;
  const scoped = (detailed?.insights || [])
    .filter((insight) => {
      const title = String(insight?.title || "").toLowerCase();
      const detail = String(insight?.detail || "").toLowerCase();
      return !title.includes("unknown") && !title.includes("unkonw") && !detail.includes("unknown") && !detail.includes("unkonw");
    })
    .slice(0, 8);
  const finalInsights = scoped.length ? scoped : buildFallbackInsights(summary, detailed);
  container.innerHTML = finalInsights
    .map(
      (insight) => `
      <article class="insight-card">
        <div class="insight-icon">${insight.icon || "•"}</div>
        <div>
          <h4>${insight.title}</h4>
          <p>${insight.detail}</p>
        </div>
      </article>
    `,
    )
    .join("");
}

function buildFallbackInsights(summary, detailed) {
  const hourly = detailed?.hourly_distribution || [];
  const topHour = hourly.reduce((best, h) => (h.count > (best?.count || 0) ? h : best), null);
  const topAirline = (summary?.top_airlines || []).find((row) => !isUnknownLabel(row?.airline)) || null;
  const topBand = (summary?.altitude_bins || []).reduce((best, b) => (best === null || b.count > best.count ? b : best), null);
  const scopeLabel = state.sqliteMode
    ? state.sqliteScope === "day"
      ? `day ${labCurrentArchiveDay || "loaded"}`
      : state.sqliteScope === "range"
        ? "the loaded range"
        : "full history"
    : "full history";
  const selectedAirline = state.filters?.airline || "";
  const selectedAirport = state.filters?.airport || "";
  const totalRecords = summary?.total_rows || detailed?.metrics?.total_records;
  const uniqueAircraft = detailed?.unique_aircraft || detailed?.metrics?.unique_aircraft;
  const airborne = detailed?.metrics?.airborne;
  const onGround = detailed?.metrics?.on_ground;
  const airborneShare = typeof airborne === "number" && typeof onGround === "number" && airborne + onGround > 0
    ? Math.round((airborne / (airborne + onGround)) * 100)
    : null;

  return [
    {
      icon: "•",
      title: "Current view",
      detail: `You are looking at ${scopeLabel}.`,
    },
    {
      icon: "✦",
      title: "Scale",
      detail: totalRecords && uniqueAircraft
        ? `${fmtNum(totalRecords)} records across ${fmtNum(uniqueAircraft)} aircraft.`
        : "This selection is too small to judge cleanly.",
    },
    {
      icon: "⏱",
      title: "Traffic rhythm",
      detail: topHour
        ? `The busiest hour is ${String(topHour.hour).padStart(2, "0")}:00.`
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
      icon: "•",
      title: "Filters",
      detail: selectedAirline || selectedAirport
        ? `Filtered to ${selectedAirline || "all airlines"}${selectedAirport ? ` near ${selectedAirport}` : ""}.`
        : "No extra filter is applied.",
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

function syncFilterLabels(filters) {
  updateLabel(
    "hourRangeLabel",
    `${String(filters.hourStart).padStart(2, "0")}:00 → ${String(filters.hourEnd).padStart(2, "0")}:00`,
  );
  updateLabel(
    "altRangeLabel",
    `${fmtNum(filters.altMin)}m → ${fmtNum(filters.altMax)}m`,
  );
  updateLabel(
    "spdRangeLabel",
    `${fmtNum(filters.spdMin)}m/s → ${fmtNum(filters.spdMax)}m/s`,
  );
  updateLabel(
    "hourChip",
    filters.hourStart === 0 && filters.hourEnd === 23
      ? "Full Day"
      : `${String(filters.hourStart).padStart(2, "0")}:00 → ${String(filters.hourEnd).padStart(2, "0")}:00`,
  );
  updateLabel(
    "bandChip",
    filters.altMin === -1000 && filters.altMax === 14000 && filters.spdMin === 0 && filters.spdMax === 350
      ? "All Bands"
      : "Filtered Bands",
  );
}

function loadFiltersFromUI() {
  const hourStart = Number(document.getElementById("hourStart").value);
  const hourEnd = Number(document.getElementById("hourEnd").value);
  const altMin = Number(document.getElementById("altMin").value);
  const altMax = Number(document.getElementById("altMax").value);
  const spdMin = Number(document.getElementById("spdMin").value);
  const spdMax = Number(document.getElementById("spdMax").value);
  const month = document.getElementById("monthSelect").value;
  const airline = document.getElementById("airlineFilter")?.value || "";
  const airport = document.getElementById("airportFilterLab")?.value || "";

  state.filters = {
    month,
    hourStart: Math.min(hourStart, hourEnd),
    hourEnd: Math.max(hourStart, hourEnd),
    altMin: Math.min(altMin, altMax),
    altMax: Math.max(altMin, altMax),
    spdMin: Math.min(spdMin, spdMax),
    spdMax: Math.max(spdMin, spdMax),
    airline,
    airport,
  };
  syncFilterLabels(state.filters);
}

function scheduleLabRender() {
  window.clearTimeout(labFilterTimer);
  labFilterTimer = window.setTimeout(() => {
    if (state.sqliteDb && state.sqliteMode && state.sqliteScope === "day") {
      state.sqlite = summarizeDbWithFilters(state.sqliteDb, state.filters);
    }
    renderAll();
  }, 120);
}

function resetFilters() {
  document.getElementById("hourStart").value = 0;
  document.getElementById("hourEnd").value = 23;
  document.getElementById("altMin").value = -1000;
  document.getElementById("altMax").value = 14000;
  document.getElementById("spdMin").value = 0;
  document.getElementById("spdMax").value = 350;
  document.getElementById("monthSelect").value = "all";
  const airline = document.getElementById("airlineFilter");
  const airport = document.getElementById("airportFilterLab");
  if (airline) airline.value = "";
  if (airport) airport.value = "";
  loadFiltersFromUI();
  updateLabel("monthChip", "All Months");
  renderAll();
}

function renderAll() {
  const summary = state.sqliteMode ? state.sqlite.summary : state.summary;
  const detailed = state.sqliteMode ? state.sqlite.detailed : state.detailed;
  renderHero(summary, detailed);
  renderMetrics(summary, detailed);
  renderMonthly(state.monthly, state.filters);
  renderHourWeekday(detailed, state.filters);
  renderBands(summary, state.filters);
  renderLeaders(summary);
  renderInsights(summary, detailed);
}

function initControls(monthly) {
  const select = document.getElementById("monthSelect");
  if (!select) return;
  select.innerHTML = `
    <option value="all">All Months</option>
    ${monthly.map((m) => `<option value="${m.month}">${m.month}</option>`).join("")}
  `;

  const applyBtn = document.getElementById("applyFilters");
  const resetBtn = document.getElementById("resetFilters");
  applyBtn?.addEventListener("click", () => {
    loadFiltersFromUI();
    updateLabel("monthChip", state.filters.month === "all" ? "All Months" : state.filters.month);
    if (state.sqliteDb && state.sqliteMode && state.sqliteScope === "day") {
      const filtered = summarizeDbWithFilters(state.sqliteDb, state.filters);
      state.sqlite = filtered;
    }
    renderAll();
  });
  resetBtn?.addEventListener("click", resetFilters);

  ["hourStart", "hourEnd", "altMin", "altMax", "spdMin", "spdMax"].forEach((id) => {
    document.getElementById(id)?.addEventListener("input", () => {
      loadFiltersFromUI();
      scheduleLabRender();
    });
  });

  ["monthSelect", "airlineFilter", "airportFilterLab"].forEach((id) => {
    document.getElementById(id)?.addEventListener("change", () => {
      loadFiltersFromUI();
      scheduleLabRender();
    });
  });
}

async function loadSqliteDay(day) {
  const status = document.getElementById("sqliteStatus");
  status.textContent = "Loading archive...";
  beginLabLoading("Loading day archive", `Fetching ${day} and rebuilding charts, filters, and trace paths.`);
  labSelectedTraceKey = null;
  try {
    await flushUi();
    const archiveDb = await loadArchiveDbRaw(day, {
      initSqlJs,
      baseDir: ARCHIVE_BASE_DIR,
    });
    const { summary, detailed } = summarizeDb(archiveDb);
    const table = archiveDb.exec(
      "SELECT name FROM sqlite_master WHERE type='table' AND name='flight_positions_archive'"
    );
    if (table?.[0]?.values?.length) {
      archiveDb.exec("CREATE VIEW flight_positions AS SELECT * FROM flight_positions_archive;");
    }
    state.sqliteDb = archiveDb;
    state.sqlite = { summary, detailed };
    state.sqliteMode = true;
    state.sqliteScope = "day";
    labCurrentArchiveDay = day;
    status.textContent = `Loaded ${day} archive (${fmtNum(summary.total_rows)} records).`;
    await hydrateSqliteFilters();
    enableQueryConsole(true);
    renderAll();
    endLabLoading();
    void updateLabMapForDb(day, archiveDb);
  } catch (err) {
    console.error(err);
    state.sqliteMode = false;
    state.sqliteScope = "full";
    state.sqliteDb = null;
    state.sqlite = { summary: state.summary, detailed: state.detailed };
    applyBaseFilterOptions();
    enableQueryConsole(true);
    status.textContent = "Using full history (archive unavailable).";
    renderAll();
  } finally {
    if (labLoadingCount > 0) endLabLoading();
  }
}

function eachDay(start, end) {
  const days = [];
  const cur = new Date(start);
  const last = new Date(end);
  while (cur <= last) {
    days.push(cur.toISOString().slice(0, 10));
    cur.setUTCDate(cur.getUTCDate() + 1);
  }
  return days;
}

async function loadSqliteRange(startDay, endDay) {
  const status = document.getElementById("sqliteStatus");
  status.textContent = "Loading archives...";
  beginLabLoading("Loading archive range", `Fetching ${startDay} through ${endDay} and merging the dataset.`);
  labSelectedTraceKey = null;
  try {
    await flushUi();
    const days = eachDay(startDay, endDay);
    const results = [];
    const missing = [];
    const mapRows = [];
    for (const day of days) {
      status.textContent = `Loading ${day}...`;
      try {
        const db = await loadArchiveDbRaw(day, {
          initSqlJs,
          baseDir: ARCHIVE_BASE_DIR,
        });
        const item = summarizeDb(db);
        results.push(item);
        const rows = db.exec(`
          SELECT icao24, callsign, airline, lat, lon, altitude, velocity, observed_at, nearest_airport
          FROM flight_positions_archive
          WHERE lat IS NOT NULL AND lon IS NOT NULL
          ORDER BY icao24 ASC, observed_at ASC
          LIMIT 1200
        `);
        mapRows.push(...(rows?.[0]?.values || []));
      } catch (err) {
        console.warn(`Archive missing for ${day}`, err);
        missing.push(day);
      }
    }
    if (!results.length) {
      state.sqliteMode = false;
      state.sqliteScope = "full";
      state.sqliteDb = null;
      applyBaseFilterOptions();
      enableQueryConsole(false);
      status.textContent = "No archives found for that range.";
      return;
    }
    const merged = mergeHistorical(results);
    state.sqlite = merged;
    state.sqliteMode = true;
    state.sqliteScope = "range";
    state.sqliteDb = null;
    state.rangeDays = days;
    labCurrentArchiveDay = `${startDay} → ${endDay}`;
    applyRangeFilterOptions(merged);
    enableQueryConsole(true);
    const suffix = missing.length ? ` (${missing.length} missing)` : "";
    status.textContent = `Loaded ${results.length} days (${fmtNum(merged.summary.total_rows)} records)${suffix}.`;
    renderAll();
    endLabLoading();
    labArchiveDb = null;
    renderLabMap(mapRows, `${startDay} → ${endDay}`);
  } catch (err) {
    console.error(err);
    status.textContent = "Range load failed.";
  } finally {
    if (labLoadingCount > 0) endLabLoading();
  }
}

function updateLabMapStatus(text) {
  const el = document.getElementById("labMapStatus");
  if (el) el.textContent = text;
}

function initLabMap() {
  if (labMap || typeof L === "undefined") return;
  const mapEl = document.getElementById("labMap");
  if (!mapEl) return;
  labMap = L.map(mapEl, {
    zoomControl: true,
    attributionControl: false,
  }).setView([20, 0], 2);
  labMap.createPane("densityPane");
  labMap.getPane("densityPane").style.zIndex = 350;
  labMap.createPane("tracePane");
  labMap.getPane("tracePane").style.zIndex = 450;
  labMap.createPane("markerPane");
  labMap.getPane("markerPane").style.zIndex = 650;
  L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
    maxZoom: 12,
    minZoom: 2,
  }).addTo(labMap);
  labLayer = L.layerGroup().addTo(labMap);
  labAirportLayer = L.layerGroup().addTo(labMap);
  labTraceLayer = L.layerGroup().addTo(labMap);
  labClusterLayer = L.layerGroup().addTo(labMap);
  L.control.scale({ imperial: false }).addTo(labMap);
  labMap.on("click", () => {
    labSelectedTraceKey = null;
    labTraceLayer?.clearLayers();
  });
  const toggle = document.getElementById("labDensityToggle");
  toggle?.addEventListener("click", () => {
    labDensityVisible = !labDensityVisible;
    toggle.textContent = `Density: ${labDensityVisible ? "On" : "Off"}`;
    if (!labMap || !labClusterLayer) return;
    if (labDensityVisible) {
      labMap.addLayer(labClusterLayer);
      if (labLastRows.length && labLastDay) {
        renderLabMap(labLastRows, labLastDay);
      }
    } else {
      labMap.removeLayer(labClusterLayer);
    }
  });
}

function clearLabMapLayers() {
  labLayer?.clearLayers();
  labAirportLayer?.clearLayers();
  labTraceLayer?.clearLayers();
  labClusterLayer?.clearLayers();
}

function renderLabMap(rows, day) {
  initLabMap();
  if (!labLayer) return;
  clearLabMapLayers();
  labTraceIndex = new Map();
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
      fillColor: "#22d3ee",
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
    marker.on("click", () => highlightLabTrace(trailKey));
    marker.addTo(labLayer);
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

  if (labDensityVisible) {
    airportClusters.forEach((cluster, airport) => {
      const latAvg = cluster.latSum / cluster.count;
      const lonAvg = cluster.lonSum / cluster.count;
      addHeatBlob(labClusterLayer, latAvg, lonAvg, cluster.count, airport);
    });
  }
  if (labAirportLayer) {
    airportClusters.forEach((cluster, airport) => {
      const latAvg = cluster.latSum / cluster.count;
      const lonAvg = cluster.lonSum / cluster.count;
      addAirportMarker(labAirportLayer, latAvg, lonAvg, `${airport} airport`);
    });
  }

  trailsByFlight.forEach((trail, key) => {
    const points = trail
      .slice()
      .sort((a, b) => a.observed - b.observed)
      .map(({ lat, lon }) => [lat, lon]);
    labTraceIndex.set(key, points);
  });

  if (labSelectedTraceKey && labTraceIndex.has(labSelectedTraceKey)) {
    drawRoute(labTraceLayer, labTraceIndex.get(labSelectedTraceKey), "#38bdf8");
  }

  markers.forEach((marker) => marker.bringToFront?.());

  if (bounds.length && labMap) {
    labMap.fitBounds(bounds, { padding: [60, 60], maxZoom: 7 });
  }
  updateLabMapStatus(`Map: ${rows.length} positions - ${day}`);
  labLastRows = rows;
  labLastDay = day;
}

async function fetchLabArchiveDb(day) {
  if (!day) return null;
  if (labArchiveCache.has(day)) return labArchiveCache.get(day);
  const db = await loadArchiveDbRaw(day, { initSqlJs, baseDir: ARCHIVE_BASE_DIR });
  labArchiveCache.set(day, db);
  return db;
}

async function updateLabMapForDb(day, db) {
  if (!day || !db) {
    clearLabMapLayers();
    updateLabMapStatus("No archive loaded.");
    return;
  }
  labArchiveDb = db;
  labCurrentArchiveDay = day;
  const res = db.exec(`
    SELECT icao24, callsign, airline, lat, lon, altitude, velocity, observed_at, nearest_airport
    FROM flight_positions_archive
    WHERE lat IS NOT NULL AND lon IS NOT NULL
    ORDER BY icao24 ASC, observed_at ASC
    LIMIT 1200
  `);
  labLastRows = res?.[0]?.values || [];
  labLastDay = day;
  renderLabMap(labLastRows, day);
}

async function updateLabMapForRange(day) {
  if (!day) return;
  try {
    const db = await fetchLabArchiveDb(day);
    await updateLabMapForDb(day, db);
    updateLabMapStatus(`Map preview based on ${day}`);
  } catch (err) {
    console.warn("Range map load failed", err);
    updateLabMapStatus("Unable to build map for range.");
  }
}

function highlightLabTrace(icao) {
  if (!labTraceLayer || !icao) return;
  labSelectedTraceKey = icao;
  labTraceLayer.clearLayers();
  const indexed = labTraceIndex.get(icao);
  if (indexed?.length >= 2) {
    drawRoute(labTraceLayer, indexed, "#38bdf8");
    return;
  }
  if (!labArchiveDb) return;
  const res = labArchiveDb.exec(
    "SELECT lat, lon FROM flight_positions_archive WHERE icao24 = ? AND lat IS NOT NULL AND lon IS NOT NULL ORDER BY observed_at ASC",
    [icao]
  );
  const points = (res?.[0]?.values || [])
    .map(([lat, lon]) => [Number(lat), Number(lon)])
    .filter(([lat, lon]) => Number.isFinite(lat) && Number.isFinite(lon));
  if (points.length < 2) return;
  drawRoute(labTraceLayer, points, "#38bdf8");
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
      .bindTooltip(`${label} | ${count} pts`, { direction: "top", permanent: false })
      .addTo(layer);
  });
}

function addAirportMarker(layer, lat, lon, label) {
  if (!layer || !Number.isFinite(lat) || !Number.isFinite(lon)) return;
  L.circleMarker([lat, lon], {
    radius: 4,
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

async function hydrateSqliteFilters() {
  const airlineSelect = document.getElementById("airlineFilter");
  const airportSelect = document.getElementById("airportFilterLab");
  const airlineHint = document.getElementById("airlineHint");
  const airportHint = document.getElementById("airportHint");
  if (!state.sqliteDb || !airlineSelect || !airportSelect) return;

  const airlineRows =
    state.sqliteDb.exec(
      "SELECT airline, COUNT(*) as c FROM flight_positions_archive WHERE airline IS NOT NULL AND airline != '' GROUP BY airline ORDER BY c DESC LIMIT 50"
    )[0]?.values || [];
  const airportRows =
    state.sqliteDb.exec(
      "SELECT nearest_airport, COUNT(*) as c FROM flight_positions_archive WHERE nearest_airport IS NOT NULL AND nearest_airport != '' GROUP BY nearest_airport ORDER BY c DESC LIMIT 50"
    )[0]?.values || [];

  airlineSelect.innerHTML = `<option value=\"\">All Airlines</option>` +
    airlineRows.map((r) => `<option value=\"${r[0]}\">${r[0]}</option>`).join("");
  airportSelect.innerHTML = `<option value=\"\">All Airports</option>` +
    airportRows.map((r) => `<option value=\"${r[0]}\">${r[0]}</option>`).join("");
  airlineSelect.disabled = false;
  airportSelect.disabled = false;
  if (airlineHint) airlineHint.textContent = "From selected day";
  if (airportHint) airportHint.textContent = "From selected day";
}

function applyBaseFilterOptions() {
  const airlineSelect = document.getElementById("airlineFilter");
  const airportSelect = document.getElementById("airportFilterLab");
  const airlineHint = document.getElementById("airlineHint");
  const airportHint = document.getElementById("airportHint");
  if (!airlineSelect || !airportSelect) return;

  const airlines = state.summary?.top_airlines || [];
  if (airlines.length) {
    airlineSelect.innerHTML =
      `<option value="">All Airlines</option>` +
      airlines.map((r) => `<option value="${r.airline}">${r.airline}</option>`).join("");
    airlineSelect.disabled = false;
    if (airlineHint) airlineHint.textContent = "From full history";
  } else {
    airlineSelect.innerHTML = `<option value="">All Airlines</option>`;
    airlineSelect.disabled = false;
    if (airlineHint) airlineHint.textContent = "From full history";
  }

  if (state.liveAirports?.length) {
    airportSelect.innerHTML =
      `<option value="">All Airports</option>` +
      state.liveAirports.map((r) => `<option value="${r.airport}">${r.airport}</option>`).join("");
    airportSelect.disabled = false;
    if (airportHint) airportHint.textContent = "From live airports";
  } else {
    airportSelect.innerHTML = `<option value="">All Airports</option>`;
    airportSelect.disabled = false;
    if (airportHint) airportHint.textContent = "From live airports";
  }
}

function applyRangeFilterOptions(merged) {
  const airlineSelect = document.getElementById("airlineFilter");
  const airportSelect = document.getElementById("airportFilterLab");
  const airlineHint = document.getElementById("airlineHint");
  const airportHint = document.getElementById("airportHint");
  if (!airlineSelect || !airportSelect) return;

  const airlines = merged?.summary?.top_airlines || [];
  if (airlines.length) {
    airlineSelect.innerHTML =
      `<option value="">All Airlines</option>` +
      airlines.map((r) => `<option value="${r.airline}">${r.airline}</option>`).join("");
    airlineSelect.disabled = false;
    if (airlineHint) airlineHint.textContent = "From selected range (top airlines)";
  } else {
    airlineSelect.innerHTML = `<option value="">No airline data</option>`;
    airlineSelect.disabled = true;
    if (airlineHint) airlineHint.textContent = "No airline data in range";
  }

  if (state.liveAirports?.length) {
    airportSelect.innerHTML =
      `<option value="">All Airports</option>` +
      state.liveAirports.map((r) => `<option value="${r.airport}">${r.airport}</option>`).join("");
    airportSelect.disabled = false;
    if (airportHint) airportHint.textContent = "From live airports";
  } else {
    airportSelect.innerHTML = `<option value="">No airport data</option>`;
    airportSelect.disabled = true;
    if (airportHint) airportHint.textContent = "No airport data";
  }
}

function initSqliteControls() {
  const input = document.getElementById("sqliteDate");
  const startInput = document.getElementById("sqliteRangeStart");
  const endInput = document.getElementById("sqliteRangeEnd");
  const loadBtn = document.getElementById("loadSqliteDay");
  const loadRangeBtn = document.getElementById("loadSqliteRange");
  const clearBtn = document.getElementById("clearSqliteDay");
  const status = document.getElementById("sqliteStatus");

  if (!input || !loadBtn || !clearBtn) return;

  const now = new Date();
  const today = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  const yesterday = new Date(today);
  yesterday.setUTCDate(yesterday.getUTCDate() - 1);
  const defaultDay = yesterday.toISOString().slice(0, 10);
  input.value = defaultDay;
  if (startInput) startInput.value = defaultDay;
  if (endInput) endInput.value = defaultDay;

  loadBtn.addEventListener("click", () => {
    const day = input.value;
    if (!day) {
      status.textContent = "Pick a date first.";
      return;
    }
    loadSqliteDay(day);
  });

  loadRangeBtn?.addEventListener("click", () => {
    const startDay = startInput?.value;
    const endDay = endInput?.value;
    if (!startDay || !endDay) {
      status.textContent = "Pick a range first.";
      return;
    }
    loadSqliteRange(startDay, endDay);
  });

  clearBtn.addEventListener("click", async () => {
    beginLabLoading("Restoring full history", "Rebuilding the lab view from the full dataset.");
    await flushUi();
    state.sqliteMode = false;
    state.sqliteScope = "full";
    state.sqliteDb = null;
    state.rangeDays = [];
    applyBaseFilterOptions();
    enableQueryConsole(true);
    status.textContent = "Using full history.";
    renderAll();
    clearLabMapLayers();
    updateLabMapStatus("Map disabled in full history view.");
    window.setTimeout(() => endLabLoading(), 0);
  });

  loadSqliteDay(defaultDay);
}

function enableQueryConsole(enabled) {
  const status = document.getElementById("sqlStatus");
  const runBtn = document.getElementById("runSqlQuery");
  if (status) {
    status.textContent = enabled
      ? "Querying available data."
      : "Querying is disabled.";
  }
  if (runBtn) runBtn.disabled = !enabled;
}

function initQueryConsole() {
  const runBtn = document.getElementById("runSqlQuery");
  const clearBtn = document.getElementById("clearSqlQuery");
  const textarea = document.getElementById("sqlQuery");
  const results = document.getElementById("sqlResults");
  const status = document.getElementById("sqlStatus");

  if (!runBtn || !clearBtn || !textarea || !results) return;

  runBtn.addEventListener("click", () => {
    const query = textarea.value.trim();
    if (!query) return;
    runSqlQuery(query, results, status);
  });

  clearBtn.addEventListener("click", () => {
    textarea.value = "";
    results.innerHTML = "";
  });
}

async function runSqlQuery(query, resultsEl, statusEl) {
  try {
    if (state.sqliteDb) {
      const res = state.sqliteDb.exec(query);
      renderSqlResults(res, resultsEl);
      return;
    }
    if (state.sqliteScope === "full") {
      if (statusEl) statusEl.textContent = "Preparing full-history query database...";
      beginLabLoading("Preparing SQL database", "Building the queryable database from the full history summary.");
      await flushUi();
      state.sqliteDb = buildTempDbFromJson();
      endLabLoading();
      if (state.sqliteDb) {
        const res = state.sqliteDb.exec(query);
        renderSqlResults(res, resultsEl);
        return;
      }
    }
    if (state.sqliteScope === "range" && state.rangeDays.length) {
      const rows = [];
      let columns = null;
      for (const day of state.rangeDays) {
        try {
          const db = await loadArchiveDbRaw(day, { initSqlJs, baseDir: ARCHIVE_BASE_DIR });
          const res = db.exec(query);
          if (res.length) {
            if (!columns) columns = res[0].columns;
            rows.push(...res[0].values);
          }
        } catch (err) {
          console.warn(`Query skip ${day}`, err);
        }
      }
      if (!columns || !rows.length) {
        resultsEl.innerHTML = "<div class=\"query-status\">No results.</div>";
        return;
      }
      renderSqlResults([{ columns, values: rows.slice(0, 200) }], resultsEl);
      return;
    }
    if (statusEl) statusEl.textContent = "No queryable data loaded.";
  } catch (err) {
    resultsEl.innerHTML = `<div class="query-status">Query error: ${err.message}</div>`;
  }
}

function renderSqlResults(res, resultsEl) {
  if (!res.length) {
    resultsEl.innerHTML = "<div class=\"query-status\">No results.</div>";
    return;
  }
  const table = res[0];
  const header = table.columns.map((c) => `<th>${c}</th>`).join("");
  const body = table.values
    .slice(0, 200)
    .map((row) => `<tr>${row.map((v) => `<td>${v ?? ""}</td>`).join("")}</tr>`)
    .join("");
  resultsEl.innerHTML = `<table><thead><tr>${header}</tr></thead><tbody>${body}</tbody></table>`;
}

function buildTempDbFromJson() {
  if (!state.sqlModule) return null;
  const db = new state.sqlModule.Database();
  const norm = (v) => (v === undefined ? null : v);
  db.exec(`
    CREATE TABLE historical_summary (total_rows INTEGER);
    CREATE TABLE historical_altitude_bins (altitude_band TEXT, count INTEGER);
    CREATE TABLE historical_speed_bins (speed_band TEXT, count INTEGER);
    CREATE TABLE historical_top_airlines (airline TEXT, count INTEGER);
    CREATE TABLE historical_top_models (model TEXT, count INTEGER);
    CREATE TABLE historical_hourly_distribution (hour INTEGER, count INTEGER);
    CREATE TABLE historical_weekday_distribution (day TEXT, count INTEGER);
    CREATE TABLE historical_metrics (key TEXT, value REAL);
    CREATE TABLE airport_counts (airport TEXT, flights INTEGER);
    CREATE TABLE flight_positions (
      observed_at TEXT,
      icao24 TEXT,
      airline TEXT,
      nearest_airport TEXT,
      altitude REAL,
      velocity REAL,
      heading REAL,
      on_ground INTEGER
    );
  `);

  const summary = state.summary || {};
  if (summary.total_rows !== undefined) {
    db.exec("INSERT INTO historical_summary VALUES (?);", [norm(summary.total_rows)]);
  }
  (summary.altitude_bins || []).forEach((b) => {
    if (b?.altitude_band === undefined || b?.count === undefined) return;
    db.exec("INSERT INTO historical_altitude_bins VALUES (?, ?);", [norm(b.altitude_band), norm(b.count)]);
  });
  (summary.speed_bins || []).forEach((b) => {
    if (b?.speed_band === undefined || b?.count === undefined) return;
    db.exec("INSERT INTO historical_speed_bins VALUES (?, ?);", [norm(b.speed_band), norm(b.count)]);
  });
  (summary.top_airlines || []).forEach((b) => {
    if (b?.airline === undefined || b?.count === undefined) return;
    db.exec("INSERT INTO historical_top_airlines VALUES (?, ?);", [norm(b.airline), norm(b.count)]);
  });
  (summary.top_models || []).forEach((b) => {
    if (b?.model === undefined || b?.count === undefined) return;
    db.exec("INSERT INTO historical_top_models VALUES (?, ?);", [norm(b.model), norm(b.count)]);
  });

  const detailed = state.detailed || {};
  (detailed.hourly_distribution || []).forEach((b) => {
    if (b?.hour === undefined || b?.count === undefined) return;
    db.exec("INSERT INTO historical_hourly_distribution VALUES (?, ?);", [norm(b.hour), norm(b.count)]);
  });
  (detailed.weekday_distribution || []).forEach((b) => {
    if (b?.day === undefined || b?.count === undefined) return;
    db.exec("INSERT INTO historical_weekday_distribution VALUES (?, ?);", [norm(b.day), norm(b.count)]);
  });

  if (detailed.metrics) {
    Object.entries(detailed.metrics).forEach(([key, value]) => {
      if (value === undefined || value === null) return;
      db.exec("INSERT INTO historical_metrics VALUES (?, ?);", [norm(key), norm(value)]);
    });
  }

  (state.liveAirports || []).forEach((a) => {
    if (a?.airport === undefined || a?.flights === undefined) return;
    db.exec("INSERT INTO airport_counts VALUES (?, ?);", [norm(a.airport), norm(a.flights)]);
    db.exec("INSERT INTO flight_positions (nearest_airport) VALUES (?);", [norm(a.airport)]);
  });

  (summary.top_airlines || []).forEach((b) => {
    if (b?.airline === undefined) return;
    db.exec("INSERT INTO flight_positions (airline) VALUES (?);", [norm(b.airline)]);
  });

  (summary.altitude_bins || []).forEach((b) => {
    if (b?.altitude_band === undefined || b?.count === undefined) return;
    const band = parseBand(b.altitude_band);
    const rows = Math.min(Number(b.count) || 0, 2000);
    for (let i = 0; i < rows; i += 1) {
      db.exec("INSERT INTO flight_positions (altitude) VALUES (?);", [band]);
    }
  });

  (summary.speed_bins || []).forEach((b) => {
    if (b?.speed_band === undefined || b?.count === undefined) return;
    const band = parseBand(b.speed_band);
    const rows = Math.min(Number(b.count) || 0, 2000);
    for (let i = 0; i < rows; i += 1) {
      db.exec("INSERT INTO flight_positions (velocity) VALUES (?);", [band]);
    }
  });

  (detailed.hourly_distribution || []).forEach((b) => {
    if (b?.hour === undefined || b?.count === undefined) return;
    const rows = Math.min(Number(b.count) || 0, 2000);
    for (let i = 0; i < rows; i += 1) {
      const hour = String(b.hour).padStart(2, "0");
      db.exec("INSERT INTO flight_positions (observed_at) VALUES (?);", [`1970-01-01T${hour}:00:00Z`]);
    }
  });

  db.exec(`
    CREATE VIEW airlines AS
      SELECT airline, COUNT(*) AS flights
      FROM flight_positions
      WHERE airline IS NOT NULL
      GROUP BY airline;
    CREATE VIEW airports AS
      SELECT nearest_airport AS airport, COUNT(*) AS flights
      FROM flight_positions
      WHERE nearest_airport IS NOT NULL
      GROUP BY nearest_airport;
    CREATE VIEW flight_positions_archive AS
      SELECT * FROM flight_positions;
  `);

  return db;
}

async function init() {
  beginLabLoading("Loading history lab", "Fetching datasets and rebuilding the workspace.");
  await flushUi();
  const [summary, monthly, detailed, airportCounts] = await Promise.all([
    fetchJson("data/historical_summary.json"),
    fetchJson("data/historical_monthly.json"),
    fetchJson("data/historical_detailed.json"),
    fetchJson("data/airport_counts.json"),
  ]);

  state.summary = summary;
  state.monthly = monthly || [];
  state.detailed = detailed;
  state.liveAirports = Array.isArray(airportCounts) ? airportCounts.slice(0, 50) : [];

  state.sqlModule = await initSqlJs({
    locateFile: (file) =>
      `https://cdnjs.cloudflare.com/ajax/libs/sql.js/1.10.2/${file}`,
  });
  state.sqliteDb = null;

  initControls(state.monthly);
  initSqliteControls();
  applyBaseFilterOptions();
  initQueryConsole();
  enableQueryConsole(true);
  loadFiltersFromUI();
  updateLabel("monthChip", "All Months");
  renderAll();
  setLabLoading(false);
}

init();
