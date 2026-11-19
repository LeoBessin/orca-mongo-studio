// Finds, pages, counts and document writes. Each query id keeps an open cursor, so the next page
// reads on from it; any other page re-runs the find with skip. Pages stay under the size Orca lets a
// request answer (1 MiB): long strings, big arrays and binary data are cut down with a marker, and a
// page stops early when its documents would pass the byte budget.
import { createHash } from 'node:crypto'
import { BSON, type AbstractCursor, type Collection, type Document, type MongoClient } from 'mongodb'
import type { AggOptions, CountResult, Namespace, QueryLibrary, QueryPage, QuerySpec, QueryText, SavedQuery, WriteResult } from '../protocol'
import { hasWriteStage } from '../shared/pipeline'
import { base64Length, bsonType, isObject, type JsonObject, type JsonValue } from '../shared/ejson-view'
import { fitsHost, HOST_MAX_BYTES, HOST_MAX_OBJECTS, hostSize, QUERY_TEXT_MAX } from '../shared/host-size'
import type { JsonValue as WorkerJson, OrcaWorkerApi } from 'orca/worker'

const { EJSON } = BSON

/**
 * What a page's documents may add up to, in Orca's own measure (see shared/host-size): an answer
 * is refused past 1 MiB or 10,000 objects. Canonical Extended JSON makes each number an object, so
 * a page of 500 orders runs out of objects long before bytes.
 */
export const PAGE_BYTE_BUDGET = Math.floor(HOST_MAX_BYTES * 0.75)
export const PAGE_OBJECT_BUDGET = Math.floor(HOST_MAX_OBJECTS * 0.9)
/** Deeper values are cut, so the page stays under Orca's 100 levels. */
const DEPTH_MAX = 80
export const FIND_MAX_TIME_MS = 60_000
/** Reads keep every BSON type as it is: Int64 stays a Long, regexes keep their flags. */
export const EXACT = { promoteValues: false, promoteLongs: false, bsonRegExp: true } as const
export const COUNT_MAX_TIME_MS = 10_000
const IDLE_CURSOR_MS = 10 * 60_000

const STRING_MAX = 4000
const STRING_PREVIEW = 500
const ARRAY_MAX = 200
const ARRAY_PREVIEW = 50
const BINARY_MAX = 4096
const BINARY_PREVIEW_CHARS = 64

export function invalid(message: string, code = 'invalid_params'): Error {
  return Object.assign(new Error(message), { code })
}

export function toBson<T = Document>(value: JsonValue): T {
  return EJSON.parse(JSON.stringify(value), { relaxed: false }) as T
}

export function toCanonical(value: unknown): JsonObject {
  return EJSON.serialize(value, { relaxed: false }) as JsonObject
}

/** Cuts long strings, arrays and binary values down to a preview; `cut` says whether any were. */
export function shrink(value: JsonValue, depth = 0): { value: JsonValue; cut: boolean } {
  if (depth > DEPTH_MAX && typeof value === 'object' && value !== null && (Array.isArray(value) || bsonType(value) === 'object')) {
    const size = Array.isArray(value) ? value.length : Object.keys(value).length
    return { value: { $msTruncated: { kind: Array.isArray(value) ? 'array' : 'object', size, preview: null } }, cut: true }
  }
  if (typeof value === 'string') {
    if (value.length <= STRING_MAX) return { value, cut: false }
    return { value: { $msTruncated: { kind: 'string', size: value.length, preview: value.slice(0, STRING_PREVIEW) } }, cut: true }
  }
  if (Array.isArray(value)) {
    if (value.length > ARRAY_MAX) {
      const preview = value.slice(0, ARRAY_PREVIEW).map((v) => shrink(v, depth + 1).value)
      return { value: { $msTruncated: { kind: 'array', size: value.length, preview } }, cut: true }
    }
    let cut = false
    const out = value.map((v) => {
      const r = shrink(v, depth + 1)
      cut ||= r.cut
      return r.value
    })
    return { value: out, cut }
  }
  if (!isObject(value)) return { value, cut: false }
  const type = bsonType(value)
  if (type === 'binData' || type === 'uuid') {
    const b = value.$binary
    if (isObject(b) && typeof b.base64 === 'string' && base64Length(b.base64) > BINARY_MAX) {
      return { value: { $msTruncated: { kind: 'binary', size: base64Length(b.base64), preview: { $binary: { base64: b.base64.slice(0, BINARY_PREVIEW_CHARS), subType: String(b.subType) } } } }, cut: true }
    }
    return { value, cut: false }
  }
  if (type !== 'object') return { value, cut: false }
  let cut = false
  const out: JsonObject = {}
  for (const [k, v] of Object.entries(value)) {
    const r = shrink(v, depth + 1)
    cut ||= r.cut
    out[k] = r.value
  }
  return { value: out, cut }
}

