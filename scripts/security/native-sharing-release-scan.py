#!/usr/bin/env python3
from __future__ import annotations

import sys

from native_sharing_release_scan_core import *  # noqa: F401,F403
from native_sharing_release_scan_core import main


if __name__ == "__main__":
    sys.exit(main())
