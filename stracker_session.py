"""Canonical mobile session contract for STRACKER.

Cookie values never leave this module in public summaries. Google session material is
stored as an AES-GCM encrypted backend-only bundle. The browser receives only an
independent, signed application-session cookie.
"""

from __future__ import annotations

import base64
import hashlib
import hmac
import json
import os
import re
import secrets
import time
import urllib.error
import urllib.request
from dataclasses import dataclass
from enum import Enum
from pathlib import Path
from typing import Any, Callable, Iterable, Mapping

from cryptography.hazmat.primitives.ciphers.aead import AESGCM


class SessionState(str, Enum):
    UNCONFIGURED = "UNCONFIGURED"
    IMPORTING = "IMPORTING"
    VALIDATING = "VALIDATING"
    READY = "READY"
    STALE = "STALE"
    EXPIRED = "EXPIRED"
    NO_LOCATION = "NO_LOCATION"
    ERROR = "ERROR"


UNLOCKED_SESSION_STATES = {
    SessionState.READY,
    SessionState.STALE,
    SessionState.NO_LOCATION,
}


class CookieFormat(str, Enum):
    COOKIE_EDITOR_JSON = "COOKIE_EDITOR_JSON"
    WRAPPED_JSON = "WRAPPED_JSON"
    COOKIE_HEADER = "COOKIE_HEADER_STRING"
    NETSCAPE = "NETSCAPE"


class SessionContractError(ValueError):
    def __init__(self, code: str, message: str, action: str, *, status: int = 400):
        super().__init__(message)
        self.code = code
        self.message = message
        self.action = action
        self.status = status

    def to_public(self) -> dict[str, Any]:
        return {
            "status": "error",
            "code": self.code,
            "message": self.message,
            "action": self.action,
        }


CRITICAL_COOKIE_NAMES = (
    "SID",
    "HSID",
    "SSID",
    "APISID",
    "SAPISID",
    "__Secure-1PSID",
    "__Secure-3PSID",
)

_BASE_REQUIRED = {"SID", "HSID", "SSID", "APISID", "SAPISID"}
_SECURE_ALTERNATIVES = {"__Secure-1PSID", "__Secure-3PSID"}
_ALLOWED_DOMAIN_RE = re.compile(r"^(?:[a-z0-9-]+\.)*google\.com$", re.IGNORECASE)
_COOKIE_NAME_RE = re.compile(r"^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$")
_APP_COOKIE_NAME = "stracker_app_session"
_BUNDLE_AAD = b"stracker-google-session-v1"
_APP_SESSION_AAD = b"stracker-app-session-v1"


@dataclass(frozen=True)
class ParsedCookieSession:
    cookies: tuple[dict[str, Any], ...]
    format: CookieFormat
    critical_present: tuple[str, ...]
    critical_missing: tuple[str, ...]

    @property
    def count(self) -> int:
        return len(self.cookies)

    @property
    def has_required_critical(self) -> bool:
        names = set(self.critical_present)
        return _BASE_REQUIRED.issubset(names) and bool(names & _SECURE_ALTERNATIVES)

    def public_summary(self) -> dict[str, Any]:
        return {
            "format": self.format.value,
            "cookie_count": self.count,
            "critical_present": list(self.critical_present),
            "critical_missing": list(self.critical_missing),
            "critical_complete": self.has_required_critical,
        }


@dataclass(frozen=True)
class ProbeResult:
    state: SessionState
    code: str
    message: str
    action: str
    location: dict[str, float] | None = None

    def public_payload(self) -> dict[str, Any]:
        payload: dict[str, Any] = {
            "state": self.state.value,
            "code": self.code,
            "message": self.message,
            "action": self.action,
        }
        if self.location is not None:
            payload["location_available"] = True
        else:
            payload["location_available"] = False
        return payload


@dataclass(frozen=True)
class ApplicationSession:
    subject: str
    issued_at: int
    expires_at: int


def _safe_domain(value: Any) -> str:
    domain = str(value or ".google.com").strip().lower().lstrip(".")
    if not domain or not _ALLOWED_DOMAIN_RE.fullmatch(domain):
        raise SessionContractError(
            "DOMAIN_NOT_ALLOWED",
            "La sesión contiene cookies de un dominio no permitido.",
            "Exportá únicamente las cookies autorizadas de Google Maps y volvé a intentar.",
        )
    return "." + domain


