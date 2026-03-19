# Flight Observatory

Real-time and historical flight tracking dashboard powered by OpenSky Network ADS-B surveillance data.

## Quick Start

```bash
# Generate historical analytics
python3 build_historical_data.py

# Serve dashboard
python3 -m http.server 8000 --directory dashboard
```

Visit `http://localhost:8000` for live dashboard or `http://localhost:8000/historical.html` for historical analysis.

## Dashboard

- **Live Dashboard** - Real-time metrics, traffic trends, and airport filtering
- **Historical Dashboard** - Multi-month trends, patterns, data quality, and insights

Run `pipeline.py` to continuously collect and update live data.

## Data Flow

```
OpenSky API → pipeline.py → SQLite → dashboard JSON files → Browser
                                    ↓
                            build_historical_data.py (periodic)
```

## Files

- `pipeline.py` - Data collection and live metrics
- `build_historical_data.py` - Historical analysis generation
- `dashboard/` - Frontend (HTML, CSS, JS)
- `flights_adsb.sqlite` - Flight records database
