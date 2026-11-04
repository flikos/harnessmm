# HarnessMM chain — measured benefit (live session, 2026-11-04)

Task: verify the harnessmm package (syntax -> tests -> bench -> git HEAD -> report file).
Same commands in both arms, same session, same model.

## Baseline arm: 5 tool calls = 5 model steps

| step | command time | model-step gap |
| --- | --- | --- |
| 1 syntax | <1s | — |
| 2 tests (tail -8) | ~1s | 12s |
| 3 bench --json (tail -12) | ~1s | 11s |
| 4 git log | <1s | 11s |
| 5 write report | <1s | ~11s |

- wall time: ~48s, of which commands ~3s — the rest is model-step latency (~11s/step)
- tool outputs landed in transcript: ~607 B (~150 tokens) only because of `tail`;
  untruncated the same outputs are 6,401 B (tests) + 1,077 B (bench json) ≈ ~2k tokens,
  and they are replayed in EVERY subsequent request of the session

## Chain arm: validate + 1 harnessmm_chain call = 2 model steps

- 5/5 nodes executed inside one call, 5/5 certificates verified against receipts
- same commands, same ~3s of command time
- context footprint: graph authorship ~1.1 KB (~280 tokens, one-time) + ~750 B result table (~190 tokens)
- wall time ≈ 2 × ~11s + ~3s ≈ ~25s

## Benefit

- model steps: 5 -> 2 (or -> 1 without the validate pass); ~33s of latency saved
- context: one compact result instead of N raw outputs; advantage grows with output size and session length
- quality identical: same gates, plus a substitution certificate per node

## Break-even

Authorship (~280 tokens) vs a saved step (~11s latency + several hundred tokens of
output/replay). In a live session the chain pays for itself from ~2-3 mechanical steps.
(The bench's break-even of 5 was measured on tiny scripted prompts, ~157 tokens/call.)

## When to use / when not

Use: verification and regression gates, build->test->lint chains with observable gates
(exit code, json_field, file content), the same chain repeated over many items, long
sessions where transcript replay dominates cost.

Do not use: <3 steps; when the model must READ full command output (chain truncates each
step to 1200 chars); exploration/debugging; commands that need per-step approval or the
bash sandbox (chain shell runs in the Host process; allowShell is explicit consent).

## Defect found and fixed during the experiment

Plugin tests wrote into the live usage ledger (test invocations looked like real usage).
Fixed: tests now point HARNESSMM_USAGE_DIR at a throwaway directory. 34/34 tests pass,
live ledger line count unchanged (51 before and after the suite run).
