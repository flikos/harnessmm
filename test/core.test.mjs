import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { compileGraph, hashValue } from '../lib/graph.js'
import { Controller, verifyCertificate } from '../lib/controller.js'
import { evaluateGuard, GuardError } from '../lib/guards.js'
import { breakEven, estimateTokens } from '../lib/cost.js'
import { runBenchmark, ARMS } from '../lib/report.js'

const writeNode = (id, after, guard) => ({
  id,
  action: 'write',
  args: { path: 'solution.py', content: 'print(1)\n' },
  after,
  guard,
})

test('a closed, acyclic, dependency-respecting graph compiles', () => {
  const raw = {
    nodes: [
      writeNode('s2', 's1', { op: 'exists', of: 's1' }),
      {
        id: 's3',
        action: 'shell',
        args: { cmd: 'python3 check.py' },
        after: 's2',
        guard: { op: 'exit_code', of: 's2', eq: 0 },
      },
    ],
  }
  const compiled = compileGraph(raw, { rootId: 's1' })
  assert.equal(compiled.ok, true, JSON.stringify(compiled.errors))
  assert.equal(compiled.graph.nodes.length, 2)
  assert.match(compiled.graph.hash, /^[0-9a-f]{64}$/)
})

test('placeholder arguments are rejected: a decision must be fully resolved', () => {
  for (const args of [
    { cmd: '$NEXT_STEP' },
    { path: '{{file}}' },
    { cmd: '<command>' },
    { cmd: '${x}' },
    { cmd: 'pytest $TEST_FILE' },
    { cmd: 'cat solution.py > $1' },
  ]) {
    const compiled = compileGraph(
      { nodes: [{ id: 's2', action: 'shell', args, after: 's1', guard: { op: 'exists', of: 's1' } }] },
      { rootId: 's1' },
    )
    assert.equal(compiled.ok, false)
    assert.equal(compiled.errors.some((error) => error.includes('args')), true)
  }
})

test('unknown guard operators fail closed', () => {
  const compiled = compileGraph(
    { nodes: [{ id: 's2', action: 'shell', args: { cmd: 'ls' }, after: 's1', guard: { op: 'vibes', of: 's1' } }] },
    { rootId: 's1' },
  )
  assert.equal(compiled.ok, false)
  assert.equal(compiled.errors.some((error) => error.includes('unsupported guard op')), true)
})

test('a guard may not read a successor receipt', () => {
  const compiled = compileGraph(
    {
      nodes: [
        { id: 's2', action: 'shell', args: { cmd: 'a' }, after: 's1', guard: { op: 'exists', of: 's3' } },
        { id: 's3', action: 'shell', args: { cmd: 'b' }, after: 's2', guard: { op: 'exists', of: 's2' } },
      ],
    },
    { rootId: 's1' },
  )
  assert.equal(compiled.ok, false)
  assert.equal(compiled.errors.some((error) => error.includes('not a causal predecessor')), true)
})

test('cycles are rejected', () => {
  const compiled = compileGraph({
    nodes: [
      { id: 's2', action: 'shell', args: { cmd: 'a' }, after: 's3' },
      { id: 's3', action: 'shell', args: { cmd: 'b' }, after: 's2' },
    ],
  })
  assert.equal(compiled.ok, false)
  assert.equal(compiled.errors.some((error) => error.startsWith('cycle')), true)
})

test('guards consume receipts only and throw when evidence is absent', () => {
  const env = { receipts: new Map(), cwd: os.tmpdir() }
  assert.throws(() => evaluateGuard({ op: 'exit_code', of: 's9', eq: 0 }, env), GuardError)
})

