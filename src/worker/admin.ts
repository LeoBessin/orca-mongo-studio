// Administration: indexes (list with sizes and use, create every kind, drop, hide, change a TTL),
// collections (statistics, validation rules, rename, clear, drop, make capped), databases
// (statistics, create collections of every kind, drop) and the profiler. Names are checked here
// before anything reaches the server, and system databases are never dropped.
import { BSON, type Db, type Document, type MongoClient } from 'mongodb'
import type {
  CollectionInfo,
  CollectionKind,
  CreateCollectionSpec,
  DatabaseInfo,
  DbRef,
  DetailItem,
  IndexBuild,
  IndexInfo,
  IndexList,
  Namespace,
  ProfileEntry,
  ProfileFilter,
  ProfilerStatus,
  ValidationAction,
  ValidationCheck,
  ValidationLevel
} from '../protocol'
import { isObject, type JsonObject, type JsonValue } from '../shared/ejson-view'
import { defaultIndexName, unknownIndexOptions } from '../shared/index-spec'
import { formatBytes } from '../shared/nodes'
import { HOST_MAX_BYTES } from '../shared/host-size'
import { COUNT_MAX_TIME_MS, invalid, toBson, toCanonical } from './query'
import { collStats, indexFlags } from './tree'

const { EJSON } = BSON
const STATS_TIMEOUT_MS = 5000
const SYSTEM_DBS = new Set(['admin', 'local', 'config'])

// ---- Names ----

export function checkCollectionName(name: string): void {
  if (!name) throw invalid('Give the collection a name.')
  if (name.includes('$')) throw invalid('A collection name can\'t contain $.')
  if (name.includes('\0')) throw invalid('A collection name can\'t contain a null character.')
  if (name.startsWith('system.')) throw invalid('Names starting with "system." are kept for MongoDB.')
  if (name.startsWith('.') || name.endsWith('.')) throw invalid('A collection name can\'t start or end with a dot.')
  if (Buffer.byteLength(name) > 235) throw invalid('That name is too long.')
}

