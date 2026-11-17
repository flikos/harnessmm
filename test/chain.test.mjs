import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { runChain, makeExecutor, makeSandboxExecutor, renderChain } from '../lib/chain.js'

const workspace = () => fs.mkdtempSync(path.join(os.tmpdir(), 'harnessmm-chain-'))
const graph = (nodes) => ({ nodes })

test('a chain runs write → compile → test with no reasoning call', async () => {
  const cwd = workspace()
  const raw = graph([
    {
      id: 's1',
      action: 'write',
      args: { path: 'solution.py', content: 'def add(a, b):\n    return a + b\n' },
    },
    {
      id: 's2',
      action: 'shell',
      args: { cmd: 'python3 -m py_compile solution.py' },
      after: 's1',
      guard: { op: 'exit_code', of: 's1', eq: 0 },
    },
    {
      id: 's3',
      action: 'shell',
      args: { cmd: 'python3 -c "import solution; assert solution.add(2, 3) == 5; print(\'OK\')"' },
      after: 's2',
      guard: { op: 'exit_code', of: 's2', eq: 0 },
    },
  ])
  const result = await runChain({ raw, cwd, execute: makeExecutor({ cwd, allowShell: true }) })
  assert.equal(result.stopReason, 'exhausted')
  assert.equal(result.steps.length, 3)
  assert.equal(result.certificates, 3)
  assert.equal(result.verified, 3)
  assert.equal(result.pending.length, 0)
  assert.equal(result.steps[2].exitCode, 0)
})

test('a failing guard stops the chain and hands control back', async () => {
  const cwd = workspace()
  const raw = graph([
    { id: 's1', action: 'shell', args: { cmd: 'python3 -c "import sys; sys.exit(1)"' } },
    {
      id: 's2',
      action: 'shell',
      args: { cmd: 'echo should-not-run' },
      after: 's1',
      guard: { op: 'exit_code', of: 's1', eq: 0 },
    },
  ])
  const result = await runChain({ raw, cwd, execute: makeExecutor({ cwd, allowShell: true }) })
  assert.equal(result.stopReason, 'expectation-failed')
  assert.equal(result.failedStep, 's2')
  assert.equal(result.steps.length, 1)
  assert.deepEqual(result.pending, ['s2'])
})

test('shell nodes are refused unless the caller opts in', async () => {
  const cwd = workspace()
  const raw = graph([{ id: 's1', action: 'shell', args: { cmd: 'echo hi' } }])
  const result = await runChain({ raw, cwd, execute: makeExecutor({ cwd, allowShell: false }) })
  assert.equal(result.stopReason, 'execution-error')
  assert.match(result.detail, /allowShell/)
  assert.equal(result.certificates, 0)
})

test('write cannot escape the working directory', async () => {
  const cwd = workspace()
  const raw = graph([{ id: 's1', action: 'write', args: { path: '../escape.txt', content: 'x' } }])
  const result = await runChain({ raw, cwd, execute: makeExecutor({ cwd, allowShell: true }) })
  assert.equal(result.stopReason, 'execution-error')
  assert.match(result.detail, /escapes the working directory/)
})

test('an invalid graph is rejected before any command runs', async () => {
  const cwd = workspace()
  const result = await runChain({
    raw: graph([{ id: 's1', action: 'shell', args: { cmd: '$CMD' } }]),
    cwd,
    execute: makeExecutor({ cwd, allowShell: true }),
  })
  assert.equal(result.stopReason, 'invalid-graph')
  assert.equal(result.steps.length, 0)
})

