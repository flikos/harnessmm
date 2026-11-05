# Quickstart

Two minutes to know what this plugin does and how to drive it. Details and measurements:
[README](../README.md); one measured case: [benefit-report](benefit-report.md).

## What it does

Guarded decision reuse from [HarnessMM (arXiv:2610.32813)](https://arxiv.org/abs/2610.32813):

**`harnessmm_chain` — run a decided plan without re-deciding.** You hand it a graph of mechanical
steps; it runs them in order, and between nodes the model is not called at all. Each step is gated by
evidence from the previous one (exit code, file existence, JSON field), so a failed step stops the
chain instead of being papered over. A chain saved with an `intent` is found later by *your* wording,
so the second run costs neither authoring nor a phrase registry.

It does not decide anything for you, does not infer new decisions, and does not touch the model loop.

## Install

```
plugin_manager action=install_bundle target=/absolute/path/to/harnessmm
```

or, without the Harness UI:

```
dsh plugin --profile <profile> add /absolute/path/to/harnessmm
```

Source changes under `lib/` reach a running Host only after `remove_bundle` + `install_bundle`.

## Use the chain

Reach for it when a task is **≥3 mechanical steps whose readiness is observable** — build → test →
lint → format → commit, or the same sequence over many files. Do not reach for it when the next step
depends on what the output *means*, or when there are one or two steps.

```json
{"nodes": [
  {"id": "s2", "action": "shell", "args": {"cmd": "node --test test/*.test.mjs"}, "after": "s1",
   "guard": {"op": "exit_code", "of": "s1", "eq": 0}},
  {"id": "s3", "action": "shell", "args": {"cmd": "node bin/bench.mjs"}, "after": "s2",
   "guard": {"op": "json_field", "of": "s2", "field": "ok", "eq": true}}
]}
```

Guard operators: `exists`, `exit_code`, `stdout_contains`, `stderr_contains`, `file_exists`,
`file_contains`, `json_field` (with `field` plus `exists` / `eq` / `ne`), and the combinators `all`,
`any`, `not`. An unreadable receipt is not treated as a failure — it is reported as unknown and stops
the chain with `deferred`.

Call it with the graph and a `rootId` for the step you already ran yourself:

```
harnessmm_chain(graph: {...}, rootId: "s1")
harnessmm_chain(solve: "прогони тесты и замер для пакета", rootId: "s1")   # reuse a saved chain
```

What comes back: `markdown` (what ran, what it proved), `stopReason` (`completed` or `deferred`),
`certificates` (how many guards were actually proven), `receipts`, and `deferReasons` naming the node
that stopped the chain and why. Feed `receipts` back in a later call to resume: finished nodes are not
re-run.

Choices worth knowing:

| argument | default | meaning |
| --- | --- | --- |
| `executor` | `direct` | `sandboxed` runs shell through the native bash tool and inherits its sandbox and permissions |
| `allowShell` | `false` | required for `direct`; runs in the Host process, outside the bash sandbox |
| `name` + `save` | — | store the graph under a name instead of running it |
| `name` alone | — | run a saved graph; every save keeps a versioned copy |
| `list` | — | show saved graphs and how often each was used |
| `maxSteps` | `20` | hard cap on executed nodes |

## Let the model find the chain itself

You do not register phrases and you do not have to remember commands. A saved chain states what it
is for, and the request you write in your own words is matched against that:

```
harnessmm_chain { solve: "прогони тесты и замер для пакета", rootId: "s1" }
```

That is the model's job to issue — you just ask for the work. What you may want to do by hand is
*have* a library worth matching, which means saving chains with an `intent`:

```json
{"graph": {...}, "save": true, "name": "verify-package",
 "intent": "проверить пакет: тесты и замер",
 "description": "test suite, then the lab benchmark", "rootId": "s1"}
```

`intent` is the only registration this plugin has. A chain saved without it runs by name and is
never suggested — that is intentional, not an oversight.

Matching rules worth knowing:

- Words are stemmed and stopwords dropped, so `тесты`, `тест` and `тестов` are one term, and
  `проверь`/`посмотри`/`сделай` are ignored as ways of asking rather than things asked for.
- A chain's `intent` must therefore describe **what it does**, not how someone phrases the request.
- Coverage decides: one shared vague word cannot claim a chain. A request that asks for the chain's
  work plus three other things still matches.

## Check what actually happened

Every call appends one line to `~/.harnessmm/usage/usage.jsonl` (override `HARNESSMM_USAGE_DIR`):
tool, stop reason, certificates, executor, per-node timings, defer reasons, and the
caller's `session`. Saved graphs live in `~/.harnessmm/graphs`.

```
node --test test/*.test.mjs          # 68 tests
node bin/bench.mjs [--tasks add,roman] [--json]
```

## Boundaries

- Guards prove their own condition, not that the program is right.
- Benchmark token numbers are `characters / 4` estimates over exact prompt strings, not tokenizer
  counts and not claims about model quality.
- Substitution fires only where someone registered a decision; how often that happens in real work
  is unmeasured.
- `allowShell` and `denylist` are defence in depth, not a sandbox.