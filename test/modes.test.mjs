import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { apply } from '../index.js'

// Mode resolution is pure: it maps the arguments a caller passed to the single
// entry path the tool will take. Every later change to the tool works through
// this list, so it is the seam that keeps those changes honest.
const TEST_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'harnessmm-modes-'))
process.env.HARNESSMM_HOME = TEST_HOME
process.env.HARNESSMM_USAGE_DIR = path.join(TEST_HOME, 'usage')

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

const { resolveMode } = await import('../lib/modes.js')

test('a transient graph resolves to the graph mode', () => {
  const mode = resolveMode({ graph: { nodes: [] } })
  assert.equal(mode.kind, 'graph')
})

test('listing resolves to the list mode', () => {
  assert.equal(resolveMode({ list: true }).kind, 'list')
})

test('a save request resolves to the save mode and names the graph', () => {
  const mode = resolveMode({ graph: { nodes: [] }, save: true, name: 'demo' })
  assert.equal(mode.kind, 'save')
  assert.equal(mode.name, 'demo')
})

test('a bare name resolves to the named mode', () => {
  assert.equal(resolveMode({ name: 'demo' }).kind, 'named')
})

test('every mode carries the arguments it needs, and nothing is left implicit', () => {
  const modes = [
    resolveMode({ graph: { nodes: [] } }),
    resolveMode({ list: true }),
    resolveMode({ graph: { nodes: [] }, save: true, name: 'demo' }),
    resolveMode({ name: 'demo' }),
    resolveMode({ solve: 'something' }),
  ]
  for (const mode of modes) {
    assert.equal(typeof mode.kind, 'string')
    assert.ok(Object.hasOwn(mode, 'args'), `${mode.kind} must carry its arguments`)
  }
})

test('the tool reaches every entry path through one resolved mode', async () => {
  const ctx = fakeContext()
  apply(ctx)
  const chain = ctx.defs.get('harnessmm_chain')
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

const { resolveMode } = await import('../lib/modes.js')

  assert.equal(resolveMode({ list: true }).kind, 'list')
  assert.equal(resolveMode({ graph: { nodes: [] } }).kind, 'graph')
  assert.equal(resolveMode({ name: 'x' }).kind, 'named')
  assert.equal(resolveMode({ save: true, name: 'x', graph: { nodes: [] } }).kind, 'save')
  assert.equal(resolveMode({ solve: 'x' }).kind, 'solve')
  assert.equal(typeof chain.execute, 'function')
})

test('a call with nothing to do is rejected, naming what is missing', () => {
  assert.throws(() => resolveMode({}), /graph|list|name|solve/)
})