test('a json_field guard reads a structured result and unlocks the next node', async () => {
  const cwd = workspace()
  const raw = graph([
    { id: 's1', action: 'shell', args: { cmd: `python3 -c "import json; print(json.dumps({'answer': 42}))"` } },
    {
      id: 's2',
      action: 'write',
      args: { path: 'accepted.txt', content: 'answer was 42\n' },
      after: 's1',
      guard: { op: 'json_field', of: 's1', field: 'answer', eq: 42 },
    },
  ])
  const result = await runChain({ raw, cwd, execute: makeExecutor({ cwd, allowShell: true }) })
  assert.equal(result.stopReason, 'exhausted')
  assert.equal(fs.readFileSync(path.join(cwd, 'accepted.txt'), 'utf8'), 'answer was 42\n')
})

test('a json_field guard on the wrong value stops before the dependent node', async () => {
  const cwd = workspace()
  const raw = graph([
    { id: 's1', action: 'shell', args: { cmd: `python3 -c "import json; print(json.dumps({'answer': 41}))"` } },
    {
      id: 's2',
      action: 'write',
      args: { path: 'accepted.txt', content: 'should not exist' },
      after: 's1',
      guard: { op: 'json_field', of: 's1', field: 'answer', eq: 42 },
    },
  ])
  const result = await runChain({ raw, cwd, execute: makeExecutor({ cwd, allowShell: true }) })
  assert.equal(result.stopReason, 'expectation-failed')
  assert.equal(fs.existsSync(path.join(cwd, 'accepted.txt')), false)
})

test('the rendered report names the stop reason and the remaining steps', async () => {
  const cwd = workspace()
  const raw = graph([
    { id: 's1', action: 'shell', args: { cmd: 'exit 3' } },
    { id: 's2', action: 'shell', args: { cmd: 'echo later' }, after: 's1', guard: { op: 'exit_code', of: 's1', eq: 0 } },
  ])
  const result = await runChain({ raw, cwd, execute: makeExecutor({ cwd, allowShell: true }) })
  const report = renderChain(result)
  assert.match(report, /Chain stopped at 1 step/)
  assert.match(report, /Not executed: s2/)
  assert.match(report, /Certificates: 1\/1/)
})
test('a stalled chain shows the full output of the failing step', async () => {
  const cwd = workspace()
  const raw = graph([
    { id: 's1', action: 'shell', args: { cmd: `python3 -c "print('x' * 3000); raise SystemExit(1)"` } },
    { id: 's2', action: 'shell', args: { cmd: 'echo never' }, after: 's1', guard: { op: 'exit_code', of: 's1', eq: 0 } },
  ])
  const result = await runChain({ raw, cwd, execute: makeExecutor({ cwd, allowShell: true }) })
  assert.equal(result.stopReason, 'expectation-failed')
  const report = renderChain(result)
  assert.equal(report.includes('x'.repeat(2500)), true, 'failing output must not be truncated to a table cell')
})

test('a chain resumes from receipts without re-running finished nodes', async () => {
  const cwd = workspace()
  const first = await runChain({
    raw: graph([
      { id: 's1', action: 'shell', args: { cmd: `python3 -c "print('stage1')"` } },
      { id: 's2', action: 'shell', args: { cmd: 'exit 5' }, after: 's1', guard: { op: 'exit_code', of: 's1', eq: 0 } },
      { id: 's3', action: 'shell', args: { cmd: 'echo done' }, after: 's2', guard: { op: 'exit_code', of: 's2', eq: 0 } },
    ]),
    cwd,
    execute: makeExecutor({ cwd, allowShell: true }),
  })
  assert.equal(first.stopReason, 'expectation-failed')
  assert.deepEqual(first.pending, ['s3'])

  const second = await runChain({
    raw: graph([
      { id: 's3', action: 'shell', args: { cmd: 'echo recovered' }, after: 's2', guard: { op: 'exit_code', of: 's2', eq: 5 } },
    ]),
    cwd,
    priorIds: first.receipts.map((receipt) => receipt.stepId),
    priorReceipts: first.receipts,
    execute: makeExecutor({ cwd, allowShell: true }),
  })
  assert.equal(second.stopReason, 'exhausted')
  assert.equal(second.steps.length, 1, 'only the remaining node runs')
  assert.match(second.steps[0].stdout, /recovered/)
})

