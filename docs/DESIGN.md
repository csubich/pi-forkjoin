# Design record

Public distillation of the design process (spike evidence, verified pi
behaviors, field incidents, rejected alternatives). Claims here are backed by
the 59-assertion scripted-provider suite in `test/` and real-binary field
sessions. Verified against pi 1.3.0.

## 1. Motivation (measured, not guessed)

Analysis of ~900 subagent launches across 100+ orchestrator sessions:

- Resident context growth per delegated task: median ~18k tokens (mean 25k).
- Cumulative input tokens *sent* per task: median ~1.6M (resend multiplier
  ≈ assistant-turns × context size).
- Growth fits `~0.6k × assistant turns` better than per-task.
- Sessions died of context, not logic: wave ceilings ~10–13 tasks; peak
  context median 175k, p90 233k; auto-compaction ~246k tokensBefore.
- Composition of per-task growth: thinking 37%, bash results 29%, tool-call
  args 19%, reads 10%, wait-reports 5%.
- Empirical rule adopted: **optional introspection tools do not get called**
  (measured ≈0.2 uses/task). Put evidence inline; don't gate it behind a call.

Thesis: delegate the transient portion of each task to a child path; keep
resident cost per task ~6–8k instead of ~18k. Confirmed in the field: 42% of a
10-task session's bytes never entered live context, evidence intact.

## 2. Design contract

Division of labor: **forks manage context within one train of thought;
subagents move work between trains of thought.**

- `fork(label)` — near-free, speculative, mandatory short label (findability +
  a micro-commitment). No brief argument: the child inherits full live
  context; the decision to fork *is* the priming.
- `join(message)` — freeform report, **no schema** (schemas get gamed;
  structure nothing that records nothing). Rewinds to the fork root; the
  parent sees report + **generated manifest**.
- Manifest — generated from the tree, never reported by the child: one line
  per tool call (~40 tokens), entry ids for readback, errors never elided,
  reads suppressed, identical runs collapsed (`×N`), hard cap with elision
  note. Three layers: report (claims) / manifest (evidence) / `child_call`
  (verdicts, opt-in). Report-vs-manifest discrepancy is the useful adversarial
  pressure.
- `child_call(id)` — the only drill-down. Args + thinking + full result,
  lineage stamp, byte budget, spill-to-file. Read-only → batch-safe.
- Exclusivity: `fork`/`join` must be alone in their assistant turn (a batched
  sibling either orphans a tool_result or describes mutations the parent never
  authorized). Enforced by tool-side veto **with evidence**, not convention.

Liveness = pure backward walk of the active branch to the first marker:

| first marker | `fork()` | `join()` | `/abandon-fork` |
|---|---|---|---|
| fork-open | ✗ nested error (diagnostic) | ✓ completes it | ✓ voids it |
| join / cancel | ✓ | ✗ | ✗ |
| abandon | ✓ | ✗ | ✗ |
| root | ✓ | ✗ | ✗ |

Human navigates out → the fork simply stops being live. Navigates back in and
joins → a NEW sibling continuation on the parent path (multi-continuation by
construction). All state lives in the tree: resume/reload/navigation-safe.

`/abandon-fork` is human-only **because the model's cheapest exit from a
railed child must not be evidence destruction** — evidence disposal is the one
operation the actor cannot take. Semantics are promotion, not deletion: the
child keeps the pen; its work becomes ordinary linear history; nothing is
lost.

Rejected by decision (reasons, not taste): nested forks (subagents own that
niche; the error falls out of the walk); mid-child resume (reasoning blocks do
not survive replay → conclusions-without-reasoning confabulation; pollutes the
append-only evidence subtree — safe substitute: re-fork with explicit
corrective instruction); model-callable abandon (incentives); fixed join
schemas (gamed).

## 3. Mechanism, and the pi facts it rests on

All verified in pi 1.3.0 dist and behavior-tested in the suite:

