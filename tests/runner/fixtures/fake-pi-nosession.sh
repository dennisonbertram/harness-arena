#!/bin/sh
# Deterministic fake `pi` that never writes a session.jsonl at all --
# simulates a corrupted/missing session file (issue #19 finding 2: cost
# tamper resistance). With no session and no stdout cost, the runner must
# report the task's cost as UNMEASURED (no fabricated floor value).
set -e

mkdir -p /logs/agent/sessions
# Deliberately no session.jsonl written here.

mkdir -p /app
printf '%s' 'NOMATCH_WRONG_PATTERN_XYZ' > /app/regex.txt

echo "fake-pi-nosession: wrote wrong regex.txt, no session.jsonl"
