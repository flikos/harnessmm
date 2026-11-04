import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'harnessmm-lib-'))
process.env.HARNESSMM_HOME = home

const { saveGraph, loadGraph, listGraphs, isValidName } = await import('../lib/library.js')

test('a graph saved by name comes back unchanged', () => {
  const graph = { nodes: [{ id: 's1', action: 'shell', args: { cmd: 'echo hi' } }] }
  const file = saveGraph('verify-basic', graph, { description: 'smoke check' })
  assert.ok(fs.existsSync(file))
  assert.deepEqual(loadGraph('verify-basic'), graph)
  const listed = listGraphs()
  assert.equal(listed.length, 1)
  assert.equal(listed[0].name, 'verify-basic')
  assert.equal(listed[0].nodes, 1)
  assert.equal(listed[0].description, 'smoke check')
})

test('graph names are validated and unknown names fail clearly', () => {
  assert.equal(isValidName('verify-basic'), true)
  assert.equal(isValidName('Bad Name'), false)
  assert.equal(isValidName('../escape'), false)
  assert.throws(() => saveGraph('Bad Name', { nodes: [] }), /must match/)
  assert.throws(() => loadGraph('missing-graph'), /no saved graph named missing-graph/)
})
