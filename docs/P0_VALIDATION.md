# P0 Validation Evidence

Validation ran in clean GitHub Actions checkouts. No production endpoint, deployment or secret store was modified.

```text
BASE_SHA=923cac9c9bcc0b7e05701dd1018e61a454d0f478
IMPLEMENTATION_RUN=29825436822
FINAL_HARDENING_RUN=29825998483
PRODUCTION_MODIFIED=NO
DEPLOYMENT_EXECUTED=NO
```

## Backend gates

| Command | Result | Exact status |
|---|---|---|
| `python -m py_compile tracker_map.py nextjs-ui/tracker_map.py stracker_security.py tests/test_p0_security.py` | PASS | exit 0 |
| `python -m unittest discover -s tests -p test_*.py -v` | PASS | exit 0; tests=11 |
| `cmp tracker_map.py nextjs-ui/tracker_map.py` | PASS | exit 0 |
| `git diff --check` | PASS | exit 0 |

## Frozen dependency gate

| Checkout | Command | Exit | Classification | Missing entries | Invalid entries |
|---|---|---:|---|---:|---:|
| Base | `npm ci --ignore-scripts` | 1 | NPM_CI_EUSAGE_NO_NPM_LOCKFILE | 0 | 0 |
| Candidate | `npm ci --ignore-scripts` | 1 | NPM_CI_EUSAGE_NO_NPM_LOCKFILE | 0 | 0 |

`npm ci` fails with EUSAGE because neither `package-lock.json` nor `npm-shrinkwrap.json` exists; the only committed JavaScript lockfile is `bun.lock`. Base and candidate have the same files and exit code, so this is a preexisting package-manager mismatch rather than a P0 regression. Package names and raw logs are omitted.

## Ephemeral frontend comparison

Because the frozen gate fails, these checks use `npm install --ignore-scripts --package-lock=false` only inside disposable runners. This is not a release build.

| Check | Classification | Base exit | Candidate exit |
|---|---|---:|---:|
| `npm_install` | PASS | 0 | 0 |
| `lint` | PREEXISTING_FAIL | 2 | 2 |
| `typecheck` | PREEXISTING_FAIL | 2 | 2 |
| `build` | PREEXISTING_FAIL | 1 | 1 |

## Integrity and scope

- Browser-generated Bearer token code removed from the active source path.
- Sensitive endpoint exceptions return generic client errors.
- Production impact: none.
- Deployment: not executed.
