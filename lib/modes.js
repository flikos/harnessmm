/**
 * Which entry path a chain call is taking.
 *
 * The tool accepts several shapes of request — run a plan, store one, list the
 * stored ones, look one up — and each branch needs different handling. Deciding
 * that in one place, as data, keeps the tool definition free of conditionals and
 * lets a branch be removed as one unit rather than untangled from the rest.
 *
 * @param {object} args the arguments the caller passed
 * @returns {{kind: 'graph'|'list'|'save'|'solve'|'named', args: object, name?: string}}
 * @throws when the arguments name no entry path at all
 */
export function resolveMode(args = {}) {
  if (args.list === true) return { kind: 'list', args }
  if (args.save === true) {
    if (typeof args.name !== 'string' || args.name === '') {
      throw new Error('save needs a name')
    }
    if (!args.graph && args.steps === undefined) throw new Error('save needs a graph')
    return { kind: 'save', args, name: args.name }
  }
  if (args.steps !== undefined) return { kind: 'graph', args, form: 'linear' }
  if (args.graph) return { kind: 'graph', args, form: 'graph' }
  if (typeof args.solve === 'string') return { kind: 'solve', args }
  if (typeof args.name === 'string' && args.name !== '') return { kind: 'named', args, name: args.name }
  throw new Error('pass a graph, a saved name, solve, or list: true')
}