test('destructive commands are refused before they run', async () => {
  const cwd = workspace()
  const result = await runChain({
    raw: graph([{ id: 's1', action: 'shell', args: { cmd: 'sudo rm -rf /' } }]),
    cwd,
    execute: makeExecutor({ cwd, allowShell: true }),
  })
  assert.equal(result.stopReason, 'execution-error')
  assert.match(result.detail, /refused command/)
})

test('a node can carry its own timeout', async () => {
  const cwd = workspace()
  const started = Date.now()
  const result = await runChain({
    raw: graph([{ id: 's1', action: 'shell', args: { cmd: 'sleep 2' }, timeoutMs: 200 }]),
    cwd,
    execute: makeExecutor({ cwd, allowShell: true }),
  })
  assert.ok(Date.now() - started < 1500, 'timeout must cut the command short')
  assert.notEqual(result.steps[0].exitCode, 0)
})

test('the result reports the round-trips the plan skipped, and nothing it would have cost', async () => {
  const cwd = workspace()
  const result = await runChain({
    raw: graph([
      { id: 's1', action: 'shell', args: { cmd: 'echo one' } },
      { id: 's2', action: 'shell', args: { cmd: 'echo two' }, after: 's1', guard: { op: 'exit_code', of: 's1', eq: 0 } },
    ]),
    cwd,
    execute: makeExecutor({ cwd, allowShell: true }),
  })
  assert.equal(result.avoidedRoundTrips, 1)
  assert.equal('saved' in result, false, 'one savings figure only: a second field invites a second report')
  const report = renderChain(result)
  assert.match(report, /1 model round-trip\(s\) skipped \(counted, upper bound\)/)
  assert.equal(report.includes('constant model'), false)
})

test('a stopped chain prints receipts that can be passed back to resume', async () => {
  const cwd = workspace()
  const first = await runChain({
    raw: graph([
      { id: 's1', action: 'shell', args: { cmd: 'exit 4' } },
      { id: 's2', action: 'shell', args: { cmd: 'echo later' }, after: 's1', guard: { op: 'exit_code', of: 's1', eq: 0 } },
    ]),
    cwd,
    execute: makeExecutor({ cwd, allowShell: true }),
  })
  const report = renderChain(first)
  const match = /### Receipts \(pass back as `receipts` to resume\)\n```json\n(.+)\n```/s.exec(report)
  assert.ok(match, 'receipts block missing')
  const receipts = JSON.parse(match[1])
  assert.equal(receipts[0].stepId, 's1')
  assert.equal(receipts[0].exitCode, 4)

  const second = await runChain({
    raw: graph([
      { id: 's2', action: 'shell', args: { cmd: 'echo resumed' }, after: 's1', guard: { op: 'exit_code', of: 's1', eq: 4 } },
    ]),
    cwd,
    priorIds: receipts.map((receipt) => receipt.stepId),
    priorReceipts: receipts,
    execute: makeExecutor({ cwd, allowShell: true }),
  })
  assert.equal(second.stopReason, 'exhausted')
  assert.equal(second.steps.length, 1)
})

const sandboxDispatch = (shape) => {
  const calls = []
  return {
    calls,
    dispatch: async (input) => {
      calls.push(input)
      return shape
    },
  }
}

test('the sandboxed executor reads a structured bash result', async () => {
  const cwd = workspace()
  const { calls, dispatch } = sandboxDispatch({
    isError: false,
    value: { exitCode: 0, stdout: 'sandbox ok' },
    content: [{ type: 'text', text: 'sandbox ok' }],
  })
  const result = await runChain({
    raw: graph([{ id: 's1', action: 'shell', args: { cmd: 'echo sandbox ok' } }]),
    cwd,
    execute: makeSandboxExecutor({ dispatch, cwd }),
  })
  assert.equal(result.stopReason, 'exhausted')
  assert.equal(result.steps[0].exitCode, 0)
  assert.match(result.steps[0].stdout, /sandbox ok/)
  assert.equal(calls.length, 1)
  assert.equal(calls[0].name, 'bash')
  assert.equal(calls[0].arguments.command, 'echo sandbox ok')
})

