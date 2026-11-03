/**
 * A deterministic stand-in for the slow reasoning model. It is a replay, not an
 * LLM: the point is to hold the *decision content* fixed between the baseline
 * and the HarnessMM arm so that the only difference measured is when the
 * decision is produced. Its token cost is computed from the exact prompt and
 * output strings, like any other call.
 */
function bump(stepId, by) {
  const match = /^s(\d+)$/.exec(stepId)
  if (!match) throw new Error(`step ids must look like s<N>, got ${stepId}`)
  return `s${Number(match[1]) + by}`
}

function planAfter(writeStep, { python }) {
  const compileStep = bump(writeStep, 1)
  const testStep = bump(writeStep, 2)
  return {
    nodes: [
      {
        id: compileStep,
        action: 'shell',
        args: { cmd: `${python} -m py_compile solution.py` },
        after: writeStep,
        guard: { op: 'exists', of: writeStep },
      },
      {
        id: testStep,
        action: 'shell',
        args: { cmd: `${python} check.py` },
        after: compileStep,
        guard: { op: 'exit_code', of: compileStep, eq: 0 },
      },
    ],
  }
}

export function createScriptedActor({ python = 'python3' } = {}) {
  return {
    /** @returns {{action: {name: string, args: object}, graph?: {nodes: object[]}, final?: boolean}} */
    decide({ task, receipts, nextId, includeGraph = true }) {
      const last = receipts.at(-1)
      const write = (source) => {
        const decision = { action: { name: 'write', args: { path: 'solution.py', content: source } } }
        if (includeGraph) decision.graph = planAfter(nextId, { python })
        return decision
      }
      const compile = () => ({ action: { name: 'shell', args: { cmd: `${python} -m py_compile solution.py` } } })
      const test = () => ({ action: { name: 'shell', args: { cmd: `${python} check.py` } } })
      if (!last) {
        return write(task.buggySolution ?? task.brokenSolution ?? task.solution)
      }
      const isShell = last.action === 'shell'
      const ranTests = isShell && String(last.args?.cmd ?? '').includes('check.py')
      const ranCompile = isShell && String(last.args?.cmd ?? '').includes('py_compile')
      if (ranTests && last.exitCode === 0) {
        return { action: { name: 'answer', args: { text: 'tests passed' } }, final: true }
      }
      if (ranTests || (ranCompile && last.exitCode !== 0)) {
        return write(task.solution)
      }
      if (!includeGraph) {
        if (last.action === 'write') return compile()
        if (ranCompile && last.exitCode === 0) return test()
      }
      // A receipt the plan did not anticipate: no compiled decision applies.
      return write(task.solution)
    },
  }
}