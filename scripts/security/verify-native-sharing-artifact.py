#!/usr/bin/env python3
from __future__ import annotations

import argparse
import hashlib
import json
import re
import sys
from pathlib import Path

ALLOWED_FILES = {"browser-qa.json", "gates.json", "manifest.json", "sha256sums.txt"}
FORBIDDEN_PATTERNS = (
    re.compile(r"-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----"),
    re.compile(r"Authorization\s*:\s*Bearer", re.IGNORECASE),
    re.compile(r"\b(?:SID|HSID|SSID|APISID|SAPISID)=", re.IGNORECASE),
    re.compile(r"\b(?:viewerCapability|viewerSessionToken|emitterToken)\b\s*[:=]\s*['\"][A-Za-z0-9._-]{20,}", re.IGNORECASE),
    re.compile(r"-3[0-9]\.\d{3,}"),
    re.compile(r"-6[0-9]\.\d{3,}"),
)


def sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(65536), b""):
            digest.update(chunk)
    return digest.hexdigest()


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--artifact", required=True)
    parser.add_argument("--source-sha", required=True)
    parser.add_argument("--run-id", required=True)
    args = parser.parse_args(argv)

    root = Path(args.artifact)
    actual = {path.name for path in root.iterdir() if path.is_file()}
    if actual != ALLOWED_FILES or any(path.is_dir() for path in root.iterdir()):
        raise RuntimeError("ARTIFACT_ALLOWLIST_MISMATCH")

    for path in sorted(root.iterdir()):
        text = path.read_text(encoding="utf-8", errors="strict")
        for pattern in FORBIDDEN_PATTERNS:
            if pattern.search(text):
                raise RuntimeError(f"ARTIFACT_CONTENT_REJECTED:{path.name}")

    manifest = json.loads((root / "manifest.json").read_text(encoding="utf-8"))
    expected_flags = {
        "privateDataUsed": False,
        "realCoordinatesIncluded": False,
        "cookiesIncluded": False,
        "tokensIncluded": False,
        "capabilitiesIncluded": False,
        "authorizationHeadersIncluded": False,
        "rawLogsIncluded": False,
        "envFilesIncluded": False,
        "sourceArchiveIncluded": False,
    }
    if manifest.get("sourceSha") != args.source_sha:
        raise RuntimeError("ARTIFACT_HEAD_SHA_MISMATCH")
    if manifest.get("workflowRunId") != str(args.run_id):
        raise RuntimeError("ARTIFACT_RUN_ID_MISMATCH")
    if any(manifest.get(key) is not expected for key, expected in expected_flags.items()):
        raise RuntimeError("ARTIFACT_PRIVACY_FLAG_MISMATCH")

    checksums: dict[str, str] = {}
    for line in (root / "sha256sums.txt").read_text(encoding="utf-8").splitlines():
        digest, name = line.split("  ", 1)
        checksums[name] = digest
    expected_checksum_names = {"browser-qa.json", "gates.json", "manifest.json"}
    if set(checksums) != expected_checksum_names:
        raise RuntimeError("ARTIFACT_CHECKSUM_SET_MISMATCH")
    for name, expected_digest in checksums.items():
        if sha256(root / name) != expected_digest:
            raise RuntimeError(f"ARTIFACT_CHECKSUM_MISMATCH:{name}")

    browser = json.loads((root / "browser-qa.json").read_text(encoding="utf-8"))
    if browser.get("privateDataUsed") is not False:
        raise RuntimeError("BROWSER_PRIVATE_DATA_FLAG_INVALID")
    if browser.get("coordinateValuesRetained") is not False:
        raise RuntimeError("BROWSER_COORDINATE_FLAG_INVALID")
    if browser.get("secretValuesRetained") is not False:
        raise RuntimeError("BROWSER_SECRET_FLAG_INVALID")

    print("ARTIFACT_HEAD_SHA_MATCH=PASS")
    print("ARTIFACT_RUN_ID_MATCH=PASS")
    print("INTERNAL_SHA256SUMS=PASS")
    print("PRIVATE_DATA_USED=FALSE")
    print("REAL_COORDINATES=ABSENT")
    print("COOKIES=ABSENT")
    print("TOKENS=ABSENT")
    print("CAPABILITIES=ABSENT")
    print("AUTHORIZATION_HEADERS=ABSENT")
    print("RAW_LOGS=ABSENT")
    print("ENV_FILES=ABSENT")
    print("SOURCE_ARCHIVE=ABSENT")
    print("SECURITY_ARTIFACT_SCAN=PASS")
    return 0


if __name__ == "__main__":
    sys.exit(main())
