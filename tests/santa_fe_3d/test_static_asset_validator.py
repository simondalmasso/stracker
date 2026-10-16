from __future__ import annotations

import hashlib
import importlib.util
import json
import sys
import tempfile
import unittest
from pathlib import Path

MODULE_PATH = Path(__file__).resolve().parents[2] / "scripts" / "santa-fe-3d" / "validate_static_asset.py"


def load_module():
    spec = importlib.util.spec_from_file_location("validate_static_asset_test_target", MODULE_PATH)
    if spec is None or spec.loader is None:
        raise RuntimeError("VALIDATOR_MODULE_LOAD_FAILED")
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    return module


class StaticAssetValidatorTest(unittest.TestCase):
    def test_accepts_multiple_hashed_assets_and_checks_each_file(self):
        module = load_module()
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            data_dir = root / "data" / "santa-fe-3d"
            data_dir.mkdir(parents=True)
            (data_dir / "public-urban-boundary.geojson").write_text('{"type":"FeatureCollection","features":[]}\n')
            (data_dir / "source-lock.json").write_text('{"release":"2026-07-22.0"}\n')

            asset_specs = []
            for name, payload in (
                ("north-east", b"PMTiles-ne"),
                ("north-west", b"PMTiles-nw"),
                ("south-east", b"PMTiles-se"),
                ("south-west", b"PMTiles-sw"),
            ):
                digest = hashlib.sha256(payload).hexdigest()
                filename = f"santa-fe-buildings-3d-{name}.{digest[:16]}.pmtiles"
                (data_dir / filename).write_bytes(payload)
                asset_specs.append((f"/data/santa-fe-3d/{filename}", digest, len(payload)))

            manifest = {
                "city_id": "ar-santa-fe-capital",
                "layer": "santa_fe_buildings_3d",
                "source_dataset_releases": {"Overture Maps Buildings": "2026-07-22.0"},
                "final_features": 264425,
                "unique_height_bucket_count": 101,
                "uniform_default_height_fraction": 0.001184,
                "private_user_coordinates_used": False,
                "private_tracking_data_in_assets": False,
                "user_markers_in_dataset": False,
                "sessions_or_capabilities_in_dataset": False,
                "asset_paths": [item[0] for item in asset_specs],
                "asset_sha256": [item[1] for item in asset_specs],
                "asset_sizes": [item[2] for item in asset_specs],
                "asset_shard_count": 4,
                "asset_under_25_mib_hard_limit": True,
            }
            manifest_path = data_dir / "manifest.json"
            manifest_path.write_text(json.dumps(manifest))

            module.validate(manifest_path, root)

    def test_rejects_mismatched_asset_metadata_lengths(self):
        module = load_module()
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            data_dir = root / "data" / "santa-fe-3d"
            data_dir.mkdir(parents=True)
            (data_dir / "public-urban-boundary.geojson").write_text("{}")
            (data_dir / "source-lock.json").write_text("{}")
            manifest = {
                "city_id": "ar-santa-fe-capital",
                "layer": "santa_fe_buildings_3d",
                "source_dataset_releases": {"Overture Maps Buildings": "2026-07-22.0"},
                "final_features": 5000,
                "unique_height_bucket_count": 6,
                "uniform_default_height_fraction": 0.1,
                "private_user_coordinates_used": False,
                "private_tracking_data_in_assets": False,
                "user_markers_in_dataset": False,
                "sessions_or_capabilities_in_dataset": False,
                "asset_paths": ["/data/santa-fe-3d/santa-fe-buildings-3d.0123456789abcdef.pmtiles"],
                "asset_sha256": [],
                "asset_sizes": [1],
                "asset_under_25_mib_hard_limit": True,
            }
            manifest_path = data_dir / "manifest.json"
            manifest_path.write_text(json.dumps(manifest))
            with self.assertRaises(AssertionError):
                module.validate(manifest_path, root)


if __name__ == "__main__":
    unittest.main()
