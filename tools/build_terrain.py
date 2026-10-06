"""Build data/terrain.json for the Torres 3D viewer.

The grid is defined in the viewer's coast-aligned frame (x seaward, y alongshore) and must
match js/geo.js (ORIGIN, COAST_BEARING, DOMAIN).

Sources:
  copernicus30  Copernicus DEM GLO-30 tile downloaded from the AWS Open Data registry
                (default; this is how data/terrain.json was built). Requires rasterio, pyproj.
  openmeteo     Copernicus DEM GLO-90 via the Open-Meteo Elevation API. No extra packages,
                but slow: the free tier is rate limited (HTTP 429), so requests are paced.
  geotiff       Any local DEM in a geographic or projected CRS (LiDAR, drone survey...).
                Requires rasterio and pyproj.

Examples:
  pip install numpy rasterio pyproj
  python tools/build_terrain.py                      # Copernicus 30 m, dx = 25 m
  python tools/build_terrain.py --source openmeteo --dx 75
  python tools/build_terrain.py --geotiff dem_torres.tif --dx 10
"""

import argparse
import json
import math
import time
import urllib.error
import urllib.request
from pathlib import Path

import numpy as np

# Keep in sync with js/geo.js
ORIGIN_LAT, ORIGIN_LON = -29.347, -49.727
COAST_BEARING = 32.0
DOMAIN = dict(x0=-1500.0, x1=3500.0, y0=-3200.0, y1=4000.0)

M_PER_DEG_LAT = 110850.0
M_PER_DEG_LON = 111320.0 * math.cos(math.radians(ORIGIN_LAT))
SEAWARD = math.radians(COAST_BEARING + 90.0)
ALONG = math.radians(COAST_BEARING)
NHAT = np.array([math.sin(SEAWARD), math.cos(SEAWARD)])
THAT = np.array([math.sin(ALONG), math.cos(ALONG)])

OUT = Path(__file__).resolve().parents[1] / "data" / "terrain.json"


def coast_to_lonlat(x, y):
    e = x * NHAT[0] + y * THAT[0]
    n = x * NHAT[1] + y * THAT[1]
    return ORIGIN_LON + e / M_PER_DEG_LON, ORIGIN_LAT + n / M_PER_DEG_LAT


def grid_points(dx):
    xs = np.arange(DOMAIN["x0"], DOMAIN["x1"] + 0.5 * dx, dx)
    ys = np.arange(DOMAIN["y0"], DOMAIN["y1"] + 0.5 * dx, dx)
    X, Y = np.meshgrid(xs, ys)  # rows = y, columns = x (row-major, x fastest)
    lon, lat = coast_to_lonlat(X, Y)
    return xs, ys, lon, lat


COP30_URL = (
    "https://copernicus-dem-30m.s3.amazonaws.com/Copernicus_DSM_COG_10_{ns}{lat:02d}_00_{ew}{lon:03d}_00_DEM/"
    "Copernicus_DSM_COG_10_{ns}{lat:02d}_00_{ew}{lon:03d}_00_DEM.tif"
)


def download_copernicus30(lon, lat, cache_dir):
    """Download the 1x1 degree GLO-30 tile covering the grid (the Torres domain fits in one)."""
    lat_floor = math.floor(float(lat.min()))
    lon_floor = math.floor(float(lon.min()))
    if math.floor(float(lat.max())) != lat_floor or math.floor(float(lon.max())) != lon_floor:
        raise SystemExit("Domain spans more than one Copernicus tile; merge tiles and use --geotiff")
    url = COP30_URL.format(
        ns="S" if lat_floor < 0 else "N", lat=abs(lat_floor),
        ew="W" if lon_floor < 0 else "E", lon=abs(lon_floor),
    )
    cache_dir.mkdir(parents=True, exist_ok=True)
    path = cache_dir / url.rsplit("/", 1)[1]
    if not path.exists():
        print(f"Downloading {url}")
        urllib.request.urlretrieve(url, path)
    return path


