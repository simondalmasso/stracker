#!/usr/bin/env python3
from __future__ import annotations

import json
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


def patch_package() -> None:
    path = ROOT / "package.json"
    data = json.loads(path.read_text(encoding="utf-8"))
    scripts = data["scripts"]
    scripts["lint"] = "eslint src/app/page.tsx src/components/mobile src/lib/location-source"
    scripts["build"] = "prisma generate && next build"
    scripts["build:export"] = "prisma generate && BUILD_EXPORT=1 next build"
    path.write_text(json.dumps(data, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")


def main() -> None:
    patch_package()


if __name__ == "__main__":
    main()