test('the sandboxed executor falls back to the exit-code marker in text', async () => {
  const cwd = workspace()
  const { dispatch } = sandboxDispatch({
    isError: false,
    value: null,
    content: [{ type: 'text', text: 'some output\nmore\n[exit code: 3]' }],
  })
  const result = await runChain({
    raw: graph([
      { id: 's1', action: 'shell', args: { cmd: 'false' } },
      { id: 's2', action: 'shell', args: { cmd: 'echo never' }, after: 's1', guard: { op: 'exit_code', of: 's1', eq: 0 } },
    ]),
    cwd,
    execute: makeSandboxExecutor({ dispatch, cwd }),
  })
  assert.equal(result.steps[0].exitCode, 3)
  assert.equal(result.stopReason, 'expectation-failed')
})

test('the sandboxed executor fails closed on an unparsable result', async () => {
  const cwd = workspace()
  const { dispatch } = sandboxDispatch({ isError: false, value: null, content: [{ type: 'text', text: 'no marker here' }] })
  const result = await runChain({
    raw: graph([{ id: 's1', action: 'shell', args: { cmd: 'echo hi' } }]),
    cwd,
    execute: makeSandboxExecutor({ dispatch, cwd }),
  })
  assert.equal(result.stopReason, 'execution-error')
  assert.match(result.detail, /cannot determine an exit code/)
})

test('the denylist also applies to the sandboxed executor', async () => {
  const cwd = workspace()
  const { calls, dispatch } = sandboxDispatch({ isError: false, value: { exitCode: 0 }, content: [] })
  const result = await runChain({
    raw: graph([{ id: 's1', action: 'shell', args: { cmd: 'sudo rm -rf /' } }]),
    cwd,
    execute: makeSandboxExecutor({ dispatch, cwd }),
  })
  assert.equal(result.stopReason, 'execution-error')
  assert.match(result.detail, /refused command/)
  assert.equal(calls.length, 0, 'a refused command must never reach dispatch')
})

test('sandboxed write nodes stay direct and do not dispatch', async () => {
  const cwd = workspace()
  const { calls, dispatch } = sandboxDispatch({ isError: false, value: { exitCode: 0 }, content: [] })
  const result = await runChain({
    raw: graph([{ id: 's1', action: 'write', args: { path: 'a.txt', content: 'x' } }]),
    cwd,
    execute: makeSandboxExecutor({ dispatch, cwd }),
  })
  assert.equal(result.stopReason, 'exhausted')
  assert.equal(calls.length, 0)
  assert.equal(fs.readFileSync(path.join(cwd, 'a.txt'), 'utf8'), 'x')
})

test('the sandboxed extractor never renders output as [object Object]', async () => {
  const cwd = workspace()
  const { dispatch } = sandboxDispatch({
    isError: false,
    value: { exitCode: 0, stdout: [{ type: 'text', text: 'block one' }, { type: 'text', text: 'block two' }] },
    content: [],
  })
  const result = await runChain({
    raw: graph([{ id: 's1', action: 'shell', args: { cmd: 'echo blocks' } }]),
    cwd,
    execute: makeSandboxExecutor({ dispatch, cwd }),
  })
  assert.equal(result.steps[0].exitCode, 0)
  assert.match(result.steps[0].stdout, /block one/)
  assert.match(result.steps[0].stdout, /block two/)
  assert.equal(result.steps[0].stdout.includes('[object Object]'), false)
})

