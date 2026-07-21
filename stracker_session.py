"""Canonical Google shared-session parsing and health checks for STRACKER.

Cookie values are intentionally treated as opaque secrets. Public responses expose
only counts, cookie names required for diagnostics, and classified health states.
"""

from __future__ import annotations

import json
import os
import re
import tempfile
import time
import urllib.error
import urllib.request
from dataclasses import dataclass
from pathlib import Path
from typing import Callable, Iterable

MAX_IMPORT_BYTES = 512 * 1024
ALLOWED_DOMAIN_SUFFIXES = ("google.com",)
CRITICAL_COOKIE_NAMES = (
    "SID",
    "HSID",
    "SSID",
    "APISID",
    "SAPISID",
    "__Secure-1PSID",
    "__Secure-3PSID",
)
_COORDINATE_PATTERN = re.compile(r"\[null,(-?\d{1,3}\.\d+),(-?\d{1,3}\.\d+)\]")


class SessionInputError(ValueError):
    """Safe parser error. The message never contains cookie values."""

    def __init__(self, code: str, message: str, action: str):
        super().__init__(message)
        self.code = code
        self.message = message
        self.action = action


@dataclass(frozen=True)
class NormalizedCookie:
    name: str
    value: str
    domain: str
    path: str = "/"
    secure: bool = True
    expires: int | None = None
    http_only: bool = False
    same_site: str | None = None

    def to_storage_dict(self) -> dict:
        return {
            "name": self.name,
            "value": self.value,
            "domain": self.domain,
            "path": self.path,
            "secure": self.secure,
            "expires": self.expires,
            "httpOnly": self.http_only,
            "sameSite": self.same_site,
        }


@dataclass(frozen=True)
class ParsedSession:
    format_detected: str
    cookies: tuple[NormalizedCookie, ...]
    critical_present: tuple[str, ...]
    critical_missing: tuple[str, ...]

    def public_summary(self) -> dict:
        return {
            "formatDetected": self.format_detected,
            "count": len(self.cookies),
            "criticalPresent": list(self.critical_present),
            "criticalMissing": list(self.critical_missing),
        }


@dataclass(frozen=True)
class SessionHealth:
    health: str
    state: str
    configured: bool
    message: str
    location_available: bool = False

    def public_summary(self) -> dict:
        return {
            "health": self.health,
            "state": self.state,
            "configured": self.configured,
            "message": self.message,
        }


def _allowed_domain(domain: str) -> bool:
    normalized = domain.strip().lower().lstrip(".")
    return any(normalized == suffix or normalized.endswith("." + suffix) for suffix in ALLOWED_DOMAIN_SUFFIXES)


def _expiry(value: object) -> int | None:
    if value in (None, "", 0, "0", -1, "-1"):
        return None
    try:
        parsed = int(float(str(value)))
    except (TypeError, ValueError):
        raise SessionInputError("INVALID_EXPIRY", "Una cookie tiene una fecha de vencimiento inválida.", "Exportá nuevamente la sesión.")
    return parsed if parsed > 0 else None


def _normalize_item(item: object, default_domain: str = ".google.com") -> NormalizedCookie:
    if not isinstance(item, dict):
        raise SessionInputError("INVALID_COOKIE", "La sesión contiene una cookie inválida.", "Usá una exportación compatible.")
    name = str(item.get("name", "")).strip()
    value = item.get("value")
    if not name or not isinstance(value, str) or not value:
        raise SessionInputError("INVALID_COOKIE", "Una cookie no tiene nombre o valor válido.", "Exportá nuevamente la sesión.")
    domain = str(item.get("domain") or item.get("host") or default_domain).strip().lower()
    if not _allowed_domain(domain):
        raise SessionInputError("DOMAIN_NOT_ALLOWED", "La sesión contiene dominios no permitidos.", "Importá únicamente cookies de Google Maps.")
    path = str(item.get("path") or "/")
    if not path.startswith("/"):
        path = "/"
    same_site = item.get("sameSite")
    return NormalizedCookie(
        name=name,
        value=value,
        domain=domain,
        path=path,
        secure=bool(item.get("secure", True)),
        expires=_expiry(item.get("expirationDate", item.get("expires"))),
        http_only=bool(item.get("httpOnly", False)),
        same_site=str(same_site) if same_site else None,
    )


