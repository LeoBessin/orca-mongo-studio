// Import and export of connection definitions. Exports never carry secrets: an inline PEM or a
// password must be entered again after import. Accepts Mongo Studio's own format, MongoDB Compass
// exports, and plain connection strings (one per line).
import { cloneDef, connectionSubtitle, type ConnectionDef, type SecretDraft } from './model'
import { ConnectionStringError, parseConnectionString } from './uri'

export const EXPORT_FORMAT = 'mongo-studio.connections'

export type ExportFile = {
  format: typeof EXPORT_FORMAT
  version: 1
  exportedAt: string
  connections: Omit<ConnectionDef, 'id' | 'createdAt' | 'updatedAt'>[]
}

export function exportConnections(defs: readonly ConnectionDef[], now: number): string {
  const file: ExportFile = {
    format: EXPORT_FORMAT,
    version: 1,
    exportedAt: new Date(now).toISOString(),
    connections: defs.map((d) => {
      const { id: _id, createdAt: _c, updatedAt: _u, ...rest } = cloneDef(d)
      return rest
    })
  }
  return `${JSON.stringify(file, null, 2)}\n`
}

export type ImportedConnection = { def: ConnectionDef; secrets: SecretDraft; warnings: string[] }
export type ImportResult = { items: ImportedConnection[]; errors: string[] }

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
  if (!trimmed) return { items, errors: ['Nothing to import.'] }

  if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
    let data: unknown
    try {
      data = JSON.parse(trimmed)
    } catch (e) {
      return { items, errors: [`This is not valid JSON: ${(e as Error).message}`] }
    }
    if (isRecord(data) && data.format === EXPORT_FORMAT && Array.isArray(data.connections)) {
      data.connections.forEach((c, i) => {
        if (isRecord(c)) items.push(fromStudio(c, base, newId))
        else errors.push(`Connection ${i + 1} is not an object.`)
      })
      return { items, errors }
    }
    // MongoDB Compass: { connections: [{ connectionOptions: { connectionString }, favorite: { name } }] }
    const list = isRecord(data) && Array.isArray(data.connections) ? data.connections : Array.isArray(data) ? data : null
    if (!list) return { items, errors: ['This JSON is neither a Mongo Studio nor a Compass export.'] }
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
    return { items, errors }
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
  return { items, errors }
}
