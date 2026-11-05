import { compileGraph, guardFieldNeeds } from './graph.js'

/**
 * The linear plan: the form a model writes for everyday work.
 *
 * A graph is precise but expensive to author — identifiers, predecessors and
 * declared receipt fields have to stay consistent by hand. Most real sequences
 * are a straight line, so they get a form that says exactly that: this step,
 * this expectation, then the next.
 *
 * Both forms compile to the same plan, so a guard means the same thing whether
 * it arrived in a list or a graph. Nothing here weakens validation: a linear
 * plan is translated and then handed to the same compiler as any other.
 */

/** Receipt fields a guard reads, so the linear form can declare them for you. */
function fieldsFor(guard) {
  return [...guardFieldNeeds(guard)]
}

/**
 * Compile a plan given either as `{steps: [...]}` (linear) or `{nodes: [...]}`
 * (graph).
 *
 * @param {object} raw
 * @returns {ReturnType<typeof compileGraph>}
 */
export function compilePlan(raw, options = {}) {
  if (raw && typeof raw === 'object' && Array.isArray(raw.steps)) {
    const errors = []
    const steps = raw.steps
    if (steps.length === 0) errors.push('steps: a plan needs at least one step')
    const nodes = []
    for (const [index, step] of steps.entries()) {
      const path = `steps[${index}]`
      if (!step || typeof step !== 'object') {
        errors.push(`${path}: step must be an object`)
        continue
      }
      const id = step.id ?? `s${index + 1}`
      const previousId = index === 0 ? null : (steps[index - 1]?.id ?? `s${index}`)
      if (index === 0 && step.after !== undefined && step.after !== null) {
        errors.push(`${path}.after: the first step has no predecessor`)
        continue
      }
      if (index > 0 && step.after !== undefined && step.after !== null && step.after !== previousId) {
        errors.push(`${path}.after: must name the step before it (${previousId}), not ${step.after}`)
        continue
      }
      // A list is ordered; the predecessor is the step above, so the only
      // thing `after` may do is disagree with that.
      const after = index === 0 ? null : previousId
      if (!step.run || typeof step.run !== 'object') {
        errors.push(`${path}.run: an object of literal arguments is required`)
        continue
      }
      // A guard always reads a receipt; in the linear form the only sensible
      // one is the step before it, so the author does not repeat it.
      const expect = step.expect ?? null
      const guard =
        expect?.op && expect.of === undefined && after !== null
          ? { ...expect, of: after }
          : expect
      nodes.push({
        id,
        action: step.action ?? 'shell',
        args: step.run,
        ...(after === null ? {} : { after }),
        guard,
        // A guard reads fields it must have declared; the linear form declares
        // exactly what the guard needs, so the author is not asked to restate
        // what is already implied. The graph form may declare the same set
        // explicitly, and the two then hash identically.
        ...(Array.isArray(step.required_receipt_fields) || guard?.op
          ? { required_receipt_fields: step.required_receipt_fields ?? fieldsFor(guard) }
          : {}),
        ...(step.timeoutMs === undefined ? {} : { timeoutMs: step.timeoutMs }),
      })
    }
    if (errors.length > 0) {
      return { ok: false, errors, graph: null }
    }
    return compileGraph({ nodes }, options)
  }
  return compileGraph(raw, options)
}