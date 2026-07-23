from __future__ import annotations

import argparse
import json
import re
from dataclasses import dataclass
from pathlib import Path
from typing import Iterable, Iterator

RULE_INFRA_WRANGLER_MUTATION = "INFRA_WRANGLER_MUTATION"
RULE_INFRA_DATABASE_BINDING = "INFRA_DATABASE_BINDING"
RULE_INFRA_DURABLE_OBJECT_BINDING = "INFRA_DURABLE_OBJECT_BINDING"
RULE_INFRA_MIGRATION_BINDING = "INFRA_MIGRATION_BINDING"
RULE_GOOGLE_INTERNAL_ENDPOINT = "GOOGLE_INTERNAL_ENDPOINT"
RULE_GOOGLE_SESSION_CREDENTIAL = "GOOGLE_SESSION_CREDENTIAL"
RULE_LEGACY_GOOGLE_SHARED_SOURCE = "LEGACY_GOOGLE_SHARED_SOURCE"
RULE_VIEWER_CAPABILITY_IN_URL = "VIEWER_CAPABILITY_IN_URL"
RULE_PERSISTENT_VIEWER_TOKEN = "PERSISTENT_VIEWER_TOKEN"
RULE_SENSITIVE_LOGGING = "SENSITIVE_LOGGING"
RULE_SHARED_ROUTE_ANALYTICS = "SHARED_ROUTE_ANALYTICS"
RULE_PRIVATE_KEY_MATERIAL = "PRIVATE_KEY_MATERIAL"

PRODUCT_ROOTS = (
    "native-sharing/src",
    "src/app/share",
    "src/app/shared",
    "src/components/mobile",
    "src/lib/location-source",
    "out",
)
SHARED_ANALYTICS_ROOTS = (
    "src/app/shared",
    "src/components/mobile/NativeViewerApp.tsx",
    "src/lib/location-source/use-native-viewer.ts",
    "out/shared",
    "out/shared.html",
)
WORKFLOW_PATH = ".github/workflows/native-location-sharing-v1.yml"
SELF_PATH = "scripts/security/native-sharing-release-scan.py"
FIXTURE_PREFIX = "tests/security/fixtures/native-sharing-release-scan"
EXCLUDED_DIRECTORY_NAMES = {
    ".git", ".next", "node_modules", "__pycache__", "coverage",
    ".cache", ".turbo", "artifacts", "tmp", "temp",
}
TEXT_SUFFIXES = {
    ".cjs", ".css", ".html", ".js", ".json", ".jsonc", ".jsx",
    ".mjs", ".toml", ".ts", ".tsx", ".yaml", ".yml",
}
SENSITIVE_LOG_TERMS = re.compile(
    r"\b(?:emitter(?:Token)?|viewer(?:Session)?Token|viewerCapability|capability|authorization|cookie)\b",
    re.IGNORECASE,
)

@dataclass(frozen=True, order=True)
class Finding:
    rule_id: str
    file_path: str

    def public_payload(self) -> dict[str, str]:
        return {"ruleId": self.rule_id, "filePath": self.file_path}


def _relative(root: Path, path: Path) -> str:
    return path.resolve().relative_to(root.resolve()).as_posix()


def _is_excluded(relative_path: str) -> bool:
    parts = Path(relative_path).parts
    if relative_path == SELF_PATH or relative_path.startswith(f"{FIXTURE_PREFIX}/"):
        return True
    return any(part in EXCLUDED_DIRECTORY_NAMES for part in parts)


def _read_text(path: Path) -> str:
    return path.read_text(encoding="utf-8", errors="replace")


def _iter_files(root: Path, relative_root: str) -> Iterator[Path]:
    candidate = root / relative_root
    if candidate.is_file():
        if not _is_excluded(relative_root):
            yield candidate
        return
    if not candidate.is_dir():
        return
    for path in sorted(candidate.rglob("*")):
        if not path.is_file():
            continue
        relative_path = _relative(root, path)
        if _is_excluded(relative_path):
            continue
        if path.suffix.lower() in TEXT_SUFFIXES:
            yield path


def _strip_c_like_comments(text: str) -> str:
    output: list[str] = []
    index = 0
    quote: str | None = None
    escaped = False
    line_comment = False
    block_comment = False
    while index < len(text):
        char = text[index]
        nxt = text[index + 1] if index + 1 < len(text) else ""
        if line_comment:
            if char == "\n":
                line_comment = False
                output.append(char)
            index += 1
            continue
        if block_comment:
            if char == "*" and nxt == "/":
                block_comment = False
                index += 2
            else:
                if char == "\n":
                    output.append(char)
                index += 1
            continue
        if quote is not None:
            output.append(char)
            if escaped:
                escaped = False
            elif char == "\\":
                escaped = True
            elif char == quote:
                quote = None
            index += 1
            continue
        if char in {"'", '"', "`"}:
            quote = char
            output.append(char)
            index += 1
            continue
        if char == "/" and nxt == "/":
            line_comment = True
            index += 2
            continue
        if char == "/" and nxt == "*":
            block_comment = True
            index += 2
            continue
        output.append(char)
        index += 1
    return "".join(output)


