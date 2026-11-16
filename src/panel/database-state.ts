// The Database tab: statistics and collections, creating a collection of any kind (or a new
// database with its first collection), the profiler and its entries, and dropping the database.
import { plugin } from 'orca'
import type { CreateCollectionSpec } from '../protocol'
import { shellString, toShellInline, type JsonObject } from '../shared/ejson-view'
import { parseShellDocument, ShellParseError } from '../shared/shell-parse'
import {
  adminTabId,
  backToTree,
  changeAdmin,
  closeAdmin,
  closeTabsForNs,
  refreshTree,
  sayAdmin,
  showOrAdd,
  tabOf,
  type CollectionDraft,
  type DatabaseTab
} from './admin-state'
import { openNamespace } from './collection-state'
import { errorText } from './state'

export function databaseTabId(connectionId: string, db: string): string {
  return adminTabId('database', [connectionId, db])
}

function emptyDraft(): CollectionDraft {
  return { name: '', kind: 'plain', size: '', max: '', timeField: '', metaField: '', granularity: '', expire: '', validator: '', level: 'strict', action: 'error', collation: '' }
}

function newTab(connectionId: string, db: string, isNew: boolean): DatabaseTab {
  return {
    id: isNew ? adminTabId('database', [connectionId, '(new)']) : databaseTabId(connectionId, db),
    kind: 'database',
    connectionId,
    title: isNew ? 'New database' : db,
    db,
    isNew,
    newDb: '',
    open: { overview: !isNew, create: isNew, profiler: false, drop: false },
    loading: false,
    create: emptyDraft(),
    createErrors: {},
    creating: false,
    profilerDraft: { level: '0', slowms: '100', sampleRate: '1' },
    profileFilter: { op: '', minMs: '', ns: '' },
    reading: false,
    dropName: ''
  }
}

export async function openDatabase(connectionId: string, db: string): Promise<void> {
  if (showOrAdd(newTab(connectionId, db, false))) await loadDatabase(databaseTabId(connectionId, db))
}

/** A tab to create a database: MongoDB makes one with its first collection. */
export function openNewDatabase(connectionId: string): void {
  showOrAdd(newTab(connectionId, '', true))
}

export async function loadDatabase(id: string): Promise<void> {
  const t = tabOf(id, 'database')
  if (!t || t.isNew) return
  changeAdmin(id, 'database', () => ({ loading: true }))
  const ref = { connectionId: t.connectionId, db: t.db }
  const [info, profiler] = await Promise.allSettled([plugin.request('admin.database', ref, { timeoutMs: 30000 }), plugin.request('profiler.status', ref, { timeoutMs: 30000 })])
  changeAdmin(id, 'database', () => {
    const out: Partial<DatabaseTab> = { loading: false }
    if (info.status === 'fulfilled') {
      out.info = info.value
      out.infoError = undefined
    } else out.infoError = errorText(info.reason)
    if (profiler.status === 'fulfilled') {
      const p = profiler.value
      out.profiler = p
      out.profilerError = undefined
      out.profilerDraft = { level: String(p.level), slowms: String(p.slowms), sampleRate: String(p.sampleRate) }
    } else out.profilerError = errorText(profiler.reason)
    return out
  })
}

export function toggleDbSection(id: string, section: keyof DatabaseTab['open'], open: boolean): void {
  changeAdmin(id, 'database', (t) => ({ open: { ...t.open, [section]: open } }))
}

// ---- Create a collection ----

export function editCreate(id: string, change: Partial<CollectionDraft>): void {
  changeAdmin(id, 'database', (t) => {
    const errors = { ...t.createErrors }
    for (const k of Object.keys(change)) delete errors[k]
    return { create: { ...t.create, ...change }, createErrors: errors }
  })
}

const whole = (text: string): number | undefined => (/^\d+$/.test(text.trim()) ? Number(text.trim()) : undefined)

