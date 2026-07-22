#!/bin/sh
# Deterministic fake `pi` that never writes a session.jsonl at all --
# simulates a corrupted/missing session file (issue #19 finding 2: cost
# tamper resistance). The runner must fall back to RUNNER_MISSING_COST_FLOOR
# instead of silently treating this as a $0-cost task.
set -e

mkdir -p /logs/agent/sessions
# Deliberately no session.jsonl written here.

mkdir -p /app
printf '%s' 'NOMATCH_WRONG_PATTERN_XYZ' > /app/regex.txt

echo "fake-pi-nosession: wrote wrong regex.txt, no session.jsonl"
