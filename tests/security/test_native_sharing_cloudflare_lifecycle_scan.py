from __future__ import annotations

import json
import subprocess
import sys
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
SCANNER = ROOT / 'scripts/security/native-sharing-cloudflare-release-scan.py'
FIXTURES = ROOT / 'tests/security/fixtures/native-sharing-cloudflare-lifecycle'


class LifecycleScannerTests(unittest.TestCase):
    def run_fixture(self, name: str) -> tuple[int, list[dict[str, str]]]:
        completed = subprocess.run(
            [sys.executable, str(SCANNER), '--root', str(FIXTURES / name), '--config-only'],
            cwd=ROOT,
            check=False,
            capture_output=True,
            text=True,
        )
        records: list[dict[str, str]] = []
        for line in completed.stdout.splitlines():
            if line.startswith('{'):
                record = json.loads(line)
                self.assertEqual(set(record), {'ruleId', 'filePath'})
                records.append(record)
        self.assertNotIn('token', completed.stdout.lower())
        self.assertNotIn('capability', completed.stdout.lower())
        return completed.returncode, records

    def test_exports_sqlite_safe(self) -> None:
        code, records = self.run_fixture('exports-sqlite-safe')
        self.assertEqual(code, 0)
        self.assertEqual(records, [])

    def test_migrations_are_forbidden(self) -> None:
        code, records = self.run_fixture('migrations-forbidden')
        self.assertNotEqual(code, 0)
        self.assertEqual(
            {record['ruleId'] for record in records},
            {'MIGRATIONS_PRESENT', 'EXPORTS_SQLITE_INVALID'},
        )
        self.assertEqual(
            {record['filePath'] for record in records},
            {'native-sharing-cloudflare/wrangler.jsonc'},
        )

    def test_exports_and_migrations_cannot_coexist(self) -> None:
        code, records = self.run_fixture('exports-and-migrations-forbidden')
        self.assertNotEqual(code, 0)
        self.assertEqual(
            {record['ruleId'] for record in records},
            {'EXPORTS_AND_MIGRATIONS_COEXIST', 'MIGRATIONS_PRESENT'},
        )
        self.assertEqual(
            {record['filePath'] for record in records},
            {'native-sharing-cloudflare/wrangler.jsonc'},
        )


if __name__ == '__main__':
    unittest.main()
