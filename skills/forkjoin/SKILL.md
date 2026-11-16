---
name: pi-forkjoin
description: Context-scoped fork/join for pi sessions via the fork, join, and child_call tools. Use before starting speculative or exploratory work whose transcript trail will not be needed again (investigation, triage loops, plan drafting, board/status reads), when a fork/join tool returns a state error, or when a join was staged but never landed (recovery with /forkjoin-commit).
---

# pi-forkjoin: fork/join state machine

`fork(label)` opens a child segment at the current transcript leaf; all work
there stays out of the parent's context. `join(message)` reports back: at the
join turn's boundary the leaf rewinds to the fork root and the parent continues
in the same run, seeing only your report plus an auto-generated evidence
manifest. The child transcript is never deleted — it stays in the session tree.

## Hard invariants

- `fork` must be the ONLY tool call in its assistant turn. No siblings.
- `join` must be the ONLY tool call in its turn. Do all other tool work in
  earlier turns, then join alone.
- No nested forks. If `fork` errors saying a fork is still open, that error is
  evidence — it quotes what the child actually did. Trust it over your memory
  of an intended join. Either `join` that fork, or (interactive sessions only)
  ask the user to run `/abandon-fork`.
- Joins rewind the transcript, NOT the filesystem. Do not mutate shared state
  (files, git, services) inside a child unless the change IS the task; if you
  did, account for every mutation in the join message.

## join(message): what to report

The parent sees your message plus a generated manifest of every child tool
call, each line stamped with an entry id `[xxxxxxxx]`. The manifest contradicts
embellishment, so report honestly and concretely:

- verdict + the specific findings (paths, ids, numbers), not vibes;
- any files you created/edited/deleted;
- anything the parent should re-check, with the manifest ids to `child_call`.

## After joining: read back instead of redoing

When you need a detail from joined child work, prefer `child_call(id)` over
re-running the work. `id` is the `[xxxxxxxx]` stamp in the manifest — it must
reference a tool-result entry. `child_call` is a pure read, safe to batch with
other tools. Results over 4000 bytes spill in full to `.forkjoin/readback-<id>.txt`.

## Recovery and escape hatches (human commands)

- `/forkjoin-commit` — recovery path when a join was staged but the turn was
  aborted/errored/crashed before the boundary commit landed. It commits the
  staged join: moves the leaf back to the fork root and delivers the join note.
  The normal join needs no command — it commits automatically at the turn
  boundary.
- `/abandon-fork` — voids the active fork so the child continues as the linear
  mainline session (use when the child drifted into real mainline work). The
  agent cannot run this; ask the user.

## Troubleshooting tool errors

- `fork "<label>" is still open` — a fork is open; the error lists child call
  count, last result, and whether a join was staged. Act on that evidence.
- `join must be the only tool call in its turn` — run the siblings in a later
  turn; join alone.
- `no active fork to join (walk reached: join|abandon|root)` — this segment
  already joined, was abandoned, or never forked. Do not force it; check
  `/tree` if unsure.
- `unavailable on this pi build (SessionManager.branch missing)` — pi < 1.3.0;
  fork/join is disabled by design.
