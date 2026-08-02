# Safe local startup

Run `./scripts/init.sh` from the worktree root. Its JSON output has the URL,
PID, local storage directory, and log file. The process uses `STORAGE=file`;
it does not use Blob or production variables. `/api/ready` is the startup gate
and checks both harness and voice storage, so an open port alone is not ready.

Use `--check` for prerequisite/port/PID validation without side effects and
`--no-install` for an already-installed worktree. To stop, terminate the
reported PID and remove `.harness-arena/init.pid`. To reset development data,
then run `./scripts/init.sh --reset`; reset is explicit and only deletes that
worktree's `.harness-arena/local-data` directory. Do not use production cleanup
or Blob scripts for local development.
