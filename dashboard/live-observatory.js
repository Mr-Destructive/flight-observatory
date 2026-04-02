/**
 * Airspace Observatory - Live Engine (v3.3)
 * Split-View Layout + Global Airport Intelligence
 */

const OPENSKY_API = "https://opensky-network.org/api/states/all";
const MIN_REQUEST_GAP = 10000; // 10s gap

let state = {
  aircraft: [],
  airports: [],
  userLocation: null,
  summary: { total: 0, landing: 0, departing: 0, cruising: 0, ground: 0 },
  currentFocus: { flights: [], label: "Global View", airport: null, summary: { total: 0, landing: 0, departing: 0, cruising: 0 } },
  selected: null,
  lastUpdated: null,
  lastRequestTime: 0,
  charts: {},
  map: null,
  tileLayer: null,
  isDarkMode: true,
  mode: "archive",
  layers: {
    aircraft: null
  }
};

let viewportRefreshTimer = null;

const EMITTER_CATEGORIES = {
  0: "No information", 1: "No Info", 2: "Light", 3: "Small",
  4: "Large", 5: "High Vortex Large", 6: "Heavy",
  7: "High Performance", 8: "Rotorcraft", 9: "Glider",
  10: "Lighter-than-air", 11: "Parachutist", 12: "Ultralight", 
  14: "UAV", 15: "Space Vehicle", 16: "Emergency",
  17: "Service Vehicle", 18: "Point Obstacle"
};

const PLANE_SVG = (color) => `
<svg width="24" height="24" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
  <path d="M21 16L21 14L13 9L13 3.5C13 2.67 12.33 2 11.5 2C10.67 2 10 2.67 10 3.5L10 9L2 14L2 16L10 13.5L10 19L8 20.5L8 22L11.5 21L15 22L15 20.5L13 19L13 13.5L21 16Z" fill="${color}"/>
</svg>`;

