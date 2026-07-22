#!/bin/sh
# Deterministic fake `pi` that reproduces the exact live-run bug (run
# 9f4a1b3e): emits real per-turn cost data to stdout via message_end
# events -- exactly like real `pi --print --mode json` -- but never
# flushes a session.jsonl before the `timeout` wrapper SIGTERMs it. The
# runner must recover the real cost from the captured stdout instead of
# silently flooring it.
set -e

mkdir -p /logs/agent/sessions
# Deliberately no session.jsonl written.

echo '{"type":"message_update","message":{"role":"assistant","usage":{"cost":{"total":0.002}}}}'
echo '{"type":"message_end","message":{"role":"assistant","usage":{"cost":{"total":0.006}}}}'
echo '{"type":"message_update","message":{"role":"assistant","usage":{"cost":{"total":0.001}}}}'
echo '{"type":"message_end","message":{"role":"assistant","usage":{"cost":{"total":0.009}}}}'

mkdir -p /app
printf '%s' 'NOMATCH_WRONG_PATTERN_XYZ' > /app/regex.txt

# Simulate the agent hanging past its timeout -- `timeout` SIGTERMs this
# process before it could ever write a session.jsonl.
sleep 120
