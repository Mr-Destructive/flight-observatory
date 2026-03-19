const charts = new Map();

// ============================================================================
// Data Fetching
// ============================================================================

async function fetchJson(path) {
  try {
    const basePath = window.location.pathname.split('/').slice(0, -1).join('/');
    const fullPath = basePath + '/' + path;
    const res = await fetch(fullPath);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json();
  } catch (err) {
    console.error(`Fetch error for ${path}:`, err);
    return null;
  }
}

// ============================================================================
// Chart Creation
// ============================================================================

function createChart(canvasId, type, labels, data, color, yLabel = "") {
  const canvas = document.getElementById(canvasId);
  if (!canvas) return null;

  const ctx = canvas.getContext("2d");
  const chart = new Chart(ctx, {
    type,
    data: {
      labels,
      datasets: [
        {
          label: yLabel || "Value",
          data,
          borderColor: color,
          backgroundColor:
            type === "line" ? color.replace(/[^,]+(?=\))/, "0.1") : color + "40",
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
          ticks: { color: "#6b7280", maxRotation: 45 },
          grid: { color: "rgba(255, 255, 255, 0.05)", drawBorder: false },
        },
        y: {
          ticks: { color: "#6b7280" },
          grid: { color: "rgba(255, 255, 255, 0.05)", drawBorder: false },
        },
      },
    },
  });

  charts.set(canvasId, chart);
  return chart;
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

function renderMetricsTable(elementId, metrics) {
  const el = document.getElementById(elementId);
  if (!el || !metrics || typeof metrics !== "object") {
    if (el) el.innerHTML = '<div class="hint">No metrics available</div>';
    return;
  }

  const rows = Object.entries(metrics)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, value]) => {
      let formatted = value;
      if (typeof value === "number") {
        formatted = Number.isInteger(value)
          ? value.toLocaleString()
          : value.toFixed(2);
      } else if (Array.isArray(value) || (value && typeof value === "object")) {
        formatted = JSON.stringify(value);
      }
      return { metric: key, value: formatted };
    });

  renderTable(elementId, rows, ["metric", "value"]);
}

function renderInsights(elementId, insights) {
  const el = document.getElementById(elementId);
  if (!el) return;

  if (!insights || !Array.isArray(insights) || insights.length === 0) {
    el.innerHTML = '<div class="hint">No insights available</div>';
    return;
  }

  el.innerHTML = insights
    .map(
      (insight) => `
    <article class="insight-card">
      <div class="insight-tag">${insight.category || insight.tag || "Insight"}</div>
      <h4>${insight.title}</h4>
      <p>${insight.detail || insight.description}</p>
    </article>
  `
    )
    .join("");
}

// ============================================================================
// Main Load Function
// ============================================================================

