# P0 Validation Evidence

Validation ran in a clean GitHub Actions checkout. No production endpoint, deployment or secret store was modified.

## Backend gates

| Command | Result | Exact status |
|---|---|---|
| `python -m py_compile tracker_map.py nextjs-ui/tracker_map.py stracker_security.py tests/test_p0_security.py` | PASS | exit 0 |
| `python -m unittest discover -s tests -p test_*.py -v` | PASS | exit 0; tests=9 |

## Frontend comparison against BASE_SHA

| Check | Classification | Base exit | Candidate exit |
|---|---|---:|---:|
| `npm_ci` | PREEXISTING_FAIL | 1 | 1 |
| `lint` | PREEXISTING_FAIL | 125 | 125 |
| `typecheck` | PREEXISTING_FAIL | 125 | 125 |
| `build` | PREEXISTING_FAIL | 125 | 125 |

A candidate failure is classified as `PREEXISTING_FAIL` only when the same clean-environment check also failed on the exact base SHA. Raw logs are retained only in the ephemeral Actions runner and are not committed because they may contain noisy source excerpts.

## Integrity checks

- `tracker_map.py` and `nextjs-ui/tracker_map.py`: byte-identical after patch.
- `git diff --check`: required before commit.
- Production impact: none.
- Deployment: not executed.
