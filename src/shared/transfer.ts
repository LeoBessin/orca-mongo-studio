// Import and export of connection definitions. Exports never carry secrets: an inline PEM or a
// password must be entered again after import. Accepts Mongo Studio's own format, MongoDB Compass
// exports, and plain connection strings (one per line). Mongo Studio's format also carries the
// saved tasks that use only the exported connections, naming connections by name (as shell scripts
// do), so they find their connections on another machine.
import { normalizeGroup } from './groups'
import { cloneDef, connectionSubtitle, type ConnectionDef, type SecretDraft } from './model'
import { mapTaskConnections, taskConnections, type Task, type TaskRequest } from './tasks'
import { ConnectionStringError, parseConnectionString } from './uri'

export const EXPORT_FORMAT = 'mongo-studio.connections'

export type ExportFile = {
  format: typeof EXPORT_FORMAT
  version: 1
  exportedAt: string
  connections: Omit<ConnectionDef, 'id' | 'createdAt' | 'updatedAt'>[]
  tasks?: ExportedTask[]
}

/** A saved task in an export: its request names connections by name instead of id. */
export type ExportedTask = { name: string; request: TaskRequest }

/** The tasks that travel with these connections: those that use no other connection. */
export function exportableTasks(defs: readonly ConnectionDef[], tasks: readonly Task[]): Task[] {
  const ids = new Set(defs.map((d) => d.id))
  return tasks.filter((t) => taskConnections(t.request).every((id) => ids.has(id)))
}

export function exportConnections(defs: readonly ConnectionDef[], now: number, tasks: readonly Task[] = []): string {
  const names = new Map(defs.map((d) => [d.id, d.name]))
  const travel = exportableTasks(defs, tasks)
  const file: ExportFile = {
    format: EXPORT_FORMAT,
    version: 1,
    exportedAt: new Date(now).toISOString(),
    connections: defs.map((d) => {
      const { id: _id, createdAt: _c, updatedAt: _u, ...rest } = cloneDef(d)
      return rest
    }),
    ...(travel.length ? { tasks: travel.map((t) => ({ name: t.name, request: mapTaskConnections(t.request, (id) => names.get(id)!) })) } : {})
  }
  return `${JSON.stringify(file, null, 2)}\n`
}

export type ImportedConnection = { def: ConnectionDef; secrets: SecretDraft; warnings: string[] }
export type ImportResult = { items: ImportedConnection[]; errors: string[]; tasks: ExportedTask[] }

/**
 * Gives imported tasks connection ids again. A name means a connection from the same file first,
 * then a saved one; a name that matches none, or more than one, leaves the task out with a reason.
 */
export function resolveTasks(
  tasks: readonly ExportedTask[],
  imported: readonly { id: string; name: string }[],
  saved: readonly { id: string; name: string }[]
): { tasks: ExportedTask[]; errors: string[] } {
  const out: ExportedTask[] = []
  const errors: string[] = []
  const find = (name: string): { id?: string; problem?: string } => {
    for (const pool of [imported, saved]) {
      const hits = pool.filter((c) => c.name === name)
      if (hits.length === 1) return { id: hits[0]!.id }
      if (hits.length > 1) return { problem: `more than one connection is named "${name}"` }
    }
    return { problem: `no connection is named "${name}"` }
  }
  for (const t of tasks) {
    const problems: string[] = []
    let request: TaskRequest
    try {
      request = mapTaskConnections(t.request, (name) => {
        const hit = find(name)
        if (hit.problem) problems.push(hit.problem)
        return hit.id ?? name
      })
    } catch {
      errors.push(`The task "${t.name}" was not imported: its settings are not readable.`)
      continue
    }
    if (problems.length) errors.push(`The task "${t.name}" was not imported: ${[...new Set(problems)].join('; ')}.`)
    else out.push({ name: t.name, request })
  }
  return { tasks: out, errors }
}

function readTasks(raw: unknown, errors: string[]): ExportedTask[] {
  if (raw === undefined) return []
  if (!Array.isArray(raw)) {
    errors.push('The tasks of this file are not a list; they were left out.')
    return []
  }
  const out: ExportedTask[] = []
  raw.forEach((t, i) => {
    if (isRecord(t) && typeof t.name === 'string' && isRecord(t.request) && typeof t.request.kind === 'string') out.push({ name: t.name, request: t.request as TaskRequest })
    else errors.push(`Task ${i + 1} of the file is not a task; it was left out.`)
  })
  return out
}

