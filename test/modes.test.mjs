import test from 'node:test'
import assert from 'node:assert/strict'
import { resolveMode } from '../lib/modes.js'

// The tool accepts a plan in two forms. Everything else used to be an entry
// path — saving, naming, looking one up, listing a library — and is now gone;
// a call that still asks for one must fail loudly and name the replacement.

test('a linear plan resolves to the plan mode', () => {
  const mode = resolveMode({ steps: [{ run: { cmd: 'ls' } }] })
  assert.equal(mode.kind, 'graph')
  assert.equal(mode.form, 'linear')
})

test('a graph plan resolves to the plan mode', () => {
  const mode = resolveMode({ graph: { nodes: [] } })
  assert.equal(mode.kind, 'graph')
  assert.equal(mode.form, 'graph')
})

test('every removed entry path is refused, naming the replacement', () => {
  for (const args of [{ name: 'demo' }, { save: true, name: 'demo', graph: {} }, { solve: 'do a thing' }, { list: true }]) {
    assert.throws(
      () => resolveMode(args),
      /is gone[\s\S]*State the plan in the call/,
      `expected ${JSON.stringify(args)} to be refused with the replacement`,
    )
  }
})

test('a call with no plan is rejected, saying what to pass', () => {
  assert.throws(() => resolveMode({}), /pass a plan/)
})
