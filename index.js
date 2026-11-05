import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { compileGraph } from './lib/graph.js'
import { TASKS } from './lib/tasks.js'
import { runBenchmark, renderMarkdown, writeReport } from './lib/report.js'
import { logUsage } from './lib/usage.js'
import { runChain, makeExecutor, makeSandboxExecutor, renderChain } from './lib/chain.js'
import { resolveMode } from './lib/modes.js'
import { summarizeUsage } from './lib/usage.js'

/**
 * HarnessMM Lab: three tools.
 *  - harnessmm_validate checks an Executable Decision Graph against literal
 *    closure and causal-dependency rules before anyone trusts it.
 *  - harnessmm_bench runs the same task set through the baseline and the
 *    guarded-reuse arm and returns measured token accounting.
 *  - harnessmm_chain executes a saved or inline graph and reports receipts.
 * The tools never touch this session's model loop. Understanding a request is
 * the model's job: it states the plan itself, in the call, as a list of steps
 * with their expectations. Nothing is registered in advance and nothing is
 * matched by wording. See docs/quickstart.md.
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

const CHAIN_DESCRIPTION =
  'Execute a plan without a reasoning call per step. Pass `steps` for the common case: a list of {run, expect}, where the first step needs no predecessor and each later step runs only when the previous step\'s expectation is proven by its receipt. For branching procedures, pass `graph` (EDG nodes with after/guard) instead — both compile to the same plan.'

function makeChainTool(ctx) {
  return {
    name: 'harnessmm_chain',
    description: CHAIN_DESCRIPTION,
    parameters: {
      type: 'object',
      properties: {
        steps: {
          description:
            'Linear plan: [{"run":{"cmd":"..."},"expect":{"op":"exit_code","eq":0}}]. The first step has no predecessor and no expectation; a later step\'s expect defaults to reading the step above it. Omit expect when a step needs no gate.',
          type: ['array', 'object'],
        },
        graph: {
          description:
            'Graph form, for branching procedures: {"nodes":[{"id","action":"write|shell","args","after","guard"}]}. Use this only when the plan is not a straight line.',
          type: ['object', 'string'],
        },
        receipts: {
          description: 'Receipts from an earlier run, to resume a graph that already executed those nodes.',
          type: 'array',
          items: { type: 'object', additionalProperties: true },
        },
        rootId: {
          description:
            'Optional. Receipt id of a step that already ran, when this plan continues after work done outside it. A plan that starts from nothing needs no root.',
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
          avoidedRoundTrips: { type: 'number' },
          modelCallsBetweenSteps: { type: 'number' },
        },
        required: ['markdown', 'stopReason'],
      },
      render: (_args, value) => text(value.markdown),
    },
    async execute(args, exec) {
      resolveMode(args)

      const raw =
        args.steps !== undefined
          ? { steps: Array.isArray(args.steps) ? args.steps : args.steps.steps ?? [] }
          : args.graph
            ? parseGraph(args.graph)
            : null
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
        mode: 'run',
        steps: result.steps.length,
        stopReason: result.stopReason,
        certificates: result.certificates,
        allowShell: args.allowShell === true,
        executor: sandboxed ? 'sandboxed' : 'direct',
        resumed: priorReceipts.length,
        execMs,
        stepMs: result.steps.map((step) => ({ id: step.id, ms: step.ms })),
        verdicts: (result.verdicts ?? []).map((reason) => ({ id: reason.id, state: reason.state })),
        failedStep: result.failedStep ?? null,
        avoidedRoundTrips: result.avoidedRoundTrips,
        modelCallsBetweenSteps: result.modelCallsBetweenSteps,
        savedMs: result.saved.estMs,
        savedTokens: result.saved.estTokens,
      })
      return {
        markdown: renderChain(result),
        stopReason: result.stopReason,
        steps: result.steps.length,
        certificates: result.certificates,
        receipts: result.receipts,
        verdicts: result.verdicts ?? [],
        failedStep: result.failedStep ?? null,
        avoidedRoundTrips: result.avoidedRoundTrips,
        modelCallsBetweenSteps: result.modelCallsBetweenSteps,
        saved: result.saved,
      }
    },
  }
}

export function apply(ctx, config = {}) {
  ctx.effect(() => ctx.tools.register(validateTool))
  ctx.effect(() => ctx.tools.register(benchTool))
  ctx.effect(() => ctx.tools.register(makeChainTool(ctx)))
}