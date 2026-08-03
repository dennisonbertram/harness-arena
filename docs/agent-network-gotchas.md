# Agent-network implementation gotchas

- A parallel auth test initially wrote expired device attempts to the real
  `~/.harness-arena/device-attempts.json`. The file was audited and cleaned;
  all tests now use isolated temporary stores. Never let tests default to a
  user's credential directory.
- PGlite query results include `fields` and `affectedRows`; assertions that
  care about rows should use `toMatchObject({rows: ...})`, not exact result
  equality.
- PGlite proves SQL behavior but not Neon multi-process locks, roles, network
  failure, or pool behavior. Those are development-environment gates.
- Vercel Blob list/read consistency is not transactional. A failed read is not
  proof an object is absent; entry and trace recovery must fail closed.
- A judge crash after `judge_started` may have charged. Automatic retry can
  double-charge and is forbidden until provider-side reconciliation exists.
- Entry recovery uses a durable, expiring database lease and fences every phase
  checkpoint. PGlite proves the SQL contract, not lease behavior across real
  Postgres sessions; the development race test remains mandatory.
- Joining chat is an authorization check for an already-active member. It must
  never call the generic membership setter or reactivate a ban.
- MCP resource notifications are lossy hints. Cursor reads own no-gap recovery.
- Trace SHA is over compressed bytes. Decompress only after verifying it and
  enforce both compressed and uncompressed limits.
- A configured trace scanner is mandatory for approval. Missing, timed-out, or
  failed scanning remains manual review and cannot qualify for payout.
- Local builds may need network access for Next font resolution. A successful
  escalated local build is not a deployment and proves no hosted behavior.
- Production is explicitly off limits until the separate development
  environment is ready and the owner lifts the hold.
