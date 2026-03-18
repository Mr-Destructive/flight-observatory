import json
import os
import glob
import math
from datetime import datetime, timezone
from collections import Counter, defaultdict

DATA_DIR = os.getenv("MUMBAI_DATA_DIR", "scripts/t3/mumbai16-26")
OUT_DIR = os.path.join("dashboard", "data")
os.makedirs(OUT_DIR, exist_ok=True)

files = sorted(glob.glob(os.path.join(DATA_DIR, "*.ndjson")))
DETAILED_METRICS_PATH = os.path.join(DATA_DIR, "DETAILED_METRICS.json")

monthly_counts = Counter()
monthly_alt = defaultdict(list)
monthly_speed = defaultdict(list)
yearly_counts = Counter()
altitude_bins = Counter()
speed_bins = Counter()
ground_count = 0
total_rows = 0

prefix_counts = Counter()
model_counts = Counter()
hour_counts = Counter()
minute_counts = Counter()
weekday_counts = Counter()

for path in files:
    month = os.path.basename(path).replace(".ndjson", "")
    with open(path, "r", encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            if not line:
                continue
            try:
                row = json.loads(line)
            except json.JSONDecodeError:
                continue
            monthly_counts[month] += 1
            total_rows += 1
            year = month.split("-")[0]
            yearly_counts[year] += 1

            alt = row.get("alt")
            if isinstance(alt, (int, float)):
                monthly_alt[month].append(alt)
                altitude_bins[int(math.floor(alt / 1000.0) * 1000)] += 1
            elif alt == "ground":
                ground_count += 1

            gs = row.get("gs")
            if isinstance(gs, (int, float)):
                monthly_speed[month].append(gs)
                speed_bins[int(math.floor(gs / 50.0) * 50)] += 1

            ts = row.get("t")
            if isinstance(ts, (int, float)):
                dt = datetime.fromtimestamp(ts, timezone.utc)
                hour_counts[dt.hour] += 1
                minute_counts[dt.minute] += 1
                weekday_counts[dt.weekday()] += 1

            flight = row.get("flight") or ""
            prefix = "".join([c for c in flight if c.isalpha()])
            if prefix:
                prefix_counts[prefix] += 1

            model = row.get("model")
            if model:
                model_counts[model] += 1


def pctile(arr, p):
    if not arr:
        return None
    arr = sorted(arr)
    idx = int((len(arr) - 1) * p)
    return arr[idx]

monthly_series = []
for month in sorted(monthly_counts.keys()):
    monthly_series.append(
        {
            "month": month,
            "count": monthly_counts[month],
            "alt_median": pctile(monthly_alt.get(month, []), 0.5),
            "alt_p90": pctile(monthly_alt.get(month, []), 0.9),
            "speed_median": pctile(monthly_speed.get(month, []), 0.5),
            "speed_p90": pctile(monthly_speed.get(month, []), 0.9),
        }
    )

summary = {
    "months": len(monthly_series),
    "total_rows": total_rows,
    "ground_rate": (ground_count / total_rows) if total_rows else 0,
    "yearly_counts": [
        {"year": y, "count": yearly_counts[y]}
        for y in sorted(yearly_counts.keys())
    ],
    "altitude_bins": [
        {"altitude_band": k, "count": altitude_bins[k]}
        for k in sorted(altitude_bins.keys())
    ],
    "speed_bins": [
        {"speed_band": k, "count": speed_bins[k]}
        for k in sorted(speed_bins.keys())
    ],
    "top_prefixes": [
        {"prefix": k, "flights": v}
        for k, v in prefix_counts.most_common(20)
    ],
    "top_models": [
        {"model": k, "flights": v}
        for k, v in model_counts.most_common(20)
    ],
}

details = {}
if os.path.exists(DETAILED_METRICS_PATH):
    with open(DETAILED_METRICS_PATH, "r", encoding="utf-8") as f:
        details = json.load(f)

def build_insights(metrics):
    insights = []
    if not metrics:
        return insights

    def add(title, detail, tag):
        insights.append({"title": title, "detail": detail, "tag": tag})

    seasonality = metrics.get("traffic_seasonality_score")
    if isinstance(seasonality, (int, float)):
        if seasonality > 40:
            add(
                "Strong seasonality",
                f"Seasonality score {seasonality:.1f} suggests demand swings by month.",
                "Seasonality",
            )
        else:
            add(
                "Moderate seasonality",
                f"Seasonality score {seasonality:.1f} indicates steadier demand.",
                "Seasonality",
            )

    busiest = metrics.get("busiest_month")
    slowest = metrics.get("slowest_month")
    if busiest and slowest:
        add(
            "Traffic extremes",
            f"Busiest month: {busiest}. Slowest month: {slowest}.",
            "Traffic",
        )

    morning = metrics.get("morning_traffic_percentage")
    evening = metrics.get("evening_traffic_percentage")
    if isinstance(morning, (int, float)) and isinstance(evening, (int, float)):
        add(
            "Daytime concentration",
            f"{morning:.1f}% of activity happens in the morning window.",
            "Operations",
        )

    narrow_body = metrics.get("narrow_body_percentage")
    if isinstance(narrow_body, (int, float)):
        add(
            "Fleet mix leans narrow-body",
            f"Narrow-body aircraft account for {narrow_body:.1f}% of sightings.",
            "Fleet",
        )

    cruise = metrics.get("cruise_altitude_percentage")
    if isinstance(cruise, (int, float)):
        add(
            "Cruise exposure",
            f"{cruise:.1f}% of snapshots are in cruise altitude band.",
            "Altitude",
        )

    completeness = metrics.get("data_completeness_all_fields")
    if isinstance(completeness, (int, float)):
        add(
            "High data completeness",
            f"{completeness:.1f}% of records include all fields.",
            "Quality",
        )

    dominant_heading = metrics.get("dominant_heading")
    if dominant_heading:
        add(
            "Dominant heading",
            f"Most aircraft headings cluster toward {dominant_heading}.",
            "Direction",
        )

    busiest_hour = metrics.get("busiest_hour")
    busiest_traffic = metrics.get("busiest_hour_traffic")
    if isinstance(busiest_hour, int):
        add(
            "Peak hour",
            f"Peak activity at {busiest_hour:02d}:00 with {busiest_traffic:,} records.",
            "Time",
        )

    add(
        "Origin/destination not present",
        "This dataset is snapshot-only; origin/destination and full routes are not directly recorded.",
        "Limits",
    )

    return insights

details_out = {
    "generated_at": datetime.now(timezone.utc).isoformat(),
    "metrics": details,
    "hourly_distribution": [
        {"hour": h, "count": hour_counts[h]} for h in range(24)
    ],
    "minute_distribution": [
        {"minute": m, "count": minute_counts[m]} for m in range(60)
    ],
    "weekday_distribution": [
        {
            "weekday": w,
            "label": ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"][w],
            "count": weekday_counts[w],
        }
        for w in range(7)
    ],
    "seasonal_pattern": [
        {"month": k, "avg_count": v}
        for k, v in sorted((details.get("seasonal_pattern") or {}).items())
    ],
    "heading_distribution": [
        {"direction": k, "count": v}
        for k, v in sorted((details.get("heading_distribution") or {}).items())
    ],
    "fleet_mix": [
        {"type": "Narrow-body", "share": details.get("narrow_body_percentage", 0)},
        {"type": "Wide-body", "share": details.get("wide_body_percentage", 0)},
        {"type": "Regional", "share": details.get("regional_percentage", 0)},
        {"type": "Cargo", "share": details.get("cargo_percentage", 0)},
    ],
    "adsb_type_distribution": [
        {"type": k, "count": v}
        for k, v in sorted((details.get("adsb_type_distribution") or {}).items())
    ],
    "insights": build_insights(details),
}

with open(os.path.join(OUT_DIR, "historical_monthly.json"), "w") as f:
    json.dump(monthly_series, f, indent=2)

with open(os.path.join(OUT_DIR, "historical_summary.json"), "w") as f:
    json.dump(summary, f, indent=2)

with open(os.path.join(OUT_DIR, "historical_detailed.json"), "w") as f:
    json.dump(details_out, f, indent=2)

print("Wrote historical datasets to", OUT_DIR)
