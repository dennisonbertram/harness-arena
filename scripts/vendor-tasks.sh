#!/usr/bin/env bash
# Vendors the 10 fixed Terminal-Bench 2.0 tasks into tasks/<id>/ at the
# pinned upstream commit. Copies only task.toml, instruction.md and tests/
# (never solution/ or environment/). Idempotent: re-running against the same
# pinned commit produces no diff.
set -euo pipefail

UPSTREAM_REPO="https://github.com/laude-institute/terminal-bench-2"
PINNED_COMMIT="69671fbaac6d67a7ef0dfec016cc38a64ef7a77c"

TASK_IDS=(
  "regex-log"
  "fix-git"
  "log-summary-date-ranges"
  "extract-elf"
  "sqlite-db-truncate"
  "multi-source-data-merger"
  "openssl-selfsigned-cert"
  "prove-plus-comm"
  "cobol-modernization"
  "db-wal-recovery"
)

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TASKS_DIR="$REPO_ROOT/tasks"
WORK_DIR="$(mktemp -d)"
trap 'rm -rf "$WORK_DIR"' EXIT

echo "Fetching pinned commit $PINNED_COMMIT from $UPSTREAM_REPO ..."
git init -q "$WORK_DIR"
git -C "$WORK_DIR" remote add origin "$UPSTREAM_REPO"

fetch_ok=0
for attempt in 1 2; do
  if git -C "$WORK_DIR" fetch --depth 1 origin "$PINNED_COMMIT"; then
    fetch_ok=1
    break
  fi
  echo "Fetch attempt $attempt failed, retrying..." >&2
done

if [ "$fetch_ok" -ne 1 ]; then
  echo "ERROR: failed to fetch pinned commit $PINNED_COMMIT after 2 attempts" >&2
  exit 1
fi

git -C "$WORK_DIR" checkout -q FETCH_HEAD

mkdir -p "$TASKS_DIR"

for id in "${TASK_IDS[@]}"; do
  src="$WORK_DIR/$id"
  dest="$TASKS_DIR/$id"

  if [ ! -d "$src" ]; then
    echo "ERROR: task '$id' not found at pinned commit ($src missing)" >&2
    exit 1
  fi

  rm -rf "$dest"
  mkdir -p "$dest"

  cp "$src/task.toml" "$dest/task.toml"
  cp "$src/instruction.md" "$dest/instruction.md"
  cp -R "$src/tests" "$dest/tests"

  echo "Vendored $id"
done

# The pinned commit predates the upstream LICENSE file being added to the
# repo (it landed later the same day). The license text itself (Apache-2.0)
# has not changed, so fetch it from the current default branch instead of
# the pinned commit's tree.
curl -fsSL -o "$TASKS_DIR/LICENSE-terminal-bench-2" \
  "https://raw.githubusercontent.com/laude-institute/terminal-bench-2/main/LICENSE"

cat > "$TASKS_DIR/ATTRIBUTION.md" <<ATTRIBUTION
# Attribution

The tasks under this directory are vendored from the
[terminal-bench-2](https://github.com/laude-institute/terminal-bench-2)
project, pinned at commit \`${PINNED_COMMIT}\`.

- Upstream repository: ${UPSTREAM_REPO}
- Pinned commit: ${PINNED_COMMIT}
- License: Apache License 2.0 (see \`LICENSE-terminal-bench-2\` in this directory)

Note: the pinned commit predates the upstream \`LICENSE\` file being added to
the repository, so \`LICENSE-terminal-bench-2\` is fetched from the current
default branch instead of the pinned commit's tree. The license text
(Apache-2.0) is unaffected by this and has not changed.

Only \`task.toml\`, \`instruction.md\`, and \`tests/\` are vendored per task.
\`solution/\` (reference answers) and \`environment/\` (Dockerfile sources) are
intentionally NOT vendored: solutions stay out of this repo and remain public
upstream, and prebuilt images (\`alexgshaw/<task>:20251031\`) are used instead
of rebuilding environments locally. Image tags are Docker Hub references
maintained upstream; if they are ever deleted, re-vendoring will not restore
them — the runner is expected to pre-pull/snapshot images to insulate runs.

Every vendored task's \`tests/test_outputs.py\` preserves the upstream
\`terminal-bench-canary\` GUID byte-identical, unmodified from the source file.

Re-run \`scripts/vendor-tasks.sh\` to refresh the bundle from the pinned
commit above. Bumping the pinned commit requires an explicit re-vendor
commit.
ATTRIBUTION

echo "Vendor complete: ${#TASK_IDS[@]} tasks written to $TASKS_DIR"
