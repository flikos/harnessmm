import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const NAME = /^[a-z0-9][a-z0-9-]{0,62}$/

export function libraryDir() {
  return process.env.HARNESSMM_HOME
    ? path.join(process.env.HARNESSMM_HOME, 'graphs')
    : path.join(os.homedir(), '.harnessmm', 'graphs')
}

export function isValidName(name) {
  return typeof name === 'string' && NAME.test(name)
}

export function saveGraph(name, graph, { description = '' } = {}) {
  if (!isValidName(name)) {
    throw new Error('graph name must match ^[a-z0-9][a-z0-9-]{0,62}$')
  }
  const dir = libraryDir()
  fs.mkdirSync(dir, { recursive: true })
  const file = path.join(dir, `${name}.json`)
  const payload = { name, description, savedAt: new Date().toISOString(), graph }
  fs.writeFileSync(file, `${JSON.stringify(payload, null, 2)}\n`)
  return file
}

export function loadGraph(name) {
  if (!isValidName(name)) throw new Error('invalid graph name')
  const file = path.join(libraryDir(), `${name}.json`)
  if (!fs.existsSync(file)) {
    throw new Error(`no saved graph named ${name} (run harnessmm_chain with list: true to see what exists)`)
  }
  const payload = JSON.parse(fs.readFileSync(file, 'utf8'))
  if (!payload.graph || !Array.isArray(payload.graph.nodes)) {
    throw new Error(`saved graph ${name} is malformed`)
  }
  return payload.graph
}

export function listGraphs() {
  const dir = libraryDir()
  if (!fs.existsSync(dir)) return []
  const out = []
  for (const file of fs.readdirSync(dir)) {
    if (!file.endsWith('.json')) continue
    try {
      const payload = JSON.parse(fs.readFileSync(path.join(dir, file), 'utf8'))
      out.push({
        name: payload.name ?? file.replace(/\.json$/, ''),
        description: payload.description ?? '',
        savedAt: payload.savedAt ?? null,
        nodes: Array.isArray(payload.graph?.nodes) ? payload.graph.nodes.length : 0,
      })
    } catch {
      out.push({ name: file.replace(/\.json$/, ''), description: '(unreadable)', savedAt: null, nodes: 0 })
    }
  }
  return out.sort((a, b) => a.name.localeCompare(b.name))
}