1. **Sessions are append-only trees** (`id`/`parentId`); model context is
   rebuilt from the tree on *every* provider request (`prepare()` uses
   `buildSessionProjection().messages`). Rewinding the leaf is therefore the
   entire "context surgery"; no state handler or transcript rewrite needed.
2. **`turn_end` fires after the assistant message AND every tool result are
   persisted** — pi's own comment calls it "the first point where a
   context-only custom message can be inserted without landing between a tool
   call and its result". Branching there cannot strand a `tool_use`.
3. **Boundary entries returned from `turn_end` commit after handler side
   effects and before the steering drain**; `continue: true` guarantees one
   more provider request in the same run, any mode. Hence: join stages
   (durable), acks, and its own boundary handler does
   `SessionManager.branch(forkRoot)` + returns the join note. Parent
   continuation, same `prompt()`, zero upstream changes.
4. **Boundary `entries` chain across extensions** (each handler sees the
   accumulated list and replaces it) — the handler preserves others' drafts
   and drops stale `context_edit` targets.
5. **`ReadonlySessionManager` is a typing facade**; the runtime object is the
   live manager (`SessionManager` is a public exported class; `branch`,
   `appendCustomEntry`, `getEntry`, `getTree` are public). Zero reflection
   needed: no prototype patches, no `agent.state` writes. Compaction (input,
   trigger, accounting) is tree-based throughout, so post-join compaction
   cannot bake child content into a parent summary.
6. Mid-run `pi.appendEntry` **queues** until the turn-boundary flush — all
   forkjoin mutations go directly through the manager for deterministic
   landing order.
7. Error acks are leaves too: the boundary commit guards on `!isError`
   (a rejected join must never commit).

Failure modes are cataloged and tested: torn commit (branch moved, note lost)
→ fork stays live at the root, plain re-join recovers; aborted/errored join
turn → staged join persists, `/forkjoin-commit` (idle recovery) finishes it,
hard-failing rather than delivering at an unverified leaf; compaction inside a
child → walk is tree-based, commit unaffected; stale staged entries off-branch
never re-commit.

## 4. Field incidents

**Incident A — the confabulated join.** Interactive self-play chess, one
fork/join per ply. Ply 4: the model executed a game mutation inside the child
(violating its own recited invariant), called `fork` without joining (correctly
vetoed), then claimed the veto was wrong because "the join manifest arrived but
was truncated". Whole-file forensics: the string it quoted existed nowhere
except its own thinking block. Lesson: **a bare verdict loses to a confident
false memory.** The veto now quotes state (join never called vs staged
uncommitted), child call count, and the last child result; ask-the-user hints
are UI-gated so headless runs are never told to wait for a human.

**Session B — clean.** Ten plies, ten fork/join pairs: 1:1 pairing, every note
parented exactly at its fork root, zero tool errors (contract held on guidance
alone), zero in-child mutations, reported moves ≡ executed moves. 42% of
session bytes kept out of live context.

## 5. Accepted non-issues

- **pi `/tree` cosmetics**: branch points add +1 indent that never recovers
  (each fork/join pair deepens the rendered mainline one level), and children
  are ordered active-branch-first at every branch (leaf-relative, reflows when
  preview-navigating). Pure selector rendering; model context unaffected; a
  custom extension-rendered tree view was prototyped and rejected as
  unnecessary.
- Print-mode lifetime: because the continuation is inside `prompt()`, there is
  no process-teardown race; the recovery command exists only for runs that
  died mid-join.

## 6. Verification matrix

`npm test` → 59 assertions, scripted provider, real AgentSession, in-memory
sessions: orphan join, batch vetoes (both tools), nested-fork diagnostics
(both states), happy-path boundary commit (note parenting, context rebuild,
durability-at-return), multi-continuation semantics, idempotence (plain turns,
stray commits, off-branch staging), mid-child compaction, torn-commit recovery,
crash recovery via `/forkjoin-commit`, child_call ids/spill/lineage,
cross-extension boundary-entry preservation, UI-gated hints, zero-call child
(no self-listing manifests). Plus real-binary smokes in print mode and two
multi-turn interactive field sessions.
