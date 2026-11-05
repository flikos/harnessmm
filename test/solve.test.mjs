import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { apply } from '../index.js'

// Tool code writes to the graph library and the usage ledger; keep both in a
// throwaway directory so a test run never touches the live state.
const TEST_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'harnessmm-solve-'))
process.env.HARNESSMM_HOME = TEST_HOME
process.env.HARNESSMM_USAGE_DIR = path.join(TEST_HOME, 'usage')

const GRAPH = {
  nodes: [
    {
      id: 's2',
      action: 'shell',
      args: { cmd: 'echo verified' },
      after: 's1',
      guard: { op: 'exit_code', of: 's1', eq: 0 },
      required_receipt_fields: ['exitCode'],
    },
  ],
}

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

function chainTool() {
  const ctx = fakeContext()
  apply(ctx)
  return ctx.defs.get('harnessmm_chain')
}

test('a saved intent makes a chain suggestible without registering any phrase', async () => {
  const chain = chainTool()
  await chain.execute({
    graph: GRAPH,
    name: 'verify-package',
    save: true,
    intent: 'пакет: тесты и замер',
    description: 'syntax, tests, bench',
    rootId: 's1',
    cwd: TEST_HOME,
  })

  // `rootId` names the receipt the author already holds: a chain cannot start
  // from nothing, and a saved graph is re-run against a fresh one.
  const result = await chain.execute({ solve: 'прогони тесты и замер для пакета', cwd: TEST_HOME, rootId: 's1' })
  // The matched chain is what ran: a shell node guarded on a receipt the model
  // never supplied, so it defers here — the point is that the graph was found
  // and loaded, not that it completed.
  assert.notEqual(result.stopReason, 'no-match')
  // The matched graph was loaded and attempted: it defers because its first
  // step has no receipt, which is the point — the lookup happened.
  assert.match(result.markdown, /Chain (stopped|completed)/)
})

test('an unmatched request reports what exists instead of guessing', async () => {
  const chain = chainTool()
  const result = await chain.execute({ solve: 'переведи этот текст на английский' })
  assert.equal(result.stopReason, 'no-match')
  assert.match(result.markdown, /verify-package/)
  assert.match(result.markdown, /пакет: тесты и замер/)
})

test('a chain saved without intent is listed but never suggested', async () => {
  // Its own library, so the intent-bearing chain saved by the first test cannot
  // satisfy this request.
  const isolated = fs.mkdtempSync(path.join(os.tmpdir(), 'harnessmm-solve-anon-'))
  const previous = process.env.HARNESSMM_HOME
  process.env.HARNESSMM_HOME = isolated
  try {
    const chain = chainTool()
    await chain.execute({ graph: GRAPH, name: 'anonymous-chain', save: true, rootId: 's1', cwd: isolated })
    const listed = await chain.execute({ list: true })
    assert.match(listed.markdown, /anonymous-chain/)
    assert.match(listed.markdown, /not suggestible/)

    const result = await chain.execute({ solve: 'пакет тесты замер', cwd: isolated })
    assert.equal(result.stopReason, 'no-match')
  } finally {
    process.env.HARNESSMM_HOME = previous
  }
})