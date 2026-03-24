#!/usr/bin/env python3
"""Build a local airline logo cache for the dashboard.

This script resolves airline names from the dashboard data files to the
Soaring Symbols SVG catalog, downloads the matched logos once, and writes a
manifest for the dashboard to consume offline.
"""

from __future__ import annotations

import csv
import json
import re
import unicodedata
from collections import defaultdict
from pathlib import Path
from typing import Dict, Iterable, Optional

import requests

ROOT = Path(__file__).resolve().parents[1]
DASHBOARD_DATA = ROOT / "dashboard" / "data"
LOGO_DIR = ROOT / "dashboard" / "assets" / "airline-logos"
MANIFEST_PATH = DASHBOARD_DATA / "airline_logos.json"
AIRLINES_DAT = ROOT / "airlines.dat"
SOARING_JSON_URL = "https://raw.githubusercontent.com/anhthang/soaring-symbols/main/airlines.json"
SOARING_ASSET_BASE = "https://raw.githubusercontent.com/anhthang/soaring-symbols/main/assets"


def norm(value: str) -> str:
    text = unicodedata.normalize("NFKD", str(value or ""))
    text = text.encode("ascii", "ignore").decode("ascii")
    return re.sub(r"[^a-z0-9]+", "", text.lower())


def ensure_dir(path: Path) -> None:
    path.mkdir(parents=True, exist_ok=True)


def load_dashboard_airlines() -> set[str]:
    names: set[str] = set()
    for path in DASHBOARD_DATA.glob("*.json"):
      if path.name == "airline_logos.json":
        continue
      try:
        data = json.loads(path.read_text(encoding="utf-8"))
      except Exception:
        continue

      def walk(value):
        if isinstance(value, dict):
          for key, val in value.items():
            if key == "airline" and isinstance(val, str):
              value_norm = val.strip()
              if value_norm and value_norm.lower() != "unknown":
                names.add(value_norm)
            walk(val)
        elif isinstance(value, list):
          for item in value:
            walk(item)

      walk(data)
    return names


def load_openflights() -> list[dict]:
    rows = []
    with AIRLINES_DAT.open(newline="", encoding="latin1") as f:
        reader = csv.reader(f)
        for row in reader:
            if len(row) < 8:
                continue
            rows.append(
                {
                    "name": row[1].strip(),
                    "iata": "" if row[3].strip() in ("", r"\N") else row[3].strip().upper(),
                    "icao": "" if row[4].strip() in ("", r"\N") else row[4].strip().upper(),
                    "country": row[6].strip(),
                    "active": row[7].strip().upper() == "Y",
                }
            )
    return rows


def load_soaring() -> list[dict]:
    res = requests.get(SOARING_JSON_URL, timeout=60)
    res.raise_for_status()
    return res.json()


def build_soaring_index(items: Iterable[dict]) -> dict:
    by_name: Dict[str, dict] = {}
    by_iata: Dict[str, dict] = {}
    by_icao: Dict[str, dict] = {}
    by_slug: Dict[str, dict] = {}
    for item in items:
        by_name[norm(item.get("name"))] = item
        if item.get("iata"):
            by_iata[item["iata"].upper()] = item
        if item.get("icao"):
            by_icao[item["icao"].upper()] = item
        if item.get("slug"):
            by_slug[item["slug"]] = item
        for sub in item.get("subsidiaries", []) or []:
            by_name[norm(sub.get("name"))] = sub
            if sub.get("iata"):
                by_iata[sub["iata"].upper()] = sub
            if sub.get("icao"):
                by_icao[sub["icao"].upper()] = sub
    return {"name": by_name, "iata": by_iata, "icao": by_icao, "slug": by_slug}


