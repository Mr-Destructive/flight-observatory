import json
from pathlib import Path


def assert_contains(path: Path, needles):
    text = path.read_text(encoding="utf-8")
    for needle in needles:
        if needle not in text:
            raise AssertionError(f"{path}: missing {needle}")


def main():
    root = Path(__file__).resolve().parents[1] / "dashboard"

    assert_contains(
        root / "index.html",
        [
            'id="liveMap"',
            'id="metricsGrid"',
            'id="minuteTraffic"',
            'id="airportTable"',
            "leaflet.css",
            "leaflet.js",
        ],
    )

    assert_contains(
        root / "historical.html",
        [
            'id="historicalMap"',
            'id="skyPulse"',
            'id="trafficWave"',
            "leaflet.css",
            "leaflet.js",
        ],
    )

    assert_contains(
        root / "history-lab.html",
        [
            'id="labMap"',
            'id="labMetricGrid"',
            'id="monthVolume"',
            "leaflet.css",
            "leaflet.js",
        ],
    )

    assert_contains(
        root / "case-study" / "mumbai" / "index.html",
        [
            'id="takeawayCards"',
            'id="insightCards"',
            'id="likelyAirlineTable"',
            'id="flowDirectionTable"',
            'id="flowRoutesTable"',
            'id="queryInput"',
            'id="querySchema"',
            'id="queryResult"',
            'data/mumbai_observatory/bundle.json',
            'data/mumbai_observatory/query.sqlite',
            'monthly_trend.svg',
            'yearly_trend.svg',
            'likely_airlines.svg',
            'flow_direction.svg',
            'flow_routes.svg',
        ],
    )

    assert_contains(
        root / "case-study" / "index.html",
        [
            'href="./archive/mumbai-5m-snapshot/"',
            'Case Studies',
            'Mumbai archived',
        ],
    )

    assert_contains(
        root / "case-study" / "archive" / "mumbai-5m-snapshot" / "index.html",
        [
            'Mumbai 5-minute ADS-B snapshot',
            'archived 5-minute snapshot',
            '300-second sampling',
        ],
    )

    assert_contains(
        root / "research.html",
        [
            'url=./case-study/archive/mumbai-5m-snapshot/',
            "window.location.replace('./case-study/archive/mumbai-5m-snapshot/');",
        ],
    )

    assert_contains(
        root / "mumbai-case-study" / "index.html",
        [
            'url=../case-study/archive/mumbai-5m-snapshot/',
            "window.location.replace('../case-study/archive/mumbai-5m-snapshot/');",
        ],
    )

    if not (root / "data/mumbai_observatory/query.sqlite").exists():
        raise AssertionError("research query sqlite missing")

    historical_detailed = json.loads((root / "data/historical_detailed.json").read_text(encoding="utf-8"))
    sky_analytics = json.loads((root / "data/sky_analytics.json").read_text(encoding="utf-8"))

    speed_stats = historical_detailed.get("speed_stats") or {}
    if speed_stats.get("max") and speed_stats["max"] > 300:
        raise AssertionError(f"historical speed max is unrealistic: {speed_stats['max']}")

    detailed_text = (root / "data/historical_detailed.json").read_text(encoding="utf-8")
    if "21ft on average" in detailed_text or "6.48 Mach" in detailed_text:
        raise AssertionError("historical detail still contains the old bad speed copy")

    for item in sky_analytics.get("speed_leaderboard", []):
        if item.get("max_speed") and item["max_speed"] > 300:
            raise AssertionError(f"sky analytics speed leaderboard is unrealistic: {item['max_speed']}")

    print("UI smoke checks passed.")


if __name__ == "__main__":
    main()
