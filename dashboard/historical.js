async function fetchJson(path) {
  const res = await fetch(path);
  if (!res.ok) throw new Error(`Fetch failed: ${path} (${res.status})`);
  return res.json();
}

function buildChart(ctx, type, labels, data, color) {
  return new Chart(ctx, {
    type,
    data: {
      labels,
      datasets: Array.isArray(data)
        ? [
            {
              data,
              borderColor: color,
              backgroundColor: color,
              fill: type === "line",
              tension: 0.35,
            },
          ]
        : data,
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: {
        legend: { display: false },
      },
      interaction: { mode: "index", intersect: false },
      scales: {
        x: { ticks: { color: "#b5c0d0", maxRotation: 0 } },
        y: { ticks: { color: "#b5c0d0" } },
      },
    },
  });
}

function renderTable(targetId, rows, columns) {
  const el = document.getElementById(targetId);
  if (!el) return;
  if (!rows || !rows.length) {
    el.innerHTML = "<p class=\"hint\">No data</p>";
    return;
  }
  const header = columns.map((c) => `<th>${c}</th>`).join("");
  const body = rows
    .map(
      (r) =>
        `<tr>${columns
          .map((c) => `<td>${r[c] ?? "--"}</td>`)
          .join("")}</tr>`
    )
    .join("");
  el.innerHTML = `<table><thead><tr>${header}</tr></thead><tbody>${body}</tbody></table>`;
}

function renderInsights(targetId, insights) {
  const el = document.getElementById(targetId);
  if (!el) return;
  if (!insights || !insights.length) {
    el.innerHTML = "<p class=\"hint\">No insights yet</p>";
    return;
  }
  el.innerHTML = insights
    .map(
      (insight) => `
      <article class="insight-card">
        <div class="tag">${insight.tag || "Insight"}</div>
        <h3>${insight.title}</h3>
        <p>${insight.detail}</p>
      </article>
    `
    )
    .join("");
}

function renderMetricTable(targetId, metrics) {
  const el = document.getElementById(targetId);
  if (!el) return;
  if (!metrics || typeof metrics !== "object") {
    el.innerHTML = "<p class=\"hint\">No metrics</p>";
    return;
  }
  const rows = Object.keys(metrics)
    .sort()
    .map((key) => {
      const value = metrics[key];
      let formatted = value;
      if (typeof value === "number") {
        formatted = Number.isInteger(value) ? value.toLocaleString() : value.toFixed(2);
      } else if (Array.isArray(value)) {
        formatted = JSON.stringify(value);
      } else if (value && typeof value === "object") {
        formatted = JSON.stringify(value);
      }
      return { key, value: formatted };
    });
  renderTable(targetId, rows, ["key", "value"]);
}

async function main() {
  const [monthly, summary, detailed] = await Promise.all([
    fetchJson("./data/historical_monthly.json"),
    fetchJson("./data/historical_summary.json"),
    fetchJson("./data/historical_detailed.json"),
  ]);

  const summaryEl = document.getElementById("hist-summary");
  if (summaryEl && summary) {
    summaryEl.textContent = `Rows: ${summary.total_rows.toLocaleString()} | Months: ${summary.months}`;
  }

  buildChart(
    document.getElementById("histMonthly"),
    "line",
    monthly.map((d) => d.month),
    monthly.map((d) => d.count),
    "#7bdff6"
  );

  buildChart(
    document.getElementById("histAlt"),
    "line",
    monthly.map((d) => d.month),
    monthly.map((d) => d.alt_median || 0),
    "#f4b266"
  );

  buildChart(
    document.getElementById("histSpeed"),
    "line",
    monthly.map((d) => d.month),
    monthly.map((d) => d.speed_median || 0),
    "#c2a5ff"
  );

  if (summary?.yearly_counts) {
    buildChart(
      document.getElementById("histYearly"),
      "bar",
      summary.yearly_counts.map((d) => d.year),
      summary.yearly_counts.map((d) => d.count),
      "#ffcf87"
    );
  }

  if (summary?.altitude_bins) {
    buildChart(
      document.getElementById("histAltBins"),
      "bar",
      summary.altitude_bins.map((d) => d.altitude_band),
      summary.altitude_bins.map((d) => d.count),
      "#7bdff6"
    );
  }

  if (summary?.speed_bins) {
    buildChart(
      document.getElementById("histSpeedBins"),
      "bar",
      summary.speed_bins.map((d) => d.speed_band),
      summary.speed_bins.map((d) => d.count),
      "#f4b266"
    );
  }

  renderTable("histPrefixTable", summary.top_prefixes || [], ["prefix", "flights"]);
  renderTable("histModelTable", summary.top_models || [], ["model", "flights"]);

  if (detailed?.insights) {
    renderInsights("histInsights", detailed.insights);
  }

  if (detailed?.hourly_distribution) {
    buildChart(
      document.getElementById("histHourly"),
      "bar",
      detailed.hourly_distribution.map((d) => `${d.hour}h`),
      detailed.hourly_distribution.map((d) => d.count),
      "#7bdff6"
    );
  }

  if (detailed?.minute_distribution) {
    buildChart(
      document.getElementById("histMinute"),
      "line",
      detailed.minute_distribution.map((d) => d.minute),
      detailed.minute_distribution.map((d) => d.count),
      "#f4b266"
    );
  }

  if (detailed?.seasonal_pattern) {
    buildChart(
      document.getElementById("histSeasonal"),
      "bar",
      detailed.seasonal_pattern.map((d) => d.month),
      detailed.seasonal_pattern.map((d) => d.avg_count),
      "#c2a5ff"
    );
  }

  if (detailed?.heading_distribution) {
    buildChart(
      document.getElementById("histHeading"),
      "bar",
      detailed.heading_distribution.map((d) => d.direction),
      detailed.heading_distribution.map((d) => d.count),
      "#ffcf87"
    );
  }

  if (detailed?.fleet_mix) {
    buildChart(
      document.getElementById("histFleet"),
      "bar",
      detailed.fleet_mix.map((d) => d.type),
      detailed.fleet_mix.map((d) => d.share),
      "#7bdff6"
    );
  }

  if (detailed?.metrics) {
    const m = detailed.metrics;
    const completenessRows = [
      { field: "Altitude", pct: m.data_completeness_altitude ?? 0 },
      { field: "Speed", pct: m.data_completeness_speed ?? 0 },
      { field: "Track", pct: m.data_completeness_track ?? 0 },
      { field: "Position", pct: m.data_completeness_position ?? 0 },
      { field: "Timestamp", pct: m.data_completeness_time ?? 0 },
      { field: "All Fields", pct: m.data_completeness_all_fields ?? 0 },
    ];
    buildChart(
      document.getElementById("histQuality"),
      "bar",
      completenessRows.map((d) => d.field),
      completenessRows.map((d) => d.pct),
      "#f4b266"
    );
  }

  if (detailed?.adsb_type_distribution) {
    buildChart(
      document.getElementById("histAdsb"),
      "bar",
      detailed.adsb_type_distribution.map((d) => d.type),
      detailed.adsb_type_distribution.map((d) => d.count),
      "#c2a5ff"
    );
  }

  renderMetricTable("histMetricTable", detailed?.metrics || {});
}

main().catch((err) => console.error(err));
