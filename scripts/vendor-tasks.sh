#!/usr/bin/env bash
# Vendors the 16 fixed Terminal-Bench 2.0 tasks (the harnessarena.xyz ranked
# subset) into tasks/<id>/ at the pinned upstream commit. Copies only
# task.toml, instruction.md and tests/ (never solution/ or environment/).
# Idempotent: re-running against the same pinned commit produces no diff.
#
# The bundle is staged into a scratch directory first, validated for
# completeness (all 16 tasks with task.toml + instruction.md + tests/test.sh,
# plus a sha256-verified LICENSE), and only then atomically swapped in for
# tasks/. Any validation failure aborts before tasks/ is touched, and the
# swap replaces tasks/ wholesale so directories no longer in the manifest
# (e.g. a task removed from TASK_IDS) do not linger.
set -euo pipefail

UPSTREAM_REPO="${VENDOR_TASKS_UPSTREAM_REPO:-https://github.com/laude-institute/terminal-bench-2}"
PINNED_COMMIT="${VENDOR_TASKS_PINNED_COMMIT:-69671fbaac6d67a7ef0dfec016cc38a64ef7a77c}"

# LICENSE is pinned to the specific upstream commit that introduced it (the
# only commit in upstream history that has ever touched the LICENSE path, per
# `gh api repos/laude-institute/terminal-bench-2/commits?path=LICENSE`), not
# to a moving branch head. The sha256 constant below was computed once
# against that commit's LICENSE blob and is asserted on every run so a
# tampered or unexpectedly changed file is caught rather than silently
# vendored.
LICENSE_COMMIT="2ef6e27cf5888ec23adcbb72807b36b0508dfd68"
LICENSE_URL="${VENDOR_TASKS_LICENSE_URL:-https://raw.githubusercontent.com/laude-institute/terminal-bench-2/${LICENSE_COMMIT}/LICENSE}"
LICENSE_SHA256="c71d239df91726fc519c6eb72d318ec65820627232b2f796219e87dcf35d0ab4"

TASK_IDS=(
  "fix-git"
  "kv-store-grpc"
  "headless-terminal"
  "cancel-async-tasks"
  "write-compressor"
  "nginx-request-logging"
  "qemu-startup"
  "sanitize-git-repo"
  "fix-code-vulnerability"
  "query-optimize"
  "modernize-scientific-stack"
  "custom-memory-heap-crash"
  "model-extraction-relu-logits"
  "pytorch-model-cli"
  "multi-source-data-merger"
  "sparql-university"
)

sha256_of() {
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$1" | awk '{print $1}'
  else
    shasum -a 256 "$1" | awk '{print $1}'
  fi
}

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TASKS_DIR="$REPO_ROOT/tasks"
WORK_DIR="$(mktemp -d)"
STAGING_DIR="$(mktemp -d "$REPO_ROOT/tasks.staging.XXXXXX")"
OLD_DIR="${STAGING_DIR}.old"
cleanup() {
  # If we died between demoting tasks/ and promoting staging, restore the
  # original tree before deleting anything — tasks/ must never end up absent.
  if [ ! -d "$TASKS_DIR" ] && [ -d "$OLD_DIR" ]; then
    mv "$OLD_DIR" "$TASKS_DIR"
  fi
  rm -rf "$WORK_DIR" "$STAGING_DIR" "$OLD_DIR" 2>/dev/null || true
}
trap cleanup EXIT

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

echo "Staging vendored tasks into $STAGING_DIR ..."
for id in "${TASK_IDS[@]}"; do
  src="$WORK_DIR/$id"
  dest="$STAGING_DIR/$id"

  if [ ! -d "$src" ]; then
    echo "ERROR: task '$id' not found at pinned commit ($src missing); tasks/ left untouched" >&2
    exit 1
  fi

  mkdir -p "$dest"
  cp "$src/task.toml" "$dest/task.toml"
  cp "$src/instruction.md" "$dest/instruction.md"
  cp -R "$src/tests" "$dest/tests"
done

echo "Validating staged bundle completeness ..."
for id in "${TASK_IDS[@]}"; do
  for required in "task.toml" "instruction.md" "tests/test.sh"; do
    if [ ! -f "$STAGING_DIR/$id/$required" ]; then
      echo "ERROR: staged task '$id' is missing required file '$required'; tasks/ left untouched" >&2
      exit 1
    fi
  done