async function loadHistoricalDashboard() {
  const [monthly, summary, detailed] = await Promise.all([
    fetchJson("./data/historical_monthly.json"),
    fetchJson("./data/historical_summary.json"),
    fetchJson("./data/historical_detailed.json"),
  ]);

  if (!monthly || !summary) {
    console.warn("Missing historical data files");
    return;
  }

  // Update header info
  if (summary.total_rows) {
    document.getElementById("totalRows").textContent =
      summary.total_rows.toLocaleString();
  }
  if (summary.months) {
    document.getElementById("timeSpan").textContent =
      summary.months + " months";
  }

  // ========================================================================
  // Monthly Trends
  // ========================================================================

  if (Array.isArray(monthly) && monthly.length > 0) {
    createChart(
      "monthlyActivity",
      "line",
      monthly.map((d) => d.month),
      monthly.map((d) => d.count),
      "rgb(6, 182, 212)",
      "Flights"
    );

    createChart(
      "altitudeMonthly",
      "line",
      monthly.map((d) => d.month),
      monthly.map((d) => d.alt_median || 0),
      "rgb(249, 115, 22)",
      "Altitude (m)"
    );

    createChart(
      "speedMonthly",
      "line",
      monthly.map((d) => d.month),
      monthly.map((d) => d.speed_median || 0),
      "rgb(168, 85, 247)",
      "Speed (m/s)"
    );
  }

  // ========================================================================
  // Yearly Totals
  // ========================================================================

  if (summary.yearly_counts && Array.isArray(summary.yearly_counts)) {
    createChart(
      "yearlyTotals",
      "bar",
      summary.yearly_counts.map((d) => String(d.year)),
      summary.yearly_counts.map((d) => d.count),
      "rgb(16, 185, 129)",
      "Flights"
    );
  }

  // ========================================================================
  // Distributions
  // ========================================================================

  if (summary.altitude_bins && Array.isArray(summary.altitude_bins)) {
    createChart(
      "altitudeDistribution",
      "bar",
      summary.altitude_bins.map((d) => d.altitude_band),
      summary.altitude_bins.map((d) => d.count),
      "rgb(168, 85, 247)",
      "Flights"
    );
  }

  if (summary.speed_bins && Array.isArray(summary.speed_bins)) {
    createChart(
      "speedDistribution",
      "bar",
      summary.speed_bins.map((d) => d.speed_band),
      summary.speed_bins.map((d) => d.count),
      "rgb(236, 72, 153)",
      "Flights"
    );
  }

  // ========================================================================
  // Seasonal & Hourly Patterns
  // ========================================================================

  if (detailed?.seasonal_pattern && Array.isArray(detailed.seasonal_pattern)) {
    createChart(
      "seasonalPattern",
      "bar",
      detailed.seasonal_pattern.map((d) => d.month),
      detailed.seasonal_pattern.map((d) => d.avg_count),
      "rgb(59, 130, 246)",
      "Avg Flights"
    );
  }

  if (detailed?.hourly_distribution && Array.isArray(detailed.hourly_distribution)) {
    createChart(
      "hourlyPattern",
      "bar",
      detailed.hourly_distribution.map((d) => `${d.hour}h`),
      detailed.hourly_distribution.map((d) => d.count),
      "rgb(251, 146, 60)",
      "Flights"
    );
  }

  // ========================================================================
  // Directional & Fleet
  // ========================================================================

  if (detailed?.heading_distribution && Array.isArray(detailed.heading_distribution)) {
    createChart(
      "headingDistribution",
      "bar",
      detailed.heading_distribution.map((d) => d.direction || d.heading),
      detailed.heading_distribution.map((d) => d.count),
      "rgb(34, 197, 94)",
      "Flights"
    );
  }

  if (detailed?.aircraft_weekly && Array.isArray(detailed.aircraft_weekly)) {
    createChart(
      "aircraftWeekly",
      "line",
      detailed.aircraft_weekly.map((d) => d.week),
      detailed.aircraft_weekly.map((d) => d.aircraft),
      "rgb(59, 130, 246)",
      "Aircraft"
    );
  }

  if (detailed?.aircraft_daily && Array.isArray(detailed.aircraft_daily)) {
    createChart(
      "aircraftDaily",
      "line",
      detailed.aircraft_daily.map((d) => d.day),
      detailed.aircraft_daily.map((d) => d.aircraft),
      "rgb(251, 146, 60)",
      "Aircraft"
    );
  }

  if (detailed?.ground_airborne) {
    const ga = detailed.ground_airborne;
    createChart(
      "groundAirborne",
      "doughnut",
      ["On Ground", "Airborne"],
      [ga.on_ground || 0, ga.airborne || 0],
      "rgb(168, 85, 247)",
      "Count"
    );
  }

  if (detailed?.top_airports_activity && Array.isArray(detailed.top_airports_activity)) {
    createChart(
      "topAirportsActivity",
      "bar",
      detailed.top_airports_activity.map((d) => d.airport),
      detailed.top_airports_activity.map((d) => d.activity),
      "rgb(34, 197, 94)",
      "Activity Count"
    );
  }

  // ========================================================================
  // Data Quality
  // ========================================================================

  if (detailed?.metrics) {
    const m = detailed.metrics;
    const completenessData = [
      m.data_completeness_altitude ?? 0,
      m.data_completeness_speed ?? 0,
      m.data_completeness_track ?? 0,
      m.data_completeness_position ?? 0,
      m.data_completeness_time ?? 0,
    ];
    createChart(
      "dataQuality",
      "bar",
      ["Altitude", "Speed", "Track", "Position", "Time"],
      completenessData,
      "rgb(251, 146, 60)",
      "Completeness %"
    );
  }

  if (detailed?.adsb_type_distribution && Array.isArray(detailed.adsb_type_distribution)) {
    createChart(
      "adsbTypes",
      "bar",
      detailed.adsb_type_distribution.map((d) => d.type),
      detailed.adsb_type_distribution.map((d) => d.count),
      "rgb(139, 92, 246)",
      "Count"
    );
  }

  // ========================================================================
  // Top Categories
  // ========================================================================

  if (summary.top_airlines && Array.isArray(summary.top_airlines)) {
    renderTable(
      "topAirlines",
      summary.top_airlines.slice(0, 20),
      ["airline", "flights"]
    );
  }

  if (summary.top_models && Array.isArray(summary.top_models)) {
    renderTable(
      "topModels",
      summary.top_models.slice(0, 20),
      ["model", "flights"]
    );
  }

  // ========================================================================
  // Insights
  // ========================================================================

  if (detailed?.insights && Array.isArray(detailed.insights)) {
    renderInsights("insightsContainer", detailed.insights);
  }

  // ========================================================================
  // All Metrics
  // ========================================================================

  if (detailed?.metrics) {
    renderMetricsTable("allMetrics", detailed.metrics);
  }
}

// ============================================================================
// Initialization
// ============================================================================

loadHistoricalDashboard();
