#!/usr/bin/env python3
"""
Generate historical analysis data from the flights_adsb SQLite database.
This script creates JSON files for the historical dashboard with comprehensive metrics.
"""

import json
import os
import sqlite3
from collections import defaultdict
from datetime import datetime, timezone
from math import floor

SQLITE_PATH = os.getenv("SQLITE_PATH", "flights_adsb.sqlite")
DATA_DIR = os.path.join("dashboard", "data")
os.makedirs(DATA_DIR, exist_ok=True)


def safe_int(val):
    try:
        return int(val)
    except (TypeError, ValueError):
        return None


def safe_float(val):
    try:
        return float(val)
    except (TypeError, ValueError):
        return None


def compute_percentile(values, p):
    """Compute p-th percentile (0-1) of a sorted list."""
    if not values:
        return None
    idx = int((len(values) - 1) * p)
    return values[idx]


def build_monthly_summary(conn):
    """Extract monthly flight counts and statistics."""
    cur = conn.cursor()

    rows = cur.execute(
        """
        SELECT 
            strftime('%Y-%m', substr(timestamp, 1, 19)) as month,
            COUNT(*) as count,
            AVG(CASE WHEN altitude IS NOT NULL THEN altitude END) as alt_avg,
            AVG(CASE WHEN velocity IS NOT NULL THEN velocity END) as speed_avg
        FROM flights_adsb
        WHERE month IS NOT NULL
        GROUP BY month
        ORDER BY month ASC
    """
    ).fetchall()

    monthly = []
    for month, count, alt_avg, speed_avg in rows:
        alt_data = cur.execute(
            """
            SELECT altitude FROM flights_adsb
            WHERE strftime('%Y-%m', substr(timestamp, 1, 19)) = ? AND altitude IS NOT NULL
            ORDER BY altitude ASC
        """,
            (month,),
        ).fetchall()
        alt_vals = [a[0] for a in alt_data if isinstance(a[0], (int, float))]

        speed_data = cur.execute(
            """
            SELECT velocity FROM flights_adsb
            WHERE strftime('%Y-%m', substr(timestamp, 1, 19)) = ? AND velocity IS NOT NULL
            ORDER BY velocity ASC
        """,
            (month,),
        ).fetchall()
        speed_vals = [s[0] for s in speed_data if isinstance(s[0], (int, float))]

        monthly.append(
            {
                "month": month,
                "count": count,
                "alt_avg": round(alt_avg, 1) if alt_avg else None,
                "alt_median": (
                    compute_percentile(alt_vals, 0.5) if alt_vals else None
                ),
                "alt_p90": (
                    compute_percentile(alt_vals, 0.9) if alt_vals else None
                ),
                "speed_avg": round(speed_avg, 1) if speed_avg else None,
                "speed_median": (
                    compute_percentile(speed_vals, 0.5) if speed_vals else None
                ),
                "speed_p90": (
                    compute_percentile(speed_vals, 0.9) if speed_vals else None
                ),
            }
        )

    return monthly


