#!/usr/bin/env python3
from __future__ import annotations

import contextlib
import importlib.util
import io
import json
import sys
import tempfile
import unittest
from pathlib import Path


REPOSITORY_ROOT = Path(__file__).resolve().parents[2]
SCANNER_PATH = REPOSITORY_ROOT / "scripts/security/native-sharing-release-scan.py"
FIXTURE_ROOT = REPOSITORY_ROOT / "tests/security/fixtures/native-sharing-release-scan"
SPEC = importlib.util.spec_from_file_location("native_sharing_release_scan", SCANNER_PATH)
if SPEC is None or SPEC.loader is None:
    raise RuntimeError("scanner module could not be loaded")
scanner = importlib.util.module_from_spec(SPEC)
sys.modules[SPEC.name] = scanner
SPEC.loader.exec_module(scanner)


EXPECTED_FIXTURES = {
    "safe": [],
    "forbidden-wrangler-deploy": [(scanner.RULE_INFRA_WRANGLER_MUTATION, scanner.WORKFLOW_PATH)],
    "forbidden-wrangler-publish": [(scanner.RULE_INFRA_WRANGLER_MUTATION, scanner.WORKFLOW_PATH)],
    "forbidden-version-upload": [(scanner.RULE_INFRA_WRANGLER_MUTATION, scanner.WORKFLOW_PATH)],
    "forbidden-database-binding": [(scanner.RULE_INFRA_DATABASE_BINDING, "wrangler.jsonc")],
    "forbidden-durable-object-binding": [(scanner.RULE_INFRA_DURABLE_OBJECT_BINDING, "wrangler.toml")],
    "forbidden-migration-binding": [(scanner.RULE_INFRA_MIGRATION_BINDING, "wrangler.toml")],
    "forbidden-google-endpoint": [(scanner.RULE_GOOGLE_INTERNAL_ENDPOINT, "native-sharing/src/google.ts")],
    "forbidden-google-session-credential": [(scanner.RULE_GOOGLE_SESSION_CREDENTIAL, "native-sharing/src/google.ts")],
    "forbidden-legacy-source": [(scanner.RULE_LEGACY_GOOGLE_SHARED_SOURCE, "src/lib/location-source/contracts.ts")],
    "forbidden-capability-path": [(scanner.RULE_VIEWER_CAPABILITY_IN_URL, "src/app/shared/page.tsx")],
    "forbidden-capability-query": [(scanner.RULE_VIEWER_CAPABILITY_IN_URL, "src/app/shared/page.tsx")],
    "forbidden-persistent-token": [(scanner.RULE_PERSISTENT_VIEWER_TOKEN, "src/lib/location-source/viewer.ts")],
    "forbidden-sensitive-log": [(scanner.RULE_SENSITIVE_LOGGING, "src/lib/location-source/viewer.ts")],
    "forbidden-analytics": [(scanner.RULE_SHARED_ROUTE_ANALYTICS, "src/app/shared/page.tsx")],
    "forbidden-private-key": [(scanner.RULE_PRIVATE_KEY_MATERIAL, "native-sharing/src/key.ts")],
}

ALL_RULE_IDS = {
    scanner.RULE_INFRA_WRANGLER_MUTATION,
    scanner.RULE_INFRA_DATABASE_BINDING,
    scanner.RULE_INFRA_DURABLE_OBJECT_BINDING,
    scanner.RULE_INFRA_MIGRATION_BINDING,
    scanner.RULE_GOOGLE_INTERNAL_ENDPOINT,
    scanner.RULE_GOOGLE_SESSION_CREDENTIAL,
    scanner.RULE_LEGACY_GOOGLE_SHARED_SOURCE,
    scanner.RULE_VIEWER_CAPABILITY_IN_URL,
    scanner.RULE_PERSISTENT_VIEWER_TOKEN,
    scanner.RULE_SENSITIVE_LOGGING,
    scanner.RULE_SHARED_ROUTE_ANALYTICS,
    scanner.RULE_PRIVATE_KEY_MATERIAL,
}


