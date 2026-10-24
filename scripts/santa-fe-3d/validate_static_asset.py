#!/usr/bin/env python3
from __future__ import annotations

import argparse
import hashlib
import json
import re
from pathlib import Path

FORBIDDEN = re.compile(rb"(?:authorization\s*:|bearer\s+[A-Za-z0-9._~-]{16,}|cookie\s*:|capability[_-]?token|session[_-]?secret)", re.I)
ASSET_HARD_LIMIT_BYTES = 25 * 1024 * 1024
ASSET_NAME = re.compile(r"santa-fe-buildings-3d(?:-[a-z]+(?:-[a-z]+)?)?\.[0-9a-f]{16}\.pmtiles")


def validate(manifest_path: Path, root: Path) -> None:
    manifest = json.loads(manifest_path.read_text())
    assert manifest["city_id"] == "ar-santa-fe-capital"
    assert manifest["layer"] == "santa_fe_buildings_3d"
    assert manifest["source_dataset_releases"]["Overture Maps Buildings"] == "2026-07-22.0"
    assert manifest["final_features"] >= 5000
    assert manifest["unique_height_bucket_count"] >= 6
    assert manifest["uniform_default_height_fraction"] < 0.35
    assert manifest["private_user_coordinates_used"] is False
    assert manifest["private_tracking_data_in_assets"] is False
    assert manifest["user_markers_in_dataset"] is False
    assert manifest["sessions_or_capabilities_in_dataset"] is False

    paths = manifest["asset_paths"]
    hashes = manifest["asset_sha256"]
    sizes = manifest["asset_sizes"]
    assert len(paths) == len(hashes) == len(sizes)
    assert len(paths) >= 1
    assert manifest.get("asset_shard_count", len(paths)) == len(paths)
    assert len(set(paths)) == len(paths)
    assert len(set(hashes)) == len(hashes)

    for relative_path, expected_hash, expected_size in zip(paths, hashes, sizes, strict=True):
        assert isinstance(relative_path, str) and relative_path.startswith("/data/santa-fe-3d/")
        asset = root / relative_path.lstrip("/")
        assert ASSET_NAME.fullmatch(asset.name)
        assert asset.is_file()
        actual_size = asset.stat().st_size
        assert actual_size == expected_size
        assert 0 < actual_size < ASSET_HARD_LIMIT_BYTES
        digest = hashlib.sha256()
        with asset.open("rb") as handle:
            for chunk in iter(lambda: handle.read(1024 * 1024), b""):
                digest.update(chunk)
        assert digest.hexdigest() == expected_hash

    assert manifest["asset_under_25_mib_hard_limit"] is True
    for candidate in [
        manifest_path,
        root / "data/santa-fe-3d/public-urban-boundary.geojson",
        root / "data/santa-fe-3d/source-lock.json",
    ]:
        assert not FORBIDDEN.search(candidate.read_bytes())


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--manifest", required=True)
    parser.add_argument("--root", required=True)
    args = parser.parse_args()
    validate(Path(args.manifest), Path(args.root))
    print("SANTA_FE_STATIC_ASSET_VALIDATION=PASS")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
