import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'harnessmm-lib-'))
process.env.HARNESSMM_HOME = home

const { saveGraph, loadGraph, listGraphs, listVersions, isValidName } = await import('../lib/library.js')

test('a graph saved by name comes back unchanged', () => {
  const graph = { nodes: [{ id: 's1', action: 'shell', args: { cmd: 'echo hi' } }] }
  const { file, history, stamp } = saveGraph('verify-basic', graph, { description: 'smoke check' })
  assert.ok(fs.existsSync(file))
  assert.ok(fs.existsSync(history))
  assert.equal(stamp.length, 12)
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

test('re-saving keeps immutable versions and lists only the current entry', () => {
  const v1 = { nodes: [{ id: 's1', action: 'shell', args: { cmd: 'echo one' } }] }
  const v2 = { nodes: [{ id: 's1', action: 'shell', args: { cmd: 'echo two' } }] }
  const first = saveGraph('versioned', v1)
  const second = saveGraph('versioned', v2)
  assert.notEqual(first.stamp, second.stamp)
  assert.deepEqual(loadGraph('versioned'), v2, 'the name resolves to the latest save')
  const versions = listVersions('versioned')
  assert.equal(versions.length, 2)
  assert.ok(versions.includes(first.stamp) && versions.includes(second.stamp))
  const names = listGraphs().map((entry) => entry.name)
  assert.equal(names.filter((name) => name === 'versioned').length, 1, 'history copies are not list entries')
})
