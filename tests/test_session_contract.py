from __future__ import annotations

import io
import json
import tempfile
import time
import unittest
import urllib.error
from pathlib import Path

from stracker_session import (
    CookieFormat,
    SessionContractError,
    SessionState,
    application_session_from_headers,
    clear_encrypted_session,
    issue_application_session,
    load_encrypted_session,
    parse_cookie_session,
    probe_google_session,
    public_session_status,
    store_encrypted_session,
    verify_application_session,
)


FAKE_VALUES = {
    "SID": "fake-sid-value",
    "HSID": "fake-hsid-value",
    "SSID": "fake-ssid-value",
    "APISID": "fake-apisid-value",
    "SAPISID": "fake-sapisid-value",
    "__Secure-1PSID": "fake-secure-value",
}


def cookie_rows(domain: str = ".google.com") -> list[dict[str, object]]:
    return [
        {
            "name": name,
            "value": value,
            "domain": domain,
            "path": "/",
            "secure": True,
            "expirationDate": time.time() + 3600,
        }
        for name, value in FAKE_VALUES.items()
    ]


class FakeResponse:
    def __init__(self, body: str, status: int = 200):
        self.body = body.encode("utf-8")
        self.status = status

    def __enter__(self):
        return self

    def __exit__(self, exc_type, exc, tb):
        return False

    def read(self) -> bytes:
        return self.body


class SessionParserTests(unittest.TestCase):
    def test_cookie_editor_json(self):
        parsed = parse_cookie_session(json.dumps(cookie_rows()))
        self.assertEqual(parsed.format, CookieFormat.COOKIE_EDITOR_JSON)
        self.assertEqual(parsed.count, len(FAKE_VALUES))
        self.assertTrue(parsed.has_required_critical)
        self.assertNotIn("value", parsed.public_summary())

    def test_wrapped_json(self):
        payload = {"format": "auto", "data": json.dumps(cookie_rows())}
        parsed = parse_cookie_session(json.dumps(payload))
        self.assertEqual(parsed.format, CookieFormat.WRAPPED_JSON)

    def test_cookie_header_string(self):
        header = "; ".join(f"{name}={value}" for name, value in FAKE_VALUES.items())
        parsed = parse_cookie_session(header)
        self.assertEqual(parsed.format, CookieFormat.COOKIE_HEADER)
        self.assertTrue(all(cookie["domain"] == ".google.com" for cookie in parsed.cookies))

    def test_netscape(self):
        lines = ["# Netscape HTTP Cookie File"]
        for name, value in FAKE_VALUES.items():
            lines.append(f".google.com\tTRUE\t/\tTRUE\t{int(time.time() + 3600)}\t{name}\t{value}")
        parsed = parse_cookie_session("\n".join(lines))
        self.assertEqual(parsed.format, CookieFormat.NETSCAPE)

    def test_rejects_non_google_domain(self):
        with self.assertRaises(SessionContractError) as ctx:
            parse_cookie_session(cookie_rows(".example.com"))
        self.assertEqual(ctx.exception.code, "DOMAIN_NOT_ALLOWED")

    def test_rejects_missing_critical_cookies(self):
        with self.assertRaises(SessionContractError) as ctx:
            parse_cookie_session([cookie_rows()[0]])
        self.assertEqual(ctx.exception.code, "COOKIES_INCOMPLETE")

    def test_rejects_expired_cookie(self):
        rows = cookie_rows()
        rows[0]["expirationDate"] = time.time() - 1
        with self.assertRaises(SessionContractError) as ctx:
            parse_cookie_session(rows)
        self.assertEqual(ctx.exception.code, "SESSION_EXPIRED")


class SecureBundleTests(unittest.TestCase):
    def test_encrypted_bundle_never_contains_plaintext_cookie_values(self):
        parsed = parse_cookie_session(cookie_rows())
        probe = probe_google_session(
            parsed,
            "https://example.invalid/rpc",
            opener=lambda *_args, **_kwargs: FakeResponse("[null,-60.7,-31.6]"),
        )
        self.assertEqual(probe.state, SessionState.READY)
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "google_session.enc"
            secret = "s" * 64
            store_encrypted_session(path, secret, parsed, probe)
            stored_bytes = path.read_bytes()
            for value in FAKE_VALUES.values():
                self.assertNotIn(value.encode("utf-8"), stored_bytes)
            loaded = load_encrypted_session(path, secret)
            self.assertIsNotNone(loaded)
            self.assertEqual(len(loaded["cookies"]), len(FAKE_VALUES))
            clear_encrypted_session(path)
            self.assertFalse(path.exists())


class ProbeTests(unittest.TestCase):
    def setUp(self):
        self.parsed = parse_cookie_session(cookie_rows())

    def test_ready_requires_real_coordinate_contract(self):
        result = probe_google_session(
            self.parsed,
            "https://example.invalid/rpc",
            opener=lambda *_args, **_kwargs: FakeResponse("[null,-60.7,-31.6]"),
        )
        self.assertEqual(result.state, SessionState.READY)
        self.assertTrue(result.location)
        self.assertNotIn("location", result.public_payload())

    def test_no_location_is_explicit_and_unlockable(self):
        result = probe_google_session(
            self.parsed,
            "https://example.invalid/rpc",
            opener=lambda *_args, **_kwargs: FakeResponse("[null,null,null]"),
        )
        self.assertEqual(result.state, SessionState.NO_LOCATION)

    def test_expired_session(self):
        def expired(*_args, **_kwargs):
            raise urllib.error.HTTPError("https://example.invalid", 403, "forbidden", {}, io.BytesIO())

        result = probe_google_session(self.parsed, "https://example.invalid/rpc", opener=expired)
        self.assertEqual(result.state, SessionState.EXPIRED)

    def test_upstream_error(self):
        def unavailable(*_args, **_kwargs):
            raise urllib.error.URLError("offline")

        result = probe_google_session(self.parsed, "https://example.invalid/rpc", opener=unavailable)
        self.assertEqual(result.state, SessionState.ERROR)


class ApplicationSessionTests(unittest.TestCase):
    def test_signed_http_only_session_verification(self):
        secret = "a" * 64
        token = issue_application_session(secret, "authorized@example.invalid", ttl_seconds=600)
        verified = verify_application_session(token, secret)
        self.assertIsNotNone(verified)
        headers = {"Cookie": f"other=x; stracker_app_session={token}"}
        self.assertIsNotNone(application_session_from_headers(headers, secret))
        self.assertIsNone(verify_application_session(token + "tampered", secret))

    def test_expired_application_session(self):
        secret = "b" * 64
        token = issue_application_session(secret, "authorized@example.invalid", ttl_seconds=300)
        verified = verify_application_session(token, secret, now=int(time.time()) + 301)
        self.assertIsNone(verified)

    def test_map_unlock_rules(self):
        for state, unlocked in (
            (SessionState.READY, True),
            (SessionState.STALE, True),
            (SessionState.NO_LOCATION, True),
            (SessionState.EXPIRED, False),
            (SessionState.ERROR, False),
        ):
            status = public_session_status(
                {
                    "state": state.value,
                    "format": CookieFormat.COOKIE_EDITOR_JSON.value,
                    "cookies": cookie_rows(),
                    "critical_present": list(FAKE_VALUES),
                    "critical_missing": [],
                }
            )
            self.assertEqual(status["map_unlocked"], unlocked, state.value)


if __name__ == "__main__":
    unittest.main()
