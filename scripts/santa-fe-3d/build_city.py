#!/usr/bin/env python3
"""Build a deterministic, city-bounded Santa Fe LOD1 building dataset.

The extractor reads only the pinned Overture release and public city envelope.
It never reads owner coordinates, screenshots, sessions, cookies, or tracking data.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import math
import os
import re
import sys
from collections import Counter, defaultdict
from pathlib import Path
from typing import Any, Iterable

from shapely import from_wkb, make_valid, to_geojson
from shapely.geometry import GeometryCollection, MultiPolygon, Polygon, shape
from shapely.ops import transform, unary_union
from pyproj import Transformer
from overturemaps.core import record_batch_reader

OVERTURE_RELEASE = "2026-07-22.0"
OVERTURE_PY_VERSION = "1.0.1"
TIPPECANOE_COMMIT = "7c80fccdc17e4f8d9f4a52d518b4845290224366"
PMTILES_CLI_VERSION = "v1.30.1"
LAYER_NAME = "santa_fe_buildings_3d"
FLOOR_HEIGHT_M = 3.1
MIN_AREA_M2 = 8.0
MAX_HEIGHT_M = 180.0
CITY_ID = "ar-santa-fe-capital"
ASSET_TARGET_BYTES = 24 * 1024 * 1024
ASSET_HARD_LIMIT_BYTES = 25 * 1024 * 1024
WGS84_TO_UTM21S = Transformer.from_crs("EPSG:4326", "EPSG:32721", always_xy=True).transform

def canonical_json(value: Any) -> bytes:
    return (json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=False) + "\n").encode()

def sha256_bytes(value: bytes) -> str:
    return hashlib.sha256(value).hexdigest()

def stable_unit(seed: str) -> float:
    value = int(hashlib.sha256(seed.encode()).hexdigest()[:12], 16)
    return value / float(0xFFFFFFFFFFFF)

def finite_number(value: Any) -> float | None:
    if value is None or isinstance(value, bool):
        return None
    try:
        number = float(value)
    except (TypeError, ValueError):
        return None
    return number if math.isfinite(number) else None

def polygonal(geom: Any) -> Polygon | MultiPolygon | None:
    if geom is None or geom.is_empty:
        return None
    repaired = make_valid(geom)
    if repaired.is_empty:
        return None
    if isinstance(repaired, (Polygon, MultiPolygon)):
        return repaired
    if isinstance(repaired, GeometryCollection):
        polygons = [part for part in repaired.geoms if isinstance(part, (Polygon, MultiPolygon)) and not part.is_empty]
        if not polygons:
            return None
        merged = unary_union(polygons)
        return merged if isinstance(merged, (Polygon, MultiPolygon)) else None
    return None

def projected_area_m2(geom: Polygon | MultiPolygon) -> float:
    return float(transform(WGS84_TO_UTM21S, geom).area)

def clean_geometry(raw_wkb: Any, boundary: Polygon | MultiPolygon) -> tuple[Polygon | MultiPolygon | None, str]:
    if raw_wkb is None:
        return None, "missing"
    try:
        geom = polygonal(from_wkb(bytes(raw_wkb)))
    except Exception:
        return None, "invalid_wkb"
    if geom is None:
        return None, "invalid"
    clipped = polygonal(geom.intersection(boundary))
    if clipped is None:
        return None, "outside"
    simplified = polygonal(clipped.simplify(0.0000008, preserve_topology=True))
    if simplified is None:
        return None, "simplified_empty"
    if projected_area_m2(simplified) < MIN_AREA_M2:
        return None, "sliver"
    return simplified, "ok"

def source_id(row: dict[str, Any]) -> str:
    raw = row.get("id")
    if isinstance(raw, str) and raw:
        return raw
    return sha256_bytes(canonical_json({"bbox": row.get("bbox"), "subtype": row.get("subtype")}))[:32]

def building_class(row: dict[str, Any], area_m2: float) -> str:
    for key in ("class", "subtype"):
        value = row.get(key)
        if isinstance(value, str) and value and value not in {"building", "unknown"}:
            return re.sub(r"[^a-z0-9_-]+", "-", value.lower())[:40]
    if area_m2 < 90:
        return "small_residential"
    if area_m2 < 320:
        return "medium_residential"
    if area_m2 < 1200:
        return "large_urban"
    return "large_footprint"

def height_for(row: dict[str, Any], area_m2: float, stable_id: str, klass: str) -> tuple[float, float, str, str]:
    explicit = finite_number(row.get("height"))
    min_height = finite_number(row.get("min_height"))
    min_floor = finite_number(row.get("min_floor"))
    floors = finite_number(row.get("num_floors"))
    base = max(0.0, min_height or ((min_floor or 0.0) * FLOOR_HEIGHT_M))
    if explicit is not None and 3.0 <= explicit <= MAX_HEIGHT_M and base < explicit:
        return round(explicit, 1), round(base, 1), "explicit", "high"
    if floors is not None and 1 <= floors <= 55:
        height = min(MAX_HEIGHT_M, max(3.0, floors * FLOOR_HEIGHT_M))
        if base < height:
            return round(height, 1), round(base, 1), "floors", "medium"

    u = stable_unit(stable_id)
    commercial = any(token in klass for token in ("commercial", "retail", "office", "industrial", "warehouse"))
    if commercial:
        low, high = (5.5, 15.5) if area_m2 < 900 else (9.0, 24.0)
    elif area_m2 < 80:
        low, high = 3.2, 6.5
    elif area_m2 < 260:
        low, high = 5.0, 10.8
    elif area_m2 < 850:
        low, high = 7.0, 15.5
    else:
        low, high = 11.0, 30.0
    estimated = round((low + (high - low) * u) * 2.0) / 2.0
    estimated = max(3.0, min(MAX_HEIGHT_M, estimated))
    source = "estimated" if area_m2 >= 80 or commercial else "fallback"
    confidence = "medium" if source == "estimated" else "low"
    return estimated, min(base, max(0.0, estimated - 1.0)), source, confidence

def read_rows(kind: str, bbox: tuple[float, float, float, float]) -> list[dict[str, Any]]:
    reader = record_batch_reader(
        kind,
        bbox=bbox,
        release=OVERTURE_RELEASE,
        connect_timeout=45,
        request_timeout=240,
        stac=False,
    )
    if reader is None:
        raise RuntimeError(f"OVERTURE_READER_UNAVAILABLE:{kind}")
    table = reader.read_all()
    return table.to_pylist()

def row_digest(rows: Iterable[dict[str, Any]]) -> str:
    digest = hashlib.sha256()
    for row in sorted(rows, key=source_id):
        selected = {
            "id": source_id(row),
            "geometry_sha256": sha256_bytes(bytes(row.get("geometry") or b"")),
            "building_id": row.get("building_id"),
            "height": row.get("height"),
            "min_height": row.get("min_height"),
            "num_floors": row.get("num_floors"),
            "min_floor": row.get("min_floor"),
            "class": row.get("class"),
            "subtype": row.get("subtype"),
            "has_parts": row.get("has_parts"),
        }
        digest.update(canonical_json(selected))
    return digest.hexdigest()

def feature(row: dict[str, Any], geom: Polygon | MultiPolygon, dataset_type: str) -> dict[str, Any]:
    sid = source_id(row)
    area = projected_area_m2(geom)
    klass = building_class(row, area)
    height, min_height, height_source, confidence = height_for(row, area, sid, klass)
    return {
        "type": "Feature",
        "id": sid,
        "properties": {
            "height": height,
            "min_height": min_height,
            "height_source": height_source,
            "height_confidence": confidence,
            "building_class": klass,
            "source_dataset": f"Overture Maps {OVERTURE_RELEASE} ({dataset_type})",
            "source_feature_id_or_stable_hash": sid,
            "footprint_area_m2": round(area, 1),
        },
        "geometry": json.loads(to_geojson(geom, indent=None)),
    }

def extract(args: argparse.Namespace) -> None:
    boundary_path = Path(args.boundary)
    boundary_doc = json.loads(boundary_path.read_text())
    boundary = polygonal(shape(boundary_doc["features"][0]["geometry"]))
    if boundary is None:
        raise RuntimeError("PUBLIC_BOUNDARY_INVALID")
    minx, miny, maxx, maxy = boundary.bounds
    bbox = (minx, miny, maxx, maxy)

    buildings = read_rows("building", bbox)
    parts = read_rows("building_part", bbox)
    input_counts = {"building": len(buildings), "building_part": len(parts)}
    input_digests = {"building": row_digest(buildings), "building_part": row_digest(parts)}

    clean_buildings: dict[str, tuple[dict[str, Any], Polygon | MultiPolygon]] = {}
    clean_parts: dict[str, list[tuple[dict[str, Any], Polygon | MultiPolygon]]] = defaultdict(list)
    invalid = Counter()
    for row in buildings:
        geom, reason = clean_geometry(row.get("geometry"), boundary)
        if geom is None:
            invalid[f"building:{reason}"] += 1
            continue
        clean_buildings[source_id(row)] = (row, geom)
    orphan_parts: list[tuple[dict[str, Any], Polygon | MultiPolygon]] = []
    for row in parts:
        geom, reason = clean_geometry(row.get("geometry"), boundary)
        if geom is None:
            invalid[f"building_part:{reason}"] += 1
            continue
        parent = row.get("building_id")
        if isinstance(parent, str) and parent:
            clean_parts[parent].append((row, geom))
        else:
            orphan_parts.append((row, geom))

    selected: list[dict[str, Any]] = []
    parents_suppressed = 0
    parts_retained = 0
    duplicate_removed = 0
    seen_geometry: set[str] = set()

    def append_unique(item: dict[str, Any]) -> None:
        nonlocal duplicate_removed
        geom_key = sha256_bytes(canonical_json(item["geometry"]))
        if geom_key in seen_geometry:
            duplicate_removed += 1
            return
        seen_geometry.add(geom_key)
        selected.append(item)

    for parent_id, (row, geom) in sorted(clean_buildings.items()):
        candidates = clean_parts.get(parent_id, [])
        useful_parts: list[tuple[dict[str, Any], Polygon | MultiPolygon]] = []
        if candidates:
            parent_area = projected_area_m2(geom)
            union_geom = polygonal(unary_union([candidate_geom for _, candidate_geom in candidates]).intersection(geom))
            coverage = projected_area_m2(union_geom) / parent_area if union_geom is not None and parent_area > 0 else 0
            if coverage >= 0.55:
                useful_parts = candidates
        if useful_parts:
            parents_suppressed += 1
            for part_row, part_geom in useful_parts:
                append_unique(feature(part_row, part_geom, "building_part"))
                parts_retained += 1
        else:
            append_unique(feature(row, geom, "building"))

    for parent_id, candidates in sorted(clean_parts.items()):
        if parent_id in clean_buildings:
            continue
        for part_row, part_geom in candidates:
            append_unique(feature(part_row, part_geom, "building_part"))
            parts_retained += 1
    for part_row, part_geom in orphan_parts:
        append_unique(feature(part_row, part_geom, "building_part"))
        parts_retained += 1

    if len(selected) < 5000:
        raise RuntimeError(f"SANTA_FE_DENSITY_TOO_LOW:{len(selected)}")

    selected.sort(key=lambda item: str(item["properties"]["source_feature_id_or_stable_hash"]))
    output = Path(args.output)
    output.parent.mkdir(parents=True, exist_ok=True)
    with output.open("w", encoding="utf-8") as handle:
        for item in selected:
            handle.write(json.dumps(item, sort_keys=True, separators=(",", ":"), ensure_ascii=False) + "\n")

    height_counts = Counter(item["properties"]["height_source"] for item in selected)
    buckets = Counter(float(item["properties"]["height"]) for item in selected)
    default_12 = sum(1 for item in selected if float(item["properties"]["height"]) == 12.0)
    stats = {
        "schema_version": 1,
        "city_id": CITY_ID,
        "layer": LAYER_NAME,
        "source_dataset_releases": {"Overture Maps": OVERTURE_RELEASE},
        "bounded_input_sha256": input_digests,
        "input_features_by_source": input_counts,
        "invalid_removed": dict(sorted(invalid.items())),
        "duplicates_removed": duplicate_removed,
        "parts_retained": parts_retained,
        "parents_suppressed": parents_suppressed,
        "final_features": len(selected),
        "height_source_counts": dict(sorted(height_counts.items())),
        "unique_height_bucket_count": len(buckets),
        "uniform_default_height_fraction": round(default_12 / len(selected), 6),
        "measured_percent": round(100 * (height_counts["explicit"] + height_counts["floors"]) / len(selected), 2),
        "estimated_percent": round(100 * (height_counts["estimated"] + height_counts["fallback"]) / len(selected), 2),
        "public_boundary_sha256": sha256_bytes(boundary_path.read_bytes()),
        "public_boundary_bounds": [round(v, 6) for v in bbox],
        "private_user_coordinates_used": False,
    }
    if stats["unique_height_bucket_count"] < 6:
        raise RuntimeError("UNIQUE_HEIGHT_BUCKETS_TOO_LOW")
    if stats["uniform_default_height_fraction"] >= 0.35:
        raise RuntimeError("UNIFORM_DEFAULT_HEIGHT_FRACTION_TOO_HIGH")
    Path(args.stats).write_bytes(canonical_json(stats))
    print(json.dumps(stats, indent=2, sort_keys=True))

def finalize(args: argparse.Namespace) -> None:
    pmtiles = Path(args.pmtiles)
    if not pmtiles.is_file():
        raise RuntimeError("PMTILES_MISSING")
    size = pmtiles.stat().st_size
    if size >= ASSET_HARD_LIMIT_BYTES:
        raise RuntimeError(f"PMTILES_EXCEEDS_CLOUDFLARE_HARD_LIMIT:{size}")
    digest = sha256_bytes(pmtiles.read_bytes())
    hashed_name = f"santa-fe-buildings-3d.{digest[:16]}.pmtiles"
    destination = pmtiles.with_name(hashed_name)
    if destination != pmtiles:
        pmtiles.replace(destination)

    stats = json.loads(Path(args.stats).read_text())
    source_sha = os.environ.get("SOURCE_SHA", "UNSET")
    manifest = {
        **stats,
        "schema_version": 1,
        "city_id": CITY_ID,
        "public_boundary_source": {
            "name": "OpenStreetMap Nominatim public Santa Fe place boundary, simplified city-scale urban envelope",
            "path": "/data/santa-fe-3d/public-urban-boundary.geojson",
            "license": "ODbL-1.0",
        },
        "source_dataset_releases": {
            "Overture Maps Buildings": OVERTURE_RELEASE,
            "Overture schema": "v1.18.0",
        },
        "source_licenses": {
            "Overture Maps Buildings": "ODbL-1.0 (contains OpenStreetMap-derived buildings)",
            "OpenStreetMap": "ODbL-1.0",
        },
        "source_attributions": [
            "© OpenStreetMap contributors",
            "© Overture Maps Foundation",
        ],
        "build_tool_versions": {
            "overturemaps-py": OVERTURE_PY_VERSION,
            "tippecanoe_commit": TIPPECANOE_COMMIT,
            "go-pmtiles": PMTILES_CLI_VERSION,
            "python": sys.version.split()[0],
        },
        "build_command": "bash scripts/santa-fe-3d/materialize.sh",
        "asset_paths": [f"/data/santa-fe-3d/{hashed_name}"],
        "asset_sizes": [size],
        "asset_sha256": [digest],
        "asset_under_24_mib_target": size <= ASSET_TARGET_BYTES,
        "asset_under_25_mib_hard_limit": size < ASSET_HARD_LIMIT_BYTES,
        "created_from_commit": source_sha,
        "height_values_are_visual_massing_not_survey_measurements": True,
        "private_tracking_data_in_assets": False,
        "user_markers_in_dataset": False,
        "sessions_or_capabilities_in_dataset": False,
    }
    manifest_path = destination.with_name("manifest.json")
    manifest_path.write_bytes(canonical_json(manifest))
    generated = Path(args.generated_ts)
    generated.parent.mkdir(parents=True, exist_ok=True)
    generated.write_text(
        "// Generated by scripts/santa-fe-3d/build_city.py; commit with the matching PMTiles asset.\n"
        f"export const SANTA_FE_3D_ASSET_PATH = '/data/santa-fe-3d/{hashed_name}' as const\n"
        "export const SANTA_FE_3D_SOURCE_LAYER = 'santa_fe_buildings_3d' as const\n"
        f"export const SANTA_FE_3D_ASSET_SHA256 = '{digest}' as const\n"
        f"export const SANTA_FE_3D_FEATURE_COUNT = {int(stats['final_features'])} as const\n"
        f"export const SANTA_FE_3D_BOUNDS = {json.dumps(stats['public_boundary_bounds'])} as const\n",
        encoding="utf-8",
    )
    print(json.dumps(manifest, indent=2, sort_keys=True))

def parser() -> argparse.ArgumentParser:
    result = argparse.ArgumentParser()
    sub = result.add_subparsers(dest="command", required=True)
    extraction = sub.add_parser("extract")
    extraction.add_argument("--boundary", required=True)
    extraction.add_argument("--output", required=True)
    extraction.add_argument("--stats", required=True)
    extraction.set_defaults(func=extract)
    final = sub.add_parser("finalize")
    final.add_argument("--pmtiles", required=True)
    final.add_argument("--stats", required=True)
    final.add_argument("--generated-ts", required=True)
    final.set_defaults(func=finalize)
    return result

def main() -> int:
    args = parser().parse_args()
    args.func(args)
    return 0

if __name__ == "__main__":
    raise SystemExit(main())
