/**
 * Which entry path a chain call is taking.
 *
 * The tool accepts a plan in two forms; everything else — saving, naming,
 * looking one up, listing a library — was removed once its value failed to
 * justify the concept. A call that still asks for one of those fails loudly and
 * names the replacement, so an old habit does not read as a malformed plan.
 *
 * @param {object} args the arguments the caller passed
 * @returns {{kind: 'graph', args: object, form: 'linear'|'graph'}}
 * @throws when the arguments name no plan or ask for a removed entry path
 */
function removed(field) {
  return new Error(
    `${field} is gone: chains are no longer saved or looked up. State the plan in the call — { steps: [...] } or { graph: {...} }.`,
  )
}

export function resolveMode(args = {}) {
  if (args.save === true) throw removed('save')
  if (typeof args.solve === 'string') throw removed('solve')
  if (typeof args.name === 'string' && args.name !== '') throw removed('name')
  if (args.list === true) throw removed('list')
  if (args.steps !== undefined) return { kind: 'graph', args, form: 'linear' }
  if (args.graph) return { kind: 'graph', args, form: 'graph' }
  throw new Error('pass a plan: { steps: [...] } or { graph: {...} }')
}