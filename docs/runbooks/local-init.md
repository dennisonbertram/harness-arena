# Safe local startup

Run `./scripts/init.sh` from the worktree root. Its JSON output has the URL,
PID, local storage directory, and log file. The process uses `STORAGE=file`;
it does not use Blob or production variables. `/api/ready` is the startup gate
and matches the owner PID/nonce while checking the seed and a real storage
write, so an open port alone is not ready. Concurrent or repeat invocations
wait on the same atomic lock and report the existing healthy instance.

The child environment is a strict allowlist. Every key discovered in Next's
development `.env*` inputs is preempted before startup and removed after Next
loads configuration. `STORAGE=file` fails closed in production and Vercel.

Use `--check` for prerequisite/port/PID validation without side effects and
`--no-install` for an already-installed worktree. To stop, terminate the
reported PID and remove `.harness-arena/init.pid`. To reset development data,
then run `./scripts/init.sh --reset`; reset is explicit and only deletes that
worktree's `.harness-arena/local-data` directory after realpath/lstat
confinement checks. It refuses symlinks anywhere below state or local data and
fails closed when either current JSON metadata or a legacy numeric PID names a
live process; stale PID recovery is reported in the reset output. File and
voice storage likewise reject any symlink component before reading or mutating
local data. A readiness timeout
terminates the owned process group and retains secret-safe evidence in
`.harness-arena/init-failure.json` plus `.harness-arena/init.log`. Do not use
production cleanup or Blob scripts for local development.