/** A document as a page shows it: canonical, shrunk, and small enough to send. */
export function pageDoc(doc: Document): { doc: JsonObject; cut: boolean; bytes: number; objects: number } {
  return pageCanonical(toCanonical(doc))
}

/** The same, for a document already in canonical Extended JSON. */
export function pageCanonical(canonical: JsonObject): { doc: JsonObject; cut: boolean; bytes: number; objects: number } {
  const { value, cut } = shrink(canonical, 2)
  const shrunk = value as JsonObject
  const size = hostSize(shrunk)
  if (size.bytes <= PAGE_BYTE_BUDGET && size.objects <= PAGE_OBJECT_BUDGET) return { doc: shrunk, cut, bytes: size.bytes, objects: size.objects }
  // Still too big (thousands of fields): keep the _id so it can be opened on its own.
  const stub: JsonObject = { $msTruncated: { kind: 'object', size: Object.keys(shrunk).length, preview: null } }
  const out: JsonObject = '_id' in shrunk ? { _id: shrunk._id!, '(document)': stub } : { '(document)': stub }
  const small = hostSize(out)
  return { doc: out, cut: true, bytes: small.bytes, objects: small.objects }
}

type Session = {
  id: string
  key: string
  cursor: AbstractCursor<Document>
  /** The result offset of the next document the cursor yields. */
  next: number
  /** A document read but left for the next page, when a page filled its byte budget. */
  pending?: Document
  lastUsed: number
}

function specKey(ns: Namespace, spec: QuerySpec): string {
  return JSON.stringify([ns.connectionId, ns.db, ns.collection, spec])
}

function pipelineKey(ns: Namespace, pipeline: JsonObject[], options: AggOptions): string {
  return JSON.stringify([ns.connectionId, ns.db, ns.collection, 'aggregate', pipeline, options])
}

/** Options an aggregate takes from the panel, checked. */
export function aggregateOptions(options: AggOptions): Document {
  const out: Document = {}
  if (options.allowDiskUse === true) out.allowDiskUse = true
  if (options.collation && Object.keys(options.collation).length) out.collation = toBson(options.collation)
  return out
}

export function checkPipeline(pipeline: unknown): asserts pipeline is JsonObject[] {
  if (!Array.isArray(pipeline)) throw invalid('A pipeline is an array of stages.')
  for (const [i, s] of pipeline.entries()) {
    if (!isObject(s) || Object.keys(s).length !== 1 || !Object.keys(s)[0]!.startsWith('$')) throw invalid(`Stage ${i + 1} must be a document with one stage name, like { $match: { … } }.`)
  }
}

function checkSpec(spec: QuerySpec, pageSize: number): void {
  if (!isObject(spec.filter)) throw invalid('The filter must be a document.')
  if (!Number.isInteger(spec.skip) || spec.skip < 0) throw invalid('Skip must be a whole number, 0 or more.')
  if (!Number.isInteger(spec.limit) || spec.limit < 0) throw invalid('Limit must be a whole number, 0 or more (0 is no limit).')
  if (!Number.isInteger(pageSize) || pageSize < 1 || pageSize > 1000) throw invalid('Page size must be from 1 to 1000.')
}

export class QuerySessions {
  private readonly sessions = new Map<string, Session>()
  private sweeper: ReturnType<typeof setInterval> | undefined

  constructor(private readonly client: (connectionId: string) => Promise<MongoClient>) {}

