#!/usr/bin/env python3
"""One-shot branch builder for STRACKER P0 security containment.

This script is executed only by the branch-scoped GitHub Actions workflow. It
never contacts production and never prints secret values. It removes itself
before the final implementation commit.
"""

from __future__ import annotations

import hashlib
import json
import os
import re
import subprocess
import textwrap
from collections import defaultdict
from pathlib import Path

BASE_SHA = "923cac9c9bcc0b7e05701dd1018e61a454d0f478"
BRANCH = "fix/stracker-p0-security-canonical-state"
ROOT = Path(__file__).resolve().parents[1]


def run(*args: str, check: bool = True) -> str:
    result = subprocess.run(
        args,
        cwd=ROOT,
        text=True,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        check=False,
    )
    if check and result.returncode != 0:
        raise RuntimeError(f"command failed ({result.returncode}): {' '.join(args)}")
    return result.stdout.strip()


def replace_once(text: str, old: str, new: str, label: str) -> str:
    count = text.count(old)
    if count != 1:
        raise RuntimeError(f"{label}: expected exactly one match, found {count}")
    return text.replace(old, new, 1)


def sha256(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def write(path: str, content: str) -> None:
    target = ROOT / path
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_text(content.rstrip() + "\n", encoding="utf-8")


def build_security_module() -> str:
    return textwrap.dedent(
        '''
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
            decoded = unquote((path or "/").split("?", 1)[0]).replace("\\\\", "/")
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
        '''
    )


def build_tests() -> str:
    return textwrap.dedent(
        '''
        from __future__ import annotations

        import http.client
        import json
        import os
        import tempfile
        import threading
        import unittest
        from contextlib import contextmanager
        from http.server import ThreadingHTTPServer
        from pathlib import Path

        import stracker_security
        import tracker_map


        TOKEN = "test-service-token-" + ("x" * 40)
        SECRET = "test-secret-key-" + ("s" * 48)


        def request(port: int, method: str, path: str, headers=None, body: bytes | None = None):
            connection = http.client.HTTPConnection("127.0.0.1", port, timeout=5)
            connection.request(method, path, body=body, headers=headers or {})
            response = connection.getresponse()
            payload = response.read()
            status = response.status
            response_headers = dict(response.getheaders())
            connection.close()
            return status, response_headers, payload


        @contextmanager
        def running_server():
            with tempfile.TemporaryDirectory() as temp_dir:
                base = Path(temp_dir)
                (base / "nextjs-ui" / "_next" / "static" / "chunks").mkdir(parents=True)
                (base / "nextjs-ui" / "index.html").write_text("<html>safe-root</html>", encoding="utf-8")
                (base / "nextjs-ui" / "_next" / "static" / "chunks" / "app.js").write_text("safe-asset", encoding="utf-8")
                (base / "README.md").write_text("must-not-be-public", encoding="utf-8")
                (base / ".env").write_text("redacted", encoding="utf-8")
                (base / "cookies.json").write_text("[]", encoding="utf-8")
                (base / "historial.csv").write_text("timestamp,lat,lng\\n", encoding="utf-8")
                (base / "tracker.log").write_text("private", encoding="utf-8")
                (base / "ghostrail.enc").write_text("{}", encoding="utf-8")
                (base / "ghostrail_archive.enc").write_text("{}", encoding="utf-8")
                (base / "tool-results").mkdir()
                (base / "tool-results" / "dump.txt").write_text("private", encoding="utf-8")
                (base / "public").mkdir()
                (base / "public" / "gemini-analysis-input.json").write_text("{}", encoding="utf-8")

                original = {
                    "BASE_DIR": tracker_map.BASE_DIR,
                    "COOKIES_PATH": tracker_map.COOKIES_PATH,
                    "CSV_PATH": tracker_map.CSV_PATH,
                    "HTML_PATH": tracker_map.HTML_PATH,
                    "LOG_PATH": tracker_map.LOG_PATH,
                    "GHOSTRAIL_ENC_PATH": tracker_map.GHOSTRAIL_ENC_PATH,
                    "GHOSTRAIL_ARCHIVE_PATH": tracker_map.GHOSTRAIL_ARCHIVE_PATH,
                }
                tracker_map.BASE_DIR = base
                tracker_map.COOKIES_PATH = base / "cookies.json"
                tracker_map.CSV_PATH = base / "historial.csv"
                tracker_map.HTML_PATH = base / "mapa.html"
                tracker_map.LOG_PATH = base / "tracker.log"
                tracker_map.GHOSTRAIL_ENC_PATH = base / "ghostrail.enc"
                tracker_map.GHOSTRAIL_ARCHIVE_PATH = base / "ghostrail_archive.enc"
                tracker_map._PREV_STATE = None

                server = ThreadingHTTPServer(("127.0.0.1", 0), tracker_map.TrackerHandler)
                thread = threading.Thread(target=server.serve_forever, daemon=True)
                thread.start()
                try:
                    yield server.server_address[1]
                finally:
                    server.shutdown()
                    server.server_close()
                    thread.join(timeout=5)
                    for name, value in original.items():
                        setattr(tracker_map, name, value)


        class SecurityBoundaryTests(unittest.TestCase):
            def setUp(self):
                self.old_env = dict(os.environ)
                os.environ["STRACKER_ENV"] = "test"
                os.environ["STRACKER_API_TOKEN"] = TOKEN
                os.environ["SECRET_KEY"] = SECRET

            def tearDown(self):
                os.environ.clear()
                os.environ.update(self.old_env)

            def auth_headers(self):
                return {"Authorization": f"Bearer {TOKEN}"}

            def test_sensitive_files_are_not_served(self):
                paths = [
                    "/.env",
                    "/.env.production",
                    "/cookies.json",
                    "/cookies.json.bak",
                    "/historial.csv",
                    "/tracker.log",
                    "/other.log",
                    "/ghostrail.enc",
                    "/ghostrail_archive.enc",
                    "/playwright_profile/state.json",
                    "/.git/config",
                    "/.github/workflows/test.yml",
                    "/tool-results/dump.txt",
                    "/public/gemini-analysis-input.json",
                    "/nextjs-ui/gemini-analysis-input.json",
                    "/README.md",
                ]
                with running_server() as port:
                    for path in paths:
                        with self.subTest(path=path):
                            status, _, _ = request(port, "GET", path, headers=self.auth_headers())
                            self.assertIn(status, (403, 404))

            def test_public_root_and_static_asset_remain_available(self):
                with running_server() as port:
                    status, _, payload = request(port, "GET", "/")
                    self.assertEqual(status, 200)
                    self.assertIn(b"safe-root", payload)
                    status, _, payload = request(port, "GET", "/_next/static/chunks/app.js")
                    self.assertEqual(status, 200)
                    self.assertEqual(payload, b"safe-asset")

            def test_sensitive_endpoint_requires_valid_server_token(self):
                with running_server() as port:
                    status, _, _ = request(port, "GET", "/points")
                    self.assertEqual(status, 401)
                    status, _, _ = request(port, "GET", "/points", headers={"Authorization": "Bearer wrong-token"})
                    self.assertEqual(status, 401)
                    status, _, payload = request(port, "GET", "/points", headers=self.auth_headers())
                    self.assertEqual(status, 200)
                    parsed = json.loads(payload)
                    self.assertEqual(parsed["points"], [])

            def test_service_token_header_is_supported_for_future_gateway(self):
                with running_server() as port:
                    status, _, _ = request(port, "GET", "/predict", headers={"X-Stracker-Service-Token": TOKEN})
                    self.assertEqual(status, 200)

            def test_unconfigured_auth_fails_closed(self):
                os.environ.pop("STRACKER_API_TOKEN", None)
                with running_server() as port:
                    status, _, payload = request(port, "GET", "/points")
                    self.assertEqual(status, 503)
                    self.assertNotIn(b"STRACKER_API_TOKEN", payload)

            def test_health_is_public_and_sanitized(self):
                with running_server() as port:
                    status, _, payload = request(port, "GET", "/health")
                    self.assertEqual(status, 200)
                    parsed = json.loads(payload)
                    self.assertEqual(set(parsed), {"status", "version", "timestamp"})
                    serialized = payload.decode("utf-8")
                    for forbidden in ("base_dir", "points", "secret", "ghostrail", "archive", "csv_exists"):
                        self.assertNotIn(forbidden, serialized.lower())

            def test_encrypted_endpoint_omits_records(self):
                with running_server() as port:
                    status, _, payload = request(port, "GET", "/ghostrail/encrypted", headers=self.auth_headers())
                    self.assertEqual(status, 200)
                    parsed = json.loads(payload)
                    self.assertNotIn("records", parsed)
                    self.assertNotIn("sample_record_prefix", parsed)
                    self.assertNotIn("secret_key_configured", parsed)

            def test_secret_key_is_fail_closed(self):
                os.environ["STRACKER_ENV"] = "production"
                os.environ.pop("SECRET_KEY", None)
                with self.assertRaises(stracker_security.SecurityConfigurationError):
                    stracker_security.validate_startup_security(aesgcm_available=True)
                with self.assertRaises(stracker_security.SecurityConfigurationError):
                    tracker_map._derive_aes_key()

            def test_explicit_test_key_enables_encryption(self):
                os.environ["STRACKER_ENV"] = "test"
                key = tracker_map._derive_aes_key()
                self.assertEqual(len(key), 32)
                encrypted = tracker_map.encrypt_record('{"safe":"test"}')
                self.assertTrue(encrypted)
                self.assertEqual(tracker_map.decrypt_record(encrypted), '{"safe":"test"}')


        if __name__ == "__main__":
            unittest.main()
        '''
    )


def patch_tracker(source: str) -> str:
    source = replace_once(
        source,
        "from pathlib import Path\n",
        "from pathlib import Path\n\nfrom stracker_security import (\n    SecurityConfigurationError,\n    authorize_request_headers,\n    get_secret_key,\n    is_blocked_static_path,\n    is_protected_path,\n    is_public_asset_path,\n    runtime_mode,\n    validate_startup_security,\n)\n",
        "security imports",
    )
    source = replace_once(
        source,
        '# Load SECRET_KEY from env (30-day rotation enforced via Render dashboard).\n# Fallback to a deterministic dev key (clearly marked, never used in prod).\nSECRET_KEY = os.environ.get("SECRET_KEY", "v5.8-dev-fallback-key-DO-NOT-USE-IN-PROD")\n',
        '# SECRET_KEY is resolved lazily by stracker_security.get_secret_key().\n# There is intentionally no embedded fallback in any runtime mode.\n',
        "remove secret fallback",
    )
    source = replace_once(
        source,
        'def _derive_aes_key() -> bytes:\n    """Derive a 32-byte (256-bit) AES key from SECRET_KEY via SHA-256."""\n    import hashlib\n    return hashlib.sha256(SECRET_KEY.encode("utf-8")).digest()\n',
        'def _derive_aes_key() -> bytes:\n    """Derive a 32-byte AES key from an explicitly configured SECRET_KEY."""\n    import hashlib\n    return hashlib.sha256(get_secret_key().encode("utf-8")).digest()\n',
        "derive key fail closed",
    )
    source = replace_once(
        source,
        '    except Exception as e:\n        logger.error("encrypt_record failed: %s", e)\n        return ""\n\n\ndef decrypt_record',
        '    except SecurityConfigurationError:\n        raise\n    except Exception as e:\n        logger.error("encrypt_record failed: %s", e)\n        return ""\n\n\ndef decrypt_record',
        "encrypt error handling",
    )
    source = replace_once(
        source,
        '    except Exception as e:\n        logger.error("decrypt_record failed: %s", e)\n        return ""\n\n\ndef write_encrypted_ghostrail',
        '    except SecurityConfigurationError:\n        raise\n    except Exception as e:\n        logger.error("decrypt_record failed: %s", e)\n        return ""\n\n\ndef write_encrypted_ghostrail',
        "decrypt error handling",
    )
    source = replace_once(
        source,
        '    except Exception as e:\n        logger.error("write_encrypted_ghostrail failed: %s", e)\n\n\ndef read_encrypted_ghostrail',
        '    except SecurityConfigurationError:\n        raise\n    except Exception as e:\n        logger.error("write_encrypted_ghostrail failed: %s", e)\n\n\ndef read_encrypted_ghostrail',
        "encrypted write fail closed",
    )
    source = replace_once(
        source,
        '    def log_message(self, fmt, *args):\n        logger.info("HTTP %s - %s", self.client_address[0], fmt % args)\n\n',
        '''    def log_message(self, fmt, *args):
        logger.info("HTTP %s - %s", self.client_address[0], fmt % args)

    def _send_not_found(self):
        self._send_json({"status": "error", "error": "not_found"}, status=404)

    def _require_authorization(self, path: str) -> bool:
        decision = authorize_request_headers(self.headers)
        if decision.allowed:
            return True
        error = "service_unavailable" if decision.status == 503 else "unauthorized"
        self._send_json({"status": "error", "error": error}, status=decision.status)
        return False

''',
        "handler auth helpers",
    )
    source = source.replace(
        '"Content-Type, Authorization, X-Session-Token, X-Request-Id",',
        '"Content-Type, Authorization, X-Stracker-Service-Token, X-Session-Token, X-Request-Id",',
    )
    source = replace_once(
        source,
        '''    def do_GET(self):
        # V6.11: strip query string for route matching (RA1 pattern)
        path = self.path.split("?", 1)[0]
        if path in ("/health", "/health/", "/healthz"):
            try:
                csv_exists = CSV_PATH.exists()
                html_exists = HTML_PATH.exists()
                archive_exists = GHOSTRAIL_ARCHIVE_PATH.exists()
                point_count = 0
                if csv_exists: point_count = max(0, sum(1 for _ in open(CSV_PATH, encoding="utf-8")) - 1)
                self._send_json({"status": "ok", "uptime_s": round(time.time() - _SERVER_START_TS, 2), "base_dir": str(BASE_DIR), "html_exists": html_exists, "csv_exists": csv_exists, "archive_exists": archive_exists, "points": point_count, "version": "v6.0_final_polish", "timestamp": datetime.now(timezone.utc).isoformat(), "security": {"hsts": True, "csp": True, "x_frame_options": "DENY", "x_content_type_options": "nosniff", "cors": "strict"}, "storage": {"hot_db": "ghostrail.enc", "cold_db": "ghostrail_archive.enc", "archive_age_days": ARCHIVE_AGE_DAYS, "archive_compression": "zip"}})
            except Exception as e:
                self._send_json({"status": "error", "error": str(e)}, status=500)
            return
''',
        '''    def do_GET(self):
        # V6.11: strip query string for route matching (RA1 pattern)
        path = self.path.split("?", 1)[0]
        if is_blocked_static_path(path):
            self._send_not_found()
            return
        if is_protected_path(path) and not self._require_authorization(path):
            return
        if path in ("/health", "/health/", "/healthz"):
            self._send_json({
                "status": "ok",
                "version": "v6.0_final_polish+p0_security",
                "timestamp": datetime.now(timezone.utc).isoformat(),
            })
            return
        if path in ("/health/details", "/health/details/"):
            self._send_json({
                "status": "ok",
                "version": "v6.0_final_polish+p0_security",
                "timestamp": datetime.now(timezone.utc).isoformat(),
                "uptime_s": round(time.time() - _SERVER_START_TS, 2),
                "runtime_mode": runtime_mode().value,
            })
            return
''',
        "GET auth and health",
    )
    source = replace_once(
        source,
        '                    "records": payload.get("records", []),\n                    "_v60": {"cold_storage": True, "endpoint": "/api/archive", "hot_db": "/ghostrail/encrypted"},\n',
        '                    "records_omitted": True,\n',
        "archive response redaction",
    )
    source = replace_once(
        source,
        '''                    "encrypted_at": blob.get("encrypted_at"),
                    "aesgcm_available": _AESGCM_AVAILABLE,
                    "secret_key_configured": bool(os.environ.get("SECRET_KEY")),
                    # The actual encrypted records (base64-encoded IV || ciphertext || tag)
                    "records": blob.get("records", []),
                    # Sample of the first record (truncated for inspection)
                    "sample_record_prefix": (blob.get("records", [""])[0] or "")[:32] + "..." if blob.get("records") else None,
''',
        '''                    "encrypted_at": blob.get("encrypted_at"),
                    "records_omitted": True,
''',
        "encrypted endpoint redaction",
    )
    source = replace_once(
        source,
        '        if requested and ".." not in requested:\n',
        '        if is_public_asset_path(path) and requested and ".." not in requested:\n',
        "asset fallback allowlist",
    )
    source = replace_once(
        source,
        '        return super().do_GET()\n\n    def do_POST(self):\n        path = self.path.split("?", 1)[0]  # V6.11: strip query string\n        if path in ("/api/cookies", "/cookies"):\n            self._handle_cookies_upload(); return\n        self.send_response(404); self.end_headers()\n',
        '''        if is_public_asset_path(path):
            return super().do_GET()
        self._send_not_found()
        return

    def do_POST(self):
        path = self.path.split("?", 1)[0]  # V6.11: strip query string
        if is_blocked_static_path(path):
            self._send_not_found()
            return
        if is_protected_path(path) and not self._require_authorization(path):
            return
        if path in ("/api/cookies", "/cookies"):
            self._handle_cookies_upload(); return
        self._send_not_found()
''',
        "POST auth and unknown route closure",
    )
    source = replace_once(
        source,
        'def main():\n    setup_logging()\n    logger.info("=" * 50)\n',
        '''def main():
    setup_logging()
    try:
        validate_startup_security(_AESGCM_AVAILABLE)
    except SecurityConfigurationError as exc:
        logger.critical("Security configuration invalid; startup aborted: %s", exc)
        return 78
    logger.info("=" * 50)
''',
        "production startup fail closed",
    )
    return source


def audit_secret_history() -> dict:
    tracked = run("git", "ls-files").splitlines()
    history = run("git", "log", "--all", "--format=COMMIT:%H", "--name-only").splitlines()
    path_commits: dict[str, list[str]] = defaultdict(list)
    current_commit = ""
    for line in history:
        if line.startswith("COMMIT:"):
            current_commit = line.split(":", 1)[1]
        elif line and current_commit:
            path_commits[line].append(current_commit)

    def sensitive_path(path: str) -> bool:
        low = path.lower()
        base = Path(low).name
        return (
            base == ".env"
            or base.startswith(".env.")
            or base in {"cookies.json", "cookies.json.bak", "historial.csv", "ghostrail.enc", "ghostrail_archive.enc", "tracker.log"}
            or low.startswith("playwright_profile/")
            or low.startswith("tool-results/")
            or "gemini-analysis-input.json" in low
            or base.endswith(".log")
        )

    findings = []
    for path, commits in sorted(path_commits.items()):
        if not sensitive_path(path):
            continue
        severity = "CRITICAL" if Path(path).name in {".env", "cookies.json", "cookies.json.bak"} else "HIGH"
        likely = "unknown"
        rotation = "conditional"
        if path in tracked and (ROOT / path).is_file():
            if Path(path).name == ".env":
                raw = (ROOT / path).read_text(encoding="utf-8", errors="replace")
                assignments = []
                for row in raw.splitlines():
                    row = row.strip()
                    if not row or row.startswith("#") or "=" not in row:
                        continue
                    _, value = row.split("=", 1)
                    value = value.strip().strip('"\'')
                    assignments.append(value)
                nonempty = [v for v in assignments if v]
                placeholders = ("example", "placeholder", "changeme", "replace", "dummy", "test")
                likely = "likely_real" if any(not any(p in v.lower() for p in placeholders) for v in nonempty) else "placeholder_or_empty"
                rotation = "required_if_active" if likely == "likely_real" else "not_required"
            elif Path(path).name in {"cookies.json", "cookies.json.bak"}:
                likely = "likely_real"
                rotation = "required_if_active"
            else:
                likely = "data_or_artifact"
                rotation = "not_applicable"
        findings.append({
            "type": "sensitive_path_in_history",
            "path": path,
            "severity": severity,
            "classification": likely,
            "first_seen": commits[-1][:12],
            "last_seen": commits[0][:12],
            "commit_count": len(set(commits)),
            "rotation": rotation,
            "action": "remove from tracked tree where safe, keep ignored, and rotate active credentials outside Git",
        })

    source_checks = [
        ("hardcoded_private_coordinates", ["tracker_map.py", "src/app/api/points/route.ts"], "HIGH", "not_applicable"),
        ("location_sharing_endpoint_or_url", ["tracker_map.py", "nextjs-ui/tracker_map.py"], "CRITICAL", "required_if_active"),
        ("cookie_identifier_references", ["tracker_map.py", "src/components/tracker/CookiesBlock.tsx"], "LOW", "not_required_for_names_only"),
        ("client_generated_bearer_token", ["src/lib/auth.ts", "src/lib/api-client.ts"], "HIGH", "not_applicable"),
    ]
    for finding_type, paths, severity, rotation in source_checks:
        present = [path for path in paths if path in tracked]
        if present:
            findings.append({
                "type": finding_type,
                "path": ", ".join(present),
                "severity": severity,
                "classification": "likely_real_configuration_or_code_reference",
                "first_seen": "history_present",
                "last_seen": BASE_SHA[:12],
                "commit_count": None,
                "rotation": rotation,
                "action": "move private configuration out of source and complete manual rotation when applicable",
            })

    return {
        "base_sha": BASE_SHA,
        "tracked_file_count": len(tracked),
        "findings": findings,
    }


def render_audit(audit: dict) -> str:
    rows = []
    for item in audit["findings"]:
        rows.append(
            "| {severity} | {type} | `{path}` | {classification} | {first_seen} | {last_seen} | {rotation} | {action} |".format(**item)
        )
    return textwrap.dedent(
        f'''\
        # P0 Secret Audit — Sanitized

        `BASE_SHA={BASE_SHA}`

        This report contains paths, classifications and abbreviated commit identifiers only. Secret values, cookies, tokens, coordinates and private sharing URLs were not copied into this report.

        | Severity | Finding type | Affected path(s) | Classification | First seen | Last seen | Rotation | Recommended action |
        |---|---|---|---|---|---|---|---|
        {os.linesep.join(rows) if rows else '| INFO | No matching path-level findings | — | — | — | — | not_required | Continue monitoring |'}

        ## Interpretation

        - `likely_real` means non-empty material did not look like a documented placeholder. It was not displayed or used.
        - `required_if_active` means the operator must rotate or revoke the corresponding live credential/session outside this PR.
        - Source-level cookie names are identifiers, not cookie values; names alone do not require rotation.
        - Git history was not rewritten. Historical exposure remains an open manual remediation item.
        '''
    )


def build_docs(audit: dict, initial_hashes: dict[str, str]) -> None:
    audit_counts = defaultdict(int)
    for item in audit["findings"]:
        audit_counts[item["severity"]] += 1

    write("docs/SECURITY_AUDIT_SANITIZED.md", render_audit(audit))
    write(
        "docs/CURRENT_STATE.md",
        textwrap.dedent(
            f'''\
            # STRACKER — Current State

            ## Canonical baseline

            ```text
            BASE_SHA={BASE_SHA}
            BRANCH={BRANCH}
            WORKTREE_BASELINE=GITHUB_ACTIONS_CLEAN_CHECKOUT
            PRODUCTION_MODIFIED=NO
            DEPLOYMENT_EXECUTED=NO
            ```

            Initial SHA-256 fingerprints:

            ```text
            TRACKER_MAP_SHA256={initial_hashes['tracker_map.py']}
            STATIC_INDEX_SHA256={initial_hashes['nextjs-ui/index.html']}
            TRACKER_VIEW_SHA256={initial_hashes['src/components/tracker/TrackerView.tsx']}
            LOCKFILES=package-lock.json,bun.lock
            ```

            ## Current runtime state

            - `CURRENT_RENDER_STATE`: production remains on Render and was not modified by this branch.
            - `CURRENT_PRODUCTION_STATE`: last read-only Phase 0 observation reported the Python runtime online but with security and persistence unresolved.
            - `CURRENT_UI_SOURCE`: `src/components/tracker/TrackerView.tsx`.
            - `CURRENT_STATIC_ARTIFACT`: committed `nextjs-ui/` export; source/artifact parity remains unverified.
            - `CURRENT_BACKEND`: `tracker_map.py`; `nextjs-ui/tracker_map.py` is kept byte-identical in this branch.
            - `AUTH_MODEL`: protected Python endpoints require `STRACKER_API_TOKEN` via Bearer or `X-Stracker-Service-Token`, validated server-side with constant-time comparison.
            - `COOKIE_MODEL`: existing JSON/wrapper parser remains functionally unchanged; import endpoints are now authenticated. Header/Netscape normalization remains P1.
            - `GHOSTRAIL_MODEL`: CSV remains the canonical hot-history source; no migration was performed.
            - `STORAGE_MODEL`: local Render filesystem remains operationally unsafe until external persistence is implemented.

            ## Known security findings

            ```text
            CRITICAL_FINDINGS={audit_counts['CRITICAL']}
            HIGH_FINDINGS={audit_counts['HIGH']}
            MEDIUM_FINDINGS={audit_counts['MEDIUM']}
            LOW_FINDINGS={audit_counts['LOW']}
            HISTORICAL_REWRITE=NOT_EXECUTED
            ROTATION=NOT_EXECUTED
            ```

            See `docs/SECURITY_AUDIT_SANITIZED.md` for path-only evidence.

            ## Fixes implemented

            - Fail-closed static asset allowlist; arbitrary repository files are no longer served.
            - Authentication enforced on location, cookie, prediction, archive and encrypted-history endpoints.
            - Production startup validation for `STRACKER_API_TOKEN`, `SECRET_KEY` and AES-GCM support.
            - Public `/health` response reduced to status, version and timestamp.
            - Archive and encrypted verification endpoints no longer return records or key-presence metadata.
            - `.gitignore` hardened and `.env.example` added with names only.
            - Focused Python integration and unit tests added.

            ## Validations executed

            See `docs/P0_VALIDATION.md`, generated by the clean GitHub Actions checkout.

            ## Open risks

            - Repository remains public.
            - Tracked `.env` and historical sensitive material require manual review and potential rotation.
            - Production is unchanged and therefore does not yet receive these controls.
            - Root UI is not protected by this transitional token mechanism; whole-application protection is reserved for Cloudflare Access.
            - Render filesystem persistence remains unsafe.
            - Cookie parser formats and UI truthfulness remain P1.
            - Static export/source parity remains unresolved.

            ## Cloudflare status

            ```text
            FULL_CLOUDFLARE_CUTOVER=NO_GO
            HYBRID_CLOUDFLARE_EDGE_PLUS_RENDER=PRELIMINARY_GO
            CLOUDFLARE_RESOURCES_CREATED=NO
            ```

            ## Next exact step

            Review the Draft PR, then prepare a non-production staging plan for server credentials and Cloudflare Access/gateway PoC. No production promotion is authorized.
            '''
        ),
    )
    write(
        "docs/SECURITY.md",
        textwrap.dedent(
            '''\
            # STRACKER Security Model

            ## Data classification

            Location, trajectories, timestamps, device telemetry and Google session cookies are highly sensitive. They must not be public, cached, logged verbatim or committed to Git.

            ## Transitional backend authentication

            Protected routes require a server-configured `STRACKER_API_TOKEN` with at least 32 characters. Accepted transports:

            - `Authorization: Bearer <token>` for controlled clients.
            - `X-Stracker-Service-Token: <token>` for the future Cloudflare Worker-to-Render gateway.

            Tokens are compared with `hmac.compare_digest`. Missing server configuration returns a generic `503`; missing or incorrect credentials return a generic `401`. CORS remains defense-in-depth and is not authentication.

            The root Next.js shell is not protected by this transitional mechanism because browser subresources cannot safely attach a manually entered Bearer token. Full UI protection is assigned to Cloudflare Access in the next phase. All endpoints capable of returning or mutating sensitive data are protected now.

            ## Runtime modes

            `STRACKER_ENV` accepts `development`, `test`, or `production`.

            In production, startup fails before tracking or HTTP serving unless:

            - `STRACKER_API_TOKEN` is valid;
            - `SECRET_KEY` contains at least 32 characters;
            - AES-GCM support is available.

            No source-code fallback key exists. Tests use explicit environment-only test material.

            ## Static file policy

            The Python server uses a fail-closed allowlist. Public files are limited to the root application shell and known frontend assets. Sensitive files, repository metadata, logs, histories, profiles and audit inputs return 404.

            ## Protected routes

            `/points`, `/api/cookies`, `/cookies`, `/cookies.html`, `/predict`, `/api/archive`, `/archive`, `/ghostrail/encrypted`, `/health/details`, and the legacy `/mapa.html` surface require server-side authentication.

            `/historial.csv`, logs, encrypted blobs and other internal files are never served as static files.

            ## Manual incident actions

            This PR does not rotate credentials, revoke Google sessions, rewrite Git history or change repository visibility. Any audit item marked `required_if_active` must be handled manually after explicit authorization.
            '''
        ),
    )
    write(
        "docs/DEPLOYMENT.md",
        textwrap.dedent(
            '''\
            # STRACKER Deployment Controls

            ## Current platform

            Production remains on Render. This branch performs no deployment and changes no production environment variables.

            ## Required environment names

            - `STRACKER_ENV=production`
            - `STRACKER_API_TOKEN` — high-entropy service credential, at least 32 characters.
            - `SECRET_KEY` — high-entropy encryption key material, at least 32 characters.
            - `CORS_ALLOWED_ORIGINS` — explicit comma-separated allowlist.
            - Existing non-secret runtime controls such as `PORT` and `TRACKER_SKIP_PLAYWRIGHT` as required by the platform.

            Values must be configured in the deployment platform, never in Git, screenshots, logs or PR text.

            ## Pre-deployment gates

            1. Exact source SHA and clean tree recorded.
            2. Secret audit reviewed and active credentials rotated where required.
            3. Python syntax and focused backend tests pass.
            4. Frontend lint, typecheck and build results are compared with the base SHA.
            5. A staging credential is configured and unauthorized/authorized smokes are executed.
            6. Rollback target is recorded.
            7. Production promotion receives separate explicit authorization.

            ## Rollback

            This P0 branch has not been deployed; rollback is not applicable. A future Render promotion must preserve the prior deployment and must not assume that code rollback restores filesystem data.
            '''
        ),
    )
    write(
        "docs/CLOUDFLARE_MIGRATION.md",
        textwrap.dedent(
            '''\
            # STRACKER Cloudflare Migration

            ```text
            FULL_CLOUDFLARE_CUTOVER=NO_GO
            HYBRID_CLOUDFLARE_EDGE_PLUS_RENDER=PRELIMINARY_GO
            ```

            ## Rationale

            The current Python process depends on a long-running HTTP server, threads, a continuous polling loop and mutable local files. That model cannot be lifted directly into Cloudflare Workers without redesign and parity testing.

            ## Next phase

            Build an isolated PoC where Cloudflare provides:

            - Access protection for the complete UI;
            - a Worker gateway with `Cache-Control: no-store`;
            - validated Access identity at the edge;
            - `X-Stracker-Service-Token` authentication to the temporary Render ingestion runtime;
            - sanitized observability and request IDs.

            Render continues temporarily as ingestion runtime until Google RPC behavior, scheduling, persistence, GhostRail parity, costs, observability and rollback all pass explicit gates.

            No Worker, binding, KV, D1, R2, Durable Object, DNS record or production route is created by P0.
            '''
        ),
    )


def main() -> None:
    os.chdir(ROOT)
    origin_main = run("git", "rev-parse", "origin/main")
    if origin_main != BASE_SHA:
        raise RuntimeError(f"origin/main changed: expected {BASE_SHA}, got {origin_main}")
    if run("git", "merge-base", "--is-ancestor", BASE_SHA, "HEAD", check=False) != "":
        # merge-base --is-ancestor normally has no stdout; return code is checked below separately.
        pass
    ancestor = subprocess.run(["git", "merge-base", "--is-ancestor", BASE_SHA, "HEAD"], cwd=ROOT).returncode
    if ancestor != 0:
        raise RuntimeError("branch is not based on the authorized base SHA")
    if run("git", "status", "--porcelain"):
        raise RuntimeError("checkout is not clean before P0 generation")

    initial_hashes = {
        "tracker_map.py": sha256(ROOT / "tracker_map.py"),
        "nextjs-ui/index.html": sha256(ROOT / "nextjs-ui/index.html"),
        "src/components/tracker/TrackerView.tsx": sha256(ROOT / "src/components/tracker/TrackerView.tsx"),
    }
    audit = audit_secret_history()

    write("stracker_security.py", build_security_module())
    patched = patch_tracker((ROOT / "tracker_map.py").read_text(encoding="utf-8"))
    write("tracker_map.py", patched)
    write("nextjs-ui/tracker_map.py", patched)
    write("tests/test_p0_security.py", build_tests())

    write(
        ".gitignore",
        textwrap.dedent(
            '''\
            node_modules/
            .next/
            out/
            coverage/
            test-results/
            playwright-report/
            screenshots-sensitive/
            artifacts-sensitive/

            .env
            .env.*
            !.env.example
            cookies.json
            cookies.json.bak
            historial.csv
            ghostrail.enc
            ghostrail_archive.enc
            playwright_profile/
            *.sqlite
            *.sqlite3
            *.db
            *.log
            dev.log
            server.log

            upload/
            __pycache__/
            *.py[cod]
            '''
        ),
    )
    write(
        ".env.example",
        textwrap.dedent(
            '''\
            # Runtime mode: development, test, or production.
            STRACKER_ENV=development

            # Required in production. Use high-entropy values in the platform secret store.
            STRACKER_API_TOKEN=
            SECRET_KEY=

            # Explicit frontend/gateway origins, comma-separated.
            CORS_ALLOWED_ORIGINS=http://localhost:3000,http://127.0.0.1:3000

            # Runtime controls.
            PORT=8765
            TRACKER_SKIP_PLAYWRIGHT=1
            '''
        ),
    )
    build_docs(audit, initial_hashes)

    # The tracked .env is intentionally not read into output, modified or removed in P0.
    print(json.dumps({
        "base_sha": BASE_SHA,
        "branch": BRANCH,
        "modified_files_pre_validation": run("git", "status", "--short").splitlines(),
        "secret_findings_count": len(audit["findings"]),
    }))


if __name__ == "__main__":
    main()
