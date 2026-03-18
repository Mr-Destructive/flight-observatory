import json
import os
import glob
import math
from collections import Counter, defaultdict

DATA_DIR = os.getenv("MUMBAI_DATA_DIR", "scripts/t3/mumbai16-26")
OUT_DIR = os.path.join("dashboard", "data")
os.makedirs(OUT_DIR, exist_ok=True)

files = sorted(glob.glob(os.path.join(DATA_DIR, "*.ndjson")))

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

with open(os.path.join(OUT_DIR, "historical_monthly.json"), "w") as f:
    json.dump(monthly_series, f, indent=2)

with open(os.path.join(OUT_DIR, "historical_summary.json"), "w") as f:
    json.dump(summary, f, indent=2)

print("Wrote historical datasets to", OUT_DIR)
