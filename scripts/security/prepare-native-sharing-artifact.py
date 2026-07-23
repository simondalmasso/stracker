#!/usr/bin/env python3
from __future__ import annotations

import argparse
import hashlib
import json
import re
import shutil
import sys
from pathlib import Path

ALLOWED_FILES = {"browser-qa.json", "gates.json", "manifest.json", "sha256sums.txt"}
FORBIDDEN_PATTERNS = (
    re.compile(r"-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----"),
    re.compile(r"Authorization\s*:\s*Bearer", re.IGNORECASE),
    re.compile(r"\b(?:SID|HSID|SSID|APISID|SAPISID)=", re.IGNORECASE),
    re.compile(r"\b(?:viewerCapability|viewerSessionToken|emitterToken)\b\s*[:=]\s*['\"][A-Za-z0-9._-]{20,}", re.IGNORECASE),
    re.compile(r"\b(?:localStorage|sessionStorage|indexedDB)\b", re.IGNORECASE),
    re.compile(r"-3[0-9]\.\d{3,}"),
    re.compile(r"-6[0-9]\.\d{3,}"),
)


def sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(65536), b""):
            digest.update(chunk)
    return digest.hexdigest()


def validate_text(path: Path) -> None:
    text = path.read_text(encoding="utf-8", errors="strict")
    for pattern in FORBIDDEN_PATTERNS:
        if pattern.search(text):
            raise RuntimeError(f"ARTIFACT_CONTENT_REJECTED:{path.name}")


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--browser", required=True)
    parser.add_argument("--gates", required=True)
    parser.add_argument("--output", required=True)
    parser.add_argument("--source-sha", required=True)
    parser.add_argument("--run-id", required=True)
    args = parser.parse_args(argv)

    if not re.fullmatch(r"[0-9a-f]{40}", args.source_sha):
        raise RuntimeError("INVALID_SOURCE_SHA")
    if not re.fullmatch(r"[0-9]+", str(args.run_id)):
        raise RuntimeError("INVALID_RUN_ID")

    browser_source = Path(args.browser)
    gates_source = Path(args.gates)
    output = Path(args.output)
    output.mkdir(parents=True, exist_ok=True, mode=0o700)
    for existing in output.iterdir():
        if existing.is_dir():
            shutil.rmtree(existing)
        else:
            existing.unlink()

    browser_payload = json.loads(browser_source.read_text(encoding="utf-8"))
    gates_payload = json.loads(gates_source.read_text(encoding="utf-8"))
    if browser_payload.get("privateDataUsed") is not False:
        raise RuntimeError("PRIVATE_DATA_FLAG_INVALID")
    if browser_payload.get("coordinateValuesRetained") is not False:
        raise RuntimeError("COORDINATE_FLAG_INVALID")
    if browser_payload.get("secretValuesRetained") is not False:
        raise RuntimeError("SECRET_FLAG_INVALID")

    browser_target = output / "browser-qa.json"
    gates_target = output / "gates.json"
    browser_target.write_text(json.dumps(browser_payload, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    gates_target.write_text(json.dumps(gates_payload, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    validate_text(browser_target)
    validate_text(gates_target)

    manifest_payload = {
        "schema": "stracker.native-sharing-validation-artifact.v1",
        "sourceSha": args.source_sha,
        "workflowRunId": str(args.run_id),
        "privateDataUsed": False,
        "realCoordinatesIncluded": False,
        "cookiesIncluded": False,
        "tokensIncluded": False,
        "capabilitiesIncluded": False,
        "authorizationHeadersIncluded": False,
        "rawLogsIncluded": False,
        "envFilesIncluded": False,
        "sourceArchiveIncluded": False,
        "files": [
            {"name": browser_target.name, "sha256": sha256(browser_target)},
            {"name": gates_target.name, "sha256": sha256(gates_target)},
        ],
    }
    manifest_target = output / "manifest.json"
    manifest_target.write_text(json.dumps(manifest_payload, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    validate_text(manifest_target)

    checksummed = [browser_target, gates_target, manifest_target]
    checksum_target = output / "sha256sums.txt"
    checksum_target.write_text("".join(f"{sha256(path)}  {path.name}\n" for path in checksummed), encoding="utf-8")
    validate_text(checksum_target)

    actual = {path.name for path in output.iterdir() if path.is_file()}
    if actual != ALLOWED_FILES or any(path.is_dir() for path in output.iterdir()):
        raise RuntimeError("ARTIFACT_ALLOWLIST_MISMATCH")

    print("PREPARE_SANITIZED_ARTIFACT=PASS")
    return 0


if __name__ == "__main__":
    sys.exit(main())
