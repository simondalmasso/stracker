from __future__ import annotations

import importlib.util
import sys
import unittest
from pathlib import Path
from unittest.mock import patch

MODULE_PATH = Path(__file__).resolve().parents[2] / "scripts" / "santa-fe-3d" / "build_city_streaming.py"


def load_module():
    spec = importlib.util.spec_from_file_location("build_city_streaming_test_target", MODULE_PATH)
    if spec is None or spec.loader is None:
        raise RuntimeError("STREAMING_MODULE_LOAD_FAILED")
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    return module


class FakeBatch:
    def __init__(self, rows):
        self._rows = rows
        self.num_rows = len(rows)

    def to_pylist(self):
        return list(self._rows)


class FakeReader:
    def __iter__(self):
        yield FakeBatch([{"id": "a"}])
        yield FakeBatch([])
        yield FakeBatch([{"id": "b"}])

    def read_all(self):
        raise AssertionError("read_all must not be used")


class StreamingReaderTest(unittest.TestCase):
    def test_uses_stac_and_consumes_batches_without_read_all(self):
        module = load_module()
        captured = {}

        def fake_reader(kind, **kwargs):
            captured["kind"] = kind
            captured.update(kwargs)
            return FakeReader()

        with patch.object(module, "record_batch_reader", fake_reader):
            rows = module.read_rows_bounded("building", (-60.71, -31.66, -60.69, -31.63), "2026-07-22.0")

        self.assertEqual(rows, [{"id": "a"}, {"id": "b"}])
        self.assertEqual(captured["kind"], "building")
        self.assertTrue(captured["stac"])
        self.assertEqual(captured["release"], "2026-07-22.0")
        self.assertEqual(captured["connect_timeout"], 45)
        self.assertEqual(captured["request_timeout"], 240)


if __name__ == "__main__":
    unittest.main()