/** The draft as a spec, or an error per field. */
export function createSpec(d: CollectionDraft): { spec?: CreateCollectionSpec; errors: Partial<Record<keyof CollectionDraft, string>> } {
  const errors: Partial<Record<keyof CollectionDraft, string>> = {}
  const name = d.name.trim()
  if (!name) errors.name = 'Give the collection a name.'
  else if (name.includes('$')) errors.name = 'A collection name can\'t contain $.'
  else if (name.startsWith('system.')) errors.name = 'Names starting with "system." are kept for MongoDB.'
  const spec: CreateCollectionSpec = { name, kind: d.kind }
  const expire = d.expire.trim()
  const expireAfterSeconds = expire ? whole(expire) : undefined
  if (expire && expireAfterSeconds === undefined) errors.expire = 'A whole number of seconds.'
  if (d.kind === 'capped') {
    const size = whole(d.size)
    if (size === undefined || size < 1) errors.size = 'The most bytes it holds, a whole number.'
    const max = d.max.trim() ? whole(d.max) : undefined
    if (d.max.trim() && (max === undefined || max < 1)) errors.max = 'A whole number, or empty for no limit.'
    if (size) spec.capped = { size, ...(max ? { max } : {}) }
  }
  if (d.kind === 'timeseries') {
    if (!d.timeField.trim()) errors.timeField = 'The field holding each measurement\'s date.'
    else if (d.metaField.trim() && d.metaField.trim() === d.timeField.trim()) errors.metaField = 'The meta field and the time field must differ.'
    spec.timeseries = { timeField: d.timeField.trim(), ...(d.metaField.trim() ? { metaField: d.metaField.trim() } : {}), ...(d.granularity ? { granularity: d.granularity } : {}), ...(expireAfterSeconds !== undefined ? { expireAfterSeconds } : {}) }
  }
  if (d.kind === 'clustered') spec.clustered = expireAfterSeconds !== undefined ? { expireAfterSeconds } : {}
  const doc = (field: 'validator' | 'collation', what: string): JsonObject | undefined => {
    if (!d[field].trim()) return undefined
    try {
      return parseShellDocument(d[field], what)
    } catch (error) {
      errors[field] = error instanceof ShellParseError ? error.message : errorText(error)
      return undefined
    }
  }
  const validator = d.kind === 'timeseries' ? undefined : doc('validator', 'validator')
  if (validator && Object.keys(validator).length) {
    spec.validator = validator
    spec.validationLevel = d.level
    spec.validationAction = d.action
  }
  const collation = doc('collation', 'collation')
  if (collation) {
    if (typeof collation.locale !== 'string') errors.collation = 'A collation needs a locale, such as { locale: \'en\' }.'
    else spec.collation = collation
  }
  return Object.keys(errors).length ? { errors } : { spec, errors }
}

/** The mongosh command that creates it. */
export function createCommandText(db: string, spec: CreateCollectionSpec): string {
  const options: JsonObject = {}
  if (spec.capped) {
    options.capped = true
    options.size = spec.capped.size
    if (spec.capped.max) options.max = spec.capped.max
  }
  if (spec.timeseries) {
    const { expireAfterSeconds, ...ts } = spec.timeseries
    options.timeseries = ts
    if (expireAfterSeconds !== undefined) options.expireAfterSeconds = expireAfterSeconds
  }
  if (spec.clustered) {
    options.clusteredIndex = { key: { _id: 1 }, unique: true }
    if (spec.clustered.expireAfterSeconds !== undefined) options.expireAfterSeconds = spec.clustered.expireAfterSeconds
  }
  if (spec.validator) {
    options.validator = spec.validator
    options.validationLevel = spec.validationLevel ?? 'strict'
    options.validationAction = spec.validationAction ?? 'error'
  }
  if (spec.collation) options.collation = spec.collation
  return `db.getSiblingDB(${shellString(db)}).createCollection(${shellString(spec.name)}${Object.keys(options).length ? `, ${toShellInline(options)}` : ''})`
}

