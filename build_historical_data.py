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
            strftime('%Y-%m', timestamp) as month,
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
        # Get median values for the month
        alt_data = cur.execute(
            """
            SELECT altitude FROM flights_adsb
            WHERE strftime('%Y-%m', timestamp) = ? AND altitude IS NOT NULL
            ORDER BY altitude ASC
        """,
            (month,),
        ).fetchall()
        alt_vals = [a[0] for a in alt_data if isinstance(a[0], (int, float))]

        speed_data = cur.execute(
            """
            SELECT velocity FROM flights_adsb
            WHERE strftime('%Y-%m', timestamp) = ? AND velocity IS NOT NULL
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
                "speed_avg": round(speed_avg, 1) if speed_avg else None,
                "speed_median": (
                    compute_percentile(speed_vals, 0.5) if speed_vals else None
                ),
            }
        )

    return monthly


def build_summary(conn):
    """Build comprehensive summary statistics."""
    cur = conn.cursor()

    # Total rows
    total_rows = cur.execute("SELECT COUNT(*) FROM flights_adsb").fetchone()[0]

    # Date range
    date_range = cur.execute(
        "SELECT MIN(timestamp), MAX(timestamp) FROM flights_adsb WHERE timestamp IS NOT NULL"
    ).fetchone()
    min_date, max_date = date_range

    # Count months
    months_query = cur.execute(
        "SELECT COUNT(DISTINCT strftime('%Y-%m', timestamp)) FROM flights_adsb"
    ).fetchone()[0]

    # Yearly counts
    yearly = cur.execute(
        """
        SELECT strftime('%Y', timestamp) as year, COUNT(*) as count
        FROM flights_adsb
        WHERE timestamp IS NOT NULL
        GROUP BY year
        ORDER BY year ASC
    """
    ).fetchall()

    # Altitude bins
    alt_bins = defaultdict(int)
    alt_data = cur.execute("SELECT altitude FROM flights_adsb WHERE altitude IS NOT NULL").fetchall()
    for (alt,) in alt_data:
        if isinstance(alt, (int, float)):
            bin_val = int(floor(alt / 1000) * 1000)
            alt_bins[bin_val] += 1

    # Speed bins
    speed_bins = defaultdict(int)
    speed_data = cur.execute("SELECT velocity FROM flights_adsb WHERE velocity IS NOT NULL").fetchall()
    for (spd,) in speed_data:
        if isinstance(spd, (int, float)):
            bin_val = int(floor(spd / 50) * 50)
            speed_bins[bin_val] += 1

    # Top airlines
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

    # Top aircraft models (from callsign prefix if available)
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

    # Hourly distribution
    hourly = defaultdict(int)
    hourly_data = cur.execute(
        "SELECT strftime('%H', timestamp) as hour FROM flights_adsb WHERE timestamp IS NOT NULL"
    ).fetchall()
    for (hour,) in hourly_data:
        if hour:
            hourly[int(hour)] += 1

    hourly_list = [{"hour": h, "count": hourly.get(h, 0)} for h in range(24)]

    # Seasonal pattern (month of year)
    seasonal = defaultdict(list)
    seasonal_data = cur.execute(
        """
        SELECT strftime('%m', timestamp) as month, COUNT(*) as count
        FROM flights_adsb
        WHERE timestamp IS NOT NULL
        GROUP BY month
        ORDER BY month ASC
    """
    ).fetchall()
    months_map = {
        "01": "Jan",
        "02": "Feb",
        "03": "Mar",
        "04": "Apr",
        "05": "May",
        "06": "Jun",
        "07": "Jul",
        "08": "Aug",
        "09": "Sep",
        "10": "Oct",
        "11": "Nov",
        "12": "Dec",
    }
    seasonal_list = [
        {"month": months_map.get(m, m), "avg_count": int(c)}
        for m, c in seasonal_data
    ]

    # Heading distribution (8 cardinal directions)
    headings = defaultdict(int)
    heading_data = cur.execute(
        "SELECT heading FROM flights_adsb WHERE heading IS NOT NULL"
    ).fetchall()
    directions = ["N", "NE", "E", "SE", "S", "SW", "W", "NW"]
    for (heading,) in heading_data:
        if isinstance(heading, (int, float)):
            h = (heading % 360 + 360) % 360
            idx = int(round(h / 45)) % 8
            headings[directions[idx]] += 1

    heading_list = [
        {"direction": d, "count": headings.get(d, 0)} for d in directions
    ]

    # Data completeness
    total = cur.execute("SELECT COUNT(*) FROM flights_adsb").fetchone()[0]
    completeness = {}
    if total > 0:
        completeness = {
            "data_completeness_altitude": round(
                100
                * cur.execute(
                    "SELECT COUNT(*) FROM flights_adsb WHERE altitude IS NOT NULL"
                ).fetchone()[0]
                / total,
                1,
            ),
            "data_completeness_speed": round(
                100
                * cur.execute(
                    "SELECT COUNT(*) FROM flights_adsb WHERE velocity IS NOT NULL"
                ).fetchone()[0]
                / total,
                1,
            ),
            "data_completeness_track": round(
                100
                * cur.execute(
                    "SELECT COUNT(*) FROM flights_adsb WHERE heading IS NOT NULL"
                ).fetchone()[0]
                / total,
                1,
            ),
            "data_completeness_position": round(
                100
                * cur.execute(
                    "SELECT COUNT(*) FROM flights_adsb WHERE lat IS NOT NULL AND lon IS NOT NULL"
                ).fetchone()[0]
                / total,
                1,
            ),
            "data_completeness_time": round(
                100
                * cur.execute(
                    "SELECT COUNT(*) FROM flights_adsb WHERE timestamp IS NOT NULL"
                ).fetchone()[0]
                / total,
                1,
            ),
            "data_completeness_all_fields": round(
                100
                * cur.execute(
                    """SELECT COUNT(*) FROM flights_adsb 
                       WHERE altitude IS NOT NULL 
                       AND velocity IS NOT NULL 
                       AND heading IS NOT NULL 
                       AND lat IS NOT NULL 
                       AND lon IS NOT NULL 
                       AND timestamp IS NOT NULL"""
                ).fetchone()[0]
                / total,
                1,
            ),
        }

    # ADS-B types (placeholder - would need callsign analysis)
    adsb_types = [
        {"type": "Position Only", "count": 0},
        {"type": "Position + Velocity", "count": 0},
        {"type": "Position + Altitude", "count": 0},
        {"type": "All Fields", "count": 0},
    ]

    # Generate insights
    insights = generate_insights(conn, total)

    return {
        "hourly_distribution": hourly_list,
        "seasonal_pattern": seasonal_list,
        "heading_distribution": heading_list,
        "adsb_type_distribution": adsb_types,
        "metrics": completeness,
        "insights": insights,
    }


def generate_insights(conn, total):
    """Generate human-readable insights from the data."""
    cur = conn.cursor()
    insights = []

    # Peak hour
    peak_hour = cur.execute(
        """
        SELECT strftime('%H', timestamp) as hour, COUNT(*) as count
        FROM flights_adsb
        WHERE timestamp IS NOT NULL
        GROUP BY hour
        ORDER BY count DESC
        LIMIT 1
    """
    ).fetchone()
    if peak_hour:
        hour, count = peak_hour
        insights.append(
            {
                "category": "Traffic",
                "title": f"Peak Activity at {hour}:00",
                "detail": f"Highest concentration of flights occurs around {hour}:00 hours with ~{count} records.",
            }
        )

    # Altitude trend
    alt_avg = cur.execute(
        "SELECT AVG(altitude) FROM flights_adsb WHERE altitude IS NOT NULL"
    ).fetchone()[0]
    if alt_avg:
        insights.append(
            {
                "category": "Operations",
                "title": f"Average Altitude: {alt_avg:.0f}m",
                "detail": f"Aircraft in the region operate at an average altitude of {alt_avg:.0f} meters.",
            }
        )

    # Speed trend
    speed_avg = cur.execute(
        "SELECT AVG(velocity) FROM flights_adsb WHERE velocity IS NOT NULL"
    ).fetchone()[0]
    if speed_avg:
        insights.append(
            {
                "category": "Operations",
                "title": f"Average Speed: {speed_avg:.1f}m/s",
                "detail": f"Aircraft maintain an average speed of {speed_avg:.1f} m/s (≈{speed_avg*1.94:.0f}kt).",
            }
        )

    # Top airline
    top_airline = cur.execute(
        """
        SELECT airline, COUNT(*) as count
        FROM flights_adsb
        WHERE airline IS NOT NULL AND airline != ''
        GROUP BY airline
        ORDER BY count DESC
        LIMIT 1
    """
    ).fetchone()
    if top_airline:
        airline, count = top_airline
        insights.append(
            {
                "category": "Airlines",
                "title": f"Dominant Carrier: {airline}",
                "detail": f"{airline} represents {round(100*count/total, 1)}% of all tracked flights.",
            }
        )

    # Data quality
    completeness = cur.execute(
        """
        SELECT COUNT(*)
        FROM flights_adsb
        WHERE altitude IS NOT NULL AND velocity IS NOT NULL AND heading IS NOT NULL
    """
    ).fetchone()[0]
    if total > 0:
        completeness_pct = round(100 * completeness / total, 1)
        insights.append(
            {
                "category": "Quality",
                "title": f"Data Completeness: {completeness_pct}%",
                "detail": f"{completeness_pct}% of records have all key fields (altitude, speed, heading).",
            }
        )

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
