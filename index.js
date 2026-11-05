import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { compileGraph } from './lib/graph.js'
import { TASKS } from './lib/tasks.js'
import { runBenchmark, renderMarkdown, writeReport } from './lib/report.js'
import { logUsage } from './lib/usage.js'
import { runChain, makeExecutor, makeSandboxExecutor, renderChain } from './lib/chain.js'
import { saveGraph, loadGraph, listGraphs, isValidName } from './lib/library.js'
import { summarizeUsage } from './lib/usage.js'
import {
  commitSubstitution,
  createSubstitutionState,
  decideSubstitution,
  decisionsFile,
  readDecisions,
  synthesizedChunks,
} from './lib/substitution.js'

/**
 * HarnessMM Lab: three tools.
 *  - harnessmm_validate checks an Executable Decision Graph against literal
 *    closure and causal-dependency rules before anyone trusts it.
 *  - harnessmm_bench runs the same task set through the baseline and the
 *    guarded-reuse arm and returns measured token accounting.
 *  - harnessmm_chain executes a saved or inline graph and reports receipts.
 * The tools never touch this session's model loop; boundary substitution rides
 * on the `llm/stream` waterfall and is wired only when a profile enables it
 * (`wireSubstitution`). See docs/quickstart.md for the opt-in and its measured
 * effect.
 */
export const inject = ['tools']

const text = (value) => [{ type: 'text', text: value }]

/**
 * Short, stable caller id. A ledger without it cannot answer the question it
 * exists for: a maintainer's own smoke test reads exactly like real work.
 *
 * Session ids are branded `session-<uuid>`: keeping the prefix would spend the
 * whole budget on `session-` and make every caller look identical. The profile
 * is deliberately not recorded — the Host inherits ambient environment, so a run
 * inside one profile can report another profile's name, and a lying field is
 * worse than an absent one.
 */
function shortSession(value) {
  if (value === null || value === undefined) return null
  const text = String(value).replace(/^session-/, '')
  return text === '' ? null : text.slice(0, 8)
}

function attribution(exec) {
  return { session: shortSession(exec?.agent?.session?.id ?? null) }
}

function parseGraph(input) {
  if (input && typeof input === 'object') return input
  if (typeof input === 'string') return JSON.parse(input)
  throw new Error('graph must be a JSON object or a JSON string')
}

const validateTool = {
  name: 'harnessmm_validate',
  description:
    'Validate an Executable Decision Graph (EDG) before trusting it: literal argument closure, acyclic dependencies, guard operators and causal guard references. Returns ok plus exact errors.',
  parameters: {
    type: 'object',
    properties: {
      graph: {
        description: 'EDG document: {"nodes":[{"id","action","args","after","guard"}]}',
        type: ['object', 'string'],
      },
      rootId: {
        description: 'Receipt id of the action the actor executed together with this graph.',
        type: 'string',
      },
      priorIds: {
        description: 'Receipt ids that already exist when the graph is authored.',
        type: 'array',
        items: { type: 'string' },
      },
    },
    required: ['graph'],
    additionalProperties: false,
  },
  output: {
    schema: {
      type: 'object',
      properties: {
        ok: { type: 'boolean' },
        errors: { type: 'array', items: { type: 'string' } },
        nodes: { type: 'number' },
        hash: { type: 'string' },
      },
      required: ['ok'],
    },
    render: (_args, value) => text(
      value.ok
        ? `EDG accepted: ${value.nodes} node(s), hash ${String(value.hash).slice(0, 12)}…`
        : `EDG rejected by ${value.errors.length} check(s):\n- ${value.errors.join('\n- ')}`,
    ),
  },
  async execute(args, exec) {
    const compiled = compileGraph(parseGraph(args.graph), {
      rootId: args.rootId,
      priorIds: args.priorIds ?? [],
    })
    const value = compiled.ok
      ? { ok: true, errors: [], nodes: compiled.graph.nodes.length, hash: compiled.graph.hash }
      : { ok: false, errors: compiled.errors, nodes: 0, hash: '' }
    logUsage({ tool: 'harnessmm_validate', ...attribution(exec), ok: value.ok, nodes: value.nodes, errors: value.errors })
    return value
  },
}

