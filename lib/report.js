import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { TASKS } from './tasks.js'
import { runTask } from './runner.js'

export const ARMS = ['baseline', 'harness']

function aggregate(arm, runs) {
  const totals = runs.reduce(
    (acc, run) => {
      acc.calls += run.ledger.calls
      acc.input += run.ledger.inputTokens
      acc.output += run.ledger.outputTokens
      acc.selector += run.ledger.selectorTokens
      acc.tokens += run.ledger.totalTokens
      acc.executed += run.executedDecisions
      acc.deferred += run.deferred
      acc.certificates += run.certificates
      acc.authored += run.authoredGraphTokens
      acc.successes += run.success ? 1 : 0
      return acc
    },
    {
      calls: 0,
      input: 0,
      output: 0,
      selector: 0,
      tokens: 0,
      executed: 0,
      deferred: 0,
      certificates: 0,
      authored: 0,
      successes: 0,
    },
  )
  return {
    arm,
    tasks: runs.length,
    successes: totals.successes,
    successRate: runs.length ? totals.successes / runs.length : 0,
    actorCalls: totals.calls,
    inputTokens: totals.input,
    outputTokens: totals.output,
    selectorTokens: totals.selector,
    totalTokens: totals.tokens,
    tokensPerTask: runs.length ? totals.tokens / runs.length : 0,
    callsPerTask: runs.length ? totals.calls / runs.length : 0,
    executedDecisions: totals.executed,
    deferred: totals.deferred,
    certificates: totals.certificates,
    authoredGraphTokens: totals.authored,
  }
}

/**
 * Compare the two arms on the same task set and the same tool chain.
 * Everything below is measured: the token counts come from the prompt strings
 * and decisions the runner actually produced.
 */
export function runBenchmark({ taskIds, selector = 'unique', python = 'python3', root, clean = true } = {}) {
  const tasks = taskIds?.length ? TASKS.filter((task) => taskIds.includes(task.id)) : TASKS
  if (tasks.length === 0) throw new Error('no matching tasks')
  const baseDir = root ?? fs.mkdtempSync(path.join(os.tmpdir(), 'harnessmm-'))
  const runs = []
  for (const task of tasks) {
    for (const arm of ARMS) {
      const workdir = path.join(baseDir, task.id, arm)
      if (clean) fs.rmSync(workdir, { recursive: true, force: true })
      runs.push(runTask({ task, arm, workdir, python, selector }))
    }
  }
  const baseline = aggregate('baseline', runs.filter((run) => run.arm === 'baseline'))
  const harness = aggregate('harness', runs.filter((run) => run.arm === 'harness'))
  const skipped = baseline.actorCalls - harness.actorCalls
  const avgCallbackTokens = baseline.actorCalls ? baseline.totalTokens / baseline.actorCalls : 0
  const removedTokens = baseline.totalTokens - harness.totalTokens
  return {
    selector,
    python,
    baseDir,
    runs,
    summary: {
      baseline,
      harness,
      skippedCallbacks: skipped,
      removedTokens,
      savingRatio: baseline.totalTokens ? removedTokens / baseline.totalTokens : 0,
      authoredGraphTokens: harness.authoredGraphTokens,
      avgCallbackTokens,
      breakEvenCallbacks:
        avgCallbackTokens > 0 ? Math.ceil(harness.authoredGraphTokens / avgCallbackTokens) : null,
      qualityDelta: harness.successRate - baseline.successRate,
      certificatesVerified: runs
        .flatMap((run) => run.certificateAudit)
        .filter((audit) => audit.ok).length,
      certificatesTotal: runs.reduce((sum, run) => sum + run.certificates, 0),
      rejectedGraphs: runs.reduce((sum, run) => sum + run.diagnostics.length, 0),
    },
  }
}

const pct = (value) => `${(value * 100).toFixed(2)}%`