def build_summary(conn):
    """Build comprehensive summary statistics."""
    cur = conn.cursor()

    total_rows = cur.execute("SELECT COUNT(*) FROM flights_adsb").fetchone()[0]

    date_range = cur.execute(
        "SELECT MIN(timestamp), MAX(timestamp) FROM flights_adsb WHERE timestamp IS NOT NULL"
    ).fetchone()
    min_date, max_date = date_range

    months_query = cur.execute(
        "SELECT COUNT(DISTINCT strftime('%Y-%m', substr(timestamp, 1, 19))) FROM flights_adsb"
    ).fetchone()[0]

    yearly = cur.execute(
        """
        SELECT strftime('%Y', substr(timestamp, 1, 19)) as year, COUNT(*) as count
        FROM flights_adsb
        WHERE timestamp IS NOT NULL
        GROUP BY year
        ORDER BY year ASC
    """
    ).fetchall()

    alt_bins = defaultdict(int)
    alt_data = cur.execute("SELECT altitude FROM flights_adsb WHERE altitude IS NOT NULL").fetchall()
    for (alt,) in alt_data:
        if isinstance(alt, (int, float)):
            bin_val = int(floor(alt / 1000) * 1000)
            alt_bins[bin_val] += 1

    speed_bins = defaultdict(int)
    speed_data = cur.execute("SELECT velocity FROM flights_adsb WHERE velocity IS NOT NULL").fetchall()
    for (spd,) in speed_data:
        if isinstance(spd, (int, float)):
            bin_val = int(floor(spd / 50) * 50)
            speed_bins[bin_val] += 1

    top_airlines = cur.execute(
        """
        SELECT airline, COUNT(*) as flights
        FROM flights_adsb
        WHERE airline IS NOT NULL AND airline != ''
        GROUP BY airline
        ORDER BY flights DESC
        LIMIT 30
    """
    ).fetchall()

    top_models = cur.execute(
        """
        SELECT 
            SUBSTR(callsign, 1, 3) as model_code,
            COUNT(*) as flights
        FROM flights_adsb
        WHERE callsign IS NOT NULL AND LENGTH(callsign) > 0
        GROUP BY model_code
        ORDER BY flights DESC
        LIMIT 30
    """
    ).fetchall()

    return {
        "total_rows": total_rows,
        "months": months_query,
        "date_range": [min_date, max_date],
        "yearly_counts": [{"year": int(y), "count": c} for y, c in yearly],
        "altitude_bins": [
            {"altitude_band": f"{k}m", "count": v}
            for k, v in sorted(alt_bins.items())
        ],
        "speed_bins": [
            {"speed_band": f"{k}m/s", "count": v}
            for k, v in sorted(speed_bins.items())
        ],
        "top_airlines": [{"airline": a, "flights": c} for a, c in top_airlines],
        "top_models": [{"model": m, "flights": c} for m, c in top_models],
    }