  private open(ns: Namespace, spec: QuerySpec, client: MongoClient, offset: number, pageSize: number): AbstractCursor<Document> {
    const coll = client.db(ns.db).collection(ns.collection)
    const cursor = coll.find(toBson(spec.filter), {
      ...EXACT,
      skip: spec.skip + offset,
      maxTimeMS: FIND_MAX_TIME_MS,
      batchSize: Math.min(pageSize + 1, 1000)
    })
    if (spec.limit > 0) cursor.limit(Math.max(spec.limit - offset, 0))
    if (spec.projection && Object.keys(spec.projection).length) cursor.project(toBson(spec.projection))
    if (spec.sort && Object.keys(spec.sort).length) cursor.sort(toBson(spec.sort))
    if (spec.collation && Object.keys(spec.collation).length) cursor.collation(toBson(spec.collation))
    return cursor
  }

  async page(queryId: string, ns: Namespace, spec: QuerySpec, offset: number, pageSize: number): Promise<QueryPage> {
    checkSpec(spec, pageSize)
    if (!Number.isInteger(offset) || offset < 0) throw invalid('The page offset must be 0 or more.')
    if (spec.limit > 0 && offset >= spec.limit) {
      await this.close(queryId)
      return { queryId, offset, docs: [], truncated: [], hasMore: false, stoppedForSize: false, ms: 0 }
    }
    return this.read(queryId, specKey(ns, spec), offset, pageSize, async () => this.open(ns, spec, await this.client(ns.connectionId), offset, pageSize))
  }

  /**
   * A page of an aggregation's results. Reading on uses the open cursor; any other page re-runs the
   * pipeline with a `$skip`. A pipeline that writes (`$out`, `$merge`) runs once, from offset 0
   * with a new query id, and is never re-run for a page.
   */
  async pageAggregate(queryId: string, ns: Namespace, pipeline: JsonObject[], options: AggOptions, offset: number, pageSize: number, first: boolean): Promise<QueryPage> {
    checkPipeline(pipeline)
    if (!Number.isInteger(pageSize) || pageSize < 1 || pageSize > 1000) throw invalid('Page size must be from 1 to 1000.')
    if (!Number.isInteger(offset) || offset < 0) throw invalid('The page offset must be 0 or more.')
    const key = pipelineKey(ns, pipeline, options)
    if (hasWriteStage(pipeline)) {
      if (!first || offset !== 0) {
        const s = this.sessions.get(queryId)
        if (!s || s.key !== key || s.next !== offset) throw invalid('This pipeline writes to a collection ($out or $merge), so it is not run again for a page. Run it again to repeat the write.', 'conflict')
      }
    }
    return this.read(queryId, key, offset, pageSize, async () => {
      const client = await this.client(ns.connectionId)
      const stages = offset > 0 ? [...pipeline, { $skip: offset }] : pipeline
      return client
        .db(ns.db)
        .collection(ns.collection)
        .aggregate(stages.map((st) => toBson<Document>(st)), { ...EXACT, ...aggregateOptions(options), maxTimeMS: FIND_MAX_TIME_MS, batchSize: Math.min(pageSize + 1, 1000) })
    })
  }

  private async read(queryId: string, key: string, offset: number, pageSize: number, open: () => Promise<AbstractCursor<Document>>): Promise<QueryPage> {
    const started = Date.now()
    let s = this.sessions.get(queryId)
    if (s && (s.key !== key || s.next !== offset)) {
      await this.close(queryId)
      s = undefined
    }
    if (!s) {
      s = { id: queryId, key, cursor: await open(), next: offset, lastUsed: Date.now() }
      this.sessions.set(queryId, s)
      this.startSweeper()
    }
    s.lastUsed = Date.now()
    const docs: JsonObject[] = []
    const truncated: number[] = []
    let bytes = 0
    let objects = 0
    let stoppedForSize = false
    try {
      while (docs.length < pageSize) {
        const raw = s.pending ?? (await s.cursor.next())
        s.pending = undefined
        if (raw === null) break
        const shown = pageDoc(raw)
        if (docs.length > 0 && (bytes + shown.bytes > PAGE_BYTE_BUDGET || objects + shown.objects > PAGE_OBJECT_BUDGET)) {
          s.pending = raw
          stoppedForSize = true
          break
        }
        if (shown.cut) truncated.push(docs.length)
        docs.push(shown.doc)
        bytes += shown.bytes
        objects += shown.objects
      }
      s.next = offset + docs.length
      const hasMore = s.pending !== undefined || (await s.cursor.hasNext())
      if (!hasMore) await this.close(queryId)
      return { queryId, offset, docs, truncated, hasMore, stoppedForSize, ms: Date.now() - started }
    } catch (error) {
      await this.close(queryId)
      throw error
    }
  }

