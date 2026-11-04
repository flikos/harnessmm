---
name: harnessmm
description: "Run a multi-step mechanical chain without a reasoning call per step. Use when a task has 3+ steps whose readiness is decided by an observable receipt (exit code, file existence, JSON field) — build/test/lint/format/migrate sequences, verification gates, or the same chain over many similar items. Not for exploratory debugging, 1–2 step tasks, or steps that branch on the meaning of output."
---

# HarnessMM chain

`harnessmm_chain` executes a decision graph (EDG) inside the session directory. A node runs only
when its guard is proven by receipts already observed; the model is not called between nodes.
Saved graphs make the second run free; receipts make an interrupted chain resumable.

## When to use

- Three or more mechanical steps, each ready on an observable fact: exit code, file written, JSON
  field value.
- Verification gates (syntax → tests → lint → bench → report) and build chains.
- The same chain repeated over similar items, or across sessions: save it under a name.

## When not to

- Exploration, debugging, or any step decided by reading output.
- One or two steps: graph authorship costs more than it saves.
- Where "guard passed" does not imply "result is correct" and no verifier exists.

## Procedure

1. Author the whole chain before running it: every `args` value is a literal (no `$VAR`, no
   `{{}}`), every node names its `after` predecessor, every guard names an earlier receipt.
2. The first node has no `after` and no guard; it is the only unconditional step.
3. `harnessmm_validate` first. A rejection means the graph is wrong — fix it, do not run it.
4. Run it. If it will be reused, pass `save: true` with a `name`; later runs are `{ name }` only.
5. Choose the executor: `"sandboxed"` runs shell through the native bash tool (sandbox, policy
   and approvals apply; use it whenever commands are not obviously safe). `"direct"` needs
   `allowShell: true`, runs in the Host process, and is only for trusted mechanical commands.
   Destructive patterns are refused in both modes; `timeoutMs` per node is honoured.
6. Read the result: `completed`, `deferred` (no eligible node — control returns to you), `error`,
   `invalid-graph`, `saved`. `deferred` is an answer, not a failure: the report carries the full
   output of the failing step.
7. To continue: fix the graph and pass the run's `receipts` back — finished nodes are not re-run
   and guards may reference them.

## Guard rules

- The exit code of a verifier beats a substring of its output; `json_field` beats
  `stdout_contains`.
- A condition you cannot write as a literal is not a guard: do not build the chain around it.
- Never author a guard whose truth does not imply what you actually need.
- Declare `required_receipt_fields` (`exitCode`/`stdout`/`stderr`) on nodes whose guard reads a
  receipt; a guard on an undeclared field is rejected at compile time.
- A stopped chain explains every pending node (`guard-negative` vs `evidence-unreadable` vs
  `waiting-for-predecessor`). Read that before re-authoring: a negative means the world disagreed
  with the plan; an unreadable means the evidence was missing.

## Stop conditions

- Two consecutive guard failures: abandon substitution and continue normally.
- The chain stops by itself; do not loop it to force progress.

`harnessmm_bench` is a measurement harness, not a work tool: use it only when someone asks how the
mechanism performs.
