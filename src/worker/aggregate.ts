// The aggregation editor's worker side: a stage's preview (its input and output, a few documents
// each), explain plans for finds and pipelines, views made from a pipeline, and saved pipelines.
// Running and paging a whole pipeline is in query.ts, next to finds, so both share cursors.
import { createHash } from 'node:crypto'
import { BSON, type Document, type MongoClient } from 'mongodb'
import type { JsonValue as WorkerJson, OrcaWorkerApi } from 'orca/worker'
import type { AggOptions, ExplainResult, Namespace, PreviewDocs, PreviewResult, QuerySpec, SavedPipeline } from '../protocol'
import { isObject, type JsonObject } from '../shared/ejson-view'
import { summarizeExplain, type ExplainVerbosity } from '../shared/explain'
import { hostSize, HOST_MAX_OBJECTS } from '../shared/host-size'
import { hasWriteStage, type StageText } from '../shared/pipeline'
import { aggregateOptions, checkPipeline, EXACT, invalid, PAGE_BYTE_BUDGET, PAGE_OBJECT_BUDGET, pageDoc, toBson } from './query'

const { EJSON } = BSON

const PREVIEW_MAX_TIME_MS = 30_000
const EXPLAIN_MAX_TIME_MS = 120_000
export const PREVIEW_MAX = 100
/** Raw explain text past this is cut; the visual summary still covers the whole plan. */
const RAW_MAX_CHARS = 600_000
const VERBOSITIES = new Set<ExplainVerbosity>(['queryPlanner', 'executionStats', 'allPlansExecution'])

function bsonStages(pipeline: JsonObject[]): Document[] {
  return pipeline.map((s) => toBson<Document>(s))
}

// ---- Preview ----

async function sample(client: MongoClient, ns: Namespace, pipeline: JsonObject[], size: number, options: AggOptions, budget: { bytes: number; objects: number }): Promise<PreviewDocs> {
  const raw = await client
    .db(ns.db)
    .collection(ns.collection)
    .aggregate([...bsonStages(pipeline), { $limit: size + 1 }], { ...EXACT, ...aggregateOptions(options), maxTimeMS: PREVIEW_MAX_TIME_MS })
    .toArray()
  const out: PreviewDocs = { docs: [], truncated: [], more: raw.length > size, stoppedForSize: false }
  let bytes = 0
  let objects = 0
  for (const d of raw.slice(0, size)) {
    const shown = pageDoc(d)
    if (out.docs.length > 0 && (bytes + shown.bytes > budget.bytes || objects + shown.objects > budget.objects)) {
      out.stoppedForSize = true
      out.more = true
      break
    }
    if (shown.cut) out.truncated.push(out.docs.length)
    out.docs.push(shown.doc)
    bytes += shown.bytes
    objects += shown.objects
  }
  return out
}

/**
 * A stage's input (the stages before it) and output (with it), `size` documents each. With no
 * `stage`, only the input is read: the stage is off, or it writes.
 */
export async function previewStage(client: MongoClient, ns: Namespace, before: JsonObject[], stage: JsonObject | undefined, size: number, options: AggOptions): Promise<PreviewResult> {
  checkPipeline(before)
  if (stage !== undefined) checkPipeline([stage])
  if (!Number.isInteger(size) || size < 1 || size > PREVIEW_MAX) throw invalid(`A preview shows 1 to ${PREVIEW_MAX} documents.`)
  if (hasWriteStage(before) || (stage && hasWriteStage([stage]))) throw invalid('A preview never runs $out or $merge; run the whole pipeline to write.')
  const started = Date.now()
  const half = { bytes: Math.floor(PAGE_BYTE_BUDGET / 2), objects: Math.floor(PAGE_OBJECT_BUDGET / 2) }
  const [input, output] = await Promise.all([
    sample(client, ns, before, size, options, stage ? half : { bytes: PAGE_BYTE_BUDGET, objects: PAGE_OBJECT_BUDGET }),
    stage ? sample(client, ns, [...before, stage], size, options, half) : Promise.resolve(undefined)
  ])
  return output ? { input, output, ms: Date.now() - started } : { input, ms: Date.now() - started }
}

