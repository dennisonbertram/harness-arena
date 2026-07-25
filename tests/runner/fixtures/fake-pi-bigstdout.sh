#!/bin/sh
# Deterministic fake `pi` that writes a normal (small, usable) session.jsonl
# but a huge amount of stdout -- reproducing the live-run 413 (run
# 9f4a1b3e: "callback POST failed ... trace?task_id=regex-log&name=pi-stdout.txt:
# HTTP 413", pi stdout exceeded Vercel's ~4.5MB function body limit). The
# runner must now upload the FULL pi-stdout.txt gzip-compressed (no truncation),
# which keeps it well under the body limit.
set -e

mkdir -p /logs/agent/sessions
cat > /logs/agent/sessions/session.jsonl <<'EOF'
{"type":"message","message":{"role":"user","content":"solve the regex task"}}
{"type":"message","message":{"role":"assistant","usage":{"cost":{"total":0.004}}}}
EOF

mkdir -p /app
printf '%s' 'NOMATCH_WRONG_PATTERN_XYZ' > /app/regex.txt

i=0
while [ "$i" -lt 6000 ]; do
  echo "line $i: some verbose agent chatter that pads stdout well past 256KB for the trace-upload cap test"
  i=$((i + 1))
done