def _normalize_cookie(raw: Mapping[str, Any]) -> dict[str, Any]:
    name = str(raw.get("name") or "").strip()
    value = raw.get("value")
    if not name or not _COOKIE_NAME_RE.fullmatch(name):
        raise SessionContractError(
            "INVALID_COOKIE",
            "La sesión contiene una cookie inválida.",
            "Generá una exportación nueva y evitá editar manualmente los nombres.",
        )
    if value is None or not isinstance(value, (str, int, float, bool)):
        raise SessionContractError(
            "INVALID_COOKIE",
            "La sesión contiene una cookie sin valor utilizable.",
            "Generá una exportación nueva desde Cookie Editor o copiá el Header completo.",
        )
    normalized: dict[str, Any] = {
        "name": name,
        "value": str(value),
        "domain": _safe_domain(raw.get("domain")),
        "path": str(raw.get("path") or "/"),
        "secure": bool(raw.get("secure", True)),
        "httpOnly": bool(raw.get("httpOnly", raw.get("http_only", False))),
    }
    expiry = raw.get("expirationDate", raw.get("expires"))
    if expiry not in (None, "", 0, "0"):
        try:
            normalized["expirationDate"] = float(expiry)
        except (TypeError, ValueError):
            raise SessionContractError(
                "INVALID_COOKIE",
                "La sesión contiene una fecha de expiración inválida.",
                "Generá una exportación nueva sin modificar el archivo.",
            )
    return normalized


def _deduplicate(cookies: Iterable[dict[str, Any]]) -> tuple[dict[str, Any], ...]:
    dedup: dict[tuple[str, str, str], dict[str, Any]] = {}
    for cookie in cookies:
        key = (cookie["name"], cookie["domain"], cookie["path"])
        dedup[key] = cookie
    return tuple(dedup.values())


def _parse_json_value(value: Any, *, wrapped: bool = False) -> tuple[list[Mapping[str, Any]], CookieFormat]:
    if isinstance(value, list):
        return value, CookieFormat.WRAPPED_JSON if wrapped else CookieFormat.COOKIE_EDITOR_JSON
    if isinstance(value, dict) and "data" in value:
        inner = value.get("data")
        if isinstance(inner, str):
            try:
                inner = json.loads(inner)
            except json.JSONDecodeError as exc:
                raise SessionContractError(
                    "FORMAT_NOT_RECOGNIZED",
                    "El JSON envuelto contiene datos que no se pueden interpretar.",
                    "Volvé a copiar la exportación completa y reintentá.",
                ) from exc
        return _parse_json_value(inner, wrapped=True)
    raise SessionContractError(
        "FORMAT_NOT_RECOGNIZED",
        "Formato no reconocido.",
        "Usá Cookie Editor JSON, JSON envuelto, Cookie Header String o Netscape.",
    )


def _parse_netscape(text: str) -> list[Mapping[str, Any]]:
    rows: list[Mapping[str, Any]] = []
    for raw_line in text.splitlines():
        line = raw_line.strip("\r\n")
        if not line or line.startswith("#"):
            continue
        parts = line.split("\t")
        if len(parts) < 7:
            raise SessionContractError(
                "FORMAT_NOT_RECOGNIZED",
                "El archivo Netscape está incompleto.",
                "Exportá nuevamente el archivo de cookies en formato Netscape.",
            )
        domain, _include_subdomains, path, secure, expires, name = parts[:6]
        value = "\t".join(parts[6:])
        rows.append(
            {
                "domain": domain,
                "path": path or "/",
                "secure": secure.upper() == "TRUE",
                "expires": expires,
                "name": name,
                "value": value,
            }
        )
    if not rows:
        raise SessionContractError(
            "FORMAT_NOT_RECOGNIZED",
            "El archivo Netscape no contiene cookies.",
            "Exportá nuevamente la sesión y volvé a intentar.",
        )
    return rows


def _parse_cookie_header(text: str) -> list[Mapping[str, Any]]:
    rows: list[Mapping[str, Any]] = []
    for part in text.split(";"):
        segment = part.strip()
        if not segment:
            continue
        if "=" not in segment:
            raise SessionContractError(
                "FORMAT_NOT_RECOGNIZED",
                "El Header de cookies está incompleto.",
                "Copiá el contenido completo del encabezado Cookie, sin incluir la palabra Cookie:.",
            )
        name, value = segment.split("=", 1)
        rows.append({"name": name.strip(), "value": value, "domain": ".google.com", "path": "/"})
    if not rows:
        raise SessionContractError(
            "FORMAT_NOT_RECOGNIZED",
            "El Header no contiene cookies.",
            "Copiá el contenido completo del encabezado Cookie.",
        )
    return rows


