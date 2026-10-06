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

Sentinel-2 (optional, recommended): --s2-scene adds a 10 m land/water mask from the
MNDWI/NDWI indices (exact shoreline, river, jetties, lagoons) and a true-colour texture
(data/imagery.jpg) aligned with the grid. Elevation is then written as data/terrain.bin
(int16, decimetres) next to the JSON metadata. Requires scipy and pillow as well.

Examples:
  pip install numpy rasterio pyproj scipy pillow
  python tools/build_terrain.py --s2-scene S2C_22JFN_20260925_0_L2A --dx 10
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


S2_URL = "https://sentinel-cogs.s3.us-west-2.amazonaws.com/sentinel-s2-l2a-cogs/{zone}/{band}/{sq}/{year}/{month}/{scene}/{asset}.tif"


def s2_asset_url(scene, asset):
    # scene id like S2C_22JFN_20260925_0_L2A
    tile, date = scene.split("_")[1], scene.split("_")[2]
    return "/vsicurl/" + S2_URL.format(zone=tile[:2], band=tile[2], sq=tile[3:5], year=date[:4],
                                      month=int(date[4:6]), scene=scene, asset=asset)


def sample_s2(scene, lon, lat):
    """Bilinear-sample Sentinel-2 L2A bands on the grid. Returns (rgb uint8 [ny,nx,3], water bool)."""
    import rasterio
    from pyproj import Transformer
    from rasterio.windows import from_bounds
    from scipy.ndimage import map_coordinates

    pad = 0.01
    bbox = (lon.min() - pad, lat.min() - pad, lon.max() + pad, lat.max() + pad)
    out = {}
    for asset in ("TCI", "B03", "B08", "B11"):
        with rasterio.open(s2_asset_url(scene, asset)) as r:
            tr = Transformer.from_crs("EPSG:4326", r.crs, always_xy=True)
            x0, y0 = tr.transform(bbox[0], bbox[1])
            x1, y1 = tr.transform(bbox[2], bbox[3])
            win = from_bounds(min(x0, x1), min(y0, y1), max(x0, x1), max(y0, y1), r.transform)
            data = r.read(window=win).astype(np.float32)
            inv = ~r.window_transform(win)
            ux, uy = tr.transform(lon.ravel(), lat.ravel())
            col, row = inv * (np.asarray(ux), np.asarray(uy))
            coords = np.vstack([row - 0.5, col - 0.5])
            out[asset] = np.stack([map_coordinates(b, coords, order=1, mode="nearest").reshape(lon.shape) for b in data])
        print(f"  {asset}: window {data.shape}")

    g, n, sw = out["B03"][0], out["B08"][0], out["B11"][0]
    eps = 1e-6
    ndwi = (g - n) / (g + n + eps)
    mndwi = (g - sw) / (g + sw + eps)
    # MNDWI keeps surf-zone foam as water (SWIR is absorbed), NDWI catches dark river water
    water = (mndwi > 0.05) | (ndwi > 0.15)
    rgb = np.clip(np.moveaxis(out["TCI"], 0, -1), 0, 255).astype(np.uint8)
    return rgb, water, mndwi


def clean_mask(water, min_water=60, min_land=3):
    """Drop speckle: tiny inland water patches and isolated land pixels in the sea."""
    from scipy.ndimage import label
    lab, n = label(water)
    sizes = np.bincount(lab.ravel())
    small = (sizes < min_water) & (np.arange(n + 1) > 0)
    water = water & ~small[lab]
    lab, n = label(~water)
    sizes = np.bincount(lab.ravel())
    small = (sizes < min_land) & (np.arange(n + 1) > 0)
    return water | small[lab]


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
    """Bilinear sampling of a DEM (a 30 m DEM on a 10 m grid would look terraced with nearest)."""
    import rasterio
    from pyproj import Transformer
    from scipy.ndimage import map_coordinates

    with rasterio.open(path) as src:
        tr = Transformer.from_crs("EPSG:4326", src.crs, always_xy=True)
        px, py = tr.transform(lon.ravel(), lat.ravel())
        col, row = ~src.transform * (np.asarray(px), np.asarray(py))
        r0, r1 = int(max(row.min() - 2, 0)), int(min(row.max() + 3, src.height))
        c0, c1 = int(max(col.min() - 2, 0)), int(min(col.max() + 3, src.width))
        data = src.read(1, window=((r0, r1), (c0, c1))).astype(np.float64)
        if src.nodata is not None:
            data[data == src.nodata] = 0.0
    data[~np.isfinite(data)] = 0.0
    vals = map_coordinates(data, [row - r0 - 0.5, col - c0 - 0.5], order=1, mode="nearest")
    return vals.reshape(lat.shape)


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
    ap.add_argument("--s2-scene", help="Sentinel-2 L2A scene id for shoreline mask and texture, e.g. S2C_22JFN_20260925_0_L2A")
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

    payload = {
        "source": source,
        "grid": {"x0": DOMAIN["x0"], "y0": DOMAIN["y0"], "dx": args.dx, "dy": args.dx, "nx": int(xs.size), "ny": int(ys.size)},
        "frame": {"origin": [ORIGIN_LAT, ORIGIN_LON], "coast_bearing": COAST_BEARING},
    }

    if args.s2_scene:
        from PIL import Image
        print(f"Sentinel-2 {args.s2_scene}")
        rgb, water, _ = sample_s2(args.s2_scene, lon, lat)
        water = clean_mask(water)
        # the mask defines the shoreline; the DEM keeps the relief on land
        elev = np.where(water, -1.0, np.maximum(elev, 0.8))
        img = Image.fromarray(rgb)  # row 0 = southern edge (y0), same as the grid
        img_path = args.out.parent / "imagery.jpg"
        img.save(img_path, quality=88)
        payload["source"] += f" + Sentinel-2 ({args.s2_scene[10:18]})"
        payload["imagery"] = img_path.name
        payload["imagery_source"] = f"Copernicus Sentinel-2 L2A {args.s2_scene}"
        print(f"Wrote {img_path} ({img_path.stat().st_size / 1024:.0f} kB); water cells {water.mean():.0%}")

    print(f"Elevation range: {elev.min():.1f} to {elev.max():.1f} m; sea cells (<=0.5 m): {(elev <= 0.5).mean():.0%}")
    args.out.parent.mkdir(parents=True, exist_ok=True)
    if elev.size > 100_000:
        bin_path = args.out.with_suffix(".bin")
        np.round(elev * 10).clip(-32767, 32767).astype("<i2").tofile(bin_path)
        payload["elevation_bin"] = bin_path.name
        payload["elevation_scale"] = 0.1
        print(f"Wrote {bin_path} ({bin_path.stat().st_size / 1024:.0f} kB)")
    else:
        payload["elevation"] = [round(float(v), 1) for v in elev.ravel()]
    args.out.write_text(json.dumps(payload, separators=(",", ":")))
    print(f"Wrote {args.out} ({args.out.stat().st_size / 1024:.0f} kB)")


if __name__ == "__main__":
    main()