export function renderMarkdown(result) {
  const { summary } = result
  const lines = []
  lines.push('# HarnessMM prototype — measured accounting')
  lines.push('')
  lines.push(
    'Same task set, same tool chain, same replay actor. Only the decision boundary differs.',
  )
  lines.push('')
  lines.push('| task | arm | calls | tokens | success | graph authored | nodes executed | deferred |')
  lines.push('| --- | --- | --- | --- | --- | --- | --- | --- |')
  for (const run of result.runs) {
    lines.push(
      `| ${run.task} | ${run.arm} | ${run.ledger.calls} | ${run.ledger.totalTokens} | ${run.success ? 'yes' : 'no'} | ${run.authoredGraphTokens} | ${run.executedDecisions} | ${run.deferred} |`,
    )
  }
  lines.push('')
  lines.push('## Aggregate')
  lines.push('')
  lines.push('| metric | baseline | harness |')
  lines.push('| --- | --- | --- |')
  lines.push(`| success rate | ${pct(summary.baseline.successRate)} | ${pct(summary.harness.successRate)} |`)
  lines.push(`| reasoning calls | ${summary.baseline.actorCalls} | ${summary.harness.actorCalls} |`)
  lines.push(`| calls per task | ${summary.baseline.callsPerTask.toFixed(2)} | ${summary.harness.callsPerTask.toFixed(2)} |`)
  lines.push(`| input tokens (est) | ${summary.baseline.inputTokens} | ${summary.harness.inputTokens} |`)
  lines.push(`| output tokens (est) | ${summary.baseline.outputTokens} | ${summary.harness.outputTokens} |`)
  lines.push(`| total tokens (est) | ${summary.baseline.totalTokens} | ${summary.harness.totalTokens} |`)
  lines.push(`| tokens per task | ${summary.baseline.tokensPerTask.toFixed(1)} | ${summary.harness.tokensPerTask.toFixed(1)} |`)
  lines.push('')
  lines.push('## Substitution economics')
  lines.push('')
  lines.push(`- callbacks avoided: **${summary.skippedCallbacks}**`)
  lines.push(
    `- tokens removed: **${summary.removedTokens}** (${pct(summary.savingRatio)} of baseline)`,
  )
  lines.push(`- graph authorship overhead: **${summary.authoredGraphTokens}** tokens`)
  lines.push(`- average baseline callback: **${summary.avgCallbackTokens.toFixed(1)}** tokens`)
  lines.push(
    `- break-even: a compiled graph pays for itself after **${summary.breakEvenCallbacks}** substituted callbacks`,
  )
  lines.push(
    `- certificates: **${summary.certificatesTotal}** issued, **${summary.certificatesVerified}** verified by replay`,
  )
  lines.push(`- graphs rejected by literal/dependency checks: **${summary.rejectedGraphs}**`)
  lines.push('')
  lines.push(
    'Token counts are character/4 estimates over the exact replayed prompt and emitted decision, not a tokenizer.',
  )
  return lines.join('\n')
}

export function writeReport(result, outDir) {
  fs.mkdirSync(outDir, { recursive: true })
  const markdown = renderMarkdown(result)
  fs.writeFileSync(path.join(outDir, 'report.md'), `${markdown}\n`)
  const serializable = {
    selector: result.selector,
    summary: result.summary,
    runs: result.runs.map((run) => ({
      task: run.task,
      arm: run.arm,
      success: run.success,
      calls: run.ledger.calls,
      inputTokens: run.ledger.inputTokens,
      outputTokens: run.ledger.outputTokens,
      totalTokens: run.ledger.totalTokens,
      authoredGraphTokens: run.authoredGraphTokens,
      executedDecisions: run.executedDecisions,
      deferred: run.deferred,
      certificates: run.certificates,
      diagnostics: run.diagnostics,
    })),
  }
  fs.writeFileSync(path.join(outDir, 'results.json'), `${JSON.stringify(serializable, null, 2)}\n`)
  return { markdown, files: [path.join(outDir, 'report.md'), path.join(outDir, 'results.json')] }
}