async function fetchJson(path, optional = false) {
  const normalized = String(path).replace(/^\.\//, "").replace(/^\/+/, "");
  const candidates = Array.from(new Set([
    `/${normalized}`,
    `/dashboard/${normalized}`,
  ]));

  try {
    for (const candidate of candidates) {
      try {
        const res = await fetch(candidate, { cache: "no-store" });
        if (res.ok) return await res.json();
      } catch (err) {
        // Try the next candidate.
      }
    }
  } catch (err) {
    if (!optional) console.error(`Fetch error for ${path}:`, err);
  }
  if (!optional) console.error(`Fetch error for ${path}:`, new Error("No archive data root matched"));
  return null;
}

async function fetchOpenSkyStates(bounds) {
  const query = `?lamin=${bounds.getSouth()}&lomin=${bounds.getWest()}&lamax=${bounds.getNorth()}&lomax=${bounds.getEast()}`;
  const url = `https://api.allorigins.win/get?disableCache=true&url=${encodeURIComponent(`${OPENSKY_API}${query}`)}`;
  const res = await fetch(url, { cache: "no-store" });
  if (!res.ok) throw new Error(`API Error: ${res.status}`);
  const payload = await res.json();
  if (payload?.contents) {
    return JSON.parse(payload.contents);
  }
  throw new Error("Unable to fetch live data");
}

function normalizeFlightRecord(record) {
  if (!record) return null;
  if (Array.isArray(record)) {
    const [icao, callsign, country, , , lon, lat, alt, onGround, velocity, heading, vRate, , , squawk, , category] = record;
    let status = "cruising";
    if (onGround || (alt !== null && alt < 150)) status = "ground";
    else if (alt !== null && alt < 4000) {
      if (typeof vRate === "number") {
        if (vRate < -0.5) status = "landing";
        else if (vRate > 0.5) status = "departing";
      } else if (typeof velocity === "number") {
        status = velocity < 160 ? "landing" : "departing";
      }
    }
    return { icao, callsign: (callsign || "").trim(), lat, lon, alt, vRate, velocity, heading, status, onGround, country, squawk, category };
  }

  if (typeof record === "object") {
    const alt = typeof record.altitude === "number" ? record.altitude : null;
    const velocity = typeof record.velocity === "number" ? record.velocity : null;
    const onGround = Boolean(record.on_ground);
    let status = String(record.status || "").toLowerCase();
    if (!status) {
      if (onGround || (alt !== null && alt < 150)) status = "ground";
      else if (alt !== null && alt < 4000) {
        status = velocity !== null && velocity < 160 ? "landing" : "departing";
      } else {
        status = "cruising";
      }
    }
    return {
      icao: record.icao24 || record.icao || record.hex || "",
      callsign: (record.callsign || "").trim(),
      lat: typeof record.lat === "number" ? record.lat : null,
      lon: typeof record.lon === "number" ? record.lon : null,
      alt,
      vRate: typeof record.vRate === "number" ? record.vRate : null,
      velocity,
      heading: typeof record.heading === "number" ? record.heading : null,
      status,
      onGround,
      country: record.origin_country || record.country || "",
      squawk: record.squawk || "",
      category: record.category,
      airline: record.airline || "",
      airport: record.airport || "",
      nearest_airport: record.nearest_airport || "",
    };
  }

  return null;
}

function formatMapLocation(lat, lon) {
  return `${Number(lat).toFixed(2)}, ${Number(lon).toFixed(2)}`;
}

function normalizeAirportName(name = "") {
  return String(name)
    .split(" Intl")[0]
    .split(" International")[0]
    .trim();
}

function findNearestAirport(center) {
  if (!center || !Array.isArray(state.airports) || !state.airports.length || !state.map) return null;
  let best = null;
  let bestDistance = Infinity;
  for (const airport of state.airports) {
    if (!Number.isFinite(airport.lat) || !Number.isFinite(airport.lon)) continue;
    const distance = state.map.distance([airport.lat, airport.lon], center);
    if (distance < bestDistance) {
      best = airport;
      bestDistance = distance;
    }
  }
  return best ? { ...best, distanceKm: bestDistance / 1000 } : null;
}

function describeFocusLocation(center) {
  if (!center) return "Global View";
  const nearbyAirport = findNearestAirport(center);
  if (nearbyAirport && nearbyAirport.distanceKm <= 8) {
    return normalizeAirportName(nearbyAirport.name || nearbyAirport.ident || "Airspace");
  }
  if (state.userLocation && Number.isFinite(state.userLocation.lat) && Number.isFinite(state.userLocation.lon)) {
    const userDistance = state.map.distance([state.userLocation.lat, state.userLocation.lon], center);
    if (userDistance <= 12000) {
      return "your location";
    }
  }
  return formatMapLocation(center.lat, center.lng);
}

function syncViewLocation() {
  if (!state.map) return;
  const viewLocation = document.getElementById("view-location");
  if (!viewLocation) return;
  const center = state.map.getCenter?.();
  const label = describeFocusLocation(center);
  if (label) viewLocation.textContent = label;
}

async function centerMapOnUserOrDefault() {
  const fallback = [19.0896, 72.8656];
  if (!state.map) return;

  if (!navigator.geolocation) {
    state.map.setView(fallback, 10, { animate: false });
    return;
  }

  await new Promise((resolve) => {
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        state.userLocation = {
          lat: Number(pos.coords.latitude),
          lon: Number(pos.coords.longitude),
        };
        if (Number.isFinite(state.userLocation.lat) && Number.isFinite(state.userLocation.lon)) {
          state.map.setView([state.userLocation.lat, state.userLocation.lon], 8, { animate: false });
        } else {
          state.map.setView(fallback, 10, { animate: false });
        }
        resolve();
      },
      () => {
        state.map.setView(fallback, 10, { animate: false });
        resolve();
      },
      { enableHighAccuracy: false, timeout: 3500, maximumAge: 60000 }
    );
  });
}

async function init() {
  console.log("Observatory: Initializing v3.3 (Split View)...");
  
  state.isDarkMode = localStorage.getItem("theme") !== "light";
  applyTheme();

  try {
    state.airports =
      (await fetchJson("data/airports_meta.json", true)) ||
      (await fetchJson("airports_meta.json", true)) ||
      [];
  } catch (e) { console.error("Airport DB Load Error"); }

  initMap();
  await centerMapOnUserOrDefault();
  initCharts();
  await loadArchiveSnapshot();
  setupListeners();
}

