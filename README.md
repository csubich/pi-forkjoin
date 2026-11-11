# pi-forkjoin

Context-scoped **fork/join** for [pi](https://www.npmjs.com/package/@earendil-works/pi-coding-agent) sessions.

An agent exploring a problem generates a lot of context it will never need
again: board reads, triage loops, retry churn, deliberation. fork/join lets the
agent push that **transient** work onto a child path of the session tree, do
the work, and then **join** back — the parent transcript rewinds to the fork
point and sees only a free-form report plus an auto-generated evidence
manifest. The child's full transcript is preserved in the session file (one
tool call away via `child_call`), but never enters the parent's context.

All of it happens **inside a single run, in every mode** — including a one-shot
`pi -p "research X, fork, form a plan, join, review the plan fresh"`.

## Why

Measured on ~900 real subagent launches across 100+ orchestrator sessions:
resident context grows ~18k tokens per delegated task, and sessions die of
context, not logic (wave-size ceilings of 10–13 tasks, auto-compaction at
~246k tokens). Roughly two-thirds of that growth is transient. Forking the
transient part keeps per-task resident cost near ~6–8k and roughly doubles how
much work a session can coordinate. In a field test (10-ply self-play chess,
one fork/join per ply), **42% of the session's bytes never entered the live
context** while remaining browsable evidence.

## Install

Copy `extension/forkjoin.ts` into either:

```
~/.pi/extensions/forkjoin.ts        # personal (all projects)
<project>/.pi/extensions/           # project (pi asks to trust the project once)
```

Requires pi ≥ 1.3.0 (verified against 1.3.0). The extension feature-detects and
disables itself cleanly on unsupported hosts rather than misbehaving.

Add the guidance block from `docs/AGENT-GUIDANCE.md` to your `AGENTS.md` so the
model knows the contract (this matters — field testing shows the contract holds
on guidance alone).

## Usage

| Surface | Who | What |
|---|---|---|
| `fork(label)` | model tool | Opens a child segment. Must be the **only** tool call in its turn. Labels the fork point for `/tree`. |
| `join(message)` | model tool | Ends it: rewinds the transcript to the fork point; the parent sees your report + generated manifest. Only tool call in its turn. |
| `child_call(id)` | model tool | Reads a manifest `[id]` back in full (args, thinking, full result; spills to file past 4 KB). Batch-safe. |
| `/abandon-fork` | human command | Voids the fork: the child transcript becomes ordinary mainline history (**promotion**, not deletion). For when a fork drifts into real work. |
| `/forkjoin-commit` | human command | Recovery: commits a staged join whose run died before the boundary commit. Normally never needed. |

Typical flow:

```
user> review PR #42 and write the release note
agent> fork("pr-42-review")            ← only tool call in the turn
       (child: reads diff, runs tests, churns, deliberates…)
agent> join("Verdict: safe to merge. Two nits. Tests green (output in manifest).")
       ← transcript rewinds to the fork point; parent context now holds
         [join pr-42-review] + report + per-call evidence manifest
agent> (continues from the report, fresh context)
```

The manifest lists each child tool call on one line with an entry id; error
lines are never elided; identical polls collapse. The report is a claim — the
manifest is evidence. Discrepancies between them are the point.

## How it works

- **Tree substrate.** pi sessions are append-only trees; model context is the
  path from the active leaf. A fork's child segment is simply an abandoned
  branch — the mainline continues past a join note attached at the fork point.
- **Boundary commit.** `join` stages its report durably (tree-resident, crash
  safe), then the join turn's own `turn_end` boundary moves the leaf to the
  fork root (`SessionManager.branch`) and commits the join note via the public
  boundary-entries contract (`{entries, continue: true}`). pi core rebuilds
  every provider request from the tree, so the parent continuation happens
  in-run, in any mode, with no state repair and no upstream changes.
- **Marker walk.** Whether a fork is live is derived purely by walking the
  active branch backward to the first of `{fork-open, join, cancel, abandon,
  root}` — no extension-side state; resume-, reload-, and navigation-safe by
  construction. Partial failures self-heal (a lost boundary commit leaves the
  fork live for a plain re-join).
- **Self-teaching rejections.** Batched forks/joins are vetoed with evidence
  (state, child call count, last child result quoted back), never bare verdicts
  — a lesson from a field incident where a model confabulated its way past a
  verdict-only error.

See `docs/DESIGN.md` for the full design record, verified pi behaviors,
failure-mode catalog, and field incidents.

## Testing

```bash
npm install            # or: PI_PKG_ROOT=/path/to/node_modules/@earendil-works
npm test               # 59-assertion scripted-provider suite; no network, no model
```

The suite runs a real pi `AgentSession` against a scripted provider: exclusivity
vetoes, boundary-commit parenting, mid-run context rebuild, compaction-inside-
child, torn-commit recovery, crash recovery, child_call spill, cross-extension
boundary-entry preservation, UI-gated diagnostics. `scripts/smoke.sh` runs an
optional end-to-end check against the real `pi -p` binary and any
OpenAI-compatible local endpoint.

Set `FORKJOIN_DEBUG=1` for stderr logs and the test-only `probe` tool.

## Notes & limits

- Single-writer sessions (pi's own concurrency model).
- Nested forks are rejected by design: subagents move work between trains of
  thought; forks manage context within one.
- Mutations inside a child persist (files have no undo); the manifest documents
  them, and the join report should account for them.
- `/tree` cosmetics: pi's tree view indents one level per fork/join pair and
  renders dead segments interleaved with the mainline. Cosmetic only — model
  context is unaffected. Documented in `docs/DESIGN.md`.

## Credits

Mechanism pattern inspired by [`@cad0p/pi-tree-navigator`](https://www.npmjs.com/package/@cad0p/pi-tree-navigator)
(in-run tree navigation via the public boundary contract), adapted to a
one-turn join with generated evidence manifests and zero reflection.

## License

MIT
