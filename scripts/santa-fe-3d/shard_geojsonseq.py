#!/usr/bin/env python3
"""Deterministically split Santa Fe GeoJSONSeq into four public city quadrants."""
from __future__ import annotations

import argparse
import json
from pathlib import Path

from shapely.geometry import shape

MID_LNG = -60.695
MID_LAT = -31.6375
SHARDS = ("north-west", "north-east", "south-west", "south-east")


def shard_name(lng: float, lat: float) -> str:
    north = lat >= MID_LAT
    west = lng < MID_LNG
    if north and west:
        return "north-west"
    if north:
        return "north-east"
    if west:
        return "south-west"
    return "south-east"


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--input", required=True)
    parser.add_argument("--output-dir", required=True)
    args = parser.parse_args()

    output_dir = Path(args.output_dir)
    output_dir.mkdir(parents=True, exist_ok=True)
    handles = {name: (output_dir / f"{name}.geojsonseq").open("w", encoding="utf-8") for name in SHARDS}
    counts = {name: 0 for name in SHARDS}
    try:
        with Path(args.input).open(encoding="utf-8") as source:
            for line_number, line in enumerate(source, start=1):
                if not line.strip():
                    continue
                feature = json.loads(line)
                centroid = shape(feature["geometry"]).representative_point()
                name = shard_name(float(centroid.x), float(centroid.y))
                handles[name].write(json.dumps(feature, sort_keys=True, separators=(",", ":"), ensure_ascii=False) + "\n")
                counts[name] += 1
    finally:
        for handle in handles.values():
            handle.close()

    if sum(counts.values()) < 5000 or any(count <= 0 for count in counts.values()):
        raise RuntimeError(f"INVALID_SHARD_COUNTS:{json.dumps(counts, sort_keys=True)}")
    print(json.dumps({"stage": "SHARD_GEOJSONSEQ", "status": "PASS", "counts": counts}, sort_keys=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
