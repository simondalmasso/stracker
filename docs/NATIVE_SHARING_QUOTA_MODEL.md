# Native Sharing Quota Model

STRACKER applies product limits below Cloudflare Free-plan limits and never upgrades automatically or falls back to paid infrastructure.

```text
MAX_SESSION_DURATION=4h
MAX_POINTS_PER_SESSION=2880
MAX_POINTS_RETURNED=600
MIN_PUBLISH_INTERVAL=5s
MAX_ACTIVE_VIEWER_SESSIONS=16
VIEWER_SESSION_TTL=10m
EXPIRATION_GRACE=60s
DELETE_AFTER_EXPIRATION=24h
MAX_GHOSTRAIL_SEGMENTS=64
MAX_REQUEST_BODY=16KiB
RPC_TIMEOUT=1500ms
```

Quota exhaustion rejects the operation without silently deleting accepted data. Storage-full and storage-unavailable errors are sanitized and fail closed. Expired/revoked sessions immediately reject reads and writes. Cleanup removes expired viewer sessions and deletes session data after the retention boundary.

Cloudflare Free is a mandatory deployment condition. Paid overage, paid fallback and automatic plan upgrades are prohibited.