function initMap() {
  state.map = L.map("map", { zoomControl: true, attributionControl: false }).setView([19.0896, 72.8656], 10);
  updateMapStyle();
  state.layers.aircraft = L.layerGroup().addTo(state.map);
}

function updateMapStyle() {
  if (state.tileLayer) state.map.removeLayer(state.tileLayer);
  const style = state.isDarkMode ? "dark_all" : "light_all";
  state.tileLayer = L.tileLayer(`https://{s}.basemaps.cartocdn.com/${style}/{z}/{x}/{y}{r}.png`, {
    maxZoom: 14, minZoom: 2, subdomains: "abcd"
  }).addTo(state.map);
}

function initCharts() {
  const theme = getChartTheme();
  const chartOptions = {
    responsive: true, maintainAspectRatio: false,
    plugins: { legend: { display: false }, tooltip: { enabled: true, backgroundColor: state.isDarkMode ? 'rgba(13, 20, 29, 0.9)' : 'rgba(255, 255, 255, 0.9)' } },
    scales: {
      y: { grid: { color: theme.grid }, ticks: { color: theme.text, font: { size: 9 } } },
      x: { grid: { display: false }, ticks: { color: theme.text, font: { size: 9 } } }
    }
  };

  state.charts.altitude = new Chart(document.getElementById("chart-altitude"), { type: "bar", data: { labels: [], datasets: [{ data: [], backgroundColor: "#00daf3", borderRadius: 4 }] }, options: chartOptions });
  state.charts.speed = new Chart(document.getElementById("chart-speed"), { type: "bar", data: { labels: [], datasets: [{ data: [], backgroundColor: "#fbbc00", borderRadius: 4 }] }, options: chartOptions });
  state.charts.heading = new Chart(document.getElementById("chart-heading"), { 
    type: "radar", 
    data: { labels: ["N", "NE", "E", "SE", "S", "SW", "W", "NW"], datasets: [{ data: [], backgroundColor: "rgba(0, 230, 57, 0.1)", borderColor: "#00e639", pointRadius: 0 }] }, 
    options: { ...chartOptions, scales: { r: { grid: { color: theme.grid }, angleLines: { color: theme.grid }, ticks: { display: false }, pointLabels: { color: theme.text, font: { size: 9 } } } } }
  });
}

function getChartTheme() {
  return state.isDarkMode ? { grid: "rgba(255,255,255,0.05)", text: "#84967e" } : { grid: "rgba(0,0,0,0.05)", text: "#64748b" };
}

async function update(isManual = false) {
  const now = Date.now();
  const updateTimer = document.getElementById("update-timer");
  const dot = document.getElementById("status-dot");

  // Global Throttle: Prevent requests if they are too close together
  if (now - state.lastRequestTime < MIN_REQUEST_GAP) {
    console.warn("Observatory: Throttling request to protect API limits.");
    if (isManual) updateTimer.textContent = "Cooling down...";
    return;
  }

  updateTimer.textContent = "Syncing...";
  dot.classList.add("updating");
  state.lastRequestTime = now;
  
  try {
    const bounds = state.map.getBounds();
    const data = await fetchOpenSkyStates(bounds);
    processData(data.states || []);
    state.mode = "live";
    dot.classList.remove("delayed", "updating");
    updateTimer.textContent = "Live Feed";
    const lastUpdate = document.getElementById("last-update-time");
    if (lastUpdate) lastUpdate.textContent = "";
    
    render();
    checkAirportFocus();
  } catch (err) {
    console.error("Observatory Sync Error:", err.message);
    dot.classList.add("delayed");
    dot.classList.remove("updating");
    updateTimer.textContent = "Archive view";
    const lastUpdate = document.getElementById("last-update-time");
    if (lastUpdate) lastUpdate.textContent = "Live feed unavailable";
  }
}

