# Quickstart

Two minutes to know what this plugin does and how to drive it. Details and measurements:
[README](../README.md); one measured case: [benefit-report](benefit-report.md).

## What it does

Two mechanisms from [HarnessMM (arXiv:2610.32813)](https://arxiv.org/abs/2610.32813), one explicit
and one opt-in:

1. **`harnessmm_chain` — run a decided plan without re-deciding.** You hand it a graph of mechanical
   steps; it runs them in order, and between nodes the model is not called at all. Each step is gated
   by evidence from the previous one (exit code, file existence, JSON field), so a failed step stops
   the chain instead of being papered over.
2. **Boundary substitution — skip the model call that decides.** Off by default. When a stored
   decision matches the incoming request, the plugin answers the model stream with that decision's
   tool call, and the loop executes it. Measured: 3 model calls → 2 for the same task.

It does not decide anything for you, does not infer new decisions, and does not touch the model loop
unless you turn substitution on.

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

## Use boundary substitution (opt-in)

Turn it on per profile — a listener here replaces a whole model turn, so it never turns itself on:

```yaml
- id: harnessmm
  name: '@local/harnessmm'
  config:
    substitution:
      enabled: true
      decisionsPath: /tmp/decisions.json   # default: ~/.harnessmm/decisions.json
      maxPerSession: 5
```

Register the decisions the model should stop re-deriving:

```json
{"decisions": [
  {"id": "run-project-task",
   "fingerprint": "e1dc1d6d7bdf275b",
   "tool": "bash",
   "arguments": {"description": "run the project task", "command": "make check"}}
]}
```

The fingerprint is `sha256` of the normalized text of the last message a person wrote, truncated to
16 hex characters — runtime context appended by the loop does not count. Compute it with
`fingerprintRequest(options)` from [lib/substitution.js](../lib/substitution.js).

It refuses — and passes straight through to the model — when the policy is off, the call is internal
(`session-title`, `compaction`), nothing matches, the decision is malformed, that decision was already
spent in this session, or `maxPerSession` is reached. A decision is spent once per session by design:
the original request stays in the conversation, so a second match would substitute forever.

## Check what actually happened

Every call appends one line to `~/.harnessmm/usage/usage.jsonl` (override `HARNESSMM_USAGE_DIR`):
tool, stop reason, certificates, executor, per-node timings, defer reasons, substitutions, and the
caller's `session`. Saved graphs live in `~/.harnessmm/graphs`, decisions in `~/.harnessmm/decisions.json`.

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