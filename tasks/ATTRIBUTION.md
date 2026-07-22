# Attribution

The tasks under this directory are vendored from the
[terminal-bench-2](https://github.com/laude-institute/terminal-bench-2)
project, pinned at commit `69671fbaac6d67a7ef0dfec016cc38a64ef7a77c`.

- Upstream repository: https://github.com/laude-institute/terminal-bench-2
- Pinned commit: 69671fbaac6d67a7ef0dfec016cc38a64ef7a77c
- License: Apache License 2.0 (see `LICENSE-terminal-bench-2` in this directory)

Note: the pinned commit predates the upstream `LICENSE` file being added to
the repository, so `LICENSE-terminal-bench-2` is fetched from the current
default branch instead of the pinned commit's tree. The license text
(Apache-2.0) is unaffected by this and has not changed.

Only `task.toml`, `instruction.md`, and `tests/` are vendored per task.
`solution/` (reference answers) and `environment/` (Dockerfile sources) are
intentionally NOT vendored: solutions stay out of this repo and remain public
upstream, and prebuilt images (`alexgshaw/<task>:20251031`) are used instead
of rebuilding environments locally. Image tags are Docker Hub references
maintained upstream; if they are ever deleted, re-vendoring will not restore
them — the runner is expected to pre-pull/snapshot images to insulate runs.

Every vendored task's `tests/test_outputs.py` preserves the upstream
`terminal-bench-canary` GUID byte-identical, unmodified from the source file.

Re-run `scripts/vendor-tasks.sh` to refresh the bundle from the pinned
commit above. Bumping the pinned commit requires an explicit re-vendor
commit.
