#!/usr/bin/env python3
from __future__ import annotations

import json
import shutil
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


def replace_once(text: str, old: str, new: str, label: str) -> str:
    if old not in text:
        raise RuntimeError(f"missing patch anchor: {label}")
    return text.replace(old, new, 1)


def patch_security() -> None:
    path = ROOT / "stracker_security.py"
    text = path.read_text(encoding="utf-8")
    if '"/api/session/status"' not in text:
        text = replace_once(text, '    "/api/cookies",\n', '    "/api/cookies",\n    "/api/session/status",\n    "/api/session/import",\n    "/api/session/delete",\n', "security exact session routes")
        text = replace_once(text, '    "/api/cookies/",\n', '    "/api/cookies/",\n    "/api/session/",\n', "security prefix session routes")
    path.write_text(text, encoding="utf-8")


def patch_tracker(path: Path) -> None:
    text = path.read_text(encoding="utf-8")
    if "from stracker_session import (" not in text:
        security_end = "    validate_startup_security,\n)\n"
        session_import = '''    validate_startup_security,\n)\n\nfrom stracker_session import (\n    MAX_IMPORT_BYTES,\n    SessionInputError,\n    delete_stored_session,\n    parse_cookie_input,\n    probe_google_location_sharing,\n    session_public_status,\n    write_session_atomic,\n)\n'''
        text = replace_once(text, security_end, session_import, f"{path.name} imports")

    get_anchor = '''        if path in ("/health/details", "/health/details/"):\n            self._send_json({\n                "status": "ok",\n                "version": "v6.0_final_polish+p0_security",\n                "timestamp": datetime.now(timezone.utc).isoformat(),\n                "uptime_s": round(time.time() - _SERVER_START_TS, 2),\n                "runtime_mode": runtime_mode().value,\n            })\n            return\n\n'''
    if 'if path in ("/api/session/status"' not in text:
        text = replace_once(text, get_anchor, get_anchor + '''        if path in ("/api/session/status", "/api/session/status/"):\n            self._send_json(session_public_status(COOKIES_PATH, LOCATIONSHARING_URL))\n            return\n\n''', f"{path.name} GET session status")

    post_start = text.index("    def do_POST(self):")
    post_end = text.index("\n    def _serve_cookies_page", post_start)
    replacement_post = '''    def do_POST(self):\n        path = self.path.split("?", 1)[0]\n        if is_blocked_static_path(path):\n            self._send_not_found()\n            return\n        if is_protected_path(path) and not self._require_authorization(path):\n            return\n        if path in ("/api/session/import", "/api/session/import/", "/api/cookies", "/cookies"):\n            self._handle_session_import()\n            return\n        if path in ("/api/session/delete", "/api/session/delete/"):\n            self._handle_session_delete()\n            return\n        self._send_not_found()\n\n'''
    text = text[:post_start] + replacement_post + text[post_end:]

    handler_start = text.index("    def _handle_cookies_upload(self):")
    handler_end = text.index("\n\nclass _ReusableThreadingHTTPServer", handler_start)
    new_handlers = '''    def _read_json_body(self) -> dict:\n        try:\n            length = int(self.headers.get("Content-Length", "0"))\n        except ValueError as exc:\n            raise SessionInputError("INVALID_LENGTH", "El tamaño del contenido no es válido.", "Volvé a intentar la importación.") from exc\n        if length <= 0:\n            raise SessionInputError("EMPTY_INPUT", "No se recibió ninguna sesión.", "Pegá una exportación antes de importar.")\n        if length > MAX_IMPORT_BYTES + 4096:\n            raise SessionInputError("INPUT_TOO_LARGE", "La sesión supera el tamaño permitido.", "Exportá únicamente las cookies necesarias de Google Maps.")\n        raw_body = self.rfile.read(length).decode("utf-8")\n        try:\n            decoded = json.loads(raw_body)\n        except json.JSONDecodeError as exc:\n            raise SessionInputError("MALFORMED_BODY", "El cuerpo de la solicitud no es JSON válido.", "Volvé a intentar la importación.") from exc\n        if isinstance(decoded, dict) and isinstance(decoded.get("raw"), str):\n            return {"raw": decoded["raw"]}\n        return {"raw": json.dumps(decoded)}\n\n    def _handle_session_import(self):\n        parsed = None\n        try:\n            body = self._read_json_body()\n            parsed = parse_cookie_input(body["raw"])\n            health = probe_google_location_sharing(parsed, LOCATIONSHARING_URL)\n            payload = {\n                "status": "ok" if health.configured else "error",\n                "action": "open_map" if health.configured else "replace_session",\n                "appAuthenticated": True,\n                **parsed.public_summary(),\n                **health.public_summary(),\n            }\n            if health.configured:\n                write_session_atomic(COOKIES_PATH, parsed)\n                logger.info("Google shared session validated and stored: format=%s count=%d health=%s", parsed.format_detected, len(parsed.cookies), health.health)\n                self._send_json(payload, status=200)\n            else:\n                logger.warning("Google shared session rejected: format=%s count=%d health=%s", parsed.format_detected, len(parsed.cookies), health.health)\n                self._send_json(payload, status=422)\n        except SessionInputError as exc:\n            self._send_json({\n                "status": "error",\n                "error": exc.code,\n                "message": exc.message,\n                "action": exc.action,\n                "appAuthenticated": True,\n                "state": "SHARED_UNCONFIGURED",\n                "health": "INVALID",\n                "configured": False,\n                "formatDetected": parsed.format_detected if parsed else None,\n                "count": len(parsed.cookies) if parsed else 0,\n                "criticalPresent": list(parsed.critical_present) if parsed else [],\n                "criticalMissing": list(parsed.critical_missing) if parsed else [],\n            }, status=400)\n        except Exception:\n            logger.exception("Shared session import failed without exposing cookie values")\n            self._send_json({"status": "error", "error": "internal_error", "message": "No se pudo validar la sesión.", "action": "Reintentá más tarde o reemplazá la sesión."}, status=500)\n\n    def _handle_session_delete(self):\n        try:\n            delete_stored_session(COOKIES_PATH)\n            self._send_json({"status": "ok"})\n        except OSError:\n            logger.exception("Shared session deletion failed")\n            self._send_json({"status": "error", "error": "internal_error"}, status=500)\n'''
    text = text[:handler_start] + new_handlers + text[handler_end:]
    path.write_text(text, encoding="utf-8")


