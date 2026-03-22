import {
  loadArchiveDb,
  loadArchiveDbRaw,
  mergeHistorical,
  summarizeDbWithFilters,
  decompressGzip,
} from "./history-archive.mjs";

const charts = new Map();
Chart.defaults.color = "#cbd5f5";
Chart.defaults.font = {
  family: "IBM Plex Sans, Inter, system-ui, sans-serif",
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

function parseBand(label) {
  if (!label) return null;
  const match = String(label).match(/-?\d+(\.\d+)?/);
  return match ? Number(match[0]) : null;
}

function updateLabel(id, text) {
  const el = document.getElementById(id);
  if (el) el.textContent = text;
}

function createChart(canvasId, type, labels, data, color, options = {}) {
  const canvas = document.getElementById(canvasId);
  if (!canvas) return null;

  const ctx = canvas.getContext("2d");
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
          borderColor: "rgba(255, 255, 255, 0.1)",
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
  if (summary?.date_range?.length === 2) {
    const start = new Date(summary.date_range[0]).toLocaleString();
    const end = new Date(summary.date_range[1]).toLocaleString();
    updateLabel("labSpan", `${start} → ${end}`);
  }
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

  const cards = [
    { label: "Peak Hour", value: busiest ? `${String(busiest.hour).padStart(2, "0")}:00` : "--" },
    { label: "Peak Weekday", value: peakDay?.day || "--" },
    { label: "Median Altitude", value: altitude.median ? `${Math.round(altitude.median)}m` : "--" },
    { label: "P90 Altitude", value: altitude.p90 ? `${Math.round(altitude.p90)}m` : "--" },
    { label: "Median Speed", value: speed.median ? `${Math.round(speed.median)}m/s` : "--" },
    { label: "P90 Speed", value: speed.p90 ? `${Math.round(speed.p90)}m/s` : "--" },
    { label: "Data Completeness", value: detailed?.metrics?.data_completeness_all_fields ? `${detailed.metrics.data_completeness_all_fields.toFixed(1)}%` : "--" },
    { label: "Ghost Fleet", value: detailed?.ghost_planes?.aircraft ? fmtNum(detailed.ghost_planes.aircraft) : "--" },
    { label: "Peak/Trough Ratio", value: peakToTrough ? peakToTrough.toFixed(2) : "--" },
    { label: "Hourly Volatility", value: volatility ? Math.round(volatility).toLocaleString() : "--" },
    { label: "Cruise Band Share", value: cruiseDominance !== null ? `${cruiseDominance}%` : "--" },
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
  const labels = airlines.map((a) => a.airline || "Unknown");
  const counts = airlines.map((a) => a.count);
  upsertChart("topAirlinesLab", "bar", labels, counts, "#60a5fa", {
    indexAxis: "y",
  });

  const models = summary?.top_models || [];
  const table = document.getElementById("topModelsLab");
  if (!table) return;
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

function renderInsights(insights) {
  const container = document.getElementById("labInsights");
  if (!container || !insights?.length) return;
  container.innerHTML = insights
    .slice(0, 8)
    .map(
      (insight) => `
      <article class="insight-card">
        <div class="insight-icon">${insight.icon || "📌"}</div>
        <div>
          <h4>${insight.title}</h4>
          <p>${insight.detail}</p>
        </div>
      </article>
    `,
    )
    .join("");
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
  renderInsights(detailed?.insights || []);
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
    });
  });
}

async function loadSqliteDay(day) {
  const status = document.getElementById("sqliteStatus");
  status.textContent = "Loading archive...";
  try {
    const { summary, detailed } = await loadArchiveDb(day, {
      initSqlJs,
      baseDir: "../archives",
    });
    const res = await fetch(`../archives/flights_${day}.sqlite.gz`);
    const gzBuffer = await res.arrayBuffer();
    const buffer = await decompressGzip(gzBuffer);
    const SQL = await initSqlJs({
      locateFile: (file) =>
        `https://cdnjs.cloudflare.com/ajax/libs/sql.js/1.10.2/${file}`,
    });
    const archiveDb = new SQL.Database(new Uint8Array(buffer));
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
    status.textContent = `Loaded ${day} archive (${fmtNum(summary.total_rows)} records).`;
    await hydrateSqliteFilters();
    enableQueryConsole(true);
    renderAll();
  } catch (err) {
    console.error(err);
    state.sqliteMode = false;
    state.sqliteScope = "full";
    state.sqliteDb = null;
    applyBaseFilterOptions();
    enableQueryConsole(false);
    status.textContent = "No archive found for that day.";
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
  try {
    const days = eachDay(startDay, endDay);
    const results = [];
    const missing = [];
    for (const day of days) {
      status.textContent = `Loading ${day}...`;
      try {
        const item = await loadArchiveDb(day, {
          initSqlJs,
          baseDir: "../archives",
        });
        results.push(item);
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
    applyRangeFilterOptions(merged);
    enableQueryConsole(true);
    const suffix = missing.length ? ` (${missing.length} missing)` : "";
    status.textContent = `Loaded ${results.length} days (${fmtNum(merged.summary.total_rows)} records)${suffix}.`;
    renderAll();
  } catch (err) {
    console.error(err);
    status.textContent = "Range load failed.";
  }
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

  clearBtn.addEventListener("click", () => {
    state.sqliteMode = false;
    state.sqliteScope = "full";
    state.sqliteDb = buildTempDbFromJson();
    state.rangeDays = [];
    applyBaseFilterOptions();
    enableQueryConsole(true);
    status.textContent = "Using full history.";
    renderAll();
  });
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
    if (state.sqliteScope === "range" && state.rangeDays.length) {
      const rows = [];
      let columns = null;
      for (const day of state.rangeDays) {
        try {
          const db = await loadArchiveDbRaw(day, { initSqlJs, baseDir: "../archives" });
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
  `);

  return db;
}

async function init() {
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
  state.sqliteDb = buildTempDbFromJson();

  initControls(state.monthly);
  initSqliteControls();
  applyBaseFilterOptions();
  initQueryConsole();
  enableQueryConsole(true);
  loadFiltersFromUI();
  updateLabel("monthChip", "All Months");
  renderAll();
}

init();
