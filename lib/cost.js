/**
 * Token accounting. The estimator is deliberately explicit: this prototype has
 * no tokenizer, so cost is reported as characters/4 and labelled as an
 * estimate. Every number in the report comes from strings the runner actually
 * replayed or generated, never from a hand-written constant.
 */
export function estimateTokens(text) {
  if (!text) return 0
  return Math.ceil(String(text).length / 4)
}

export class CostLedger {
  constructor() {
    this.calls = 0
    this.inputTokens = 0
    this.outputTokens = 0
    this.selectorTokens = 0
    this.certificateBytes = 0
    this.byStep = []
  }

  recordActorCall({ input, output, step }) {
    const inputTokens = estimateTokens(input)
    const outputTokens = estimateTokens(output)
    this.calls += 1
    this.inputTokens += inputTokens
    this.outputTokens += outputTokens
    this.byStep.push({ step, inputTokens, outputTokens })
    return { inputTokens, outputTokens }
  }

  recordSelectorCall(tokens) {
    this.selectorTokens += tokens
  }

  recordCertificate(certificate) {
    this.certificateBytes += JSON.stringify(certificate).length
  }

  get totalTokens() {
    return this.inputTokens + this.outputTokens + this.selectorTokens
  }

  get authorshipTokens() {
    return this.byStep.reduce((sum, call) => sum + call.outputTokens, 0)
  }
}

/**
 * Break-even: how many substituted callbacks are needed before the extra
 * authorship cost of a graph is paid back. Returns null when a graph never
 * pays for itself (introduced >= removed).
 */
export function breakEven({ introducedTokens, removedPerCallbackTokens }) {
  if (removedPerCallbackTokens <= 0) return null
  return Math.ceil(introducedTokens / removedPerCallbackTokens)
}

export function summarize(arm, ledger, { tasks, successes, certificates, deferred, executed }) {
  return {
    arm,
    tasks,
    successes,
    successRate: tasks === 0 ? 0 : successes / tasks,
    actorCalls: ledger.calls,
    callsPerTask: tasks === 0 ? 0 : ledger.calls / tasks,
    inputTokens: ledger.inputTokens,
    outputTokens: ledger.outputTokens,
    selectorTokens: ledger.selectorTokens,
    totalTokens: ledger.totalTokens,
    tokensPerTask: tasks === 0 ? 0 : ledger.totalTokens / tasks,
    certificates: certificates,
    executedDecisions: executed,
    deferred,
  }
}