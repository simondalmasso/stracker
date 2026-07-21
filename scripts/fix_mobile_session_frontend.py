from pathlib import Path

path = Path("src/components/tracker/SessionGate.tsx")
text = path.read_text(encoding="utf-8")
needle = "  type SessionState,\n"
if text.count(needle) != 1:
    raise SystemExit(f"unexpected SessionState import count: {text.count(needle)}")
path.write_text(text.replace(needle, "", 1), encoding="utf-8")