export function checkDatabaseName(name: string): void {
  if (!name) throw invalid('Give the database a name.')
  if (/[/\\. "$*<>:|?\0]/.test(name)) throw invalid('A database name can\'t contain / \\ . space " $ * < > : | ? or a null character.')
  if (Buffer.byteLength(name) >= 64) throw invalid('A database name is shorter than 64 bytes.')
}

function nsText(ns: Namespace): string {
  return `${ns.db}.${ns.collection}`
}

function item(label: string, value: DetailItem['value'], extra: Partial<DetailItem> = {}): DetailItem {
  return { label, value, ...extra }
}

const num = (v: unknown): number | undefined => (typeof v === 'number' ? v : typeof v === 'bigint' ? Number(v) : typeof (v as { toNumber?: unknown })?.toNumber === 'function' ? (v as { toNumber(): number }).toNumber() : undefined)

// ---- Indexes ----

export async function listIndexes(client: MongoClient, ns: Namespace): Promise<IndexList> {
  const started = Date.now()
  const db = client.db(ns.db)
  const coll = db.collection(ns.collection)
  const [specs, stats, usage, building] = await Promise.all([
    coll.listIndexes().toArray(),
    collStats(db, ns.collection),
    coll.aggregate([{ $indexStats: {} }], { maxTimeMS: STATS_TIMEOUT_MS }).toArray().catch(() => [] as Document[]),
    indexBuilds(client, ns)
  ])
  const used = new Map(usage.map((u) => [String(u.name), u.accesses as { ops?: unknown; since?: unknown } | undefined]))
  const indexes = specs.map((spec): IndexInfo => {
    const name = String(spec.name)
    const info: IndexInfo = {
      name,
      key: toCanonical(spec.key ?? {}),
      kinds: name === '_id_' ? ['unique', ...indexFlags(spec)] : indexFlags(spec),
      hidden: spec.hidden === true,
      unique: spec.unique === true || name === '_id_',
      spec: toCanonical(spec)
    }
    if (typeof spec.expireAfterSeconds === 'number') info.ttl = spec.expireAfterSeconds
    const size = stats?.indexSizes?.[name]
    if (typeof size === 'number') info.size = size
    const u = used.get(name)
    const ops = num(u?.ops)
    if (ops !== undefined) info.ops = ops
    if (u?.since instanceof Date) info.since = u.since.getTime()
    return info
  })
  return { indexes, building, ms: Date.now() - started }
}

/** Index builds running on this collection, when the user may see current operations. */
async function indexBuilds(client: MongoClient, ns: Namespace): Promise<IndexBuild[]> {
  try {
    const ops = await client
      .db('admin')
      .aggregate([{ $currentOp: { allUsers: true, idleConnections: false } }, { $match: { 'command.createIndexes': ns.collection, ns: { $in: [nsText(ns), `${ns.db}.$cmd`] } } }], { maxTimeMS: STATS_TIMEOUT_MS })
      .toArray()
    return ops.map((op) => {
      const b: IndexBuild = { names: ((op.command?.indexes ?? []) as Document[]).map((i) => String(i.name ?? defaultIndexName(toCanonical(i.key ?? {})))) }
      if (op.progress && typeof op.progress.done === 'number' && typeof op.progress.total === 'number' && op.progress.total > 0) b.progress = `${Math.round((op.progress.done / op.progress.total) * 100)}%`
      if (typeof op.secs_running === 'number') b.secs = op.secs_running
      return b
    })
  } catch {
    return []
  }
}

export async function createIndex(client: MongoClient, ns: Namespace, key: JsonObject, options: JsonObject): Promise<{ name: string }> {
  if (!isObject(key) || Object.keys(key).length === 0) throw invalid('An index needs at least one field.')
  if (!isObject(options)) throw invalid('Index options must be a document.')
  const unknown = unknownIndexOptions(options)
  if (unknown.length) throw invalid(`Unknown index option${unknown.length === 1 ? '' : 's'}: ${unknown.join(', ')}.`)
  const name = typeof options.name === 'string' && options.name ? options.name : defaultIndexName(key)
  const spec: Document = { ...toBson<Document>(options), key: toBson<Document>(key), name }
  await client.db(ns.db).command({ createIndexes: ns.collection, indexes: [spec] })
  return { name }
}

export async function dropIndex(client: MongoClient, ns: Namespace, name: string): Promise<void> {
  if (name === '_id_') throw invalid('The _id index can\'t be dropped.')
  if (!name || name === '*') throw invalid('Name the index to drop.')
  await client.db(ns.db).command({ dropIndexes: ns.collection, index: name })
}

export async function modifyIndex(client: MongoClient, ns: Namespace, name: string, change: { hidden?: boolean; expireAfterSeconds?: number }): Promise<void> {
  const index: Document = { name }
  if (typeof change.hidden === 'boolean') {
    if (name === '_id_') throw invalid('The _id index can\'t be hidden.')
    index.hidden = change.hidden
  }
  if (change.expireAfterSeconds !== undefined) {
    const s = change.expireAfterSeconds
    if (!Number.isInteger(s) || s < 0 || s > 2147483647) throw invalid('TTL is a whole number of seconds, 0 to 2147483647.')
    index.expireAfterSeconds = s
  }
  if (Object.keys(index).length === 1) throw invalid('Nothing to change.')
  await client.db(ns.db).command({ collMod: ns.collection, index })
}

// ---- Collections ----

async function collectionEntry(db: Db, name: string): Promise<{ type?: string; options?: Document } | undefined> {
  const [info] = (await db.listCollections({ name }).toArray()) as { type?: string; options?: Document }[]
  return info
}

export async function collectionInfo(client: MongoClient, ns: Namespace): Promise<CollectionInfo> {
  const db = client.db(ns.db)
  const entry = await collectionEntry(db, ns.collection)
  if (!entry) throw invalid(`${nsText(ns)} no longer exists.`, 'not_found')
  const kind: CollectionKind = entry.type === 'view' ? 'view' : entry.type === 'timeseries' ? 'timeseries' : 'collection'
  const options = entry.options ?? {}
  const stats: DetailItem[] = []
  let count: number | null = null
  let capped = options.capped === true
  if (kind === 'view') {
    stats.push(item('View on', String(options.viewOn ?? '?')), item('Stages', Array.isArray(options.pipeline) ? options.pipeline.length : 0))
  } else {
    const [s, estimated] = await Promise.all([collStats(db, ns.collection), db.collection(ns.collection).estimatedDocumentCount({ maxTimeMS: STATS_TIMEOUT_MS }).catch(() => null)])
    count = estimated
    if (s) {
      if (typeof s.count === 'number') {
        count = s.count
        stats.push(item('Documents', s.count.toLocaleString('en-US')))
      }
      if (typeof s.size === 'number') stats.push(item('Data size', formatBytes(s.size)))
      if (typeof s.avgObjSize === 'number') stats.push(item('Average document', formatBytes(s.avgObjSize)))
      if (typeof s.storageSize === 'number') stats.push(item('Storage size', formatBytes(s.storageSize)))
      if (typeof s.nindexes === 'number') stats.push(item('Indexes', s.nindexes))
      if (typeof s.totalIndexSize === 'number') stats.push(item('Index size', formatBytes(s.totalIndexSize)))
      capped ||= s.capped === true
    } else {
      if (count !== null) stats.push(item('Documents (estimated)', count.toLocaleString('en-US')))
      stats.push(item('Statistics', 'not available to this user', { tone: 'warning' }))
    }
    if (capped) stats.push(item('Capped', `${formatBytes(Number(options.size ?? 0))}${options.max ? `, ${Number(options.max).toLocaleString('en-US')} documents at most` : ''}`))
    if (options.clusteredIndex) stats.push(item('Clustered', 'on _id'))
    if (options.timeseries) {
      const ts = options.timeseries as Document
      stats.push(item('Time field', String(ts.timeField)))
      if (ts.metaField) stats.push(item('Meta field', String(ts.metaField)))
      if (ts.granularity) stats.push(item('Granularity', String(ts.granularity)))
    }
    if (typeof options.expireAfterSeconds === 'number') stats.push(item('Documents expire after', `${options.expireAfterSeconds.toLocaleString('en-US')} s`))
  }
  const validator = isObject(options.validator as JsonValue) && Object.keys(options.validator as Document).length ? toCanonical(options.validator) : null
  return {
    kind,
    stats,
    count,
    options: toCanonical(options),
    validator,
    validationLevel: (options.validationLevel as ValidationLevel | undefined) ?? 'strict',
    validationAction: (options.validationAction as ValidationAction | undefined) ?? 'error',
    capped
  }
}

const LEVELS = new Set<ValidationLevel>(['off', 'strict', 'moderate'])
const ACTIONS = new Set<ValidationAction>(['error', 'warn', 'errorAndLog'])

export async function setValidation(client: MongoClient, ns: Namespace, validator: JsonObject | null, level: ValidationLevel, action: ValidationAction): Promise<void> {
  if (!LEVELS.has(level)) throw invalid('Validation level is off, strict or moderate.')
  if (!ACTIONS.has(action)) throw invalid('Validation action is error, warn or errorAndLog.')
  if (validator !== null && !isObject(validator)) throw invalid('The validator must be a document.')
  await client.db(ns.db).command({ collMod: ns.collection, validator: validator ? toBson<Document>(validator) : {}, validationLevel: level, validationAction: action })
}

/** Documents the validator would refuse now, counted with a time limit. */
export async function checkValidation(client: MongoClient, ns: Namespace, validator: JsonObject): Promise<ValidationCheck> {
  if (!isObject(validator) || Object.keys(validator).length === 0) throw invalid('Write a validator to check.')
  const started = Date.now()
  const coll = client.db(ns.db).collection(ns.collection)
  const failingFilter = { $nor: [toBson<Document>(validator)] }
  try {
    const [failing, checked, first] = await Promise.all([
      coll.countDocuments(failingFilter, { maxTimeMS: COUNT_MAX_TIME_MS }),
      coll.estimatedDocumentCount({ maxTimeMS: STATS_TIMEOUT_MS }).catch(() => null),
      coll.findOne(failingFilter, { projection: { _id: 1 }, maxTimeMS: COUNT_MAX_TIME_MS, promoteValues: false, promoteLongs: false })
    ])
    const out: ValidationCheck = { failing, checked, ms: Date.now() - started }
    if (first && '_id' in first) out.firstId = toCanonical({ v: first._id }).v!
    return out
  } catch (error) {
    return { failing: null, checked: null, ms: Date.now() - started, error: (error as Error).message }
  }
}

export async function renameCollection(client: MongoClient, ns: Namespace, to: string, toDb: string | undefined, dropTarget: boolean): Promise<void> {
  const db = toDb?.trim() || ns.db
  checkCollectionName(to)
  checkDatabaseName(db)
  if (db === ns.db && to === ns.collection) throw invalid('That is its name already.')
  await client.db('admin').command({ renameCollection: nsText(ns), to: `${db}.${to}`, dropTarget: dropTarget === true })
}

export async function dropCollection(client: MongoClient, ns: Namespace): Promise<void> {
  if (ns.collection.startsWith('system.') && SYSTEM_DBS.has(ns.db)) throw invalid('Mongo Studio does not drop system collections.')
  await client.db(ns.db).command({ drop: ns.collection })
}

export async function clearCollection(client: MongoClient, ns: Namespace): Promise<{ deleted: number }> {
  const entry = await collectionEntry(client.db(ns.db), ns.collection)
  if (!entry) throw invalid(`${nsText(ns)} no longer exists.`, 'not_found')
  if (entry.type === 'view') throw invalid('A view has no documents of its own to delete.')
  if (entry.options?.capped) throw invalid('Documents can\'t be deleted from a capped collection. Drop it and create it again instead.')
  const r = await client.db(ns.db).collection(ns.collection).deleteMany({})
  return { deleted: r.deletedCount }
}

export async function convertToCapped(client: MongoClient, ns: Namespace, size: number): Promise<void> {
  if (!Number.isInteger(size) || size < 4096) throw invalid('A capped collection is at least 4096 bytes.')
  await client.db(ns.db).command({ convertToCapped: ns.collection, size })
}

// ---- Databases ----

export async function databaseInfo(client: MongoClient, ref: DbRef): Promise<DatabaseInfo> {
  const db = client.db(ref.db)
  const [s, infos] = await Promise.all([
    db.command({ dbStats: 1, scale: 1 }).catch(() => undefined),
    db.listCollections({}, { nameOnly: true, authorizedCollections: true }).toArray() as Promise<{ name: string; type?: string }[]>
  ])
  const stats: DetailItem[] = []
  if (s) {
    stats.push(
      item('Collections', Number(s.collections ?? 0)),
      item('Views', Number(s.views ?? 0)),
      item('Documents', Number(s.objects ?? 0).toLocaleString('en-US')),
      item('Data size', formatBytes(Number(s.dataSize ?? 0))),
      item('Storage size', formatBytes(Number(s.storageSize ?? 0))),
      item('Indexes', Number(s.indexes ?? 0)),
      item('Index size', formatBytes(Number(s.indexSize ?? 0)))
    )
    if (typeof s.fsUsedSize === 'number' && typeof s.fsTotalSize === 'number') stats.push(item('Disk', `${formatBytes(s.fsUsedSize)} of ${formatBytes(s.fsTotalSize)} used`))
  } else stats.push(item('Statistics', 'not available to this user', { tone: 'warning' }))
  const names = new Set(infos.map((c) => c.name))
  const collections = infos
    .filter((c) => !c.name.startsWith('system.buckets.') && c.name !== 'system.views')
    .map((c) => {
      const kind: DatabaseInfo['collections'][number]['kind'] = c.type === 'view' ? 'view' : c.type === 'timeseries' ? 'timeseries' : c.name.endsWith('.files') && names.has(`${c.name.slice(0, -6)}.chunks`) ? 'bucket' : 'collection'
      return { name: c.name, kind }
    })
    .sort((a, b) => a.name.localeCompare(b.name))
  return { stats, collections }
}

function positiveInt(v: unknown, what: string, min = 0): number {
  if (typeof v !== 'number' || !Number.isInteger(v) || v < min) throw invalid(`${what} is a whole number, ${min} or more.`)
  return v
}

/** The `create` command for a spec, checked. */
export function createCommand(spec: CreateCollectionSpec): Document {
  checkCollectionName(spec.name)
  const cmd: Document = { create: spec.name }
  switch (spec.kind) {
    case 'plain':
      break
    case 'capped':
      cmd.capped = true
      cmd.size = positiveInt(spec.capped?.size, 'The size in bytes', 1)
      if (spec.capped?.max !== undefined) cmd.max = positiveInt(spec.capped.max, 'The most documents', 1)
      break
    case 'timeseries': {
      const ts = spec.timeseries
      if (!ts?.timeField?.trim()) throw invalid('A time-series collection needs a time field.')
      const opts: Document = { timeField: ts.timeField.trim() }
      if (ts.metaField?.trim()) {
        if (ts.metaField.trim() === opts.timeField) throw invalid('The meta field and the time field must differ.')
        opts.metaField = ts.metaField.trim()
      }
      if (ts.granularity) {
        if (!['seconds', 'minutes', 'hours'].includes(ts.granularity)) throw invalid('Granularity is seconds, minutes or hours.')
        opts.granularity = ts.granularity
      }
      cmd.timeseries = opts
      if (ts.expireAfterSeconds !== undefined) cmd.expireAfterSeconds = positiveInt(ts.expireAfterSeconds, 'Expire after (seconds)')
      break
    }
    case 'clustered':
      cmd.clusteredIndex = { key: { _id: 1 }, unique: true }
      if (spec.clustered?.expireAfterSeconds !== undefined) cmd.expireAfterSeconds = positiveInt(spec.clustered.expireAfterSeconds, 'Expire after (seconds)')
      break
    default:
      throw invalid('Unknown kind of collection.')
  }
  if (spec.validator && Object.keys(spec.validator).length) {
    if (spec.kind === 'timeseries') throw invalid('Time-series collections take no validator.')
    cmd.validator = toBson<Document>(spec.validator)
    if (spec.validationLevel) {
      if (!LEVELS.has(spec.validationLevel)) throw invalid('Validation level is off, strict or moderate.')
      cmd.validationLevel = spec.validationLevel
    }
    if (spec.validationAction) {
      if (!ACTIONS.has(spec.validationAction)) throw invalid('Validation action is error, warn or errorAndLog.')
      cmd.validationAction = spec.validationAction
    }
  }
  if (spec.collation && Object.keys(spec.collation).length) cmd.collation = toBson<Document>(spec.collation)
  return cmd
}

export async function createCollection(client: MongoClient, ref: DbRef, spec: CreateCollectionSpec): Promise<void> {
  checkDatabaseName(ref.db)
  const cmd = createCommand(spec)
  const exists = await collectionEntry(client.db(ref.db), spec.name)
  if (exists) throw invalid(`${ref.db}.${spec.name} exists already.`, 'conflict')
  await client.db(ref.db).command(cmd)
}

export async function dropDatabase(client: MongoClient, ref: DbRef): Promise<void> {
  if (SYSTEM_DBS.has(ref.db)) throw invalid(`Mongo Studio does not drop the ${ref.db} database.`)
  await client.db(ref.db).command({ dropDatabase: 1 })
}

// ---- Profiler ----

export async function profilerStatus(client: MongoClient, ref: DbRef): Promise<ProfilerStatus> {
  const r = await client.db(ref.db).command({ profile: -1 })
  const out: ProfilerStatus = { level: Number(r.was ?? 0), slowms: Number(r.slowms ?? 100), sampleRate: Number(r.sampleRate ?? 1) }
  if (r.filter) out.filter = EJSON.stringify(r.filter, { relaxed: true })
  if (r.note) out.note = String(r.note)
  return out
}

export async function setProfiler(client: MongoClient, ref: DbRef, level: number, slowms: number, sampleRate: number): Promise<ProfilerStatus> {
  if (![0, 1, 2].includes(level)) throw invalid('The profiling level is 0 (off), 1 (slow operations) or 2 (all).')
  if (!Number.isInteger(slowms) || slowms < 0) throw invalid('Slow operations take a whole number of milliseconds, 0 or more.')
  if (typeof sampleRate !== 'number' || !(sampleRate >= 0 && sampleRate <= 1)) throw invalid('The sample rate is from 0 to 1.')
  if (ref.db === 'local') throw invalid('The local database can\'t be profiled.')
  await client.db(ref.db).command({ profile: level, slowms, sampleRate })
  return profilerStatus(client, ref)
}

const RAW_ENTRY_MAX = 20_000
const COMMAND_MAX = 300

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

export function oneLine(value: unknown, max = COMMAND_MAX): string {
  const text = value === undefined ? '' : EJSON.stringify(value as Document, { relaxed: true })
  return text.length > max ? `${text.slice(0, max - 1)}…` : text
}

export function longText(value: unknown, max = RAW_ENTRY_MAX): string {
  const text = EJSON.stringify(value as Document, undefined, 2, { relaxed: true })
  return text.length > max ? `${text.slice(0, max)}\n… (cut: ${text.length.toLocaleString('en-US')} characters in all)` : text
}

export async function profileEntries(client: MongoClient, ref: DbRef, filter: ProfileFilter, limit: number): Promise<{ entries: ProfileEntry[]; ms: number }> {
  if (!Number.isInteger(limit) || limit < 1 || limit > 500) throw invalid('Read 1 to 500 entries.')
  const started = Date.now()
  const query: Document = {}
  if (filter.op) query.op = filter.op
  if (typeof filter.minMs === 'number' && filter.minMs > 0) query.millis = { $gte: filter.minMs }
  if (filter.ns?.trim()) query.ns = { $regex: escapeRegex(filter.ns.trim()) }
  const docs = await client.db(ref.db).collection('system.profile').find(query, { sort: { ts: -1 }, limit, maxTimeMS: 30_000 }).toArray()
  // Long raw texts are dropped from the oldest entries first, so the answer stays well under 1 MiB.
  let budget = HOST_MAX_BYTES * 0.6
  const entries = docs.map((d, i): ProfileEntry => {
    let raw = longText(d)
    if (raw.length > budget) raw = '(Too long to send with the others: read fewer entries to see it.)'
    budget -= raw.length
    const e: ProfileEntry = {
      key: `p${i}-${d.ts instanceof Date ? d.ts.getTime() : i}`,
      at: d.ts instanceof Date ? d.ts.getTime() : 0,
      op: String(d.op ?? ''),
      ns: String(d.ns ?? ''),
      ms: Number(d.millis ?? 0),
      command: oneLine(d.command ?? d.query ?? d.updateobj),
      raw
    }
    if (d.planSummary) e.plan = String(d.planSummary)
    const n = (v: unknown) => (typeof v === 'number' ? v : undefined)
    if (n(d.docsExamined) !== undefined) e.docsExamined = n(d.docsExamined)!
    if (n(d.keysExamined) !== undefined) e.keysExamined = n(d.keysExamined)!
    if (n(d.nreturned) !== undefined) e.returned = n(d.nreturned)!
    if (d.user) e.user = String(d.user)
    if (d.appName) e.app = String(d.appName)
    return e
  })
  return { entries, ms: Date.now() - started }
}
