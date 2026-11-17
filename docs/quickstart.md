# Quickstart

Two minutes to know what the plugin does and how to drive it. Design and measurements:
[README](../README.md).

## What it does

You ask for work. The model plans it, and part of the plan is mechanical: run a command, check the
result, run the next one. `harnessmm_chain` runs that part in a single call — no model round-trip
between steps. It stops the moment reality disagrees and hands back what it saw.

Nothing is registered or saved beforehand. The plan is stated in the call, every time.

## Install

```
plugin_manager action=install_bundle target=/absolute/path/to/harnessmm
```

or, without the Harness UI:

```
dsh plugin --profile <profile> add /absolute/path/to/harnessmm
```

Source changes under `lib/` reach a running Host only after `remove_bundle` + `install_bundle`.

## The common case

```
harnessmm_chain { steps: [
  { run: { cmd: "npm run build" } },
  { run: { cmd: "npm test" },  expect: { op: "exit_code", eq: 0 } },
  { run: { cmd: "npm run lint" }, expect: { op: "exit_code", eq: 0 } }
], executor: "sandboxed" }
```

- The **first step** has no predecessor and no expectation — a plan starts from nothing.
- Every later step runs only when the step above produced what `expect` describes.
- `expect` reads the step above by default; that is why it does not repeat the id.

What comes back:

```
Chain completed: 3 step(s), 2 model round-trip(s) skipped (counted)
```

Two steps ran without asking you or the model anything; the figure says how many boundaries were
crossed, nothing about tokens or time.

## When a step disagrees

| status | meaning | what you get |
| --- | --- | --- |
| `exhausted` | everything ran | the step table |
| `expectation-failed` | the previous step produced something else | the failing step's full output |
| `evidence-unreadable` | the expected fact was not in the output | the step, and which fact was missing |
| `execution-error` | the command could not run | the error |
| `invalid-graph` | the plan failed validation; nothing executed | the list of validation errors |
| `deferred` | several steps were ready and the selector could not pick one | the eligible step ids |
| `max-steps` | the step cap was reached | how far it got |

Steps after the stopping one do not run.

## Expectations you can write

`exit_code`, `stdout_contains`, `stderr_contains`, `file_exists`, `file_contains`, `json_field`
(with `field` plus `exists`/`eq`/`ne`), `exists`, and the combinators `all`, `any`, `not`.

Two rules that matter:

- An argument must be a **literal**. `deploy $TARGET` is rejected: an unresolved value means the step
  still depends on future reasoning, which is what this tool exists to avoid.
- A guard proves its own condition, not correctness. "The build exited 0" is not "the program works".

## Choosing the executor

| executor | what runs | when |
| --- | --- | --- |
| `sandboxed` (prefer) | the native bash tool — its sandbox, policy and approvals apply | almost always |
| `direct` | the Host process, outside the bash sandbox; needs `allowShell: true` | trusted mechanical commands only |

Both refuse a short list of destructive patterns. The list is defence in depth, not a sandbox.

## Branching plans

When the plan is not a straight line, pass `graph` instead:

```json
{ "nodes": [
   {"id": "a", "action": "shell", "args": {"cmd": "make build"}},
   {"id": "b", "action": "shell", "args": {"cmd": "make test"}, "after": "a",
    "guard": {"op": "exit_code", "of": "a", "eq": 0},
    "required_receipt_fields": ["exitCode"]}
] }
```

Both forms compile to the same plan; a guard means the same thing either way. If a node's id collides
with the `rootId` receipt you passed, the node is renamed `<id>__shadowed` in the report — the root
receipt keeps its name.

## Check what actually happened

Every call appends one line to `~/.harnessmm/usage/usage.jsonl` (override `HARNESSMM_USAGE_DIR`):
status, steps, certificates, executor, per-step timings, the failing step and
`avoidedRoundTrips` — the number of model boundaries crossed without a call, counted, not estimated.

## Checking a plan before running it

```
harnessmm_validate { graph: {...} }
```

Rejects literal placeholders, unknown predecessors, cycles and guards reading fields they did not
declare. A rejected plan executes nothing.

## Boundaries

- The tool removes round-trips inside a plan; it does not decide the plan.
- It never touches the model stream.
- Benchmark token numbers in `harnessmm_bench` are `characters / 4` estimates, not tokenizer counts.