def build_detailed_metrics(conn):
    """Build detailed metrics including distributions and insights."""
    cur = conn.cursor()

    hourly = defaultdict(int)
    hourly_data = cur.execute(
        "SELECT strftime('%H', substr(timestamp, 1, 19)) as hour FROM flights_adsb WHERE timestamp IS NOT NULL"
    ).fetchall()
    for (hour,) in hourly_data:
        if hour:
            hourly[int(hour)] += 1

    hourly_list = [{"hour": h, "count": hourly.get(h, 0)} for h in range(24)]
    
    aircraft_weekly = cur.execute(
        """
        SELECT strftime('%Y-W%W', substr(timestamp, 1, 19)) as week, COUNT(DISTINCT icao24) as unique_aircraft
        FROM flights_adsb
        WHERE timestamp IS NOT NULL AND icao24 IS NOT NULL
        GROUP BY week
        ORDER BY week ASC
        LIMIT 52
    """
    ).fetchall()
    aircraft_weekly_list = [{"week": w, "aircraft": a} for w, a in aircraft_weekly]

    seasonal = defaultdict(int)
    seasonal_data = cur.execute(
        """
        SELECT strftime('%m', substr(timestamp, 1, 19)) as month, COUNT(*) as count
        FROM flights_adsb
        WHERE timestamp IS NOT NULL
        GROUP BY month
        ORDER BY month ASC
    """
    ).fetchall()
    months_map = {
        "01": "Jan", "02": "Feb", "03": "Mar", "04": "Apr",
        "05": "May", "06": "Jun", "07": "Jul", "08": "Aug",
        "09": "Sep", "10": "Oct", "11": "Nov", "12": "Dec",
    }
    seasonal_list = [
        {"month": months_map.get(m, m), "avg_count": int(c)}
        for m, c in seasonal_data
    ]

    headings = defaultdict(int)
    heading_data = cur.execute(
        "SELECT heading FROM flights_adsb WHERE heading IS NOT NULL AND heading >= 0 AND heading < 360"
    ).fetchall()
    directions = ["N", "NE", "E", "SE", "S", "SW", "W", "NW"]
    for row in heading_data:
        heading = row[0]
        if heading is not None and isinstance(heading, (int, float)):
            h = (float(heading) % 360 + 360) % 360
            idx = int(round(h / 45)) % 8
            headings[directions[idx]] += 1

    heading_list = [
        {"direction": d, "count": headings.get(d, 0)} for d in directions
    ]

    total = cur.execute("SELECT COUNT(*) FROM flights_adsb").fetchone()[0]
    completeness = {}
    if total > 0:
        completeness = {
            "data_completeness_altitude": round(
                100 * cur.execute("SELECT COUNT(*) FROM flights_adsb WHERE altitude IS NOT NULL").fetchone()[0] / total, 1),
            "data_completeness_speed": round(
                100 * cur.execute("SELECT COUNT(*) FROM flights_adsb WHERE velocity IS NOT NULL").fetchone()[0] / total, 1),
            "data_completeness_track": round(
                100 * cur.execute("SELECT COUNT(*) FROM flights_adsb WHERE heading IS NOT NULL").fetchone()[0] / total, 1),
            "data_completeness_position": round(
                100 * cur.execute("SELECT COUNT(*) FROM flights_adsb WHERE lat IS NOT NULL AND lon IS NOT NULL").fetchone()[0] / total, 1),
            "data_completeness_time": round(
                100 * cur.execute("SELECT COUNT(*) FROM flights_adsb WHERE timestamp IS NOT NULL").fetchone()[0] / total, 1),
            "data_completeness_all_fields": round(
                100 * cur.execute(
                    """SELECT COUNT(*) FROM flights_adsb 
                       WHERE altitude IS NOT NULL AND velocity IS NOT NULL AND heading IS NOT NULL 
                       AND lat IS NOT NULL AND lon IS NOT NULL AND timestamp IS NOT NULL"""
                ).fetchone()[0] / total, 1),
        }

    alt_stats = cur.execute(
        "SELECT MIN(altitude), MAX(altitude), AVG(altitude) FROM flights_adsb WHERE altitude IS NOT NULL"
    ).fetchone()
    speed_stats = cur.execute(
        "SELECT MIN(velocity), MAX(velocity), AVG(velocity) FROM flights_adsb WHERE velocity IS NOT NULL"
    ).fetchone()
    
    alt_avg = alt_stats[2] if alt_stats and alt_stats[2] else None
    speed_avg = speed_stats[2] if speed_stats and speed_stats[2] else None

    position_only = cur.execute(
        "SELECT COUNT(*) FROM flights_adsb WHERE lat IS NOT NULL AND lon IS NOT NULL AND (velocity IS NULL OR altitude IS NULL)"
    ).fetchone()[0]
    velocity_reports = cur.execute(
        "SELECT COUNT(*) FROM flights_adsb WHERE velocity IS NOT NULL"
    ).fetchone()[0]
    altitude_reports = cur.execute(
        "SELECT COUNT(*) FROM flights_adsb WHERE altitude IS NOT NULL"
    ).fetchone()[0]
    full_data = cur.execute(
        "SELECT COUNT(*) FROM flights_adsb WHERE lat IS NOT NULL AND lon IS NOT NULL AND velocity IS NOT NULL AND altitude IS NOT NULL AND heading IS NOT NULL"
    ).fetchone()[0]
    
    adsb_types = [
        {"type": "Position Only", "count": position_only},
        {"type": "Has Velocity", "count": velocity_reports},
        {"type": "Has Altitude", "count": altitude_reports},
        {"type": "Full Data", "count": full_data},
    ]

    insights = generate_insights(conn, total, alt_avg, speed_avg)

    on_ground = cur.execute(
        "SELECT COUNT(*) FROM flights_adsb WHERE altitude IS NOT NULL AND altitude < 100"
    ).fetchone()[0]
    airborne = cur.execute(
        "SELECT COUNT(*) FROM flights_adsb WHERE altitude IS NOT NULL AND altitude >= 100"
    ).fetchone()[0]
    
    top_airports_activity = cur.execute(
        """
        SELECT nearest_airport, COUNT(*) as count
        FROM flights_adsb
        WHERE nearest_airport IS NOT NULL AND nearest_airport != 'unknown'
        GROUP BY nearest_airport
        ORDER BY count DESC
        LIMIT 20
    """
    ).fetchall()

    aircraft_daily = cur.execute(
        """
        SELECT DATE(substr(timestamp, 1, 19)) as day, COUNT(DISTINCT icao24) as aircraft
        FROM flights_adsb
        WHERE timestamp IS NOT NULL
        GROUP BY day
        ORDER BY day DESC
        LIMIT 30
    """
    ).fetchall()
    aircraft_daily_list = [{"day": d, "aircraft": a} for d, a in aircraft_daily]

    weekday_data = cur.execute(
        """
        SELECT strftime('%w', substr(timestamp, 1, 19)) as dow, COUNT(*) as count
        FROM flights_adsb
        WHERE timestamp IS NOT NULL
        GROUP BY dow
        ORDER BY dow ASC
    """
    ).fetchall()
    weekday_labels = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"]
    weekday_list = [
        {"weekday": int(row[0]) if row[0] is not None else 0, "label": weekday_labels[int(row[0])] if row[0] is not None else "Mon", "count": row[1]}
        for row in weekday_data
    ]

    unique_aircraft = cur.execute(
        "SELECT COUNT(DISTINCT icao24) FROM flights_adsb WHERE icao24 IS NOT NULL"
    ).fetchone()[0]

    completeness["unique_aircraft"] = unique_aircraft
    completeness["total_records"] = total

    return {
        "hourly_distribution": hourly_list,
        "seasonal_pattern": seasonal_list,
        "heading_distribution": heading_list,
        "aircraft_weekly": aircraft_weekly_list,
        "aircraft_daily": aircraft_daily_list,
        "weekday_distribution": weekday_list,
        "ground_airborne": {"on_ground": on_ground, "airborne": airborne},
        "top_airports_activity": [{"airport": a, "activity": c} for a, c in top_airports_activity],
        "altitude_stats": {
            "min": alt_stats[0], "max": alt_stats[1], "avg": round(alt_stats[2], 1) if alt_stats[2] else None
        },
        "speed_stats": {
            "min": speed_stats[0], "max": speed_stats[1], "avg": round(speed_stats[2], 1) if speed_stats[2] else None
        },
        "adsb_type_distribution": adsb_types,
        "metrics": completeness,
        "insights": insights,
        "unique_aircraft": unique_aircraft,
    }


