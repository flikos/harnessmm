import fs from 'node:fs'
import path from 'node:path'
import { canonicalJson } from './graph.js'

/**
 * Guards consume observed receipts only. A verdict separates three outcomes:
 *  - eligible: the evidence proves the condition;
 *  - known negative: the evidence definitively says no;
 *  - unknown: the evidence is absent or unreadable.
 * Both non-eligible outcomes refuse admission, but only "unknown" means the
 * controller could not check — the distinction is what makes deferrals
 * diagnosable from the ledger instead of guesswork.
 */
export class GuardError extends Error {
  constructor(message) {
    super(message)
    this.name = 'GuardError'
  }
}

const positive = () => ({ eligible: true, known: true })
const negative = (reason) => ({ eligible: false, known: true, reason })
const absent = (reason) => ({ eligible: false, known: false, reasonKind: 'absent', reason })
const unreadable = (reason) => ({ eligible: false, known: false, reasonKind: 'unreadable', reason })

function receiptOf(env, id) {
  return env.receipts.get(id)
}

function resolveWithinCwd(env, relative) {
  if (!env.cwd) throw new GuardError('file guard needs a cwd')
  const root = path.resolve(env.cwd)
  const target = path.resolve(root, relative)
  if (target !== root && !target.startsWith(`${root}${path.sep}`)) {
    throw new GuardError(`path escapes cwd: ${relative}`)
  }
  return target
}

function readTextFile(env, relative) {
  try {
    return fs.readFileSync(resolveWithinCwd(env, relative), 'utf8')
  } catch (error) {
    if (error instanceof GuardError) throw error
    return null
  }
}

/** "answer" | "a.b[0].c" -> ["a","b",0,"c"] */
function parseFieldPath(field) {
  const parts = []
  for (const segment of field.split('.')) {
    const match = /^([^[\]]*)((?:\[\d+\])*)$/.exec(segment)
    if (!match) throw new GuardError(`bad field path ${field}`)
    const [, name, indexes] = match
    if (name) parts.push(name)
    for (const index of indexes.match(/\d+/g) ?? []) parts.push(Number(index))
  }
  if (parts.length === 0) throw new GuardError(`bad field path ${field}`)
  return parts
}

function resolveField(document, parts) {
  let cursor = document
  for (const part of parts) {
    if (cursor === null || typeof cursor !== 'object') return { found: false }
    if (typeof part === 'number') {
      if (!Array.isArray(cursor) || part >= cursor.length) return { found: false }
      cursor = cursor[part]
    } else {
      if (!Object.prototype.hasOwnProperty.call(cursor, part)) return { found: false }
      cursor = cursor[part]
    }
  }
  return { found: true, value: cursor }
}

function jsonFieldVerdict(guard, env) {
  let document
  if (typeof guard.path === 'string' && guard.path !== '') {
    const text = readTextFile(env, guard.path)
    if (text === null) return absent(`file ${guard.path} is not readable`)
    try {
      document = JSON.parse(text)
    } catch {
      return unreadable(`file ${guard.path} is not valid JSON`)
    }
  } else {
    const receipt = receiptOf(env, guard.of)
    if (!receipt) return unreadable(`no receipt for ${guard.of}`)
    if (typeof receipt.stdout !== 'string') return unreadable(`receipt ${guard.of} has no readable stdout`)
    try {
      document = JSON.parse(receipt.stdout)
    } catch {
      return unreadable(`stdout of ${guard.of} is not valid JSON`)
    }
  }
  let parts
  try {
    parts = parseFieldPath(guard.field)
  } catch (error) {
    return unreadable(error.message)
  }
  const { found, value } = resolveField(document, parts)
  if (typeof guard.exists === 'boolean') {
    return guard.exists === found ? positive() : negative(`field ${guard.field} exists == ${found}, expected ${guard.exists}`)
  }
  if (!found) return absent(`field ${guard.field} is missing`)
  if (guard.eq !== undefined) {
    return canonicalJson(value) === canonicalJson(guard.eq)
      ? positive()
      : negative(`field ${guard.field} == ${canonicalJson(value)}, expected ${canonicalJson(guard.eq)}`)
  }
  if (guard.ne !== undefined) {
    return canonicalJson(value) !== canonicalJson(guard.ne)
      ? positive()
      : negative(`field ${guard.field} == ${canonicalJson(value)}, expected != ${canonicalJson(guard.ne)}`)
  }
  return unreadable('json_field needs exists, eq or ne')
}

