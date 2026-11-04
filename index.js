import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { compileGraph } from './lib/graph.js'
import { TASKS } from './lib/tasks.js'
import { runBenchmark, renderMarkdown, writeReport } from './lib/report.js'
import { logUsage } from './lib/usage.js'
import { runChain, makeExecutor, renderChain } from './lib/chain.js'

/**
 * HarnessMM Lab: two tools.
 *  - harnessmm_validate checks an Executable Decision Graph against literal
 *    closure and causal-dependency rules before anyone trusts it.
 *  - harnessmm_bench runs the same task set through the baseline and the
 *    guarded-reuse arm and returns measured token accounting.
 * The installed plugin does not intercept this session's model loop: DSH has no
 * hook that can skip a reasoning call, so substitution is exercised in-process
 * by the benchmark instead of silently rewriting the live agent.
 */
export const inject = ['tools']

const text = (value) => [{ type: 'text', text: value }]

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
  async execute(args) {
    const compiled = compileGraph(parseGraph(args.graph), {
      rootId: args.rootId,
      priorIds: args.priorIds ?? [],
    })
    const value = compiled.ok
      ? { ok: true, errors: [], nodes: compiled.graph.nodes.length, hash: compiled.graph.hash }
      : { ok: false, errors: compiled.errors, nodes: 0, hash: '' }
    logUsage({ tool: 'harnessmm_validate', ok: value.ok, nodes: value.nodes, errors: value.errors })
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
  async execute(args) {
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

function makeChainTool(ctx) {
  return {
    name: 'harnessmm_chain',
    description:
      'Execute a pre-authored decision graph without a reasoning call per step: a node runs only when its guard is proven by receipts already observed (exit code, file content, JSON field). Stops and reports where control returns. Shell nodes run commands directly in the session directory, outside the bash sandbox, and need allowShell: true.',
    parameters: {
      type: 'object',
      properties: {
        graph: {
          description: 'EDG document: {"nodes":[{"id","action":"write|shell","args","after","guard"}]}',
          type: ['object', 'string'],
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
        maxSteps: {
          description: 'Hard cap on executed nodes (default 20).',
          type: 'number',
        },
      },
      required: ['graph'],
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
      const cwd = await resolveCwd(ctx, exec, args.cwd)
      const result = runChain({
        raw: parseGraph(args.graph),
        rootId: args.rootId,
        cwd,
        execute: makeExecutor({ cwd, allowShell: args.allowShell === true }),
        maxSteps: args.maxSteps ?? 20,
      })
      logUsage({
        tool: 'harnessmm_chain',
        steps: result.steps.length,
        stopReason: result.stopReason,
        certificates: result.certificates,
        allowShell: args.allowShell === true,
      })
      return {
        markdown: renderChain(result),
        stopReason: result.stopReason,
        steps: result.steps.length,
        certificates: result.certificates,
      }
    },
  }
}

export function apply(ctx) {
  ctx.effect(() => ctx.tools.register(validateTool))
  ctx.effect(() => ctx.tools.register(benchTool))
  ctx.effect(() => ctx.tools.register(makeChainTool(ctx)))
}