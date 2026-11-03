import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { apply } from '../index.js'
import { readUsage } from '../lib/usage.js'

function fakeContext() {
  const defs = new Map()
  return {
    defs,
    effect(fn) {
      return fn()
    },
    tools: {
      register(definition) {
        defs.set(definition.name, definition)
        return () => defs.delete(definition.name)
      },
    },
  }
}

test('the plugin registers exactly the two HarnessMM tools', () => {
  const ctx = fakeContext()
  apply(ctx)
  assert.deepEqual([...ctx.defs.keys()].sort(), ['harnessmm_bench', 'harnessmm_validate'])
  for (const def of ctx.defs.values()) {
    assert.equal(typeof def.execute, 'function')
    assert.equal(def.parameters.type, 'object')
    assert.equal(typeof def.output.render, 'function')
  }
})

test('harnessmm_validate accepts a closed graph and rejects a placeholder', async () => {
  const ctx = fakeContext()
  apply(ctx)
  const validate = ctx.defs.get('harnessmm_validate')

  const accepted = await validate.execute({
    graph: {
      nodes: [
        {
          id: 's2',
          action: 'shell',
          args: { cmd: 'python3 check.py' },
          after: 's1',
          guard: { op: 'exists', of: 's1' },
        },
      ],
    },
    rootId: 's1',
  })
  assert.equal(accepted.ok, true)
  assert.equal(accepted.nodes, 1)

  const rejected = await validate.execute({
    graph: { nodes: [{ id: 's2', action: 'shell', args: { cmd: '$NEXT' }, after: 's1' }] },
    rootId: 's1',
  })
  assert.equal(rejected.ok, false)
  assert.ok(rejected.errors.some((error) => error.includes('args')))
  assert.match(validate.output.render({}, rejected)[0].text, /rejected/)
})

test('harnessmm_bench returns a report with fewer calls in the harness arm', async () => {
  const ctx = fakeContext()
  apply(ctx)
  const bench = ctx.defs.get('harnessmm_bench')
  const value = await bench.execute({ tasks: ['add', 'gcd'] })
  assert.match(value.markdown, /Substitution economics/)
  assert.ok(value.skippedCallbacks > 0)
  assert.ok(value.savingRatio > 0)
  const rendered = bench.output.render({}, value)
  assert.equal(rendered[0].type, 'text')
  assert.match(rendered[0].text, /Report:/)
})
test('every tool call leaves a line in the usage ledger', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'harnessmm-usage-'))
  process.env.HARNESSMM_USAGE_DIR = dir
  const ctx = fakeContext()
  apply(ctx)
  await ctx.defs.get('harnessmm_validate').execute({
    graph: { nodes: [{ id: 's2', action: 'shell', args: { cmd: 'ls' }, after: 's1' }] },
    rootId: 's1',
  })
  await ctx.defs.get('harnessmm_bench').execute({ tasks: ['add'] })
  const lines = readUsage()
  assert.equal(lines.length, 2)
  assert.equal(lines[0].tool, 'harnessmm_validate')
  assert.equal(lines[1].tool, 'harnessmm_bench')
  assert.equal(lines[1].skippedCallbacks, 2)
  assert.match(lines[0].at, /^\d{4}-\d{2}-\d{2}T/)
  delete process.env.HARNESSMM_USAGE_DIR
})