const benchTool = {
  name: 'harnessmm_bench',
  description:
    'Run the HarnessMM benchmark: the same coding tasks through a baseline (a reasoning call after every tool result) and a guarded-reuse arm (resolved decisions execute on receipt evidence). Reports calls, estimated tokens, certificates and break-even.',
  parameters: {
    type: 'object',
    properties: {
      tasks: {
        description: 'Task ids to run. Omit for the full set.',
        type: 'array',
        items: { type: 'string' },
      },
      selector: {
        description: 'Selector policy when several decisions are eligible.',
        type: 'string',
        enum: ['unique', 'priority', 'abstain'],
      },
    },
    additionalProperties: false,
  },
  output: {
    schema: {
      type: 'object',
      properties: {
        reportPath: { type: 'string' },
        markdown: { type: 'string' },
        skippedCallbacks: { type: 'number' },
        savingRatio: { type: 'number' },
      },
      required: ['reportPath', 'markdown'],
    },
    render: (_args, value) => text(value.markdown),
  },
  async execute(args, exec) {
    const taskIds = args.tasks ?? []
    const unknown = taskIds.filter((id) => !TASKS.some((task) => task.id === id))
    if (unknown.length > 0) throw new Error(`unknown task ids: ${unknown.join(', ')}`)
    const result = runBenchmark({ taskIds: taskIds.length ? taskIds : undefined, selector: args.selector ?? 'unique' })
    const outDir = path.join(os.tmpdir(), 'harnessmm-out')
    const { markdown } = writeReport(result, outDir)
    // Keep a copy beside the installed package when that path is writable.
    try {
      const localOut = path.join(path.dirname(new URL(import.meta.url).pathname), 'out')
      fs.mkdirSync(localOut, { recursive: true })
      fs.writeFileSync(path.join(localOut, 'report.md'), `${markdown}\n`)
    } catch {
      // Read-only installation: the tmp copy is enough.
    }
    logUsage({
      tool: 'harnessmm_bench',
      ...attribution(exec),
      tasks: taskIds.length ? taskIds : TASKS.map((task) => task.id),
      selector: result.selector,
      calls: result.summary.harness.actorCalls,
      tokens: result.summary.harness.totalTokens,
      skippedCallbacks: result.summary.skippedCallbacks,
      savingRatio: Number(result.summary.savingRatio.toFixed(4)),
      certificatesVerified: result.summary.certificatesVerified,
    })
    return {
      reportPath: path.join(outDir, 'report.md'),
      markdown: `${markdown}\n\nReport: ${path.join(outDir, 'report.md')}`,
      skippedCallbacks: result.summary.skippedCallbacks,
      savingRatio: result.summary.savingRatio,
    }
  },
}

async function resolveCwd(ctx, exec, explicit) {
  if (explicit) return path.resolve(explicit)
  const service = typeof ctx.get === 'function' ? ctx.get('workingDirectory') : undefined
  if (service && exec.agent) return service.ensure(exec.agent, exec.signal)
  throw new Error('cannot resolve the session directory; pass cwd explicitly')
}

function renderList() {
  const graphs = listGraphs()
  const usage = summarizeUsage()
  const lines = ['# HarnessMM state', '']
  if (graphs.length === 0) {
    lines.push('No saved graphs. Author one and pass `save: true` with a `name`.')
  } else {
    lines.push('| name | nodes | saved | description |')
    lines.push('| --- | --- | --- | --- |')
    for (const graph of graphs) {
      lines.push(`| ${graph.name} | ${graph.nodes} | ${graph.savedAt ?? '—'} | ${graph.description || '—'} |`)
    }
  }
  lines.push('')
  lines.push('## Usage (last 200 calls)')
  const tools = Object.entries(usage.byTool)
  if (tools.length === 0) lines.push('No calls recorded yet.')
  for (const [name, stats] of tools) {
    lines.push(`- ${name}: ${stats.calls} call(s), last ${stats.lastAt}`)
  }
  if (usage.chainSteps > 0) {
    lines.push(`- steps executed by chains: ${usage.chainSteps}, certificates: ${usage.certificates}`)
  }
  return lines.join('\n')
}

