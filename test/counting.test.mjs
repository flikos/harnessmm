import test from 'node:test'
import assert from 'node:assert/strict'
import { makeCountingExecutor } from '../lib/counting.js'
import { runChain } from '../lib/chain.js'

// The whole value of this tool is that the steps in between cost no model
// round-trip. A test that cannot count executions cannot verify that, so the
// counting executor is the seam under every claim made about saving.

test('the counting executor records each execution in order with its step', async () => {
  const counting = makeCountingExecutor(async (node) => ({ exitCode: 0, stdout: `ran ${node.id}`, stderr: '', ms: 1 }))
  const result = await runChain({
    raw: {
      steps: [{ run: { cmd: 'one' } }, { run: { cmd: 'two' } }, { run: { cmd: 'three' } }].map((step, index) =>
        index === 0 ? step : { ...step, expect: { op: 'exit_code', eq: 0 } },
      ),
    },
    execute: counting.execute,
  })
  assert.equal(result.stopReason, 'exhausted')
  assert.deepEqual(counting.calls().map((call) => call.step), ['s1', 's2', 's3'])
})

test('a three-step plan whose expectations hold shows three executions and no model call between them', async () => {
  const counting = makeCountingExecutor(async (node) => ({ exitCode: 0, stdout: `ran ${node.id}`, stderr: '', ms: 1 }))
  const result = await runChain({
    raw: {
      steps: [
        { run: { cmd: 'one' } },
        { run: { cmd: 'two' }, expect: { op: 'exit_code', eq: 0 } },
        { run: { cmd: 'three' }, expect: { op: 'exit_code', eq: 0 } },
      ],
    },
    execute: counting.execute,
  })
  assert.equal(counting.count(), 3, 'three commands executed, one model call for the whole plan')
  assert.equal(result.avoidedRoundTrips, 2)
})

test('a plan that stops at its second step runs only the first, and the third never runs', async () => {
  const counting = makeCountingExecutor(async (node) => ({
    exitCode: node.id === 's1' ? 1 : 0,
    stdout: '',
    stderr: '',
    ms: 1,
  }))
  const result = await runChain({
    raw: {
      steps: [
        { run: { cmd: 'one' } },
        { run: { cmd: 'two' }, expect: { op: 'exit_code', eq: 0 } },
        { run: { cmd: 'three' }, expect: { op: 'exit_code', eq: 0 } },
      ],
    },
    execute: counting.execute,
  })
  assert.equal(result.stopReason, 'expectation-failed')
  // A guard gates the step *after* the receipt it reads: s1 runs, s2 is what the
  // guard blocks, and s3 waits behind s2.
  assert.equal(counting.count(), 1)
  assert.deepEqual(counting.calls().map((call) => call.step), ['s1'])
})

test('round-trips removed equals executed steps minus one, and is labelled as a count', async () => {
  const counting = makeCountingExecutor(async (node) => ({ exitCode: 0, stdout: '', stderr: '', ms: 1 }))
  const result = await runChain({
    raw: {
      steps: [
        { run: { cmd: 'one' } },
        { run: { cmd: 'two' }, expect: { op: 'exit_code', eq: 0 } },
        { run: { cmd: 'three' }, expect: { op: 'exit_code', eq: 0 } },
        { run: { cmd: 'four' }, expect: { op: 'exit_code', eq: 0 } },
      ],
    },
    execute: counting.execute,
  })
  assert.equal(counting.count(), 4)
  assert.equal(result.avoidedRoundTrips, 3)
})

test('the report says the figure is a count, not an estimate of tokens or time', async () => {
  const counting = makeCountingExecutor(async (node) => ({ exitCode: 0, stdout: '', stderr: '', ms: 1 }))
  const result = await runChain({
    raw: { steps: [{ run: { cmd: 'one' } }, { run: { cmd: 'two' } }].map((step, index) => (index === 0 ? step : { ...step, expect: { op: 'exit_code', eq: 0 } })) },
    execute: counting.execute,
  })
  const { renderChain } = await import('../lib/chain.js')
  const report = renderChain(result)
  assert.match(report, /round-trip\(s\) skipped \(counted\)/i)
  assert.doesNotMatch(report, /tokens|seconds/i, 'a count must not be dressed as an estimate')
})