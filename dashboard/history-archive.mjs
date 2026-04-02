export function buildArchivePath(day, baseDir = "archives") {
  return `${baseDir}/flights_${day}.sqlite.gz`;
}

export async function decompressGzip(buffer) {
  if (typeof DecompressionStream !== "undefined") {
    const stream = new Blob([buffer]).stream().pipeThrough(new DecompressionStream("gzip"));
    return new Response(stream).arrayBuffer();
  }
  if (typeof pako !== "undefined") {
    const out = pako.ungzip(new Uint8Array(buffer));
    return out.buffer;
  }
  throw new Error("No gzip decompressor available.");
}

export function percentileFromBins(bins, pct) {
  const total = bins.reduce((sum, b) => sum + b.count, 0);
  if (!total) return null;
  const target = total * pct;
  let running = 0;
  for (const b of bins) {
    running += b.count;
    if (running >= target) return b.band;
  }
  return bins[bins.length - 1]?.band ?? null;
}

function hasTable(db, name) {
  const res = db.exec(
    "SELECT name FROM sqlite_master WHERE type='table' AND name=?",
    [name],
  );
  return res[0]?.values?.length > 0;
}

export function summarizeDb(db) {
  const hasPositions = hasTable(db, "flight_positions");
  const hasArchive = hasTable(db, "flight_positions_archive");
  const table = hasPositions ? "flight_positions" : hasArchive ? "flight_positions_archive" : null;
  const hasFlights = hasTable(db, "flights");

  if (!table) {
    throw new Error("No flight positions table found.");
  }

  const totalRows =
    db.exec(`SELECT COUNT(*) FROM ${table}`)[0]?.values?.[0]?.[0] || 0;
  const airborneRows =
    db.exec(`SELECT COUNT(*) FROM ${table} WHERE on_ground IS NULL OR on_ground = 0`)[0]?.values?.[0]?.[0] || 0;
  const onGroundRows =
    db.exec(`SELECT COUNT(*) FROM ${table} WHERE on_ground = 1`)[0]?.values?.[0]?.[0] || 0;
  const avgAltitude =
    db.exec(`SELECT AVG(altitude) FROM ${table} WHERE altitude IS NOT NULL`)[0]?.values?.[0]?.[0] ?? null;
  const maxSpeed =
    db.exec(`SELECT MAX(velocity) FROM ${table} WHERE velocity IS NOT NULL`)[0]?.values?.[0]?.[0] ?? null;

  const uniqueAircraft = hasFlights
    ? db.exec("SELECT COUNT(DISTINCT icao24) FROM flights")[0]?.values?.[0]?.[0] || 0
    : db.exec(`SELECT COUNT(DISTINCT icao24) FROM ${table}`)[0]?.values?.[0]?.[0] || 0;

  const hourlyRows =
    db.exec(
      `SELECT CAST(substr(observed_at, 12, 2) AS INT) AS hour, COUNT(*) FROM ${table} WHERE observed_at IS NOT NULL GROUP BY hour ORDER BY hour`
    )[0]?.values || [];
  const weekdayRows =
    db.exec(
      `SELECT CAST(strftime('%w', observed_at) AS INT) AS dow, COUNT(*) FROM ${table} GROUP BY dow ORDER BY dow`
    )[0]?.values || [];
  const altitudeRows =
    db.exec(
      `SELECT CAST(altitude/1000 AS INT) * 1000 AS band, COUNT(*) FROM ${table} WHERE altitude IS NOT NULL GROUP BY band ORDER BY band`
    )[0]?.values || [];
  const speedRows =
    db.exec(
      `SELECT CAST(velocity/50 AS INT) * 50 AS band, COUNT(*) FROM ${table} WHERE velocity IS NOT NULL GROUP BY band ORDER BY band`
    )[0]?.values || [];
  const topAirlines = hasFlights
    ? db.exec(
        "SELECT airline, COUNT(*) FROM flights WHERE airline IS NOT NULL AND airline != '' GROUP BY airline ORDER BY COUNT(*) DESC LIMIT 10"
      )[0]?.values || []
    : db.exec(
        `SELECT airline, COUNT(*) FROM ${table} WHERE airline IS NOT NULL AND airline != '' GROUP BY airline ORDER BY COUNT(*) DESC LIMIT 10`
      )[0]?.values || [];

  const altitudeBins = altitudeRows.map((row) => ({
    band: Number(row[0]),
    label: `${row[0]}m`,
    count: Number(row[1]),
  }));
  const speedBins = speedRows.map((row) => ({
    band: Number(row[0]),
    label: `${row[0]}m/s`,
    count: Number(row[1]),
  }));

  const detailed = {
    unique_aircraft: uniqueAircraft,
    hourly_distribution: toHourlyMap(hourlyRows),
    weekday_distribution: toWeekdayMap(weekdayRows),
      altitude_stats: {
        median: percentileFromBins(altitudeBins, 0.5),
        p90: percentileFromBins(altitudeBins, 0.9),
        avg: avgAltitude,
      },
      speed_stats: {
        median: percentileFromBins(speedBins, 0.5),
        p90: percentileFromBins(speedBins, 0.9),
        max: maxSpeed,
      },
      metrics: {
        unique_aircraft: uniqueAircraft,
        total_records: totalRows,
        airborne: airborneRows,
        on_ground: onGroundRows,
        data_completeness_all_fields: null,
      },
      ground_airborne: {
        airborne: airborneRows,
        on_ground: onGroundRows,
      },
      insights: [],
    };

  const summary = {
    total_rows: totalRows,
    altitude_bins: altitudeBins.map((b) => ({
      altitude_band: b.label,
      count: b.count,
    })),
    speed_bins: speedBins.map((b) => ({ speed_band: b.label, count: b.count })),
    top_airlines: topAirlines.map((row) => ({ airline: row[0], count: row[1] })),
    top_models: [],
  };

  return { summary, detailed };
}