export async function createCollection(id: string): Promise<void> {
  const t = tabOf(id, 'database')
  if (!t) return
  const db = t.isNew ? t.newDb.trim() : t.db
  if (t.isNew && !db) {
    sayAdmin(id, 'danger', 'Give the new database a name.')
    return
  }
  const { spec, errors } = createSpec(t.create)
  if (!spec) {
    changeAdmin(id, 'database', () => ({ createErrors: errors }))
    return
  }
  changeAdmin(id, 'database', () => ({ creating: true }))
  try {
    await plugin.request('admin.createCollection', { connectionId: t.connectionId, db, spec }, { timeoutMs: 60000 })
  } finally {
    changeAdmin(id, 'database', () => ({ creating: false }))
  }
  await refreshTree(t.connectionId, t.isNew ? undefined : db)
  if (t.isNew) {
    // The new database gets its own tab, in place of this one.
    closeAdmin(id)
    await openDatabase(t.connectionId, db)
    sayAdmin(databaseTabId(t.connectionId, db), 'success', `Database ${db} created with ${spec.name}.`)
    return
  }
  changeAdmin(id, 'database', () => ({ create: emptyDraft(), createErrors: {} }))
  sayAdmin(id, 'success', `${db}.${spec.name} created.`)
  await loadDatabase(id)
}

export function openCollectionOf(id: string, name: string): Promise<void> {
  const t = tabOf(id, 'database')
  const c = t?.info?.collections.find((x) => x.name === name)
  if (!t || !c) return Promise.resolve()
  return openNamespace({ connectionId: t.connectionId, db: t.db, collection: name }, c.kind === 'view' ? 'view' : c.kind === 'timeseries' ? 'timeseries' : 'coll')
}

// ---- Profiler ----

export async function applyProfiler(id: string): Promise<void> {
  const t = tabOf(id, 'database')
  if (!t) return
  const d = t.profilerDraft
  const slowms = whole(d.slowms)
  const sampleRate = Number(d.sampleRate.trim())
  if (slowms === undefined) throw new Error('Slow operations take a whole number of milliseconds.')
  if (!d.sampleRate.trim() || !(sampleRate >= 0 && sampleRate <= 1)) throw new Error('The sample rate is from 0 to 1, such as 0.5 for half of the operations.')
  const p = await plugin.request('profiler.set', { connectionId: t.connectionId, db: t.db, level: Number(d.level), slowms, sampleRate })
  changeAdmin(id, 'database', () => ({ profiler: p, profilerDraft: { level: String(p.level), slowms: String(p.slowms), sampleRate: String(p.sampleRate) } }))
  sayAdmin(id, 'success', p.level === 0 ? 'The profiler is off. Slow operations still go to the server log.' : p.level === 1 ? `The profiler records operations slower than ${p.slowms} ms.` : 'The profiler records every operation. Turn it back down when done: it slows the server.')
}

export async function readProfile(id: string): Promise<void> {
  const t = tabOf(id, 'database')
  if (!t) return
  const f = t.profileFilter
  const minMs = f.minMs.trim() ? whole(f.minMs) : undefined
  if (f.minMs.trim() && minMs === undefined) throw new Error('Slower than: a whole number of milliseconds.')
  changeAdmin(id, 'database', () => ({ reading: true }))
  try {
    const r = await plugin.request('profiler.entries', { connectionId: t.connectionId, db: t.db, filter: { ...(f.op ? { op: f.op } : {}), ...(minMs !== undefined ? { minMs } : {}), ...(f.ns.trim() ? { ns: f.ns.trim() } : {}) }, limit: 100 }, { timeoutMs: 60000 })
    changeAdmin(id, 'database', (x) => ({ entries: r.entries, entriesMs: r.ms, entrySelected: r.entries.some((e) => e.key === x.entrySelected) ? x.entrySelected : undefined }))
  } finally {
    changeAdmin(id, 'database', () => ({ reading: false }))
  }
}

// ---- Drop ----

export async function dropDatabase(id: string): Promise<void> {
  const t = tabOf(id, 'database')
  if (!t || t.dropName !== t.db) return
  await plugin.request('admin.dropDatabase', { connectionId: t.connectionId, db: t.db }, { timeoutMs: 60000 })
  closeTabsForNs({ connectionId: t.connectionId, db: t.db })
  await refreshTree(t.connectionId)
  backToTree('neutral', `The database ${t.db} was dropped, with every collection in it.`)
}
