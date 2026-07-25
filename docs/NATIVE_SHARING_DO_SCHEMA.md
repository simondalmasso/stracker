# Native Sharing Durable Object Schema

Each `SESSION_ID` maps deterministically to one SQLite-backed `NativeSharingDurableObject`. No table contains data from another session.

## sharing_session

Single-row session metadata: hashed emitter capability, hashed viewer capability, viewer generation, state, creation/expiry/revocation timestamps, latest accepted sequence/timestamps and bounded point count.

## points

Accepted points keyed by monotonic sequence with coordinates, accuracy, speed, heading, captured/received timestamps and a confirmed GhostRail segment index. The server assigns the segment index; the client cannot declare a segment valid.

## viewer_sessions

Only opaque viewer-session verifiers are stored. Rows include the sharing session ID, generation, creation/expiry and revocation timestamps. Rotation increments generation and revokes all older rows atomically within the object.

## Indexes

Indexes cover segment/sequence reads and active viewer generation/expiry. Critical state is persisted to SQLite before a successful RPC result. No KV-backed Durable Object storage API is used.