export async function loadArchiveDb(day, options) {
  const fetchFn = options?.fetchFn || fetch;
  const initSqlJs = options?.initSqlJs;
  const baseDir = options?.baseDir || "archives";
  const baseDirs = Array.from(new Set([baseDir, ...(options?.baseDirs || [])].filter(Boolean)));

  if (!initSqlJs) {
    throw new Error("initSqlJs must be provided.");
  }

  let res = null;
  for (const dir of baseDirs) {
    const url = buildArchivePath(day, dir);
    try {
      const candidate = await fetchFn(url);
      if (candidate?.ok) {
        res = candidate;
        break;
      }
    } catch (err) {
      // try next dir
    }
  }
  if (!res) {
    throw new Error(`Archive not found: ${day}`);
  }
  const gzBuffer = await res.arrayBuffer();
  const buffer = await decompressGzip(gzBuffer);
  const SQL = await initSqlJs({
    locateFile: (file) =>
      `https://cdnjs.cloudflare.com/ajax/libs/sql.js/1.10.2/${file}`,
  });
  const db = new SQL.Database(new Uint8Array(buffer));
  return summarizeDb(db);
}

export async function loadArchiveDbRaw(day, options) {
  const fetchFn = options?.fetchFn || fetch;
  const initSqlJs = options?.initSqlJs;
  const baseDir = options?.baseDir || "archives";
  const baseDirs = Array.from(new Set([baseDir, ...(options?.baseDirs || [])].filter(Boolean)));

  if (!initSqlJs) {
    throw new Error("initSqlJs must be provided.");
  }

  let res = null;
  for (const dir of baseDirs) {
    const url = buildArchivePath(day, dir);
    try {
      const candidate = await fetchFn(url);
      if (candidate?.ok) {
        res = candidate;
        break;
      }
    } catch (err) {
      // try next dir
    }
  }
  if (!res) {
    throw new Error(`Archive not found: ${day}`);
  }
  const gzBuffer = await res.arrayBuffer();
  const buffer = await decompressGzip(gzBuffer);
  const SQL = await initSqlJs({
    locateFile: (file) =>
      `https://cdnjs.cloudflare.com/ajax/libs/sql.js/1.10.2/${file}`,
  });
  return new SQL.Database(new Uint8Array(buffer));
}