def parse_cookie_session(payload: Any) -> ParsedCookieSession:
    value = payload
    detected_format: CookieFormat
    raw_rows: list[Mapping[str, Any]]

    if isinstance(value, bytes):
        value = value.decode("utf-8", errors="strict")
    if isinstance(value, str):
        text = value.strip()
        if not text:
            raise SessionContractError(
                "FORMAT_NOT_RECOGNIZED",
                "No se recibió ninguna sesión.",
                "Pegá una exportación válida y volvé a intentar.",
            )
        if text.lower().startswith("cookie:"):
            text = text.split(":", 1)[1].strip()
        if text.startswith("[") or text.startswith("{"):
            try:
                decoded = json.loads(text)
            except json.JSONDecodeError as exc:
                raise SessionContractError(
                    "FORMAT_NOT_RECOGNIZED",
                    "El JSON no es válido.",
                    "Volvé a copiar la exportación completa y reintentá.",
                ) from exc
            raw_rows, detected_format = _parse_json_value(decoded)
        elif "\t" in text and ("# Netscape HTTP Cookie File" in text or len(text.split("\t")) >= 7):
            raw_rows = _parse_netscape(text)
            detected_format = CookieFormat.NETSCAPE
        else:
            raw_rows = _parse_cookie_header(text)
            detected_format = CookieFormat.COOKIE_HEADER
    else:
        raw_rows, detected_format = _parse_json_value(value)

    normalized = _deduplicate(_normalize_cookie(row) for row in raw_rows)
    names = {cookie["name"] for cookie in normalized}
    present = tuple(name for name in CRITICAL_COOKIE_NAMES if name in names)
    missing = tuple(name for name in CRITICAL_COOKIE_NAMES if name not in names)
    parsed = ParsedCookieSession(normalized, detected_format, present, missing)
    if not parsed.has_required_critical:
        raise SessionContractError(
            "COOKIES_INCOMPLETE",
            "Cookies incompletas.",
            "Volvé a exportar la sesión de Google Maps e incluí todas las cookies del dominio google.com.",
        )
    now = time.time()
    expired = [
        cookie["name"]
        for cookie in normalized
        if cookie.get("expirationDate") is not None and float(cookie["expirationDate"]) <= now
    ]
    if expired:
        raise SessionContractError(
            "SESSION_EXPIRED",
            "La sesión contiene cookies vencidas.",
            "Reemplazá la sesión con una exportación reciente.",
        )
    return parsed


def cookie_header(cookies: Iterable[Mapping[str, Any]]) -> str:
    return "; ".join(f"{cookie['name']}={cookie['value']}" for cookie in cookies)


def _derive_bundle_key(secret_key: str) -> bytes:
    if len(secret_key.strip()) < 32:
        raise SessionContractError(
            "SECURE_STORAGE_UNAVAILABLE",
            "El almacenamiento seguro no está configurado.",
            "Configurá SECRET_KEY antes de importar una sesión.",
            status=503,
        )
    return hashlib.sha256(("google-session:" + secret_key).encode("utf-8")).digest()


def store_encrypted_session(
    path: Path,
    secret_key: str,
    parsed: ParsedCookieSession,
    probe: ProbeResult,
) -> None:
    envelope = {
        "version": 1,
        "stored_at": int(time.time()),
        "state": probe.state.value,
        "validation_code": probe.code,
        "validated_at": int(time.time()),
        "format": parsed.format.value,
        "critical_present": list(parsed.critical_present),
        "critical_missing": list(parsed.critical_missing),
        "cookies": list(parsed.cookies),
    }
    plaintext = json.dumps(envelope, separators=(",", ":"), ensure_ascii=False).encode("utf-8")
    nonce = secrets.token_bytes(12)
    ciphertext = AESGCM(_derive_bundle_key(secret_key)).encrypt(nonce, plaintext, _BUNDLE_AAD)
    encoded = base64.urlsafe_b64encode(nonce + ciphertext)
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_suffix(path.suffix + ".tmp")
    temporary.write_bytes(encoded)
    try:
        os.chmod(temporary, 0o600)
    except OSError:
        pass
    temporary.replace(path)