test('the selector parameter reaches the controller: priority resolves an ambiguous set', async () => {
  const cwd = workspace()
  const raw = graph([
    { id: 'root', action: 'shell', args: { cmd: 'true' } },
    { id: 'b', action: 'shell', args: { cmd: 'echo b' }, after: 'root', priority: 1,
      guard: { op: 'exit_code', of: 'root', eq: 0 } },
    { id: 'c', action: 'shell', args: { cmd: 'echo c' }, after: 'root', priority: 2,
      guard: { op: 'exit_code', of: 'root', eq: 0 } },
  ])
  const unique = await runChain({ raw, cwd, execute: makeExecutor({ cwd, allowShell: true }) })
  assert.equal(unique.stopReason, 'deferred')

  const priority = await runChain({
    raw, cwd, execute: makeExecutor({ cwd, allowShell: true }), selector: 'priority',
  })
  // Priority runs c (highest), then b becomes the only eligible node and runs too.
  assert.equal(priority.stopReason, 'exhausted')
  assert.deepEqual(priority.steps.map((step) => step.id), ['root', 'c', 'b'])

  const abstain = await runChain({
    raw, cwd, execute: makeExecutor({ cwd, allowShell: true }), selector: 'abstain',
  })
  assert.equal(abstain.stopReason, 'deferred')
  // Explicit abstention defers every decision, even a single ready node.
  assert.equal(abstain.steps.length, 0)
})

test('truncated output says so: the cut start is marked, not silent', async () => {
  const cwd = workspace()
  const result = await runChain({
    raw: graph([{ id: 's1', action: 'shell', args: { cmd: 'python3 -c "print(\'x\' * 20000)"' } }]),
    cwd,
    execute: makeExecutor({ cwd, allowShell: true }),
  })
  assert.equal(result.stopReason, 'exhausted')
  assert.match(result.steps[0].stdout, /truncated \d+ char\(s\)/)
  assert.ok(result.steps[0].stdout.length < 20_000 + 200)
})

test('the bash exit-code marker is a named, testable contract', async () => {
  const { EXIT_CODE_MARKER } = await import('../lib/chain.js')
  assert.equal(EXIT_CODE_MARKER.exec('[exit code: 3]')[1], '3')
  assert.equal(EXIT_CODE_MARKER.exec('noise [exit code: -1] tail')[1], '-1')
  assert.equal(EXIT_CODE_MARKER.test('no marker here'), false)
})

test('the environment scrub catches vendor prefixes and exact secret names', async () => {
  const { scrubbedEnvironment } = await import('../lib/chain.js')
  const env = scrubbedEnvironment({
    PATH: '/usr/bin',
    GITHUB_PAT: 'x',
    GH_TOKEN: 'x',
    ANTHROPIC_API_KEY: 'x',
    AWS_SECRET_ACCESS_KEY: 'x',
    PGPASS: 'x',
    HOME: '/home/me',
    TERM: 'xterm-256color',
  })
  assert.deepEqual(Object.keys(env).sort(), ['HOME', 'PATH', 'TERM'])
})

test('a write step over the size cap is refused, not truncated', async () => {
  const cwd = workspace()
  const result = await runChain({
    raw: graph([{ id: 's1', action: 'write', args: { path: 'big.txt', content: 'x'.repeat(1_000_001) } }]),
    cwd,
    execute: makeExecutor({ cwd, allowShell: true }),
  })
  assert.equal(result.stopReason, 'execution-error')
  assert.match(result.detail, /exceeds 1_?000_?000 characters|1[_,]?000[_,]?000 characters/)
})

test('a sandboxed chain refuses an action it does not know instead of running it direct', async () => {
  const cwd = workspace()
  const { calls, dispatch } = sandboxDispatch({ isError: false, value: { exitCode: 0 }, content: [] })
  const result = await runChain({
    raw: graph([{ id: 's1', action: 'http', args: { url: 'https://example.invalid' } }]),
    cwd,
    execute: makeSandboxExecutor({ dispatch, cwd }),
  })
  assert.equal(result.stopReason, 'execution-error')
  assert.match(result.detail, /shell.*write|write.*shell/)
  assert.equal(calls.length, 0)
})