export function summarizeDbWithFilters(db, filters) {
  const hasPositions = hasTable(db, "flight_positions");
  const hasArchive = hasTable(db, "flight_positions_archive");
  const table = hasPositions ? "flight_positions" : hasArchive ? "flight_positions_archive" : null;
  const hasFlights = hasTable(db, "flights");
  if (!table) {
    throw new Error("No flight positions table found.");
  }

  const where = [];
  const params = [];
  if (filters?.airline) {
    where.push("airline = ?");
    params.push(filters.airline);
  }
  if (filters?.airport) {
    where.push("nearest_airport = ?");
    params.push(filters.airport);
  }
  if (filters?.hourStart !== undefined && filters?.hourEnd !== undefined) {
    where.push("CAST(substr(observed_at, 12, 2) AS INT) BETWEEN ? AND ?");
    params.push(filters.hourStart, filters.hourEnd);
  }
  if (filters?.altMin !== undefined && filters?.altMax !== undefined) {
    where.push("altitude BETWEEN ? AND ?");
    params.push(filters.altMin, filters.altMax);
  }
  if (filters?.spdMin !== undefined && filters?.spdMax !== undefined) {
    where.push("velocity BETWEEN ? AND ?");
    params.push(filters.spdMin, filters.spdMax);
  }
  const clause = where.length ? `WHERE ${where.join(" AND ")}` : "";

  const totalRows =
    db.exec(`SELECT COUNT(*) FROM ${table} ${clause}`, params)[0]?.values?.[0]?.[0] || 0;
  const airborneRows =
    db.exec(`SELECT COUNT(*) FROM ${table} ${clause ? clause + " AND" : "WHERE"} (on_ground IS NULL OR on_ground = 0)`, params)[0]?.values?.[0]?.[0] || 0;
  const onGroundRows =
    db.exec(`SELECT COUNT(*) FROM ${table} ${clause ? clause + " AND" : "WHERE"} on_ground = 1`, params)[0]?.values?.[0]?.[0] || 0;
  const avgAltitude =
    db.exec(`SELECT AVG(altitude) FROM ${table} ${clause ? clause + " AND" : "WHERE"} altitude IS NOT NULL`, params)[0]?.values?.[0]?.[0] ?? null;
  const maxSpeed =
    db.exec(`SELECT MAX(velocity) FROM ${table} ${clause ? clause + " AND" : "WHERE"} velocity IS NOT NULL`, params)[0]?.values?.[0]?.[0] ?? null;
  const uniqueAircraft = hasFlights
    ? db.exec(`SELECT COUNT(DISTINCT icao24) FROM flights`)[0]?.values?.[0]?.[0] || 0
    : db.exec(`SELECT COUNT(DISTINCT icao24) FROM ${table} ${clause}`, params)[0]?.values?.[0]?.[0] || 0;

  const hourlyRows =
    db.exec(
      `SELECT CAST(substr(observed_at, 12, 2) AS INT) AS hour, COUNT(*) FROM ${table} ${clause} GROUP BY hour ORDER BY hour`,
      params,
    )[0]?.values || [];
  const weekdayRows =
    db.exec(
      `SELECT CAST(strftime('%w', observed_at) AS INT) AS dow, COUNT(*) FROM ${table} ${clause} GROUP BY dow ORDER BY dow`,
      params,
    )[0]?.values || [];
  const altitudeRows =
    db.exec(
      `SELECT CAST(altitude/1000 AS INT) * 1000 AS band, COUNT(*) FROM ${table} ${clause} AND altitude IS NOT NULL GROUP BY band ORDER BY band`,
      params,
    )[0]?.values || [];
  const speedRows =
    db.exec(
      `SELECT CAST(velocity/50 AS INT) * 50 AS band, COUNT(*) FROM ${table} ${clause} AND velocity IS NOT NULL GROUP BY band ORDER BY band`,
      params,
    )[0]?.values || [];
  const topAirlines = hasFlights
    ? db.exec(
        `SELECT airline, COUNT(*) FROM flights WHERE airline IS NOT NULL AND airline != '' GROUP BY airline ORDER BY COUNT(*) DESC LIMIT 10`
      )[0]?.values || []
    : db.exec(
        `SELECT airline, COUNT(*) FROM ${table} ${clause} AND airline IS NOT NULL AND airline != '' GROUP BY airline ORDER BY COUNT(*) DESC LIMIT 10`,
        params,
      )[0]?.values || [];

  const altitudeBins = altitudeRows.map((row) => ({
    band: Number(row[0]),
    label: `${row[0]}m`,
    count: Number(row[1]),
  }));
  const speedBins = speedRows.map((row) => ({
    band: Number(row[0]),
    label: `${row[0]}m/s`,
    count: Number(row[1]),
  }));

  return {
    summary: {
      total_rows: totalRows,
      altitude_bins: altitudeBins.map((b) => ({
        altitude_band: b.label,
        count: b.count,
      })),
      speed_bins: speedBins.map((b) => ({ speed_band: b.label, count: b.count })),
      top_airlines: topAirlines.map((row) => ({ airline: row[0], count: row[1] })),
      top_models: [],
    },
    detailed: {
      unique_aircraft: uniqueAircraft,
      hourly_distribution: toHourlyMap(hourlyRows),
      weekday_distribution: toWeekdayMap(weekdayRows),
      altitude_stats: {
        median: percentileFromBins(altitudeBins, 0.5),
        p90: percentileFromBins(altitudeBins, 0.9),
        avg: avgAltitude,
      },
      speed_stats: {
        median: percentileFromBins(speedBins, 0.5),
        p90: percentileFromBins(speedBins, 0.9),
        max: maxSpeed,
      },
      metrics: {
        unique_aircraft: uniqueAircraft,
        total_records: totalRows,
        airborne: airborneRows,
        on_ground: onGroundRows,
        data_completeness_all_fields: null,
      },
      ground_airborne: {
        airborne: airborneRows,
        on_ground: onGroundRows,
      },
      insights: [],
    },
  };
}