def sample_openmeteo(lon, lat, chunk=100, pause=1.0):
    flat_lat, flat_lon = lat.ravel(), lon.ravel()
    out = np.empty(flat_lat.size)
    n_chunks = math.ceil(flat_lat.size / chunk)
    for c in range(n_chunks):
        sl = slice(c * chunk, (c + 1) * chunk)
        url = (
            "https://api.open-meteo.com/v1/elevation?latitude="
            + ",".join(f"{v:.5f}" for v in flat_lat[sl])
            + "&longitude="
            + ",".join(f"{v:.5f}" for v in flat_lon[sl])
        )
        for attempt in range(8):
            try:
                with urllib.request.urlopen(url, timeout=30) as r:
                    vals = json.load(r)["elevation"]
                break
            except urllib.error.HTTPError as exc:
                if exc.code != 429 or attempt == 7:
                    raise
                # free tier: each coordinate counts as a call (600/min); wait for the window to reset
                print(f"\n  rate limited, waiting 65 s (attempt {attempt + 1})")
                time.sleep(65)
            except urllib.error.URLError as exc:
                if attempt == 7:
                    raise
                time.sleep(2 ** min(attempt + 1, 5))
                print(f"\n  retry {attempt + 1}: {exc}")
        out[sl] = [v if v is not None and np.isfinite(v) else 0.0 for v in vals]
        print(f"\r  {c + 1}/{n_chunks} requests", end="", flush=True)
        time.sleep(pause)
    print()
    return out.reshape(lat.shape)


def sample_geotiff(path, lon, lat):
    import rasterio
    from pyproj import Transformer

    with rasterio.open(path) as src:
        tr = Transformer.from_crs("EPSG:4326", src.crs, always_xy=True)
        px, py = tr.transform(lon.ravel(), lat.ravel())
        vals = np.array([v[0] for v in src.sample(zip(px, py))], dtype=float)
        if src.nodata is not None:
            vals[vals == src.nodata] = 0.0
    vals[~np.isfinite(vals)] = 0.0
    return vals.reshape(lat.shape)


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--source", choices=["copernicus30", "openmeteo"], default="copernicus30")
    ap.add_argument("--dx", type=float, default=25.0, help="grid spacing in metres (default 25)")
    ap.add_argument("--geotiff", type=Path, help="local DEM file (overrides --source)")
    ap.add_argument("--cache", type=Path, default=Path(__file__).resolve().parent / "cache")
    ap.add_argument("--out", type=Path, default=OUT)
    args = ap.parse_args()

    xs, ys, lon, lat = grid_points(args.dx)
    print(f"Grid {xs.size} x {ys.size} = {lon.size} points, dx = {args.dx} m")
    if args.geotiff:
        elev = sample_geotiff(args.geotiff, lon, lat)
        source = f"DEM local ({args.geotiff.name})"
    elif args.source == "copernicus30":
        elev = sample_geotiff(download_copernicus30(lon, lat, args.cache), lon, lat)
        source = "Copernicus DEM GLO-30"
    else:
        elev = sample_openmeteo(lon, lat)
        source = "Copernicus DEM GLO-90 (via Open-Meteo)"

    print(f"Elevation range: {elev.min():.1f} to {elev.max():.1f} m; sea cells (<=0.5 m): {(elev <= 0.5).mean():.0%}")
    payload = {
        "source": source,
        "grid": {"x0": DOMAIN["x0"], "y0": DOMAIN["y0"], "dx": args.dx, "dy": args.dx, "nx": int(xs.size), "ny": int(ys.size)},
        "frame": {"origin": [ORIGIN_LAT, ORIGIN_LON], "coast_bearing": COAST_BEARING},
        "elevation": [round(float(v), 1) for v in elev.ravel()],
    }
    args.out.parent.mkdir(parents=True, exist_ok=True)
    args.out.write_text(json.dumps(payload, separators=(",", ":")))
    print(f"Wrote {args.out} ({args.out.stat().st_size / 1024:.0f} kB)")


if __name__ == "__main__":
    main()
