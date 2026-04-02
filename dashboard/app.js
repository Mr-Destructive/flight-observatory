const STALE_THRESHOLD = 30 * 60000; // 30 minutes
let currentAirportFilter = "";
let charts = new Map();
let liveMap;
let liveFlightLayer;
let liveAirportLayer;
let liveDensityLayer;
let liveTraceLayer;
const liveTrails = new Map();
let airportFilterTimer;
let liveDensityVisible = true;
let lastLiveFlights = [];
let lastLiveSummary = null;
let liveSelectedTraceKey = null;
let dashboardFlights = [];
let dashboardSummary = null;
let dashboardSourceLabel = "Archive view";
let dashboardGeneratedAt = null;
const OPENSKY_API = "https://opensky-network.org/api/states/all";

async function fetchOpenSkyStates(bounds) {
  const query = `?lamin=${bounds?.getSouth?.() ?? -90}&lomin=${bounds?.getWest?.() ?? -180}&lamax=${bounds?.getNorth?.() ?? 90}&lomax=${bounds?.getEast?.() ?? 180}`;
  const url = `https://api.allorigins.win/get?disableCache=true&url=${encodeURIComponent(`${OPENSKY_API}${query}`)}`;
  const res = await fetch(url, { cache: "no-store" });
  if (!res.ok) throw new Error(`API Error: ${res.status}`);
  const payload = await res.json();
  if (payload?.contents) {
    return JSON.parse(payload.contents);
  }
  throw new Error("Unable to fetch live data");
}

// ============================================================================
// Data Fetching
// ============================================================================

