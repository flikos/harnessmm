import test from 'node:test'
import assert from 'node:assert/strict'
import { compilePlan } from '../lib/plan.js'
import { runChain } from '../lib/chain.js'

// The linear form is what a model writes for everyday work: a list of steps,
// each saying what to run and what it expects. It must compile to the same
// plan as the graph form, so a guard means exactly the same thing in both.

const linear = {
  steps: [
    { run: { cmd: 'npm run build' } },
    { run: { cmd: 'npm test' }, after: 's1', expect: { op: 'exit_code', eq: 0 } },
  ],
}

test('a linear plan compiles to the same nodes the graph form uses', () => {
  const compiled = compilePlan(linear)
  assert.equal(compiled.ok, true, compiled.errors.join('; '))
  assert.equal(compiled.graph.nodes.length, 2)
  assert.equal(compiled.graph.nodes[0].id, 's1')
  assert.equal(compiled.graph.nodes[0].after, null)
  assert.equal(compiled.graph.nodes[0].action, 'shell')
  assert.equal(compiled.graph.nodes[1].after, 's1')
})

test('a linear plan and the equivalent graph produce the same plan hash', () => {
  const fromLinear = compilePlan(linear)
  const fromGraph = compilePlan({
    nodes: [
      { id: 's1', action: 'shell', args: { cmd: 'npm run build' } },
      {
        id: 's2',
        action: 'shell',
        args: { cmd: 'npm test' },
        after: 's1',
        guard: { op: 'exit_code', of: 's1', eq: 0 },
        required_receipt_fields: ['exitCode'],
      },
    ],
  })
  assert.equal(fromGraph.ok, true, fromGraph.errors.join('; '))
  assert.equal(fromLinear.graph.hash, fromGraph.graph.hash)
})

test('the first step needs no predecessor; its expectation is optional', () => {
  const compiled = compilePlan({ steps: [{ run: { cmd: 'echo hi' } }] })
  assert.equal(compiled.ok, true, compiled.errors.join('; '))
  assert.equal(compiled.graph.nodes[0].after, null)
})

test('an expectation on the first step is rejected, because there is no receipt to read', () => {
  const compiled = compilePlan({ steps: [{ run: { cmd: 'echo hi' }, expect: { op: 'exit_code', eq: 0 } }] })
  assert.equal(compiled.ok, false)
  assert.ok(compiled.errors.some((error) => error.includes('receipt')), compiled.errors.join('; '))
})

test('a step that names a predecessor other than the one above it is rejected', () => {
  // The list is ordered. `after` exists to catch a plan that contradicts its
  // own order, not to restate it.
  const compiled = compilePlan({
    steps: [
      { run: { cmd: 'a' } },
      { run: { cmd: 'b' }, after: 's3', expect: { op: 'exit_code', eq: 0 } },
      { run: { cmd: 'c' } },
    ],
  })
  assert.equal(compiled.ok, false)
  assert.ok(compiled.errors.some((error) => error.includes('steps[1]')), compiled.errors.join('; '))
})

test('the full guard vocabulary is accepted in the linear form', () => {
  const compiled = compilePlan({
    steps: [
      { run: { cmd: 'a' } },
      { run: { cmd: 'b' }, expect: { op: 'stdout_contains', text: 'PASS' } },
      { run: { cmd: 'c' }, expect: { op: 'json_field', field: 'ok', eq: true } },
      { run: { cmd: 'd' }, expect: { op: 'file_exists', path: 'out/report.md' } },
    ],
  })
  assert.equal(compiled.ok, true, compiled.errors.join('; '))
  assert.equal(compiled.graph.nodes[3].guard.op, 'file_exists')
})

test('an expectation without a step to read is rejected', () => {
  const compiled = compilePlan({
    steps: [{ run: { cmd: 'a' } }, { run: { cmd: 'b' }, after: 's9', expect: { op: 'exit_code', eq: 0 } }],
  })
  assert.equal(compiled.ok, false)
})

test('a plan with no steps is rejected', () => {
  const compiled = compilePlan({ steps: [] })
  assert.equal(compiled.ok, false)
})

test('a placeholder in a run argument is rejected', () => {
  const compiled = compilePlan({ steps: [{ run: { cmd: 'deploy $TARGET' } }] })
  assert.equal(compiled.ok, false)
})
test('a linear plan runs end to end with no model call between its steps', async () => {
  const executed = []
  const execute = async (node) => {
    executed.push(node.id)
    return { exitCode: 0, stdout: `ran ${node.id}`, stderr: '', ms: 1 }
  }
  const result = await runChain({
    raw: { steps: [{ run: { cmd: 'one' } }, { run: { cmd: 'two' }, expect: { op: 'exit_code', eq: 0 } }] },
    execute,
  })
  assert.equal(result.stopReason, 'exhausted')
  assert.deepEqual(executed, ['s1', 's2'])
})

test('a linear plan stops where its expectation does not hold', async () => {
  const executed = []
  const result = await runChain({
    raw: {
      steps: [
        { run: { cmd: 'one' } },
        { run: { cmd: 'two' }, expect: { op: 'exit_code', eq: 0 } },
        { run: { cmd: 'three' }, expect: { op: 'exit_code', eq: 0 } },
      ],
    },
    execute: async (node) => {
      executed.push(node.id)
      return { exitCode: node.id === 's1' ? 1 : 0, stdout: '', stderr: '', ms: 1 }
    },
  })
  assert.equal(result.stopReason, 'expectation-failed')
  assert.equal(result.failedStep, 's2')
  assert.deepEqual(executed, ['s1'])
})

test('the tool accepts the linear form through its own entry point', async () => {
  const defs = new Map()
  const ctx = {
    effect: (fn) => fn(),
    tools: { register: (definition) => (defs.set(definition.name, definition), () => defs.delete(definition.name)) },
  }
  const { apply } = await import('../index.js')
  apply(ctx)
  const chain = defs.get('harnessmm_chain')
  const result = await chain.execute(
    { steps: [{ run: { cmd: 'echo hello' } }], cwd: process.cwd(), executor: 'sandboxed' },
    { agent: {}, signal: undefined },
  )
  // No sandbox dispatcher is wired in a fake context, so the run reports an
  // execution error rather than a plan-invalid one: the plan itself was accepted.
  assert.equal(result.stopReason, 'execution-error')
  assert.match(result.markdown, /s1/)
})

test('the linear form runs through the direct executor too', async () => {
  const { makeExecutor } = await import('../lib/chain.js')
  const cwd = (await import('node:fs')).mkdtempSync(
    (await import('node:path')).join((await import('node:os')).tmpdir(), 'harnessmm-linear-'),
  )
  const result = await runChain({
    raw: { steps: [{ run: { cmd: 'echo one' } }, { run: { cmd: 'echo two' }, expect: { op: 'stdout_contains', text: 'one' } }] },
    cwd,
    execute: makeExecutor({ cwd, allowShell: true }),
  })
  assert.equal(result.stopReason, 'exhausted', JSON.stringify(result.failure))
  assert.equal(result.steps.length, 2)
})

test('the graph vocabulary in a linear plan is refused, not silently dropped', () => {
  const compiled = compilePlan({ steps: [{ run: { cmd: 'a' } }, { run: { cmd: 'b' }, guard: { op: 'exit_code', eq: 0 } }] })
  assert.equal(compiled.ok, false)
  assert.ok(compiled.errors.some((error) => error.includes('expect')), compiled.errors.join('; '))
})