type IdFactory = () => string

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

function fromUri(uri: string, name: string | undefined, newId: IdFactory, now: number): ImportedConnection {
  const parsed = parseConnectionString(uri, newId(), now)
  parsed.def.name = name?.trim() || connectionSubtitle(parsed.def)
  return { def: parsed.def, secrets: parsed.secrets, warnings: parsed.warnings }
}

/** Fills fields an older or hand-written export may lack, from a fresh connection's defaults. */
function mergeDefaults<T>(base: T, value: unknown): T {
  if (!isRecord(base) || !isRecord(value)) return (value === undefined ? base : value) as T
  const out: Record<string, unknown> = { ...base }
  for (const [k, v] of Object.entries(value)) out[k] = k in base ? mergeDefaults((base as Record<string, unknown>)[k], v) : v
  return out as T
}

function fromStudio(raw: unknown, base: (id: string) => ConnectionDef, newId: IdFactory): ImportedConnection {
  const def = mergeDefaults(base(newId()), raw)
  // mergeDefaults keeps whatever the file holds, so a hand-written `"group": null` would arrive as is.
  def.group = normalizeGroup(def.group)
  const warnings: string[] = []
  // Inline PEMs were secrets and did not travel: ask for them again.
  if (def.tls.ca.kind === 'inline') {
    def.tls.ca = { kind: 'none' }
    warnings.push('The CA certificate was pasted inline; paste it again.')
  }
  if (def.tls.clientCert.kind === 'inline') {
    def.tls.clientCert = { kind: 'none' }
    warnings.push('The client certificate was pasted inline; paste it again.')
  }
  if (def.ssh.privateKey.kind === 'inline') {
    def.ssh.privateKey = { kind: 'none' }
    warnings.push('The SSH private key was pasted inline; paste it again.')
  }
  return { def, secrets: {}, warnings }
}

export function importConnections(
  text: string,
  newId: IdFactory,
  now: number,
  base: (id: string) => ConnectionDef
): ImportResult {
  const trimmed = text.trim()
  const items: ImportedConnection[] = []
  const errors: string[] = []
  const tasks: ExportedTask[] = []
  if (!trimmed) return { items, errors: ['Nothing to import.'], tasks }

  if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
    let data: unknown
    try {
      data = JSON.parse(trimmed)
    } catch (e) {
      return { items, errors: [`This is not valid JSON: ${(e as Error).message}`], tasks }
    }
    if (isRecord(data) && data.format === EXPORT_FORMAT && Array.isArray(data.connections)) {
      data.connections.forEach((c, i) => {
        if (isRecord(c)) items.push(fromStudio(c, base, newId))
        else errors.push(`Connection ${i + 1} is not an object.`)
      })
      return { items, errors, tasks: readTasks(data.tasks, errors) }
    }
    // MongoDB Compass: { connections: [{ connectionOptions: { connectionString }, favorite: { name } }] }
    const list = isRecord(data) && Array.isArray(data.connections) ? data.connections : Array.isArray(data) ? data : null
    if (!list) return { items, errors: ['This JSON is neither a Mongo Studio nor a Compass export.'], tasks }
    list.forEach((c, i) => {
      const uri =
        typeof c === 'string'
          ? c
          : isRecord(c) && isRecord(c.connectionOptions) && typeof c.connectionOptions.connectionString === 'string'
            ? c.connectionOptions.connectionString
            : null
      const name = isRecord(c) && isRecord(c.favorite) && typeof c.favorite.name === 'string' ? c.favorite.name : undefined
      if (!uri) {
        errors.push(`Entry ${i + 1} has no connection string.`)
        return
      }
      try {
        const item = fromUri(uri, name, newId, now)
        if (isRecord(c) && isRecord(c.connectionOptions) && isRecord(c.connectionOptions.sshTunnel)) {
          item.warnings.push('Compass SSH tunnel settings are not imported; set up the tunnel again.')
        }
        items.push(item)
      } catch (e) {
        errors.push(`Entry ${i + 1}: ${(e as Error).message}`)
      }
    })
    return { items, errors, tasks }
  }

  trimmed.split(/\r?\n/).forEach((line, i) => {
    const uri = line.trim()
    if (!uri || uri.startsWith('#')) return
    try {
      items.push(fromUri(uri, undefined, newId, now))
    } catch (e) {
      errors.push(`Line ${i + 1}: ${e instanceof ConnectionStringError ? e.message : String(e)}`)
    }
  })
  return { items, errors, tasks }
}