def load_encrypted_session(path: Path, secret_key: str) -> dict[str, Any] | None:
    if not path.exists():
        return None
    try:
        combined = base64.urlsafe_b64decode(path.read_bytes())
        if len(combined) < 29:
            raise ValueError("invalid encrypted bundle")
        nonce, ciphertext = combined[:12], combined[12:]
        plaintext = AESGCM(_derive_bundle_key(secret_key)).decrypt(nonce, ciphertext, _BUNDLE_AAD)
        data = json.loads(plaintext.decode("utf-8"))
        if not isinstance(data, dict) or not isinstance(data.get("cookies"), list):
            raise ValueError("invalid session contract")
        return data
    except SessionContractError:
        raise
    except Exception as exc:
        raise SessionContractError(
            "SESSION_STORAGE_CORRUPT",
            "La sesión almacenada no se puede leer de forma segura.",
            "Borrá y reemplazá la sesión autorizada.",
            status=503,
        ) from exc


def clear_encrypted_session(path: Path) -> None:
    try:
        path.unlink(missing_ok=True)
    except OSError as exc:
        raise SessionContractError(
            "SESSION_CLEAR_FAILED",
            "No se pudo borrar la sesión de forma segura.",
            "Reintentá o revisá los permisos del almacenamiento backend.",
            status=503,
        ) from exc


def public_session_status(bundle: Mapping[str, Any] | None, *, last_update_epoch: float | None = None) -> dict[str, Any]:
    if not bundle:
        return {
            "state": SessionState.UNCONFIGURED.value,
            "map_unlocked": False,
            "configured": False,
            "cookie_count": 0,
            "critical_present": [],
            "critical_missing": list(CRITICAL_COOKIE_NAMES),
        }
    try:
        state = SessionState(str(bundle.get("state", SessionState.ERROR.value)))
    except ValueError:
        state = SessionState.ERROR
    if state is SessionState.READY and last_update_epoch is not None:
        age = max(0, time.time() - last_update_epoch)
        if age > 300:
            state = SessionState.STALE
    cookies = bundle.get("cookies") if isinstance(bundle.get("cookies"), list) else []
    return {
        "state": state.value,
        "map_unlocked": state in UNLOCKED_SESSION_STATES,
        "configured": True,
        "format": bundle.get("format"),
        "cookie_count": len(cookies),
        "critical_present": list(bundle.get("critical_present") or []),
        "critical_missing": list(bundle.get("critical_missing") or []),
        "validated_at": bundle.get("validated_at"),
        "validation_code": bundle.get("validation_code"),
    }


def _extract_coordinates(text: str) -> dict[str, float] | None:
    patterns = (
        re.compile(r"\[null,(-?\d+\.\d+),(-?\d+\.\d+)\]"),
        re.compile(r"\[null,\[(-?\d+\.\d+),(-?\d+\.\d+)\]\]"),
    )
    for pattern in patterns:
        match = pattern.search(text)
        if not match:
            continue
        longitude, latitude = float(match.group(1)), float(match.group(2))
        if -90 <= latitude <= 90 and -180 <= longitude <= 180:
            return {"lat": latitude, "lng": longitude}
    return None


