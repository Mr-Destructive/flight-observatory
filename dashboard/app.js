let currentAirport = "";
let charts = [];

async function fetchJson(path) {
  const res = await fetch(path);
  if (!res.ok) {
    throw new Error(`Fetch failed: ${path} (${res.status})`);
  }
  return res.json();
}

function formatMinute(ts) {
  const d = new Date(ts);
  return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

function updateTimestamp() {
  const el = document.getElementById("last-updated");
  const now = new Date();
  el.textContent = `Last updated: ${now.toLocaleString()}`;
}

function buildChart(ctx, type, labels, data, label, color) {
  const chart = new Chart(ctx, {
    type,
    data: {
      labels,
      datasets: [
        {
          label,
          data,
          borderColor: color,
          backgroundColor: color,
          fill: type === "line",
          tension: 0.35,
        },
      ],
    },
    options: {
      responsive: true,
      plugins: {
        legend: { display: false },
      },
      scales: {
        x: {
          ticks: { color: "#b5c0d0" },
          grid: { color: "rgba(255,255,255,0.06)" },
        },
        y: {
          ticks: { color: "#b5c0d0" },
          grid: { color: "rgba(255,255,255,0.06)" },
        },
      },
    },
  });
  charts.push(chart);
  return chart;
}

async function loadCharts() {
  charts.forEach((c) => c.destroy());
  charts = [];

  const [snapshot, minuteTraffic] =
    await Promise.all([
      fetchJson("./data/snapshot.json"),
      fetchJson("./data/minute_traffic.json"),
    ]);

  const filtered = currentAirport
    ? snapshot.filter((r) =>
        (r.airport || "").toUpperCase() === currentAirport.toUpperCase()
      )
    : snapshot;

  const topAirports = computeTop(snapshot, "airport", 10).map(([k, v]) => ({
    airport: k,
    flights: v,
  }));
  const altitudeBands = computeBins(filtered, "altitude", 1000, "altitude_band_m");
  const speedBands = computeBins(filtered, "velocity", 50, "speed_band_ms");
  const topAirlines = computeTop(filtered, "airline", 10).map(([k, v]) => ({
    airline: k,
    flights: v,
  }));

  buildChart(
    document.getElementById("topAirports"),
    "bar",
    topAirports.map((d) => d.airport),
    topAirports.map((d) => d.flights),
    "Flights",
    "#f4b266"
  );

  buildChart(
    document.getElementById("altitudeBands"),
    "bar",
    altitudeBands.map((d) => `${d.altitude_band_m}`),
    altitudeBands.map((d) => d.flights),
    "Flights",
    "#7bdff6"
  );

  buildChart(
    document.getElementById("speedBands"),
    "bar",
    speedBands.map((d) => `${d.speed_band_ms}`),
    speedBands.map((d) => d.flights),
    "Flights",
    "#c2a5ff"
  );

  buildChart(
    document.getElementById("topAirlines"),
    "bar",
    topAirlines.map((d) => d.airline),
    topAirlines.map((d) => d.flights),
    "Flights",
    "#ffcf87"
  );

  buildChart(
    document.getElementById("minuteTraffic"),
    "line",
    minuteTraffic.map((d) => formatMinute(d.minute)),
    minuteTraffic.map((d) => d.flights),
    "Flights",
    "#f4b266"
  );

  updateTimestamp();
}

async function boot() {
  try {
    await loadCharts();
    const applyBtn = document.getElementById("applyFilter");
    const clearBtn = document.getElementById("clearFilter");
    const input = document.getElementById("airportFilter");

    applyBtn.addEventListener("click", async () => {
      currentAirport = input.value.trim();
      await loadCharts();
    });

    clearBtn.addEventListener("click", async () => {
      currentAirport = "";
      input.value = "";
      await loadCharts();
    });

    setInterval(async () => {
      try {
        await loadCharts();
      } catch (err) {
        console.error(err);
      }
    }, 60000);
  } catch (err) {
    console.error(err);
  }
}

boot();

function computeTop(rows, key, limit) {
  const counts = new Map();
  for (const r of rows) {
    const val = (r[key] || "unknown").toString();
    counts.set(val, (counts.get(val) || 0) + 1);
  }
  return [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, limit);
}

function computeBins(rows, key, size, outKey) {
  const counts = new Map();
  for (const r of rows) {
    const val = r[key];
    if (typeof val !== "number") continue;
    const bucket = Math.floor(val / size) * size;
    counts.set(bucket, (counts.get(bucket) || 0) + 1);
  }
  return [...counts.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([bucket, count]) => ({ [outKey]: bucket, flights: count }));
}
