import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { compileGraph } from './graph.js'
import { Controller, verifyCertificate } from './controller.js'

/**
 * Commands a chain may never run. `allowShell` is blanket consent, so the
 * executor refuses a small set of commands whose blast radius is never local.
 */
export const DENY_COMMANDS = [
  { re: /\b(sudo|doas)\b/, why: 'privilege escalation' },
  { re: /\brm\s+(-[A-Za-z]+\s+)*-[A-Za-z]*[rf][A-Za-z]*\s+\/(\s|$)/, why: 'recursive delete of /' },
  { re: /\bmkfs\b|\bdd\s+if=|\b(shutdown|reboot|halt)\b/, why: 'destructive system command' },
  { re: /\b(curl|wget)\b[^|]*\|\s*(sh|bash|zsh)\b/, why: 'piping a download into a shell' },
  { re: /:\s*\(\s*\)\s*\{/, why: 'fork bomb' },
  { re: /\bchmod\s+-R\s+777\s+\/(\s|$)/, why: 'world-writable root' },
  { re: />\s*\/dev\/sd/, why: 'raw disk write' },
]

export function checkCommand(cmd) {
  for (const rule of DENY_COMMANDS) {
    if (rule.re.test(cmd)) return rule.why
  }
  return null
}

const clamp = (value, fallback, min, max) =>
  Number.isFinite(value) ? Math.min(Math.max(value, min), max) : fallback

/**
 * Executes an authored decision graph inside a session working directory.
 * The model is not called between nodes: eligibility comes from receipts only.
 */
export async function runChain({
  raw,
  rootId,
  priorIds = [],
  cwd,
  execute,
  maxSteps = 20,
  selector = 'unique',
  priorReceipts = [],
  avgStepTokens = 400,
  avgStepMs = 11_000,
}) {
  const compiled = compileGraph(raw, { rootId, priorIds })
  if (!compiled.ok) {
    return {
      ok: false,
      stopReason: 'invalid-graph',
      detail: compiled.errors.join('; '),
      steps: [],
      pending: [],
      receipts: [],
      certificates: 0,
      verified: 0,
      graphHash: null,
      saved: { avoidedCalls: 0, estTokens: 0, estMs: 0 },
    }
  }
  const controller = new Controller({ graph: compiled.graph, selector })
  for (const receipt of priorReceipts) controller.observe(receipt)

  const steps = []
  const stop = (stopReason, detail) => {
    const pending = controller.pending().map((node) => node.id)
    const audits = controller.certificates.map((certificate) =>
      verifyCertificate(certificate, { graphHash: compiled.graph.hash, receipts: controller.receipts }),
    )
    const avoidedCalls = steps.length
    return {
      ok: stopReason === 'completed',
      stopReason,
      detail,
      steps,
      pending,
      receipts: [...controller.receipts.values()],
      certificates: controller.certificates.length,
      verified: audits.filter((audit) => audit.ok).length,
      graphHash: compiled.graph.hash,
      saved: {
        avoidedCalls,
        estTokens: avoidedCalls * avgStepTokens,
        estMs: avoidedCalls * avgStepMs,
      },
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
      result = await execute(node)
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
      stdout: receipt.stdout,
      stderr: receipt.stderr,
      ms: receipt.ms ?? 0,
    })
  }
  return stop('max-steps', `stopped after ${maxSteps} steps`)
}

/**
 * Direct executor. `write` stays inside cwd; `shell` runs in the Host process
 * and therefore is NOT protected by the bash tool's sandbox — the caller opts
 * in explicitly, and a short denylist still applies.
 */
