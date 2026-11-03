#!/usr/bin/env node
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'
import { runBenchmark, renderMarkdown, writeReport } from '../lib/report.js'

const here = path.dirname(fileURLToPath(import.meta.url))
const argv = process.argv.slice(2)
const get = (name) => {
  const index = argv.indexOf(`--${name}`)
  return index >= 0 ? argv[index + 1] : undefined
}

const taskIds = get('tasks')?.split(',').map((id) => id.trim()).filter(Boolean)
const selector = get('selector') ?? 'unique'
const outDir = get('out') ?? path.join(here, '..', 'out')

const result = runBenchmark({ taskIds, selector })
const { markdown } = writeReport(result, outDir)
if (argv.includes('--json')) {
  console.log(JSON.stringify(result.summary, null, 2))
} else {
  console.log(markdown)
}
console.log(`\nreport written to ${path.relative(process.cwd(), outDir) || '.'}`)