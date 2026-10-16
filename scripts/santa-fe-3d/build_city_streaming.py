#!/usr/bin/env python3
"""Bounded STAC-backed entry point for the Santa Fe city materializer.

This wrapper keeps the pinned build implementation stable while replacing the
unbounded Overture reader with a file-pruned, batch-consumed reader. It avoids
opening the global type dataset and avoids RecordBatchReader.read_all().
"""
from __future__ import annotations

import importlib.util
import json
import sys
import time
from pathlib import Path
from typing import Any

from overturemaps.core import record_batch_reader

MODULE_PATH = Path(__file__).with_name("build_city.py")


def load_builder():
    spec = importlib.util.spec_from_file_location("stracker_santa_fe_build_city", MODULE_PATH)
    if spec is None or spec.loader is None:
        raise RuntimeError("BUILD_CITY_MODULE_LOAD_FAILED")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def read_rows_bounded(kind: str, bbox: tuple[float, float, float, float], release: str) -> list[dict[str, Any]]:
    started = time.monotonic()
    print(json.dumps({"stage": f"EXTRACT_{kind.upper()}", "status": "START", "stac": True}, sort_keys=True))
    reader = record_batch_reader(
        kind,
        bbox=bbox,
        release=release,
        connect_timeout=45,
        request_timeout=240,
        stac=True,
    )
    if reader is None:
        raise RuntimeError(f"OVERTURE_READER_UNAVAILABLE:{kind}")

    rows: list[dict[str, Any]] = []
    batches = 0
    for batch in reader:
        batches += 1
        if batch.num_rows:
            rows.extend(batch.to_pylist())
    duration = round(time.monotonic() - started, 3)
    print(json.dumps({
        "stage": f"EXTRACT_{kind.upper()}",
        "status": "PASS",
        "rows": len(rows),
        "batches": batches,
        "duration_seconds": duration,
    }, sort_keys=True))
    return rows


def main() -> int:
    builder = load_builder()

    def bounded_reader(kind: str, bbox: tuple[float, float, float, float]):
        return read_rows_bounded(kind, bbox, builder.OVERTURE_RELEASE)

    builder.read_rows = bounded_reader
    return int(builder.main())


if __name__ == "__main__":
    raise SystemExit(main())