def _parse_json(value: object) -> tuple[str, list[object]]:
    if isinstance(value, list):
        return "cookie_editor_json", value
    if not isinstance(value, dict):
        raise SessionInputError("FORMAT_NOT_RECOGNIZED", "Formato no reconocido.", "Usá Cookie Editor JSON, Header String o Netscape.")
    if "data" not in value:
        raise SessionInputError("FORMAT_NOT_RECOGNIZED", "El JSON envuelto no contiene el campo data.", "Exportá nuevamente la sesión.")
    wrapped = value.get("data")
    if isinstance(wrapped, str):
        try:
            wrapped = json.loads(wrapped)
        except json.JSONDecodeError as exc:
            raise SessionInputError("MALFORMED_JSON", "El campo data no contiene JSON válido.", "Corregí el contenido e intentá nuevamente.") from exc
        detected = "wrapped_json_string"
    else:
        detected = "wrapped_json_array"
    if not isinstance(wrapped, list):
        raise SessionInputError("INVALID_WRAPPED_JSON", "El campo data debe contener una lista de cookies.", "Exportá nuevamente la sesión.")
    return detected, wrapped


def _parse_header(raw: str) -> list[object]:
    result: list[object] = []
    for pair in raw.split(";"):
        pair = pair.strip()
        if not pair:
            continue
        if "=" not in pair:
            raise SessionInputError("MALFORMED_HEADER", "El Header String contiene un segmento inválido.", "Copiá el header Cookie completo.")
        name, value = pair.split("=", 1)
        name = name.strip()
        if not name or not value:
            raise SessionInputError("MALFORMED_HEADER", "El Header String contiene una cookie vacía.", "Copiá el header Cookie completo.")
        result.append({"name": name, "value": value, "domain": ".google.com", "path": "/", "secure": True})
    return result


def _parse_netscape(raw: str) -> list[object]:
    result: list[object] = []
    for line in raw.splitlines():
        stripped = line.strip()
        if not stripped or stripped.startswith("#"):
            continue
        parts = line.split("\t")
        if len(parts) < 7:
            raise SessionInputError("MALFORMED_NETSCAPE", "El archivo Netscape contiene una línea inválida.", "Exportá nuevamente el archivo Netscape.")
        domain, _include_subdomains, path, secure, expires, name = parts[:6]
        value = "\t".join(parts[6:])
        result.append({
            "domain": domain,
            "path": path,
            "secure": secure.upper() == "TRUE",
            "expires": expires,
            "name": name,
            "value": value,
        })
    return result


def parse_cookie_input(raw: str) -> ParsedSession:
    if not isinstance(raw, str):
        raise SessionInputError("INVALID_BODY", "El contenido debe ser texto.", "Pegá una exportación compatible.")
    raw_bytes = raw.encode("utf-8")
    if not raw_bytes:
        raise SessionInputError("EMPTY_INPUT", "No se recibió ninguna sesión.", "Pegá una exportación antes de importar.")
    if len(raw_bytes) > MAX_IMPORT_BYTES:
        raise SessionInputError("INPUT_TOO_LARGE", "La sesión supera el tamaño permitido.", "Exportá únicamente las cookies necesarias de Google Maps.")

    stripped = raw.strip()
    if stripped.startswith("[") or stripped.startswith("{"):
        try:
            decoded = json.loads(stripped)
        except json.JSONDecodeError as exc:
            raise SessionInputError("MALFORMED_JSON", "El JSON no es válido.", "Corregí el contenido e intentá nuevamente.") from exc
        format_detected, items = _parse_json(decoded)
    elif stripped.startswith("# Netscape HTTP Cookie File") or any(len(line.split("\t")) >= 7 for line in stripped.splitlines()):
        format_detected, items = "netscape", _parse_netscape(stripped)
    elif "=" in stripped:
        format_detected, items = "cookie_header", _parse_header(stripped)
    else:
        raise SessionInputError("FORMAT_NOT_RECOGNIZED", "Formato no reconocido.", "Usá Cookie Editor JSON, JSON envuelto, Header String o Netscape.")

    normalized: dict[tuple[str, str, str], NormalizedCookie] = {}
    now = int(time.time())
    for item in items:
        cookie = _normalize_item(item)
        if cookie.expires is not None and cookie.expires <= now:
            continue
        normalized[(cookie.domain.lower(), cookie.path, cookie.name)] = cookie

    cookies = tuple(normalized.values())
    if not cookies:
        raise SessionInputError("NO_VALID_COOKIES", "No quedaron cookies válidas después de normalizar.", "Renová la sesión y exportala nuevamente.")
    names = {cookie.name for cookie in cookies}
    present = tuple(name for name in CRITICAL_COOKIE_NAMES if name in names)
    missing = tuple(name for name in CRITICAL_COOKIE_NAMES if name not in names)
    return ParsedSession(format_detected, cookies, present, missing)


