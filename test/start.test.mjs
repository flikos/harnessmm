import test from 'node:test'
import assert from 'node:assert/strict'
import { compileGraph } from '../lib/graph.js'
import { runChain } from '../lib/chain.js'

// A plan must be able to start from nothing. Every case here drives the graph
// compiler, which is the seam that decides what is admissible before a single
// command runs.

const shell = (id, extra = {}) => ({ id, action: 'shell', args: { cmd: `echo ${id}` }, ...extra })

test('a plan whose first step has no predecessor is accepted', () => {
  const compiled = compileGraph({
    nodes: [
      shell('s1'),
      shell('s2', { after: 's1', guard: { op: 'exit_code', of: 's1', eq: 0 }, required_receipt_fields: ['exitCode'] }),
    ],
  })
  assert.equal(compiled.ok, true, JSON.stringify(compiled.errors))
  assert.equal(compiled.graph.nodes.length, 2)
})

test('a step depending on an identifier nothing declares is rejected, naming it', () => {
  const compiled = compileGraph({ nodes: [shell('s1', { after: 'ghost' })] })
  assert.equal(compiled.ok, false)
  assert.ok(compiled.errors.some((error) => error.includes('ghost')), compiled.errors.join('; '))
})

test('declaration order does not matter, but a true cycle still fails', () => {
  // Reading a plan top to bottom, a step may name one declared later; the
  // executor must read dependencies, not positions. Only a real loop is a
  // malformed plan.
  const compiled = compileGraph({
    nodes: [shell('first', { after: 'second' }), shell('second')],
  })
  assert.equal(compiled.ok, true, compiled.errors.join('; '))
  assert.deepEqual(compiled.graph.order, ['second', 'first'])
})

test('a loop in the plan is rejected before execution', () => {
  const compiled = compileGraph({
    nodes: [
      shell('s1'),
      shell('s2', { after: 's3' }),
      shell('s3', { after: 's2' }),
    ],
  })
  assert.equal(compiled.ok, false)
  assert.ok(compiled.errors.length > 0)
})

test('an unresolved placeholder in an argument is rejected', () => {
  const compiled = compileGraph({
    nodes: [{ id: 's1', action: 'shell', args: { cmd: 'deploy $ENVIRONMENT now' } }],
  })
  assert.equal(compiled.ok, false)
  assert.ok(compiled.errors.some((error) => error.includes('args')), compiled.errors.join('; '))
})
test('a tool call with no root identifier of any kind executes the plan', async () => {
  const executed = []
  const execute = async (node) => {
    executed.push(node.id)
    return { exitCode: 0, stdout: `ran ${node.id}`, stderr: '', ms: 1 }
  }
  const result = await runChain({
    raw: {
      nodes: [
        shell('s1'),
        shell('s2', { after: 's1', guard: { op: 'exit_code', of: 's1', eq: 0 }, required_receipt_fields: ['exitCode'] }),
      ],
    },
    execute,
  })
  assert.equal(result.stopReason, 'exhausted')
  assert.deepEqual(executed, ['s1', 's2'])
})

test('nothing executes when the plan is rejected', async () => {
  const executed = []
  const execute = async (node) => {
    executed.push(node.id)
    return { exitCode: 0, stdout: '', stderr: '', ms: 1 }
  }
  const result = await runChain({
    raw: { nodes: [shell('s1', { after: 'ghost' })] },
    execute,
  })
  assert.equal(result.stopReason, 'invalid-graph', 'a refused plan is reported apart from the four stop reasons')
  assert.deepEqual(executed, [], 'a rejected plan must not run anything')
})
