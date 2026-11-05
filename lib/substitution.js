import { createHash } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

/**
 * Decision substitution at the model boundary.
 *
 * The paper's claim is that a resolved decision does not need to be reasoned
 * about twice. At the boundary that means: when the incoming request is one a
 * stored decision already covers, answer with the decision instead of asking
 * the model what to do — the loop then executes it as if the model had chosen.
 *
 * Everything here is a pure function of the request plus the decision store, so
 * policy can be tested without a Harness. The plugin wires it into `llm/stream`.
 */

/** Calls the harness makes for itself; a decision must never replace these. */
export const INTERNAL_PURPOSES = new Set(['session-title', 'compaction'])

export function decisionsFile(config = {}) {
  if (config.decisionsPath) return config.decisionsPath
  const home = process.env.HARNESSMM_HOME
    ? process.env.HARNESSMM_HOME
    : path.join(os.homedir(), '.harnessmm')
  return path.join(home, 'decisions.json')
}

function blockText(content) {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content
    .filter((block) => block?.type === 'text')
    .map((block) => block.text)
    .join('')
}

function authoredText(message) {
  const source = message?.source?.kind
  if (source !== undefined && source !== 'user') return null
  if (message?.role !== 'user') return null
  return blockText(message.content)
}

/**
 * Text that identifies the turn's request.
 *
 * The loop appends runtime context as further user messages *after* the real
 * request, so the last user message is not the user's turn: only messages whose
 * source says a person wrote them count.
 */
export function requestText(options) {
  const messages = options?.messages ?? []
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const text = authoredText(messages[index])
    if (text === null) continue
    if (text.trim() === '') continue
    return text
  }
  return null
}

/** Normalization is deliberately blunt: case and whitespace are not meaning. */
export function normalizeRequest(text) {
  return text.trim().replace(/\s+/g, ' ').toLowerCase()
}

/** Stable short fingerprint of the turn's request, or null when there is none. */
export function fingerprintRequest(options) {
  const text = requestText(options)
  if (text === null) return null
  return createHash('sha256').update(normalizeRequest(text)).digest('hex').slice(0, 16)
}

export function readDecisions(file) {
  let raw
  try {
    raw = fs.readFileSync(file, 'utf8')
  } catch {
    return []
  }
  let parsed
  try {
    parsed = JSON.parse(raw)
  } catch {
    return []
  }
  const list = Array.isArray(parsed) ? parsed : parsed?.decisions
  if (!Array.isArray(list)) return []
  return list.filter((entry) => entry && typeof entry === 'object')
}

/**
 * A decision is usable only when it names a tool and carries arguments the tool
 * can accept. A malformed entry must fall through to the model, never fail the
 * turn.
 */
export function isUsableDecision(decision) {
  if (typeof decision?.fingerprint !== 'string' || decision.fingerprint === '') return false
  if (typeof decision?.tool !== 'string' || decision.tool === '') return false
  const args = decision.arguments
  if (args === undefined || args === null) return false
  if (typeof args === 'string') {
    try {
      const parsed = JSON.parse(args)
      return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)
    } catch {
      return false
    }
  }
  return typeof args === 'object' && !Array.isArray(args)
}

export function findDecision(decisions, fingerprint) {
  if (fingerprint === null) return null
  return decisions.find((entry) => entry.fingerprint === fingerprint && isUsableDecision(entry)) ?? null
}

/**
 * Chunks that make the loop execute one tool call. A `block-end` alone is
 * enough: the loop's assembler produced the same block with and without
 * `block-start`, and the shorter stream leaves nothing half-open.
 */
export function synthesizedChunks(decision, callId = 'harnessmm_substitution') {
  const args = typeof decision.arguments === 'string'
    ? decision.arguments
    : JSON.stringify(decision.arguments)
  return [
    {
      type: 'block-end',
      index: 0,
      block: { type: 'tool-call', id: callId, name: decision.tool, arguments: args },
    },
    { type: 'finish', reason: { kind: 'tool-calls' } },
  ]
}

/**
 * Decide what, if anything, to substitute for one model call.
 *
 * Default is refusal: an internal call, a disabled policy, an exhausted budget,
 * an unmatched request or an unusable decision all return `null`, and the caller
 * passes the request through to the model.
 *
 * A decision is spent once per session. The authored request stays in the
 * conversation after the synthesized call runs, so a second match on the
 * follow-up request would substitute the same decision again — forever, since
 * every substituted turn produces another request. `spent` is what stops that.
 */
export function decideSubstitution(options, context) {
  const { decisions, spent, perSession, config = {} } = context
  if (config.enabled !== true) return null
  if (options?.purpose !== undefined) return null
  if (INTERNAL_PURPOSES.has(options?.purpose)) return null

  const fingerprint = fingerprintRequest(options)
  if (fingerprint === null) return null

  const decision = findDecision(decisions, fingerprint)
  if (decision === null) return null

  const session = String(options?.sessionId ?? '')
  const key = `${session}:${fingerprint}`
  if (spent?.has(key) === true) return null

  const max = Number.isFinite(config.maxPerSession) ? config.maxPerSession : 5
  if ((perSession?.get(session) ?? 0) >= max) return null

  return { fingerprint, decision, session, key }
}

/** Record a substitution so the same decision is not taken twice in a session. */
export function commitSubstitution(state, hit) {
  state.spent.add(hit.key)
  state.perSession.set(hit.session, (state.perSession.get(hit.session) ?? 0) + 1)
}

/** Fresh per-session policy state. */
export function createSubstitutionState(decisions = []) {
  return { decisions, spent: new Set(), perSession: new Map() }
}