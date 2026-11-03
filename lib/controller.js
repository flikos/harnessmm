import { evaluateGuard, GuardError, describeGuard } from './guards.js'
import { hashValue } from './graph.js'

/**
 * The controller sits at the model-tool boundary. It never authors decisions,
 * never rewrites arguments and never executes a node whose guard cannot be
 * proven from an observed receipt.
 */
export class Controller {
  /**
   * @param {{ graph: import('./graph.js').compileGraph extends never ? never : any, selector?: 'unique'|'priority'|'abstain' }} options
   */
  constructor({ graph, selector = 'unique' }) {
    this.graph = graph
    this.selector = selector
    this.receipts = new Map()
    this.completed = new Set()
    this.certificates = []
    this.decisions = []
    this.rejected = []
  }

  observe(receipt) {
    this.receipts.set(receipt.stepId, receipt)
    this.completed.add(receipt.stepId)
    return this
  }

  ancestrySatisfied(node) {
    if (!node.after) return true
    return this.completed.has(node.after)
  }

  /** Nodes whose predecessor completed and whose guard is proven true. */
  eligible(env) {
    const out = []
    for (const node of this.graph.nodes) {
      if (this.completed.has(node.id)) continue
      if (!this.ancestrySatisfied(node)) continue
      let ok = false
      try {
        ok = evaluateGuard(node.guard, { ...env, receipts: this.receipts })
      } catch (error) {
        if (!(error instanceof GuardError)) throw error
        this.rejected.push({ node: node.id, reason: error.message })
        continue
      }
      if (ok) out.push(node)
    }
    return out.sort((a, b) => b.priority - a.priority || a.id.localeCompare(b.id))
  }

  /**
   * @returns {{kind:'execute', node: object} |
   *           {kind:'defer', reason: string, eligible: string[]}}
   */
  decide(env) {
    const eligible = this.eligible(env)
    const ids = eligible.map((node) => node.id)
    if (eligible.length === 0) {
      return { kind: 'defer', reason: 'no eligible decision', eligible: ids }
    }
    if (eligible.length === 1) {
      this.decisions.push({ kind: 'execute', node: eligible[0].id })
      return { kind: 'execute', node: eligible[0] }
    }
    if (this.selector === 'priority') {
      const top = eligible[0]
      const tied = eligible.filter((node) => node.priority === top.priority)
      if (tied.length === 1) {
        this.decisions.push({ kind: 'execute', node: top.id, selector: 'priority' })
        return { kind: 'execute', node: top, selectorCost: true }
      }
    }
    // Several resolved decisions compete and the selector cannot pick one
    // without a semantic judgement: abstain and pay for the reasoning call.
    this.decisions.push({ kind: 'abstain', eligible: ids })
    return { kind: 'defer', reason: 'selector abstained (ambiguous eligible set)', eligible: ids }
  }

  /** Bind an executed decision to the callback it replaced. */
  certify(node, receipt, { bypassedCallbackId }) {
    const predecessor = node.after ? this.receipts.get(node.after) : null
    const certificate = {
      graph_hash: this.graph.hash,
      decision_id: node.id,
      predecessor_receipt: node.after
        ? { step: node.after, hash: hashValue(predecessor ?? null) }
        : null,
      exact_args: node.args,
      guard: describeGuard(node.guard),
      tool_receipt: { step: receipt.stepId, hash: hashValue(receipt), exitCode: receipt.exitCode },
      bypassed_callback_id: bypassedCallbackId,
      issued_at: new Date().toISOString(),
    }
    this.certificates.push(certificate)
    return certificate
  }

  pending() {
    return this.graph.nodes.filter((node) => !this.completed.has(node.id))
  }
}

/** Recompute a certificate from the recorded state and compare it field by field. */
export function verifyCertificate(certificate, { graphHash, receipts }) {
  const problems = []
  if (certificate.graph_hash !== graphHash) problems.push('graph hash mismatch')
  const predecessor = certificate.predecessor_receipt
  if (predecessor) {
    const receipt = receipts.get(predecessor.step)
    if (!receipt) problems.push(`missing predecessor receipt ${predecessor.step}`)
    else if (hashValue(receipt) !== predecessor.hash) problems.push('predecessor receipt changed')
  }
  const toolReceipt = receipts.get(certificate.tool_receipt.step)
  if (!toolReceipt) problems.push(`missing tool receipt ${certificate.tool_receipt.step}`)
  else if (hashValue(toolReceipt) !== certificate.tool_receipt.hash) problems.push('tool receipt changed')
  if (!certificate.bypassed_callback_id) problems.push('no bypassed callback recorded')
  return { ok: problems.length === 0, problems }
}