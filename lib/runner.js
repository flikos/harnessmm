import fs from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { compileGraph, hashValue } from './graph.js'
import { Controller, verifyCertificate } from './controller.js'
import { CostLedger, estimateTokens } from './cost.js'
import { createScriptedActor } from './actor.js'

export const SYSTEM_PROMPT =
  'You are a coding agent. Decide the next tool action. Reply with JSON only. ' +
  'When you can also fix the next steps, include an executable decision graph.'

function renderPrompt(task, entries) {
  const transcript = entries.join('\n')
  return `${SYSTEM_PROMPT}\n\nTASK: ${task.prompt}\n\n${transcript}`
}

function runTool(action, { cwd, timeoutMs }) {
  const started = Date.now()
  if (action.name === 'write') {
    const target = path.resolve(cwd, action.args.path)
    if (!target.startsWith(path.resolve(cwd))) throw new Error('write escapes the task directory')
    fs.mkdirSync(path.dirname(target), { recursive: true })
    fs.writeFileSync(target, action.args.content)
    return {
      exitCode: 0,
      stdout: `wrote ${action.args.content.length} bytes to ${action.args.path}`,
      stderr: '',
      ms: Date.now() - started,
    }
  }
  if (action.name === 'shell') {
    const result = spawnSync(action.args.cmd, {
      shell: true,
      cwd,
      timeout: timeoutMs,
      encoding: 'utf8',
      env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1' },
    })
    return {
      exitCode: typeof result.status === 'number' ? result.status : 1,
      stdout: String(result.stdout ?? '').slice(-2000),
      stderr: String(result.stderr ?? '').slice(-2000),
      ms: Date.now() - started,
    }
  }
  throw new Error(`unsupported action ${action.name}`)
}

/**
 * Run one task in one arm.
 * arm: 'baseline' performs every reasoning callback; 'harness' lets the
 * controller substitute certified callbacks for resolved decisions.
 */
export function runTask({ task, arm, workdir, python = 'python3', selector = 'unique', maxSteps = 24 }) {
  fs.mkdirSync(workdir, { recursive: true })
  fs.writeFileSync(path.join(workdir, 'check.py'), task.check)
  const actor = createScriptedActor({ python })
  const ledger = new CostLedger()
  const entries = []
  const receipts = []
  let controller = null
  let step = 0
  let final = false
  let testsOk = false
  let certificates = 0
  let executedDecisions = 0
  let deferred = 0
  let selectorCalls = 0
  let authoredGraphTokens = 0
  const issued = []
  const diagnostics = []

  while (step < maxSteps && !final) {
    step += 1
    const stepId = `s${step}`
    const env = { receipts: new Map(receipts.map((r) => [r.stepId, r])), cwd: workdir }

    let node = null
    if (arm === 'harness' && controller) {
      const decision = controller.decide(env)
      if (decision.kind === 'execute') node = decision.node
      else {
        deferred += 1
        if (String(decision.reason).includes('abstained')) selectorCalls += 1
      }
    }

    if (node) {
      const result = runTool({ name: node.action, args: node.args }, { cwd: workdir, timeoutMs: 60_000 })
      const receipt = { stepId: node.id, action: node.action, args: node.args, ...result }
      receipts.push(receipt)
      controller.observe(receipt)
      const certificate = controller.certify(node, receipt, {
        bypassedCallbackId: `llm-callback:${arm}:${step}`,
      })
      ledger.recordCertificate(certificate)
      issued.push({ certificate, graph: controller.graph })
      certificates += 1
      executedDecisions += 1
      if (String(node.args.cmd ?? '').includes('check.py') && receipt.exitCode === 0) testsOk = true
      entries.push(
        `[${receipt.stepId}] ${node.action} ${JSON.stringify(node.args).slice(0, 160)}\nexit=${receipt.exitCode}\nstdout=${String(receipt.stdout).slice(-280)}`,
      )
      continue
    }

    const input = renderPrompt(task, entries)
    const decision = actor.decide({
      task,
      receipts,
      nextId: stepId,
      includeGraph: arm === 'harness',
    })
    const output = JSON.stringify(decision)
    ledger.recordActorCall({ input, output, step: stepId })
    if (arm === 'harness' && decision.graph) {
      authoredGraphTokens += estimateTokens(output) - estimateTokens(JSON.stringify({ action: decision.action }))
      const compiled = compileGraph(decision.graph, {
        rootId: stepId,
        priorIds: receipts.map((r) => r.stepId),
      })
      if (!compiled.ok) {
        diagnostics.push({ step: stepId, kind: 'graph-rejected', errors: compiled.errors })
      } else {
        const next = new Controller({ graph: compiled.graph, selector })
        for (const receipt of receipts) next.observe(receipt)
        controller = next
      }
    }
    if (decision.action.name === 'answer') {
      final = true
      entries.push(`[${stepId}] answer ${JSON.stringify(decision.action.args)}`)
      break
    }
    const result = runTool(decision.action, { cwd: workdir, timeoutMs: 60_000 })
    const receipt = { stepId, action: decision.action.name, args: decision.action.args, ...result }
    receipts.push(receipt)
    if (controller) controller.observe(receipt)
    if (String(decision.action.args.cmd ?? '').includes('check.py') && receipt.exitCode === 0) testsOk = true
    entries.push(
      `[${stepId}] ${decision.action.name} ${JSON.stringify(decision.action.args).slice(0, 160)}\nexit=${receipt.exitCode}\nstdout=${String(receipt.stdout).slice(-280)}`,
    )
  }

  const receiptMap = new Map(receipts.map((r) => [r.stepId, r]))
  const certificateAudit = issued.map(({ certificate, graph }) =>
    verifyCertificate(certificate, { graphHash: graph.hash, receipts: receiptMap }),
  )

  return {
    task: task.id,
    arm,
    success: final && testsOk,
    steps: step,
    receipts,
    ledger,
    certificates,
    certificateAudit,
    executedDecisions,
    deferred,
    selectorCalls,
    authoredGraphTokens,
    diagnostics,
    transcriptBytes: entries.reduce((sum, entry) => sum + entry.length, 0),
    workdirHash: hashValue(receipts.map((r) => [r.stepId, r.exitCode])),
  }
}