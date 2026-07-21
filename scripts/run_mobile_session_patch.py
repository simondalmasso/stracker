from __future__ import annotations

import runpy
from pathlib import Path

path = Path(__file__).with_name("apply_mobile_session_backend.py")
text = path.read_text(encoding="utf-8")
early = '    if "COOKIES_PATH.write_text" in text:\n        raise SystemExit("plaintext cookie writer remains")\n'
if text.count(early) != 1:
    raise SystemExit("unexpected plaintext guard count")
text = text.replace(early, "", 1)
final = '    path.write_text(text, encoding="utf-8")\n    (ROOT / "nextjs-ui" / "tracker_map.py").write_text(text, encoding="utf-8")\n'
replacement = '    if "COOKIES_PATH.write_text" in text:\n        raise SystemExit("plaintext cookie writer remains")\n' + final
if text.count(final) != 1:
    raise SystemExit("final tracker write marker missing")
path.write_text(text.replace(final, replacement, 1), encoding="utf-8")
runpy.run_path(str(path), run_name="__main__")
