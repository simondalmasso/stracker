#!/usr/bin/env python3
from __future__ import annotations

import hashlib
import json
import re
import zipfile
from pathlib import Path, PurePosixPath
from typing import Any

JSON_FILES = (
    "browser-qa.json",
    "gates.json",
    "manifest.json",
    "quota-model.json",
    "runtime-tests.json",
)
CHECKSUM_FILE = "sha256sums.txt"
ALLOWED_FILES = frozenset((*JSON_FILES, CHECKSUM_FILE))
CHECKSUM_NAMES = tuple(sorted(JSON_FILES))
SCHEMA = "stracker.native-sharing-final-validation.v2"

FORBIDDEN_TEXT_PATTERNS = (
    re.compile(r"-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----"),
    re.compile(r"Authorization\s*:\s*Bearer\s+[A-Za-z0-9._~+/-]{8,}", re.IGNORECASE),
    re.compile(r"\b(?:SID|HSID|SSID|APISID|SAPISID)=", re.IGNORECASE),
    re.compile(r"\b(?:viewerCapability|viewerSessionToken|emitterToken)\b\s*[:=]\s*['\"][A-Za-z0-9._-]{20,}", re.IGNORECASE),
    re.compile(r"\b(?:account[_-]?id|namespace[_-]?id)\b\s*[:=]\s*['\"][^'\"]+", re.IGNORECASE),
)
SENSITIVE_KEYS = {
    "authorization",
    "authorizationHeader",
    "authorizationHeaders",
    "cookie",
    "cookies",
    "emitterToken",
    "viewerCapability",
    "viewerSessionToken",
    "accountId",
    "namespaceId",
    "lat",
    "latitude",
    "lng",
    "lon",
    "longitude",
}


def canonical_json_bytes(payload: Any) -> bytes:
    return (json.dumps(payload, indent=2, sort_keys=True, ensure_ascii=False) + "\n").encode("utf-8")


