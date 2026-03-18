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

SQLITE_PATH = os.getenv("SQLITE_PATH", "flights_adsb.sqlite")
MAX_AIRPORT_DISTANCE_KM = float(os.getenv("MAX_AIRPORT_DISTANCE_KM", "50"))
INCLUDE_AIRLINE = os.getenv("INCLUDE_AIRLINE", "true").lower() in ("1", "true", "yes")

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
    # Keep last 60 minutes
    if len(history) > 60:
        history = history[-60:]
    write_json(path, history)


def main():
    airports = load_airports()
    airline_map = load_airlines() if INCLUDE_AIRLINE else {}

    flights = fetch_flights()
    rows = []
    snapshot = []
    now = datetime.now(timezone.utc)

    for f in flights:
        icao24 = f[0]
        callsign = f[1].strip() if f[1] else ""
        lat = safe_float(f[6])
        lon = safe_float(f[5])
        altitude = safe_float(f[7])
        velocity = safe_float(f[9])
        heading = safe_float(f[10])
        ts = (
            datetime.fromtimestamp(f[4], tz=timezone.utc)
            if f[4]
            else now
        )
        airport = (
            nearest_airport(lat, lon, airports)
            if lat is not None and lon is not None
            else "unknown"
        )
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
                "lat": lat,
                "lon": lon,
                "altitude": altitude,
                "velocity": velocity,
                "heading": heading,
                "airport": airport,
            }
        )

    conn = sqlite3.connect(SQLITE_PATH)
    init_db(conn)
    insert_rows(conn, rows)
    metrics = build_metrics(conn)
    conn.close()

    write_json(os.path.join(DATA_DIR, "top_airports.json"), metrics["top_airports"])
    write_json(
        os.path.join(DATA_DIR, "altitude_bands.json"), metrics["altitude_bands"]
    )
    write_json(os.path.join(DATA_DIR, "speed_bands.json"), metrics["speed_bands"])
    write_json(os.path.join(DATA_DIR, "top_airlines.json"), metrics["top_airlines"])
    write_json(os.path.join(DATA_DIR, "snapshot.json"), snapshot)
    update_minute_traffic(len(snapshot), now)

    print(f"Wrote {len(snapshot)} rows and dashboard JSON to {DATA_DIR}")


if __name__ == "__main__":
    main()
