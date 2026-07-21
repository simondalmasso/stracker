# STRACKER — Vector Map Performance V1

## Budgets

The machine-readable budgets live in:

```text
docs/performance/VECTOR_MAP_BUDGETS.json
```

The budgets cover:

- transferred bytes;
- first map visible and interactive times;
- map-provider request and byte counts;
- estimated FPS;
- long tasks;
- heap growth after repeated synthetic updates;
- maximum in-memory GhostRail points;
- WebGL fallback order.

Budgets are guardrails, not claims of physical-device performance.

## Raw evidence

CI produces two sanitized artifacts for the exact PR head:

```text
stracker-vector-map-spike-<SHA>
stracker-vector-map-mobile-qa-<SHA>
```

The renderer spike contains only local synthetic GeoJSON and package/runtime measurements. The mobile QA artifact contains aggregate performance numbers and request host/count/byte data. Neither artifact may contain cookies, authorization headers, service tokens or real coordinates.

```text
PERFORMANCE_BUDGETS_DEFINED=PASS
PERFORMANCE_RAW_RESULTS_SAVED=PASS only when both current-head artifacts exist
```

## Metrics

### Renderer spike

- package version;
- JavaScript/CSS file bytes;
- load and idle time;
- WebGL renderer availability;
- 3D fill-extrusion availability;
- camera result;
- estimated FPS;
- long tasks and duration;
- optional JS heap size;
- unexpected external requests.

### Mobile product QA

- required viewport;
- page and console errors;
- horizontal overflow;
- touch targets;
- provider request count;
- transferred bytes visible to Resource Timing;
- selector-to-map elapsed time;
- source isolation and late-response behavior;
- WebGL context loss/recovery behavior.

## Memory bound

GhostRail is bounded to 600 accepted points in memory. Rejected points and metadata-only dead-zone observations are not appended. Source changes and shared-session replacement clear the pipeline.

The browser QA emits repeated synthetic readings and compares heap usage when `performance.memory` is available. Absence of that Chromium-only API is recorded honestly rather than converted to PASS.

```text
NO_UNBOUNDED_MEMORY_GROWTH=PASS
```

requires both the structural 600-point cap and a current-head browser stress result within the configured heap-growth budget.

## WebGL fallback

The fallback sequence is deterministic:

1. reduce pitch;
2. reduce 3D building density;
3. disable terrain;
4. simplify effects;
5. retain MapLibre vector 2D.

This release does not enable terrain, so step 3 is already satisfied. Context loss disables 3D and reduces pitch before the map is restored. The source selector is not reopened during context recovery.

## Samsung Galaxy A22 4G

No physical Samsung Galaxy A22 4G is connected to the validation environment.

```text
A22_PHYSICAL_VALIDATION=NOT_EXECUTED_ENV_BLOCKED
PHYSICAL_DEVICE_EVIDENCE_HONEST=PASS
```

The CI artifact includes the exact viewport/throttling checklist for later physical execution. Emulator or desktop throttling evidence must not be relabeled as physical A22 evidence.
