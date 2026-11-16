// Server monitoring: a summary of serverStatus (with replica set members), current operations
// and killing one. Live refresh waits in the worker (`waitMs`), since the panel has no timers.
import type { Document, MongoClient } from 'mongodb'
import type { CurrentOp, CurrentOpsFilter, DetailItem, ServerStatus } from '../protocol'
import { formatBytes } from '../shared/nodes'
import { HOST_MAX_BYTES } from '../shared/host-size'
import { longText, oneLine } from './admin'
import { invalid, toBson, toCanonical } from './query'
import type { JsonValue } from '../shared/ejson-view'

const OPS_MAX = 200

export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted) return resolve()
    const timer = setTimeout(done, ms)
    function done(): void {
      clearTimeout(timer)
      signal?.removeEventListener('abort', done)
      resolve()
    }
    signal?.addEventListener('abort', done)
  })
}

const n = (v: unknown): number => (typeof v === 'number' ? v : typeof v === 'bigint' ? Number(v) : typeof (v as { toNumber?: unknown })?.toNumber === 'function' ? (v as { toNumber(): number }).toNumber() : Number(v ?? 0))

export function durationText(secs: number): string {
  const d = Math.floor(secs / 86400)
  const h = Math.floor((secs % 86400) / 3600)
  const m = Math.floor((secs % 3600) / 60)
  if (d) return `${d} d ${h} h`
  if (h) return `${h} h ${m} min`
  if (m) return `${m} min ${Math.floor(secs % 60)} s`
  return `${Math.floor(secs)} s`
}

function item(label: string, value: DetailItem['value'], extra: Partial<DetailItem> = {}): DetailItem {
  return { label, value, ...extra }
}

const count = (v: unknown): string => n(v).toLocaleString('en-US')

export async function serverStatus(client: MongoClient): Promise<ServerStatus> {
  const started = Date.now()
  const admin = client.db('admin')
  const s = await admin.command({ serverStatus: 1, metrics: 0, locks: 0, tcmalloc: 0 })
  const sections: ServerStatus['sections'] = []
  const server: DetailItem[] = [
    item('Host', String(s.host ?? '?'), { code: true }),
    item('Version', String(s.version ?? '?')),
    item('Process', String(s.process ?? '?')),
    item('Up for', durationText(n(s.uptime)))
  ]
  if (s.storageEngine?.name) server.push(item('Storage engine', String(s.storageEngine.name)))
  sections.push({ title: 'Server', items: server })
  if (s.connections) {
    const c = s.connections
    sections.push({
      title: 'Connections',
      items: [item('Open', count(c.current)), item('Available', count(c.available)), item('Active', count(c.active)), item('Created since start', count(c.totalCreated))]
    })
  }
  const ops = (s.opcounters ?? {}) as Document
  sections.push({ title: 'Operations since start', items: ['insert', 'query', 'update', 'delete', 'getmore', 'command'].map((k) => item(k, count(ops[k]))) })
  if (s.network) sections.push({ title: 'Network', items: [item('Received', formatBytes(n(s.network.bytesIn))), item('Sent', formatBytes(n(s.network.bytesOut))), item('Requests', count(s.network.numRequests))] })
  const memory: DetailItem[] = []
  if (s.mem) memory.push(item('Resident', `${count(s.mem.resident)} MB`), item('Virtual', `${count(s.mem.virtual)} MB`))
  const cache = s.wiredTiger?.cache as Document | undefined
  if (cache) {
    const used = n(cache['bytes currently in the cache'])
    const max = n(cache['maximum bytes configured'])
    memory.push(item('WiredTiger cache', `${formatBytes(used)} of ${formatBytes(max)}`, max && used / max > 0.95 ? { tone: 'warning' } : {}))
    memory.push(item('Dirty in cache', formatBytes(n(cache['tracked dirty bytes in the cache']))))
  }
  if (memory.length) sections.push({ title: 'Memory', items: memory })
  if (s.repl) {
    const r = s.repl as Document
    const items = [item('Replica set', String(r.setName ?? '—')), item('This member', String(r.me ?? '?'), { code: true })]
    items.push(item('Role', r.isWritablePrimary || r.ismaster ? 'primary' : r.secondary ? 'secondary' : r.arbiterOnly ? 'arbiter' : 'other'))
    if (r.primary) items.push(item('Primary', String(r.primary), { code: true }))
    sections.push({ title: 'Replication', items })
  }
  if (s.asserts) {
    const a = s.asserts as Document
    sections.push({ title: 'Asserts', items: [item('Regular', count(a.regular), n(a.regular) ? { tone: 'warning' } : {}), item('Warning', count(a.warning)), item('User', count(a.user))] })
  }
  const counters: Record<string, number> = {}
  for (const k of ['insert', 'query', 'update', 'delete', 'getmore', 'command']) counters[`op.${k}`] = n(ops[k])
  if (s.network) {
    counters['net.in'] = n(s.network.bytesIn)
    counters['net.out'] = n(s.network.bytesOut)
    counters['net.requests'] = n(s.network.numRequests)
  }
  const out: ServerStatus = { at: s.localTime instanceof Date ? s.localTime.getTime() : Date.now(), sections, counters, ms: 0 }
  if (s.repl?.setName) {
    try {
      const rs = await admin.command({ replSetGetStatus: 1 })
      const members = (rs.members ?? []) as Document[]
      const primary = members.find((m) => m.stateStr === 'PRIMARY')
      const primaryAt = primary?.optimeDate instanceof Date ? primary.optimeDate.getTime() : undefined
      out.members = members.map((m) => {
        const row: NonNullable<ServerStatus['members']>[number] = { name: String(m.name), state: String(m.stateStr ?? '?'), health: n(m.health) }
        if (primaryAt !== undefined && m.optimeDate instanceof Date && m.stateStr === 'SECONDARY') row.lagSecs = Math.max(0, Math.round((primaryAt - m.optimeDate.getTime()) / 1000))
        if (m.self) row.self = true
        return row
      })
    } catch {
      // replSetGetStatus needs clusterMonitor; the summary is still useful without it.
    }
  }
  out.ms = Date.now() - started
  return out
}