def _strip_markup_comments(text: str) -> str:
    return re.sub(r"<!--.*?-->", "", text, flags=re.DOTALL)


def _strip_config_comments(path: Path, text: str) -> str:
    if path.suffix.lower() in {".json", ".jsonc"}:
        return _strip_c_like_comments(text)
    if path.suffix.lower() == ".toml":
        return "\n".join(line for line in text.splitlines() if not line.lstrip().startswith("#"))
    return text


def _product_text(path: Path, text: str) -> str:
    if path.suffix.lower() in {".js", ".jsx", ".mjs", ".cjs", ".ts", ".tsx", ".json", ".jsonc", ".css"}:
        return _strip_c_like_comments(text)
    if path.suffix.lower() == ".html":
        return _strip_markup_comments(text)
    return text


def _iter_console_arguments(text: str) -> Iterator[str]:
    call = re.compile(r"\bconsole\s*\.\s*(?:log|info|debug|warn|error)\s*\(", re.IGNORECASE)
    for match in call.finditer(text):
        start = match.end()
        index = start
        depth = 1
        quote: str | None = None
        escaped = False
        while index < len(text) and depth > 0:
            char = text[index]
            if quote is not None:
                if escaped:
                    escaped = False
                elif char == "\\":
                    escaped = True
                elif char == quote:
                    quote = None
                index += 1
                continue
            if char in {"'", '"', "`"}:
                quote = char
            elif char == "(":
                depth += 1
            elif char == ")":
                depth -= 1
                if depth == 0:
                    yield text[start:index]
                    break
            index += 1


def _contains_sensitive_console_call(text: str) -> bool:
    return any(SENSITIVE_LOG_TERMS.search(arguments) for arguments in _iter_console_arguments(text))


def _add(findings: set[Finding], rule_id: str, root: Path, path: Path) -> None:
    findings.add(Finding(rule_id, _relative(root, path)))


def _scan_product_file(root: Path, path: Path, findings: set[Finding]) -> None:
    relative_path = _relative(root, path)
    text = _product_text(path, _read_text(path))
    lowered = text.lower()
    if re.search(r"locationsharing\s*/\s*read|google\.com/maps/rpc/locationsharing", lowered):
        _add(findings, RULE_GOOGLE_INTERNAL_ENDPOINT, root, path)
    if re.search(r"\bgoogle-shared\b", lowered):
        _add(findings, RULE_LEGACY_GOOGLE_SHARED_SOURCE, root, path)
    credential_pattern = re.compile(
        r"(?i)(?:^|[;,\{\s])(?:SID|HSID|SSID|APISID|SAPISID)\s*[:=]\s*['\"][A-Za-z0-9._-]{8,}['\"]"
    )
    cookie_header_pattern = re.compile(r"(?i)\bCookie\s*:\s*['\"][^'\"]*(?:SID|HSID|SSID|APISID|SAPISID)=")
    if credential_pattern.search(text) or cookie_header_pattern.search(text):
        _add(findings, RULE_GOOGLE_SESSION_CREDENTIAL, root, path)
    capability_url_patterns = (
        re.compile(r"(?i)/shared/(?:<[^>]*(?:capability|token)[^>]*>|\$\{[^}]*(?:capability|token)[^}]*\}|[A-Za-z0-9_-]{43}\.[A-Za-z0-9_-]{43})"),
        re.compile(r"(?i)/shared\?[^\s'\"`]*(?:token|capability)="),
        re.compile(r"(?i)[?&](?:token|capability)=\$?\{?"),
    )
    if any(pattern.search(text) for pattern in capability_url_patterns):
        _add(findings, RULE_VIEWER_CAPABILITY_IN_URL, root, path)
    persistent_pattern = re.compile(
        r"(?is)(?:\b(?:localStorage|sessionStorage)\s*\.\s*(?:setItem|getItem)\s*\([^)]*(?:viewer|capability|token)|\bindexedDB\b[^;\n]*(?:viewer|capability|token))"
    )
    if persistent_pattern.search(text):
        _add(findings, RULE_PERSISTENT_VIEWER_TOKEN, root, path)
    if _contains_sensitive_console_call(text):
        _add(findings, RULE_SENSITIVE_LOGGING, root, path)
    analytics_terms = re.compile(
        r"(?i)google-analytics|googletagmanager|segment\.com|sentry|plausible|matomo|mixpanel"
    )
    if any(relative_path == item or relative_path.startswith(f"{item}/") for item in SHARED_ANALYTICS_ROOTS):
        if analytics_terms.search(text):
            _add(findings, RULE_SHARED_ROUTE_ANALYTICS, root, path)
    if re.search(r"-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----", text):
        _add(findings, RULE_PRIVATE_KEY_MATERIAL, root, path)


