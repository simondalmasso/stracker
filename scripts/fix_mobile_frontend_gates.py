#!/usr/bin/env python3
from __future__ import annotations

import json
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


def patch_mobile_app() -> None:
    path = ROOT / "src/components/mobile/MobileLocationApp.tsx"
    text = path.read_text(encoding="utf-8")
    text = text.replace(
        "import { useCallback, useEffect, useMemo, useRef, useState } from 'react'",
        "import { useCallback, useMemo, useRef, useState } from 'react'",
    )
    old = '''export default function MobileLocationApp() {\n  const [flow, setFlow] = useState<ProductFlow>('SELECTING_SOURCE')\n  const [source, setSource] = useState<LocationSource | null>(null)\n  const [showSharedImporter, setShowSharedImporter] = useState(false)\n  const myLocation = useMyLocation()\n  const shared = useSharedLocation()\n\n  useEffect(() => {\n    const stored = window.localStorage.getItem(SOURCE_KEY)\n    if (stored === 'my-device' || stored === 'google-shared') {\n      setSource(stored)\n    }\n  }, [])\n'''
    new = '''export default function MobileLocationApp() {\n  const [initialSource] = useState<LocationSource | null>(() => {\n    if (typeof window === 'undefined') return null\n    const stored = window.localStorage.getItem(SOURCE_KEY)\n    return stored === 'my-device' || stored === 'google-shared' ? stored : null\n  })\n  const [flow, setFlow] = useState<ProductFlow>(() =>\n    initialSource === 'my-device'\n      ? 'MY_LOCATION_FLOW'\n      : initialSource === 'google-shared'\n        ? 'SHARED_LOCATION_FLOW'\n        : 'SELECTING_SOURCE',\n  )\n  const [source, setSource] = useState<LocationSource | null>(initialSource)\n  const [showSharedImporter, setShowSharedImporter] = useState(false)\n  const myLocation = useMyLocation()\n  const shared = useSharedLocation()\n'''
    if old not in text:
        raise RuntimeError("MobileLocationApp state anchor not found")
    path.write_text(text.replace(old, new, 1), encoding="utf-8")


def patch_package() -> None:
    path = ROOT / "package.json"
    data = json.loads(path.read_text(encoding="utf-8"))
    scripts = data["scripts"]
    scripts["lint"] = "eslint src/app/page.tsx src/components/mobile src/lib/location-source"
    scripts["build"] = "prisma generate && next build"
    scripts["build:export"] = "prisma generate && BUILD_EXPORT=1 next build"
    path.write_text(json.dumps(data, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")


def main() -> None:
    patch_mobile_app()
    patch_package()


if __name__ == "__main__":
    main()
