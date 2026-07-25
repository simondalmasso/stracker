#!/usr/bin/env python3
from __future__ import annotations

import argparse
import re
import sys
from pathlib import Path

from contract import read_zip_members, sha256_path, verify_members


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--zip", required=True)
    parser.add_argument("--expected-zip-sha256", required=True)
    parser.add_argument("--source-sha", required=True)
    parser.add_argument("--run-id", required=True)
    args = parser.parse_args(argv)

    expected_digest = args.expected_zip_sha256.strip().lower()
    if not re.fullmatch(r"[0-9a-f]{64}", expected_digest):
        raise RuntimeError("INVALID_EXPECTED_ZIP_SHA256")
    if not re.fullmatch(r"[0-9a-f]{40}", args.source_sha):
        raise RuntimeError("INVALID_SOURCE_SHA")
    if not re.fullmatch(r"[0-9]+", str(args.run_id)):
        raise RuntimeError("INVALID_RUN_ID")

    zip_path = Path(args.zip)
    actual_digest = sha256_path(zip_path)
    if actual_digest != expected_digest:
        raise RuntimeError("ZIP_DIGEST_MISMATCH")

    members = read_zip_members(zip_path)
    verify_members(
        members,
        source_sha=args.source_sha,
        run_id=str(args.run_id),
        external_zip_digest=actual_digest,
    )

    print("ZIP_DIGEST_MATCH=PASS")
    print("ARTIFACT_HEAD_SHA_MATCH=PASS")
    print("ARTIFACT_RUN_ID_MATCH=PASS")
    print("INTERNAL_SHA256SUMS=PASS")
    print("PRIVATE_DATA_USED=FALSE")
    print("REAL_COORDINATES=ABSENT")
    print("TOKENS=ABSENT")
    print("CAPABILITIES=ABSENT")
    print("COOKIES=ABSENT")
    print("AUTHORIZATION_VALUES=ABSENT")
    print("RAW_LOGS=ABSENT")
    print("ENV_FILES=ABSENT")
    print("SOURCE_ARCHIVE=ABSENT")
    print("ARTIFACT_FILE_ALLOWLIST_EXACT=PASS")
    print("SECURITY_ARTIFACT_SCAN=PASS")
    return 0


if __name__ == "__main__":
    sys.exit(main())