function processData(rawStates) {
  state.aircraft = (rawStates || []).map(normalizeFlightRecord).filter(Boolean);

  state.summary = {
    total: state.aircraft.length,
    landing: state.aircraft.filter(a => a.status === "landing").length,
    departing: state.aircraft.filter(a => a.status === "departing").length,
    cruising: state.aircraft.filter(a => a.status === "cruising").length
  };
}

function buildViewportSummary(flights = []) {
  return {
    total: flights.length,
    landing: flights.filter((a) => a.status === "landing").length,
    departing: flights.filter((a) => a.status === "departing").length,
    cruising: flights.filter((a) => a.status === "cruising").length,
  };
}

function safeFilenamePart(value) {
  return String(value || "current-view")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "") || "current-view";
}

function exportFlightRecord(a) {
  return {
    icao: a.icao || "",
    callsign: a.callsign || "",
    status: a.status || "",
    lat: Number.isFinite(a.lat) ? a.lat : null,
    lon: Number.isFinite(a.lon) ? a.lon : null,
    alt: Number.isFinite(a.alt) ? a.alt : null,
    velocity: Number.isFinite(a.velocity) ? a.velocity : null,
    heading: Number.isFinite(a.heading) ? a.heading : null,
    vRate: Number.isFinite(a.vRate) ? a.vRate : null,
    country: a.country || "",
    squawk: a.squawk || "",
    category: a.category ?? null,
    airline: a.airline || "",
    airport: a.airport || "",
    nearest_airport: a.nearest_airport || "",
  };
}