def resolve_logo(name: str, openflights: list[dict], soaring_index: dict) -> Optional[dict]:
    key = norm(name)
    if not key:
        return None

    # Direct match in Soaring Symbols by name.
    entry = soaring_index["name"].get(key)
    if entry:
        return entry

    # Match via OpenFlights codes, then Soaring Symbols codes.
    of_match = None
    for row in openflights:
        if norm(row["name"]) == key:
            of_match = row
            break
    if of_match:
        if of_match.get("iata") and of_match["iata"] in soaring_index["iata"]:
            return soaring_index["iata"][of_match["iata"]]
        if of_match.get("icao") and of_match["icao"] in soaring_index["icao"]:
            return soaring_index["icao"][of_match["icao"]]

    # As a last attempt, use the name key directly against the Soaring slug map.
    if key in soaring_index["slug"]:
        return soaring_index["slug"][key]
    return None


def fallback_svg(label: str, color_seed: str) -> str:
    import hashlib

    digest = hashlib.sha1(color_seed.encode("utf-8")).hexdigest()
    bg = f"#{digest[:6]}"
    fg = "#f6f7fb"
    initials = "".join(part[0] for part in re.findall(r"[A-Za-z0-9]+", label)[:2]).upper() or "NA"
    return f"""<svg role="img" viewBox="0 0 64 64" xmlns="http://www.w3.org/2000/svg">
  <rect width="64" height="64" rx="14" fill="{bg}"/>
  <text x="32" y="38" fill="{fg}" font-family="Inter, Arial, sans-serif" font-size="20" font-weight="700" text-anchor="middle">{initials[:3]}</text>
</svg>
"""


def fetch_svg(url: str) -> Optional[str]:
    res = requests.get(url, timeout=60)
    if not res.ok:
        return None
    return res.text


def main() -> None:
    ensure_dir(LOGO_DIR)
    openflights = load_openflights()
    soaring_index = build_soaring_index(load_soaring())
    target_names = sorted(load_dashboard_airlines())

    by_key = {}
    by_iata = {}
    by_icao = {}

    for name in target_names:
        if not name:
            continue
        match = resolve_logo(name, openflights, soaring_index)
        key = norm(name)
        if match and match.get("slug"):
            slug = match["slug"]
            logo_dir = LOGO_DIR / slug
            ensure_dir(logo_dir)
            logo_path = logo_dir / "logo.svg"
            if not logo_path.exists():
                svg = fetch_svg(f"{SOARING_ASSET_BASE}/{slug}/logo.svg") or fetch_svg(
                    f"{SOARING_ASSET_BASE}/{slug}/icon.svg"
                )
                if not svg:
                    svg = fallback_svg(match.get("name") or name, name)
                logo_path.write_text(svg, encoding="utf-8")
            rel_logo = f"./assets/airline-logos/{slug}/logo.svg"
            entry = {
                "name": match.get("name") or name,
                "iata": match.get("iata") or "",
                "icao": match.get("icao") or "",
                "slug": slug,
                "logo": rel_logo,
                "kind": "real",
            }
        else:
            slug = f"generated-{key}"
            logo_dir = LOGO_DIR / slug
            ensure_dir(logo_dir)
            logo_path = logo_dir / "logo.svg"
            logo_path.write_text(fallback_svg(name, name), encoding="utf-8")
            rel_logo = f"./assets/airline-logos/{slug}/logo.svg"
            entry = {
                "name": name,
                "iata": "",
                "icao": "",
                "slug": slug,
                "logo": rel_logo,
                "kind": "generated",
            }

        by_key[key] = entry
        if entry["iata"]:
            by_iata[entry["iata"].upper()] = entry
        if entry["icao"]:
            by_icao[entry["icao"].upper()] = entry

    manifest = {
        "byKey": by_key,
        "byIata": by_iata,
        "byIcao": by_icao,
        "count": len(by_key),
        "source": "anhthang/soaring-symbols",
    }
    MANIFEST_PATH.write_text(json.dumps(manifest, indent=2, sort_keys=True), encoding="utf-8")
    print(f"Wrote {MANIFEST_PATH} with {len(by_key)} entries.")


if __name__ == "__main__":
    main()
