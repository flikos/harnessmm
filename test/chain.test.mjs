import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { runChain, makeExecutor, renderChain } from '../lib/chain.js'

const workspace = () => fs.mkdtempSync(path.join(os.tmpdir(), 'harnessmm-chain-'))
const graph = (nodes) => ({ nodes })

test('a chain runs write → compile → test with no reasoning call', () => {
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
  const result = runChain({ raw, cwd, execute: makeExecutor({ cwd, allowShell: true }) })
  assert.equal(result.stopReason, 'completed')
  assert.equal(result.steps.length, 3)
  assert.equal(result.certificates, 3)
  assert.equal(result.verified, 3)
  assert.equal(result.pending.length, 0)
  assert.equal(result.steps[2].exitCode, 0)
})

test('a failing guard stops the chain and hands control back', () => {
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
  const result = runChain({ raw, cwd, execute: makeExecutor({ cwd, allowShell: true }) })
  assert.equal(result.stopReason, 'deferred')
  assert.match(result.detail, /no eligible decision/)
  assert.equal(result.steps.length, 1)
  assert.deepEqual(result.pending, ['s2'])
})

test('shell nodes are refused unless the caller opts in', () => {
  const cwd = workspace()
  const raw = graph([{ id: 's1', action: 'shell', args: { cmd: 'echo hi' } }])
  const result = runChain({ raw, cwd, execute: makeExecutor({ cwd, allowShell: false }) })
  assert.equal(result.stopReason, 'error')
  assert.match(result.detail, /allowShell/)
  assert.equal(result.certificates, 0)
})

test('write cannot escape the working directory', () => {
  const cwd = workspace()
  const raw = graph([{ id: 's1', action: 'write', args: { path: '../escape.txt', content: 'x' } }])
  const result = runChain({ raw, cwd, execute: makeExecutor({ cwd, allowShell: true }) })
  assert.equal(result.stopReason, 'error')
  assert.match(result.detail, /escapes the working directory/)
})

test('an invalid graph is rejected before any command runs', () => {
  const cwd = workspace()
  const result = runChain({
    raw: graph([{ id: 's1', action: 'shell', args: { cmd: '$CMD' } }]),
    cwd,
    execute: makeExecutor({ cwd, allowShell: true }),
  })
  assert.equal(result.stopReason, 'invalid-graph')
  assert.equal(result.steps.length, 0)
})

test('a json_field guard reads a structured result and unlocks the next node', () => {
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
  const result = runChain({ raw, cwd, execute: makeExecutor({ cwd, allowShell: true }) })
  assert.equal(result.stopReason, 'completed')
  assert.equal(fs.readFileSync(path.join(cwd, 'accepted.txt'), 'utf8'), 'answer was 42\n')
})

test('a json_field guard on the wrong value stops before the dependent node', () => {
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
  const result = runChain({ raw, cwd, execute: makeExecutor({ cwd, allowShell: true }) })
  assert.equal(result.stopReason, 'deferred')
  assert.equal(fs.existsSync(path.join(cwd, 'accepted.txt')), false)
})

test('the rendered report names the stop reason and the remaining steps', () => {
  const cwd = workspace()
  const raw = graph([
    { id: 's1', action: 'shell', args: { cmd: 'exit 3' } },
    { id: 's2', action: 'shell', args: { cmd: 'echo later' }, after: 's1', guard: { op: 'exit_code', of: 's1', eq: 0 } },
  ])
  const result = runChain({ raw, cwd, execute: makeExecutor({ cwd, allowShell: true }) })
  const report = renderChain(result)
  assert.match(report, /Chain stopped at 1 step/)
  assert.match(report, /Not executed: s2/)
  assert.match(report, /Certificates: 1\/1/)
})