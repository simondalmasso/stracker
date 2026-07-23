#!/usr/bin/env python3
from __future__ import annotations

import sys
from pathlib import Path

MODULE_DIRECTORY = Path(__file__).resolve().parent
if str(MODULE_DIRECTORY) not in sys.path:
    sys.path.insert(0, str(MODULE_DIRECTORY))

from native_sharing_release_scan_core import *  # noqa: F401,F403,E402
from native_sharing_release_scan_core import main  # noqa: E402


if __name__ == "__main__":
    sys.exit(main())
