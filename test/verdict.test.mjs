import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { evaluateGuardVerdict, evaluateGuard, GuardError } from '../lib/guards.js'
import { compileGraph, guardFieldNeeds } from '../lib/graph.js'
import { Controller } from '../lib/controller.js'
import { runChain, makeExecutor, renderChain, scrubbedEnvironment } from '../lib/chain.js'

const workspace = () => fs.mkdtempSync(path.join(os.tmpdir(), 'harnessmm-verdict-'))

test('verdicts separate "evidence says no" from "evidence cannot be read"', () => {
  const env = { receipts: new Map(), cwd: workspace() }

  const noReceipt = evaluateGuardVerdict({ op: 'exit_code', of: 's9', eq: 0 }, env)
  assert.equal(noReceipt.known, false)
  assert.equal(noReceipt.reasonKind, 'unreadable')

  env.receipts.set('s1', { stepId: 's1', exitCode: 3, stdout: 'x', stderr: '' })
  const wrongCode = evaluateGuardVerdict({ op: 'exit_code', of: 's1', eq: 0 }, env)
  assert.deepEqual({ eligible: wrongCode.eligible, known: wrongCode.known }, { eligible: false, known: true })
  assert.match(wrongCode.reason, /exit 3 != 0/)

  const absentFile = evaluateGuardVerdict({ op: 'json_field', path: 'nope.json', field: 'a', eq: 1 }, env)
  assert.equal(absentFile.known, false)
  assert.equal(absentFile.reasonKind, 'absent')

  env.receipts.set('s2', { stepId: 's2', exitCode: 0, stdout: '{"answer": 41}', stderr: '' })
  const wrongField = evaluateGuardVerdict({ op: 'json_field', of: 's2', field: 'answer', eq: 42 }, env)
  assert.equal(wrongField.known, true)
  assert.equal(wrongField.eligible, false)

  const missingField = evaluateGuardVerdict({ op: 'json_field', of: 's2', field: 'other', eq: 1 }, env)
  assert.equal(missingField.known, false, 'a missing field is absent evidence, not a negative')

  const badStdout = evaluateGuardVerdict(
    { op: 'stdout_contains', of: 's1', text: 'x' },
    { receipts: new Map([['s1', { stepId: 's1', exitCode: 0 }]]), cwd: env.cwd },
  )
  assert.equal(badStdout.known, false)
  assert.equal(badStdout.reasonKind, 'unreadable')
})

test('combinators propagate the strongest definite verdict and stay unknown otherwise', () => {
  const cwd = workspace()
  const env = { receipts: new Map([['s1', { stepId: 's1', exitCode: 1, stdout: '', stderr: '' }]]), cwd }
  const definite = evaluateGuardVerdict(
    { op: 'all', of: [{ op: 'exit_code', of: 's1', eq: 0 }, { op: 'json_field', path: 'nope.json', field: 'a', eq: 1 }] },
    env,
  )
  assert.deepEqual({ eligible: definite.eligible, known: definite.known }, { eligible: false, known: true })

  const unknown = evaluateGuardVerdict(
    { op: 'any', of: [{ op: 'exit_code', of: 'sX', eq: 0 }] },
    env,
  )
  assert.equal(unknown.known, false)
})

test('the boolean wrapper still throws on unreadable and returns false on absent', () => {
  const env = { receipts: new Map(), cwd: workspace() }
  assert.throws(() => evaluateGuard({ op: 'exit_code', of: 's9', eq: 0 }, env), GuardError)
  assert.equal(evaluateGuard({ op: 'json_field', path: 'nope.json', field: 'a', eq: 1 }, env), false)
})

test('required_receipt_fields must cover what the guard reads', () => {
  assert.deepEqual([...guardFieldNeeds({ op: 'exit_code', of: 's1', eq: 0 })], ['exitCode'])
  assert.deepEqual([...guardFieldNeeds({ op: 'json_field', of: 's1', field: 'a', eq: 1 })], ['stdout'])

  const undeclared = compileGraph({
    nodes: [
      {
        id: 's2', action: 'shell', args: { cmd: 'x' }, after: 's1',
        guard: { op: 'exit_code', of: 's1', eq: 0 },
        required_receipt_fields: ['stdout'],
      },
    ],
  }, { rootId: 's1' })
  assert.equal(undeclared.ok, false)
  assert.ok(undeclared.errors.some((error) => error.includes('undeclared field')))

  const declared = compileGraph({
    nodes: [
      {
        id: 's2', action: 'shell', args: { cmd: 'x' }, after: 's1',
        guard: { op: 'exit_code', of: 's1', eq: 0 },
        required_receipt_fields: ['exitCode'],
      },
    ],
  }, { rootId: 's1' })
  assert.equal(declared.ok, true)
  assert.deepEqual(declared.graph.nodes[0].required_receipt_fields, ['exitCode'], 'declaration must survive compilation')

  const badShape = compileGraph({
    nodes: [{ id: 's1', action: 'shell', args: { cmd: 'x' }, required_receipt_fields: ['vibes'] }],
  })
  assert.equal(badShape.ok, false)
})

test('chain commands never see credential-shaped environment variables', async () => {
  process.env.HARNESSMM_TEST_SECRET_TOKEN = 'hunter2'
  const env = scrubbedEnvironment()
  assert.equal('HARNESSMM_TEST_SECRET_TOKEN' in env, false)
  assert.equal(env.PATH !== undefined, true, 'PATH must survive scrubbing')

  const cwd = workspace()
  const result = await runChain({
    raw: { nodes: [{ id: 's1', action: 'shell', args: { cmd: 'printenv HARNESSMM_TEST_SECRET_TOKEN || echo unset' } }] },
    cwd,
    execute: makeExecutor({ cwd, allowShell: true }),
  })
  assert.match(result.steps[0].stdout, /unset/)
  assert.equal(result.steps[0].stdout.includes('hunter2'), false)
  delete process.env.HARNESSMM_TEST_SECRET_TOKEN
})

test('a deferred chain explains each pending node in report and result', async () => {
  const cwd = workspace()
  const result = await runChain({
    raw: {
      nodes: [
        { id: 's1', action: 'shell', args: { cmd: 'exit 2' } },
        { id: 's2', action: 'shell', args: { cmd: 'echo a' }, after: 's1', guard: { op: 'exit_code', of: 's1', eq: 0 } },
        { id: 's3', action: 'shell', args: { cmd: 'echo b' }, after: 's2', guard: { op: 'exit_code', of: 's2', eq: 0 } },
      ],
    },
    cwd,
    execute: makeExecutor({ cwd, allowShell: true }),
  })
  assert.equal(result.stopReason, 'deferred')
  const states = Object.fromEntries(result.deferReasons.map((reason) => [reason.id, reason.state]))
  assert.equal(states.s2, 'guard-negative')
  assert.equal(states.s3, 'waiting-for-predecessor')
  const report = renderChain(result)
  assert.match(report, /Why stopped:/)
  assert.match(report, /s2: guard-negative/)
  assert.match(report, /s3: waiting-for-predecessor/)
})