  /** Counts an aggregation's results with a `$count` stage, with a time limit. */
  async countAggregate(ns: Namespace, pipeline: JsonObject[], options: AggOptions): Promise<CountResult> {
    checkPipeline(pipeline)
    const started = Date.now()
    if (hasWriteStage(pipeline)) return { count: null, approximate: false, ms: 0, error: 'A pipeline that writes is not counted.' }
    try {
      const client = await this.client(ns.connectionId)
      const [r] = await client
        .db(ns.db)
        .collection(ns.collection)
        .aggregate([...pipeline.map((st) => toBson<Document>(st)), { $count: 'n' }], { ...aggregateOptions(options), maxTimeMS: COUNT_MAX_TIME_MS })
        .toArray()
      return { count: r ? Number(r.n) : 0, approximate: false, ms: Date.now() - started }
    } catch (error) {
      const e = error as { code?: unknown; codeName?: unknown; message?: string }
      if (e.code === 50 || e.codeName === 'MaxTimeMSExpired') {
        return { count: null, approximate: false, ms: Date.now() - started, error: `Counting took longer than ${COUNT_MAX_TIME_MS / 1000} s, so it stopped.` }
      }
      return { count: null, approximate: false, ms: Date.now() - started, error: e.message ?? String(error) }
    }
  }

  async count(ns: Namespace, spec: QuerySpec): Promise<CountResult> {
    checkSpec(spec, 1)
    const client = await this.client(ns.connectionId)
    return countMatching(client.db(ns.db).collection(ns.collection), spec.filter, spec)
  }

  async close(queryId: string): Promise<void> {
    const s = this.sessions.get(queryId)
    if (!s) return
    this.sessions.delete(queryId)
    await s.cursor.close().catch(() => undefined)
    if (this.sessions.size === 0) this.stopSweeper()
  }

  /** Closes cursors on a connection that is going away. */
  async closeFor(connectionId: string): Promise<void> {
    const prefix = JSON.stringify([connectionId]).slice(0, -1)
    await Promise.all([...this.sessions.values()].filter((s) => s.key.startsWith(prefix)).map((s) => this.close(s.id)))
  }

  async closeAll(): Promise<void> {
    await Promise.all([...this.sessions.keys()].map((id) => this.close(id)))
  }

  private startSweeper(): void {
    if (this.sweeper) return
    this.sweeper = setInterval(() => {
      const now = Date.now()
      for (const s of this.sessions.values()) if (now - s.lastUsed > IDLE_CURSOR_MS) void this.close(s.id)
    }, 60_000)
    this.sweeper.unref?.()
  }

  private stopSweeper(): void {
    if (this.sweeper) clearInterval(this.sweeper)
    this.sweeper = undefined
  }
}

/**
 * Counts the documents a filter matches (after `skip`, within `limit`), with a time limit. An empty
 * filter reads the collection's metadata instead, instant but approximate, when the server allows
 * it. `primary` counts on the primary, where a write would go.
 */
