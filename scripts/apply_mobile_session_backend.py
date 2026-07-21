from __future__ import annotations

from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


def replace_once(text: str, old: str, new: str, label: str) -> str:
    count = text.count(old)
    if count != 1:
        raise SystemExit(f"{label}: expected exactly one match, found {count}")
    return text.replace(old, new, 1)


def patch_security() -> None:
    path = ROOT / "stracker_security.py"
    text = path.read_text(encoding="utf-8")
    text = replace_once(
        text,
        '    "/health/details",\n    "/mapa.html",\n',
        '    "/health/details",\n    "/api/session/status",\n    "/api/session/import",\n    "/api/session/clear",\n    "/mapa.html",\n',
        "protected exact routes",
    )
    text = replace_once(
        text,
        '    "/health/details/",\n)\n',
        '    "/health/details/",\n    "/api/session/status/",\n    "/api/session/import/",\n    "/api/session/clear/",\n)\n',
        "protected route prefixes",
    )
    text = replace_once(
        text,
        '    "ghostrail_archive.enc",\n    "gemini-analysis-input.json",\n',
        '    "ghostrail_archive.enc",\n    "google_session.enc",\n    "gemini-analysis-input.json",\n',
        "blocked session bundle",
    )
    path.write_text(text, encoding="utf-8")


