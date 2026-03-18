import csv
import json
import os
import re
import sqlite3
from datetime import datetime, timezone
from math import radians, cos, sin, sqrt, atan2, floor
from typing import Dict, List

import requests

API_URL = "https://opensky-network.org/api/states/all"
AIRPORTS_CSV = "airport-codes.csv"
AIRLINES_DAT = "airlines.dat"
AIRLINES_URL = (
    "https://raw.githubusercontent.com/jpatokal/openflights/master/data/airlines.dat"
)

SQLITE_PATH = os.getenv("SQLITE_PATH") or "flights_adsb.sqlite"
MAX_AIRPORT_DISTANCE_KM = float(os.getenv("MAX_AIRPORT_DISTANCE_KM") or "50")
INCLUDE_AIRLINE = (os.getenv("INCLUDE_AIRLINE") or "true").lower() in (
    "1",
    "true",
    "yes",
)
MINUTE_HISTORY_LIMIT = int(os.getenv("MINUTE_HISTORY_LIMIT") or "1440")
RETENTION_DAYS = int(os.getenv("RETENTION_DAYS") or "0")
DEFAULT_AIRPORT = (os.getenv("DEFAULT_AIRPORT") or "").upper()
MAX_SNAPSHOT_ROWS = int(os.getenv("MAX_SNAPSHOT_ROWS") or "500")
SKIP_AIRPORT_MAPPING = (os.getenv("SKIP_AIRPORT_MAPPING") or "false").lower() in (
    "1",
    "true",
    "yes",
)
FILTER_BBOX = os.getenv("FILTER_BBOX", "")

DATA_DIR = os.path.join("dashboard", "data")
os.makedirs(DATA_DIR, exist_ok=True)


def load_airports() -> List[Dict[str, float]]:
    airports = []
    with open(AIRPORTS_CSV, newline="", encoding="utf-8") as f:
        reader = csv.DictReader(f)
        for row in reader:
            if row.get("coordinates"):
                lon_str, lat_str = row["coordinates"].split(",")
                try:
                    airports.append(
                        {
                            "icao": row.get("icao_code") or "",
                            "lat": float(lat_str.strip()),
                            "lon": float(lon_str.strip()),
                        }
                    )
                except ValueError:
                    continue
    return airports


def ensure_airlines_dat():
    if os.path.exists(AIRLINES_DAT):
        return
    resp = requests.get(AIRLINES_URL, timeout=30)
    resp.raise_for_status()
    with open(AIRLINES_DAT, "wb") as f:
        f.write(resp.content)


def load_airlines() -> Dict[str, str]:
    ensure_airlines_dat()
    mapping: Dict[str, str] = {}
    with open(AIRLINES_DAT, newline="", encoding="utf-8") as f:
        reader = csv.reader(f)
        for row in reader:
            if len(row) < 8:
                continue
            name = row[1].strip()
            icao = row[4].strip()
            if not name or icao in ("", r"\N"):
                continue
            mapping[icao.upper()] = name
    return mapping


def haversine(lat1, lon1, lat2, lon2) -> float:
    R = 6371.0
    dlat = radians(lat2 - lat1)
    dlon = radians(lon2 - lon1)
    a = sin(dlat / 2) ** 2 + cos(radians(lat1)) * cos(radians(lat2)) * sin(
        dlon / 2
    ) ** 2
    c = 2 * atan2(sqrt(a), sqrt(1 - a))
    return R * c


def nearest_airport(lat: float, lon: float, airports) -> str:
    nearest = None
    min_dist = float("inf")
    for ap in airports:
        d = haversine(lat, lon, ap["lat"], ap["lon"])
        if d < min_dist:
            min_dist = d
            nearest = ap["icao"]
    if not nearest or min_dist > MAX_AIRPORT_DISTANCE_KM:
        return "unknown"
    return nearest


def fetch_flights():
    resp = requests.get(API_URL, timeout=30)
    resp.raise_for_status()
    return resp.json().get("states", [])


def safe_float(val):
    try:
        return float(val)
    except (TypeError, ValueError):
        return None


def init_db(conn: sqlite3.Connection):
    conn.execute(
        """
        CREATE TABLE IF NOT EXISTS flights_adsb (
            timestamp TEXT,
            icao24 TEXT,
            callsign TEXT,
            airline TEXT,
            lat REAL,
            lon REAL,
            altitude REAL,
            velocity REAL,
            heading REAL,
            nearest_airport TEXT
        );
        """
    )
    conn.commit()


def insert_rows(conn: sqlite3.Connection, rows):
    conn.executemany(
        """
        INSERT INTO flights_adsb (
            timestamp, icao24, callsign, airline, lat, lon, altitude, velocity,
            heading, nearest_airport
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        """,
        rows,
    )
    conn.commit()