class NativeSharingReleaseScannerTests(unittest.TestCase):
    maxDiff = None

    @staticmethod
    def write(root: Path, relative_path: str, content: str) -> None:
        path = root / relative_path
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(content, encoding="utf-8")

    def materialize_fixture(self, name: str) -> tuple[tempfile.TemporaryDirectory[str], Path, list[dict[str, str]]]:
        fixture_path = FIXTURE_ROOT / name / "fixture.json"
        self.assertTrue(fixture_path.is_file(), f"missing fixture: {name}")
        definition = json.loads(fixture_path.read_text(encoding="utf-8"))
        temporary = tempfile.TemporaryDirectory(prefix=f"stracker-{name}-")
        root = Path(temporary.name)
        for entry in definition["files"]:
            self.write(root, entry["path"], entry["content"])
        return temporary, root, definition["expected"]

    def test_fixture_inventory_is_exact(self) -> None:
        actual = {path.name for path in FIXTURE_ROOT.iterdir() if path.is_dir()}
        self.assertEqual(actual, set(EXPECTED_FIXTURES))

    def test_safe_fixture_is_accepted(self) -> None:
        temporary, root, expected = self.materialize_fixture("safe")
        self.addCleanup(temporary.cleanup)
        self.assertEqual(expected, [])
        self.assertEqual(scanner.scan_repository(root), [])

    def test_every_forbidden_fixture_is_rejected_with_exact_output(self) -> None:
        observed_rules: set[str] = set()
        for name, expected_pairs in EXPECTED_FIXTURES.items():
            if name == "safe":
                continue
            with self.subTest(fixture=name):
                temporary, root, expected_json = self.materialize_fixture(name)
                self.addCleanup(temporary.cleanup)
                findings = scanner.scan_repository(root)
                actual_pairs = [(finding.rule_id, finding.file_path) for finding in findings]
                self.assertEqual(actual_pairs, expected_pairs)
                self.assertEqual(
                    [finding.public_payload() for finding in findings],
                    expected_json,
                )
                observed_rules.update(finding.rule_id for finding in findings)
        self.assertEqual(observed_rules, ALL_RULE_IDS)

    def test_scanner_does_not_match_its_own_rule_table_or_negative_fixtures(self) -> None:
        with tempfile.TemporaryDirectory(prefix="stracker-scanner-self-match-") as directory:
            root = Path(directory)
            self.write(
                root,
                scanner.SELF_PATH,
                "wrangler deploy\ndatabase_id = 'x'\n/shared/<capability>\nconsole.log(viewerToken)\n",
            )
            self.write(
                root,
                f"{scanner.FIXTURE_PREFIX}/negative.ts",
                "wrangler deploy\nlocationsharing/read\n/shared/<capability>\n",
            )
            self.write(root, "native-sharing/src/safe.ts", "export const ok = true\n")
            self.assertEqual(scanner.scan_repository(root), [])

    def test_workflow_parser_checks_only_effective_commands(self) -> None:
        safe_workflow = """jobs:
  verify:
    steps:
      - run: |
          echo 'wrangler deploy is forbidden documentation'
          cat <<'TEXT'
          wrangler publish
          TEXT
          python scripts/security/native-sharing-release-scan.py --root .
"""
        with tempfile.TemporaryDirectory(prefix="stracker-workflow-safe-") as directory:
            root = Path(directory)
            self.write(root, scanner.WORKFLOW_PATH, safe_workflow)
            self.assertEqual(scanner.scan_repository(root), [])

    def test_failure_output_is_sanitized_json_lines(self) -> None:
        findings = [scanner.Finding(scanner.RULE_SENSITIVE_LOGGING, "src/lib/location-source/viewer.ts")]
        buffer = io.StringIO()
        with contextlib.redirect_stdout(buffer):
            scanner.emit_findings(findings)
        lines = [line for line in buffer.getvalue().splitlines() if line]
        self.assertEqual(len(lines), 1)
        payload = json.loads(lines[0])
        self.assertEqual(set(payload), {"ruleId", "filePath"})
        self.assertEqual(payload["ruleId"], scanner.RULE_SENSITIVE_LOGGING)
        self.assertEqual(payload["filePath"], "src/lib/location-source/viewer.ts")
        forbidden_output_terms = (
            "viewerToken",
            "console.log",
            "Authorization",
            "Cookie",
            "latitude",
            "longitude",
            "matching line",
        )
        self.assertFalse(any(term in lines[0] for term in forbidden_output_terms))

    def test_real_repository_scope_is_clean(self) -> None:
        self.assertEqual(scanner.scan_repository(REPOSITORY_ROOT), [])


if __name__ == "__main__":
    suite = unittest.defaultTestLoader.loadTestsFromTestCase(NativeSharingReleaseScannerTests)
    result = unittest.TextTestRunner(verbosity=2).run(suite)
    if result.wasSuccessful():
        print("SCANNER_UNIT_TESTS=PASS")
        print("SAFE_FIXTURE_ACCEPTED=PASS")
        print("ALL_FORBIDDEN_FIXTURES_REJECTED=PASS")
        print("EXPECTED_RULE_IDS=PASS")
        print("EXPECTED_FILE_PATHS=PASS")
        print("SCANNER_SELF_MATCH=NO")
        print("SCANNER_OUTPUT_SANITIZED=PASS")
        print("REAL_REPOSITORY_SCOPE=PASS")
        raise SystemExit(0)
    raise SystemExit(1)
