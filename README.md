# HarnessMM for DeepSeek Harness

A working toolkit for the mechanism from [HarnessMM (arXiv:2610.32813)](https://arxiv.org/abs/2610.32813):
**guarded decision reuse** — a controller executes decisions that were already resolved, on evidence
from observed receipts, instead of paying for another reasoning call.

This is an independent implementation written from the paper, not a port of the authors' code. It
ships as a DSH plugin with three tools, a measurement lab, and an agent skill that says when the
mechanism pays for itself and when it does not.

New here? [docs/quickstart.md](docs/quickstart.md) is the two-minute version.

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

Each line also carries `session` — the first 8 characters of the caller's session id — because a
ledger without it cannot distinguish a maintainer's smoke test from real work. The profile name is
deliberately absent: the Host inherits ambient environment, so a run inside one profile can report
another profile's name, and a misleading field is worse than a missing one.

The agent skill lives in [skills/harnessmm/SKILL.md](skills/harnessmm/SKILL.md) (installed copy:
`~/.agents/skills/harnessmm/`): triggers (≥3 mechanical steps with observable gates), anti-triggers
(exploration, content-branching, <3 steps), guard rules and stop conditions.

## How a chain gets used without anyone registering phrases

Understanding a request is the model's job, so the plugin does not carry a phrase registry. What a
library saves is the *plan*: once a sequence of mechanical steps with observable gates exists,
re-deriving it costs a reasoning call at every step.

A saved chain declares what it is **for**:

```json
{"name": "verify-package",
 "intent": "проверить пакет: тесты и замер",
 "description": "test suite, then the lab benchmark"}
```

Later, the model passes the request in the person's own words:

```
harnessmm_chain { solve: "прогони тесты и замер для пакета", rootId: "s1" }
```

The library scores saved chains by how much of their declared intent the request actually talks
about — stemmed, stopword-free tokens, so `тесты`/`тест`/`тестов` are one term. Coverage is the bar
that a shared vague word cannot clear; precision is deliberately *not* a bar, because a person who
asks for the verification plus three other things still wants the verification. A miss returns what
exists, and the model authors a graph instead.

There is no interception in this path: the chain reports receipts, and the model reads them.

**Measured on the live library** (the seeded `verify-package` chain, `intent: "проверить пакет:
тесты и замер"`):

| request | result |
| --- | --- |
| `прогони тесты и замер для пакета` | match, score 1.0 |
| `проверить пакет полностью, прогони тесты и сделай замер, потом покажи сводку…` | match, score 1.0 |
| `проверь пакет` | match, score 0.23 |
| `Проверь плагин. Посмотри, что реализовано и как это можно улучшить?` | no match |
| `Переведи этот текст на английский` | no match |
| `Перепиши этот модуль на TypeScript` | no match |

The first row is the point: the sentence that defeated phrase registration — a natural request
starting with a remembered phrase, followed by a real question — no longer has to match exactly.
The last two rows are the other half: a request that shares nothing is not captured, even though
`плагин` appears in a description.

## The honest boundary

1. **This plugin does not rewrite the agent loop.** Substitution happens in one explicit tool call:
   the model asks for a chain with `solve`, or authors one. The model still reads the receipts and
   writes the answer.
2. **The mechanism can remove a live model call, and this plugin deliberately does not ship that.**
   A `llm/stream` listener can answer a turn without the adapter ever being entered — measured, both
   entry points (`llm.stream`, `preparedCall.stream`), with the adapter's own call counter as
   negative evidence. An earlier revision shipped exactly that as phrase-keyed substitution and an
   earlier revision still claimed the opposite was impossible; both were wrong, in opposite
   directions.
3. **A stored chain is a curated asset, not an inference.** `solve` matches declared intents, so it
   fires only where someone saved a chain and said what it is for. How often that happens in real
   work is unmeasured; the table above is a matrix of wordings, not an adoption number.
4. **Why phrase registration was removed.** Matching a request against registered *phrases* puts the
   meaning where there is none — in a config file, keyed to wording a person must predict. The first
   live test failed exactly as designed: a natural sentence beginning with the registered phrase did
   not match it. The model reads meaning; the library is matched against what a chain *does*.
5. **Guards prove their own condition, not correctness.** `exit_code(compile) == 0` proves the
   build succeeded, not that the program is right.
6. **Benchmark token numbers are `characters / 4` estimates** over exact prompt strings, from a
   scripted actor — not tokenizer counts, not model quality claims.

## Related implementations

| | [jlon/pi-harnessmm](https://github.com/jlon/pi-harnessmm) | [DSH-Extensions-list/dsh-harnessmm](https://github.com/DSH-Extensions-list/dsh-harnessmm) | this repo |
| --- | --- | --- | --- |
| platform | pi | DSH | DSH |
| mechanism | controller inside the root terminal call | `llm/stream` interception, authors' vendored code (7.8 MB, pinned rev) + Python RSI | explicit chain tool with intent-matched saved chains (`solve`); `llm/stream` substitution proven but not shipped |
| graph contract | authors' `<CHISEL_PLAN>`, parity-tested against the reference | authors' schema, vendored | own EDG schema (incompatible with `<CHISEL_PLAN>`) |
| adopted from them | — | — | three-valued guard verdicts, `required_receipt_fields`, env scrubbing, substitutions-not-counterfactuals accounting |

## Development

```bash
node --test test/*.test.mjs    # 68 tests
node bin/bench.mjs [--tasks add,roman] [--json]
```

Install into a profile with `plugin_manager` `install_bundle` pointing at this directory; source
changes under `lib/` need remove + install to reach the running Host. No LICENSE yet — the repo is
public but all rights reserved until one is chosen.