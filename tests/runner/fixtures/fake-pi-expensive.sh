#!/bin/sh
# Deterministic fake `pi` that reports a single-task cost (2.5) that by
# itself exceeds a $2 budget cap, used to prove the multi-task
# budget-abort-after-crossing-cap regression scenario: this task must still
# be fully attempted/verified, but no subsequent task may even start.
set -e

mkdir -p /logs/agent/sessions
cat > /logs/agent/sessions/session.jsonl <<'EOF'
{"type":"message","message":{"role":"user","content":"solve the regex task"}}
{"type":"message","message":{"role":"assistant","usage":{"cost":{"total":2.5}}}}
EOF

mkdir -p /app
printf '%s' 'NOMATCH_WRONG_PATTERN_XYZ' > /app/regex.txt

echo "fake-pi-expensive: wrote wrong regex.txt and a 2.5 cost session.jsonl"