export async function countMatching(
  coll: Collection,
  filter: JsonObject,
  options: { collation?: JsonObject; skip?: number; limit?: number; primary?: boolean } = {}
): Promise<CountResult> {
  const started = Date.now()
  const skip = options.skip ?? 0
  const limit = options.limit ?? 0
  const read: Document = options.primary ? { readPreference: 'primary' } : {}
  const within = (total: number): number => {
    const after = Math.max(total - skip, 0)
    return limit > 0 ? Math.min(after, limit) : after
  }
  try {
    if (Object.keys(filter).length === 0) {
      try {
        // Metadata only: instant even on a big collection. Views and some sharded setups refuse it.
        const n = await coll.estimatedDocumentCount({ maxTimeMS: COUNT_MAX_TIME_MS, ...read })
        return { count: within(n), approximate: true, ms: Date.now() - started }
      } catch {
        // fall through to an exact count
      }
    }
    const countOptions: Document = { maxTimeMS: COUNT_MAX_TIME_MS, ...read }
    if (skip) countOptions.skip = skip
    if (limit) countOptions.limit = limit
    if (options.collation && Object.keys(options.collation).length) countOptions.collation = toBson(options.collation)
    const n = await coll.countDocuments(toBson(filter), countOptions)
    return { count: n, approximate: false, ms: Date.now() - started }
  } catch (error) {
    const e = error as { code?: unknown; codeName?: unknown; message?: string }
    if (e.code === 50 || e.codeName === 'MaxTimeMSExpired') {
      return { count: null, approximate: false, ms: Date.now() - started, error: `Counting took longer than ${COUNT_MAX_TIME_MS / 1000} s, so it stopped.` }
    }
    return { count: null, approximate: false, ms: Date.now() - started, error: e.message ?? String(error) }
  }
}

// ---- Document writes ----

function sameId(a: JsonValue, b: JsonValue): boolean {
  return JSON.stringify(toCanonical({ v: toBson({ v: a } as JsonObject).v })) === JSON.stringify(toCanonical({ v: toBson({ v: b } as JsonObject).v }))
}

/** `{ _id }` as BSON, from its canonical Extended JSON. */
function idFilter(id: JsonValue): Document {
  return toBson<Document>({ _id: id })
}

function notFound(): Error {
  return invalid('That document is no longer there: it was deleted, or its _id changed. Run the query again.', 'conflict')
}

/** A path `$set` can take as dotted text: no empty keys, dots or leading `$`. */
function dottedPath(path: readonly (string | number)[]): string | undefined {
  for (const seg of path) {
    if (typeof seg === 'string' && (seg === '' || seg.includes('.') || seg.startsWith('$'))) return undefined
  }
  return path.map(String).join('.')
}

function setAtPath(doc: Document, path: readonly (string | number)[], value: unknown, remove: boolean): void {
  let cur: unknown = doc
  for (let i = 0; i < path.length - 1; i++) {
    const seg = path[i]!
    const next = (cur as Record<string | number, unknown>)[seg]
    if (typeof next !== 'object' || next === null) throw invalid(`There is no field at ${path.slice(0, i + 1).join('.')}. Run the query again.`, 'conflict')
    cur = next
  }
  const last = path[path.length - 1]!
  if (remove) {
    if (Array.isArray(cur) && typeof last === 'number') cur.splice(last, 1)
    else delete (cur as Record<string | number, unknown>)[last]
  } else (cur as Record<string | number, unknown>)[last] = value
}

function hasDollarKey(value: unknown, depth = 0): boolean {
  if (depth > 100 || typeof value !== 'object' || value === null) return false
  if (Array.isArray(value)) return value.some((v) => hasDollarKey(v, depth + 1))
  // BSON values (ObjectId, Long, ...) are classes; only plain documents have keys to check.
  if (Object.getPrototypeOf(value) !== Object.prototype) return false
  return Object.entries(value).some(([k, v]) => k.startsWith('$') || hasDollarKey(v, depth + 1))
}

function checkEditSize(doc: JsonObject): void {
  if (!fitsHost({ doc })) {
    const s = hostSize(doc)
    throw invalid(
      `This document is too big to edit here: as Extended JSON it is ${Math.round(s.bytes / 1024).toLocaleString('en-US')} KiB with ${s.objects.toLocaleString('en-US')} values, and Orca lets a panel send or receive at most 1 MiB and 10,000 values at once. Edit it with the shell.`,
      'too_large'
    )
  }
}

export async function getDocument(client: MongoClient, ns: Namespace, id: JsonValue): Promise<JsonObject | null> {
  const doc = await client.db(ns.db).collection(ns.collection).findOne(idFilter(id), { ...EXACT, maxTimeMS: FIND_MAX_TIME_MS })
  if (!doc) return null
  const canonical = toCanonical(doc)
  checkEditSize(canonical)
  return canonical
}