// ---- Explain ----

function checkVerbosity(v: unknown): ExplainVerbosity {
  if (!VERBOSITIES.has(v as ExplainVerbosity)) throw invalid('Verbosity is queryPlanner, executionStats or allPlansExecution.')
  return v as ExplainVerbosity
}

async function explain(client: MongoClient, ns: Namespace, command: Document, verbosity: ExplainVerbosity, kind: 'find' | 'aggregate', note?: string): Promise<ExplainResult> {
  const started = Date.now()
  const answer = await client.db(ns.db).command({ explain: { ...command, maxTimeMS: EXPLAIN_MAX_TIME_MS }, verbosity })
  delete answer.$clusterTime
  delete answer.operationTime
  const relaxed = EJSON.serialize(answer, { relaxed: true }) as JsonObject
  const summary = summarizeExplain(relaxed, kind)
  // A plan with thousands of branches: keep the tree, drop the per-stage details.
  if (hostSize(summary).objects > HOST_MAX_OBJECTS * 0.6) {
    const strip = (nodes: typeof summary.stages): void => {
      for (const n of nodes) {
        n.attrs = []
        strip(n.children)
      }
    }
    strip(summary.stages)
  }
  let raw = JSON.stringify(relaxed, null, 2)
  const rawCut = raw.length > RAW_MAX_CHARS
  if (rawCut) raw = `${raw.slice(0, RAW_MAX_CHARS)}\n… (cut: the whole plan is ${Math.round(raw.length / 1024).toLocaleString('en-US')} KiB)`
  const result: ExplainResult = { summary, raw, rawCut, verbosity, ms: Date.now() - started }
  if (note) result.note = note
  return result
}

export function explainFind(client: MongoClient, ns: Namespace, spec: QuerySpec, verbosity: unknown): Promise<ExplainResult> {
  const v = checkVerbosity(verbosity)
  if (!isObject(spec.filter)) throw invalid('The filter must be a document.')
  const command: Document = { find: ns.collection, filter: toBson(spec.filter) }
  if (spec.projection && Object.keys(spec.projection).length) command.projection = toBson(spec.projection)
  if (spec.sort && Object.keys(spec.sort).length) command.sort = toBson(spec.sort)
  if (spec.collation && Object.keys(spec.collation).length) command.collation = toBson(spec.collation)
  if (spec.skip) command.skip = spec.skip
  if (spec.limit) command.limit = spec.limit
  return explain(client, ns, command, v, 'find')
}

export function explainAggregate(client: MongoClient, ns: Namespace, pipeline: JsonObject[], options: AggOptions, verbosity: unknown): Promise<ExplainResult> {
  checkPipeline(pipeline)
  let v = checkVerbosity(verbosity)
  let note: string | undefined
  // Explaining with execution would run the write.
  if (hasWriteStage(pipeline) && v !== 'queryPlanner') {
    v = 'queryPlanner'
    note = 'This pipeline writes ($out or $merge), so it is explained without running it (queryPlanner).'
  }
  const command: Document = { aggregate: ns.collection, pipeline: bsonStages(pipeline), cursor: {}, ...aggregateOptions(options) }
  return explain(client, ns, command, v, 'aggregate', note)
}

// ---- Views ----

/** Checks a new collection or view name the way the server would, with clearer words. */
export function checkCollectionName(name: unknown): string {
  if (typeof name !== 'string' || !name.trim()) throw invalid('Name the view.')
  const n = name.trim()
  if (n.includes('$')) throw invalid('A collection or view name cannot contain $.')
  if (n.includes('\u0000')) throw invalid('A collection or view name cannot contain a null character.')
  if (n.startsWith('system.')) throw invalid('Names starting with system. are kept for MongoDB.')
  if (n.startsWith('.') || n.endsWith('.')) throw invalid('A name cannot start or end with a dot.')
  return n
}