function normalizeReceipts(input) {
  if (!Array.isArray(input)) throw new Error('receipts must be an array')
  return input.map((receipt, index) => {
    if (!receipt || typeof receipt !== 'object' || typeof receipt.stepId !== 'string') {
      throw new Error(`receipts[${index}] needs a string stepId`)
    }
    return {
      stepId: receipt.stepId,
      action: receipt.action ?? 'shell',
      args: receipt.args ?? {},
      exitCode: Number(receipt.exitCode ?? 0),
      stdout: String(receipt.stdout ?? ''),
      stderr: String(receipt.stderr ?? ''),
    }
  })
}

function makeChainTool(ctx) {
  return {
    name: 'harnessmm_chain',
    description:
      'Execute a pre-authored decision graph without a reasoning call per step: a node runs only when its guard is proven by receipts already observed (exit code, file content, JSON field). Stops and reports where control returns, with the full output of the failing step. Shell nodes run commands directly in the session directory, outside the bash sandbox, need allowShell: true, and are refused for destructive patterns. Graphs can be saved by name and re-run later; pass `receipts` from an earlier run to resume without re-executing finished nodes.',
    parameters: {
      type: 'object',
      properties: {
        graph: {
          description: 'EDG document: {"nodes":[{"id","action":"write|shell","args","after","guard"}]}',
          type: ['object', 'string'],
        },
        name: {
          description: 'Saved graph name: run it when `graph` is omitted, or store it when `save` is true.',
          type: 'string',
        },
        save: {
          description: 'Validate and store `graph` under `name` instead of running it.',
          type: 'boolean',
        },
        description: {
          description: 'One line describing a saved graph.',
          type: 'string',
        },
        list: {
          description: 'List saved graphs and usage counters instead of running anything.',
          type: 'boolean',
        },
        receipts: {
          description: 'Receipts from an earlier run, to resume a graph that already executed those nodes.',
          type: 'array',
          items: { type: 'object', additionalProperties: true },
        },
        rootId: {
          description: 'Receipt id of a step that already ran, when the graph continues after it.',
          type: 'string',
        },
        cwd: {
          description: 'Working directory. Defaults to the session directory.',
          type: 'string',
        },
        allowShell: {
          description: 'Allow shell nodes. Commands run in the Host process and bypass the bash tool sandbox; only set when the user expects commands to run.',
          type: 'boolean',
        },
        executor: {
          description: '"direct" (default) runs shell in the Host process and needs allowShell; "sandboxed" runs shell through the native bash tool, inheriting its sandbox and permission policy.',
          type: 'string',
          enum: ['direct', 'sandboxed'],
        },
        maxSteps: {
          description: 'Hard cap on executed nodes (default 20).',
          type: 'number',
        },
      },
      additionalProperties: false,
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          markdown: { type: 'string' },
          stopReason: { type: 'string' },
          steps: { type: 'number' },
          certificates: { type: 'number' },
        },
        required: ['markdown', 'stopReason'],
      },
      render: (_args, value) => text(value.markdown),
    },
    async execute(args, exec) {
      if (args.list === true) {
        const markdown = renderList()
        logUsage({ tool: 'harnessmm_chain', ...attribution(exec), mode: 'list' })
        return { markdown, stopReason: 'listed', steps: 0, certificates: 0 }
      }

      let raw = args.graph ? parseGraph(args.graph) : null
      if (args.name && !isValidName(args.name)) {
        throw new Error('graph name must match ^[a-z0-9][a-z0-9-]{0,62}$')
      }
      if (args.save === true) {
        if (!args.name) throw new Error('save needs a name')
        if (!raw) throw new Error('save needs a graph')
        const compiled = compileGraph(raw, {})
        if (!compiled.ok) throw new Error(`graph refused: ${compiled.errors.join('; ')}`)
        const saved = saveGraph(args.name, raw, { description: args.description ?? '' })
        logUsage({ tool: 'harnessmm_chain', ...attribution(exec), mode: 'save', name: args.name, nodes: compiled.graph.nodes.length, stamp: saved.stamp })
        return {
          markdown: `Saved graph "${args.name}" (${compiled.graph.nodes.length} nodes, stamp ${saved.stamp}) to ${saved.file}.\nRun it with harnessmm_chain { name: "${args.name}", allowShell: true }.`,
          stopReason: 'saved',
          steps: 0,
          certificates: 0,
        }
      }
      if (!raw) {
        if (!args.name) throw new Error('pass a graph, a saved name, or list: true')
        raw = loadGraph(args.name)
      }

      const cwd = await resolveCwd(ctx, exec, args.cwd)
      const priorReceipts = args.receipts ? normalizeReceipts(args.receipts) : []
      const sandboxed = args.executor === 'sandboxed'
      const execute = sandboxed
        ? makeSandboxExecutor({
            dispatch: (input) => ctx.tools.execute({ ...input, agent: exec.agent, signal: exec.signal }),
            cwd,
          })
        : makeExecutor({ cwd, allowShell: args.allowShell === true })
      const started = Date.now()
      const result = await runChain({
        raw,
        rootId: args.rootId,
        priorIds: priorReceipts.map((receipt) => receipt.stepId),
        priorReceipts,
        cwd,
        execute,
        maxSteps: args.maxSteps ?? 20,
      })
      const execMs = Date.now() - started
      logUsage({
        tool: 'harnessmm_chain',
        ...attribution(exec),
        name: args.name ?? null,
        steps: result.steps.length,
        stopReason: result.stopReason,
        certificates: result.certificates,
        allowShell: args.allowShell === true,
        executor: sandboxed ? 'sandboxed' : 'direct',
        resumed: priorReceipts.length,
        execMs,
        stepMs: result.steps.map((step) => ({ id: step.id, ms: step.ms })),
        deferReasons: (result.deferReasons ?? []).map((reason) => ({ id: reason.id, state: reason.state })),
        savedMs: result.saved.estMs,
        savedTokens: result.saved.estTokens,
      })
      return {
        markdown: renderChain(result),
        stopReason: result.stopReason,
        steps: result.steps.length,
        certificates: result.certificates,
        receipts: result.receipts,
        deferReasons: result.deferReasons ?? [],
        saved: result.saved,
      }
    },
  }
}