def write_session_atomic(path: Path, parsed: ParsedSession) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    payload = [cookie.to_storage_dict() for cookie in parsed.cookies]
    fd, temp_name = tempfile.mkstemp(prefix=".cookies-", suffix=".json", dir=str(path.parent))
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as handle:
            json.dump(payload, handle, ensure_ascii=False, separators=(",", ":"))
            handle.flush()
            os.fsync(handle.fileno())
        try:
            os.chmod(temp_name, 0o600)
        except OSError:
            pass
        os.replace(temp_name, path)
    finally:
        if os.path.exists(temp_name):
            os.unlink(temp_name)


def load_stored_session(path: Path) -> ParsedSession | None:
    if not path.exists():
        return None
    try:
        decoded = json.loads(path.read_text(encoding="utf-8"))
        format_detected, items = _parse_json(decoded)
        normalized = tuple(_normalize_item(item) for item in items)
    except (OSError, json.JSONDecodeError, SessionInputError):
        return None
    names = {cookie.name for cookie in normalized}
    present = tuple(name for name in CRITICAL_COOKIE_NAMES if name in names)
    missing = tuple(name for name in CRITICAL_COOKIE_NAMES if name not in names)
    return ParsedSession(format_detected, normalized, present, missing)


def delete_stored_session(path: Path) -> None:
    try:
        path.unlink()
    except FileNotFoundError:
        return


def _cookie_header(cookies: Iterable[NormalizedCookie]) -> str:
    return "; ".join(f"{cookie.name}={cookie.value}" for cookie in cookies)


def probe_google_location_sharing(
    parsed: ParsedSession,
    url: str,
    opener: Callable[..., object] = urllib.request.urlopen,
    timeout: float = 12.0,
) -> SessionHealth:
    if parsed.critical_missing:
        return SessionHealth("INCOMPLETE", "SHARED_UNCONFIGURED", False, "La sesión está incompleta.")
    request = urllib.request.Request(
        url,
        headers={
            "Cookie": _cookie_header(parsed.cookies),
            "User-Agent": "Mozilla/5.0 STRACKER-session-health",
            "Accept": "application/json,text/plain,*/*",
            "Cache-Control": "no-cache",
        },
        method="GET",
    )
    try:
        response = opener(request, timeout=timeout)
        status = int(getattr(response, "status", 200))
        body = response.read(2 * 1024 * 1024).decode("utf-8", errors="replace")
    except urllib.error.HTTPError as exc:
        if exc.code in (401, 403):
            return SessionHealth("EXPIRED", "SHARED_EXPIRED", False, "La sesión venció o fue revocada.")
        if 500 <= exc.code <= 599:
            return SessionHealth("UPSTREAM_UNAVAILABLE", "SHARED_ERROR", False, "Google no responde temporalmente.")
        return SessionHealth("INVALID", "SHARED_ERROR", False, "Google rechazó la sesión.")
    except (urllib.error.URLError, TimeoutError, OSError):
        return SessionHealth("UPSTREAM_UNAVAILABLE", "SHARED_ERROR", False, "Google no responde temporalmente.")

    if status in (401, 403):
        return SessionHealth("EXPIRED", "SHARED_EXPIRED", False, "La sesión venció o fue revocada.")
    if status >= 500:
        return SessionHealth("UPSTREAM_UNAVAILABLE", "SHARED_ERROR", False, "Google no responde temporalmente.")
    if status != 200:
        return SessionHealth("INVALID", "SHARED_ERROR", False, "Google rechazó la sesión.")
    if _COORDINATE_PATTERN.search(body):
        return SessionHealth("VALID", "SHARED_READY", True, "Sesión válida — ubicación disponible.", True)
    lowered = body.lower()
    if "locationsharing" in lowered or "location sharing" in lowered or body.startswith(")]}'"):
        return SessionHealth("NO_LOCATION_SHARED", "SHARED_NO_LOCATION", True, "Sesión válida — sin ubicación activa.")
    return SessionHealth("UNSUPPORTED_RESPONSE", "SHARED_ERROR", False, "Google devolvió un formato no reconocido.")


def session_public_status(path: Path, url: str) -> dict:
    parsed = load_stored_session(path)
    if parsed is None:
        return {
            "appAuthenticated": True,
            "state": "SHARED_UNCONFIGURED",
            "health": "UNCONFIGURED",
            "configured": False,
            "formatDetected": None,
            "count": 0,
            "criticalPresent": [],
            "criticalMissing": list(CRITICAL_COOKIE_NAMES),
            "message": "No hay una sesión vinculada.",
        }
    health = probe_google_location_sharing(parsed, url)
    return {"appAuthenticated": True, **parsed.public_summary(), **health.public_summary()}