export async function createView(client: MongoClient, ns: Namespace, name: unknown, pipeline: JsonObject[]): Promise<{ name: string }> {
  checkPipeline(pipeline)
  const n = checkCollectionName(name)
  if (hasWriteStage(pipeline)) throw invalid('A view cannot hold a $out or $merge stage. Remove it first.')
  const db = client.db(ns.db)
  const existing = await db.listCollections({ name: n }, { nameOnly: true }).toArray()
  if (existing.length) throw invalid(`${ns.db}.${n} already exists. Choose another name.`, 'conflict')
  await db.createCollection(n, { viewOn: ns.collection, pipeline: bsonStages(pipeline) })
  return { name: n }
}

// ---- Saved pipelines ----

const SAVED_MAX = 200
const BODY_MAX = 20_000
const LIBRARY_MAX_BYTES = 200 * 1024

function libraryKey(ns: Namespace): string {
  const hash = createHash('sha256').update(`${ns.db}\0${ns.collection}`).digest('hex').slice(0, 20)
  return `pipelines.v1.${ns.connectionId}.${hash}`
}

type StoredPipelines = { db: string; collection: string; saved: SavedPipeline[] }

function cleanStages(stages: unknown): StageText[] {
  if (!Array.isArray(stages)) throw invalid('A pipeline is a list of stages.')
  if (stages.length > 200) throw invalid('A saved pipeline keeps up to 200 stages.')
  return stages.map((s: Partial<StageText>) => ({
    op: typeof s?.op === 'string' ? s.op.slice(0, 100) : '$match',
    body: typeof s?.body === 'string' ? s.body.slice(0, BODY_MAX) : '',
    enabled: s?.enabled !== false
  }))
}

export class PipelineLibraryStore {
  private queue: Promise<unknown> = Promise.resolve()

  constructor(private readonly orca: OrcaWorkerApi) {}

  private exclusive<T>(run: () => Promise<T>): Promise<T> {
    const next = this.queue.then(run, run)
    this.queue = next.catch(() => undefined)
    return next
  }

  async read(ns: Namespace): Promise<{ saved: SavedPipeline[] }> {
    const raw = (await this.orca.storage.get(libraryKey(ns))) as unknown as StoredPipelines | null
    return { saved: Array.isArray(raw?.saved) ? raw.saved : [] }
  }

  private async write(ns: Namespace, saved: SavedPipeline[]): Promise<{ saved: SavedPipeline[] }> {
    const stored: StoredPipelines = { db: ns.db, collection: ns.collection, saved }
    if (hostSize(stored).bytes > LIBRARY_MAX_BYTES) throw invalid('The saved pipelines of this collection have reached their size limit. Delete some first.')
    await this.orca.storage.set(libraryKey(ns), JSON.parse(JSON.stringify(stored)) as WorkerJson)
    return { saved }
  }

  save(ns: Namespace, name: string, stages: unknown, at: number): Promise<{ saved: SavedPipeline[] }> {
    const clean = typeof name === 'string' ? name.trim().slice(0, 200) : ''
    if (!clean) return Promise.reject(invalid('Give the pipeline a name.'))
    const entry: SavedPipeline = { name: clean, at, stages: cleanStages(stages) }
    return this.exclusive(async () => {
      const { saved } = await this.read(ns)
      const next = [entry, ...saved.filter((s) => s.name !== clean)].sort((a, b) => a.name.localeCompare(b.name))
      if (next.length > SAVED_MAX) throw invalid(`A collection keeps up to ${SAVED_MAX} saved pipelines. Delete some first.`)
      return this.write(ns, next)
    })
  }

  remove(ns: Namespace, name: string): Promise<{ saved: SavedPipeline[] }> {
    return this.exclusive(async () => this.write(ns, (await this.read(ns)).saved.filter((s) => s.name !== name)))
  }

  async forget(connectionId: string): Promise<void> {
    const prefix = `pipelines.v1.${connectionId}.`
    for (const key of await this.orca.storage.keys()) if (key.startsWith(prefix)) await this.orca.storage.delete(key)
  }
}
