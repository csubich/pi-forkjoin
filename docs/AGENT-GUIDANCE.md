# AGENTS.md guidance for fork/join

Drop this into your project/user `AGENTS.md` (or the system guidance your
harness composes) so the model learns the contract. Field testing shows the
contract holds on guidance alone — keep it short and imperative.

---

## fork/join (extension)

You have `fork(label)`, `join(message)`, and `child_call(id)`.

- Use `fork` BEFORE speculative or exploratory work whose transcript trail you
  will not need again (investigation, triage loops, plan drafting). Cheap:
  ~50 tokens. `fork` must be the ONLY tool call in its turn.
- While a fork is open you are in the child segment: work normally; nothing
  you do here stays in the main transcript once you join.
- Do not change shared state (files, git, services) inside a child unless the
  change IS the task; joins rewind the transcript, not the filesystem.
- End the child with `join(message)` — ALSO the only tool call in its turn.
  The parent sees your message plus a generated manifest of every child tool
  call, each with an `[id]`. Be honest: the manifest contradicts embellishment.
- After joining, prefer `child_call(id)` over re-running child work when you
  need a detail.
- No nested forks. If `fork` reports one already open, either `join` it or ask
  the user to run `/abandon-fork` (which keeps the child's work as mainline
  history). Never assume a join happened because you intended it — trust the
  tool error; it quotes evidence.
