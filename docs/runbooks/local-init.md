# Safe local startup

Run `./scripts/init.sh` from the worktree root. Its JSON output has the URL,
PID, local storage directory, and log file. Node.js
`^20.19.0 || >=22.12.0` is required. The process uses `STORAGE=file`;
it does not use Blob or production variables. `/api/ready` is the startup gate
and matches the owner PID/nonce while checking the seed and a real storage
write, so an open port alone is not ready. Concurrent or repeat invocations
wait on the same immutable claim queue and report the existing healthy
instance. Each contender fsyncs a unique owner record before atomically
publishing its `.claim`; unpublished temp records do not participate, and
dead claims are removed only through their never-reused claim pathname.
Queue selection is advisory until the contender atomically hard-links its
unique immutable owner record into the stable owner fence. A late lower claim
cannot enter while that fence is owned. Recovery first hard-links the dead
fence inode to a unique, PID-scoped pin, revalidates token and inode, and
refuses live owners; new ownership stays blocked until all live recovery pins
have finished, while dead pins are removed only by their exact unique paths.
Cold-start contenders wait at most 120 seconds for installation, seed, and
readiness before emitting the queue's bounded blocker diagnostics. The
launcher owns each detached prerequisite process group until the whole group
is reaped. `SIGINT` and `SIGTERM` interrupt that work with a bounded
TERM-then-KILL escalation, wait for the group, release init lifecycle state,
and then preserve the original signal exit. `SIGKILL` cannot be intercepted;
recovery from an init process killed that way requires an external OS-level
supervisor. The
detached wrapper fsyncs its `init.pid` ownership and handshakes it to the
launcher before Next starts, so launcher failure cannot leave an untracked
server. Init-managed environment and seed files, plus write-once local voice
judgments, use fsynced unique temp files and atomic no-replace publication.

The child environment is a strict allowlist. Every key discovered in Next's
development `.env*` inputs is preempted before startup and removed after Next
loads configuration. `STORAGE=file` fails closed in production and Vercel.
The localhost/loopback init URL is not reachable from Vercel Sandbox, so it is
not a valid `CALLBACK_BASE` for a Sandbox run. Sandbox-backed
testing requires the separately provisioned canonical, publicly reachable
HTTPS origin of the isolated Development deployment; never substitute a live
or production origin.

Init selects `HARNESS_EXECUTION_MODE=deterministic-success`, a seeded local
development identity, one run per submission, and an ephemeral local callback
secret in its sanitized child environment. It refuses `main`, detached HEAD,
unknown deterministic scenarios, any Vercel runtime, and non-file storage.
The adapter enters through the normal dispatcher and invokes the existing
authenticated callback and trace route contracts in-process. It emits the
task manifest's complete lifecycle, trace files, zero-cost terminal totals,
and no external network or model requests.

Run the complete real-HTTP and persisted-file proof with one command:

```sh
./scripts/init.sh --smoke
```

The JSON result includes the submission/run IDs, terminal state, event/task
counts, zero model cost, and storage path. The smoke fails if readiness,
lifecycle ordering, terminal totals, traces, or the persisted run/event files
are missing. For direct failure-path testing, set
`HARNESS_DETERMINISTIC_SCENARIO` to `task-failure`, `callback-failure`,
`stale-reap`, or `budget-exceeded` before a fresh init start. These are local
fixtures; their virtual failure/cost records are not billed execution.

`./scripts/init.sh --real-sandbox-smoke` is a separate, explicit credential and
creation probe. It accepts only the isolated Development project ID, refuses
`main`, creates a short-lived Node sandbox with deny-all egress, runs one
harmless local command, and always permanently deletes the Sandbox (including its snapshots and sessions). It performs no callback, model
request, benchmark run, or Blob/application data access. It requires locally
scoped `VERCEL_TOKEN`, `VERCEL_TEAM_ID`, and the isolated Development
`VERCEL_PROJECT_ID`; do not use live credentials or data. This probe does not
claim that localhost is reachable from Vercel Sandbox.

Use `--check` for read-only prerequisite/port/PID validation and `--no-install`
for an already-installed worktree. Check may run bounded prerequisite and port
probes, but it starts no persistent process and creates, deletes, or modifies
no state, lock, PID, or env file. Stale metadata is reported as
`stale_pid_detected` and is left untouched for a normal start or explicit
reset to recover. A live check authenticates by nonce to a local-only 204
identity handshake that is unavailable under production, Vercel, or non-file
storage; it never calls `/api/ready`. Normal reads may advance filesystem
access time, so the guarantee is no application write, creation, repair, or
deletion and no content, inode, mode, modification-time, or change-time
change. To stop, terminate the
reported PID/process group and wait for its ownership metadata to clear. Then
run `./scripts/init.sh --reset`; reset is explicit and only deletes that
worktree's `.harness-arena/local-data` directory after realpath/lstat
confinement checks. It refuses symlinks anywhere below state or local data and
fails closed when either current JSON metadata or a legacy numeric PID names a
live process; stale PID recovery is reported in the reset output. File and
voice storage likewise reject any symlink component before reading or mutating
local data. A readiness timeout
terminates the owned process group and retains secret-safe evidence in
`.harness-arena/init-failure.json` plus `.harness-arena/init.log`. Do not use
production cleanup or Blob scripts for local development.