def patch_package() -> None:
    path = ROOT / "package.json"
    data = json.loads(path.read_text(encoding="utf-8"))
    data["packageManager"] = "bun@1.3.4"
    scripts = data.setdefault("scripts", {})
    scripts["dev"] = "next dev -p 3000"
    scripts["build"] = "next build"
    scripts["build:export"] = "BUILD_EXPORT=1 next build"
    scripts["start"] = "bun .next/standalone/server.js"
    scripts["lint"] = "eslint src/app src/components/mobile src/lib/location-source"
    scripts["typecheck"] = "tsc --noEmit"
    scripts["test:backend"] = "python -m unittest discover -s tests -p 'test_*.py'"
    path.write_text(json.dumps(data, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")


def patch_tsconfig() -> None:
    path = ROOT / "tsconfig.json"
    data = json.loads(path.read_text(encoding="utf-8"))
    data["include"] = ["next-env.d.ts", "src/app/**/*.ts", "src/app/**/*.tsx", "src/components/mobile/**/*.ts", "src/components/mobile/**/*.tsx", "src/lib/location-source/**/*.ts", ".next/types/**/*.ts", ".next/dev/types/**/*.ts"]
    data["exclude"] = ["node_modules", "skills", "tool-results", "src/components/tracker"]
    path.write_text(json.dumps(data, indent=2) + "\n", encoding="utf-8")


def patch_next_config() -> None:
    (ROOT / "next.config.ts").write_text('''import type { NextConfig } from "next";\n\nconst isExport = process.env.BUILD_EXPORT === "1";\n\nconst nextConfig: NextConfig = {\n  output: isExport ? "export" : "standalone",\n  images: { unoptimized: true },\n  reactStrictMode: true,\n  ...(isExport ? {} : { async rewrites() { return [\n    { source: "/points", destination: "http://127.0.0.1:3003/points" },\n    { source: "/api/session/:path*", destination: "http://127.0.0.1:3003/api/session/:path*" },\n  ]; } }),\n};\n\nexport default nextConfig;\n''', encoding="utf-8")


def write_eslint() -> None:
    (ROOT / "eslint.config.mjs").write_text('''import { defineConfig, globalIgnores } from "eslint/config";\nimport nextVitals from "eslint-config-next/core-web-vitals";\nimport nextTs from "eslint-config-next/typescript";\n\nexport default defineConfig([\n  ...nextVitals,\n  ...nextTs,\n  globalIgnores([".next/**", "out/**", "nextjs-ui/**", "skills/**", "tool-results/**", "src/components/tracker/**"]),\n]);\n''', encoding="utf-8")


def remove_obsolete_next_api() -> None:
    api_dir = ROOT / "src" / "app" / "api"
    if api_dir.exists():
        shutil.rmtree(api_dir)


def delete_tracked_env() -> None:
    path = ROOT / ".env"
    if path.exists():
        path.unlink()


def update_docs() -> None:
    (ROOT / "docs" / "MOBILE_PRODUCT_V1.md").write_text('''# STRACKER Mobile Product V1\n\n## Product source model\n\n`LocationSource` is strictly `my-device` or `google-shared`. Snapshots without a source are rejected by TypeScript contracts. The UI never renders data from both sources in one active map state.\n\n## My location\n\nUses `navigator.geolocation.watchPosition()` only after an explicit button press. Coordinates remain in browser memory and are not persisted or uploaded by default. Background tracking is not promised.\n\n## Shared location\n\nGoogle does not expose a documented general-purpose Location Sharing consumption API for STRACKER. The honest product wording is **Vincular sesión de Google Maps**. The backend accepts Cookie Editor JSON, wrapped JSON, Cookie Header String and Netscape; normalizes allowed Google domains; checks critical cookie names; performs a real upstream probe; and stores atomically only after a valid or valid-without-location classification.\n\n## Build\n\nCanonical package manager: Bun 1.3.4 with `bun.lock`. Release gates use `bun install --frozen-lockfile`, lint, independent typecheck and static export build. The legacy Next.js API routes were removed because the canonical backend is Python behind a future gateway; retaining executable Next API routes made static export non-reproducible and duplicated backend authority.\n\n## Legacy exclusion\n\n`src/components/tracker/**` is retained only as non-executable legacy reference during gradual migration. It is excluded narrowly from the mobile V1 lint/typecheck graph because the root product no longer imports it. Removal/refactor remains a follow-up task.\n\n## Security\n\nThe browser never receives Google cookie values or the Render service token. A future non-production Cloudflare gateway will attach `X-Stracker-Service-Token` server-side. No deployment is included in this branch.\n''', encoding="utf-8")


def main() -> None:
    patch_security()
    for relative in ("tracker_map.py", "nextjs-ui/tracker_map.py"):
        patch_tracker(ROOT / relative)
    patch_package()
    patch_tsconfig()
    patch_next_config()
    write_eslint()
    remove_obsolete_next_api()
    delete_tracked_env()
    update_docs()


if __name__ == "__main__":
    main()
