#!/bin/sh
# Deterministic fake `pi` used by the integration test in place of the real
# agent kit binary (via PI_INVOKE_OVERRIDE). Writes a plausible session
# JSONL with known costs, and a deliberately WRONG regex.txt answer so the
# real verifier (test_outputs.py) fails deterministically -- proving the
# reward.txt=0 -> passed=false path works, independent of the (unwritten)
# happy path.
set -e

mkdir -p /logs/agent/sessions
cat > /logs/agent/sessions/session.jsonl <<'EOF'
{"type":"message","message":{"role":"user","content":"solve the regex task"}}
{"type":"message","message":{"role":"assistant","usage":{"cost":{"total":0.001}}}}
{"type":"message","message":{"role":"assistant","usage":{"cost":{"total":0.002}}}}
EOF

mkdir -p /app
printf '%s' 'NOMATCH_WRONG_PATTERN_XYZ' > /app/regex.txt

echo "fake-pi: wrote wrong regex.txt and session.jsonl"
