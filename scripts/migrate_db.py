import argparse
import gzip
import os
import shutil
import sqlite3
from datetime import datetime, timedelta, timezone

import sys

ROOT_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if ROOT_DIR not in sys.path:
    sys.path.insert(0, ROOT_DIR)

import pipeline


def table_exists(conn: sqlite3.Connection, name: str) -> bool:
    cur = conn.execute(
        "SELECT 1 FROM sqlite_master WHERE type='table' AND name=?",
        (name,),
    )
    return cur.fetchone() is not None


def ensure_dir(path: str):
    os.makedirs(path, exist_ok=True)


def create_archive_db(path: str):
    conn = sqlite3.connect(path)
    conn.execute(
        """
        CREATE TABLE IF NOT EXISTS flight_positions_archive (
            observed_at TEXT NOT NULL,
            state_time TEXT,
            icao24 TEXT NOT NULL,
            callsign TEXT,
            origin_country TEXT,
            airline TEXT,
            origin_airport TEXT,
            dest_airport TEXT,
            lat REAL,
            lon REAL,
            altitude REAL,
            velocity REAL,
            heading REAL,
            on_ground INTEGER,
            nearest_airport TEXT,
            flight_first_seen TEXT,
            flight_last_seen TEXT
        );
        """
    )
    conn.execute(
        "CREATE INDEX IF NOT EXISTS idx_archive_observed ON flight_positions_archive(observed_at)"
    )
    conn.commit()
    return conn


def gzip_sqlite(path: str):
    gz_path = path + ".gz"
    with open(path, "rb") as f_in, gzip.open(gz_path, "wb") as f_out:
        shutil.copyfileobj(f_in, f_out)
    os.remove(path)
    return gz_path


def export_archive_from_normalized(conn_in, day: str, archive_dir: str):
    archive_path = os.path.join(archive_dir, f"flights_{day}.sqlite")
    if os.path.exists(archive_path) or os.path.exists(archive_path + ".gz"):
        return
    archive_conn = create_archive_db(archive_path)
    rows = conn_in.execute(
        """
        SELECT fp.observed_at, fp.state_time, f.icao24, f.callsign, f.origin_country,
               f.airline, f.origin_airport, f.dest_airport, fp.lat, fp.lon,
               fp.altitude, fp.velocity, fp.heading, fp.on_ground, fp.nearest_airport,
               f.first_seen, f.last_seen
        FROM flight_positions fp
        JOIN flights f ON f.flight_id = fp.flight_id
        WHERE substr(fp.observed_at, 1, 10) = ?
        """,
        (day,),
    ).fetchall()
    archive_conn.executemany(
        """
        INSERT INTO flight_positions_archive (
            observed_at, state_time, icao24, callsign, origin_country, airline,
            origin_airport, dest_airport, lat, lon, altitude, velocity, heading,
            on_ground, nearest_airport, flight_first_seen, flight_last_seen
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        """,
        rows,
    )
    archive_conn.commit()
    archive_conn.execute("VACUUM")
    archive_conn.commit()
    archive_conn.close()
    gzip_sqlite(archive_path)


def export_archive_from_legacy(conn_in, day: str, archive_dir: str):
    archive_path = os.path.join(archive_dir, f"flights_{day}.sqlite")
    if os.path.exists(archive_path) or os.path.exists(archive_path + ".gz"):
        return
    archive_conn = create_archive_db(archive_path)
    rows = conn_in.execute(
        """
        SELECT timestamp, timestamp, icao24, callsign, '' AS origin_country,
               airline, NULL AS origin_airport, NULL AS dest_airport, lat, lon,
               altitude, velocity, heading, NULL AS on_ground, nearest_airport,
               timestamp, timestamp
        FROM flights_adsb
        WHERE substr(timestamp, 1, 10) = ?
        """,
        (day,),
    ).fetchall()
    archive_conn.executemany(
        """
        INSERT INTO flight_positions_archive (
            observed_at, state_time, icao24, callsign, origin_country, airline,
            origin_airport, dest_airport, lat, lon, altitude, velocity, heading,
            on_ground, nearest_airport, flight_first_seen, flight_last_seen
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        """,
        rows,
    )
    archive_conn.commit()
    archive_conn.execute("VACUUM")
    archive_conn.commit()
    archive_conn.close()
    gzip_sqlite(archive_path)