def build_metrics(conn: sqlite3.Connection):
    cur = conn.cursor()
    top_airports = cur.execute(
        """
        SELECT nearest_airport AS airport, COUNT(*) AS flights
        FROM flights_adsb
        GROUP BY nearest_airport
        ORDER BY flights DESC
        LIMIT 10
        """
    ).fetchall()

    altitude_bands = cur.execute(
        """
        SELECT CAST(floor(altitude / 1000) * 1000 AS INT) AS altitude_band_m,
               COUNT(*) AS flights
        FROM flights_adsb
        WHERE altitude IS NOT NULL
        GROUP BY altitude_band_m
        ORDER BY altitude_band_m ASC
        """
    ).fetchall()

    speed_bands = cur.execute(
        """
        SELECT CAST(floor(velocity / 50) * 50 AS INT) AS speed_band_ms,
               COUNT(*) AS flights
        FROM flights_adsb
        WHERE velocity IS NOT NULL
        GROUP BY speed_band_ms
        ORDER BY speed_band_ms ASC
        """
    ).fetchall()

    top_airlines = cur.execute(
        """
        SELECT airline, COUNT(*) AS flights
        FROM flights_adsb
        WHERE airline IS NOT NULL AND airline != ''
        GROUP BY airline
        ORDER BY flights DESC
        LIMIT 10
        """
    ).fetchall()

    return {
        "top_airports": [{"airport": a, "flights": f} for a, f in top_airports],
        "altitude_bands": [
            {"altitude_band_m": a, "flights": f} for a, f in altitude_bands
        ],
        "speed_bands": [{"speed_band_ms": s, "flights": f} for s, f in speed_bands],
        "top_airlines": [{"airline": a, "flights": f} for a, f in top_airlines],
    }


def compute_snapshot_metrics(snapshot: list[dict]):
    total = len(snapshot)
    unique_hex = len({r["icao24"] for r in snapshot if r.get("icao24")})
    unique_airlines = len({r["airline"] for r in snapshot if r.get("airline")})
    unique_airports = len({r["airport"] for r in snapshot if r.get("airport")})
    on_ground = sum(1 for r in snapshot if r.get("on_ground") is True)
    airborne = total - on_ground

    alt_vals = sorted([r["altitude"] for r in snapshot if isinstance(r.get("altitude"), (int, float))])
    spd_vals = sorted([r["velocity"] for r in snapshot if isinstance(r.get("velocity"), (int, float))])
    heading_vals = [r["heading"] for r in snapshot if isinstance(r.get("heading"), (int, float))]

    def pctile(arr, p):
        if not arr:
            return None
        idx = int((len(arr) - 1) * p)
        return arr[idx]

    def freq(key):
        counts = {}
        for r in snapshot:
            val = r.get(key) or "unknown"
            counts[val] = counts.get(val, 0) + 1
        return counts

    airport_counts = freq("airport")
    airline_counts = freq("airline")
    country_counts = freq("origin_country")

    heading_bins = {}
    for h in heading_vals:
        bucket = int(floor(h / 30) * 30)
        heading_bins[bucket] = heading_bins.get(bucket, 0) + 1

    summary = {
        "generated_at": datetime.now(timezone.utc).isoformat(),
        "total_flights": total,
        "unique_aircraft": unique_hex,
        "unique_airlines": unique_airlines,
        "unique_airports": unique_airports,
        "on_ground": on_ground,
        "airborne": airborne,
        "altitude_min": alt_vals[0] if alt_vals else None,
        "altitude_median": pctile(alt_vals, 0.5),
        "altitude_p90": pctile(alt_vals, 0.9),
        "speed_min": spd_vals[0] if spd_vals else None,
        "speed_median": pctile(spd_vals, 0.5),
        "speed_p90": pctile(spd_vals, 0.9),
        "default_airport": DEFAULT_AIRPORT or None,
    }

    def top_n(counts, n=20, key_name="key"):
        return [
            {key_name: k, "flights": v}
            for k, v in sorted(counts.items(), key=lambda x: x[1], reverse=True)[:n]
        ]

    return {
        "summary": summary,
        "airport_counts": top_n(airport_counts, 25, "airport"),
        "airline_counts": top_n(airline_counts, 25, "airline"),
        "country_counts": top_n(country_counts, 25, "country"),
        "heading_bins": [
            {"heading_band": k, "flights": heading_bins[k]}
            for k in sorted(heading_bins.keys())
        ],
    }


def load_history(path: str):
    if not os.path.exists(path):
        return []
    with open(path, "r", encoding="utf-8") as f:
        try:
            return json.load(f)
        except json.JSONDecodeError:
            return []


def write_json(path: str, payload):
    with open(path, "w", encoding="utf-8") as f:
        json.dump(payload, f, indent=2)


def update_minute_traffic(count: int, ts: datetime):
    minute_key = ts.replace(second=0, microsecond=0).isoformat().replace("+00:00", "Z")
    path = os.path.join(DATA_DIR, "minute_traffic.json")
    history = load_history(path)
    history = [h for h in history if "minute" in h and "flights" in h]
    history.append({"minute": minute_key, "flights": count})
    history.sort(key=lambda x: x["minute"])
    # Keep a rolling window (default: 1440 minutes = 24h)
    if MINUTE_HISTORY_LIMIT > 0 and len(history) > MINUTE_HISTORY_LIMIT:
        history = history[-MINUTE_HISTORY_LIMIT:]
    write_json(path, history)


