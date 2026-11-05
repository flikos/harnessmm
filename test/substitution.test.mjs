import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  commitSubstitution,
  createSubstitutionState,
  decideSubstitution,
  decisionsFile,
  findDecision,
  fingerprintRequest,
  isUsableDecision,
  normalizeRequest,
  readDecisions,
  requestText,
  synthesizedChunks,
} from '../lib/substitution.js'

const user = (text, kind = 'user') => ({ role: 'user', content: [{ type: 'text', text }], source: { kind } })
const request = (text, extra = {}) => ({ provider: 'p', model: 'm', messages: [user(text)], ...extra })

test('request text is the authored turn, not the runtime context appended after it', () => {
  const options = {
    messages: [
      user('earlier turn'),
      { role: 'assistant', content: [{ type: 'text', text: 'reply' }], source: { kind: 'model' } },
      user('build and test the project'),
      user('<runtime-context>cwd=/x</runtime-context>', 'runtime-context'),
    ],
  }
  assert.equal(requestText(options), 'build and test the project')
})

test('fingerprint ignores case and whitespace but not meaning', () => {
  const a = fingerprintRequest(request('Build  the project'))
  const b = fingerprintRequest(request(' build the project '))
  const c = fingerprintRequest(request('build the other project'))
  assert.equal(a, b)
  assert.notEqual(a, c)
  assert.equal(normalizeRequest('A  b'), 'a b')
})

test('a request without an authored turn has no fingerprint', () => {
  assert.equal(fingerprintRequest({ messages: [] }), null)
  assert.equal(fingerprintRequest({ messages: [user('x', 'runtime-context')] }), null)
})

test('unusable decisions are ignored rather than substituted', () => {
  assert.equal(isUsableDecision({ fingerprint: 'f', tool: 'bash', arguments: '{"command":"ls"}' }), true)
  assert.equal(isUsableDecision({ fingerprint: 'f', tool: 'bash', arguments: { command: 'ls' } }), true)
  assert.equal(isUsableDecision({ fingerprint: 'f', tool: 'bash', arguments: '{not json' }), false)
  assert.equal(isUsableDecision({ fingerprint: 'f', tool: '', arguments: {} }), false)
  assert.equal(isUsableDecision({ fingerprint: '', tool: 'bash', arguments: {} }), false)
  assert.equal(isUsableDecision({ tool: 'bash', arguments: {} }), false)
})

test('decideSubstitution refuses by default and for internal calls', () => {
  const fingerprint = fingerprintRequest(request('deploy it'))
  const decisions = [{ fingerprint, tool: 'bash', arguments: { command: 'make deploy' } }]
  const options = request('deploy it')

  assert.equal(decideSubstitution(options, { decisions }), null, 'disabled by default')
  assert.equal(
    decideSubstitution({ ...options, purpose: 'session-title' }, {
      decisions,
      config: { enabled: true },
    }),
    null,
    'internal call',
  )
  assert.equal(
    decideSubstitution({ ...options, purpose: 'compaction' }, {
      decisions,
      config: { enabled: true },
    }),
    null,
    'compaction call',
  )
  assert.equal(
    decideSubstitution(request('something else'), {
      decisions,
      config: { enabled: true },
    }),
    null,
    'unmatched request',
  )
})

test('a decision is spent once per session, so the follow-up request falls through', () => {
  const fingerprint = fingerprintRequest(request('deploy it'))
  const decisions = [{ fingerprint, tool: 'bash', arguments: { command: 'make deploy' } }]
  const options = { ...request('deploy it'), sessionId: 'session-1' }
  const state = createSubstitutionState(decisions)
  const config = { enabled: true }

  const first = decideSubstitution(options, { ...state, config })
  assert.ok(first, 'first call substitutes')
  assert.equal(first.decision.tool, 'bash')

  commitSubstitution(state, first)

  assert.equal(
    decideSubstitution(options, { ...state, config }),
    null,
    'the same request after its tool ran must reach the model',
  )

  const otherSession = { ...options, sessionId: 'session-2' }
  assert.ok(decideSubstitution(otherSession, { ...state, config }), 'another session may still use it')
})

test('the per-session cap stops a long run from substituting forever', () => {
  const decisions = []
  for (let index = 0; index < 5; index += 1) {
    const text = `task number ${index}`
    decisions.push({ fingerprint: fingerprintRequest(request(text)), tool: 'bash', arguments: {} })
  }
  const state = createSubstitutionState(decisions)
  const config = { enabled: true, maxPerSession: 2 }
  let substitutions = 0
  for (let index = 0; index < 5; index += 1) {
    const options = { ...request(`task number ${index}`), sessionId: 'session-1' }
    const hit = decideSubstitution(options, { ...state, config })
    if (hit !== null) {
      substitutions += 1
      commitSubstitution(state, hit)
    }
  }
  assert.equal(substitutions, 2)
})

test('synthesized chunks describe exactly one tool call', () => {
  const chunks = synthesizedChunks({ tool: 'bash', arguments: { command: 'ls' } })
  assert.equal(chunks.length, 2)
  assert.equal(chunks[0].type, 'block-end')
  assert.equal(chunks[0].block.type, 'tool-call')
  assert.equal(chunks[0].block.name, 'bash')
  assert.equal(chunks[0].block.arguments, '{"command":"ls"}')
  assert.equal(chunks[1].type, 'finish')
  assert.equal(chunks[1].reason.kind, 'tool-calls')
})

test('the decision store tolerates a missing or broken file', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'harnessmm-decisions-'))
  assert.deepEqual(readDecisions(path.join(dir, 'absent.json')), [])
  const broken = path.join(dir, 'broken.json')
  fs.writeFileSync(broken, '{not json')
  assert.deepEqual(readDecisions(broken), [])

  const good = path.join(dir, 'good.json')
  fs.writeFileSync(good, JSON.stringify({ decisions: [{ fingerprint: 'abc', tool: 'bash', arguments: '{}' }] }))
  assert.equal(readDecisions(good).length, 1)

  const list = path.join(dir, 'list.json')
  fs.writeFileSync(list, JSON.stringify([{ fingerprint: 'abc' }]))
  assert.equal(readDecisions(list).length, 1)
})

test('findDecision needs both a match and a usable entry', () => {
  const usable = { fingerprint: 'f1', tool: 'bash', arguments: '{}' }
  const broken = { fingerprint: 'f2', tool: 'bash', arguments: '{oops' }
  assert.equal(findDecision([broken], 'f2'), null)
  assert.equal(findDecision([usable], 'f1'), usable)
  assert.equal(findDecision([usable], null), null)
})

test('the decisions file lives under the harnessmm home unless told otherwise', () => {
  const previous = process.env.HARNESSMM_HOME
  process.env.HARNESSMM_HOME = '/tmp/harnessmm-fixture'
  try {
    assert.equal(decisionsFile(), '/tmp/harnessmm-fixture/decisions.json')
    assert.equal(decisionsFile({ decisionsPath: '/tmp/explicit.json' }), '/tmp/explicit.json')
  } finally {
    if (previous === undefined) delete process.env.HARNESSMM_HOME
    else process.env.HARNESSMM_HOME = previous
  }
})