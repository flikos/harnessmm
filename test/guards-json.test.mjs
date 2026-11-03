import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { evaluateGuard, describeGuard, GuardError } from '../lib/guards.js'
import { compileGraph, GUARD_OPS } from '../lib/graph.js'

function workspace(files = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'harnessmm-json-'))
  for (const [name, content] of Object.entries(files)) {
    fs.writeFileSync(path.join(dir, name), content)
  }
  return dir
}

const receiptsOf = (entries) => new Map(entries)

test('json_field compares a literal from a JSON file', () => {
  const cwd = workspace({ 'result.json': JSON.stringify({ answer: 42, status: 'ok' }) })
  const env = { receipts: new Map(), cwd }
  assert.equal(evaluateGuard({ op: 'json_field', path: 'result.json', field: 'answer', eq: 42 }, env), true)
  assert.equal(evaluateGuard({ op: 'json_field', path: 'result.json', field: 'status', eq: 'ok' }, env), true)
  assert.equal(evaluateGuard({ op: 'json_field', path: 'result.json', field: 'answer', eq: 41 }, env), false)
  assert.equal(evaluateGuard({ op: 'json_field', path: 'result.json', field: 'answer', ne: 41 }, env), true)
})

test('json_field walks nested paths and arrays', () => {
  const cwd = workspace({ 'deep.json': JSON.stringify({ a: { b: [{ c: 'hit' }] } }) })
  const env = { receipts: new Map(), cwd }
  assert.equal(evaluateGuard({ op: 'json_field', path: 'deep.json', field: 'a.b[0].c', eq: 'hit' }, env), true)
  assert.equal(evaluateGuard({ op: 'json_field', path: 'deep.json', field: 'a.b[1].c', exists: false }, env), true)
  assert.equal(evaluateGuard({ op: 'json_field', path: 'deep.json', field: 'a.b', exists: true }, env), true)
})

test('json_field reads the stdout of a predecessor receipt', () => {
  const receipts = receiptsOf([
    ['s2', { stepId: 's2', action: 'shell', exitCode: 0, stdout: JSON.stringify({ verdict: 'pass', score: 7 }) }],
  ])
  const env = { receipts, cwd: workspace() }
  assert.equal(evaluateGuard({ op: 'json_field', of: 's2', field: 'verdict', eq: 'pass' }, env), true)
  assert.equal(evaluateGuard({ op: 'json_field', of: 's2', field: 'score', eq: 7 }, env), true)
  assert.equal(evaluateGuard({ op: 'json_field', of: 's2', field: 'missing', exists: false }, env), true)
})

test('missing evidence is not truth: absent file or field is false, malformed JSON is an error', () => {
  const cwd = workspace({ 'broken.json': '{not json' })
  const env = { receipts: new Map(), cwd }
  assert.equal(evaluateGuard({ op: 'json_field', path: 'absent.json', field: 'answer', eq: 42 }, env), false)
  assert.throws(
    () => evaluateGuard({ op: 'json_field', path: 'broken.json', field: 'answer', eq: 42 }, env),
    GuardError,
  )
})

test('json_field may not read outside the working directory', () => {
  const cwd = workspace()
  const env = { receipts: new Map(), cwd }
  assert.throws(
    () => evaluateGuard({ op: 'json_field', path: '../../etc/passwd', field: 'x', eq: 1 }, env),
    GuardError,
  )
})

test('file_contains reads file content only', () => {
  const cwd = workspace({ 'run.log': 'building\nRESULT=42\ndone\n' })
  const env = { receipts: new Map(), cwd }
  assert.equal(evaluateGuard({ op: 'file_contains', path: 'run.log', text: 'RESULT=42' }, env), true)
  assert.equal(evaluateGuard({ op: 'file_contains', path: 'run.log', text: 'RESULT=43' }, env), false)
  assert.equal(evaluateGuard({ op: 'file_contains', path: 'absent.log', text: 'x' }, env), false)
})

test('the new operators are registered and validated before use', () => {
  assert.ok(GUARD_OPS.has('json_field'))
  assert.ok(GUARD_OPS.has('file_contains'))

  const accepted = compileGraph(
    {
      nodes: [
        {
          id: 's3',
          action: 'shell',
          args: { cmd: 'python3 verify.py' },
          after: 's2',
          guard: { op: 'json_field', of: 's2', field: 'answer', eq: 42 },
        },
      ],
    },
    { rootId: 's2' },
  )
  assert.equal(accepted.ok, true, JSON.stringify(accepted.errors))

  const noField = compileGraph(
    { nodes: [{ id: 's3', action: 'shell', args: { cmd: 'x' }, after: 's2', guard: { op: 'json_field', of: 's2', eq: 1 } }] },
    { rootId: 's2' },
  )
  assert.equal(noField.ok, false)
  assert.ok(noField.errors.some((error) => error.includes('.field')))

  const bothSources = compileGraph(
    {
      nodes: [
        {
          id: 's3',
          action: 'shell',
          args: { cmd: 'x' },
          after: 's2',
          guard: { op: 'json_field', of: 's2', path: 'result.json', field: 'answer', eq: 1 },
        },
      ],
    },
    { rootId: 's2' },
  )
  assert.equal(bothSources.ok, false)
  assert.ok(bothSources.errors.some((error) => error.includes('exactly one of')))

  const noComparison = compileGraph(
    { nodes: [{ id: 's3', action: 'shell', args: { cmd: 'x' }, after: 's2', guard: { op: 'json_field', of: 's2', field: 'answer' } }] },
    { rootId: 's2' },
  )
  assert.equal(noComparison.ok, false)
  assert.ok(noComparison.errors.some((error) => error.includes('exists, eq or ne')))
})

test('a json_field guard cannot read a successor receipt', () => {
  const compiled = compileGraph(
    {
      nodes: [
        { id: 's2', action: 'shell', args: { cmd: 'a' }, after: 's1', guard: { op: 'json_field', of: 's3', field: 'x', eq: 1 } },
        { id: 's3', action: 'shell', args: { cmd: 'b' }, after: 's2' },
      ],
    },
    { rootId: 's1' },
  )
  assert.equal(compiled.ok, false)
  assert.ok(compiled.errors.some((error) => error.includes('not a causal predecessor')))
})

test('describeGuard renders the new operators for certificates', () => {
  assert.equal(describeGuard({ op: 'json_field', path: 'result.json', field: 'answer', eq: 42 }), 'file(result.json).answer == 42')
  assert.equal(describeGuard({ op: 'file_contains', path: 'run.log', text: 'OK' }), 'file(run.log) ~ "OK"')
})