def sha256_bytes(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def sha256_path(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(65536), b""):
            digest.update(chunk)
    return digest.hexdigest()


def _walk_sensitive(payload: Any, location: str = "$") -> None:
    if isinstance(payload, dict):
        for key, value in payload.items():
            child = f"{location}.{key}"
            if key in SENSITIVE_KEYS and value not in (None, False, "", [], {}):
                raise RuntimeError(f"ARTIFACT_SENSITIVE_VALUE:{child}")
            _walk_sensitive(value, child)
    elif isinstance(payload, list):
        for index, value in enumerate(payload):
            _walk_sensitive(value, f"{location}[{index}]")


def validate_text_bytes(name: str, data: bytes, forbidden_digest: str | None = None) -> str:
    if b"\r" in data:
        raise RuntimeError(f"ARTIFACT_CRLF_REJECTED:{name}")
    try:
        text = data.decode("utf-8", errors="strict")
    except UnicodeDecodeError as error:
        raise RuntimeError(f"ARTIFACT_UTF8_REJECTED:{name}") from error
    for pattern in FORBIDDEN_TEXT_PATTERNS:
        if pattern.search(text):
            raise RuntimeError(f"ARTIFACT_CONTENT_REJECTED:{name}")
    if forbidden_digest and forbidden_digest.lower() in text.lower():
        raise RuntimeError(f"ZIP_DIGEST_EMBEDDED:{name}")
    return text


def validate_json_payload(name: str, payload: Any) -> None:
    _walk_sensitive(payload)
    if name != "manifest.json":
        if not isinstance(payload, dict) or payload.get("privateDataUsed") is not False:
            raise RuntimeError(f"PRIVATE_DATA_FLAG_INVALID:{name}")


def checksum_bytes(files: dict[str, bytes]) -> bytes:
    if set(files) != set(CHECKSUM_NAMES):
        raise RuntimeError("ARTIFACT_CHECKSUM_INPUT_SET_MISMATCH")
    return "".join(f"{sha256_bytes(files[name])}  {name}\n" for name in CHECKSUM_NAMES).encode("ascii")


def parse_checksum_bytes(data: bytes) -> dict[str, str]:
    if not data.endswith(b"\n") or b"\r" in data:
        raise RuntimeError("ARTIFACT_CHECKSUM_LINE_ENDING_INVALID")
    text = data.decode("ascii", errors="strict")
    lines = text.splitlines()
    if len(lines) != len(CHECKSUM_NAMES):
        raise RuntimeError("ARTIFACT_CHECKSUM_ENTRY_COUNT_INVALID")
    parsed: dict[str, str] = {}
    for line in lines:
        match = re.fullmatch(r"([0-9a-f]{64})  ([A-Za-z0-9._-]+)", line)
        if not match:
            raise RuntimeError("ARTIFACT_CHECKSUM_FORMAT_INVALID")
        digest, name = match.groups()
        if name in parsed:
            raise RuntimeError("ARTIFACT_CHECKSUM_DUPLICATE")
        parsed[name] = digest
    if tuple(parsed) != CHECKSUM_NAMES:
        raise RuntimeError("ARTIFACT_CHECKSUM_ORDER_OR_SET_INVALID")
    return parsed


def write_deterministic_zip(source_dir: Path, zip_path: Path) -> None:
    actual = {path.name for path in source_dir.iterdir() if path.is_file()}
    if actual != ALLOWED_FILES or any(path.is_dir() for path in source_dir.iterdir()):
        raise RuntimeError("ARTIFACT_FILE_ALLOWLIST_MISMATCH")
    zip_path.parent.mkdir(parents=True, exist_ok=True)
    with zipfile.ZipFile(zip_path, "w", compression=zipfile.ZIP_DEFLATED, compresslevel=9) as archive:
        for name in sorted(ALLOWED_FILES):
            data = (source_dir / name).read_bytes()
            info = zipfile.ZipInfo(name, date_time=(1980, 1, 1, 0, 0, 0))
            info.compress_type = zipfile.ZIP_DEFLATED
            info.external_attr = 0o600 << 16
            info.create_system = 3
            archive.writestr(info, data)


def read_zip_members(zip_path: Path) -> dict[str, bytes]:
    members: dict[str, bytes] = {}
    with zipfile.ZipFile(zip_path, "r") as archive:
        infos = archive.infolist()
        if len(infos) != len(ALLOWED_FILES):
            raise RuntimeError("ARTIFACT_ZIP_ENTRY_COUNT_INVALID")
        for info in infos:
            pure = PurePosixPath(info.filename)
            if info.is_dir() or pure.name != info.filename or pure.is_absolute() or ".." in pure.parts:
                raise RuntimeError("ARTIFACT_ZIP_PATH_INVALID")
            if info.filename in members:
                raise RuntimeError("ARTIFACT_ZIP_DUPLICATE_ENTRY")
            members[info.filename] = archive.read(info)
    if set(members) != ALLOWED_FILES:
        raise RuntimeError("ARTIFACT_FILE_ALLOWLIST_MISMATCH")
    return members


def verify_members(
    members: dict[str, bytes],
    *,
    source_sha: str,
    run_id: str,
    external_zip_digest: str,
) -> None:
    if set(members) != ALLOWED_FILES:
        raise RuntimeError("ARTIFACT_FILE_ALLOWLIST_MISMATCH")

    payloads: dict[str, Any] = {}
    for name, data in members.items():
        text = validate_text_bytes(name, data, external_zip_digest)
        if name.endswith(".json"):
            try:
                payload = json.loads(text)
            except json.JSONDecodeError as error:
                raise RuntimeError(f"ARTIFACT_JSON_INVALID:{name}") from error
            if canonical_json_bytes(payload) != data:
                raise RuntimeError(f"ARTIFACT_JSON_NOT_CANONICAL:{name}")
            validate_json_payload(name, payload)
            payloads[name] = payload

    manifest = payloads["manifest.json"]
    expected_manifest_flags = {
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
    if manifest.get("schema") != SCHEMA:
        raise RuntimeError("ARTIFACT_SCHEMA_MISMATCH")
    if manifest.get("sourceSha") != source_sha:
        raise RuntimeError("ARTIFACT_HEAD_SHA_MISMATCH")
    if manifest.get("workflowRunId") != run_id:
        raise RuntimeError("ARTIFACT_RUN_ID_MISMATCH")
    if manifest.get("files") != list(CHECKSUM_NAMES):
        raise RuntimeError("ARTIFACT_MANIFEST_FILE_SET_MISMATCH")
    if any(manifest.get(key) is not value for key, value in expected_manifest_flags.items()):
        raise RuntimeError("ARTIFACT_PRIVACY_FLAG_MISMATCH")

    expected_checksums = checksum_bytes({name: members[name] for name in CHECKSUM_NAMES})
    if members[CHECKSUM_FILE] != expected_checksums:
        raise RuntimeError("ARTIFACT_SHA256SUMS_BYTE_MISMATCH")
    parsed = parse_checksum_bytes(members[CHECKSUM_FILE])
    for name, digest in parsed.items():
        if sha256_bytes(members[name]) != digest:
            raise RuntimeError(f"ARTIFACT_CHECKSUM_MISMATCH:{name}")

    browser = payloads["browser-qa.json"]
    required_browser_gates = {
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
    if browser.get("pageErrorTotal") != 0 or browser.get("horizontalOverflowTotal") != 0:
        raise RuntimeError("BROWSER_QA_ERROR_TOTAL_INVALID")
    if browser.get("capabilityExchangeCountPerViewer") != 1:
        raise RuntimeError("BROWSER_EXCHANGE_COUNT_INVALID")
    if len(browser.get("viewports", [])) != 5:
        raise RuntimeError("BROWSER_VIEWPORT_COUNT_INVALID")
    gates = browser.get("gates")
    if not isinstance(gates, dict) or any(gates.get(key) != value for key, value in required_browser_gates.items()):
        raise RuntimeError("BROWSER_REQUIRED_GATE_MISSING")

    overall_gates = payloads["gates.json"].get("gates")
    if not isinstance(overall_gates, dict) or overall_gates.get("FINAL_INTEGRITY_INPUTS") != "PASS":
        raise RuntimeError("ARTIFACT_GATE_PAYLOAD_INVALID")

    runtime = payloads["runtime-tests.json"]
    if runtime.get("workerdSqliteEvidencePreserved") is not True:
        raise RuntimeError("RUNTIME_EVIDENCE_FLAG_INVALID")
    if runtime.get("browserClaimsWorkerSqliteE2E") is not False:
        raise RuntimeError("RUNTIME_BROWSER_CLAIM_INVALID")

    quota = payloads["quota-model.json"]
    expected_quota = {
        "recurringInfrastructureCostUsd": 0,
        "mapProviderCostUsd": 0,
        "paidOverageAllowed": False,
        "automaticUpgradeToPaid": False,
        "failClosedOnFreeQuota": True,
    }
    if any(quota.get(key) != value for key, value in expected_quota.items()):
        raise RuntimeError("QUOTA_MODEL_INVALID")
