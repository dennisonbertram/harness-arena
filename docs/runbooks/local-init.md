# Safe local startup

Run `./scripts/init.sh` from the worktree root. Its JSON output has the URL,
PID, local storage directory, and log file. Node.js 20.9.0 or newer is
required. The process uses `STORAGE=file`;
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
