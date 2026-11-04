import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { apply } from '../index.js'
import { readUsage } from '../lib/usage.js'

// Tests exercise the real tool code, which logs usage. Point the ledger at a
// throwaway directory so test runs never pollute the live usage.jsonl.
const TEST_USAGE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'harnessmm-test-usage-'))
process.env.HARNESSMM_USAGE_DIR = TEST_USAGE_DIR
// The graph library defaults to ~/.harnessmm; tests must not write there.
process.env.HARNESSMM_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'harnessmm-test-home-'))

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

test('the plugin registers its tools', () => {
  const ctx = fakeContext()
  apply(ctx)
  assert.deepEqual([...ctx.defs.keys()].sort(), ['harnessmm_bench', 'harnessmm_chain', 'harnessmm_validate'])
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
  process.env.HARNESSMM_USAGE_DIR = TEST_USAGE_DIR
})

test('harnessmm_chain runs a graph in an explicit directory', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'harnessmm-chain-tool-'))
  const ctx = fakeContext()
  apply(ctx)
  const chain = ctx.defs.get('harnessmm_chain')
  const value = await chain.execute({
    cwd: dir,
    graph: {
      nodes: [
        { id: 's1', action: 'write', args: { path: 'note.txt', content: 'one\n' } },
        {
          id: 's2',
          action: 'write',
          args: { path: 'second.txt', content: 'two\n' },
          after: 's1',
          guard: { op: 'exit_code', of: 's1', eq: 0 },
        },
      ],
    },
  })
  assert.equal(value.stopReason, 'completed')
  assert.equal(value.steps, 2)
  assert.equal(value.certificates, 2)
  assert.ok(fs.existsSync(path.join(dir, 'second.txt')))
  assert.match(chain.output.render({}, value)[0].text, /Chain completed/)
})

test('harnessmm_chain refuses shell nodes without allowShell', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'harnessmm-chain-tool-'))
  const ctx = fakeContext()
  apply(ctx)
  const chain = ctx.defs.get('harnessmm_chain')
  const value = await chain.execute({
    cwd: dir,
    graph: { nodes: [{ id: 's1', action: 'shell', args: { cmd: 'echo hi' } }] },
  })
  assert.equal(value.stopReason, 'error')
  assert.match(value.markdown, /allowShell/)
})

test('harnessmm_chain saves a graph, lists it, and runs it by name', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'harnessmm-chain-tool-'))
  const ctx = fakeContext()
  apply(ctx)
  const chain = ctx.defs.get('harnessmm_chain')

  const saved = await chain.execute({
    name: 'smoke-write',
    save: true,
    description: 'writes one file',
    graph: { nodes: [{ id: 's1', action: 'write', args: { path: 'a.txt', content: 'hi' } }] },
  })
  assert.equal(saved.stopReason, 'saved')

  const listed = await chain.execute({ list: true })
  assert.match(listed.markdown, /smoke-write/)
  assert.match(listed.markdown, /Usage \(last 200 calls\)/)

  const run = await chain.execute({ name: 'smoke-write', cwd: dir })
  assert.equal(run.stopReason, 'completed')
  assert.equal(fs.readFileSync(path.join(dir, 'a.txt'), 'utf8'), 'hi')
})
