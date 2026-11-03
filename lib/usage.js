import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

/**
 * Append-only usage ledger. A tool call is the only way this plugin can be
 * "used", so every invocation leaves one JSON line behind: what was asked,
 * what came back, and when. Best effort: a read-only profile must not break
 * the tool it is observing.
 */
export function usageFile() {
  const dir = process.env.HARNESSMM_USAGE_DIR || path.join(os.tmpdir(), 'harnessmm-out')
  return path.join(dir, 'usage.jsonl')
}

export function logUsage(entry) {
  const file = usageFile()
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.appendFileSync(file, `${JSON.stringify({ at: new Date().toISOString(), ...entry })}\n`)
    return file
  } catch {
    return null
  }
}

export function readUsage() {
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