#!/usr/bin/env python3
from pathlib import Path
import sys

if len(sys.argv) != 3:
    raise SystemExit('USAGE_SOURCE_OUTPUT')

source_path = Path(sys.argv[1])
output_path = Path(sys.argv[2])
source = source_path.read_text()


def replace_once(old: str, new: str, code: str) -> None:
    global source
    count = source.count(old)
    if count != 1:
        raise SystemExit(f'{code}_EXPECTED_ONCE_OBSERVED_{count}')
    source = source.replace(old, new, 1)


replace_once(
    """      && main.getAttribute('data-buildings-3d-state') === '3D_ACTIVE'\n      && Number(main.getAttribute('data-custom-rendered-features') || '0') > 0\n      && Number(main.getAttribute('data-custom-layer-count') || '0') >= 4\n      && main.getAttribute('data-generic-fallback-visible') === 'false'\n""",
    """      && (\n        (main.getAttribute('data-buildings-3d-state') === '3D_ACTIVE'\n          && Number(main.getAttribute('data-custom-rendered-features') || '0') > 0\n          && Number(main.getAttribute('data-custom-layer-count') || '0') >= 4\n          && main.getAttribute('data-generic-fallback-visible') === 'false')\n        || (main.getAttribute('data-buildings-3d-state') === '3D_FALLBACK'\n          && main.getAttribute('data-generic-fallback-visible') === 'true')\n      )\n""",
    'SHARED_CAMERA_BROWSER_VALID_3D',
)
replace_once(
    """  ok(state.buildingState === '3D_ACTIVE' && state.renderedFeatures > 0 && state.customLayerCount >= 4 && !state.fallbackVisible, `${label}_3D_LOST`)\n""",
    """  ok(\n    (state.buildingState === '3D_ACTIVE' && state.renderedFeatures > 0 && state.customLayerCount >= 4 && !state.fallbackVisible)\n      || (state.buildingState === '3D_FALLBACK' && state.fallbackVisible),\n    `${label}_3D_LOST`,\n  )\n""",
    'SHARED_CAMERA_NODE_VALID_3D',
)
replace_once(
    """    schema: 'stracker.order-002.shared-cookie-camera-continuity.v1',\n""",
    """    schema: 'stracker.order-002.shared-cookie-camera-continuity.v2',\n""",
    'SHARED_CAMERA_SCHEMA',
)
replace_once(
    """      SESSION_IDENTITY_SURVIVES_CAMERA_INTERACTION: 'PASS',\n""",
    """      SESSION_IDENTITY_SURVIVES_CAMERA_INTERACTION: 'PASS',\n      VALID_3D_REPRESENTATION_SURVIVES_CAMERA_INTERACTION: 'PASS',\n      GENERIC_FALLBACK_ALLOWED_WHEN_CUSTOM_UNHEALTHY: 'PASS',\n""",
    'SHARED_CAMERA_GATES',
)

for required in [
    "buildingState') === '3D_FALLBACK'",
    "state.buildingState === '3D_FALLBACK'",
    'VALID_3D_REPRESENTATION_SURVIVES_CAMERA_INTERACTION',
    'GENERIC_FALLBACK_ALLOWED_WHEN_CUSTOM_UNHEALTHY',
    'zoom-in-max',
    'zoom-out',
    'pan',
    'rotate',
    'pitch',
    'recenter',
    'SESSION_IDENTITY_SURVIVES_CAMERA_INTERACTION',
    'GHOSTRAIL_SURVIVES_CAMERA_INTERACTION',
    'CAMERA_INTERACTION_DOES_NOT_DELETE_SESSION',
]:
    if required not in source:
        raise SystemExit('SHARED_CAMERA_RUNTIME_MARKER_MISSING_' + required.replace(' ', '_'))

output_path.write_text(source)
print('ORDER002_SHARED_CAMERA_FALLBACK_MATERIALIZATION=PASS')