def prune_old_rows(conn: sqlite3.Connection):
    if RETENTION_DAYS <= 0:
        return
    cutoff = datetime.now(timezone.utc).timestamp() - (RETENTION_DAYS * 86400)
    cutoff_iso = datetime.fromtimestamp(cutoff, tz=timezone.utc).isoformat()
    conn.execute(
        "DELETE FROM flights_adsb WHERE timestamp < ?",
        (cutoff_iso,),
    )
    conn.commit()


def main():
    airports = [] if SKIP_AIRPORT_MAPPING else load_airports()
    airline_map = load_airlines() if INCLUDE_AIRLINE else {}

    flights = fetch_flights()
    rows = []
    snapshot = []
    now = datetime.now(timezone.utc)

    bbox = None
    if FILTER_BBOX:
        try:
            parts = [float(p.strip()) for p in FILTER_BBOX.split(",")]
            if len(parts) == 4:
                bbox = (parts[0], parts[1], parts[2], parts[3])
        except ValueError:
            bbox = None

    for f in flights:
        icao24 = f[0]
        callsign = f[1].strip() if f[1] else ""
        lat = safe_float(f[6])
        lon = safe_float(f[5])
        altitude = safe_float(f[7])
        on_ground = bool(f[8]) if len(f) > 8 else False
        velocity = safe_float(f[9])
        heading = safe_float(f[10])
        origin_country = f[2] if len(f) > 2 else ""
        ts = (
            datetime.fromtimestamp(f[4], tz=timezone.utc)
            if f[4]
            else now
        )
        if bbox and lat is not None and lon is not None:
            min_lat, max_lat, min_lon, max_lon = bbox
            if not (min_lat <= lat <= max_lat and min_lon <= lon <= max_lon):
                continue

        airport = "unknown"
        if not SKIP_AIRPORT_MAPPING and lat is not None and lon is not None:
            airport = nearest_airport(lat, lon, airports)
        airline = "unknown"
        if INCLUDE_AIRLINE and callsign:
            m = re.match(r"^([A-Za-z]{3})", callsign)
            icao = m.group(1).upper() if m else ""
            airline = airline_map.get(icao, "unknown") if icao else "unknown"

        rows.append(
            (
                ts.isoformat(),
                icao24,
                callsign,
                airline,
                lat,
                lon,
                altitude,
                velocity,
                heading,
                airport,
            )
        )
        snapshot.append(
            {
                "timestamp": ts.isoformat(),
                "icao24": icao24,
                "callsign": callsign,
                "airline": airline,
                "origin_country": origin_country,
                "lat": lat,
                "lon": lon,
                "altitude": altitude,
                "on_ground": on_ground,
                "velocity": velocity,
                "heading": heading,
                "airport": airport,
            }
        )

    conn = sqlite3.connect(SQLITE_PATH)
    init_db(conn)
    insert_rows(conn, rows)
    prune_old_rows(conn)
    metrics = build_metrics(conn)
    conn.close()

    snapshot_metrics = compute_snapshot_metrics(snapshot)

    if MAX_SNAPSHOT_ROWS > 0 and len(snapshot) > MAX_SNAPSHOT_ROWS:
        snapshot = snapshot[:MAX_SNAPSHOT_ROWS]

    write_json(os.path.join(DATA_DIR, "top_airports.json"), metrics["top_airports"])
    write_json(
        os.path.join(DATA_DIR, "altitude_bands.json"), metrics["altitude_bands"]
    )
    write_json(os.path.join(DATA_DIR, "speed_bands.json"), metrics["speed_bands"])
    write_json(os.path.join(DATA_DIR, "top_airlines.json"), metrics["top_airlines"])
    write_json(os.path.join(DATA_DIR, "snapshot.json"), snapshot)
    write_json(
        os.path.join(DATA_DIR, "latest.json"),
        {
            "summary": snapshot_metrics["summary"],
            "airport_counts": snapshot_metrics["airport_counts"],
            "airline_counts": snapshot_metrics["airline_counts"],
            "country_counts": snapshot_metrics["country_counts"],
            "flights": snapshot,
        },
    )
    write_json(os.path.join(DATA_DIR, "summary.json"), snapshot_metrics["summary"])
    write_json(
        os.path.join(DATA_DIR, "airport_counts.json"),
        snapshot_metrics["airport_counts"],
    )
    write_json(
        os.path.join(DATA_DIR, "airline_counts.json"),
        snapshot_metrics["airline_counts"],
    )
    write_json(
        os.path.join(DATA_DIR, "country_counts.json"),
        snapshot_metrics["country_counts"],
    )
    write_json(
        os.path.join(DATA_DIR, "heading_bins.json"),
        snapshot_metrics["heading_bins"],
    )
    update_minute_traffic(len(snapshot), now)

    print(f"Wrote {len(snapshot)} rows and dashboard JSON to {DATA_DIR}")


if __name__ == "__main__":
    main()
