# STRACKER Cloudflare Migration

```text
FULL_CLOUDFLARE_CUTOVER=NO_GO
HYBRID_CLOUDFLARE_EDGE_PLUS_RENDER=PRELIMINARY_GO
```

## Rationale

The current Python process depends on a long-running HTTP server, threads, a continuous polling loop and mutable local files. That model cannot be lifted directly into Cloudflare Workers without redesign and parity testing.

## Next phase

Build an isolated PoC where Cloudflare provides:

- Access protection for the complete UI;
- a Worker gateway with `Cache-Control: no-store`;
- validated Access identity at the edge;
- `X-Stracker-Service-Token` authentication to the temporary Render ingestion runtime;
- sanitized observability and request IDs.

Render continues temporarily as ingestion runtime until Google RPC behavior, scheduling, persistence, GhostRail parity, costs, observability and rollback all pass explicit gates.

No Worker, binding, KV, D1, R2, Durable Object, DNS record or production route is created by P0.
