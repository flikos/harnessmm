import fs from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { compileGraph } from './graph.js'
import { Controller, verifyCertificate } from './controller.js'

/**
 * Executes an authored decision graph inside a session working directory.
 * The model is not called between nodes: eligibility comes from receipts only.
 */
export function runChain({
  raw,
  rootId,
  priorIds = [],
  cwd,
  execute,
  maxSteps = 20,
  selector = 'unique',
  priorReceipts = [],
}) {
  const compiled = compileGraph(raw, { rootId, priorIds })
  if (!compiled.ok) {
    return { ok: false, stopReason: 'invalid-graph', detail: compiled.errors.join('; '), steps: [], pending: [], certificates: 0, verified: 0, graphHash: null }
  }
  const controller = new Controller({ graph: compiled.graph, selector })
  for (const receipt of priorReceipts) controller.observe(receipt)

  const steps = []
  const stop = (stopReason, detail) => {
    const pending = controller.pending().map((node) => node.id)
    const audits = controller.certificates.map((certificate) =>
      verifyCertificate(certificate, { graphHash: compiled.graph.hash, receipts: controller.receipts }),
    )
    return {
      ok: stopReason === 'completed',
      stopReason,
      detail,
      steps,
      pending,
      certificates: controller.certificates.length,
      verified: audits.filter((audit) => audit.ok).length,
      graphHash: compiled.graph.hash,
    }
  }

  for (let index = 0; index < maxSteps; index += 1) {
    if (controller.pending().length === 0) {
      return stop('completed', 'all nodes executed')
    }
    const decision = controller.decide({ receipts: controller.receipts, cwd })
    if (decision.kind !== 'execute') {
      return stop('deferred', decision.reason)
    }
    const node = decision.node
    let result
    try {
      result = execute(node)
    } catch (error) {
      return stop('error', `step ${node.id}: ${error.message}`)
    }
    const receipt = { stepId: node.id, action: node.action, args: node.args, ...result }
    controller.observe(receipt)
    controller.certify(node, receipt, { bypassedCallbackId: `llm-callback:chain:${node.id}` })
    steps.push({
      id: node.id,
      action: node.action,
      args: node.args,
      exitCode: receipt.exitCode,
      stdout: String(receipt.stdout ?? '').slice(-1200),
      stderr: String(receipt.stderr ?? '').slice(-600),
      ms: receipt.ms ?? 0,
    })
  }
  return stop('max-steps', `stopped after ${maxSteps} steps`)
}

/**
 * Direct executor. `write` stays inside cwd; `shell` runs in the Host process
 * and therefore is NOT protected by the bash tool's sandbox — the caller must
 * opt in explicitly.
 */
export function makeExecutor({ cwd, allowShell = false, timeoutMs = 120_000, maxOutput = 4000 }) {
  const root = path.resolve(cwd)
  return function execute(node) {
    const started = Date.now()
    if (node.action === 'write') {
      const target = path.resolve(root, node.args.path)
      if (target !== root && !target.startsWith(`${root}${path.sep}`)) {
        throw new Error(`write escapes the working directory: ${node.args.path}`)
      }
      fs.mkdirSync(path.dirname(target), { recursive: true })
      fs.writeFileSync(target, node.args.content)
      return { exitCode: 0, stdout: `wrote ${node.args.content.length} bytes to ${node.args.path}`, stderr: '', ms: Date.now() - started }
    }
    if (node.action === 'shell') {
      if (!allowShell) {
        throw new Error('shell nodes need allowShell: true (commands run outside the bash sandbox)')
      }
      const result = spawnSync(node.args.cmd, {
        shell: true,
        cwd: root,
        timeout: timeoutMs,
        encoding: 'utf8',
        maxBuffer: 8 * 1024 * 1024,
      })
      return {
        exitCode: typeof result.status === 'number' ? result.status : 1,
        stdout: String(result.stdout ?? '').slice(-maxOutput),
        stderr: String(result.stderr ?? '').slice(-maxOutput),
        ms: Date.now() - started,
      }
    }
    throw new Error(`unsupported action ${node.action}`)
  }
}

export function renderChain(result) {
  const lines = []
  const head = result.ok
    ? `Chain completed: ${result.steps.length} step(s), 0 reasoning calls`
    : `Chain stopped at ${result.steps.length} step(s): ${result.stopReason}`
  lines.push(head)
  if (result.detail && !result.ok) lines.push(`Reason: ${result.detail}`)
  if (result.steps.length > 0) {
    lines.push('')
    lines.push('| step | action | exit | output |')
    lines.push('| --- | --- | --- | --- |')
    for (const step of result.steps) {
      const output = (step.stdout || step.stderr || '').replace(/\s+/g, ' ').slice(0, 120)
      lines.push(`| ${step.id} | ${step.action} | ${step.exitCode} | ${output.replace(/\|/g, '\\|')} |`)
    }
  }
  lines.push('')
  lines.push(`Certificates: ${result.verified}/${result.certificates} verified against receipts`)
  if (result.pending.length > 0) lines.push(`Not executed: ${result.pending.join(', ')}`)
  return lines.join('\n')
}