def patch_tracker() -> None:
    path = ROOT / "tracker_map.py"
    text = path.read_text(encoding="utf-8")
    security_import = '''from stracker_security import (
    SecurityConfigurationError,
    authorize_request_headers,
    get_secret_key,
    is_blocked_static_path,
    is_protected_path,
    is_public_asset_path,
    runtime_mode,
    validate_startup_security,
)
'''
    session_import = security_import + '''from stracker_session import (
    SessionContractError,
    SessionState,
    UNLOCKED_SESSION_STATES,
    application_cookie_header,
    application_session_from_headers,
    clear_encrypted_session,
    cookie_header,
    expired_application_cookie_header,
    issue_application_session,
    load_encrypted_session,
    parse_cookie_session,
    probe_google_session,
    public_session_status,
    store_encrypted_session,
)
'''
    text = replace_once(text, security_import, session_import, "session imports")
    text = replace_once(
        text,
        'COOKIES_PATH = BASE_DIR / "cookies.json"\nCSV_PATH = BASE_DIR / "historial.csv"\n',
        'COOKIES_PATH = BASE_DIR / "cookies.json"  # legacy cleanup only; never written\nGOOGLE_SESSION_PATH = BASE_DIR / "google_session.enc"\nCSV_PATH = BASE_DIR / "historial.csv"\n',
        "session path",
    )
    old_loader = '''def _load_cookie_header():
    try:
        with open(COOKIES_PATH, encoding="utf-8") as f:
            cookies = json.load(f)
        parts = [f"{c['name']}={c['value']}" for c in cookies if "google.com" in c.get("domain", "")]
        return "; ".join(parts)
    except Exception as e:
        logger.error("Error cargando cookies: %s", e)
        return ""
'''
    new_loader = '''def _load_session_bundle():
    try:
        return load_encrypted_session(GOOGLE_SESSION_PATH, get_secret_key())
    except (SecurityConfigurationError, SessionContractError) as exc:
        logger.warning("Authorized session unavailable: %s", getattr(exc, "code", "configuration_error"))
        return None


def _load_cookie_header():
    bundle = _load_session_bundle()
    if not bundle:
        return ""
    try:
        state = SessionState(str(bundle.get("state", SessionState.ERROR.value)))
    except ValueError:
        return ""
    if state not in UNLOCKED_SESSION_STATES:
        return ""
    cookies = bundle.get("cookies")
    if not isinstance(cookies, list):
        return ""
    return cookie_header(cookies)


def _persist_imported_cookies(raw_cookies):
    """Validate and encrypt legacy auto-refresh results; never write plaintext."""
    try:
        parsed = parse_cookie_session(raw_cookies)
        probe = probe_google_session(parsed, LOCATIONSHARING_URL)
        if probe.state not in UNLOCKED_SESSION_STATES:
            logger.warning("Automatic session refresh rejected: %s", probe.code)
            return False
        store_encrypted_session(GOOGLE_SESSION_PATH, get_secret_key(), parsed, probe)
        return True
    except (SessionContractError, SecurityConfigurationError) as exc:
        logger.warning("Automatic session refresh rejected: %s", getattr(exc, "code", "configuration_error"))
        return False
'''
    text = replace_once(text, old_loader, new_loader, "encrypted cookie loader")
    text = text.replace(
        'COOKIES_PATH.write_text(json.dumps(normalized, indent=2, ensure_ascii=False), encoding="utf-8")\n        logger.info("Cookies via SQLite: %d", len(normalized))\n        return True',
        'if not _persist_imported_cookies(normalized):\n            return False\n        logger.info("Authorized session refreshed via SQLite: %d cookies", len(normalized))\n        return True',
    )
    text = text.replace(
        'COOKIES_PATH.write_text(_json.dumps(normalized, indent=2, ensure_ascii=False), encoding="utf-8")\n                        logger.info("Cookies via CDP: %d", len(normalized))\n                        browser.close()\n                        return True',
        'if not _persist_imported_cookies(normalized):\n                            browser.close()\n                            return False\n                        logger.info("Authorized session refreshed via CDP: %d cookies", len(normalized))\n                        browser.close()\n                        return True',
    )
    text = text.replace(
        'COOKIES_PATH.write_text(json.dumps(normalized, indent=2, ensure_ascii=False), encoding="utf-8")\n                logger.info("Cookies via Playwright: %d", len(normalized))\n                context.close()\n                return True',
        'if not _persist_imported_cookies(normalized):\n                    context.close()\n                    return False\n                logger.info("Authorized session refreshed via Playwright: %d cookies", len(normalized))\n                context.close()\n                return True',
    )
    if "COOKIES_PATH.write_text" in text:
        raise SystemExit("plaintext cookie writer remains")
    text = text.replace(
        'logger.info("V6.11 device token: %s", _token)',
        'logger.info("V6.11 device token detected")',
    )
    text = replace_once(
        text,
        '''    logger.info(
        "Registrado: %.6f, %.6f | vel=%.1f km/h | rumbo=%s | %s",
        lat, lng, speed_kmh, heading_name(heading), timestamp.isoformat(),
    )
''',
        '''    logger.info(
        "Location point registered | speed=%.1f km/h | heading=%s | timestamp=%s",
        speed_kmh, heading_name(heading), timestamp.isoformat(),
    )
''',
        "coordinate log removal",
    )
    old_require = '''    def _require_authorization(self, path: str) -> bool:
        decision = authorize_request_headers(self.headers)
        if decision.allowed:
            return True
        error = "service_unavailable" if decision.status == 503 else "unauthorized"
        self._send_json({"status": "error", "error": error}, status=decision.status)
        return False
'''
    new_require = '''    def _valid_application_session(self):
        try:
            return application_session_from_headers(self.headers, get_secret_key())
        except SecurityConfigurationError:
            return None

    def _require_authorization(self, path: str) -> bool:
        decision = authorize_request_headers(self.headers)
        if decision.allowed or self._valid_application_session() is not None:
            return True
        error = "service_unavailable" if decision.status == 503 else "unauthorized"
        self._send_json({"status": "error", "code": "ACCESS_REQUIRED", "message": "Acceso privado requerido.", "action": "Ingresá mediante el acceso privado configurado para STRACKER.", "error": error}, status=decision.status)
        return False

    def _trusted_access_subject(self):
        service = authorize_request_headers(self.headers)
        if service.allowed:
            return "service-token"
        if runtime_mode().value != "production" and os.environ.get("STRACKER_ALLOW_DEV_APP_SESSION", "0") == "1":
            return "development"
        trust_access = os.environ.get("STRACKER_TRUST_CLOUDFLARE_ACCESS", "0") == "1"
        access_assertion = (self.headers.get("Cf-Access-Jwt-Assertion", "") or "").strip()
        access_identity = (self.headers.get("Cf-Access-Authenticated-User-Email", "") or "").strip()
        if trust_access and access_assertion and access_identity:
            return access_identity
        return None
'''
    text = replace_once(text, old_require, new_require, "application authorization")
    old_send = '''    def _send_json(self, payload, status=200):
        body = json.dumps(payload).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self._apply_cors_headers()
'''
    new_send = '''    def _send_json(self, payload, status=200, extra_headers=None):
        body = json.dumps(payload).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.send_header("X-Robots-Tag", "noindex, nofollow, noarchive")
        for header_name, header_value in (extra_headers or {}).items():
            self.send_header(header_name, header_value)
        self._apply_cors_headers()
'''
    text = replace_once(text, old_send, new_send, "response headers")
    health_marker = '''        if path in ("/health/details", "/health/details/"):
            self._send_json({
                "status": "ok",
                "version": "v6.0_final_polish+p0_security",
                "timestamp": datetime.now(timezone.utc).isoformat(),
                "uptime_s": round(time.time() - _SERVER_START_TS, 2),
                "runtime_mode": runtime_mode().value,
            })
            return
'''
    status_route = health_marker + '''        if path in ("/api/session/status", "/api/session/status/"):
            bundle = _load_session_bundle()
            last_update_epoch = _LAST_UPDATE.timestamp() if _LAST_UPDATE else None
            self._send_json(public_session_status(bundle, last_update_epoch=last_update_epoch))
            return
'''
    text = replace_once(text, health_marker, status_route, "session status route")
    old_post = '''        if path in ("/api/cookies", "/cookies"):
            self._handle_cookies_upload(); return
        self._send_not_found()
'''
    new_post = '''        if path in ("/api/app/session", "/api/app/session/"):
            self._handle_application_session(); return
        if path in ("/api/session/import", "/api/session/import/", "/api/cookies", "/cookies"):
            self._handle_session_import(); return
        if path in ("/api/session/clear", "/api/session/clear/"):
            self._handle_session_clear(); return
        self._send_not_found()
'''
    text = replace_once(text, old_post, new_post, "session post routes")
    start_old_handler = text.index("    def _handle_cookies_upload(self):")
    end_old_handler = text.index("\n\n\nclass _ReusableThreadingHTTPServer", start_old_handler)
    new_handlers = '''    def _handle_application_session(self):
        subject = self._trusted_access_subject()
        if not subject:
            self._send_json({"status": "error", "code": "ACCESS_REQUIRED", "message": "Acceso privado requerido.", "action": "Ingresá mediante el acceso privado configurado para STRACKER."}, status=401)
            return
        try:
            token = issue_application_session(get_secret_key(), subject)
        except SecurityConfigurationError:
            self._send_json({"status": "error", "code": "SECURE_STORAGE_UNAVAILABLE", "message": "La sesión de aplicación no está configurada.", "action": "Configurá SECRET_KEY en el backend."}, status=503)
            return
        cookie = application_cookie_header(token, production=runtime_mode().value == "production")
        self._send_json({"status": "ok", "authenticated": True}, extra_headers={"Set-Cookie": cookie})

    def _handle_session_import(self):
        try:
            length = int(self.headers.get("Content-Length", 0))
            if length <= 0 or length > 2_000_000:
                raise SessionContractError("FORMAT_NOT_RECOGNIZED", "No se recibió una sesión válida.", "Pegá una exportación válida y volvé a intentar.")
            body = self.rfile.read(length).decode("utf-8", errors="strict")
            parsed = parse_cookie_session(body)
            probe = probe_google_session(parsed, LOCATIONSHARING_URL)
            summary = parsed.public_summary()
            response = {"status": "ok" if probe.state in UNLOCKED_SESSION_STATES else "error", **summary, **probe.public_payload(), "map_unlocked": probe.state in UNLOCKED_SESSION_STATES, "configured": probe.state in UNLOCKED_SESSION_STATES, "validation_code": probe.code}
            if probe.state in UNLOCKED_SESSION_STATES:
                store_encrypted_session(GOOGLE_SESSION_PATH, get_secret_key(), parsed, probe)
                try:
                    COOKIES_PATH.unlink(missing_ok=True)
                except OSError:
                    pass
                self._send_json(response)
            else:
                status = 401 if probe.state is SessionState.EXPIRED else 422
                self._send_json(response, status=status)
        except SessionContractError as exc:
            self._send_json(exc.to_public(), status=exc.status)
        except SecurityConfigurationError:
            self._send_json({"status": "error", "code": "SECURE_STORAGE_UNAVAILABLE", "message": "El almacenamiento seguro no está configurado.", "action": "Configurá SECRET_KEY antes de importar una sesión."}, status=503)
        except UnicodeDecodeError:
            self._send_json({"status": "error", "code": "FORMAT_NOT_RECOGNIZED", "message": "Formato no reconocido.", "action": "Usá una exportación UTF-8 válida."}, status=400)
        except Exception:
            logger.exception("Session import failed without exposing payload")
            self._send_json({"status": "error", "code": "INTERNAL_ERROR", "message": "No se pudo validar la sesión.", "action": "Reintentá o reemplazá la sesión."}, status=500)

    def _handle_session_clear(self):
        try:
            clear_encrypted_session(GOOGLE_SESSION_PATH)
            try:
                COOKIES_PATH.unlink(missing_ok=True)
            except OSError:
                pass
            cookie = expired_application_cookie_header(production=runtime_mode().value == "production")
            self._send_json({"status": "ok", "state": SessionState.UNCONFIGURED.value, "map_unlocked": False, "configured": False}, extra_headers={"Set-Cookie": cookie})
        except SessionContractError as exc:
            self._send_json(exc.to_public(), status=exc.status)
'''
    text = text[:start_old_handler] + new_handlers + text[end_old_handler:]
    if "Debe ser array" in text:
        raise SystemExit("legacy parser response remains")
    path.write_text(text, encoding="utf-8")
    (ROOT / "nextjs-ui" / "tracker_map.py").write_text(text, encoding="utf-8")