def generate_insights(conn, total, alt_avg=None, speed_avg=None):
    """Generate human-readable insights from the data."""
    cur = conn.cursor()
    insights = []

    peak_hour = cur.execute(
        """
        SELECT strftime('%H', substr(timestamp, 1, 19)) as hour, COUNT(*) as count
        FROM flights_adsb WHERE timestamp IS NOT NULL
        GROUP BY hour ORDER BY count DESC LIMIT 1
    """
    ).fetchone()
    if peak_hour:
        hour, count = peak_hour
        insights.append({
            "category": "Traffic",
            "title": f"Peak Activity at {hour}:00",
            "detail": f"Highest concentration of flights occurs around {hour}:00 hours with ~{count:,} records.",
        })

    quiet_hour = cur.execute(
        """
        SELECT strftime('%H', substr(timestamp, 1, 19)) as hour, COUNT(*) as count
        FROM flights_adsb WHERE timestamp IS NOT NULL
        GROUP BY hour ORDER BY count ASC LIMIT 1
    """
    ).fetchone()
    if quiet_hour:
        hour, count = quiet_hour
        insights.append({
            "category": "Traffic",
            "title": f"Quietest Hour at {hour}:00",
            "detail": f"Lowest activity observed around {hour}:00 with ~{count:,} records.",
        })

    if alt_avg is None:
        alt_avg = cur.execute("SELECT AVG(altitude) FROM flights_adsb WHERE altitude IS NOT NULL").fetchone()[0]
    if alt_avg:
        insights.append({
            "category": "Operations",
            "title": f"Avg Altitude: {alt_avg:,.0f}m",
            "detail": f"Aircraft operate at an average altitude of {alt_avg:,.0f}m ({alt_avg/304.8:,.0f}ft).",
        })

    if speed_avg is None:
        speed_avg = cur.execute("SELECT AVG(velocity) FROM flights_adsb WHERE velocity IS NOT NULL").fetchone()[0]
    if speed_avg:
        insights.append({
            "category": "Operations",
            "title": f"Avg Speed: {speed_avg:.1f}m/s",
            "detail": f"Average ground speed of {speed_avg:.1f} m/s (~{speed_avg*1.944:.0f} knots).",
        })

    top_airline = cur.execute(
        """
        SELECT airline, COUNT(*) as count FROM flights_adsb
        WHERE airline IS NOT NULL AND airline != '' AND airline != 'unknown'
        GROUP BY airline ORDER BY count DESC LIMIT 1
    """
    ).fetchone()
    if top_airline:
        airline, count = top_airline
        insights.append({
            "category": "Airlines",
            "title": f"Dominant Carrier: {airline}",
            "detail": f"{airline} represents {round(100*count/total, 1)}% of identified flights.",
        })

    top_airport = cur.execute(
        """
        SELECT nearest_airport, COUNT(*) as count FROM flights_adsb
        WHERE nearest_airport IS NOT NULL AND nearest_airport != '' AND nearest_airport != 'unknown'
        GROUP BY nearest_airport ORDER BY count DESC LIMIT 1
    """
    ).fetchone()
    if top_airport:
        airport, count = top_airport
        insights.append({
            "category": "Airports",
            "title": f"Busiest Airport: {airport}",
            "detail": f"{airport} has the highest flight activity with {count:,} records.",
        })

    on_ground = cur.execute(
        "SELECT COUNT(*) FROM flights_adsb WHERE altitude IS NOT NULL AND altitude < 100"
    ).fetchone()[0]
    airborne = cur.execute(
        "SELECT COUNT(*) FROM flights_adsb WHERE altitude IS NOT NULL AND altitude >= 100"
    ).fetchone()[0]
    if airborne > 0:
        airborne_pct = round(100 * airborne / (on_ground + airborne), 1)
        insights.append({
            "category": "Status",
            "title": f"{airborne_pct}% Airborne",
            "detail": f"{airborne_pct}% of flights with altitude data are in the air, {100-airborne_pct:.1f}% on ground.",
        })

    completeness = cur.execute(
        "SELECT COUNT(*) FROM flights_adsb WHERE altitude IS NOT NULL AND velocity IS NOT NULL AND heading IS NOT NULL"
    ).fetchone()[0]
    if total > 0:
        completeness_pct = round(100 * completeness / total, 1)
        insights.append({
            "category": "Quality",
            "title": f"Data Completeness: {completeness_pct}%",
            "detail": f"{completeness_pct}% of records have complete altitude, speed, and heading data.",
        })

    unique_aircraft = cur.execute(
        "SELECT COUNT(DISTINCT icao24) FROM flights_adsb WHERE icao24 IS NOT NULL"
    ).fetchone()[0]
    if unique_aircraft:
        insights.append({
            "category": "Fleet",
            "title": f"{unique_aircraft:,} Unique Aircraft",
            "detail": f"Tracked {unique_aircraft:,} distinct aircraft over the data period.",
        })

    return insights


def main():
    """Generate all historical data files."""
    if not os.path.exists(SQLITE_PATH):
        print(f"Error: {SQLITE_PATH} not found")
        return

    conn = sqlite3.connect(SQLITE_PATH)
    try:
        print("Building historical monthly data...")
        monthly = build_monthly_summary(conn)
        with open(os.path.join(DATA_DIR, "historical_monthly.json"), "w") as f:
            json.dump(monthly, f, indent=2)
        print(f"  ✓ historical_monthly.json ({len(monthly)} months)")

        print("Building historical summary...")
        summary = build_summary(conn)
        with open(os.path.join(DATA_DIR, "historical_summary.json"), "w") as f:
            json.dump(summary, f, indent=2)
        print(f"  ✓ historical_summary.json ({summary['total_rows']} rows)")

        print("Building detailed metrics...")
        detailed = build_detailed_metrics(conn)
        with open(os.path.join(DATA_DIR, "historical_detailed.json"), "w") as f:
            json.dump(detailed, f, indent=2)
        print("  ✓ historical_detailed.json")

        print(f"\n✓ Historical data generated in {DATA_DIR}/")
    finally:
        conn.close()


if __name__ == "__main__":
    main()
