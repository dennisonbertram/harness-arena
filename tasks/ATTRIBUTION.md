# Attribution

The tasks under this directory are vendored from the
[terminal-bench-2](https://github.com/laude-institute/terminal-bench-2)
project, pinned at commit `69671fbaac6d67a7ef0dfec016cc38a64ef7a77c`.

- Upstream repository: https://github.com/laude-institute/terminal-bench-2
- Pinned commit: 69671fbaac6d67a7ef0dfec016cc38a64ef7a77c
- License: Apache License 2.0 (see `LICENSE-terminal-bench-2` in this directory)

Note: the pinned task commit predates the upstream `LICENSE` file being
added to the repository, so `LICENSE-terminal-bench-2` is instead fetched
from the specific upstream commit `2ef6e27cf5888ec23adcbb72807b36b0508dfd68` that introduced it
(the only commit in upstream history that has ever touched the `LICENSE`
path), not from a moving branch head. Its sha256 (`c71d239df91726fc519c6eb72d318ec65820627232b2f796219e87dcf35d0ab4`) is
asserted by this script on every run; a mismatch aborts vendoring before
tasks/ is touched. The license text (Apache-2.0) is unaffected by this and
has not changed.

Only `task.toml`, `instruction.md`, and `tests/` are vendored per task.
`solution/` (reference answers) and `environment/` (Dockerfile sources) are
intentionally NOT vendored: solutions stay out of this repo and remain public
upstream, and prebuilt images (`alexgshaw/<task>:20251031`) are used instead
of rebuilding environments locally. Image tags are Docker Hub references
maintained upstream; if they are ever deleted, re-vendoring will not restore
them — the runner is expected to pre-pull/snapshot images to insulate runs.

Every vendored task's `tests/test_outputs.py` preserves the upstream
`terminal-bench-canary` GUID byte-identical, unmodified from the source file.

Vendoring is staged and validated (all 10 tasks present with task.toml,
instruction.md and tests/test.sh) before tasks/ is atomically replaced, so a
partial or failed run never leaves tasks/ in an inconsistent state, and any
directory no longer in the pinned manifest is dropped from tasks/ on the next
successful run.

Re-run `scripts/vendor-tasks.sh` to refresh the bundle from the pinned
commit above. Bumping the pinned commit requires an explicit re-vendor
commit.
