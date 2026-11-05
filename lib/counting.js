/**
 * A recording wrapper around any executor.
 *
 * Every claim this tool makes about saving rests on one fact: a step ran
 * without a model call in front of it. That fact is only checkable if the
 * executions themselves are observable, so tests drive plans through this
 * wrapper and assert on the record it keeps.
 */
export function makeCountingExecutor(execute) {
  const calls = []
  return {
    async execute(node) {
      calls.push({
        step: node.id,
        action: node.action,
        args: node.args,
        at: Date.now(),
      })
      return execute(node)
    },
    calls: () => [...calls],
    count: () => calls.length,
  }
}