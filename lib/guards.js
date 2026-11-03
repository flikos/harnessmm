import fs from 'node:fs'
import path from 'node:path'
import { canonicalJson } from './graph.js'

/**
 * Guards consume observed receipts only. An unknown op or a missing receipt is
 * an error, and the controller treats every guard error as "not eligible":
 * the slow actor gets the decision. This is the fail-closed direction.
 */
export class GuardError extends Error {
  constructor(message) {
    super(message)
    this.name = 'GuardError'
  }
}

function requireReceipt(env, id) {
  const receipt = env.receipts.get(id)
  if (!receipt) throw new GuardError(`no receipt for ${id}`)
  return receipt
}

function requireString(value, field) {
  if (typeof value !== 'string') throw new GuardError(`${field} must be a string`)
  return value
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

function parseJsonText(text, label) {
  try {
    return JSON.parse(text)
  } catch {
    throw new GuardError(`${label} is not valid JSON`)
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

function jsonDocument(guard, env) {
  if (typeof guard.path === 'string' && guard.path !== '') {
    const text = readTextFile(env, guard.path)
    if (text === null) return { present: false }
    return { present: true, document: parseJsonText(text, `file ${guard.path}`) }
  }
  const receipt = requireReceipt(env, requireString(guard.of, 'of'))
  return {
    present: true,
    document: parseJsonText(String(receipt.stdout ?? ''), `stdout of ${guard.of}`),
  }
}

export function evaluateGuard(guard, env) {
  if (!guard) return true
  switch (guard.op) {
    case 'all': {
      if (!Array.isArray(guard.of)) throw new GuardError('all needs an array')
      return guard.of.every((child) => evaluateGuard(child, env))
    }
    case 'any': {
      if (!Array.isArray(guard.of)) throw new GuardError('any needs an array')
      return guard.of.some((child) => evaluateGuard(child, env))
    }
    case 'not':
      return !evaluateGuard(guard.of, env)
    case 'exists':
      return env.receipts.has(requireString(guard.of, 'of'))
    case 'exit_code': {
      const receipt = requireReceipt(env, requireString(guard.of, 'of'))
      if (typeof guard.eq !== 'number') throw new GuardError('exit_code needs numeric eq')
      return receipt.exitCode === guard.eq
    }
    case 'stdout_contains': {
      const receipt = requireReceipt(env, requireString(guard.of, 'of'))
      return String(receipt.stdout ?? '').includes(requireString(guard.text, 'text'))
    }
    case 'stderr_contains': {
      const receipt = requireReceipt(env, requireString(guard.of, 'of'))
      return String(receipt.stderr ?? '').includes(requireString(guard.text, 'text'))
    }
    case 'file_exists': {
      const target = resolveWithinCwd(env, requireString(guard.path, 'path'))
      return fs.existsSync(target)
    }
    case 'file_contains': {
      const text = readTextFile(env, requireString(guard.path, 'path'))
      if (text === null) return false
      return text.includes(requireString(guard.text, 'text'))
    }
    case 'json_field': {
      const { present, document } = jsonDocument(guard, env)
      if (!present) return false
      const { found, value } = resolveField(document, parseFieldPath(requireString(guard.field, 'field')))
      if (typeof guard.exists === 'boolean') return guard.exists ? found : !found
      if (!found) return false
      if (guard.eq !== undefined) return canonicalJson(value) === canonicalJson(guard.eq)
      if (guard.ne !== undefined) return canonicalJson(value) !== canonicalJson(guard.ne)
      throw new GuardError('json_field needs exists, eq or ne')
    }
    default:
      throw new GuardError(`unsupported guard op ${JSON.stringify(guard.op)}`)
  }
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