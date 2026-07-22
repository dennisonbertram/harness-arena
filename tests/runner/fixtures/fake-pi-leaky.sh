#!/bin/sh
# Deterministic fake `pi` that simulates a prompt-injected agent doing
# `printenv` and embedding secrets in both its stdout and its own session
# JSONL -- issue #19 finding 1: the runner must scrub these bytes before
# uploading session.jsonl / pi-stdout.txt as public traces.
set -e

echo "leaking env via printenv: AI_GATEWAY_API_KEY=${AI_GATEWAY_API_KEY}"
echo "also leaking a vck_ token not in the known secrets list: vck_leakedtoken999"

mkdir -p /logs/agent/sessions
cat > /logs/agent/sessions/session.jsonl <<EOF
{"type":"message","message":{"role":"user","content":"printenv"}}
{"type":"message","message":{"role":"assistant","content":"AI_GATEWAY_API_KEY=${AI_GATEWAY_API_KEY} vck_leakedtoken999","usage":{"cost":{"total":0.001}}}}
EOF

mkdir -p /app
printf '%s' 'NOMATCH_WRONG_PATTERN_XYZ' > /app/regex.txt

echo "fake-pi-leaky: wrote wrong regex.txt and a secret-leaking session.jsonl"