/** Full three-valued verdict; this is what the controller and ledger consume. */
export function evaluateGuardVerdict(guard, env) {
  if (!guard) return positive()
  switch (guard.op) {
    case 'all': {
      if (!Array.isArray(guard.of)) return unreadable('all needs an array')
      const children = guard.of.map((child) => evaluateGuardVerdict(child, env))
      const definite = children.find((child) => child.known && !child.eligible)
      if (definite) return negative(`all: ${definite.reason ?? 'branch failed'}`)
      const unknown = children.find((child) => !child.known)
      if (unknown) return { ...unknown, reason: `all: ${unknown.reason}` }
      return positive()
    }
    case 'any': {
      if (!Array.isArray(guard.of)) return unreadable('any needs an array')
      const children = guard.of.map((child) => evaluateGuardVerdict(child, env))
      if (children.some((child) => child.known && child.eligible)) return positive()
      if (children.every((child) => child.known)) return negative('any: no branch holds')
      const unknown = children.find((child) => !child.known)
      return { ...unknown, reason: `any: ${unknown.reason}` }
    }
    case 'not': {
      const child = evaluateGuardVerdict(guard.of, env)
      if (!child.known) return child
      return child.eligible ? negative(`not: inner guard holds (${child.reason ?? ''})`.trim()) : positive()
    }
    case 'exists':
      return typeof guard.of === 'string'
        ? (env.receipts.has(guard.of) ? positive() : negative(`receipt ${guard.of} does not exist`))
        : unreadable('exists needs a receipt id')
    case 'exit_code': {
      const receipt = receiptOf(env, guard.of)
      if (!receipt) return unreadable(`no receipt for ${guard.of}`)
      if (!Number.isFinite(receipt.exitCode)) return unreadable(`receipt ${guard.of} has no numeric exitCode`)
      return receipt.exitCode === guard.eq
        ? positive()
        : negative(`receipt ${guard.of} exit ${receipt.exitCode} != ${guard.eq}`)
    }
    case 'stdout_contains':
    case 'stderr_contains': {
      const field = guard.op === 'stdout_contains' ? 'stdout' : 'stderr'
      const receipt = receiptOf(env, guard.of)
      if (!receipt) return unreadable(`no receipt for ${guard.of}`)
      if (typeof receipt[field] !== 'string') return unreadable(`receipt ${guard.of} has no readable ${field}`)
      return receipt[field].includes(guard.text)
        ? positive()
        : negative(`receipt ${guard.of} ${field} does not contain ${JSON.stringify(guard.text)}`)
    }
    case 'file_exists': {
      let target
      try {
        target = resolveWithinCwd(env, guard.path)
      } catch (error) {
        return unreadable(error.message)
      }
      return fs.existsSync(target) ? positive() : negative(`file ${guard.path} does not exist`)
    }
    case 'file_contains': {
      const text = readTextFile(env, guard.path)
      if (text === null) return absent(`file ${guard.path} is not readable`)
      return text.includes(guard.text)
        ? positive()
        : negative(`file ${guard.path} does not contain ${JSON.stringify(guard.text)}`)
    }
    case 'json_field':
      return jsonFieldVerdict(guard, env)
    default:
      return unreadable(`unsupported guard op ${JSON.stringify(guard.op)}`)
  }
}

/**
 * Boolean compatibility wrapper: unreadable evidence raises (the caller must
 * not treat it as "false"), absent evidence is false.
 */
export function evaluateGuard(guard, env) {
  const verdict = evaluateGuardVerdict(guard, env)
  if (!verdict.known && verdict.reasonKind === 'unreadable') {
    throw new GuardError(verdict.reason)
  }
  return verdict.eligible
}

/** Human-readable guard source, used in certificates and reports. */
export function describeGuard(guard) {
  if (!guard) return 'always'
  switch (guard.op) {
    case 'all':
      return `(${guard.of.map(describeGuard).join(' AND ')})`
    case 'any':
      return `(${guard.of.map(describeGuard).join(' OR ')})`
    case 'not':
      return `NOT ${describeGuard(guard.of)}`
    case 'exists':
      return `receipt(${guard.of}) exists`
    case 'exit_code':
      return `receipt(${guard.of}).exit == ${guard.eq}`
    case 'stdout_contains':
      return `receipt(${guard.of}).stdout ~ ${JSON.stringify(guard.text)}`
    case 'stderr_contains':
      return `receipt(${guard.of}).stderr ~ ${JSON.stringify(guard.text)}`
    case 'file_exists':
      return `file(${guard.path}) exists`
    case 'file_contains':
      return `file(${guard.path}) ~ ${JSON.stringify(guard.text)}`
    case 'json_field': {
      const source = guard.path ? `file(${guard.path})` : `receipt(${guard.of})`
      if (typeof guard.exists === 'boolean') return `${source}.${guard.field} exists == ${guard.exists}`
      if (guard.eq !== undefined) return `${source}.${guard.field} == ${JSON.stringify(guard.eq)}`
      return `${source}.${guard.field} != ${JSON.stringify(guard.ne)}`
    }
    default:
      return `unknown(${String(guard.op)})`
  }
}