def probe_google_session(
    parsed: ParsedCookieSession,
    rpc_url: str,
    *,
    timeout: float = 15,
    opener: Callable[..., Any] = urllib.request.urlopen,
) -> ProbeResult:
    request = urllib.request.Request(
        rpc_url,
        headers={
            "Cookie": cookie_header(parsed.cookies),
            "User-Agent": "Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 Chrome/124 Mobile Safari/537.36",
            "Referer": "https://www.google.com/maps",
            "X-Goog-AuthUser": "0",
            "Accept": "application/json,text/plain,*/*",
        },
    )
    try:
        with opener(request, timeout=timeout) as response:
            status = int(getattr(response, "status", 200) or 200)
            body = response.read().decode("utf-8", errors="ignore")
    except urllib.error.HTTPError as exc:
        if exc.code in (401, 403):
            return ProbeResult(
                SessionState.EXPIRED,
                "SESSION_EXPIRED",
                "Sesión vencida.",
                "Exportá una sesión nueva desde Google Maps.",
            )
        return ProbeResult(
            SessionState.ERROR,
            "UPSTREAM_UNAVAILABLE",
            "Servicio temporalmente no disponible.",
            "Esperá unos minutos y reintentá sin reemplazar la sesión.",
        )
    except (urllib.error.URLError, TimeoutError, OSError):
        return ProbeResult(
            SessionState.ERROR,
            "UPSTREAM_UNAVAILABLE",
            "Servicio temporalmente no disponible.",
            "Revisá la conexión del servidor y reintentá.",
        )

    if status in (401, 403) or "accounts.google.com/ServiceLogin" in body or "signin/v2" in body:
        return ProbeResult(
            SessionState.EXPIRED,
            "SESSION_EXPIRED",
            "Sesión vencida.",
            "Exportá una sesión nueva desde Google Maps.",
        )
    if status >= 500:
        return ProbeResult(
            SessionState.ERROR,
            "UPSTREAM_UNAVAILABLE",
            "Servicio temporalmente no disponible.",
            "Esperá unos minutos y reintentá.",
        )
    location = _extract_coordinates(body)
    if location is not None:
        return ProbeResult(
            SessionState.READY,
            "SESSION_VALID",
            "Sesión validada.",
            "El mapa ya puede usar la ubicación autorizada.",
            location,
        )
    cleaned = re.sub(r"^\)\]\}'\s*\n?", "", body).lstrip()
    if cleaned.startswith("[null,null") or status == 200:
        return ProbeResult(
            SessionState.NO_LOCATION,
            "GOOGLE_NO_LOCATION",
            "Google no devuelve una ubicación compartida activa.",
            "Confirmá que la ubicación compartida esté habilitada y reintentá.",
        )
    return ProbeResult(
        SessionState.ERROR,
        "INVALID_UPSTREAM_PAYLOAD",
        "Google devolvió una respuesta que no cumple el contrato esperado.",
        "Reintentá más tarde o reemplazá la sesión si el problema continúa.",
    )


def _b64url_encode(value: bytes) -> str:
    return base64.urlsafe_b64encode(value).rstrip(b"=").decode("ascii")


def _b64url_decode(value: str) -> bytes:
    padding = "=" * (-len(value) % 4)
    return base64.urlsafe_b64decode((value + padding).encode("ascii"))


def issue_application_session(secret_key: str, subject: str, *, ttl_seconds: int = 43200) -> str:
    now = int(time.time())
    payload = {
        "sub": hashlib.sha256(subject.encode("utf-8")).hexdigest(),
        "iat": now,
        "exp": now + max(300, min(ttl_seconds, 86400)),
        "nonce": secrets.token_urlsafe(18),
    }
    encoded = _b64url_encode(json.dumps(payload, separators=(",", ":")).encode("utf-8"))
    signature = hmac.new(secret_key.encode("utf-8"), _APP_SESSION_AAD + encoded.encode("ascii"), hashlib.sha256).digest()
    return encoded + "." + _b64url_encode(signature)


def verify_application_session(token: str, secret_key: str, *, now: int | None = None) -> ApplicationSession | None:
    try:
        encoded, supplied_signature = token.split(".", 1)
        expected = hmac.new(secret_key.encode("utf-8"), _APP_SESSION_AAD + encoded.encode("ascii"), hashlib.sha256).digest()
        supplied = _b64url_decode(supplied_signature)
        if not hmac.compare_digest(supplied, expected):
            return None
        payload = json.loads(_b64url_decode(encoded).decode("utf-8"))
        current = int(time.time()) if now is None else now
        issued = int(payload["iat"])
        expires = int(payload["exp"])
        if issued > current + 60 or expires <= current or expires - issued > 86400:
            return None
        return ApplicationSession(str(payload["sub"]), issued, expires)
    except (ValueError, KeyError, TypeError, json.JSONDecodeError):
        return None


def application_session_from_headers(headers: Mapping[str, Any], secret_key: str) -> ApplicationSession | None:
    raw_cookie = str(headers.get("Cookie", "") or "")
    for segment in raw_cookie.split(";"):
        if "=" not in segment:
            continue
        name, value = segment.strip().split("=", 1)
        if name == _APP_COOKIE_NAME:
            return verify_application_session(value, secret_key)
    return None


def application_cookie_header(token: str, *, production: bool, max_age: int = 43200) -> str:
    attributes = [
        f"{_APP_COOKIE_NAME}={token}",
        "Path=/",
        "HttpOnly",
        "SameSite=Strict",
        f"Max-Age={max_age}",
    ]
    if production:
        attributes.append("Secure")
    return "; ".join(attributes)


def expired_application_cookie_header(*, production: bool) -> str:
    attributes = [
        f"{_APP_COOKIE_NAME}=",
        "Path=/",
        "HttpOnly",
        "SameSite=Strict",
        "Max-Age=0",
    ]
    if production:
        attributes.append("Secure")
    return "; ".join(attributes)