export function makeExecutor({
  cwd,
  allowShell = false,
  timeoutMs = 120_000,
  maxOutput = 16_000,
}) {
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
      return {
        exitCode: 0,
        stdout: `wrote ${node.args.content.length} bytes to ${node.args.path}`,
        stderr: '',
        ms: Date.now() - started,
      }
    }
    if (node.action === 'shell') {
      if (!allowShell) {
        throw new Error('shell nodes need allowShell: true (commands run outside the bash sandbox)')
      }
      const reason = checkCommand(node.args.cmd)
      if (reason) {
        throw new Error(`refused command (${reason}): ${node.args.cmd}`)
      }
      const limit = clamp(Number(node.timeoutMs), timeoutMs, 100, 600_000)
      const result = spawnSync(node.args.cmd, {
        shell: true,
        cwd: root,
        timeout: limit,
        encoding: 'utf8',
        maxBuffer: 16 * 1024 * 1024,
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

const cell = (text, limit) => String(text ?? '').replace(/\s+/g, ' ').slice(0, limit).replace(/\|/g, '\\|')

export function renderChain(result) {
  const lines = []
  lines.push(
    result.ok
      ? `Chain completed: ${result.steps.length} step(s), 0 reasoning calls`
      : `Chain stopped at ${result.steps.length} step(s): ${result.stopReason}`,
  )
  if (result.detail && !result.ok) lines.push(`Reason: ${result.detail}`)
  if (result.steps.length > 0) {
    lines.push('')
    lines.push('| step | action | exit | output |')
    lines.push('| --- | --- | --- | --- |')
    for (const step of result.steps) {
      const output = cell(step.stdout || step.stderr, 120)
      lines.push(`| ${step.id} | ${step.action} | ${step.exitCode} | ${output} |`)
    }
  }
  if (!result.ok && result.steps.length > 0) {
    const last = result.steps[result.steps.length - 1]
    const body = [last.stdout, last.stderr].filter(Boolean).join('\n')
    if (body && body.trim() !== '') {
      lines.push('')
      lines.push(`### Full output of ${last.id} (exit ${last.exitCode})`)
      lines.push('```')
      lines.push(body.slice(-16_000))
      lines.push('```')
    }
  }
  if (!result.ok && result.receipts.length > 0) {
    const compact = result.receipts.map((receipt) => ({
      stepId: receipt.stepId,
      action: receipt.action,
      exitCode: receipt.exitCode,
      stdout: String(receipt.stdout ?? '').slice(-400),
      stderr: String(receipt.stderr ?? '').slice(-200),
    }))
    lines.push('')
    lines.push('### Receipts (pass back as `receipts` to resume)')
    lines.push('```json')
    lines.push(JSON.stringify(compact))
    lines.push('```')
  }
  lines.push('')
  lines.push(`Certificates: ${result.verified}/${result.certificates} verified against receipts`)
  if (result.pending.length > 0) lines.push(`Not executed: ${result.pending.join(', ')}`)
  if (result.saved?.avoidedCalls > 0) {
    lines.push(
      `Saved (estimate): ${result.saved.avoidedCalls} reasoning call(s), ~${result.saved.estTokens} tokens, ~${Math.round(result.saved.estMs / 100) / 10}s`,
    )
  }
  return lines.join('\n')
}

/** The native bash tool's value shape is not part of its contract: accept
 * strings, block arrays and {text|content} objects, and never lose output to
 * "[object Object]". */
function stringifyMaybe(value) {
  if (value == null) return ''
  if (typeof value === 'string') return value
  if (Array.isArray(value)) return value.map(stringifyMaybe).filter(Boolean).join('\n')
  if (typeof value === 'object') {
    if (typeof value.text === 'string') return value.text
    if (typeof value.content !== 'undefined') return stringifyMaybe(value.content)
    return JSON.stringify(value)
  }
  return String(value)
}

function parseSandboxResult(result, node) {
  if (!result || typeof result !== 'object') {
    throw new Error(`sandboxed dispatch returned nothing for ${node.id}`)
  }
  const text = (result.content ?? [])
    .map((block) => (typeof block?.text === 'string' ? block.text : ''))
    .join('\n')
  if (result.isError) {
    const message = result.error?.message ?? text.slice(-500) ?? 'dispatch failed'
    throw new Error(`sandboxed bash refused or failed: ${message}`)
  }
  const value = result.value
  if (value && typeof value === 'object' && Number.isFinite(value.exitCode)) {
    const stdout = stringifyMaybe(value.stdout ?? value.output) || text
    return {
      exitCode: value.exitCode,
      stdout: stdout.slice(-16_000),
      stderr: stringifyMaybe(value.stderr).slice(-16_000),
    }
  }
  const marker = /\[exit code:\s*(-?\d+)\]/.exec(text)
  if (marker) {
    return {
      exitCode: Number(marker[1]),
      stdout: text.replace(marker[0], '').trim(),
      stderr: '',
    }
  }
  throw new Error(`cannot determine an exit code from the sandboxed bash result for ${node.id} (fail closed)`)
}

/**
 * Sandboxed executor: shell nodes run through the harness's own bash tool, so
 * the file sandbox, permission policy and approval flow all apply. Slower than
 * direct execution and parsing depends on the bash tool's result shape, so an
 * unparsable result is an error, never an assumed success.
 * `write` nodes stay direct: they are contained to cwd by makeExecutor.
 */
export function makeSandboxExecutor({ dispatch, cwd, newCallId }) {
  const direct = makeExecutor({ cwd, allowShell: true })
  const callId = newCallId ?? (() => crypto.randomUUID())
  return async function execute(node) {
    if (node.action !== 'shell') return direct(node)
    const reason = checkCommand(node.args.cmd)
    if (reason) throw new Error(`refused command (${reason}): ${node.args.cmd}`)
    const started = Date.now()
    const result = await dispatch({
      callId: callId(),
      name: 'bash',
      arguments: {
        command: node.args.cmd,
        description: `harnessmm chain node ${node.id}`,
        workdir: cwd,
        ...(Number.isFinite(node.timeoutMs) ? { timeoutMs: node.timeoutMs } : {}),
      },
    })
    const parsed = parseSandboxResult(result, node)
    return { ...parsed, ms: Date.now() - started }
  }
}
