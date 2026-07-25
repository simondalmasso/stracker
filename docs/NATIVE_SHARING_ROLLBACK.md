# Native Sharing Runtime Rollback

This branch performs no deployment. The future rollback unit is the Worker code version; persistent SQLite data is a separate state surface and is not reverted by code rollback.

Before any live phase, rollback must define:

1. the previously verified Worker version;
2. compatibility of that version with the current SQLite schema;
3. whether writes must be paused before rollback;
4. explicit retention and deletion handling;
5. smoke tests for session creation, publication, exchange, polling, rotation and revocation.

A code rollback must never restore a revoked capability or viewer generation. If schema compatibility is uncertain, traffic remains at zero and the runtime stays fail closed.
