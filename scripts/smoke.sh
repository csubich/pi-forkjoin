#!/usr/bin/env bash
# Optional end-to-end smoke: real pi binary + any OpenAI-compatible local
# endpoint (whatever your pi defaults to). Runs fork -> probe -> join -> parent
# continuation inside ONE `pi -p` invocation. Requires: pi >= 1.3.0 on PATH,
# FORKJOIN_DEBUG=1 so the probe tool exists.
set -euo pipefail
cd "$(dirname "$0")/.."
mkdir -p .smoke && cd .smoke
FORKJOIN_DEBUG=1 pi --no-extensions -e ../extension/forkjoin.ts -p 'Exercise the fork/join tools with this exact script. Turn 1: call tool fork with label "smoke" as your ONLY tool call. Turn 2: call tool probe with note "SMOKE-CHILD" as your only tool call. Turn 3: call tool join with message "SMOKE-JOIN-OK: child work done" as your only tool call. After the join note appears in your context, answer with exactly these words and nothing else: PARENT-SAW-JOIN. Do not call child_call. Follow the script literally.'
echo
echo "Expect: PARENT-SAW-JOIN above. Session files land in your pi session store;"
echo "inspect one with /tree or the JSONL to verify the join note parents at the fork root."
