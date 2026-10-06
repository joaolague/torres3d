"""Archive the Open-Meteo forecasts used by Torres 3D, for later validation.

Each run saves one compact JSON snapshot with the first `--hours` hours of every model
set (ECMWF, GFS, Météo-France/ICON) plus best-match tide and sea temperature:

  archive/YYYY/MM/YYYY-MM-DDTHHMMZ.json

Comparing these snapshots with field observations (Diário do Mar) gives forecast error
by model, beach and lead time. Runs in GitHub Actions twice a day; standard library only.

  python tools/archive_forecast.py            # writes into ./archive
  python tools/archive_forecast.py --hours 96 --out /tmp/archive
  python tools/archive_forecast.py --latest data/forecast-latest.json

--latest also writes the full 7-day forecast in the exact raw format the web app downloads
(3 model sets, wind on the app's 3x3 grid). The app falls back to this file when Open-Meteo
cannot be reached from the visitor's browser (offline, blocked or rate-limited).
"""

import argparse
import json
import math
import time
import urllib.error
import urllib.parse
import urllib.request
from datetime import datetime, timezone
from pathlib import Path

# Keep in sync with js/data.js
MARINE_POINT = (-29.37, -49.67)       # ~5 km offshore of Praia Grande
WIND_POINT = (-29.347, -49.727)       # Praia Grande shoreline
TZ = "America/Sao_Paulo"
MODEL_SETS = [
    ("ecmwf", "ecmwf_wam025", "ecmwf_ifs025"),
    ("gfs", "ncep_gfswave025", "gfs_seamless"),
    ("mf", "meteofrance_wave", "icon_seamless"),
]
MARINE_VARS = [
    "wave_height", "wave_direction", "wave_period", "wave_peak_period",
    "wind_wave_height", "wind_wave_direction", "wind_wave_period", "wind_wave_peak_period",
    "swell_wave_height", "swell_wave_direction", "swell_wave_period", "swell_wave_peak_period",
    "secondary_swell_wave_height", "secondary_swell_wave_direction", "secondary_swell_wave_period",
]
MARINE_MIN = ["wave_height", "wave_direction", "wave_period"]
WIND_VARS = ["wind_speed_10m", "wind_direction_10m", "wind_gusts_10m"]

# App wind grid: 3x3 points over the coast-frame domain, same order as windGridPoints() in js/data.js
ORIGIN = (-29.347, -49.727)
COAST_BEARING = 32.0
DOMAIN = dict(x0=-1500.0, x1=3500.0, y0=-3200.0, y1=4000.0)


def wind_grid_points():
    m_lat = 110850.0
    m_lon = 111320.0 * math.cos(math.radians(ORIGIN[0]))
    sea, along = math.radians(COAST_BEARING + 90), math.radians(COAST_BEARING)
    pts = []
    for j in range(3):
        for i in range(3):
            x = DOMAIN["x0"] + i * (DOMAIN["x1"] - DOMAIN["x0"]) / 2
            y = DOMAIN["y0"] + j * (DOMAIN["y1"] - DOMAIN["y0"]) / 2
            e = x * math.sin(sea) + y * math.sin(along)
            n = x * math.cos(sea) + y * math.cos(along)
            pts.append((round(ORIGIN[0] + n / m_lat, 4), round(ORIGIN[1] + e / m_lon, 4)))
    return pts


def get_json(url, retries=3):
    for attempt in range(retries + 1):
        try:
            with urllib.request.urlopen(url, timeout=60) as r:
                return json.load(r)
        except urllib.error.HTTPError as exc:
            if exc.code == 400 or attempt == retries:
                raise
            time.sleep(30 if exc.code == 429 else 5 * (attempt + 1))
        except urllib.error.URLError:
            if attempt == retries:
                raise
            time.sleep(5 * (attempt + 1))


def marine_url(model, variables, days):
    q = {"latitude": MARINE_POINT[0], "longitude": MARINE_POINT[1], "timezone": TZ,
         "forecast_days": days, "hourly": ",".join(variables)}
    if model:
        q["models"] = model
    return "https://marine-api.open-meteo.com/v1/marine?" + urllib.parse.urlencode(q)


def wind_url(model, days):
    q = {"latitude": WIND_POINT[0], "longitude": WIND_POINT[1], "timezone": TZ, "forecast_days": days,
         "hourly": ",".join(WIND_VARS), "wind_speed_unit": "ms", "models": model}
    return "https://api.open-meteo.com/v1/forecast?" + urllib.parse.urlencode(q)