/**
 * Wire boundary substitution into this session's model loop.
 *
 * Off unless the profile enables it: the listener replaces a whole model turn,
 * so it must never be an accident of installing the plugin. Every refusal —
 * internal call, unmatched request, exhausted budget, malformed decision — is a
 * plain `next()`, so the model answers exactly as before.
 */
function wireSubstitution(ctx, config) {
  const settings = config?.substitution ?? {}
  if (settings.enabled !== true) return

  const file = decisionsFile(settings)
  const decisions = readDecisions(file)
  if (decisions.length === 0) {
    logUsage({ tool: 'llm/stream', mode: 'mount', enabled: true, decisions: 0, file })
    return
  }

  const state = createSubstitutionState(decisions)
  logUsage({ tool: 'llm/stream', mode: 'mount', enabled: true, decisions: decisions.length, file })

  ctx.effect(() => ctx.on('llm/stream', async function* (options, next) {
    const hit = decideSubstitution(options, { ...state, config: settings })
    if (hit === null) {
      yield* next()
      return
    }
    commitSubstitution(state, hit)
    logUsage({
      tool: 'llm/stream',
      mode: 'substitution',
      session: shortSession(hit.session),
      fingerprint: hit.fingerprint,
      decision: hit.decision.id ?? null,
      calls: hit.decision.tool,
      purpose: options.purpose ?? null,
    })
    for (const chunk of synthesizedChunks(hit.decision)) yield chunk
  }))
}

export function apply(ctx, config = {}) {
  ctx.effect(() => ctx.tools.register(validateTool))
  ctx.effect(() => ctx.tools.register(benchTool))
  ctx.effect(() => ctx.tools.register(makeChainTool(ctx)))
  wireSubstitution(ctx, config)
}