test('the controller defers until a guard is proven, then executes exactly one node', () => {
  const compiled = compileGraph(
    {
      nodes: [
        {
          id: 's3',
          action: 'shell',
          args: { cmd: 'python3 check.py' },
          after: 's2',
          guard: { op: 'exit_code', of: 's2', eq: 0 },
        },
      ],
    },
    { rootId: 's1', priorIds: ['s2'] },
  )
  assert.equal(compiled.ok, true)
  const controller = new Controller({ graph: compiled.graph })

  const deferred = controller.decide({ receipts: controller.receipts, cwd: os.tmpdir() })
  assert.equal(deferred.kind, 'defer')

  controller.observe({ stepId: 's2', action: 'shell', args: { cmd: 'build' }, exitCode: 1, stdout: '', stderr: '' })
  const afterFailure = controller.decide({ receipts: controller.receipts, cwd: os.tmpdir() })
  assert.equal(afterFailure.kind, 'defer')

  controller.observe({ stepId: 's2', action: 'shell', args: { cmd: 'build' }, exitCode: 0, stdout: 'ok', stderr: '' })
  const executed = controller.decide({ receipts: controller.receipts, cwd: os.tmpdir() })
  assert.equal(executed.kind, 'execute')
  assert.equal(executed.node.id, 's3')
})

test('an ambiguous eligible set abstains and returns control to the actor', () => {
  const compiled = compileGraph(
    {
      nodes: [
        { id: 's2', action: 'shell', args: { cmd: 'a' }, after: 's1', guard: { op: 'exists', of: 's1' }, priority: 1 },
        { id: 's3', action: 'shell', args: { cmd: 'b' }, after: 's1', guard: { op: 'exists', of: 's1' }, priority: 1 },
      ],
    },
    { rootId: 's1', priorIds: ['s2'] },
  )
  assert.equal(compiled.ok, true)
  const controller = new Controller({ graph: compiled.graph })
  controller.observe({ stepId: 's1', action: 'write', args: {}, exitCode: 0 })
  const decision = controller.decide({ receipts: controller.receipts, cwd: os.tmpdir() })
  assert.equal(decision.kind, 'defer')
  assert.match(decision.reason, /abstained/)
  assert.deepEqual(decision.eligible, ['s2', 's3'])
})

test('a certificate binds graph, decision, receipt and the bypassed callback', () => {
  const compiled = compileGraph(
    {
      nodes: [
        { id: 's2', action: 'write', args: { path: 'a.py', content: 'x = 1\n' }, after: 's1', guard: { op: 'exists', of: 's1' } },
      ],
    },
    { rootId: 's1', priorIds: ['s2'] },
  )
  assert.equal(compiled.ok, true)
  const controller = new Controller({ graph: compiled.graph })
  controller.observe({ stepId: 's1', action: 'write', args: {}, exitCode: 0 })
  const receipt = { stepId: 's2', action: 'write', args: { path: 'a.py' }, exitCode: 0, stdout: 'ok' }
  controller.observe(receipt)
  const certificate = controller.certify(controller.graph.byId.get('s2'), receipt, {
    bypassedCallbackId: 'llm-callback:step-2',
  })

  const receipts = new Map([
    ['s1', controller.receipts.get('s1')],
    ['s2', receipt],
  ])
  const verdict = verifyCertificate(certificate, { graphHash: compiled.graph.hash, receipts })
  assert.deepEqual(verdict, { ok: true, problems: [] })

  const tampered = verifyCertificate(certificate, {
    graphHash: compiled.graph.hash,
    receipts: new Map([...receipts, ['s2', { ...receipt, exitCode: 9 }]]),
  })
  assert.equal(tampered.ok, false)
  assert.equal(tampered.problems.includes('tool receipt changed'), true)
})

test('break-even rounds up and refuses an impossible saving', () => {
  assert.equal(breakEven({ introducedTokens: 669, removedPerCallbackTokens: 157.5 }), 5)
  assert.equal(breakEven({ introducedTokens: 10, removedPerCallbackTokens: 0 }), null)
  assert.equal(estimateTokens('abcd'), 1)
})

test('end to end: the same task set succeeds in both arms with fewer calls in the harness arm', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'harnessmm-test-'))
  const result = runBenchmark({ taskIds: ['add', 'roman'], root })
  assert.deepEqual(ARMS, ['baseline', 'harness'])
  assert.equal(result.summary.baseline.successRate, 1)
  assert.equal(result.summary.harness.successRate, 1)
  assert.ok(result.summary.harness.actorCalls < result.summary.baseline.actorCalls)
  assert.equal(result.summary.certificatesTotal, result.summary.certificatesVerified)
  assert.ok(result.summary.removedTokens > 0)
})