async function fetchJson(path, optional = false) {
  try {
    const normalized = String(path).replace(/^\.\//, "");
    const url = new URL(`/data/${normalized.replace(/^data\//, "")}`, window.location.origin);
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

function renderMetrics(summary, flights) {
  const grid = document.getElementById("metricsGrid");
  if (!grid || !summary) return;

  const altitudes = (flights || []).map((r) => r.altitude).filter((v) => typeof v === "number");
  const speeds = (flights || []).map((r) => r.velocity).filter((v) => typeof v === "number");

  const altP90 = computePercentile(altitudes, 0.9);
  const speedP90 = computePercentile(speeds, 0.9);

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
      label: "Avg Alt (m)",
      value: formatNumber(summary.altitude_avg),
      color: "--accent-orange",
    },
    {
      label: "P90 Alt (m)",
      value: formatNumber(altP90),
      color: "--accent-purple",
    },
    {
      label: "Avg Spd (m/s)",
      value: formatNumber(summary.speed_avg),
      color: "--accent-green",
    },
    {
      label: "P90 Spd (m/s)",
      value: formatNumber(speedP90),
      color: "--accent-pink",
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

  const derivedGrid = document.getElementById("liveDerivedMetrics");
  if (!derivedGrid) return;

  const groundDelay = flights.filter(
    (f) =>
      f.on_ground === true &&
      typeof f.velocity === "number" &&
      f.velocity === 0 &&
      typeof f.altitude === "number" &&
      f.altitude < 50
  ).length;
  const approach = flights.filter((f) => typeof f.altitude === "number" && f.altitude < 1500).length;
  const cruise = flights.filter((f) => typeof f.altitude === "number" && f.altitude > 8000).length;
  const approachRatio = cruise ? Math.round((approach / cruise) * 100) : null;

  const headingBins = computeHeadingBins(flights);
  const maxHeading = headingBins.reduce((best, b) => (b.count > best ? b.count : best), 0);
  const headingShare = flights.length ? Math.round((maxHeading / flights.length) * 100) : null;

  const altBins = computeBins(flights, "altitude", 1000);
  const topBand = altBins.length
    ? altBins.reduce((best, b) => (b.count > best.count ? b : best), altBins[0])
    : null;
  const cruiseDominance = topBand && flights.length ? Math.round((topBand.count / flights.length) * 100) : null;

  const corridorCounts = new Map();
  for (const f of flights) {
    if (!f.airport || isUnknownLabel(f.airport) || typeof f.altitude !== "number") continue;
    const band = Math.floor(f.altitude / 1000) * 1000;
    const key = `${f.airport} @ ${band}m`;
    corridorCounts.set(key, (corridorCounts.get(key) || 0) + 1);
  }
  const topCorridor = Array.from(corridorCounts.entries()).sort((a, b) => b[1] - a[1])[0];

  const derived = [
    { label: "Ground Delay Index", value: groundDelay, color: "--accent-orange" },
    {
      label: "Approach/Cruise %",
      value: approachRatio !== null ? `${approachRatio}%` : "--",
      color: "--accent-cyan",
    },
    {
      label: "Heading Dominance",
      value: headingShare !== null ? `${headingShare}%` : "--",
      color: "--accent-purple",
    },
    {
      label: "Cruise Band Share",
      value: cruiseDominance !== null ? `${cruiseDominance}%` : "--",
      color: "--accent-green",
    },
    {
      label: "Busy Corridor",
      value: topCorridor ? cleanLabel(topCorridor[0], "--") : "--",
      color: "--accent-pink",
    },
  ];

  derivedGrid.innerHTML = derived
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

function computePercentile(arr, p) {
  if (!arr || arr.length === 0) return null;
  const sorted = arr.slice().sort((a, b) => a - b);
  const idx = Math.floor(sorted.length * p);
  return sorted[Math.min(idx, sorted.length - 1)];
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

function cleanLabel(value, fallback = "--") {
  return isUnknownLabel(value) ? fallback : String(value);
}

function normalizeFlightRecord(record) {
  if (!record) return null;

  if (Array.isArray(record)) {
    const [icao24, callsign, origin_country, _time_position, _last_contact, lon, lat, altitude, on_ground, velocity, heading, vertical_rate] = record;
    const alt = typeof altitude === "number" ? altitude : null;
    const spd = typeof velocity === "number" ? velocity : null;
    const climb = typeof vertical_rate === "number" ? vertical_rate : null;
    let status = "cruising";
    if (on_ground || (alt !== null && alt < 150)) {
      status = "ground";
    } else if (alt !== null && alt < 4000) {
      if (climb !== null) {
        if (climb < -0.5) status = "landing";
        else if (climb > 0.5) status = "departing";
      } else if (spd !== null && spd < 120) {
        status = "landing";
      }
    }
    return {
      icao24,
      callsign: (callsign || "").trim(),
      airline: record[13] || "",
      origin_country,
      lat,
      lon,
      altitude: alt,
      on_ground: Boolean(on_ground),
      velocity: spd,
      heading,
      status,
    };
  }

  if (typeof record === "object") {
    const alt = typeof record.altitude === "number" ? record.altitude : null;
    const spd = typeof record.velocity === "number" ? record.velocity : null;
    let status = String(record.status || "").toLowerCase();
    if (!status) {
      if (record.on_ground || (alt !== null && alt < 150)) {
        status = "ground";
      } else if (alt !== null && alt < 4000) {
        if (spd !== null && spd < 120) status = "landing";
        else if (spd !== null && spd >= 120) status = "departing";
        else status = "cruising";
      } else {
        status = "cruising";
      }
    }
    return {
      ...record,
      callsign: (record.callsign || "").trim(),
      origin_country: record.origin_country || record.country || "",
      lat: typeof record.lat === "number" ? record.lat : null,
      lon: typeof record.lon === "number" ? record.lon : null,
      altitude: alt,
      on_ground: Boolean(record.on_ground),
      velocity: spd,
      heading: typeof record.heading === "number" ? record.heading : null,
      status,
    };
  }

  return null;
}

function normalizeFlights(records) {
  return (records || []).map(normalizeFlightRecord).filter(Boolean);
}

function buildSnapshotSummary(flights, generatedAt) {
  const altitudes = (flights || []).map((r) => r.altitude).filter((v) => typeof v === "number");
  const speeds = (flights || []).map((r) => r.velocity).filter((v) => typeof v === "number");
  return {
    total_flights: flights.length,
    unique_aircraft: new Set(flights.map((r) => r.icao24).filter(Boolean)).size,
    unique_airlines: new Set(
      flights
        .map((r) => r.airline)
        .filter((value) => value && !isUnknownLabel(value))
    ).size,
    unique_airports: new Set(
      flights
        .map((r) => r.airport || r.nearest_airport)
        .filter((value) => value && !isUnknownLabel(value))
    ).size,
    airborne: flights.filter((r) => !r.on_ground).length,
    on_ground: flights.filter((r) => r.on_ground).length,
    altitude_avg: altitudes.length ? altitudes.reduce((a, b) => a + b, 0) / altitudes.length : null,
    altitude_median: computeMedian(altitudes),
    speed_avg: speeds.length ? speeds.reduce((a, b) => a + b, 0) / speeds.length : null,
    speed_median: computeMedian(speeds),
    generated_at: generatedAt || new Date().toISOString(),
  };
}

function filterFlightsByAirport(flights, filter) {
  const query = (filter || "").trim().toUpperCase();
  if (!query) return flights;
  return flights.filter((flight) => {
    const airport = String(flight.airport || "").toUpperCase();
    const nearest = String(flight.nearest_airport || "").toUpperCase();
    return airport.includes(query) || nearest.includes(query);
  });
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
  
  // Create gradient if it's a line chart
  const background = type === 'line'
    ? CHART_THEME.getGradient(ctx, color)
    : CHART_THEME.withAlpha(color, 0.22);

  const chart = new Chart(ctx, {
    type,
    data: {
      labels,
      datasets: [
        {
          label,
          data,
          ...CHART_THEME.applyDatasetDefaults(type, color),
          backgroundColor: background,
          ...options.dataset,
        },
      ],
    },
    options: {
      ...CHART_THEME.defaults,
      ...options,
      plugins: {
        ...CHART_THEME.defaults.plugins,
        ...(options.plugins || {}),
        tooltip: {
          ...CHART_THEME.defaults.plugins.tooltip,
          ...(options.plugins?.tooltip || {}),
        }
      },
      scales: {
        ...CHART_THEME.defaults.scales,
        ...(options.scales || {}),
      }
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
        `<tr>${columns
          .map((c) => {
            if (c === "airline" || c === "airport" || c === "country") {
              const value = cleanLabel(r[c], "Other");
              if (c === "airline" && window.AirlineLogos?.render) {
                return `<td>${window.AirlineLogos.render(value)}</td>`;
              }
              return `<td>${escapeHtml(value)}</td>`;
            }
            return `<td>${escapeHtml(formatNumber(r[c]))}</td>`;
          })
          .join("")}</tr>`
    )
    .join("");

  el.innerHTML = `<table><thead><tr>${header}</tr></thead><tbody>${body}</tbody></table>`;
}

// ============================================================================
// Data Processing
// ============================================================================

function computeTopN(rows, key, limit = 10, options = {}) {
  const includeUnknown = Boolean(options.includeUnknown);
  const counts = new Map();
  for (const row of rows) {
    const val = String(row[key] || "unknown");
    if (!includeUnknown && isUnknownLabel(val)) continue;
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

function normalizeForCharts(items = []) {
  return items
    .map(([label, count]) => {
      const normalized = (label || "unknown").toString();
      const isUnknown = normalized.toLowerCase() === "unknown";
      const chartValue = isUnknown ? Math.max(1, Math.round(count * 0.15)) : count;
      return { label: normalized, count, chartValue, isUnknown };
    })
    .sort((a, b) => {
      if (a.isUnknown && !b.isUnknown) return 1;
      if (!a.isUnknown && b.isUnknown) return -1;
      return b.chartValue - a.chartValue;
    });
}

function updateLiveMapStatus(text) {
  const el = document.getElementById("liveMapStatus");
  if (el) el.textContent = text;
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
      .bindTooltip(`${label} | ${count} flights`, { direction: "top", permanent: false })
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
    .bindTooltip(`${label}`, {
      direction: "bottom",
      permanent: true,
      className: "airport-label",
      offset: [0, 8],
      opacity: 1,
    })
    .addTo(layer);
}

function highlightLiveTrace(key) {
  if (!liveTraceLayer) return;
  liveSelectedTraceKey = key || null;
  liveTraceLayer.clearLayers();
  const trail = liveTrails.get(key);
  if (!trail || trail.length < 2) return;
  drawRoute(liveTraceLayer, trail.slice(-20), "#67e8f9");
}

function initLiveMap() {
  if (liveMap || typeof L === "undefined") return;
  const mapEl = document.getElementById("liveMap");
  if (!mapEl) return;
  liveMap = L.map(mapEl, {
    zoomControl: true,
    attributionControl: false,
  }).setView([20, 0], 2);
  liveMap.createPane("densityPane");
  liveMap.getPane("densityPane").style.zIndex = 350;
  liveMap.createPane("tracePane");
  liveMap.getPane("tracePane").style.zIndex = 450;
  liveMap.createPane("markerPane");
  liveMap.getPane("markerPane").style.zIndex = 650;
  L.tileLayer("https://{s}.basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}{r}.png", {
    maxZoom: 12,
    minZoom: 2,
    subdomains: "abcd",
    attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> &copy; <a href="https://carto.com/attributions">CARTO</a>',
  }).addTo(liveMap);
  liveFlightLayer = L.layerGroup().addTo(liveMap);
  liveAirportLayer = L.layerGroup().addTo(liveMap);
  liveDensityLayer = L.layerGroup().addTo(liveMap);
  liveTraceLayer = L.layerGroup().addTo(liveMap);
  L.control.scale({ imperial: false }).addTo(liveMap);
  liveMap.on("click", () => {
    liveSelectedTraceKey = null;
    liveTraceLayer?.clearLayers();
  });
  const toggle = document.getElementById("liveDensityToggle");
  toggle?.addEventListener("click", () => {
    liveDensityVisible = !liveDensityVisible;
    toggle.textContent = `Density: ${liveDensityVisible ? "On" : "Off"}`;
    if (!liveMap || !liveDensityLayer) return;
    if (liveDensityVisible) {
      liveMap.addLayer(liveDensityLayer);
    } else {
      liveMap.removeLayer(liveDensityLayer);
    }
    if (lastLiveFlights.length) {
      updateLiveMap(lastLiveFlights, lastLiveSummary);
    }
  });
}

function updateLiveMap(flights, summary, sourceLabel = "Live Feed") {
  initLiveMap();
  if (!liveMap || !liveFlightLayer || !Array.isArray(flights)) return;
  liveFlightLayer.clearLayers();
  liveAirportLayer && liveAirportLayer.clearLayers();
  liveDensityLayer && liveDensityLayer.clearLayers();
  liveTraceLayer && liveTraceLayer.clearLayers();
  const bounds = [];
  const airportClusters = new Map();
  const activeTrails = [];
  const markers = [];

  flights.forEach((flight, index) => {
    const lat = Number(flight.lat);
    const lon = Number(flight.lon);
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) return;
    const color = flight.on_ground ? "#fbbc00" : "#00daf3";
    const marker = L.circleMarker([lat, lon], {
      radius: 8,
      fillColor: color,
      color: "#ebffe2",
      weight: 2,
      opacity: 0.95,
      fillOpacity: 1,
      pane: "markerPane",
    });
    const label = [flight.callsign, flight.airline, flight.icao24].filter(Boolean).join(" | ");
    marker.bindPopup(
      `<strong>${label || flight.icao24 || "Unknown"}</strong><br/>${Math.round(flight.altitude || 0)}m - ${Math.round(
        flight.velocity || 0
      )}m/s`
    );
    marker.on("click", () => {
      const key = flight.icao24 || flight.callsign || `flight-${index}`;
      highlightLiveTrace(key);
    });
    liveFlightLayer.addLayer(marker);
    markers.push(marker);
    bounds.push([lat, lon]);

    const traceKey = flight.icao24 || flight.callsign || `flight-${index}`;
    const trail = liveTrails.get(traceKey) || [];
    trail.push([lat, lon]);
    if (trail.length > 10) trail.shift();
    liveTrails.set(traceKey, trail);
    if (trail.length > 1) activeTrails.push(trail.slice());

    const airportName = flight.airport || flight.nearest_airport;
    if (airportName && !isUnknownLabel(airportName)) {
      const cluster = airportClusters.get(airportName) || { count: 0, latSum: 0, lonSum: 0 };
      cluster.count += 1;
      cluster.latSum += lat;
      cluster.lonSum += lon;
      airportClusters.set(airportName, cluster);
    }
  });

  if (liveDensityLayer) {
    liveDensityLayer.clearLayers();
    if (liveDensityVisible && !liveMap.hasLayer(liveDensityLayer)) {
      liveMap.addLayer(liveDensityLayer);
    }
    if (!liveDensityVisible) {
      liveMap.removeLayer(liveDensityLayer);
    }
  }
  if (liveDensityVisible && liveDensityLayer) {
    airportClusters.forEach((cluster, airport) => {
      const lat = cluster.latSum / cluster.count;
      const lon = cluster.lonSum / cluster.count;
      addHeatBlob(liveDensityLayer, lat, lon, cluster.count, airport);
    });
  }
  if (liveAirportLayer) {
    airportClusters.forEach((cluster, airport) => {
      const lat = cluster.latSum / cluster.count;
      const lon = cluster.lonSum / cluster.count;
      addAirportMarker(liveAirportLayer, lat, lon, airport);
    });
  }

  if (liveSelectedTraceKey && liveTrails.has(liveSelectedTraceKey)) {
    drawRoute(liveTraceLayer, liveTrails.get(liveSelectedTraceKey), "#67e8f9");
  }

  markers.forEach((marker) => marker.bringToFront?.());

  if (bounds.length) {
    liveMap.fitBounds(bounds, { padding: [60, 60], maxZoom: 7 });
    updateLiveMapStatus(`${sourceLabel}: ${flights.length} aircraft - ${summary?.total_flights || flights.length} total`);
  } else {
    liveMap.setView([20, 0], 2);
    updateLiveMapStatus(`${sourceLabel}: no aircraft available right now.`);
  }
}

// ============================================================================
// Main Load Function
// ============================================================================

async function renderDashboard() {
  destroyCharts();
  await window.AirlineLogos?.load?.();

  const filtered = filterFlightsByAirport(dashboardFlights, currentAirportFilter);
  const summary = buildSnapshotSummary(filtered, dashboardGeneratedAt || dashboardSummary?.generated_at);
  lastLiveFlights = filtered;
  lastLiveSummary = summary;

  const lastUpdatedEl = document.getElementById("lastUpdated");
  if (lastUpdatedEl && summary?.generated_at) {
    const date = new Date(summary.generated_at);
    lastUpdatedEl.textContent = date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
  }

  renderMetrics(summary, filtered);

  if (Array.isArray(window.__minuteTraffic) && window.__minuteTraffic.length > 0) {
    createChart(
      "minuteTraffic",
      "line",
      window.__minuteTraffic.map((d) => new Date(d.minute).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })),
      window.__minuteTraffic.map((d) => d.flights),
      "Flights",
      "rgb(34,211,238)"
    );
  }

  if (dashboardFlights.length > 0) {
    const topAirportsChart = normalizeForCharts(computeTopN(filtered, "airport", 12));
    createChart(
      "topAirports",
      "bar",
      topAirportsChart.map((t) => t.label),
      topAirportsChart.map((t) => t.chartValue),
      "Flights",
      "rgb(245,158,11)"
    );

    const altBins = computeBins(filtered, "altitude", 1000);
    createChart("altitudeBands", "bar", altBins.map((d) => `${d.bin}m`), altBins.map((d) => d.count), "Flights", "rgb(167,139,250)");

    const speedBins = computeBins(filtered, "velocity", 50);
    createChart("speedBands", "bar", speedBins.map((d) => `${d.bin}m/s`), speedBins.map((d) => d.count), "Flights", "rgb(251,113,133)");

    const topAirlinesChart = normalizeForCharts(computeTopN(filtered, "airline", 12));
    createChart(
      "topAirlines",
      "bar",
      topAirlinesChart.map((t) => t.label),
      topAirlinesChart.map((t) => t.chartValue),
      "Flights",
      "rgb(52,211,153)"
    );

    const headingBins = computeHeadingBins(filtered);
    createChart("headingBins", "bar", headingBins.map((d) => d.direction), headingBins.map((d) => d.count), "Flights", "rgb(245,158,11)");
  }

  if (dashboardFlights.length > 0) {
    const topAirports = computeTopN(filtered, "airport", 15);
    renderTable("airportTable", topAirports.map(([a, c]) => ({ airport: a, flights: c })), ["airport", "flights"]);

    const topAirlines = computeTopN(filtered, "airline", 15);
    renderTable("airlineTable", topAirlines.map(([a, c]) => ({ airline: a, flights: c })), ["airline", "flights"]);

    const topCountries = computeTopN(filtered, "origin_country", 15);
    renderTable("countryTable", topCountries.map(([c, n]) => ({ country: c, flights: n })), ["country", "flights"]);
  }

  updateLiveMap(filtered, summary, dashboardSourceLabel);
}

async function loadArchiveFallback() {
  const [latest, snapshot, minuteTraffic] = await Promise.all([
    fetchJson("./data/snapshot.json", true),
    fetchJson("./data/latest.json", true),
    fetchJson("./data/minute_traffic.json", true),
  ]);

  dashboardFlights = normalizeFlights(snapshot || latest?.flights || []);
  dashboardSummary = latest?.summary || buildSnapshotSummary(dashboardFlights);
  dashboardGeneratedAt = dashboardSummary?.generated_at || dashboardFlights[0]?.timestamp || new Date().toISOString();
  dashboardSourceLabel = "Archive view";
  window.__minuteTraffic = minuteTraffic || [];
  document.getElementById("update-timer").textContent = "Archive view";
  document.getElementById("status-dot")?.classList.remove("updating");
  document.getElementById("status-dot")?.classList.remove("delayed");
  await renderDashboard();
}

async function loadLiveFeed() {
  const updateTimer = document.getElementById("update-timer");
  const dot = document.getElementById("status-dot");
  const button = document.getElementById("live-feed-button");

  if (updateTimer) updateTimer.textContent = "Syncing live feed...";
  dot?.classList.add("updating");
  button && (button.disabled = true);

  try {
    initLiveMap();
    const bounds = liveMap?.getBounds?.();
    const data = await fetchOpenSkyStates(bounds);
    const flights = normalizeFlights(data.states || []);
    dashboardFlights = flights;
    dashboardSummary = buildSnapshotSummary(flights, new Date().toISOString());
    dashboardGeneratedAt = dashboardSummary.generated_at;
    dashboardSourceLabel = "Live feed";
    await renderDashboard();
    if (updateTimer) updateTimer.textContent = "Live feed";
    dot?.classList.remove("delayed");
  } catch (err) {
    console.error("Observatory Sync Error:", err.message);
    dot?.classList.add("delayed");
    if (!dashboardFlights.length) {
      await loadArchiveFallback();
    } else {
      await renderDashboard();
    }
    if (updateTimer) updateTimer.textContent = dashboardFlights.length ? "Archive view" : "Offline";
  } finally {
    dot?.classList.remove("updating");
    button && (button.disabled = false);
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

function applyAirportFilter() {
  const input = document.getElementById("airportFilter");
  currentAirportFilter = input ? input.value.trim() : "";
  const hint = document.getElementById("airportFilterHint");
  if (hint) {
    hint.textContent = currentAirportFilter
      ? `Showing matches for ${currentAirportFilter.toUpperCase()}.`
      : "Leave blank to show all airports.";
  }
  renderDashboard();
}

document.getElementById("applyFilter").addEventListener("click", applyAirportFilter);

document.getElementById("clearFilter").addEventListener("click", () => {
  currentAirportFilter = "";
  document.getElementById("airportFilter").value = "";
  const hint = document.getElementById("airportFilterHint");
  if (hint) hint.textContent = "Leave blank to show all airports.";
  renderDashboard();
});

document.getElementById("airportFilter").addEventListener("keypress", (e) => {
  if (e.key === "Enter") {
    applyAirportFilter();
  }
});

document.getElementById("airportFilter").addEventListener("input", () => {
  window.clearTimeout(airportFilterTimer);
  airportFilterTimer = window.setTimeout(applyAirportFilter, 180);
});

document.getElementById("live-feed-button")?.addEventListener("click", loadLiveFeed);

// Initial load from archive fallback. Live feed updates are manual.
loadArchiveFallback();
