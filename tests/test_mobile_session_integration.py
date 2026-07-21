from __future__ import annotations

import os
import unittest
from pathlib import Path

from stracker_security import is_blocked_static_path, is_protected_path
from stracker_session import SessionState, application_cookie_header, expired_application_cookie_header


ROOT = Path(__file__).resolve().parents[1]


class MobileSessionIntegrationTests(unittest.TestCase):
    def test_session_routes_are_protected(self):
        for path in ("/api/session/status", "/api/session/import", "/api/session/clear"):
            self.assertTrue(is_protected_path(path), path)

    def test_encrypted_bundle_is_never_public(self):
        self.assertTrue(is_blocked_static_path("/google_session.enc"))

    def test_application_cookie_security_attributes(self):
        header = application_cookie_header("fake-token", production=True)
        self.assertIn("HttpOnly", header)
        self.assertIn("SameSite=Strict", header)
        self.assertIn("Secure", header)
        expired = expired_application_cookie_header(production=True)
        self.assertIn("Max-Age=0", expired)

    def test_backend_source_has_no_plaintext_cookie_writer_or_legacy_error(self):
        source = (ROOT / "tracker_map.py").read_text(encoding="utf-8")
        self.assertNotIn("COOKIES_PATH.write_text", source)
        self.assertNotIn("Debe ser array", source)
        self.assertIn("/api/app/session", source)
        self.assertIn("/api/session/import", source)
        self.assertIn("probe_google_session", source)
        self.assertIn("store_encrypted_session", source)

    def test_duplicate_backend_stays_identical(self):
        root_backend = (ROOT / "tracker_map.py").read_bytes()
        duplicate_backend = (ROOT / "nextjs-ui" / "tracker_map.py").read_bytes()
        self.assertEqual(root_backend, duplicate_backend)

    def test_unconfigured_and_expired_do_not_unlock_map(self):
        self.assertNotIn(SessionState.UNCONFIGURED, {SessionState.READY, SessionState.STALE, SessionState.NO_LOCATION})
        self.assertNotIn(SessionState.EXPIRED, {SessionState.READY, SessionState.STALE, SessionState.NO_LOCATION})

    def test_development_app_session_bypass_is_explicit(self):
        source = (ROOT / "tracker_map.py").read_text(encoding="utf-8")
        self.assertIn('STRACKER_ALLOW_DEV_APP_SESSION", "0") == "1"', source)
        self.assertIn("STRACKER_TRUST_CLOUDFLARE_ACCESS", source)


if __name__ == "__main__":
    unittest.main()
