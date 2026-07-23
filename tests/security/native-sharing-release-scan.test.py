#!/usr/bin/env python3
from __future__ import annotations

import contextlib
import importlib.util
import io
import json
import shutil
import sys
import tempfile
import unittest
from pathlib import Path


REPOSITORY_ROOT = Path(__file__).resolve().parents[2]
SCANNER_PATH = REPOSITORY_ROOT / "scripts/security/native-sharing-release-scan.py"
SPEC = importlib.util.spec_from_file_location("native_sharing_release_scan", SCANNER_PATH)
if SPEC is None or SPEC.loader is None:
    raise RuntimeError("scanner module could not be loaded")
scanner = importlib.util.module_from_spec(SPEC)
sys.modules[SPEC.name] = scanner
SPEC.loader.exec_module(scanner)


class NativeSharingReleaseScannerTests(unittest.TestCase):
    maxDiff = None

    def fixture_root(self, name: str) -> tuple[tempfile.TemporaryDirectory[str], Path]:
        temporary = tempfile.TemporaryDirectory(prefix=f"stracker-{name}-")
        root = Path(temporary.name)
        return temporary, root

    @staticmethod
    def write(root: Path, relative_path: str, content: str) -> None:
        path = root / relative_path
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(content, encoding="utf-8")

    def scan_fixture(self, name: str, relative_path: str, content: str):
        temporary, root = self.fixture_root(name)
        self.addCleanup(temporary.cleanup)
        self.write(root, relative_path, content)
        return scanner.scan_repository(root)

    def test_safe_source_is_accepted(self) -> None:
        temporary, root = self.fixture_root("safe-source")
        self.addCleanup(temporary.cleanup)
        self.write(
            root,
            "native-sharing/src/safe.ts",
            "export const source = 'shared-location'\nexport const link = '/shared#v='\n",
        )
        self.write(
            root,
            scanner.WORKFLOW_PATH,
            "jobs:\n  verify:\n    steps:\n      - run: python scripts/security/native-sharing-release-scan.py --root .\n",
        )
        self.assertEqual(scanner.scan_repository(root), [])

    def test_every_forbidden_fixture_is_rejected_with_expected_rule_and_path(self) -> None:
        cases = {
            "forbidden-wrangler-deploy": (
                scanner.WORKFLOW_PATH,
                "jobs:\n  release:\n    steps:\n      - run: wrangler deploy\n",
                scanner.RULE_INFRA_WRANGLER_MUTATION,
            ),
            "forbidden-database-binding": (
                "wrangler.jsonc",
                '{"database_id": "00000000-0000-0000-0000-000000000000"}\n',
                scanner.RULE_INFRA_DATABASE_BINDING,
            ),
            "forbidden-durable-object-binding": (
                "wrangler.toml",
                "[durable_objects]\nbindings = []\n",
                scanner.RULE_INFRA_DURABLE_OBJECT_BINDING,
            ),
            "forbidden-migration-binding": (
                "wrangler.toml",
                "[[migrations]]\ntag = \"v1\"\n",
                scanner.RULE_INFRA_MIGRATION_BINDING,
            ),
            "forbidden-google-cookie": (
                "native-sharing/src/google.ts",
                'export const headers = { Cookie: "SID=abcdefghijklmnop" }\n',
                scanner.RULE_GOOGLE_SESSION_CREDENTIAL,
            ),
            "forbidden-capability-url": (
                "src/app/shared/page.tsx",
                'export const unsafe = "/shared/<capability>"\n',
                scanner.RULE_VIEWER_CAPABILITY_IN_URL,
            ),
            "forbidden-sensitive-log": (
                "src/lib/location-source/viewer.ts",
                "console.log(viewerToken)\n",
                scanner.RULE_SENSITIVE_LOGGING,
            ),
            "forbidden-google-endpoint": (
                "native-sharing/src/google.ts",
                'export const endpoint = "https://www.google.com/maps/rpc/locationsharing/read"\n',
                scanner.RULE_GOOGLE_INTERNAL_ENDPOINT,
            ),
            "forbidden-legacy-source": (
                "src/lib/location-source/contracts.ts",
                "export type Source = 'google-shared'\n",
                scanner.RULE_LEGACY_GOOGLE_SHARED_SOURCE,
            ),
            "forbidden-persistent-viewer-token": (
                "src/lib/location-source/viewer.ts",
                "localStorage.setItem('viewer-token', viewerSessionToken)\n",
                scanner.RULE_PERSISTENT_VIEWER_TOKEN,
            ),
            "forbidden-shared-analytics": (
                "src/app/shared/page.tsx",
                'export const analytics = "https://www.googletagmanager.com/gtm.js"\n',
                scanner.RULE_SHARED_ROUTE_ANALYTICS,
            ),
            "forbidden-private-key": (
                "native-sharing/src/key.ts",
                'export const key = "-----BEGIN PRIVATE KEY-----"\n',
                scanner.RULE_PRIVATE_KEY_MATERIAL,
            ),
        }
        observed_rules: set[str] = set()
        for name, (relative_path, content, expected_rule) in cases.items():
            with self.subTest(fixture=name):
                findings = self.scan_fixture(name, relative_path, content)
                self.assertEqual(len(findings), 1)
                finding = findings[0]
                self.assertEqual(finding.rule_id, expected_rule)
                self.assertEqual(finding.file_path, relative_path)
                observed_rules.add(finding.rule_id)

        self.assertEqual(
            observed_rules,
            {
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
            },
        )

    def test_scanner_does_not_match_its_own_rule_table_or_negative_fixtures(self) -> None:
        temporary, root = self.fixture_root("scanner-self-match")
        self.addCleanup(temporary.cleanup)
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
        findings = self.scan_fixture("workflow-semantic-safe", scanner.WORKFLOW_PATH, safe_workflow)
        self.assertEqual(findings, [])

    def test_failure_output_is_sanitized(self) -> None:
        marker = "DO_NOT_EMIT_MATCHING_CONTENT"
        findings = [scanner.Finding(scanner.RULE_SENSITIVE_LOGGING, "src/lib/location-source/viewer.ts")]
        buffer = io.StringIO()
        with contextlib.redirect_stdout(buffer):
            scanner.emit_findings(findings)
        output = buffer.getvalue().strip()
        payload = json.loads(output)
        self.assertEqual(set(payload), {"ruleId", "filePath"})
        self.assertEqual(payload["ruleId"], scanner.RULE_SENSITIVE_LOGGING)
        self.assertEqual(payload["filePath"], "src/lib/location-source/viewer.ts")
        self.assertNotIn(marker, output)
        self.assertNotIn("viewerToken", output)
        self.assertNotIn("console.log", output)

    def test_real_repository_scope_is_clean(self) -> None:
        findings = scanner.scan_repository(REPOSITORY_ROOT)
        self.assertEqual(findings, [])


if __name__ == "__main__":
    suite = unittest.defaultTestLoader.loadTestsFromTestCase(NativeSharingReleaseScannerTests)
    result = unittest.TextTestRunner(verbosity=2).run(suite)
    if result.wasSuccessful():
        print("SAFE_FIXTURE_ACCEPTED=PASS")
        print("EVERY_FORBIDDEN_FIXTURE_REJECTED=PASS")
        print("EXPECTED_RULE_ID=PASS")
        print("EXPECTED_FILE_PATH=PASS")
        print("SCANNER_SELF_MATCH=NO")
        print("OUTPUT_SANITIZED=PASS")
        print("REAL_REPOSITORY_SCOPE=PASS")
        raise SystemExit(0)
    raise SystemExit(1)
