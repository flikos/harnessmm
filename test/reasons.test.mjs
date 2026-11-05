import test from 'node:test'
import assert from 'node:assert/strict'
import { runChain } from '../lib/chain.js'

// The four ways a plan can stop are different decisions for the caller:
// finish and answer; reason about a failure; refuse to guess about unreadable
// evidence; or report that the command never ran. Collapsing them into one
// status is what made the previous reporting useless.

const shell = (id, extra = {}) => ({ id, action: 'shell', args: { cmd: `echo ${id}` }, ...extra })
const passes = (id, after) => ({
  ...shell(id, { after, guard: { op: 'exit_code', of: after, eq: 0 }, required_receipt_fields: ['exitCode'] }),
})

test('a plan that runs out of steps reports exhaustion', async () => {
  const result = await runChain({
    raw: { nodes: [shell('s1')] },
    execute: async (node) => ({ exitCode: 0, stdout: `ran ${node.id}`, stderr: '', ms: 2 }),
  })
  assert.equal(result.stopReason, 'exhausted')
  assert.equal(result.steps.length, 1)
  assert.equal(result.failedStep, null)
})

test('an expectation that does not hold reports expectation-failed, naming the step', async () => {
  const result = await runChain({
    raw: {
      nodes: [
        shell('s1'),
        passes('s2', 's1'),
      ],
    },
    execute: async (node) => ({
      exitCode: node.id === 's1' ? 1 : 0,
      stdout: `ran ${node.id}`,
      stderr: '',
      ms: 2,
    }),
  })
  assert.equal(result.stopReason, 'expectation-failed')
  assert.equal(result.failedStep, 's2')
  assert.deepEqual(result.steps.map((step) => step.id), ['s1'], 'the failing step never ran')
})

test('a missing expected field reports evidence-unreadable, not a failed expectation', async () => {
  const result = await runChain({
    raw: {
      nodes: [
        shell('s1'),
        {
          ...shell('s2', { after: 's1' }),
          guard: { op: 'json_field', of: 's1', field: 'ok', eq: true },
          required_receipt_fields: ['stdout'],
        },
      ],
    },
    execute: async (node) => ({ exitCode: 0, stdout: 'not json at all', stderr: '', ms: 2 }),
  })
  assert.equal(result.stopReason, 'evidence-unreadable')
  assert.equal(result.failedStep, 's2')
})

test('a command that cannot run reports execution-error, not an expectation failure', async () => {
  const result = await runChain({
    raw: { nodes: [shell('s1')] },
    execute: async () => {
      throw new Error('spawn failed')
    },
  })
  assert.equal(result.stopReason, 'execution-error')
  assert.equal(result.failedStep, 's1')
  assert.match(result.detail, /spawn failed/)
})

test('the failing step carries its full output, not a truncated excerpt', async () => {
  const long = 'x'.repeat(40_000)
  const result = await runChain({
    raw: { nodes: [shell('s1'), passes('s2', 's1')] },
    execute: async () => ({ exitCode: 1, stdout: long, stderr: 'build failed', ms: 2 }),
  })
  assert.equal(result.stopReason, 'expectation-failed')
  assert.equal(result.failure.stdout.length, long.length)
  assert.equal(result.failure.stderr, 'build failed')
})

test('steps after the stop do not execute', async () => {
  const executed = []
  const result = await runChain({
    raw: { nodes: [shell('s1'), passes('s2', 's1'), passes('s3', 's2')] },
    execute: async (node) => {
      executed.push(node.id)
      return { exitCode: node.id === 's1' ? 1 : 0, stdout: '', stderr: '', ms: 1 }
    },
  })
  assert.equal(result.stopReason, 'expectation-failed')
  assert.deepEqual(executed, ['s1'])
})

test('a plan that hits the step limit reports the cap', async () => {
  const nodes = [shell('s1'), passes('s2', 's1'), passes('s3', 's2')]
  const result = await runChain({
    raw: { nodes },
    execute: async () => ({ exitCode: 0, stdout: '{}', stderr: '', ms: 1 }),
    maxSteps: 2,
  })
  assert.equal(result.stopReason, 'max-steps')
})