def wind_grid_url(model, days):
    pts = wind_grid_points()
    q = {"latitude": ",".join(str(p[0]) for p in pts), "longitude": ",".join(str(p[1]) for p in pts),
         "hourly": ",".join(WIND_VARS), "wind_speed_unit": "ms", "timezone": TZ, "forecast_days": days, "models": model}
    return "https://api.open-meteo.com/v1/forecast?" + urllib.parse.urlencode(q, safe=",")


def write_latest(path, days=7):
    """Full forecast in the raw shape js/data.js assembles (marine + 9-point wind per set)."""
    snap = {"issued_utc": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%MZ"), "sets": {}}
    full = MARINE_VARS + ["sea_level_height_msl", "sea_surface_temperature"]
    try:
        snap["base"] = get_json(marine_url(None, full, days))
    except Exception as exc:
        print(f"  base marine failed: {exc}")
        snap["base"] = None
    for key, wave_model, wind_model in MODEL_SETS:
        try:
            try:
                marine = get_json(marine_url(wave_model, MARINE_VARS, days))
            except urllib.error.HTTPError:
                marine = get_json(marine_url(wave_model, MARINE_MIN, days))
            wind = get_json(wind_grid_url(wind_model, days))
            snap["sets"][key] = {"marine": marine, "wind": wind if isinstance(wind, list) else [wind]}
        except Exception as exc:
            print(f"  latest {key} failed: {exc}")
    if not snap["sets"]:
        raise SystemExit("latest: no model set could be downloaded")
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(snap, separators=(",", ":")))
    print(f"Wrote {path} ({path.stat().st_size / 1024:.0f} kB); sets: {', '.join(snap['sets'])}")


def trim(hourly, hours, digits=2):
    """Keep the first `hours` steps; round numbers to shrink the archive."""
    out = {}
    for k, v in hourly.items():
        v = v[:hours]
        out[k] = v if k == "time" else [None if x is None else round(x, digits) for x in v]
    return out


def fetch_marine(model, days, hours):
    try:
        data = get_json(marine_url(model, MARINE_VARS, days))
    except urllib.error.HTTPError:
        data = get_json(marine_url(model, MARINE_MIN, days))
    return trim(data["hourly"], hours)


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--hours", type=int, default=72, help="forecast hours to keep (default 72)")
    ap.add_argument("--out", type=Path, default=Path(__file__).resolve().parents[1] / "archive")
    ap.add_argument("--latest", type=Path, help="also write the 7-day app snapshot to this path")
    args = ap.parse_args()
    if args.latest:
        write_latest(args.latest)
    days = min(16, args.hours // 24 + 1)

    now = datetime.now(timezone.utc)
    snapshot = {
        "issued_utc": now.strftime("%Y-%m-%dT%H:%MZ"),
        "timezone": TZ,
        "marine_point": MARINE_POINT,
        "wind_point": WIND_POINT,
        "models": {},
        "errors": {},
    }
    for key, wave_model, wind_model in MODEL_SETS:
        entry = {"wave_model": wave_model, "wind_model": wind_model}
        try:
            entry["waves"] = fetch_marine(wave_model, days, args.hours)
        except Exception as exc:  # keep the other models if one fails
            snapshot["errors"][f"{key}_waves"] = str(exc)
        try:
            entry["wind"] = trim(get_json(wind_url(wind_model, days))["hourly"], args.hours)
        except Exception as exc:
            snapshot["errors"][f"{key}_wind"] = str(exc)
        snapshot["models"][key] = entry

    try:
        base = get_json(marine_url(None, ["sea_level_height_msl", "sea_surface_temperature"], days))
        snapshot["sea"] = trim(base["hourly"], args.hours)
    except Exception as exc:
        snapshot["errors"]["sea"] = str(exc)

    ok = [k for k, m in snapshot["models"].items() if "waves" in m and "wind" in m]
    if not ok:
        raise SystemExit(f"No model set could be downloaded: {snapshot['errors']}")

    path = args.out / now.strftime("%Y") / now.strftime("%m") / now.strftime("%Y-%m-%dT%H%MZ.json")
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(snapshot, separators=(",", ":")))
    print(f"Wrote {path} ({path.stat().st_size / 1024:.0f} kB); models: {', '.join(ok)}"
          + (f"; errors: {list(snapshot['errors'])}" if snapshot["errors"] else ""))


if __name__ == "__main__":
    main()