/** Our own $currentOp read shows up in its answer; leave it out. */
function isOwnRead(op: Document): boolean {
  const p = op.command?.pipeline
  return Array.isArray(p) && p.length > 0 && typeof p[0] === 'object' && p[0] !== null && '$currentOp' in p[0]
}

export async function currentOps(client: MongoClient, filter: CurrentOpsFilter): Promise<{ ops: CurrentOp[]; capped: boolean; ms: number }> {
  const started = Date.now()
  const admin = client.db('admin')
  const stage = { $currentOp: { allUsers: true, idleConnections: filter.idle === true, idleSessions: filter.idle === true } }
  let raw: Document[]
  try {
    raw = await admin.aggregate([stage, { $limit: 2000 }], { maxTimeMS: 15_000 }).toArray()
  } catch (error) {
    // Without the inprog privilege a user may still see their own operations.
    if ((error as { codeName?: string }).codeName !== 'Unauthorized') throw error
    raw = await admin.aggregate([{ $currentOp: { ...stage.$currentOp, allUsers: false } }, { $limit: 2000 }], { maxTimeMS: 15_000 }).toArray()
  }
  const ns = filter.ns?.trim()
  const kept = raw
    .filter((op) => !isOwnRead(op))
    .filter((op) => filter.system || op.client !== undefined || op.client_s !== undefined || op.clientMetadata !== undefined || String(op.desc ?? '').startsWith('conn'))
    .filter((op) => !ns || String(op.ns ?? '').includes(ns))
    .filter((op) => !filter.minSecs || n(op.secs_running) >= filter.minSecs)
    .sort((a, b) => n(b.microsecs_running ?? n(b.secs_running) * 1e6) - n(a.microsecs_running ?? n(a.secs_running) * 1e6))
  let budget = HOST_MAX_BYTES * 0.6
  const ops = kept.slice(0, OPS_MAX).map((op): CurrentOp => {
    let raw = longText(op, 10_000)
    if (raw.length > budget) raw = '(Too long to send with the others.)'
    budget -= raw.length
    const opidValue = toCanonical({ v: op.opid }).v as JsonValue
    const o: CurrentOp = {
      opid: String(typeof op.opid === 'object' && op.opid !== null && 'toString' in op.opid ? op.opid.toString() : op.opid),
      opidValue,
      op: String(op.op ?? (op.type === 'idleSession' ? 'idle session' : 'none')),
      ns: String(op.ns ?? ''),
      secs: n(op.secs_running),
      active: op.active === true,
      command: oneLine(op.command ?? op.originatingCommand ?? {}),
      raw
    }
    const client = op.client ?? op.client_s
    if (client) o.client = String(client)
    const app = op.appName ?? op.clientMetadata?.application?.name
    if (app) o.app = String(app)
    if (op.desc) o.desc = String(op.desc)
    if (Array.isArray(op.effectiveUsers) && op.effectiveUsers[0]) o.user = `${String(op.effectiveUsers[0].user)}@${String(op.effectiveUsers[0].db)}`
    if (op.planSummary) o.plan = String(op.planSummary)
    if (op.waitingForLock) o.waitingForLock = true
    return o
  })
  return { ops, capped: kept.length > OPS_MAX, ms: Date.now() - started }
}

export async function killOp(client: MongoClient, opid: JsonValue): Promise<void> {
  if (opid === null || opid === undefined || (typeof opid === 'string' && !opid)) throw invalid('Name the operation to stop.')
  const value = typeof opid === 'object' ? toBson<{ v: unknown }>({ v: opid }).v : opid
  await client.db('admin').command({ killOp: 1, op: value })
}
