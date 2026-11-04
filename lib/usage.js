import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

/**
 * Append-only usage ledger. A tool call is the only way this plugin can be
 * "used", so every invocation leaves one JSON line behind. The default lives
 * in the user's home rather than a temporary directory: a ledger that a reboot
 * can delete cannot answer "was this ever used".
 */
export function usageDir() {
  if (process.env.HARNESSMM_USAGE_DIR) return process.env.HARNESSMM_USAGE_DIR
  return process.env.HARNESSMM_HOME
    ? path.join(process.env.HARNESSMM_HOME, 'usage')
    : path.join(os.homedir(), '.harnessmm', 'usage')
}

export function usageFile() {
  return path.join(usageDir(), 'usage.jsonl')
}

/** Copy the legacy temporary ledger once, so early history is not lost. */
function migrateLegacy() {
  if (process.env.HARNESSMM_USAGE_DIR || process.env.HARNESSMM_HOME) return
  const target = usageFile()
  if (fs.existsSync(target)) return
  const legacy = path.join(os.tmpdir(), 'harnessmm-out', 'usage.jsonl')
  if (!fs.existsSync(legacy)) return
  try {
    fs.mkdirSync(path.dirname(target), { recursive: true })
    fs.copyFileSync(legacy, target)
  } catch {
    // A missing migration is not worth failing a tool call over.
  }
}

export function logUsage(entry) {
  const file = usageFile()
  try {
    migrateLegacy()
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.appendFileSync(file, `${JSON.stringify({ at: new Date().toISOString(), ...entry })}\n`)
    return file
  } catch {
    return null
  }
}

export function readUsage() {
  migrateLegacy()
  const file = usageFile()
  if (!fs.existsSync(file)) return []
  return fs
    .readFileSync(file, 'utf8')
    .split('\n')
    .filter((line) => line.trim() !== '')
    .map((line) => {
      try {
        return JSON.parse(line)
      } catch {
        return { malformed: line }
      }
    })
}

/** Aggregate the last `window` entries into per-tool counters. */
export function summarizeUsage(window = 200) {
  const entries = readUsage().slice(-window)
  const byTool = {}
  let chainSteps = 0
  let chainMs = 0
  let certificates = 0
  for (const entry of entries) {
    if (entry.malformed) continue
    const key = entry.tool ?? 'unknown'
    byTool[key] = byTool[key] ?? { calls: 0, lastAt: null }
    byTool[key].calls += 1
    byTool[key].lastAt = entry.at
    if (key === 'harnessmm_chain') {
      chainSteps += Number(entry.steps ?? 0)
      certificates += Number(entry.certificates ?? 0)
      chainMs += Number(entry.execMs ?? 0)
    }
  }
  return { window, entries: entries.length, byTool, chainSteps, certificates, chainMs }
}
