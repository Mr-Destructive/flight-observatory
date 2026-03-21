const charts = new Map();

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

function createChart(canvasId, type, labels, data, color, yLabel = "", options = {}) {
  const canvas = document.getElementById(canvasId);
  if (!canvas) return null;

  const hasData = data && data.length > 0 && data.some(v => v !== null && v !== undefined);
  
  if (!hasData) {
    const parent = canvas.parentElement;
    if (parent) {
      canvas.style.display = 'none';
    }
    return null;
  }

  const ctx = canvas.getContext("2d");
  const chart = new Chart(ctx, {
    type,
    data: {
      labels,
      datasets: [{
        label: yLabel || "Value",
        data,
        borderColor: color,
        backgroundColor: type === "line" ? color.replace(/[^,]+(?=\))/, "0.1") : color + "40",
        fill: type === "line",
        tension: type === "line" ? 0.3 : 0,
        borderWidth: 2,
        pointRadius: 3,
        pointHoverRadius: 5,
        pointBackgroundColor: color,
        spanGaps: true,
        ...options.dataset,
      }],
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
      scales: {
        x: { ticks: { color: "#6b7280", maxRotation: 45 }, grid: { color: "rgba(255, 255, 255, 0.05)" } },
        y: { beginAtZero: type === "bar", ticks: { color: "#6b7280" }, grid: { color: "rgba(255, 255, 255, 0.05)" } },
      },
      ...options.chart,
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

function renderInsights(elementId, insights) {
  const el = document.getElementById(elementId);
  if (!el || !insights?.length) return;
  
  el.innerHTML = insights.map(insight => `
    <article class="insight-card">
      <div class="insight-icon">${insight.icon || '📊'}</div>
      <div class="insight-content">
        <h4>${insight.title}</h4>
        <p>${insight.detail}</p>
      </div>
    </article>
  `).join('');
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
    stats.push({ label: "Max Speed", value: Math.round(detailed.speed_stats.max) + "m/s", color: "--accent-cyan" });
  }
  if (sky?.busiest_corridors?.[0]) {
    stats.push({ label: "Busiest FL", value: Math.round(sky.busiest_corridors[0].altitude_band / 1000) + "km", color: "--accent-green" });
  }
  if (detailed?.ground_airborne) {
    const pct = Math.round(100 * detailed.ground_airborne.airborne / (detailed.ground_airborne.airborne + detailed.ground_airborne.on_ground));
    stats.push({ label: "Airborne %", value: pct + "%", color: "--accent-pink" });
  }
  if (detailed?.ghost_planes) {
    stats.push({ label: "Ghost Fleet", value: formatNumber(detailed.ghost_planes.aircraft), color: "--accent-purple" });
  }

  grid.innerHTML = stats.map(s => `
    <div class="metric-card">
      <div class="metric-label">${s.label}</div>
      <div class="metric-value" style="color: var(${s.color})">${s.value}</div>
    </div>
  `).join('');
}

function renderSpeedLeaderboard(leaderboard) {
  const el = document.getElementById("speedLeaderboard");
  if (!el || !leaderboard?.length) return;

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
        ${leaderboard.map((item, i) => `
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
    `<tr>${columns.map(c => `<td>${formatNumber(r[c])}</td>`).join('')}</tr>`
  ).join("");

  el.innerHTML = `<table><thead><tr>${header}</tr></thead><tbody>${body}</tbody></table>`;
}

function renderGroundAirborne(data) {
  if (!data) return;
  const ctx = document.getElementById("groundAirborne");
  if (!ctx) return;
  
  new Chart(ctx.getContext("2d"), {
    type: "doughnut",
    data: {
      labels: ["On Ground", "Airborne"],
      datasets: [{
        data: [data.on_ground || 0, data.airborne || 0],
        backgroundColor: ["rgb(249, 115, 22)", "rgb(16, 185, 129)"],
        borderWidth: 0,
      }],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: {
        legend: { display: true, position: "bottom", labels: { color: "#9ca3af" } },
      },
    },
  });
}

async function loadHistoricalDashboard() {
  const [monthly, summary, detailed, sky] = await Promise.all([
    fetchJson("./data/historical_monthly.json"),
    fetchJson("./data/historical_summary.json"),
    fetchJson("./data/historical_detailed.json"),
    fetchJson("./data/sky_analytics.json"),
  ]);

  if (!monthly || !summary) {
    console.warn("Missing historical data files");
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

  // Quick stats
  renderQuickStats(summary, detailed, sky);

  // Insights
  if (detailed?.insights?.length) {
    renderInsights("insightsContainer", detailed.insights);
  }

  // Ghost Fleet
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

  // Traffic Wave
  if (detailed?.hourly_distribution?.length) {
    createChart(
      "trafficWave", "line",
      detailed.hourly_distribution.map(d => `${d.hour}:00`),
      detailed.hourly_distribution.map(d => d.count),
      "rgb(6, 182, 212)",
      "Flights"
    );
  }

  // Altitude Tiers
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
            { label: "Arrivals", data: arrivals, backgroundColor: "rgb(16, 185, 129)", borderRadius: 4 },
            { label: "Departures", data: departures, backgroundColor: "rgb(249, 115, 22)", borderRadius: 4 },
          ],
        },
        options: {
          responsive: true,
          maintainAspectRatio: false,
          plugins: { legend: { display: true, position: "bottom", labels: { color: "#9ca3af" } } },
          scales: {
            x: { ticks: { color: "#6b7280" }, grid: { color: "rgba(255, 255, 255, 0.05)" } },
            y: { ticks: { color: "#6b7280" }, grid: { color: "rgba(255, 255, 255, 0.05)" } },
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

  // Directional Traffic Stats
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

  // Airline Preferences
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

  // Tables
  if (summary?.top_airlines?.length) {
    renderTable("topAirlines", summary.top_airlines.slice(0, 15), ["airline", "flights"]);
  }
  if (summary?.top_models?.length) {
    renderTable("topModels", summary.top_models.slice(0, 15), ["model", "flights"]);
  }
}

loadHistoricalDashboard();
