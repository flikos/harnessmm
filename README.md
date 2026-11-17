# HarnessMM for DeepSeek Harness

Guarded decision reuse from [HarnessMM (arXiv:2610.32813)](https://arxiv.org/abs/2610.32813), as a
DSH plugin: the model decides a sequence **once**, states what it expects from each step, and the
plugin runs the rest without waking it.

Two minutes in: [docs/quickstart.md](docs/quickstart.md).

## The idea in one paragraph

A person asks the agent to do real work. Part of the plan is mechanical — run a command, check it
produced what was expected, run the next one. Normally each of those steps costs a model round-trip,
because after every tool result the model has to be woken to say "continue". Here the model states the
whole continuation at the moment it starts, with an expectation per step. Where the expectation holds
the plugin keeps going on its own; where it does not, it stops and hands over what it saw.

## The plan

Two forms, one engine. Pass whichever fits:

**Linear** — the everyday case:

```json
{ "steps": [
    { "run": { "cmd": "npm run build" } },
    { "run": { "cmd": "npm test" }, "expect": { "op": "exit_code", "eq": 0 } },
    { "run": { "cmd": "npm run lint" }, "expect": { "op": "exit_code", "eq": 0 } }
] }
```

The first step needs no predecessor: a plan starts from nothing. Every later step runs only when the
one above it produced what `expect` describes, and `expect` defaults to reading the step above, so the
common case says it once.

**Graph** — for branching procedures: `{ "nodes": [ {id, action, args, after, guard} ] }`. Both forms
compile to the same plan and hash identically, so a guard means the same thing wherever it arrived.

Expectations use one vocabulary in both forms: `exit_code`, `stdout_contains`, `stderr_contains`,
`file_exists`, `file_contains`, `json_field` (with `field` plus `exists`/`eq`/`ne`), `exists`, and the
combinators `all`, `any`, `not`.

## The seven ways a plan stops

| status | meaning | what the caller does |
| --- | --- | --- |
| `exhausted` | every step ran | answer |
| `expectation-failed` | the world disagreed with the plan | read `failure`, which carries the failing step's full output |
| `evidence-unreadable` | the expected fact was not in the output | do not guess |
| `execution-error` | the command could not run | fix the invocation |
| `invalid-graph` | the plan failed validation; nothing executed | fix the plan — the `detail` lists every error |
| `deferred` | several nodes were ready and the selector could not pick one without a semantic judgement | decide between the eligible steps, or pass `selector: "priority"` |
| `max-steps` | the hard cap on executed nodes was reached | split the plan |

Each stop names the step that caused it; `invalid-graph` is the one that names the plan itself.

## What it measures

The claim is a **count, stated as an upper bound**: `avoidedRoundTrips` is the number of model
boundaries the plan crossed without a call — for a plan with N executed steps, N − 1. It is an upper
bound because an agent could in principle issue several tool calls in one reasoning turn; when that
happens a step does not cost a round-trip. There is no token or time figure
anywhere in the result: a number nobody measured would compete with the one that was.

Measured on a live profile (the run recorded in this repository's history):

```
harnessmm_chain { steps: [ tests, count-modules ], executor: "sandboxed" }
→ Chain completed: 2 step(s), 1 model round-trip(s) skipped (counted)
→ ledger: { stopReason: "exhausted", certificates: 2, avoidedRoundTrips: 1,
            stepMs: [{s1: 612}, {s2: 30}] }
```

The counting executor in the tests (`lib/counting.js`) records every command the run issues, which is
how "no model call between the steps" is observed rather than asserted. A plan of N steps removes
N − 1 round-trips **when it runs to the end**; a plan that stops reports fewer — what happened, not
what might have.

The counting itself is not done by the tool but by a wrapping executor in the tests
(`lib/counting.js`), so "no model call between the steps" is demonstrated, not asserted.

## Safety

- `executor: "sandboxed"` runs each command through the native bash tool: its sandbox, its permission
  policy and its approvals apply. Prefer it.
- `executor: "direct"` needs `allowShell: true`, runs in the Host process and is outside the bash
  sandbox: only for commands you trust.
- A short deny list refuses destructive patterns in both modes. It is defence in depth, not a
  sandbox: it catches typos and obvious mistakes, not concealment — `bash -c 'sudo …'`, base64
  wrapping or rearranged arguments all pass it. The sandboxed executor is the real boundary.
- Spawned commands get a scrubbed environment: variables with credential-like names or
  well-known vendor prefixes (GH_, AWS_, AZURE_, …) are removed. Also a denylist, not a
  guarantee: a secret under an innocent name still passes through.
- A plan that fails validation executes nothing.
- Every step has a timeout; the whole plan has a step cap. Write steps are capped at one
  million characters.

## The honest boundary

1. **The model still decides.** This tool removes round-trips *within* a plan the model authored; it
   never chooses what to do. It does not touch the model stream.
2. **The mechanism can remove a live model call, and this plugin does not ship that.** A `llm/stream`
   listener can answer a turn without the adapter ever being entered — measured, through both entry
   points, with the adapter's own call counter as negative evidence. Shipping it would mean replacing
   a reasoning step outright; the design here keeps the model in charge instead.
3. **A plan is only as good as its expectations.** A guard proves its own condition, not
   correctness: `exit_code(build) == 0` proves the build succeeded, not that the program is right.
4. **Pre-registration was removed, deliberately.** An earlier revision required chains to be saved
   under a name and found later by matching the user's wording against a declared intent. That put
   the meaning of a request into a keyword matcher: the first live test failed exactly as designed,
   when a natural sentence beginning with the registered phrase did not match it. The model states the
   plan in the call instead, and nothing is registered in advance.
5. **Do not require a saved procedure to get value.** If the first use needed preparation, the tool
   would be for maintainers, not for work.

## Related implementations

| | [jlon/pi-harnessmm](https://github.com/jlon/pi-harnessmm) | [DSH-Extensions-list/dsh-harnessmm](https://github.com/DSH-Extensions-list/dsh-harnessmm) | this repo |
| --- | --- | --- | --- |
| platform | pi | DSH | DSH |
| mechanism | controller inside the root terminal call, plan authored in `<CHISEL_PLAN>` | same, with a vendored controller and a Python self-improvement pipeline | explicit tool call; the plan is a tool argument |
| plan stated | in the model's text, parsed | in the model's text, parsed | as structured arguments — no text parsing |
| return reasons | exhaustion, unreadable evidence, native error, abstention | same | four, named in the result: exhausted, expectation-failed, evidence-unreadable, execution-error |
| adopted from them | — | — | explicit return reasons, declared receipt fields, a certificate naming the skipped call, a step cap |
| deliberately not adopted | — | — | vendored controllers, text-embedded plan syntax, policy versions and training priors, recursive self-improvement |

## Observability

Every call appends one line to `~/.harnessmm/usage/usage.jsonl` (override with `HARNESSMM_USAGE_DIR`):
status, step count, certificates, executor, per-step timings, the failing step, round-trips removed and
the caller's session. Test runs use a throwaway ledger, never the live one.

`harnessmm_usage` reads that ledger back: per-tool call counts, chain steps, certificates and wall
time over a window, plus raw entries on request. The ledger is how adoption is measured instead of
guessed — before deciding whether the plugin earns its place, look at what actually ran.

`harnessmm_validate` checks a plan before anyone trusts it (literal closure, unknown predecessors,
cycles, guards reading undeclared fields). `harnessmm_bench` is a measurement harness for the paper's
mechanism, not a work tool.

The agent skill lives in [skills/harnessmm/SKILL.md](skills/harnessmm/SKILL.md) (installed copy:
`~/.agents/skills/harnessmm/`): when to reach for a chain, how to write a plan, what each status means.

## Development

```bash
node --test test/*.test.mjs     # 91 tests
node bin/bench.mjs [--tasks add,roman] [--json]
```

Install into a profile with `plugin_manager` `install_bundle` pointing at this directory; source
changes under `lib/` need remove + install to reach the running Host. No LICENSE yet — the repo is
public but all rights reserved until one is chosen.