def patch_page() -> None:
    path = ROOT / "src/app/page.tsx"
    path.write_text(
        """'use client'\n\nimport dynamic from 'next/dynamic'\nimport { SessionGate } from '@/components/tracker/SessionGate'\n\nconst TrackerView = dynamic(() => import('@/components/tracker/TrackerView'), {\n  ssr: false,\n  loading: () => <div style={{ width: '100%', height: '100dvh', background: '#000' }} />,\n})\n\nexport default function Home() {\n  return (\n    <SessionGate>\n      <TrackerView />\n    </SessionGate>\n  )\n}\n""",
        encoding="utf-8",
    )


def append_unique(path: Path, marker: str, content: str) -> None:
    current = path.read_text(encoding="utf-8") if path.exists() else ""
    if marker not in current:
        if current and not current.endswith("\n"):
            current += "\n"
        current += content
        path.write_text(current, encoding="utf-8")


def patch_config_and_docs() -> None:
    append_unique(
        ROOT / ".gitignore",
        "google_session.enc",
        "\n# Encrypted authorized Google session bundle\ngoogle_session.enc\n",
    )
    append_unique(
        ROOT / ".env.example",
        "STRACKER_TRUST_CLOUDFLARE_ACCESS",
        "\n# Browser application-session trust boundary\nSTRACKER_TRUST_CLOUDFLARE_ACCESS=\nSTRACKER_ALLOW_DEV_APP_SESSION=\nGOOGLE_MAPS_SHARE_URL=\n",
    )
    mobile_doc = ROOT / "docs/MOBILE_SESSION_ONBOARDING.md"
    mobile_doc.write_text(
        """# STRACKER Mobile Session Onboarding\n\n## Product decision\n\nSTRACKER is mobile-first. Desktop renders the same architecture in a bounded width and has no exclusive features.\n\nGoogle Maps consumer Location Sharing has no verified public API for this use case. The product therefore uses the honest action **Importar sesión** and never describes the flow as OAuth or an official Google integration.\n\n## State machine\n\n`UNCONFIGURED → IMPORTING → VALIDATING → READY | NO_LOCATION | EXPIRED | ERROR`\n\n`STALE` is derived when a previously validated session has an old last-location timestamp. Only `READY`, `STALE`, and `NO_LOCATION` unlock the map.\n\n## Security contract\n\n- Browser access is represented by a signed, HttpOnly, SameSite=Strict application cookie.\n- In production the cookie is Secure and can be issued only after a server service credential or explicitly trusted Cloudflare Access identity headers.\n- Google cookie values are accepted once, validated against allowed domains and the upstream location contract, encrypted with AES-GCM, and never returned to the browser.\n- The browser stores no Google cookies in localStorage, IndexedDB, or application state after submission.\n- Failed replacements do not overwrite the last validated backend bundle.\n- All session and location responses use `Cache-Control: no-store` and `X-Robots-Tag: noindex, nofollow, noarchive`.\n\n## Accepted formats\n\n- Cookie Editor JSON\n- Wrapped JSON\n- Cookie Header String\n- Netscape\n\n## Non-production trust setup\n\nDevelopment tests require the explicit `STRACKER_ALLOW_DEV_APP_SESSION=1`. Production must leave that flag disabled. Cloudflare Access trust requires `STRACKER_TRUST_CLOUDFLARE_ACCESS=1` and validated Access headers at a private gateway; this branch does not configure Cloudflare or deploy.\n""",
        encoding="utf-8",
    )
    append_unique(
        ROOT / "docs/SECURITY.md",
        "## Mobile application session",
        "\n## Mobile application session\n\nThe browser uses an independent signed HttpOnly application session. Google cookie values are backend-only and stored in `google_session.enc` using AES-GCM. Session import is not considered successful until the backend probes the authorized source and classifies the result as `READY` or `NO_LOCATION`.\n",
    )
    append_unique(
        ROOT / "docs/DEPLOYMENT.md",
        "STRACKER_TRUST_CLOUDFLARE_ACCESS",
        "\n## Mobile session gateway variables\n\n- `STRACKER_TRUST_CLOUDFLARE_ACCESS`: enable only behind a verified private Access gateway.\n- `STRACKER_ALLOW_DEV_APP_SESSION`: tests/development only; must be disabled in production.\n- `GOOGLE_MAPS_SHARE_URL`: optional backend-only fallback URL; never expose it to the browser.\n\nNo deployment or production variable change is performed by the mobile onboarding branch.\n",
    )
    append_unique(
        ROOT / "docs/CURRENT_STATE.md",
        "STACKED_MOBILE_BRANCH=feat/stracker-mobile-session-onboarding",
        "\n## Stacked mobile-first phase\n\n```text\nSTACKED_BASE_SHA=fa919edad57937481f97e74ac96f09697bf03642\nSTACKED_BASE_BRANCH=fix/stracker-p0-security-canonical-state\nSTACKED_MOBILE_BRANCH=feat/stracker-mobile-session-onboarding\nPRODUCT_MODE=MOBILE_FIRST\nGOOGLE_LOCATION_SHARING_PUBLIC_API=NOT_VERIFIED_AVAILABLE\nSESSION_ACTION_LABEL=IMPORTAR_SESION\nPRODUCTION_MODIFIED=NO\nDEPLOYMENT_EXECUTED=NO\n```\n\nThe stacked branch adds a canonical cookie parser, encrypted backend session bundle, independent application session, real upstream validation, explicit session state machine, mobile onboarding, and map gating.\n",
    )


def main() -> None:
    patch_security()
    patch_tracker()
    patch_page()
    patch_config_and_docs()


if __name__ == "__main__":
    main()
