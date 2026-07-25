#!/usr/bin/env python3
from __future__ import annotations

import argparse
import json
import re
import sys
from dataclasses import dataclass
from pathlib import Path


@dataclass(frozen=True, order=True)
class Finding:
    rule_id: str
    file_path: str

    def emit(self) -> str:
        return json.dumps({'ruleId': self.rule_id, 'filePath': self.file_path}, separators=(',', ':'), sort_keys=True)


def strip_jsonc(text: str) -> str:
    text = re.sub(r'/\*.*?\*/', '', text, flags=re.S)
    return re.sub(r'(^|\s)//.*$', '', text, flags=re.M)


def relative(root: Path, path: Path) -> str:
    return path.relative_to(root).as_posix()


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
            blocks.append(value.strip('"\''))
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


def scan_config(root: Path, config_path: Path) -> list[Finding]:
    findings: set[Finding] = set()
    config_rel = relative(root, config_path)
    try:
        config = json.loads(strip_jsonc(config_path.read_text(encoding='utf-8')))
    except Exception:
        return [Finding('WRANGLER_CONFIG_INVALID', config_rel)]

    exports = config.get('exports')
    migrations_present = 'migrations' in config
    if exports is not None and migrations_present:
        findings.add(Finding('EXPORTS_AND_MIGRATIONS_COEXIST', config_rel))
    if migrations_present:
        findings.add(Finding('MIGRATIONS_PRESENT', config_rel))
    expected_exports = {
        'NativeSharingDurableObject': {
            'type': 'durable-object',
            'storage': 'sqlite',
        },
    }
    if exports != expected_exports:
        findings.add(Finding('EXPORTS_SQLITE_INVALID', config_rel))

    if config.get('workers_dev') is not False or config.get('preview_urls') is not False:
        findings.add(Finding('ROUTABLE_CONFIG', config_rel))
    if config.get('observability', {}).get('enabled') is not False:
        findings.add(Finding('OBSERVABILITY_ENABLED', config_rel))
    if any(key in config for key in ('routes', 'route', 'account_id', 'zone_id')):
        findings.add(Finding('REAL_ROUTE_OR_ACCOUNT', config_rel))
    if config.get('vars') or config.get('secrets'):
        findings.add(Finding('REAL_SECRET_BINDING', config_rel))

    assets = config.get('assets', {})
    worker_first = set(assets.get('run_worker_first', []))
    if not {'/api/share/*', '/shared', '/shared/*'}.issubset(worker_first):
        findings.add(Finding('WORKER_FIRST_BOUNDARY_INVALID', config_rel))
    if assets.get('binding') != 'ASSETS' or assets.get('directory') != '../out':
        findings.add(Finding('STATIC_ASSETS_BINDING_INVALID', config_rel))

    bindings = config.get('durable_objects', {}).get('bindings', [])
    if bindings != [{'name': 'NATIVE_SHARING', 'class_name': 'NativeSharingDurableObject'}]:
        findings.add(Finding('DO_BINDING_INVALID', config_rel))
    return sorted(findings)


def scan_repository(root: Path) -> list[Finding]:
    source_root = root / 'native-sharing-cloudflare'
    config_path = source_root / 'wrangler.jsonc'
    workflow = root / '.github/workflows/native-sharing-cloudflare-runtime-v1.yml'
    shared_headers = root / 'public/_headers'
    findings: set[Finding] = set(scan_config(root, config_path))

    executable = [
        path for path in source_root.rglob('*')
        if path.is_file() and path.suffix in {'.ts', '.js', '.json', '.jsonc'}
    ]
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
                findings.add(Finding(rule_id, relative(root, path)))

    if not shared_headers.is_file():
        findings.add(Finding('SHARED_HEADERS_MISSING', relative(root, shared_headers)))
    else:
        headers = shared_headers.read_text(encoding='utf-8', errors='replace')
        required = (
            '/shared',
            'Cache-Control: no-store, max-age=0',
            'Referrer-Policy: no-referrer',
            "frame-ancestors 'none'",
            "base-uri 'none'",
            'Permissions-Policy: geolocation=(), camera=(), microphone=()',
            'X-Robots-Tag: noindex, nofollow, noarchive, nosnippet',
        )
        if any(value not in headers for value in required):
            findings.add(Finding('SHARED_HEADERS_INVALID', relative(root, shared_headers)))

    if workflow.is_file():
        wrangler = r'wrangler(?:@[A-Za-z0-9._-]+)?'
        mutation = re.compile(
            rf'\b{wrangler}\s+(?:versions\s+upload|publish)\b|\bgh\s+pr\s+merge\b|'
            r'\bgit\s+push\b[^\n]*(?:--force|-f)|api\.cloudflare\.com/client/v4',
            re.I,
        )
        deploy = re.compile(rf'\b{wrangler}\s+deploy\b', re.I)
        for block in run_blocks(workflow.read_text(encoding='utf-8')):
            for raw in block.splitlines():
                line = raw.strip()
                if not line or line.startswith('#'):
                    continue
                if mutation.search(line):
                    findings.add(Finding('LIVE_MUTATION_COMMAND', relative(root, workflow)))
                if deploy.search(line) and '--dry-run' not in line:
                    findings.add(Finding('LIVE_DEPLOY_COMMAND', relative(root, workflow)))
    return sorted(findings)


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument('--root', type=Path, default=Path(__file__).resolve().parents[2])
    parser.add_argument('--config-only', action='store_true')
    args = parser.parse_args()
    root = args.root.resolve()
    findings = scan_config(root, root / 'native-sharing-cloudflare/wrangler.jsonc') if args.config_only else scan_repository(root)
    if findings:
        for finding in findings:
            print(finding.emit())
        return 1
    print('NATIVE_SHARING_CLOUDFLARE_SECURITY_SCAN=PASS')
    return 0


if __name__ == '__main__':
    sys.exit(main())
