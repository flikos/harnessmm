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

## Boundary substitution (opt-in, off by default)

A chain substitutes *inside* one tool call. Boundary substitution replaces the model call that
decides the tool call: when the incoming request is one a stored decision already covers, the
plugin answers `llm/stream` with that decision's tool call, and the loop executes it as if the model
had chosen it.

It is off unless a profile enables it, because a listener here replaces a whole model turn:

```yaml
- id: harnessmm
  name: '@local/harnessmm'
  config:
    substitution:
      enabled: true
      decisionsPath: /tmp/decisions.json   # default ~/.harnessmm/decisions.json
      maxPerSession: 5
```

```json
{"decisions": [
  {"id": "run-project-task",
   "fingerprint": "e1dc1d6d7bdf275b",
   "tool": "bash",
   "arguments": {"description": "run the project task", "command": "make check"}}
]}
```

The fingerprint is `sha256(normalized authored request)` truncated to 16 hex characters, where the
authored request is the last user message a person wrote — the loop appends runtime context as
further user messages, so the last user message is not the turn. Compute it with
`fingerprintRequest(options)` from [lib/substitution.js](lib/substitution.js).

Refusal is the default. The listener passes straight through when: the policy is disabled; the call
is internal (`purpose` is `session-title` or `compaction`); no decision matches the fingerprint; the
decision is malformed (no tool, unparseable arguments); the decision was already spent in this
session; or the per-session cap is reached. A decision is spent once per session on purpose — the
authored request stays in the conversation after the synthesized call runs, so a second match on the
follow-up request would substitute the same decision forever.

**Measured delta, equal conditions** (isolated profile, stub model that really decides to call a
tool, same prompt both arms):

| arm | model calls | tool ran | final answer |
| --- | --- | --- | --- |
| substitution disabled | 3 | yes | `ANSWER-AFTER-TOOL` |
| substitution enabled | 2 | yes | `ANSWER-AFTER-TOOL` |

One model call removed per substituted decision — the call that existed only to choose the tool.
This is a counted difference, not a token estimate. It does not remove the call that interprets the
tool result, and it says nothing about how often a real conversation matches a stored decision.

To reproduce, point the run at its own ledger, or the measurement lands in the live one:

```bash
HARNESSMM_HOME=/tmp/poc/hm HARNESSMM_USAGE_DIR=/tmp/poc/hm/usage \
  dsh --profile poc "Run the project task [[RUN-TOOL]]"
```

## The honest boundary

1. **Chains do not rewrite the agent loop; boundary substitution does, and it is opt-in.** Inside a
   `harnessmm_chain` call the granularity is "tool call": the model still authors the graph and reads
   the result. The `llm/stream` listener described above replaces a reasoning step outright — which
   is why it ships disabled, must be turned on per profile, and passes every unmatched or malformed
   case back to the model.
2. **Boundary-level substitution in DSH is possible, and measured here without vendoring.**
   `llm.stream()` and `preparedCall.stream()` both dispatch through the `llm/stream` waterfall, as
   [DSH-Extensions-list/dsh-harnessmm](https://github.com/DSH-Extensions-list/dsh-harnessmm) does
   with the authors' vendored controller. Two constraints the measurements exposed: one turn is more
   than one model call (the request and `purpose: 'session-title'`), so an interceptor must select by
   `purpose`; and the loop appends runtime context *after* the user message, so matching must use the
   authored turn, not the last message. Earlier revisions of this README claimed a plugin *cannot*
   remove a live model callback; that was wrong.
3. **A stored decision is a curated asset, not an inference.** Substitution matches a fingerprint
   computed from the request text, so it fires only where someone registered a decision. How often
   that happens in real work is unmeasured: the count in the table is a controlled comparison, not
   an adoption number.
4. **Guards prove their own condition, not correctness.** `exit_code(compile) == 0` proves the
   build succeeded, not that the program is right.
5. **Benchmark token numbers are `characters / 4` estimates** over exact prompt strings, from a
   scripted actor — not tokenizer counts, not model quality claims.

## Related implementations

| | [jlon/pi-harnessmm](https://github.com/jlon/pi-harnessmm) | [DSH-Extensions-list/dsh-harnessmm](https://github.com/DSH-Extensions-list/dsh-harnessmm) | this repo |
| --- | --- | --- | --- |
| platform | pi | DSH | DSH |
| mechanism | controller inside the root terminal call | `llm/stream` interception, authors' vendored code (7.8 MB, pinned rev) + Python RSI | explicit chain tool plus opt-in `llm/stream` substitution from a stored-decision match, own implementation |
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