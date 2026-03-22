import gzip
import os
import sqlite3
from datetime import datetime, timedelta, timezone

import pipeline


def test_find_or_create_flight_sessionization():
    conn = sqlite3.connect(":memory:")
    pipeline.init_db(conn)

    now = datetime.now(timezone.utc)
    pipeline.MAX_GAP_MINUTES = 120

    flight_id_1 = pipeline.find_or_create_flight(
        conn,
        "abc123",
        "TEST123",
        "Testland",
        "TestAir",
        now,
    )
    flight_id_2 = pipeline.find_or_create_flight(
        conn,
        "abc123",
        "TEST123",
        "Testland",
        "TestAir",
        now + timedelta(minutes=30),
    )

    assert flight_id_1 == flight_id_2
    conn.close()


def test_archive_and_prune_daily(tmp_path):
    db_path = tmp_path / "flights_adsb.sqlite"
    archive_dir = tmp_path / "archives"
    archive_dir.mkdir(parents=True, exist_ok=True)

    pipeline.SQLITE_PATH = str(db_path)
    pipeline.ARCHIVE_DIR = str(archive_dir)
    pipeline.ARCHIVE_OLDER_THAN_DAYS = 1
    pipeline.RETENTION_DAYS = 1
    pipeline.VACUUM_MAIN = True

    conn = sqlite3.connect(db_path)
    pipeline.init_db(conn)

    today = datetime.now(timezone.utc).date()
    yesterday = today - timedelta(days=1)

    def add_observation(day, icao, callsign):
        observed_at = datetime.combine(day, datetime.min.time(), tzinfo=timezone.utc)
        flight_id = pipeline.find_or_create_flight(
            conn,
            icao,
            callsign,
            "Testland",
            "TestAir",
            observed_at,
        )
        pipeline.insert_positions(
            conn,
            [
                (
                    flight_id,
                    observed_at.isoformat(),
                    observed_at.isoformat(),
                    19.0,
                    72.0,
                    10000.0,
                    220.0,
                    90.0,
                    0,
                    "VABB",
                )
            ],
        )

    add_observation(yesterday, "abc123", "TEST123")
    add_observation(today, "def456", "TEST456")

    pipeline.archive_old_rows(conn)
    pipeline.prune_old_rows(conn)

    cur = conn.execute("SELECT COUNT(*) FROM flight_positions")
    remaining_positions = cur.fetchone()[0]
    cur = conn.execute("SELECT COUNT(*) FROM flights")
    remaining_flights = cur.fetchone()[0]

    assert remaining_positions == 1
    assert remaining_flights == 1

    archive_file = archive_dir / f"flights_{yesterday.isoformat()}.sqlite.gz"
    assert archive_file.exists()
    assert archive_file.stat().st_size > 0

    with gzip.open(archive_file, "rb") as f:
        header = f.read(16)
    assert header.startswith(b"SQLite format 3")

    conn.close()