export function mergeHistorical(items) {
  const merged = {
    summary: {
      total_rows: 0,
      altitude_bins: [],
      speed_bins: [],
      top_airlines: [],
      top_models: [],
    },
    detailed: {
      unique_aircraft: 0,
      hourly_distribution: Array.from({ length: 24 }, (_, i) => ({ hour: i, count: 0 })),
      weekday_distribution: ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].map((day, idx) => ({
        day,
        count: 0,
        idx,
      })),
      altitude_stats: { median: null, p90: null },
      speed_stats: { median: null, p90: null },
      metrics: {
        unique_aircraft: 0,
        total_records: 0,
        airborne: 0,
        on_ground: 0,
        data_completeness_all_fields: null,
      },
      insights: [],
    },
  };

  const altitudeMap = new Map();
  const speedMap = new Map();
  const airlineMap = new Map();

  items.forEach(({ summary, detailed }) => {
    if (!summary || !detailed) return;
    merged.summary.total_rows += summary.total_rows || 0;
    merged.detailed.metrics.total_records += summary.total_rows || 0;
    merged.detailed.unique_aircraft += detailed.unique_aircraft || 0;
    merged.detailed.metrics.unique_aircraft += detailed.unique_aircraft || 0;
    merged.detailed.metrics.airborne += detailed.metrics?.airborne || 0;
    merged.detailed.metrics.on_ground += detailed.metrics?.on_ground || 0;

    (summary.altitude_bins || []).forEach((b) => {
      const key = b.altitude_band;
      altitudeMap.set(key, (altitudeMap.get(key) || 0) + (b.count || 0));
    });
    (summary.speed_bins || []).forEach((b) => {
      const key = b.speed_band;
      speedMap.set(key, (speedMap.get(key) || 0) + (b.count || 0));
    });
    (summary.top_airlines || []).forEach((a) => {
      const key = a.airline || "Unknown";
      airlineMap.set(key, (airlineMap.get(key) || 0) + (a.count || 0));
    });

    (detailed.hourly_distribution || []).forEach((h) => {
      const slot = merged.detailed.hourly_distribution[h.hour];
      if (slot) slot.count += h.count || 0;
    });
    (detailed.weekday_distribution || []).forEach((d) => {
      const slot = merged.detailed.weekday_distribution[d.idx ?? 0];
      if (slot) slot.count += d.count || 0;
    });
  });

  merged.summary.altitude_bins = Array.from(altitudeMap.entries())
    .map(([altitude_band, count]) => ({ altitude_band, count }))
    .sort((a, b) => parseBand(a.altitude_band) - parseBand(b.altitude_band));
  merged.summary.speed_bins = Array.from(speedMap.entries())
    .map(([speed_band, count]) => ({ speed_band, count }))
    .sort((a, b) => parseBand(a.speed_band) - parseBand(b.speed_band));
  merged.summary.top_airlines = Array.from(airlineMap.entries())
    .map(([airline, count]) => ({ airline, count }))
    .sort((a, b) => b.count - a.count)
    .slice(0, 10);

  const altitudeBins = merged.summary.altitude_bins.map((b) => ({
    band: parseBand(b.altitude_band),
    count: b.count,
  }));
  const speedBins = merged.summary.speed_bins.map((b) => ({
    band: parseBand(b.speed_band),
    count: b.count,
  }));
  merged.detailed.altitude_stats.median = percentileFromBins(altitudeBins, 0.5);
  merged.detailed.altitude_stats.p90 = percentileFromBins(altitudeBins, 0.9);
  merged.detailed.speed_stats.median = percentileFromBins(speedBins, 0.5);
  merged.detailed.speed_stats.p90 = percentileFromBins(speedBins, 0.9);

  return merged;
}

function toHourlyMap(rows) {
  const hours = Array.from({ length: 24 }, (_, i) => ({ hour: i, count: 0 }));
  rows.forEach((row) => {
    const hour = Number(row[0]);
    const count = Number(row[1]);
    if (!Number.isNaN(hour) && hours[hour]) {
      hours[hour].count = count;
    }
  });
  return hours;
}

function parseBand(label) {
  const match = String(label || "").match(/-?\d+(\.\d+)?/);
  return match ? Number(match[0]) : 0;
}

function toWeekdayMap(rows) {
  const labels = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  const days = labels.map((day, idx) => ({ day, count: 0, idx }));
  rows.forEach((row) => {
    const idx = Number(row[0]);
    const count = Number(row[1]);
    if (!Number.isNaN(idx) && days[idx]) {
      days[idx].count = count;
    }
  });
  return days;
}