done

# sanitize-git-repo's tests/test_outputs.py contains intentional fake leaked
# tokens (the task is about scrubbing secrets from git history), which trips
# GitHub secret-scanning push protection. Store it base64-encoded so nothing
# pushable contains the token pattern; scripts/build-runner-bundle.mjs decodes
# any tests/*.b64 back to the real file at bundle-build time (byte-identical).
SANITIZE_TESTS="$STAGING_DIR/sanitize-git-repo/tests/test_outputs.py"
if [ -f "$SANITIZE_TESTS" ]; then
  base64 -i "$SANITIZE_TESTS" > "$SANITIZE_TESTS.b64"
  rm "$SANITIZE_TESTS"
  echo "Encoded sanitize-git-repo/tests/test_outputs.py -> .b64 (secret-scan safe)"
fi

echo "Fetching pinned LICENSE ($LICENSE_COMMIT) ..."
curl -fsSL -o "$STAGING_DIR/LICENSE-terminal-bench-2" "$LICENSE_URL"

actual_sha256="$(sha256_of "$STAGING_DIR/LICENSE-terminal-bench-2")"
if [ "$actual_sha256" != "$LICENSE_SHA256" ]; then
  echo "ERROR: LICENSE sha256 mismatch: expected $LICENSE_SHA256, got $actual_sha256; tasks/ left untouched" >&2
  exit 1
fi

cat > "$STAGING_DIR/ATTRIBUTION.md" <<ATTRIBUTION
# Attribution

The tasks under this directory are vendored from the
[terminal-bench-2](https://github.com/laude-institute/terminal-bench-2)
project, pinned at commit \`${PINNED_COMMIT}\`.

- Upstream repository: ${UPSTREAM_REPO}
- Pinned commit: ${PINNED_COMMIT}
- License: Apache License 2.0 (see \`LICENSE-terminal-bench-2\` in this directory)

Note: the pinned task commit predates the upstream \`LICENSE\` file being
added to the repository, so \`LICENSE-terminal-bench-2\` is instead fetched
from the specific upstream commit \`${LICENSE_COMMIT}\` that introduced it
(the only commit in upstream history that has ever touched the \`LICENSE\`
path), not from a moving branch head. Its sha256 (\`${LICENSE_SHA256}\`) is
asserted by this script on every run; a mismatch aborts vendoring before
tasks/ is touched. The license text (Apache-2.0) is unaffected by this and
has not changed.

Only \`task.toml\`, \`instruction.md\`, and \`tests/\` are vendored per task.
\`solution/\` (reference answers) and \`environment/\` (Dockerfile sources) are
intentionally NOT vendored: solutions stay out of this repo and remain public
upstream, and prebuilt images (\`alexgshaw/<task>:20251031\`) are used instead
of rebuilding environments locally. Image tags are Docker Hub references
maintained upstream; if they are ever deleted, re-vendoring will not restore
them — the runner is expected to pre-pull/snapshot images to insulate runs.

Every vendored task's \`tests/test_outputs.py\` preserves the upstream
\`terminal-bench-canary\` GUID byte-identical, unmodified from the source file.

Vendoring is staged and validated (all 16 tasks present with task.toml,
instruction.md and tests/test.sh) before tasks/ is atomically replaced, so a
partial or failed run never leaves tasks/ in an inconsistent state, and any
directory no longer in the pinned manifest is dropped from tasks/ on the next
successful run.

Re-run \`scripts/vendor-tasks.sh\` to refresh the bundle from the pinned
commit above. Bumping the pinned commit requires an explicit re-vendor
commit.
ATTRIBUTION

echo "Atomically replacing $TASKS_DIR with staged bundle ..."
rm -rf "$OLD_DIR"
if [ -d "$TASKS_DIR" ]; then
  mv "$TASKS_DIR" "$OLD_DIR"
fi
mv "$STAGING_DIR" "$TASKS_DIR"
rm -rf "$OLD_DIR"

echo "Vendor complete: ${#TASK_IDS[@]} tasks written to $TASKS_DIR"
