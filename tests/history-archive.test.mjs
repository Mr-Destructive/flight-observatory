import test from "node:test";
import assert from "node:assert/strict";

import { buildArchivePath, summarizeDb, mergeHistorical } from "../dashboard/history-archive.mjs";

test("buildArchivePath uses archives folder and date", () => {
  const path = buildArchivePath("2026-03-21");
  assert.equal(path, "archives/flights_2026-03-21.sqlite.gz");
});

test("summarizeDb builds summary and detailed from exec results", () => {
  const execMap = new Map([
    ["flight_positions", { values: [["flight_positions"]] }],
    ["flights", { values: [["flights"]] }],
    ["SELECT COUNT(*) FROM flight_positions", { values: [[100]] }],
    ["SELECT COUNT(DISTINCT icao24) FROM flights", { values: [[10]] }],
    [
      "SELECT CAST(substr(observed_at, 12, 2) AS INT) AS hour, COUNT(*) FROM flight_positions GROUP BY hour ORDER BY hour",
      { values: [[0, 5], [1, 10]] },
    ],
    [
      "SELECT CAST(strftime('%w', observed_at) AS INT) AS dow, COUNT(*) FROM flight_positions GROUP BY dow ORDER BY dow",
      { values: [[0, 20], [1, 30]] },
    ],
    [
      "SELECT CAST(altitude/1000 AS INT) * 1000 AS band, COUNT(*) FROM flight_positions WHERE altitude IS NOT NULL GROUP BY band ORDER BY band",
      { values: [[0, 50], [1000, 50]] },
    ],
    [
      "SELECT CAST(velocity/50 AS INT) * 50 AS band, COUNT(*) FROM flight_positions WHERE velocity IS NOT NULL GROUP BY band ORDER BY band",
      { values: [[0, 60], [50, 40]] },
    ],
    [
      "SELECT airline, COUNT(*) FROM flights WHERE airline IS NOT NULL AND airline != '' GROUP BY airline ORDER BY COUNT(*) DESC LIMIT 10",
      { values: [["A", 70], ["B", 30]] },
    ],
  ]);

  const fakeDb = {
    exec(query, params = []) {
      const key = query.includes("sqlite_master") ? query : query;
      if (query.includes("sqlite_master")) {
        const name = params[0];
        if (name === "flight_positions") return [execMap.get("flight_positions")];
        if (name === "flights") return [execMap.get("flights")];
        return [{ values: [] }];
      }
      const result = execMap.get(key);
      return result ? [result] : [];
    },
  };

  const { summary, detailed } = summarizeDb(fakeDb);

  assert.equal(summary.total_rows, 100);
  assert.equal(detailed.unique_aircraft, 10);
  assert.equal(summary.altitude_bins.length, 2);
  assert.equal(summary.speed_bins.length, 2);
  assert.equal(detailed.altitude_stats.median, 0);
  assert.equal(detailed.altitude_stats.p90, 1000);
  assert.equal(detailed.speed_stats.median, 0);
  assert.equal(detailed.speed_stats.p90, 50);
});

test("summarizeDb works with archive table", () => {
  const execMap = new Map([
    ["SELECT name FROM sqlite_master WHERE type='table' AND name=?", { values: [["flight_positions_archive"]] }],
    ["SELECT COUNT(*) FROM flight_positions_archive", { values: [[50]] }],
    ["SELECT COUNT(DISTINCT icao24) FROM flight_positions_archive", { values: [[8]] }],
    [
      "SELECT CAST(substr(observed_at, 12, 2) AS INT) AS hour, COUNT(*) FROM flight_positions_archive GROUP BY hour ORDER BY hour",
      { values: [[0, 2]] },
    ],
    [
      "SELECT CAST(strftime('%w', observed_at) AS INT) AS dow, COUNT(*) FROM flight_positions_archive GROUP BY dow ORDER BY dow",
      { values: [[1, 5]] },
    ],
    [
      "SELECT CAST(altitude/1000 AS INT) * 1000 AS band, COUNT(*) FROM flight_positions_archive WHERE altitude IS NOT NULL GROUP BY band ORDER BY band",
      { values: [[0, 20]] },
    ],
    [
      "SELECT CAST(velocity/50 AS INT) * 50 AS band, COUNT(*) FROM flight_positions_archive WHERE velocity IS NOT NULL GROUP BY band ORDER BY band",
      { values: [[0, 20]] },
    ],
    [
      "SELECT airline, COUNT(*) FROM flight_positions_archive WHERE airline IS NOT NULL AND airline != '' GROUP BY airline ORDER BY COUNT(*) DESC LIMIT 10",
      { values: [["A", 7]] },
    ],
  ]);

  const fakeDb = {
    exec(query, params = []) {
      if (query.includes("sqlite_master")) {
        const name = params[0];
        if (name === "flight_positions") return [{ values: [] }];
        if (name === "flight_positions_archive") return [execMap.get(query)];
        if (name === "flights") return [{ values: [] }];
        return [{ values: [] }];
      }
      const result = execMap.get(query);
      return result ? [result] : [];
    },
  };

  const { summary, detailed } = summarizeDb(fakeDb);
  assert.equal(summary.total_rows, 50);
  assert.equal(detailed.unique_aircraft, 8);
  assert.equal(summary.top_airlines[0].airline, "A");
});

test("mergeHistorical aggregates bins and totals", () => {
  const day1 = {
    summary: {
      total_rows: 10,
      altitude_bins: [{ altitude_band: "0m", count: 4 }],
      speed_bins: [{ speed_band: "0m/s", count: 6 }],
      top_airlines: [{ airline: "A", count: 3 }],
    },
    detailed: {
      unique_aircraft: 5,
      hourly_distribution: [{ hour: 0, count: 2 }],
      weekday_distribution: [{ day: "Sun", count: 2, idx: 0 }],
      altitude_stats: { median: 0, p90: 0 },
      speed_stats: { median: 0, p90: 0 },
      metrics: { unique_aircraft: 5, total_records: 10 },
      insights: [],
    },
  };
  const day2 = {
    summary: {
      total_rows: 20,
      altitude_bins: [{ altitude_band: "0m", count: 6 }],
      speed_bins: [{ speed_band: "50m/s", count: 8 }],
      top_airlines: [{ airline: "A", count: 2 }, { airline: "B", count: 4 }],
    },
    detailed: {
      unique_aircraft: 7,
      hourly_distribution: [{ hour: 0, count: 3 }],
      weekday_distribution: [{ day: "Sun", count: 3, idx: 0 }],
      altitude_stats: { median: 0, p90: 0 },
      speed_stats: { median: 0, p90: 0 },
      metrics: { unique_aircraft: 7, total_records: 20 },
      insights: [],
    },
  };

  const merged = mergeHistorical([day1, day2]);

  assert.equal(merged.summary.total_rows, 30);
  assert.equal(merged.summary.altitude_bins[0].count, 10);
  assert.equal(merged.summary.speed_bins.length, 2);
  assert.equal(merged.detailed.hourly_distribution[0].count, 5);
  assert.equal(merged.detailed.weekday_distribution[0].count, 5);
  assert.equal(merged.summary.top_airlines[0].airline, "A");
  assert.equal(merged.summary.top_airlines[0].count, 5);
});