function escapeCsvValue(value) {
  if (value === null || value === undefined) return "";
  const text = String(value);
  if (/[",\n]/.test(text)) {
    return `"${text.replace(/"/g, '""')}"`;
  }
  return text;
}

function buildCurrentViewExport() {
  const focus = state.currentFocus?.flights ? state.currentFocus : getViewportFocus(state.aircraft);
  const flights = Array.isArray(focus.flights) ? focus.flights : [];
  const summary = buildViewportSummary(flights);
  return {
    generated_at: new Date().toISOString(),
    focus_label: focus.label || "Current map view",
    summary,
    airport: focus.airport
      ? {
          ident: focus.airport.ident || "",
          iata: focus.airport.iata || "",
          name: focus.airport.name || "",
          elev: Number.isFinite(focus.airport.elev) ? focus.airport.elev : null,
          lat: Number.isFinite(focus.airport.lat) ? focus.airport.lat : null,
          lon: Number.isFinite(focus.airport.lon) ? focus.airport.lon : null,
        }
      : null,
    flights: flights.map(exportFlightRecord),
  };
}

function downloadCurrentView(format) {
  const exportData = buildCurrentViewExport();
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const namePart = safeFilenamePart(exportData.focus_label);
  const filename = `flight-observatory-${namePart}-${stamp}.${format === "csv" ? "csv" : "json"}`;
  const mime = format === "csv" ? "text/csv;charset=utf-8" : "application/json;charset=utf-8";
  const content = format === "csv"
    ? (() => {
        const rows = exportData.flights;
        const header = ["icao","callsign","status","lat","lon","alt","velocity","heading","vRate","country","squawk","category","airline","airport","nearest_airport"];
        const lines = [header.join(",")];
        for (const row of rows) {
          lines.push(header.map((key) => escapeCsvValue(row[key])).join(","));
        }
        return lines.join("\n");
      })()
    : JSON.stringify(exportData, null, 2);

  const blob = new Blob([content], { type: mime });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  URL.revokeObjectURL(url);
}

function updateAnalysisPanel(focus, summary) {
  const location = document.getElementById("analysis-focus-location");
  const summaryNode = document.getElementById("analysis-focus-summary");
  if (location) location.textContent = focus?.label || "Current map view";
  if (summaryNode) {
    summaryNode.textContent = `${summary.total} aircraft visible in the current map view. ${summary.landing} landing, ${summary.departing} departing, and ${summary.cruising} cruising.`;
  }
}

async function loadArchiveSnapshot() {
  const snapshot = await fetchJson("data/snapshot.json", true);
  const latest = await fetchJson("data/latest.json", true);
  const flights = Array.isArray(snapshot) ? snapshot : Array.isArray(latest?.flights) ? latest.flights : [];
  processData(flights);
  state.mode = "archive";
  const updateTimer = document.getElementById("update-timer");
  if (updateTimer) updateTimer.textContent = "Archive view";
  const lastUpdate = document.getElementById("last-update-time");
  if (lastUpdate) lastUpdate.textContent = "";
  const dot = document.getElementById("status-dot");
  dot?.classList.remove("updating", "delayed");
  render();
  checkAirportFocus();
}

function render() {
  state.layers.aircraft.clearLayers();
  state.aircraft.forEach(a => {
    if (a.lat === null || a.lon === null) return;
    const color = getStatusColor(a.status);
    const marker = L.divIcon({
      className: "aircraft-marker",
      html: `<div style="transform: rotate(${a.heading || 0}deg); width: 24px; height: 24px; display: flex; align-items: center; justify-content: center; filter: drop-shadow(0 0 4px ${color}88);">${PLANE_SVG(color)}</div>`,
      iconSize: [24, 24], iconAnchor: [12, 12]
    });
    L.marker([a.lat, a.lon], { icon: marker }).addTo(state.layers.aircraft).on("click", () => selectAircraft(a));
  });
  refreshViewportDashboard();
}

function updateCharts(flights = state.aircraft) {
  const altBins = new Array(13).fill(0);
  const speedBins = new Array(10).fill(0);
  const headBins = new Array(8).fill(0);

  flights.forEach(a => {
    if (a.alt !== null) altBins[Math.min(12, Math.floor(a.alt / 1000))]++;
    if (a.velocity !== null) speedBins[Math.min(9, Math.floor((a.velocity * 1.94384) / 100))]++;
    if (a.heading !== null) headBins[Math.round(a.heading / 45) % 8]++;
  });

  state.charts.altitude.data.labels = altBins.map((_, i) => `${i}k`);
  state.charts.altitude.data.datasets[0].data = altBins;
  state.charts.altitude.update();

  state.charts.speed.data.labels = speedBins.map((_, i) => `${i*100}`);
  state.charts.speed.data.datasets[0].data = speedBins;
  state.charts.speed.update();

  state.charts.heading.data.datasets[0].data = headBins;
  state.charts.heading.update();
}

function getViewportFocus(flights = state.aircraft) {
  if (!state.map) {
    return { flights, label: "Global View", airport: null };
  }

  const bounds = state.map.getBounds?.();
  const zoom = state.map.getZoom?.() ?? 0;
  const center = state.map.getCenter?.();
  const visibleFlights = bounds
    ? flights.filter((a) => a.lat !== null && a.lon !== null && bounds.contains([a.lat, a.lon]))
    : [];

  const nearestAirport = findNearestAirport(center);
  const activeAirport = nearestAirport && nearestAirport.distanceKm <= 8 ? nearestAirport : null;

  if (visibleFlights.length) {
    return {
      flights: visibleFlights,
      label: describeFocusLocation(center),
      airport: activeAirport,
    };
  }

  if (zoom >= 6 && center) {
    const radiusKm = zoom >= 14 ? 3 : zoom >= 12 ? 6 : zoom >= 10 ? 10 : zoom >= 8 ? 18 : 30;
    const centerFlights = flights.filter(
      (a) =>
        a.lat !== null &&
        a.lon !== null &&
        state.map.distance([a.lat, a.lon], center) < radiusKm * 1000
    );
    if (centerFlights.length) {
      return {
        flights: centerFlights,
        label: describeFocusLocation(center),
        airport: activeAirport,
        radiusKm,
      };
    }
  }

  return { flights, label: describeFocusLocation(center), airport: activeAirport };
}

function refreshViewportDashboard() {
  window.clearTimeout(viewportRefreshTimer);
  viewportRefreshTimer = window.setTimeout(() => {
    const focus = getViewportFocus(state.aircraft);
    const summary = buildViewportSummary(focus.flights);
    state.currentFocus = { ...focus, summary };
    const lastUpdate = document.getElementById("last-update-time");

    document.getElementById("count-total").textContent = summary.total;
    document.getElementById("count-landing").textContent = summary.landing;
    document.getElementById("count-departing").textContent = summary.departing;
    document.getElementById("count-cruising").textContent = summary.cruising;

    if (lastUpdate) {
      lastUpdate.textContent = `Focus: ${summary.total} aircraft`;
    }

    updateAnalysisPanel(focus, summary);
    updateCharts(focus.flights);
    checkAirportFocus(focus);
    syncViewLocation();
  }, 50);
}

function checkAirportFocus(focus = null) {
  if (!state.map) return;
  const center = state.map.getCenter?.();
  const zoom = state.map.getZoom?.() ?? 0;
  const bar = document.getElementById("airport-detail-bar");
  const viewLocation = document.getElementById("view-location");
  const activeAirport = center
    ? focus?.airport || state.airports.find((ap) =>
        Number.isFinite(ap?.lat) && Number.isFinite(ap?.lon) && state.map.distance([ap.lat, ap.lon], center) < 8000
      )
    : focus?.airport || null;

  if (activeAirport && zoom >= 9) {
    if (!center) {
      bar.style.display = "none";
      viewLocation.textContent = focus?.label || "Global View";
      return;
    }
    bar.style.display = "block";
    document.getElementById("ap-code").textContent = `${activeAirport.ident} / ${activeAirport.iata || '---'}`;
    document.getElementById("ap-name").textContent = activeAirport.name;
    document.getElementById("ap-elev").textContent = `${activeAirport.elev} ft`;
    document.getElementById("ap-coords").textContent = `${activeAirport.lat.toFixed(2)}, ${activeAirport.lon.toFixed(2)}`;
    
    const local = Array.isArray(focus?.flights)
      ? focus.flights
      : state.aircraft.filter((a) =>
          Number.isFinite(a?.lat) &&
          Number.isFinite(a?.lon) &&
          state.map.distance([a.lat, a.lon], [activeAirport.lat, activeAirport.lon]) < 25000
        );
    document.getElementById("ap-in").textContent = local.filter(a => a.status === "landing").length;
    document.getElementById("ap-out").textContent = local.filter(a => a.status === "departing").length;
    document.getElementById("ap-intensity").textContent = local.length > 15 ? "BUSY" : "QUIET";

    viewLocation.textContent = focus?.label || activeAirport.name.split(" Intl")[0].split(" International")[0];
  } else {
    bar.style.display = "none";
    viewLocation.textContent = focus?.label || (center ? (zoom > 5 ? "Local Airspace" : "Global View") : "Global View");
  }
}

function selectAircraft(a) {
  state.selected = a;
  document.getElementById("side-panel").classList.add("active");
  document.getElementById("panel-callsign").textContent = a.callsign || a.icao.toUpperCase();
  const statusPill = document.getElementById("panel-status-pill");
  statusPill.textContent = a.status;
  statusPill.style.background = getStatusColor(a.status) + "22";
  statusPill.style.color = getStatusColor(a.status);
  
  document.getElementById("panel-alt").textContent = a.alt !== null ? `${Math.round(a.alt)}m` : "---";
  document.getElementById("panel-speed").textContent = a.velocity !== null ? `${Math.round(a.velocity * 1.94384)}kt` : "---";
  document.getElementById("panel-heading").textContent = a.heading !== null ? `${Math.round(a.heading)}°` : "---";
  document.getElementById("panel-vrate").textContent = a.vRate !== null ? `${a.vRate.toFixed(1)}m/s` : "---";
  document.getElementById("panel-country").textContent = a.country || "Unknown";
  document.getElementById("panel-category").textContent = EMITTER_CATEGORIES[a.category] || "No Data";
  
  document.getElementById("panel-insight").textContent = a.status === "landing" ? "Significant descent. Final approach." : a.status === "departing" ? "Active climb. Departing airspace." : "Maintaining cruise altitude.";
}

function toggleTheme() {
  state.isDarkMode = !state.isDarkMode;
  localStorage.setItem("theme", state.isDarkMode ? "dark" : "light");
  applyTheme();
  [state.charts.altitude, state.charts.speed, state.charts.heading].forEach(c => c && c.destroy());
  initCharts();
  refreshViewportDashboard();
}

function applyTheme() {
  document.body.classList.toggle("light-mode", !state.isDarkMode);
  document.documentElement.dataset.theme = state.isDarkMode ? "dark" : "light";
  document.documentElement.style.colorScheme = state.isDarkMode ? "dark" : "light";
  updateThemeUI();
  if (state.map) updateMapStyle();
}

function updateThemeUI() {
  const icon = document.getElementById("theme-icon");
  const text = document.getElementById("theme-text");
  icon.textContent = state.isDarkMode ? "🌙" : "☀️";
  text.textContent = state.isDarkMode ? "Dark Mode" : "Light Mode";
}

function setupRailSplitter() {
  const splitter = document.getElementById("rail-splitter");
  if (!splitter) return;

  const minWidth = 320;
  const maxWidth = 520;
  let dragging = false;

  const applyWidth = (x) => {
    const next = Math.max(minWidth, Math.min(maxWidth, Math.round(x)));
    document.documentElement.style.setProperty("--rail-width", `${next}px`);
    state.map?.invalidateSize?.();
  };

  splitter.addEventListener("pointerdown", (event) => {
    dragging = true;
    document.body.classList.add("is-resizing");
    splitter.setPointerCapture?.(event.pointerId);
    event.preventDefault();
  });

  window.addEventListener("pointermove", (event) => {
    if (!dragging) return;
    applyWidth(event.clientX);
  });

  const finish = () => {
    if (!dragging) return;
    dragging = false;
    document.body.classList.remove("is-resizing");
    state.map?.invalidateSize?.();
  };

  window.addEventListener("pointerup", finish);
  window.addEventListener("pointercancel", finish);
}

function setupAnalysisToggle() {
  const toggleBtn = document.getElementById("analysis-toggle");
  const closeBtn = document.getElementById("analysis-close");
  const overlay = document.getElementById("analysis-overlay");
  const backdrop = document.getElementById("analysis-backdrop");
  const openPanel = () => {
    document.body.classList.add("analysis-open");
    overlay?.setAttribute("aria-hidden", "false");
    requestAnimationFrame(() => {
      Object.values(state.charts).forEach((chart) => chart?.resize?.());
    });
  };
  const closePanel = () => {
    document.body.classList.remove("analysis-open");
    overlay?.setAttribute("aria-hidden", "true");
  };
  const redraw = () => {
    requestAnimationFrame(() => {
      Object.values(state.charts).forEach((chart) => chart?.resize?.());
    });
  };

  toggleBtn?.addEventListener("click", () => {
    if (document.body.classList.contains("analysis-open")) closePanel();
    else openPanel();
    redraw();
  });
  closeBtn?.addEventListener("click", closePanel);
  backdrop?.addEventListener("click", closePanel);
  window.closeAnalysis = closePanel;
  window.openAnalysis = openPanel;
}

function getStatusColor(status) {
  const colors = { landing: "#00daf3", departing: "#fbbc00", cruising: "#00e639", ground: "#84967e" };
  return colors[status] || "#ffffff";
}

function setupListeners() {
  state.map.on("moveend", () => { syncViewLocation(); refreshViewportDashboard(); });
  state.map.on("zoomend", () => { syncViewLocation(); refreshViewportDashboard(); });
  state.map.on("move", () => { syncViewLocation(); refreshViewportDashboard(); });
  state.map.on("zoom", () => { syncViewLocation(); refreshViewportDashboard(); });
  window.addEventListener("keydown", (e) => {
    if (e.key === "Escape") {
      if (document.body.classList.contains("analysis-open")) window.closeAnalysis?.();
      else closePanel();
    }
  });
  document.getElementById("live-feed-button")?.addEventListener("click", () => update(true));
  document.getElementById("analysis-download-json")?.addEventListener("click", () => downloadCurrentView("json"));
  document.getElementById("analysis-download-csv")?.addEventListener("click", () => downloadCurrentView("csv"));
  setupRailSplitter();
  setupAnalysisToggle();
}

function closePanel() {
  document.getElementById("side-panel").classList.remove("active");
  state.selected = null;
}

document.addEventListener("DOMContentLoaded", init);
window.closePanel = closePanel;
window.toggleTheme = toggleTheme;
