#!/usr/bin/env python3
from __future__ import annotations

import hashlib
import importlib.util
import json
import shutil
import subprocess
import sys
import tempfile
import unittest
import zipfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
SCRIPT_DIR = ROOT / "scripts" / "native-sharing-cloudflare-artifact"
sys.path.insert(0, str(SCRIPT_DIR))

from contract import ALLOWED_FILES, canonical_json_bytes, read_zip_members, write_deterministic_zip  # noqa: E402

SOURCE_SHA = "a" * 40
RUN_ID = "123456"
REQUIRED_BROWSER_GATES = {
    "ROOT_SELECTOR_BEFORE_NETWORK": "PASS",
    "ROOT_SELECTOR_BEFORE_GEOLOCATION": "PASS",
    "ROOT_SELECTOR_BEFORE_MAP": "PASS",
    "MY_DEVICE_EXPLICIT_SELECTION": "PASS",
    "MY_DEVICE_SYNTHETIC_WATCH_POSITION": "PASS",
    "MY_DEVICE_COORDINATES_NOT_TRANSMITTED": "PASS",
    "SOURCE_SWITCH_CLEANUP": "PASS",
    "LATE_RESPONSE_BLOCKED": "PASS",
    "SHARE_EXPLICIT_START_REQUIRED": "PASS",
    "SHARE_NO_GEOLOCATION_BEFORE_START": "PASS",
    "SHARE_NO_SESSION_BEFORE_START": "PASS",
    "VIEWER_CONFIRMATION_REQUIRED": "PASS",
    "NO_API_BEFORE_VIEWER_CONFIRMATION": "PASS",
    "NO_MAP_BEFORE_VIEWER_CONFIRMATION": "PASS",
    "CAPABILITY_FRAGMENT_ONLY": "PASS",
    "FRAGMENT_REMOVED_AFTER_EXCHANGE": "PASS",
    "OPAQUE_BEARER_POLLING": "PASS",
    "CAPABILITY_IN_TRANSPORT_URL": "NO",
    "ROTATION_INVALIDATES_VIEWER": "PASS",
    "REVOCATION_INVALIDATES_VIEWER": "PASS",
    "GHOSTRAIL_CLEARED_ON_INVALIDATION": "PASS",
    "PREFERS_REDUCED_MOTION": "PASS",
    "MAP_ATTRIBUTION_PRESENT": "PASS",
    "BROWSER_SYNTHETIC_INTEGRATION": "PASS",
    "WORKER_SQLITE_E2E_NOT_CLAIMED": "YES",
}


def run(command: list[str], expect_success: bool) -> subprocess.CompletedProcess[str]:
    result = subprocess.run(command, text=True, capture_output=True, check=False)
    if expect_success and result.returncode != 0:
        raise AssertionError(result.stdout + result.stderr)
    if not expect_success and result.returncode == 0:
        raise AssertionError("command unexpectedly succeeded")
    return result


class ArtifactContractTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temp = Path(tempfile.mkdtemp(prefix="stracker-artifact-test-"))
        self.inputs = self.temp / "inputs"
        self.inputs.mkdir()
        self.output = self.temp / "artifact"
        self.zip_path = self.temp / "artifact.zip"
        self.digest_path = self.temp / "digest.txt"
        payloads = {
            "browser.json": {
                "schema": "browser.v2",
                "privateDataUsed": False,
                "coordinateValuesRetained": False,
                "secretValuesRetained": False,
                "pageErrorTotal": 0,
                "horizontalOverflowTotal": 0,
                "capabilityExchangeCountPerViewer": 1,
                "viewports": [{"width": 320, "height": 568}] * 5,
                "gates": REQUIRED_BROWSER_GATES,
            },
            "gates.json": {
                "privateDataUsed": False,
                "gates": {"FINAL_INTEGRITY_INPUTS": "PASS"},
            },
            "runtime.json": {
                "privateDataUsed": False,
                "workerdSqliteEvidencePreserved": True,
                "browserClaimsWorkerSqliteE2E": False,
            },
            "quota.json": {
                "privateDataUsed": False,
                "recurringInfrastructureCostUsd": 0,
                "mapProviderCostUsd": 0,
                "paidOverageAllowed": False,
                "automaticUpgradeToPaid": False,
                "failClosedOnFreeQuota": True,
            },
        }
        for name, payload in payloads.items():
            (self.inputs / name).write_bytes(canonical_json_bytes(payload))
        self.prepare()

    def tearDown(self) -> None:
        shutil.rmtree(self.temp)

    def prepare(self, expect_success: bool = True) -> subprocess.CompletedProcess[str]:
        return run([
            sys.executable,
            str(SCRIPT_DIR / "prepare.py"),
            "--browser", str(self.inputs / "browser.json"),
            "--gates", str(self.inputs / "gates.json"),
            "--runtime-tests", str(self.inputs / "runtime.json"),
            "--quota-model", str(self.inputs / "quota.json"),
            "--output-dir", str(self.output),
            "--zip", str(self.zip_path),
            "--digest-output", str(self.digest_path),
            "--source-sha", SOURCE_SHA,
            "--run-id", RUN_ID,
        ], expect_success)

    def verify(self, expect_success: bool = True, digest: str | None = None) -> subprocess.CompletedProcess[str]:
        return run([
            sys.executable,
            str(SCRIPT_DIR / "verify.py"),
            "--zip", str(self.zip_path),
            "--expected-zip-sha256", digest or self.digest_path.read_text().strip(),
            "--source-sha", SOURCE_SHA,
            "--run-id", RUN_ID,
        ], expect_success)

    def rewrite_zip(self, members: dict[str, bytes]) -> None:
        with zipfile.ZipFile(self.zip_path, "w", compression=zipfile.ZIP_DEFLATED) as archive:
            for name, data in members.items():
                archive.writestr(name, data)
        self.digest_path.write_text(hashlib.sha256(self.zip_path.read_bytes()).hexdigest() + "\n")

    def test_valid_artifact(self) -> None:
        result = self.verify()
        self.assertIn("ARTIFACT_FILE_ALLOWLIST_EXACT=PASS", result.stdout)
        self.assertEqual({path.name for path in self.output.iterdir()}, ALLOWED_FILES)

    def test_wrong_external_zip_digest_rejected(self) -> None:
        self.verify(False, "0" * 64)

    def test_extra_root_file_rejected(self) -> None:
        members = read_zip_members(self.zip_path)
        members["extra.txt"] = b"extra\n"
        self.rewrite_zip(members)
        self.verify(False)

    def test_missing_file_rejected(self) -> None:
        members = read_zip_members(self.zip_path)
        del members["quota-model.json"]
        self.rewrite_zip(members)
        self.verify(False)

    def test_crlf_checksum_rejected(self) -> None:
        members = read_zip_members(self.zip_path)
        members["sha256sums.txt"] = members["sha256sums.txt"].replace(b"\n", b"\r\n")
        self.rewrite_zip(members)
        self.verify(False)

    def test_reordered_checksum_rejected(self) -> None:
        members = read_zip_members(self.zip_path)
        lines = members["sha256sums.txt"].splitlines(keepends=True)
        members["sha256sums.txt"] = b"".join(reversed(lines))
        self.rewrite_zip(members)
        self.verify(False)

    def test_capability_value_rejected(self) -> None:
        members = read_zip_members(self.zip_path)
        payload = json.loads(members["gates.json"])
        payload["viewerCapability"] = "A" * 43 + "." + "B" * 43
        members["gates.json"] = canonical_json_bytes(payload)
        self.rewrite_zip(members)
        self.verify(False)

    def test_coordinate_value_rejected(self) -> None:
        members = read_zip_members(self.zip_path)
        payload = json.loads(members["browser-qa.json"])
        payload["lat"] = 10.1234
        members["browser-qa.json"] = canonical_json_bytes(payload)
        self.rewrite_zip(members)
        self.verify(False)

    def test_zip_digest_embedded_rejected(self) -> None:
        # Use a chosen valid-looking digest as both expected digest and embedded content,
        # then call the member verifier directly so the circularity rule is isolated.
        members = read_zip_members(self.zip_path)
        chosen = "d" * 64
        payload = json.loads(members["gates.json"])
        payload["embeddedDigest"] = chosen
        members["gates.json"] = canonical_json_bytes(payload)
        from contract import verify_members
        with self.assertRaisesRegex(RuntimeError, "ZIP_DIGEST_EMBEDDED"):
            verify_members(members, source_sha=SOURCE_SHA, run_id=RUN_ID, external_zip_digest=chosen)

    def test_duplicate_zip_entry_rejected(self) -> None:
        members = read_zip_members(self.zip_path)
        with zipfile.ZipFile(self.zip_path, "w", compression=zipfile.ZIP_DEFLATED) as archive:
            for name, data in members.items():
                archive.writestr(name, data)
            archive.writestr("manifest.json", members["manifest.json"])
        self.digest_path.write_text(hashlib.sha256(self.zip_path.read_bytes()).hexdigest() + "\n")
        self.verify(False)


if __name__ == "__main__":
    unittest.main(verbosity=2)
