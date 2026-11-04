import { createHash } from 'node:crypto'

/**
 * Executable Decision Graph (EDG) schema, literal-closure validation and
 * dependency checking. Everything here is deterministic and side-effect free.
 */

const ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/

const PLACEHOLDER_PATTERNS = [
  ['template {{...}} expression', /\{\{/],
  ['template ${...} expression', /\$\{/],
  ['angle-bracket placeholder', /<[A-Za-z_][^<>]{0,60}>/],
  ['variable reference', /\$[A-Za-z_][A-Za-z0-9_]*/],
  ['positional variable', /\$[0-9]/],
]

export const GUARD_OPS = new Set([
  'exists',
  'exit_code',
  'stdout_contains',
  'stderr_contains',
  'file_exists',
  'file_contains',
  'json_field',
  'all',
  'any',
  'not',
])

/** Stable JSON so graph hashes do not depend on key order. */
export function canonicalJson(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`
  const keys = Object.keys(value).sort()
  return `{${keys.map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`
}

export function hashValue(value) {
  return createHash('sha256').update(canonicalJson(value)).digest('hex')
}

/**
 * Literal closure: an EDG argument must be fully materialised. A placeholder
 * means the value still depends on future inference, which would silently turn
 * a compiled decision back into a reasoning call.
 */
export function literalViolations(value, path = 'args') {
  const problems = []
  if (typeof value === 'string') {
    for (const [label, pattern] of PLACEHOLDER_PATTERNS) {
      if (pattern.test(value)) problems.push(`${path}: ${label} in ${JSON.stringify(value)}`)
    }
    if (value.trim() === '') problems.push(`${path}: empty string is not a resolved literal`)
    return problems
  }
  if (Array.isArray(value)) {
    value.forEach((item, index) => problems.push(...literalViolations(item, `${path}[${index}]`)))
    return problems
  }
  if (value && typeof value === 'object') {
    for (const [key, item] of Object.entries(value)) {
      problems.push(...literalViolations(item, `${path}.${key}`))
    }
    return problems
  }
  if (value === null || ['boolean', 'number'].includes(typeof value)) return problems
  return [`${path}: unsupported literal type ${typeof value}`]
}

function guardRefs(guard, path, errors) {
  if (!guard || typeof guard !== 'object' || Array.isArray(guard)) {
    errors.push(`${path}: guard must be an object`)
    return []
  }
  const op = guard.op
  if (!GUARD_OPS.has(op)) {
    errors.push(`${path}: unsupported guard op ${JSON.stringify(op)} (fail closed)`)
    return []
  }
  if (op === 'all' || op === 'any') {
    if (!Array.isArray(guard.of) || guard.of.length === 0) {
      errors.push(`${path}.of: ${op} needs a non-empty array`)
      return []
    }
    return guard.of.flatMap((child, index) => guardRefs(child, `${path}.of[${index}]`, errors))
  }
  if (op === 'not') {
    return guardRefs(guard.of, `${path}.of`, errors)
  }
  if (op === 'file_exists') {
    if (typeof guard.path !== 'string' || guard.path.trim() === '') {
      errors.push(`${path}.path: file_exists needs a path`)
    }
    return []
  }
  if (op === 'file_contains') {
    if (typeof guard.path !== 'string' || guard.path.trim() === '') {
      errors.push(`${path}.path: file_contains needs a path`)
    }
    if (typeof guard.text !== 'string' || guard.text === '') {
      errors.push(`${path}.text: file_contains needs non-empty text`)
    }
    return []
  }
  if (op === 'json_field') {
    if (typeof guard.field !== 'string' || guard.field.trim() === '') {
      errors.push(`${path}.field: json_field needs a field path such as answer or a.b[0]`)
    }
    const hasPath = typeof guard.path === 'string' && guard.path.trim() !== ''
    const hasReceipt = typeof guard.of === 'string' && guard.of !== ''
    if (hasPath === hasReceipt) {
      errors.push(`${path}: json_field needs exactly one of path (file) or of (receipt stdout)`)
    }
    if (typeof guard.exists !== 'boolean' && guard.eq === undefined && guard.ne === undefined) {
      errors.push(`${path}: json_field needs exists, eq or ne`)
    }
    return hasReceipt ? [guard.of] : []
  }
  if (typeof guard.of !== 'string') {
    errors.push(`${path}.of: guard needs a receipt id`)
    return []
  }
  if (op === 'exit_code' && typeof guard.eq !== 'number') {
    errors.push(`${path}.eq: exit_code needs a numeric eq`)
  }
  if ((op === 'stdout_contains' || op === 'stderr_contains') && typeof guard.text !== 'string') {
    errors.push(`${path}.text: ${op} needs text`)
  }
  return [guard.of]
}

/**
 * Compile a raw EDG document.
 * @param {{ nodes: unknown[] }} raw
 * @param {{ rootId?: string }} options rootId is the receipt id of the action
 *   the actor executed together with this graph; graph nodes may depend on it.
 */
export function compileGraph(raw, { rootId, priorIds = [] } = {}) {
  const errors = []
  // Receipts that already exist when the graph is authored. A node may depend
  // on them, and a guard may read them, because their evidence is observable.
  const known = new Set(priorIds)
  if (rootId) known.add(rootId)
  const nodes = []
  if (!raw || typeof raw !== 'object' || !Array.isArray(raw.nodes)) {
    return { ok: false, errors: ['graph must be an object with a nodes array'] }
  }
  const byId = new Map()
  for (const [index, node] of raw.nodes.entries()) {
    const path = `nodes[${index}]`
    if (!node || typeof node !== 'object') {
      errors.push(`${path}: node must be an object`)
      continue
    }
    if (typeof node.id !== 'string' || !ID_PATTERN.test(node.id)) {
      errors.push(`${path}.id: expected ${ID_PATTERN}`)
      continue
    }
    const id = node.id === rootId ? `${node.id}__shadowed` : node.id
    if (byId.has(id)) errors.push(`${path}.id: duplicate node id ${node.id}`)
    if (typeof node.action !== 'string' || node.action.trim() === '') {
      errors.push(`${path}.action: non-empty action name required`)
      continue
    }
    if (!node.args || typeof node.args !== 'object' || Array.isArray(node.args)) {
      errors.push(`${path}.args: object of literal arguments required`)
      continue
    }
    const literalProblems = literalViolations(node.args, `${path}.args`)
    errors.push(...literalProblems)
    if (node.after !== undefined && node.after !== null && typeof node.after !== 'string') {
      errors.push(`${path}.after: predecessor id or null required`)
    }
    if (node.timeoutMs !== undefined && (!Number.isFinite(node.timeoutMs) || node.timeoutMs <= 0)) {
      errors.push(`${path}.timeoutMs: positive number required`)
    }
    if (node.guard !== undefined && node.guard !== null) guardRefs(node.guard, `${path}.guard`, errors)
    const compiled = {
      id,
      action: node.action,
      args: node.args,
      after: node.after ?? null,
      guard: node.guard ?? null,
      priority: Number.isFinite(node.priority) ? node.priority : 0,
      // Per-node execution limits must survive compilation, or the executor
      // silently falls back to the global timeout.
      ...(Number.isFinite(node.timeoutMs) ? { timeoutMs: node.timeoutMs } : {}),
    }
    byId.set(id, compiled)
    nodes.push(compiled)
  }

  // Acyclic + reachable predecessor check.
  const color = new Map()
  const order = []
  const visit = (id, stack) => {
    const state = color.get(id)
    if (state === 'done') return
    if (state === 'open') {
      errors.push(`cycle: ${[...stack, id].join(' -> ')}`)
      return
    }
    color.set(id, 'open')
    const node = byId.get(id)
    const next = node?.after
    if (next && byId.has(next)) visit(next, [...stack, id])
    color.set(id, 'done')
    order.push(id)
  }
  for (const id of byId.keys()) visit(id, [])

  // Guard references may only name ancestors (or the root action), never a
  // sibling or a successor: a guard that reads the future is not evidence.
  const ancestorsOf = (id) => {
    const seen = new Set()
    let cursor = byId.get(id)?.after ?? null
    while (cursor && !seen.has(cursor)) {
      seen.add(cursor)
      cursor = byId.get(cursor)?.after ?? null
    }
    for (const id of known) seen.add(id)
    return seen
  }
  for (const node of nodes) {
    if (node.after && !byId.has(node.after) && !known.has(node.after)) {
      errors.push(`nodes.${node.id}.after: unknown predecessor ${node.after}`)
    }
    const refs = new Set()
    if (node.guard) guardRefs(node.guard, `nodes.${node.id}.guard`, errors).forEach((r) => refs.add(r))
    const ancestors = ancestorsOf(node.id)
    for (const ref of refs) {
      if (!ancestors.has(ref)) {
        errors.push(`nodes.${node.id}.guard: ${ref} is not a causal predecessor`)
      }
    }
  }

  if (errors.length > 0) return { ok: false, errors }
  const graph = { nodes, order, byId, rootId: rootId ?? null, priorIds: [...known] }
  return {
    ok: true,
    errors: [],
    graph: { ...graph, hash: hashValue({ nodes, rootId: rootId ?? null, priorIds: [...known].sort() }) },
  }
}

export function guardOps(guard, out = []) {
  if (!guard) return out
  if (Array.isArray(guard.of)) {
    for (const child of guard.of) guardOps(child, out)
    return out
  }
  if (guard.op === 'not') {
    guardOps(guard.of, out)
    return out
  }
  out.push(guard.op)
  return out
}