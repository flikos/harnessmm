# HarnessMM prototype

A working prototype of the mechanism from [HarnessMM (arXiv:2610.32813)](https://arxiv.org/abs/2610.32813):
a controller at the model–tool boundary that executes **already resolved** decisions on
observed receipts instead of paying for another reasoning call.

## What is implemented

| piece | file | what it does |
| --- | --- | --- |
| EDG schema + compile | `lib/graph.js` | nodes with literal args, predecessor, guard; rejects placeholders, cycles, non-causal guards, unknown ops |
| Guards | `lib/guards.js` | `exists`, `exit_code`, `stdout_contains`, `stderr_contains`, `file_exists`, `file_contains`, `json_field`, `all/any/not`; evidence comes only from receipts and files, unknown evidence throws |
| Controller | `lib/controller.js` | eligibility = predecessor completed ∧ guard proven ∧ args closed; unique → execute, ambiguous → abstain, none → defer to actor |
| Certificates | `lib/controller.js` | binds graph hash, decision id, predecessor receipt, exact args, tool receipt, bypassed callback; `verifyCertificate` replays the binding |
| Accounting | `lib/cost.js` | per-call input/output estimates, break-even |
| Benchmark | `lib/report.js`, `bin/bench.mjs` | same tasks and tools through baseline vs guarded-reuse arm |

The benchmark executes **real tools** (`write`, `python3 -m py_compile`, `python3 check.py`) in
temporary directories.

## Reading a structured answer without the model

`json_field` turns a machine-checkable result into a guard, so the next step in the chain runs on
the receipt alone:

```json
{"id": "s3", "action": "shell", "args": {"cmd": "python3 verify.py"}, "after": "s2",
 "guard": {"op": "json_field", "of": "s2", "field": "answer", "eq": 42}}
```

`of` parses the predecessor's stdout as JSON; `path` reads a JSON file under the task directory
(same containment rule as `file_exists`). The field path supports nesting and indexes
(`a.b[0].c`), and the comparison is `eq`, `ne` or `exists`. `file_contains` checks raw file text.

Fail-closed behaviour: an absent file or field is `false` (no evidence, node stays ineligible),
malformed JSON raises `GuardError` (the controller then defers to the model), and a path outside
the working directory is refused.

## Measured result (8 tasks, character/4 token estimate)

| metric | baseline | HarnessMM |
| --- | --- | --- |
| success | 8/8 | 8/8 |
| reasoning calls | 37 | 18 |
| total tokens | 5 828 | 3 613 |
| tokens / task | 728.5 | 451.6 |

- callbacks avoided: **19**
- tokens removed: **2 215** (38.01 %)
- graph authorship overhead: **669** tokens
- break-even: **5** substituted callbacks per compiled graph
- certificates: **19** issued, **19** verified by replay
- graphs rejected by closure/dependency checks: 0

Reproduce: `node bin/bench.mjs` (add `--json` for the summary object).

## The honest boundary

1. **The actor is a replay, not an LLM.** Its decisions are scripted so the two arms make the
   same semantic choices; only the *moment* of the reasoning call differs. Token counts are
   `characters / 4` over the exact prompt and decision strings, not a tokenizer.
2. **This does not skip a live model call in DSH.** `agent/pre-step` can reject or replace
   messages but cannot suppress a reasoning step, so a plugin cannot remove a callback from a
   running session. The prototype therefore runs the substitution in-process, and the installed
   plugin exposes `harnessmm_bench` / `harnessmm_validate` rather than silently rewriting the agent.
3. **Guards prove their own condition, not correctness.** `exit_code(compile) == 0` proves the
   build succeeded; it does not prove the program is right. The two repair tasks (roman, balanced)
   exercise the fail-closed path: the tests node stays ineligible, control returns to the actor,
   and the actor authors a second graph.

## Installed as a plugin

The package is a DSH bundle (`dsh.bundle.patch`), installed in the `desktop` profile. It adds two
tools: `harnessmm_validate` (graph admission check) and `harnessmm_bench` (measured accounting).

## How to tell the plugin was used

A tool call is the only way this plugin can act, so usage is never implicit. Three traces, in order
of strength:

1. **The tool card in the session** — the call and its rendered result are part of the transcript.
2. **`usage.jsonl`** — one line per invocation (`at`, `tool`, arguments, outcome), appended to
   `$HARNESSMM_USAGE_DIR`, default `<tmp>/harnessmm-out/usage.jsonl`:
   `{"at":"2026-11-03T04:06:26.830Z","tool":"harnessmm_bench","tasks":["add","gcd"],...}`
3. **Artifacts with timestamps** — `report.md` / `results.json` are rewritten per run; the
   certificates inside are the evidence that substitutions actually happened (a certificate whose
   receipt no longer matches fails verification).

The ledger was added after the plugin was already loaded, so the running Host keeps the previous
module generation until Harness restarts.

## When this mechanism pays off

Good fit: long mechanical chains whose next step is decided by a *receipt* rather than by meaning
(build → test → lint → run, migrations, batch pipelines over many similar items), and repeated
patterns where one authored graph serves several transitions.

Bad fit: one- or two-step tasks (graph authorship does not amortise — break-even was 5 substituted
callbacks in the measured run), steps that branch on the *content* of an observation, exploratory
debugging, and anything where a guard's proven condition is weaker than the correctness you need.