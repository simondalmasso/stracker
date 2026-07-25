#!/usr/bin/env python3
from __future__ import annotations

import argparse
import json
import re
import shutil
import sys
from pathlib import Path

from contract import (
    ALLOWED_FILES,
    CHECKSUM_NAMES,
    SCHEMA,
    canonical_json_bytes,
    checksum_bytes,
    sha256_path,
    validate_json_payload,
    validate_text_bytes,
    write_deterministic_zip,
)


def read_json(path: Path, label: str) -> dict:
    payload = json.loads(path.read_text(encoding="utf-8", errors="strict"))
    if not isinstance(payload, dict):
        raise RuntimeError(f"ARTIFACT_INPUT_NOT_OBJECT:{label}")
    validate_json_payload(label, payload)
    return payload


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--browser", required=True)
    parser.add_argument("--gates", required=True)
    parser.add_argument("--runtime-tests", required=True)
    parser.add_argument("--quota-model", required=True)
    parser.add_argument("--output-dir", required=True)
    parser.add_argument("--zip", required=True)
    parser.add_argument("--digest-output", required=True)
    parser.add_argument("--source-sha", required=True)
    parser.add_argument("--run-id", required=True)
    args = parser.parse_args(argv)

    if not re.fullmatch(r"[0-9a-f]{40}", args.source_sha):
        raise RuntimeError("INVALID_SOURCE_SHA")
    if not re.fullmatch(r"[0-9]+", str(args.run_id)):
        raise RuntimeError("INVALID_RUN_ID")

    inputs = {
        "browser-qa.json": read_json(Path(args.browser), "browser-qa.json"),
        "gates.json": read_json(Path(args.gates), "gates.json"),
        "runtime-tests.json": read_json(Path(args.runtime_tests), "runtime-tests.json"),
        "quota-model.json": read_json(Path(args.quota_model), "quota-model.json"),
    }
    manifest = {
        "schema": SCHEMA,
        "sourceSha": args.source_sha,
        "workflowRunId": str(args.run_id),
        "files": list(CHECKSUM_NAMES),
        "privateDataUsed": False,
        "realCoordinatesIncluded": False,
        "tokensIncluded": False,
        "capabilitiesIncluded": False,
        "cookiesIncluded": False,
        "authorizationValuesIncluded": False,
        "rawLogsIncluded": False,
        "envFilesIncluded": False,
        "sourceArchiveIncluded": False,
        "accountIdentifiersIncluded": False,
        "namespaceIdentifiersIncluded": False,
    }
    inputs["manifest.json"] = manifest

    output = Path(args.output_dir)
    if output.exists():
        shutil.rmtree(output)
    output.mkdir(parents=True, mode=0o700)

    file_bytes: dict[str, bytes] = {}
    for name, payload in inputs.items():
        data = canonical_json_bytes(payload)
        validate_text_bytes(name, data)
        (output / name).write_bytes(data)
        file_bytes[name] = data

    (output / "sha256sums.txt").write_bytes(checksum_bytes(file_bytes))
    actual = {path.name for path in output.iterdir() if path.is_file()}
    if actual != ALLOWED_FILES or any(path.is_dir() for path in output.iterdir()):
        raise RuntimeError("ARTIFACT_FILE_ALLOWLIST_MISMATCH")

    zip_path = Path(args.zip)
    write_deterministic_zip(output, zip_path)
    digest = sha256_path(zip_path)
    Path(args.digest_output).write_text(digest + "\n", encoding="ascii", newline="\n")

    print("PREPARE_SANITIZED_ARTIFACT=PASS")
    print("ARTIFACT_FILE_ALLOWLIST_EXACT=PASS")
    print("INTERNAL_SHA256SUMS=PASS")
    print(f"ZIP_SHA256={digest}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