def _iter_wrangler_configs(root: Path) -> Iterator[Path]:
    for path in sorted(root.rglob("wrangler*")):
        if not path.is_file() or path.suffix.lower() not in {".json", ".jsonc", ".toml"}:
            continue
        relative_path = _relative(root, path)
        if not _is_excluded(relative_path):
            yield path


def _scan_cloudflare_config(root: Path, path: Path, findings: set[Finding]) -> None:
    text = _strip_config_comments(path, _read_text(path))
    if re.search(r"(?m)^\s*database_id\s*=|['\"]database_id['\"]\s*:", text):
        _add(findings, RULE_INFRA_DATABASE_BINDING, root, path)
    if re.search(r"(?m)^\s*\[durable_objects(?:\.[^\]]+)?\]\s*$|['\"]durable_objects['\"]\s*:", text):
        _add(findings, RULE_INFRA_DURABLE_OBJECT_BINDING, root, path)
    if re.search(r"(?m)^\s*\[\[?migrations(?:\.[^\]]+)?\]\]?\s*$|['\"]migrations['\"]\s*:", text):
        _add(findings, RULE_INFRA_MIGRATION_BINDING, root, path)


def _extract_run_blocks(workflow_text: str) -> list[str]:
    lines = workflow_text.splitlines()
    blocks: list[str] = []
    index = 0
    while index < len(lines):
        match = re.match(r"^(\s*)(?:-\s*)?run\s*:\s*(.*)$", lines[index])
        if not match:
            index += 1
            continue
        base_indent = len(match.group(1))
        value = match.group(2).strip()
        if value not in {"|", ">", "|-", ">-", "|+", ">+"}:
            blocks.append(value.strip("'\""))
            index += 1
            continue
        index += 1
        block_lines: list[str] = []
        while index < len(lines):
            candidate = lines[index]
            if candidate.strip() and len(candidate) - len(candidate.lstrip()) <= base_indent:
                break
            block_lines.append(candidate[base_indent + 2 :] if len(candidate) > base_indent else "")
            index += 1
        blocks.append("\n".join(block_lines))
    return blocks


def _effective_shell_lines(block: str) -> Iterable[str]:
    heredoc_end: str | None = None
    for raw_line in block.splitlines():
        stripped = raw_line.strip()
        if heredoc_end is not None:
            if stripped == heredoc_end:
                heredoc_end = None
            continue
        heredoc = re.search(r"<<-?\s*['\"]?([A-Za-z_][A-Za-z0-9_]*)['\"]?", stripped)
        if heredoc:
            heredoc_end = heredoc.group(1)
        if stripped and not stripped.startswith("#"):
            yield stripped


def _scan_workflow(root: Path, path: Path, findings: set[Finding]) -> None:
    if not path.is_file():
        return
    mutation_pattern = re.compile(
        r"(?:^|[;&|]\s*)(?:[A-Za-z_][A-Za-z0-9_]*=[^\s]+\s+)*(?:bunx\s+|npx\s+|pnpm\s+exec\s+)?wrangler\s+(?:deploy|publish|versions\s+upload)\b|"
        r"(?:^|[;&|]\s*)gh\s+pr\s+merge\b|"
        r"(?:^|[;&|]\s*)git\s+push\b[^\n]*(?:--force|-f)(?:\s|$)",
        flags=re.IGNORECASE,
    )
    for block in _extract_run_blocks(_read_text(path)):
        for line in _effective_shell_lines(block):
            if mutation_pattern.search(line):
                _add(findings, RULE_INFRA_WRANGLER_MUTATION, root, path)
                return


def scan_repository(root: Path) -> list[Finding]:
    root = root.resolve()
    findings: set[Finding] = set()
    for relative_root in PRODUCT_ROOTS:
        for path in _iter_files(root, relative_root):
            _scan_product_file(root, path, findings)
    for path in _iter_wrangler_configs(root):
        _scan_cloudflare_config(root, path, findings)
    _scan_workflow(root, root / WORKFLOW_PATH, findings)
    return sorted(findings)


def emit_findings(findings: Iterable[Finding]) -> None:
    for finding in findings:
        print(json.dumps(finding.public_payload(), separators=(",", ":"), sort_keys=True))


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(add_help=True)
    parser.add_argument("--root", default=".")
    args = parser.parse_args(argv)
    findings = scan_repository(Path(args.root))
    if findings:
        emit_findings(findings)
        return 1
    print("SECURITY_RELEASE_SCAN=PASS")
    return 0
