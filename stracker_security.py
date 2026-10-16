
"""Security boundary helpers for STRACKER's temporary Python runtime.

This module is intentionally dependency-free. Cloudflare Access will
eventually protect the full UI; until then, sensitive backend routes
require a server-configured service token and static files are served
through a fail-closed allowlist.
"""

from __future__ import annotations

import hmac
import os
from dataclasses import dataclass
from enum import Enum
from pathlib import PurePosixPath
from urllib.parse import unquote


class SecurityConfigurationError(RuntimeError):
    """Raised when required security material is absent or invalid."""


class RuntimeMode(str, Enum):
    DEVELOPMENT = "development"
    TEST = "test"
    PRODUCTION = "production"


@dataclass(frozen=True)
class AuthDecision:
    allowed: bool
    status: int
    reason: str


_PROTECTED_EXACT = {
    "/points",
    "/api/cookies",
    "/cookies",
    "/cookies.html",
    "/predict",
    "/api/archive",
    "/archive",
    "/ghostrail/encrypted",
    "/health/details",
    "/mapa.html",
}
_PROTECTED_PREFIXES = (
    "/points/",
    "/api/cookies/",
    "/cookies/",
    "/predict/",
    "/api/archive/",
    "/archive/",
    "/ghostrail/encrypted/",
    "/health/details/",
)

_BLOCKED_BASENAMES = {
    ".env",
    "cookies.json",
    "cookies.json.bak",
    "historial.csv",
    "tracker.log",
    "ghostrail.enc",
    "ghostrail_archive.enc",
    "gemini-analysis-input.json",
}
_BLOCKED_SEGMENTS = {
    ".git",
    ".github",
    "playwright_profile",
    "tool-results",
    "screenshots-sensitive",
    "artifacts-sensitive",
}
_PUBLIC_EXACT = {
    "/index.html",
    "/manifest.json",
    "/robots.txt",
    "/favicon.ico",
    "/logo.svg",
    "/apple-touch-icon.png",
}
_PUBLIC_ASSET_SUFFIXES = {
    ".js",
    ".css",
    ".map",
    ".woff",
    ".woff2",
    ".ttf",
    ".otf",
    ".png",
    ".jpg",
    ".jpeg",
    ".webp",
    ".svg",
    ".ico",
    ".json",
    ".txt",
}


def runtime_mode() -> RuntimeMode:
    raw = os.environ.get("STRACKER_ENV", "development").strip().lower()
    aliases = {"dev": "development", "prod": "production", "testing": "test"}
    raw = aliases.get(raw, raw)
    try:
        return RuntimeMode(raw)
    except ValueError as exc:
        raise SecurityConfigurationError("STRACKER_ENV must be development, test, or production") from exc


def _normalize_path(path: str) -> str:
    decoded = unquote((path or "/").split("?", 1)[0]).replace("\\", "/")
    if not decoded.startswith("/"):
        decoded = "/" + decoded
    normalized = "/" + str(PurePosixPath(decoded)).lstrip("/")
    return "/" if normalized == "/." else normalized


def is_protected_path(path: str) -> bool:
    normalized = _normalize_path(path)
    return normalized in _PROTECTED_EXACT or normalized.startswith(_PROTECTED_PREFIXES)


def is_blocked_static_path(path: str) -> bool:
    normalized = _normalize_path(path)
    parts = [part.lower() for part in PurePosixPath(normalized).parts if part not in ("/", "")]
    if any(part in _BLOCKED_SEGMENTS for part in parts):
        return True
    if any(part == ".env" or part.startswith(".env.") for part in parts):
        return True
    basename = parts[-1] if parts else ""
    if basename in _BLOCKED_BASENAMES:
        return True
    if basename.endswith(".log"):
        return True
    return False


def is_public_asset_path(path: str) -> bool:
    normalized = _normalize_path(path)
    if is_blocked_static_path(normalized):
        return False
    if normalized in _PUBLIC_EXACT:
        return True
    if normalized.startswith("/_next/"):
        return PurePosixPath(normalized).suffix.lower() in _PUBLIC_ASSET_SUFFIXES
    return False


def _configured_api_token() -> str | None:
    token = os.environ.get("STRACKER_API_TOKEN", "").strip()
    return token if len(token) >= 32 else None


def _presented_token(headers) -> str:
    authorization = (headers.get("Authorization", "") or "").strip()
    if authorization.lower().startswith("bearer "):
        return authorization[7:].strip()
    return (headers.get("X-Stracker-Service-Token", "") or "").strip()


def authorize_request_headers(headers) -> AuthDecision:
    expected = _configured_api_token()
    if expected is None:
        return AuthDecision(False, 503, "auth_not_configured")
    presented = _presented_token(headers)
    if not presented:
        return AuthDecision(False, 401, "missing_credential")
    if not hmac.compare_digest(presented.encode("utf-8"), expected.encode("utf-8")):
        return AuthDecision(False, 401, "invalid_credential")
    return AuthDecision(True, 200, "authorized")


def get_secret_key() -> str:
    key = os.environ.get("SECRET_KEY", "").strip()
    if len(key) < 32:
        raise SecurityConfigurationError("SECRET_KEY must be configured with at least 32 characters")
    return key


def validate_startup_security(aesgcm_available: bool) -> None:
    if runtime_mode() is not RuntimeMode.PRODUCTION:
        return
    if _configured_api_token() is None:
        raise SecurityConfigurationError("STRACKER_API_TOKEN is required in production")
    get_secret_key()
    if not aesgcm_available:
        raise SecurityConfigurationError("AES-GCM support is required in production")
