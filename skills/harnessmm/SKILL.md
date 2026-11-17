---
name: harnessmm
description: "Run several mechanical steps in one tool call without a reasoning round-trip between them. Use when the next step's readiness is decided by an observable fact — exit code, a file, a JSON field — and you can state that expectation up front: build → test → lint → report, migrations, deploy then smoke-check. Not for exploratory debugging, steps whose continuation depends on reading output, or one-step tasks."
---

# HarnessMM chain

`harnessmm_chain` runs a plan inside one tool call. A step runs only when the
step before it produced the receipt you said to expect; nothing is asked of you
between steps. When reality disagrees, the call stops and hands you the evidence.

Nothing is registered or saved. The plan is stated in the call, every time.

## When to use

- You can name the next step **now**, and what it will look like when it
  worked: an exit code, a file that exists, a field in JSON output.
- Three or more such steps, or a repeatable sequence you run often.
- The whole continuation is mechanical: no judgement between steps.

## When not to

- Exploration or debugging: the next step depends on what the output *means*.
- One or two steps: authoring the plan costs more than it saves.
- A step whose success you cannot express as a literal fact.

## Procedure

1. Write the plan as `steps`, first step first. Each step is `{run, expect}`:
   - `run` — the command with every argument already resolved. No `$VAR`, no
     placeholders: an unresolved argument means the value still depends on
     future reasoning, which is exactly what this tool exists to avoid.
   - `expect` — what the **previous** step must have produced. Omit it when the
     step needs no gate (the first step never has one).
2. Pass the result of a step you have already run as `rootId` only when you are
   continuing work that began outside the plan.
3. Call `harnessmm_validate` first when the plan is longer than a few steps, or
   when a guard is subtle. A rejection means the plan is wrong — fix it, do not
   run it.
4. Choose the executor: `"sandboxed"` runs shell through the native bash tool,
   inheriting its sandbox, policy and approvals — use it unless the commands are
   obviously safe. `"direct"` needs `allowShell: true`, runs in the Host process,
   and is only for trusted mechanical commands. Destructive patterns are refused
   in both; `timeoutMs` per step is honoured.
5. Read the result. Seven statuses, each a different decision:

   | status | meaning | what to do |
   | --- | --- | --- |
   | `exhausted` | every step ran | answer; nothing to re-derive |
   | `expectation-failed` | the world disagreed | read `failure` — it carries the failing step's full output — and decide the recovery |
   | `evidence-unreadable` | the expected fact was not there | do not guess: the output was not what a guard can read |
   | `execution-error` | the command could not run | fix the invocation |
   | `invalid-graph` | the plan failed validation; nothing ran | fix the plan from the listed errors |
   | `deferred` | several nodes were ready and no selector could pick | pick between the eligible steps yourself, or pass `selector: "priority"` |
   | `max-steps` | the step cap was reached | split the plan |

## Guard rules

- The exit code of a verifier beats a substring of its output; `json_field`
  beats `stdout_contains`.
- A condition you cannot write as a literal is not a guard: do not build the
  plan around it.
- Never author a guard whose truth does not imply what you actually need.
- Guards read a receipt; in the linear form the receipt is always the step
  above, so declare receipt fields only when you also pass a graph.

## What it is worth

The result reports `avoidedRoundTrips`: model boundaries crossed without a call,
counted, not estimated — an upper bound, because a single reasoning turn could
have issued several tool calls. A plan of N steps removes N − 1 round-trips when
it runs to the end.

## Stop conditions

- Two consecutive failed expectations: stop substituting and work normally.
- The plan stops itself; do not re-run it hoping for a different result.

`harnessmm_bench` is a measurement harness, not a work tool: use it only when
someone asks how the mechanism performs.
