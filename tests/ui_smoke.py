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

    print("UI smoke checks passed.")


if __name__ == "__main__":
    main()