export async function updateField(
  client: MongoClient,
  ns: Namespace,
  id: JsonValue,
  path: (string | number)[],
  value: JsonValue | undefined,
  remove: boolean
): Promise<WriteResult> {
  if (path.length === 0) throw invalid('Choose a field to change.')
  if (path[0] === '_id') throw invalid("A document's _id can't change. Clone the document to give the copy a new _id.")
  if (!remove && value === undefined) throw invalid('There is no value to save.')
  const coll = client.db(ns.db).collection(ns.collection)
  const filter = idFilter(id)
  const bson = remove ? undefined : toBson<{ v: unknown }>({ v: value! } as JsonObject).v
  const dotted = dottedPath(path)
  if (dotted !== undefined && !(remove && typeof path[path.length - 1] === 'number')) {
    const update = remove ? { $unset: { [dotted]: '' } } : { $set: { [dotted]: bson } }
    const r = await coll.updateOne(filter, update)
    if (r.matchedCount === 0) throw notFound()
    return { matched: r.matchedCount, modified: r.modifiedCount }
  }
  // Keys with dots or a leading $, and removing an array item: change the document and replace it,
  // only if nobody changed it in between.
  const current = await coll.findOne(filter, EXACT)
  if (!current) throw notFound()
  const before = toCanonical(current)
  setAtPath(current, path, bson, remove)
  // `$literal` compares and writes the whole document even when its keys have dots or a leading $.
  const r = await coll.updateOne({ ...filter, $expr: { $eq: ['$$ROOT', { $literal: toBson<Document>(before) }] } }, [{ $replaceWith: { $literal: current } }])
  if (r.matchedCount === 0) throw invalid('The document changed while saving. Run the query again and retry.', 'conflict')
  return { matched: r.matchedCount, modified: r.modifiedCount }
}

export async function replaceDocument(client: MongoClient, ns: Namespace, id: JsonValue, doc: JsonObject): Promise<WriteResult> {
  checkEditSize(doc)
  if ('_id' in doc && !sameId(doc._id!, id)) throw invalid("A document's _id can't change. Clone the document to give the copy a new _id.")
  const bson = toBson<Document>(doc)
  delete bson._id
  const coll = client.db(ns.db).collection(ns.collection)
  // A replacement can't hold keys with a leading $; an update pipeline with $literal can.
  const r = hasDollarKey(bson)
    ? await coll.updateOne(idFilter(id), [{ $replaceWith: { $literal: { _id: idFilter(id)._id, ...bson } } }])
    : await coll.replaceOne(idFilter(id), bson)
  if (r.matchedCount === 0) throw notFound()
  return { matched: r.matchedCount, modified: r.modifiedCount }
}

export async function insertDocuments(client: MongoClient, ns: Namespace, docs: JsonObject[]): Promise<{ insertedIds: JsonValue[] }> {
  if (!Array.isArray(docs) || docs.length === 0) throw invalid('There is nothing to insert.')
  for (const d of docs) if (!isObject(d)) throw invalid('Each document must be written in { }.')
  const r = await client.db(ns.db).collection(ns.collection).insertMany(docs.map((d) => toBson<Document>(d)), { ordered: true })
  const ids = Object.keys(r.insertedIds)
    .sort((a, b) => Number(a) - Number(b))
    .map((k) => (toCanonical({ v: r.insertedIds[Number(k)] }) as { v: JsonValue }).v)
  return { insertedIds: ids }
}

export async function deleteDocuments(client: MongoClient, ns: Namespace, ids: JsonValue[]): Promise<{ deleted: number }> {
  if (!Array.isArray(ids) || ids.length === 0) throw invalid('Choose documents to delete.')
  if (ids.length > 10_000) throw invalid('Delete at most 10,000 documents at a time.')
  const values = ids.map((id) => toBson<{ v: unknown }>({ v: id } as JsonObject).v)
  const r = await client.db(ns.db).collection(ns.collection).deleteMany({ _id: { $in: values } } as Document)
  return { deleted: r.deletedCount }
}

// ---- History and saved queries ----

const HISTORY_MAX = 50
const TEXT_MAX = QUERY_TEXT_MAX
/** Orca refuses a storage value past 256 KiB; history gives way first. */
const LIBRARY_MAX_BYTES = 200 * 1024