def export_live_day_from_normalized(conn_in, day: str, out_path: str):
    conn_out = sqlite3.connect(out_path)
    pipeline.init_db(conn_out)

    flights = conn_in.execute(
        """
        SELECT DISTINCT f.flight_id, f.icao24, f.callsign, f.origin_country, f.airline,
                        f.origin_airport, f.dest_airport, f.first_seen, f.last_seen
        FROM flights f
        JOIN flight_positions fp ON fp.flight_id = f.flight_id
        WHERE substr(fp.observed_at, 1, 10) = ?
        """,
        (day,),
    ).fetchall()
    conn_out.executemany(
        """
        INSERT INTO flights (
            flight_id, icao24, callsign, origin_country, airline,
            origin_airport, dest_airport, first_seen, last_seen
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        """,
        flights,
    )
    positions = conn_in.execute(
        """
        SELECT flight_id, observed_at, state_time, lat, lon, altitude, velocity,
               heading, on_ground, nearest_airport
        FROM flight_positions
        WHERE substr(observed_at, 1, 10) = ?
        """,
        (day,),
    ).fetchall()
    conn_out.executemany(
        """
        INSERT INTO flight_positions (
            flight_id, observed_at, state_time, lat, lon, altitude, velocity,
            heading, on_ground, nearest_airport
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        """,
        positions,
    )
    conn_out.commit()
    conn_out.execute("VACUUM")
    conn_out.commit()
    conn_out.close()


def export_live_day_from_legacy(conn_in, day: str, out_path: str):
    conn_out = sqlite3.connect(out_path)
    pipeline.init_db(conn_out)

    rows = conn_in.execute(
        """
        SELECT timestamp, icao24, callsign, airline, lat, lon, altitude, velocity,
               heading, nearest_airport
        FROM flights_adsb
        WHERE substr(timestamp, 1, 10) = ?
        ORDER BY timestamp ASC
        """,
        (day,),
    )
    batch = []
    batch_size = 2000
    for row in rows:
        ts, icao24, callsign, airline, lat, lon, altitude, velocity, heading, airport = row
        if not ts:
            continue
        observed_at = pipeline.parse_iso(ts)
        flight_id = pipeline.find_or_create_flight(
            conn_out,
            icao24 or "",
            callsign or "",
            "",
            airline or "",
            observed_at,
        )
        if not flight_id:
            continue
        batch.append(
            (
                flight_id,
                observed_at.isoformat(),
                observed_at.isoformat(),
                lat,
                lon,
                altitude,
                velocity,
                heading,
                None,
                airport,
            )
        )
        if len(batch) >= batch_size:
            pipeline.insert_positions(conn_out, batch)
            batch.clear()
    if batch:
        pipeline.insert_positions(conn_out, batch)
    conn_out.execute("VACUUM")
    conn_out.commit()
    conn_out.close()


def main():
    parser = argparse.ArgumentParser(description="Offline migration and daily split")
    parser.add_argument("--input", default="flights_adsb.sqlite")
    parser.add_argument("--out-dir", default=".")
    parser.add_argument("--daily-dir", default=os.path.join("dashboard", "db", "daily"))
    parser.add_argument("--keep-days", type=int, default=1)
    parser.add_argument("--max-gap-minutes", type=int, default=120)
    args = parser.parse_args()

    pipeline.MAX_GAP_MINUTES = args.max_gap_minutes

    ensure_dir(args.out_dir)
    archive_dir = os.path.join(args.out_dir, "archives")
    ensure_dir(archive_dir)

    conn_in = sqlite3.connect(args.input)
    normalized = table_exists(conn_in, "flight_positions") and table_exists(conn_in, "flights")
    legacy = table_exists(conn_in, "flights_adsb")

    if not normalized and not legacy:
        raise SystemExit("No recognizable tables found in input DB.")

    today = datetime.now(timezone.utc).date()
    cutoff_date = today - timedelta(days=args.keep_days - 1)
    cutoff_iso = cutoff_date.isoformat()

    if normalized:
        day_rows = conn_in.execute(
            "SELECT DISTINCT substr(observed_at, 1, 10) AS day FROM flight_positions ORDER BY day ASC"
        ).fetchall()
        days = [row[0] for row in day_rows]
    else:
        day_rows = conn_in.execute(
            "SELECT DISTINCT substr(timestamp, 1, 10) AS day FROM flights_adsb ORDER BY day ASC"
        ).fetchall()
        days = [row[0] for row in day_rows]

    for day in days:
        if day < cutoff_iso:
            if normalized:
                export_archive_from_normalized(conn_in, day, archive_dir)
            else:
                export_archive_from_legacy(conn_in, day, archive_dir)

    daily_dir = os.path.join(args.out_dir, args.daily_dir)
    ensure_dir(daily_dir)

    for day in days:
        if day < cutoff_iso:
            continue
        out_path = os.path.join(daily_dir, f"flights_{day}.sqlite")
        if os.path.exists(out_path):
            os.remove(out_path)
        if normalized:
            export_live_day_from_normalized(conn_in, day, out_path)
        else:
            export_live_day_from_legacy(conn_in, day, out_path)

    conn_in.close()


if __name__ == "__main__":
    main()
