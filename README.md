# HarnessMM for DeepSeek Harness

A working toolkit for the mechanism from [HarnessMM (arXiv:2610.32813)](https://arxiv.org/abs/2610.32813):
**guarded decision reuse** — a controller executes decisions that were already resolved, on evidence
from observed receipts, instead of paying for another reasoning call.

This is an independent implementation written from the paper, not a port of the authors' code. It
ships as a DSH plugin with three tools, a measurement lab, and an agent skill that says when the
mechanism pays for itself and when it does not.

## Tools

| tool | role |
| --- | --- |
| `harnessmm_chain` | the work tool: executes an authored decision graph in the session directory with **zero model calls between nodes** |
| `harnessmm_validate` | admission check for a graph before anyone trusts it |
| `harnessmm_bench` | measurement lab: the same scripted task set through a baseline arm and a guarded-reuse arm |

## How a chain works

A chain is an Executable Decision Graph (EDG): nodes with an `action` (`write` or `shell`), fully
literal `args`, an `after` predecessor, and a `guard` over observed evidence.

```json
{"nodes": [
  {"id": "s1", "action": "write", "args": {"path": "solution.py", "content": "..."}},
  {"id": "s2", "action": "shell", "args": {"cmd": "python3 -m py_compile solution.py"},
   "after": "s1", "guard": {"op": "exit_code", "of": "s1", "eq": 0},
   "required_receipt_fields": ["exitCode"]},
  {"id": "s3", "action": "shell", "args": {"cmd": "python3 check.py"},
   "after": "s2", "guard": {"op": "exit_code", "of": "s2", "eq": 0},
   "required_receipt_fields": ["exitCode"]}
]}
```

A node runs only when its predecessor completed **and** its guard is proven by receipts already
observed. Every substitution issues a certificate binding the graph hash, the decision, the
predecessor receipt, the exact arguments and the tool receipt; `verifyCertificate` re-derives the
binding on demand.

**Guards** read receipts and files only: `exists`, `exit_code`, `stdout_contains`,
`stderr_contains`, `file_exists`, `file_contains`, `json_field` (a file or a receipt's stdout, with
nested field paths like `a.b[0].c` and `eq`/`ne`/`exists`), composed with `all`/`any`/`not`.
Unknown operators, unreadable evidence and paths escaping the working directory all fail closed.
`required_receipt_fields` makes a node declare which receipt fields its guard reads; compilation
rejects a guard on an undeclared field.

**Three-valued verdicts.** Every evaluation separates *the evidence says no* (`guard-negative`, a
fact) from *the evidence cannot be read* (`evidence-absent` / `evidence-unreadable`). A stopped
chain reports the reason per pending node — in the rendered result, the returned value and the
ledger — so a deferral is diagnosable instead of guesswork.

**Stopping.** The chain stops on the first unproven guard (`deferred`), a refused command or
executor failure (`error`), an invalid graph (rejected before anything runs), or `maxSteps`.
A stopped result carries the full output of the failing step (up to 16 KB, not a table cell) and a
`receipts` block: pass it back with a repaired graph and finished nodes are not re-executed.

**Saved graphs.** `{graph, name, save: true}` validates and stores a graph under
`~/.harnessmm/graphs/<name>.json`, plus an immutable `<name>@<stamp>.json` copy so a certificate's
`graph_hash` always resolves to the exact graph it was issued for. `{name}` runs it; `{list: true}`
shows saved graphs and usage counters.

## Executor modes and safety

| mode | shell runs in | consent | notes |
| --- | --- | --- | --- |
| `direct` (default) | the Host process via `spawnSync` | `allowShell: true` required | fastest; outside the bash tool's sandbox |
| `sandboxed` | the native `bash` tool (`ctx.tools.execute`) | none beyond the call | inherits file sandbox, permission policy and approvals; result parsing is fail-closed |

Both modes refuse a denylist of destructive commands (`sudo`, recursive delete of `/`, `mkfs`,
`dd if=`, piping a download into a shell, fork bombs, raw disk writes) and honour a per-node
`timeoutMs`. Direct execution scrubs environment variables whose name matches
`key|password|secret|token|credential|passwd`, so an unattended command cannot echo a credential
into the transcript. `write` nodes are confined to the working directory in both modes.

## What it measures

Two independent measurements, both reproducible:

**Lab benchmark** (`node bin/bench.mjs`, 8 scripted coding tasks, real `python3` subprocesses,
character/4 token estimate): 19 reasoning callbacks avoided, 2 215 tokens removed (38.01 %),
graph authorship overhead 669 tokens, break-even 5 substituted callbacks, 19/19 certificates
verified. The actor is a deterministic replay, so the two arms differ only in *when* a decision is
produced.

**Live session experiment** ([docs/benefit-report.md](docs/benefit-report.md)): one real
verification task (syntax → tests → bench → git → report) run as 5 separate tool calls versus
validate + one chain call — 3 model steps and ~33 s of step latency saved, ~2k tokens kept out of
the replayed transcript, identical outcomes.

Savings reporting is deliberately split: **substitutions are measured; token and time savings are a
labeled constant model** (`avgStepTokens`/`avgStepMs`), never presented as measured tokens.

## Observability

Every invocation appends one JSON line to `~/.harnessmm/usage/usage.jsonl` (override with
`HARNESSMM_USAGE_DIR`; the legacy temporary ledger is migrated once): tool, arguments, stop reason,
certificates, executor, per-node `stepMs`, defer reasons and the savings model output. Test runs
write to a throwaway ledger, never the live one.

The agent skill lives in [skills/harnessmm/SKILL.md](skills/harnessmm/SKILL.md) (installed copy:
`~/.agents/skills/harnessmm/`): triggers (≥3 mechanical steps with observable gates), anti-triggers
(exploration, content-branching, <3 steps), guard rules and stop conditions.

## The honest boundary

1. **This plugin does not rewrite the agent loop.** Substitution happens inside one explicit
   `harnessmm_chain` call — granularity "tool call", not "reasoning boundary". The model still
   authors the graph and reads the result.
2. **Boundary-level substitution in DSH is possible, just not here.** A plugin can intercept
   `llm/stream` and answer with a synthesized tool call, as
   [DSH-Extensions-list/dsh-harnessmm](https://github.com/DSH-Extensions-list/dsh-harnessmm)
   demonstrates with the authors' vendored controller. Earlier revisions of this README claimed a
   plugin *cannot* remove a live model callback; that was wrong — it was based on `agent/pre-step`
   alone. A minimal proof-of-concept of `llm/stream` interception (probe profile, no vendoring) is
   on the roadmap.
3. **Guards prove their own condition, not correctness.** `exit_code(compile) == 0` proves the
   build succeeded, not that the program is right.
4. **Benchmark token numbers are `characters / 4` estimates** over exact prompt strings, from a
   scripted actor — not tokenizer counts, not model quality claims.

## Related implementations

| | [jlon/pi-harnessmm](https://github.com/jlon/pi-harnessmm) | [DSH-Extensions-list/dsh-harnessmm](https://github.com/DSH-Extensions-list/dsh-harnessmm) | this repo |
| --- | --- | --- | --- |
| platform | pi | DSH | DSH |
| mechanism | controller inside the root terminal call | `llm/stream` interception, authors' vendored code (7.8 MB, pinned rev) + Python RSI | explicit chain tool, own implementation from the paper |
| graph contract | authors' `<CHISEL_PLAN>`, parity-tested against the reference | authors' schema, vendored | own EDG schema (incompatible with `<CHISEL_PLAN>`) |
| adopted from them | — | — | three-valued guard verdicts, `required_receipt_fields`, env scrubbing, substitutions-not-counterfactuals accounting |

## Development

```bash
node --test test/*.test.mjs    # 56 tests
node bin/bench.mjs [--tasks add,roman] [--json]
```

Install into a profile with `plugin_manager` `install_bundle` pointing at this directory; source
changes under `lib/` need remove + install to reach the running Host. No LICENSE yet — the repo is
public but all rights reserved until one is chosen.