function libraryKey(ns: Namespace): string {
  const hash = createHash('sha256').update(`${ns.db}\0${ns.collection}`).digest('hex').slice(0, 20)
  return `queries.v1.${ns.connectionId}.${hash}`
}

export function libraryPrefix(connectionId: string): string {
  return `queries.v1.${connectionId}.`
}

type StoredLibrary = QueryLibrary & { db: string; collection: string }

function cleanText(q: QueryText): QueryText {
  const field = (v: unknown): string => (typeof v === 'string' ? v.slice(0, TEXT_MAX) : '')
  return { filter: field(q.filter), projection: field(q.projection), sort: field(q.sort), collation: field(q.collation), skip: field(q.skip), limit: field(q.limit) }
}

function sameText(a: QueryText, b: QueryText): boolean {
  return (['filter', 'projection', 'sort', 'collation', 'skip', 'limit'] as const).every((k) => a[k].trim() === b[k].trim())
}

export class QueryLibraryStore {
  private queue: Promise<unknown> = Promise.resolve()

  constructor(private readonly orca: OrcaWorkerApi) {}

  private exclusive<T>(run: () => Promise<T>): Promise<T> {
    const next = this.queue.then(run, run)
    this.queue = next.catch(() => undefined)
    return next
  }

  async read(ns: Namespace): Promise<QueryLibrary> {
    const raw = (await this.orca.storage.get(libraryKey(ns))) as unknown as StoredLibrary | null
    return { history: Array.isArray(raw?.history) ? raw.history : [], saved: Array.isArray(raw?.saved) ? raw.saved : [] }
  }

  private async write(ns: Namespace, lib: QueryLibrary): Promise<QueryLibrary> {
    const stored: StoredLibrary = { db: ns.db, collection: ns.collection, history: [...lib.history], saved: lib.saved }
    while (hostSize(stored).bytes > LIBRARY_MAX_BYTES && stored.history.length > 0) stored.history.pop()
    if (hostSize(stored).bytes > LIBRARY_MAX_BYTES) throw invalid('The saved queries of this collection have reached their size limit. Delete some first.')
    lib = { history: stored.history, saved: stored.saved }
    await this.orca.storage.set(libraryKey(ns), JSON.parse(JSON.stringify(stored)) as WorkerJson)
    return lib
  }

  record(ns: Namespace, text: QueryText, at: number): Promise<QueryLibrary> {
    return this.exclusive(async () => {
      const lib = await this.read(ns)
      const query = cleanText(text)
      const history = [{ at, query }, ...lib.history.filter((h) => !sameText(h.query, query))].slice(0, HISTORY_MAX)
      return this.write(ns, { ...lib, history })
    })
  }

  clearHistory(ns: Namespace): Promise<QueryLibrary> {
    return this.exclusive(async () => this.write(ns, { ...(await this.read(ns)), history: [] }))
  }

  save(ns: Namespace, name: string, text: QueryText, at: number): Promise<QueryLibrary> {
    const clean = name.trim().slice(0, 200)
    if (!clean) return Promise.reject(invalid('Give the query a name.'))
    return this.exclusive(async () => {
      const lib = await this.read(ns)
      const entry: SavedQuery = { name: clean, at, query: cleanText(text) }
      const saved = [entry, ...lib.saved.filter((s) => s.name !== clean)].sort((a, b) => a.name.localeCompare(b.name))
      if (saved.length > 200) throw invalid('A collection keeps up to 200 saved queries. Delete some first.')
      return this.write(ns, { ...lib, saved })
    })
  }

  remove(ns: Namespace, name: string): Promise<QueryLibrary> {
    return this.exclusive(async () => {
      const lib = await this.read(ns)
      return this.write(ns, { ...lib, saved: lib.saved.filter((s) => s.name !== name) })
    })
  }

  /** Drops every library of a deleted connection. */
  async forget(connectionId: string): Promise<void> {
    const prefix = libraryPrefix(connectionId)
    for (const key of await this.orca.storage.keys()) if (key.startsWith(prefix)) await this.orca.storage.delete(key)
  }
}
