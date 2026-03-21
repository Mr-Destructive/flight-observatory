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

        monthly.append({
            "month": month,
            "count": count,
            "alt_avg": round(alt_avg, 1) if alt_avg else None,
            "alt_median": compute_percentile(alt_vals, 0.5),
            "alt_p90": compute_percentile(alt_vals, 0.9),
            "speed_avg": round(speed_avg, 1) if speed_avg else None,
            "speed_median": compute_percentile(speed_vals, 0.5),
            "speed_p90": compute_percentile(speed_vals, 0.9),
        })

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
        FROM flights_adsb WHERE timestamp IS NOT NULL
        GROUP BY year ORDER BY year ASC
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
        GROUP BY airline ORDER BY flights DESC LIMIT 30
    """
    ).fetchall()

    top_models = cur.execute(
        """
        SELECT SUBSTR(callsign, 1, 3) as model_code, COUNT(*) as flights
        FROM flights_adsb
        WHERE callsign IS NOT NULL AND LENGTH(callsign) > 0
        GROUP BY model_code ORDER BY flights DESC LIMIT 30
    """
    ).fetchall()

    return {
        "total_rows": total_rows,
        "months": months_query,
        "date_range": [min_date, max_date],
        "yearly_counts": [{"year": int(y), "count": c} for y, c in yearly],
        "altitude_bins": [{"altitude_band": f"{k}m", "count": v} for k, v in sorted(alt_bins.items())],
        "speed_bins": [{"speed_band": f"{k}m/s", "count": v} for k, v in sorted(speed_bins.items())],
        "top_airlines": [{"airline": a, "flights": c} for a, c in top_airlines],
        "top_models": [{"model": m, "flights": c} for m, c in top_models],
    }


def build_detailed_metrics(conn):
    """Build detailed metrics including distributions and insights."""
    cur = conn.cursor()

    # Hourly distribution
    hourly = defaultdict(int)
    hourly_data = cur.execute(
        "SELECT strftime('%H', substr(timestamp, 1, 19)) as hour FROM flights_adsb WHERE timestamp IS NOT NULL"
    ).fetchall()
    for (hour,) in hourly_data:
        if hour:
            hourly[int(hour)] += 1

    hourly_list = [{"hour": h, "count": hourly.get(h, 0)} for h in range(24)]
    
    # Calculate average hourly traffic for pulse index
    total_hourly = sum(hourly.values())
    avg_hourly = total_hourly / 24 if total_hourly > 0 else 1
    hourly_pulse = [
        {
            "hour": h,
            "count": hourly.get(h, 0),
            "pulse_index": round(100.0 * hourly.get(h, 0) / avg_hourly, 0),
            "status": "PEAK" if hourly.get(h, 0) > avg_hourly * 1.5 else ("TROUGH" if hourly.get(h, 0) < avg_hourly * 0.5 else "NORMAL")
        }
        for h in range(24)
    ]

    # Aircraft count over time (weekly)
    aircraft_weekly = cur.execute(
        """
        SELECT strftime('%Y-W%W', substr(timestamp, 1, 19)) as week, COUNT(DISTINCT icao24) as unique_aircraft
        FROM flights_adsb WHERE timestamp IS NOT NULL AND icao24 IS NOT NULL
        GROUP BY week ORDER BY week ASC LIMIT 52
    """
    ).fetchall()
    aircraft_weekly_list = [{"week": w, "aircraft": a} for w, a in aircraft_weekly]

    # Seasonal pattern
    seasonal = defaultdict(int)
    seasonal_data = cur.execute(
        """
        SELECT strftime('%m', substr(timestamp, 1, 19)) as month, COUNT(*) as count
        FROM flights_adsb WHERE timestamp IS NOT NULL
        GROUP BY month ORDER BY month ASC
    """
    ).fetchall()
    months_map = {
        "01": "Jan", "02": "Feb", "03": "Mar", "04": "Apr",
        "05": "May", "06": "Jun", "07": "Jul", "08": "Aug",
        "09": "Sep", "10": "Oct", "11": "Nov", "12": "Dec",
    }
    seasonal_list = [{"month": months_map.get(m, m), "avg_count": int(c)} for m, c in seasonal_data]

    # Heading distribution
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
    heading_list = [{"direction": d, "count": headings.get(d, 0)} for d in directions]

    total = cur.execute("SELECT COUNT(*) FROM flights_adsb").fetchone()[0]

    # Data completeness
    completeness = {}
    if total > 0:
        completeness = {
            "data_completeness_altitude": round(100 * cur.execute("SELECT COUNT(*) FROM flights_adsb WHERE altitude IS NOT NULL").fetchone()[0] / total, 1),
            "data_completeness_speed": round(100 * cur.execute("SELECT COUNT(*) FROM flights_adsb WHERE velocity IS NOT NULL").fetchone()[0] / total, 1),
            "data_completeness_track": round(100 * cur.execute("SELECT COUNT(*) FROM flights_adsb WHERE heading IS NOT NULL").fetchone()[0] / total, 1),
            "data_completeness_position": round(100 * cur.execute("SELECT COUNT(*) FROM flights_adsb WHERE lat IS NOT NULL AND lon IS NOT NULL").fetchone()[0] / total, 1),
            "data_completeness_time": round(100 * cur.execute("SELECT COUNT(*) FROM flights_adsb WHERE timestamp IS NOT NULL").fetchone()[0] / total, 1),
            "data_completeness_all_fields": round(100 * cur.execute(
                """SELECT COUNT(*) FROM flights_adsb 
                   WHERE altitude IS NOT NULL AND velocity IS NOT NULL AND heading IS NOT NULL 
                   AND lat IS NOT NULL AND lon IS NOT NULL AND timestamp IS NOT NULL"""
            ).fetchone()[0] / total, 1),
        }

    # Altitude/Speed statistics
    alt_stats = cur.execute("SELECT MIN(altitude), MAX(altitude), AVG(altitude) FROM flights_adsb WHERE altitude IS NOT NULL").fetchone()
    speed_stats = cur.execute("SELECT MIN(velocity), MAX(velocity), AVG(velocity) FROM flights_adsb WHERE velocity IS NOT NULL").fetchone()
    alt_avg = alt_stats[2] if alt_stats and alt_stats[2] else None
    speed_avg = speed_stats[2] if speed_stats and speed_stats[2] else None

    # ADS-B data quality
    position_only = cur.execute("SELECT COUNT(*) FROM flights_adsb WHERE lat IS NOT NULL AND lon IS NOT NULL AND (velocity IS NULL OR altitude IS NULL)").fetchone()[0]
    velocity_reports = cur.execute("SELECT COUNT(*) FROM flights_adsb WHERE velocity IS NOT NULL").fetchone()[0]
    altitude_reports = cur.execute("SELECT COUNT(*) FROM flights_adsb WHERE altitude IS NOT NULL").fetchone()[0]
    full_data = cur.execute("SELECT COUNT(*) FROM flights_adsb WHERE lat IS NOT NULL AND lon IS NOT NULL AND velocity IS NOT NULL AND altitude IS NOT NULL AND heading IS NOT NULL").fetchone()[0]
    
    adsb_types = [
        {"type": "Position Only", "count": position_only},
        {"type": "Has Velocity", "count": velocity_reports},
        {"type": "Has Altitude", "count": altitude_reports},
        {"type": "Full Data", "count": full_data},
    ]

    # Ground vs Airborne
    on_ground = cur.execute("SELECT COUNT(*) FROM flights_adsb WHERE altitude IS NOT NULL AND altitude < 100").fetchone()[0]
    airborne = cur.execute("SELECT COUNT(*) FROM flights_adsb WHERE altitude IS NOT NULL AND altitude >= 100").fetchone()[0]
    
    # In/Out ratio per airport
    airport_flow = cur.execute(
        """
        SELECT 
            nearest_airport,
            SUM(CASE WHEN heading BETWEEN 0 AND 180 THEN 1 ELSE 0 END) as arrivals,
            SUM(CASE WHEN heading > 180 OR heading < 0 THEN 1 ELSE 0 END) as departures,
            COUNT(*) as total
        FROM flights_adsb
        WHERE nearest_airport IS NOT NULL AND nearest_airport != 'unknown' AND heading IS NOT NULL
        GROUP BY nearest_airport
        HAVING total > 50
        ORDER BY total DESC LIMIT 15
    """
    ).fetchall()
    in_out_ratios = [
        {
            "airport": ap,
            "arrivals": arr,
            "departures": dep,
            "total": tot,
            "arrival_ratio": round(arr / dep, 2) if dep > 0 else 0,
            "type": "arrival_heavy" if arr > dep else "departure_heavy"
        }
        for ap, arr, dep, tot in airport_flow
    ]

    # Unique aircraft
    unique_aircraft = cur.execute("SELECT COUNT(DISTINCT icao24) FROM flights_adsb WHERE icao24 IS NOT NULL").fetchone()[0]

    # Aircraft daily
    aircraft_daily = cur.execute(
        """
        SELECT DATE(substr(timestamp, 1, 19)) as day, COUNT(DISTINCT icao24) as aircraft
        FROM flights_adsb WHERE timestamp IS NOT NULL
        GROUP BY day ORDER BY day DESC LIMIT 30
    """
    ).fetchall()
    aircraft_daily_list = [{"day": d, "aircraft": a} for d, a in aircraft_daily]

    # Weekday distribution
    weekday_data = cur.execute(
        """
        SELECT strftime('%w', substr(timestamp, 1, 19)) as dow, COUNT(*) as count
        FROM flights_adsb WHERE timestamp IS NOT NULL
        GROUP BY dow ORDER BY dow ASC
    """
    ).fetchall()
    weekday_labels = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"]
    weekday_list = [
        {"weekday": int(row[0]) if row[0] is not None else 0, "label": weekday_labels[int(row[0])] if row[0] is not None else "Sun", "count": row[1]}
        for row in weekday_data
    ]

    # Ghost planes (0 velocity but altitude > 100)
    ghost_planes = cur.execute(
        """
        SELECT COUNT(DISTINCT icao24) FROM flights_adsb
        WHERE velocity = 0 AND (altitude > 100 OR altitude < -100)
    """
    ).fetchone()[0]
    ghost_sightings = cur.execute(
        "SELECT COUNT(*) FROM flights_adsb WHERE velocity = 0 AND (altitude > 100 OR altitude < -100)"
    ).fetchone()[0]

    completeness["unique_aircraft"] = unique_aircraft
    completeness["total_records"] = total

    return {
        "hourly_distribution": hourly_list,
        "hourly_pulse": hourly_pulse,
        "seasonal_pattern": seasonal_list,
        "heading_distribution": heading_list,
        "aircraft_weekly": aircraft_weekly_list,
        "aircraft_daily": aircraft_daily_list,
        "weekday_distribution": weekday_list,
        "ground_airborne": {"on_ground": on_ground, "airborne": airborne},
        "altitude_stats": {"min": alt_stats[0], "max": alt_stats[1], "avg": round(alt_stats[2], 1) if alt_stats[2] else None},
        "speed_stats": {"min": speed_stats[0], "max": speed_stats[1], "avg": round(speed_stats[2], 1) if speed_stats[2] else None},
        "adsb_type_distribution": adsb_types,
        "metrics": completeness,
        "insights": generate_insights(conn, total, alt_avg, speed_avg),
        "unique_aircraft": unique_aircraft,
        "in_out_ratios": in_out_ratios,
        "ghost_planes": {"aircraft": ghost_planes, "sightings": ghost_sightings},
    }


def build_sky_analytics(conn):
    """Build sky density and altitude band analytics."""
    cur = conn.cursor()

    # Altitude tier distribution
    alt_tiers = cur.execute(
        """
        SELECT 
            CASE 
                WHEN altitude < 3000 THEN 'LOW (0-3km)'
                WHEN altitude < 9000 THEN 'MID (3-9km)'
                WHEN altitude < 12000 THEN 'HIGH (9-12km)'
                WHEN altitude < 15000 THEN 'HEAVY (12-15km)'
                ELSE 'ULTRALONG (>15km)'
            END as tier,
            COUNT(*) as flights,
            ROUND(AVG(velocity)) as avg_speed
        FROM flights_adsb WHERE altitude IS NOT NULL AND velocity IS NOT NULL
        GROUP BY tier ORDER BY MIN(altitude)
    """
    ).fetchall()
    altitude_tiers = [
        {"tier": t, "flights": f, "avg_speed": s}
        for t, f, s in alt_tiers
    ]

    # Speed tier distribution
    speed_tiers = cur.execute(
        """
        SELECT 
            CASE 
                WHEN velocity < 100 THEN 'SLOW (<100m/s)'
                WHEN velocity < 200 THEN 'CRUISING (100-200)'
                WHEN velocity < 300 THEN 'FAST (200-300)'
                WHEN velocity < 400 THEN 'VFAST (300-400)'
                ELSE 'DEMON (>400)'
            END as tier,
            COUNT(*) as flights,
            ROUND(AVG(altitude)) as avg_alt
        FROM flights_adsb WHERE velocity IS NOT NULL AND altitude IS NOT NULL
        GROUP BY tier ORDER BY MIN(velocity)
    """
    ).fetchall()
    speed_tiers = [
        {"tier": t, "flights": f, "avg_alt": a}
        for t, f, a in speed_tiers
    ]

    # Efficiency curve (speed/altitude ratio by altitude band)
    efficiency = cur.execute(
        """
        SELECT 
            CAST(altitude / 1000 AS INTEGER) * 1000 as alt_bucket,
            COUNT(*) as flights,
            ROUND(AVG(velocity)) as avg_speed,
            ROUND(AVG(velocity) / (CAST(altitude / 1000 AS INTEGER) + 1), 2) as efficiency
        FROM flights_adsb
        WHERE altitude > 1000 AND velocity > 50
        GROUP BY alt_bucket
        HAVING flights > 100
        ORDER BY alt_bucket
    """
    ).fetchall()
    efficiency_curve = [
        {"altitude": a, "flights": f, "avg_speed": s, "efficiency": e}
        for a, f, s, e in efficiency
    ]

    # Busiest sky corridors (top altitude bands)
    corridors = cur.execute(
        """
        SELECT 
            CAST(altitude / 1000 AS INTEGER) * 1000 as alt_band,
            COUNT(*) as flights
        FROM flights_adsb
        WHERE altitude > 3000
        GROUP BY alt_band
        ORDER BY flights DESC
        LIMIT 10
    """
    ).fetchall()
    busiest_corridors = [
        {"altitude_band": a, "flights": f}
        for a, f in corridors
    ]

    # Flight phases
    phases = cur.execute(
        """
        SELECT 
            CASE 
                WHEN altitude < 100 THEN 'GROUND'
                WHEN altitude < 3000 THEN 'TAKEOFF/CLIMB'
                WHEN altitude < 9000 THEN 'LOW_CRITERIA'
                WHEN altitude < 12000 THEN 'HIGH_CRITERIA'
                ELSE 'CRUISE'
            END as phase,
            COUNT(*) as sightings,
            ROUND(100.0 * COUNT(*) / SUM(COUNT(*)) OVER(), 1) as percentage
        FROM flights_adsb WHERE altitude IS NOT NULL
        GROUP BY phase
        ORDER BY percentage DESC
    """
    ).fetchall()
    flight_phases = [
        {"phase": p, "sightings": s, "percentage": pct}
        for p, s, pct in phases
    ]

    # Direction traffic
    directions = cur.execute(
        """
        SELECT 
            CASE 
                WHEN heading >= 315 OR heading < 45 THEN 'NORTHBOUND'
                WHEN heading >= 45 AND heading < 135 THEN 'EASTBOUND'
                WHEN heading >= 135 AND heading < 225 THEN 'SOUTHBOUND'
                ELSE 'WESTBOUND'
            END as direction,
            COUNT(*) as flights,
            ROUND(AVG(velocity)) as avg_speed,
            ROUND(AVG(altitude)) as avg_alt
        FROM flights_adsb
        WHERE heading IS NOT NULL AND altitude IS NOT NULL AND velocity IS NOT NULL
        GROUP BY direction
        ORDER BY flights DESC
    """
    ).fetchall()
    directional_traffic = [
        {"direction": d, "flights": f, "avg_speed": s, "avg_alt": a}
        for d, f, s, a in directions
    ]

    # Top speed demons
    speed_demons = cur.execute(
        """
        SELECT icao24, MAX(velocity) as max_speed, ROUND(AVG(altitude)) as avg_alt, nearest_airport
        FROM flights_adsb
        WHERE velocity > 300 AND icao24 IS NOT NULL
        GROUP BY icao24
        ORDER BY max_speed DESC
        LIMIT 15
    """
    ).fetchall()
    speed_leaderboard = [
        {"icao24": i, "max_speed": s, "avg_alt": a, "region": r}
        for i, s, a, r in speed_demons
    ]

    # Holding pattern candidates
    holding = cur.execute(
        """
        SELECT 
            nearest_airport,
            COUNT(DISTINCT icao24) as aircraft,
            COUNT(*) as sightings,
            ROUND(AVG(altitude)) as avg_alt
        FROM flights_adsb
        WHERE altitude BETWEEN 500 AND 3000 
            AND velocity BETWEEN 50 AND 150
            AND nearest_airport IS NOT NULL AND nearest_airport != 'unknown'
        GROUP BY nearest_airport
        HAVING aircraft > 5
        ORDER BY sightings DESC
        LIMIT 10
    """
    ).fetchall()
    holding_patterns = [
        {"airport": a, "aircraft": c, "sightings": s, "avg_alt": alt}
        for a, c, s, alt in holding
    ]

    # Wind effect (eastbound vs westbound speeds)
    wind_effect = cur.execute(
        """
        SELECT 
            CASE 
                WHEN heading >= 270 OR heading < 90 THEN 'EASTBOUND (Tailwind)'
                ELSE 'WESTBOUND (Headwind)'
            END as route,
            COUNT(*) as flights,
            ROUND(AVG(velocity)) as avg_speed,
            ROUND(AVG(altitude)) as avg_alt
        FROM flights_adsb
        WHERE velocity IS NOT NULL AND heading IS NOT NULL AND velocity > 0
        GROUP BY route
    """
    ).fetchall()
    wind_effect_data = [
        {"route": r, "flights": f, "avg_speed": s, "avg_alt": a}
        for r, f, s, a in wind_effect
    ]

    # Regional density (5x5 degree grid)
    regional_density = cur.execute(
        """
        SELECT 
            ROUND(lat / 5) * 5 as lat_center,
            ROUND(lon / 5) * 5 as lon_center,
            COUNT(*) as flights,
            COUNT(DISTINCT icao24) as unique_aircraft
        FROM flights_adsb
        WHERE lat IS NOT NULL AND lon IS NOT NULL
        GROUP BY lat_center, lon_center
        HAVING flights > 100
        ORDER BY flights DESC
        LIMIT 20
    """
    ).fetchall()
    regional_grid = [
        {"lat": lat, "lon": lon, "flights": f, "aircraft": a}
        for lat, lon, f, a in regional_density
    ]

    # Airline altitude preferences
    airline_alt = cur.execute(
        """
        SELECT airline, COUNT(*) as flights, ROUND(AVG(altitude)) as avg_alt, ROUND(AVG(velocity)) as avg_speed
        FROM flights_adsb
        WHERE airline IS NOT NULL AND airline != '' AND airline != 'unknown'
        GROUP BY airline
        HAVING flights > 50
        ORDER BY avg_alt DESC
        LIMIT 20
    """
    ).fetchall()
    airline_preferences = [
        {"airline": a, "flights": f, "avg_alt": alt, "avg_speed": s}
        for a, f, alt, s in airline_alt
    ]

    # Peak hours analysis
    peak_hours = cur.execute(
        """
        SELECT strftime('%H', substr(timestamp, 1, 19)) as hour, COUNT(*) as flights
        FROM flights_adsb WHERE timestamp IS NOT NULL
        GROUP BY hour ORDER BY flights DESC LIMIT 5
    """
    ).fetchall()

    quiet_hours = cur.execute(
        """
        SELECT strftime('%H', substr(timestamp, 1, 19)) as hour, COUNT(*) as flights
        FROM flights_adsb WHERE timestamp IS NOT NULL
        GROUP BY hour ORDER BY flights ASC LIMIT 5
    """
    ).fetchall()

    return {
        "altitude_tiers": altitude_tiers,
        "speed_tiers": speed_tiers,
        "efficiency_curve": efficiency_curve,
        "busiest_corridors": busiest_corridors,
        "flight_phases": flight_phases,
        "directional_traffic": directional_traffic,
        "speed_leaderboard": speed_leaderboard,
        "holding_patterns": holding_patterns,
        "wind_effect": wind_effect_data,
        "regional_density": regional_grid,
        "airline_preferences": airline_preferences,
        "peak_hours": [{"hour": h, "flights": f} for h, f in peak_hours],
        "quiet_hours": [{"hour": h, "flights": f} for h, f in quiet_hours],
    }


def generate_insights(conn, total, alt_avg=None, speed_avg=None):
    """Generate human-readable insights from the data."""
    cur = conn.cursor()
    insights = []

    # Peak hour
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
            "title": f"Peak Hour: {hour}:00",
            "detail": f"{count:,} flights at {hour}:00 - highest traffic concentration of the day",
            "icon": "⏰"
        })

    # Quiet hour
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
            "title": f"Quietest Hour: {hour}:00",
            "detail": f"Only {count:,} flights at {hour}:00 - airspace is most sparse",
            "icon": "🌙"
        })

    # Busiest altitude
    busiest_alt = cur.execute(
        """
        SELECT CAST(altitude / 1000 AS INTEGER) * 1000 as band, COUNT(*) as cnt
        FROM flights_adsb WHERE altitude > 3000
        GROUP BY band ORDER BY cnt DESC LIMIT 1
    """
    ).fetchone()
    if busiest_alt:
        band, cnt = busiest_alt
        insights.append({
            "category": "Sky",
            "title": f"Preferred Cruise: {int(band)/1000:.0f}km",
            "detail": f"{cnt:,} flights at {int(band)/1000:.0f}km - the busiest sky corridor",
            "icon": "✈️"
        })

    # Speed demon
    max_speed = cur.execute("SELECT MAX(velocity) FROM flights_adsb WHERE velocity IS NOT NULL").fetchone()[0]
    if max_speed:
        knots = round(max_speed * 1.944)
        mach = round(max_speed / 343, 2)
        insights.append({
            "category": "Records",
            "title": f"Speed Record: {max_speed:.0f}m/s",
            "detail": f"That's {knots} knots ({mach} Mach) - the fastest aircraft recorded",
            "icon": "⚡"
        })

    if alt_avg:
        insights.append({
            "category": "Operations",
            "title": f"Avg Altitude: {alt_avg:,.0f}m",
            "detail": f"Aircraft cruise at {alt_avg/304.8:,.0f}ft on average",
            "icon": "🛫"
        })

    if speed_avg:
        insights.append({
            "category": "Operations",
            "title": f"Avg Speed: {speed_avg:.0f}m/s",
            "detail": f"Average ground speed is {speed_avg*1.944:.0f} knots",
            "icon": "🚀"
        })

    # Top airline
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
            "detail": f"{airline} flies {round(100*count/total, 1)}% of identified flights",
            "icon": "🏆"
        })

    # Busiest airport
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
            "category": "Hubs",
            "title": f"Busiest Hub: {airport}",
            "detail": f"{airport} has {count:,} flight sightings - the most active airspace",
            "icon": "🛬"
        })

    # Airborne percentage
    airborne = cur.execute("SELECT COUNT(*) FROM flights_adsb WHERE altitude IS NOT NULL AND altitude >= 100").fetchone()[0]
    total_alt = cur.execute("SELECT COUNT(*) FROM flights_adsb WHERE altitude IS NOT NULL").fetchone()[0]
    if total_alt > 0:
        airborne_pct = round(100 * airborne / total_alt, 1)
        insights.append({
            "category": "Status",
            "title": f"{airborne_pct}% Airborne",
            "detail": f"Most tracked flights are in the air, not on ground",
            "icon": "🌤️"
        })

    # Data quality
    completeness = cur.execute(
        "SELECT COUNT(*) FROM flights_adsb WHERE altitude IS NOT NULL AND velocity IS NOT NULL AND heading IS NOT NULL"
    ).fetchone()[0]
    if total > 0:
        completeness_pct = round(100 * completeness / total, 1)
        insights.append({
            "category": "Quality",
            "title": f"Data Quality: {completeness_pct}%",
            "detail": f"{completeness_pct}% of records have complete telemetry data",
            "icon": "📊"
        })

    # Ghost planes
    ghost = cur.execute("SELECT COUNT(DISTINCT icao24) FROM flights_adsb WHERE velocity = 0 AND (altitude > 100 OR altitude < -100)").fetchone()[0]
    if ghost:
        insights.append({
            "category": "Anomaly",
            "title": f"Ghost Fleet: {ghost}",
            "detail": f"{ghost} aircraft with 0 velocity at altitude - possible parked aircraft",
            "icon": "👻"
        })

    if unique_aircraft := cur.execute("SELECT COUNT(DISTINCT icao24) FROM flights_adsb WHERE icao24 IS NOT NULL").fetchone()[0]:
        insights.append({
            "category": "Fleet",
            "title": f"{unique_aircraft:,} Unique Aircraft",
            "detail": f"Tracked {unique_aircraft:,} distinct aircraft in the data",
            "icon": "🛩️"
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

        print("Building sky analytics...")
        sky = build_sky_analytics(conn)
        with open(os.path.join(DATA_DIR, "sky_analytics.json"), "w") as f:
            json.dump(sky, f, indent=2)
        print("  ✓ sky_analytics.json")

        print(f"\n✓ All historical data generated in {DATA_DIR}/")
    finally:
        conn.close()


if __name__ == "__main__":
    main()
