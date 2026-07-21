
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
        (base / "historial.csv").write_text("timestamp,lat,lng\n", encoding="utf-8")
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
