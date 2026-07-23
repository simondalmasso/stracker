#!/usr/bin/env python3
from __future__ import annotations

import json
import re
import sys
from dataclasses import dataclass
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
SOURCE_ROOT = ROOT / 'native-sharing-cloudflare'
CONFIG = SOURCE_ROOT / 'wrangler.jsonc'
WORKFLOW = ROOT / '.github/workflows/native-sharing-cloudflare-runtime-v1.yml'

@dataclass(frozen=True, order=True)
class Finding:
    rule_id: str
    file_path: str

    def emit(self) -> str:
        return json.dumps({'ruleId': self.rule_id, 'filePath': self.file_path}, separators=(',', ':'), sort_keys=True)


def relative(path: Path) -> str:
    return path.relative_to(ROOT).as_posix()


def strip_jsonc(text: str) -> str:
    text = re.sub(r'/\*.*?\*/', '', text, flags=re.S)
    return re.sub(r'(^|\s)//.*$', '', text, flags=re.M)


def run_blocks(text: str) -> list[str]:
    lines = text.splitlines()
    blocks: list[str] = []
    index = 0
    while index < len(lines):
        match = re.match(r'^(\s*)(?:-\s*)?run\s*:\s*(.*)$', lines[index])
        if not match:
            index += 1
            continue
        indent = len(match.group(1))
        value = match.group(2).strip()
        if value not in {'|', '>', '|-', '>-', '|+', '>+'}:
            blocks.append(value.strip('\"\''))
            index += 1
            continue
        index += 1
        body: list[str] = []
        while index < len(lines):
            line = lines[index]
            if line.strip() and len(line) - len(line.lstrip()) <= indent:
                break
            body.append(line[indent + 2:] if len(line) > indent else '')
            index += 1
        blocks.append('\n'.join(body))
    return blocks


def scan() -> list[Finding]:
    findings: set[Finding] = set()
    executable = [path for path in SOURCE_ROOT.rglob('*') if path.is_file() and path.suffix in {'.ts', '.js', '.json', '.jsonc'}]
    patterns = [
        ('GOOGLE_PROVIDER_ENABLED', re.compile(r'locationsharing/read|google\.com/maps/rpc|\bgoogle-shared\b', re.I)),
        ('REAL_GOOGLE_CREDENTIAL', re.compile(r'\b(?:SID|HSID|SSID|APISID|SAPISID)=', re.I)),
        ('PRIVATE_KEY_MATERIAL', re.compile(r'-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----')),
        ('SENSITIVE_LOGGING', re.compile(r'console\.(?:log|info|debug|warn|error)\s*\([^\n;]*(?:emitter|viewer|capability|token|authorization|cookie)', re.I)),
        ('KV_BACKED_STORAGE', re.compile(r'(?:ctx|this\.ctx)\.storage\.(?:get|put|list)\s*\(|\.storage\.kv\b', re.I)),
        ('REAL_SECRET_LITERAL', re.compile(r'Authorization\s*:\s*Bearer\s+[A-Za-z0-9._-]{12,}|X-Stracker-Emitter\s*:\s*[A-Za-z0-9_-]{20,}', re.I)),
    ]
    for path in executable:
        text = path.read_text(encoding='utf-8', errors='replace')
        for rule_id, pattern in patterns:
            if pattern.search(text):
                findings.add(Finding(rule_id, relative(path)))

    try:
        config = json.loads(strip_jsonc(CONFIG.read_text(encoding='utf-8')))
    except Exception:
        findings.add(Finding('WRANGLER_CONFIG_INVALID', relative(CONFIG)))
        config = {}
    if config.get('workers_dev') is not False or config.get('preview_urls') is not False:
        findings.add(Finding('ROUTABLE_CONFIG', relative(CONFIG)))
    if any(key in config for key in ('routes', 'route', 'account_id', 'zone_id')):
        findings.add(Finding('REAL_ROUTE_OR_ACCOUNT', relative(CONFIG)))
    if config.get('vars') or config.get('secrets'):
        findings.add(Finding('REAL_SECRET_BINDING', relative(CONFIG)))
    bindings = config.get('durable_objects', {}).get('bindings', [])
    if bindings != [{'name': 'NATIVE_SHARING', 'class_name': 'NativeSharingDurableObject'}]:
        findings.add(Finding('DO_BINDING_INVALID', relative(CONFIG)))
    migrations = config.get('migrations', [])
    if migrations != [{'tag': 'v1', 'new_sqlite_classes': ['NativeSharingDurableObject']}]:
        findings.add(Finding('DO_SQLITE_MIGRATION_INVALID', relative(CONFIG)))
    if 'new_classes' in json.dumps(config):
        findings.add(Finding('KV_BACKED_DO_CLASS', relative(CONFIG)))

    if WORKFLOW.is_file():
        mutation = re.compile(r'\bwrangler\s+(?:versions\s+upload|publish)\b|\bgh\s+pr\s+merge\b|\bgit\s+push\b[^\n]*(?:--force|-f)|api\.cloudflare\.com/client/v4', re.I)
        deploy = re.compile(r'\bwrangler\s+deploy\b', re.I)
        for block in run_blocks(WORKFLOW.read_text(encoding='utf-8')):
            for raw in block.splitlines():
                line = raw.strip()
                if not line or line.startswith('#'):
                    continue
                if mutation.search(line):
                    findings.add(Finding('LIVE_MUTATION_COMMAND', relative(WORKFLOW)))
                if deploy.search(line) and '--dry-run' not in line:
                    findings.add(Finding('LIVE_DEPLOY_COMMAND', relative(WORKFLOW)))
    return sorted(findings)


def main() -> int:
    findings = scan()
    if findings:
        for finding in findings:
            print(finding.emit())
        return 1
    print('NATIVE_SHARING_CLOUDFLARE_SECURITY_SCAN=PASS')
    return 0

if __name__ == '__main__':
    sys.exit(main())
