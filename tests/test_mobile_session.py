import json
import tempfile
import unittest
import urllib.error
from io import BytesIO
from pathlib import Path
from unittest.mock import Mock

from stracker_session import (
    CRITICAL_COOKIE_NAMES,
    SessionInputError,
    delete_stored_session,
    load_stored_session,
    parse_cookie_input,
    probe_google_location_sharing,
    write_session_atomic,
)


def complete_cookie_list():
    return [
        {"name": name, "value": f"opaque-{index}", "domain": ".google.com", "path": "/", "secure": True}
        for index, name in enumerate(CRITICAL_COOKIE_NAMES)
    ]


class FakeResponse:
    status = 200

    def __init__(self, body: bytes):
        self._body = body

    def read(self, _limit: int):
        return self._body


class MobileSessionParserTests(unittest.TestCase):
    def test_cookie_editor_json_array(self):
        parsed = parse_cookie_input(json.dumps(complete_cookie_list()))
        self.assertEqual(parsed.format_detected, "cookie_editor_json")
        self.assertEqual(len(parsed.cookies), len(CRITICAL_COOKIE_NAMES))
        self.assertEqual(parsed.critical_missing, ())

    def test_wrapped_json_array(self):
        parsed = parse_cookie_input(json.dumps({"data": complete_cookie_list()}))
        self.assertEqual(parsed.format_detected, "wrapped_json_array")

    def test_wrapped_json_string(self):
        parsed = parse_cookie_input(json.dumps({"data": json.dumps(complete_cookie_list())}))
        self.assertEqual(parsed.format_detected, "wrapped_json_string")

    def test_cookie_header_string(self):
        raw = "; ".join(f"{name}=opaque-{index}" for index, name in enumerate(CRITICAL_COOKIE_NAMES))
        parsed = parse_cookie_input(raw)
        self.assertEqual(parsed.format_detected, "cookie_header")
        self.assertEqual(parsed.critical_missing, ())

    def test_netscape_cookie_file(self):
        lines = ["# Netscape HTTP Cookie File"]
        for index, name in enumerate(CRITICAL_COOKIE_NAMES):
            lines.append(f".google.com\tTRUE\t/\tTRUE\t0\t{name}\topaque-{index}")
        parsed = parse_cookie_input("\n".join(lines))
        self.assertEqual(parsed.format_detected, "netscape")
        self.assertEqual(parsed.critical_missing, ())

    def test_rejects_non_google_domain(self):
        payload = [{"name": "SID", "value": "opaque", "domain": ".example.com"}]
        with self.assertRaises(SessionInputError) as context:
            parse_cookie_input(json.dumps(payload))
        self.assertEqual(context.exception.code, "DOMAIN_NOT_ALLOWED")

    def test_reports_missing_critical_names_without_values(self):
        parsed = parse_cookie_input(json.dumps([{"name": "SID", "value": "secret-value", "domain": ".google.com"}]))
        summary = parsed.public_summary()
        serialized = json.dumps(summary)
        self.assertNotIn("secret-value", serialized)
        self.assertIn("HSID", summary["criticalMissing"])

    def test_rejects_oversized_body(self):
        with self.assertRaises(SessionInputError) as context:
            parse_cookie_input("x" * (512 * 1024 + 1))
        self.assertEqual(context.exception.code, "INPUT_TOO_LARGE")

    def test_atomic_storage_round_trip_and_delete(self):
        parsed = parse_cookie_input(json.dumps(complete_cookie_list()))
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "cookies.json"
            write_session_atomic(path, parsed)
            loaded = load_stored_session(path)
            self.assertIsNotNone(loaded)
            self.assertEqual(loaded.critical_missing, ())
            delete_stored_session(path)
            self.assertFalse(path.exists())

    def test_health_valid_with_location(self):
        parsed = parse_cookie_input(json.dumps(complete_cookie_list()))
        opener = Mock(return_value=FakeResponse(b"[null,-31.0000,-60.0000]"))
        health = probe_google_location_sharing(parsed, "https://example.invalid", opener=opener)
        self.assertEqual(health.health, "VALID")
        self.assertEqual(health.state, "SHARED_READY")

    def test_health_valid_without_location(self):
        parsed = parse_cookie_input(json.dumps(complete_cookie_list()))
        opener = Mock(return_value=FakeResponse(b")]}\'\nlocationsharing"))
        health = probe_google_location_sharing(parsed, "https://example.invalid", opener=opener)
        self.assertEqual(health.health, "NO_LOCATION_SHARED")
        self.assertEqual(health.state, "SHARED_NO_LOCATION")

    def test_health_expired(self):
        parsed = parse_cookie_input(json.dumps(complete_cookie_list()))
        error = urllib.error.HTTPError("https://example.invalid", 401, "unauthorized", {}, BytesIO())
        opener = Mock(side_effect=error)
        health = probe_google_location_sharing(parsed, "https://example.invalid", opener=opener)
        self.assertEqual(health.health, "EXPIRED")
        self.assertEqual(health.state, "SHARED_EXPIRED")


if __name__ == "__main__":
    unittest.main()
