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
      datasets: [
        {
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

async function main() {
  const [monthly, summary] = await Promise.all([
    fetchJson("./data/historical_monthly.json"),
    fetchJson("./data/historical_summary.json"),
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
}

main().catch((err) => console.error(err));
