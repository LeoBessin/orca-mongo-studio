// Import from JSON (an array, one document per line as mongoexport writes, or documents one after
// another; Extended JSON in its relaxed or canonical form), CSV and TSV (a column mapping with
// types, inferred or given in a mongoimport-style header), and BSON (a mongodump `.bson` file, or a
// dump folder with one per collection, `.gz` included, and their `.metadata.json` for indexes and
// options). Sources are pasted text or a path the worker reads as a stream.
import { readdir, readFile, stat } from 'node:fs/promises'
import { basename, extname, join } from 'node:path'
import { Readable } from 'node:stream'
import { createGunzip, gunzipSync } from 'node:zlib'
import { BSON, type CreateCollectionOptions, type Document, type IndexDescription, type MongoClient } from 'mongodb'
import type { DataSource, ImportFormat, ImportOptions, ImportPreview, ImportResult, Namespace } from '../protocol'
import { columnsFor, CsvReader, guessDelimiter, mappingProblems, rowDocument, type CsvColumn } from '../shared/csv'
import type { JsonObject, JsonValue } from '../shared/ejson-view'
import { JsonRecordReader } from '../shared/json-records'
import { checkSignal, sourceBytes, sourceSize, type JobHandle, type Uploads } from './jobs'
import { EXACT, invalid, pageCanonical, toBson, toCanonical } from './query'
import { CollectionWriter } from './writer'

const { EJSON } = BSON
/** Rows read before the column types are fixed. */
export const INFER_ROWS = 1000
/** A BSON document is at most 16 MiB; a little more allows for a bad length to be caught. */
const BSON_DOC_MAX = 16 * 1024 * 1024 + 16 * 1024
const PREVIEW_MAX = 100
export const SYSTEM_DB = new Set(['admin', 'local', 'config'])

export type RecordItem = { record: number; doc?: Document; error?: string; size: number }
export type ReadState = { bytes: number; columns?: CsvColumn[]; notes: string[]; sampleRows: string[][] }

// ---- Formats ----

export function formatForName(name: string): { format?: ImportFormat; gzip: boolean } {
  let n = name.toLowerCase()
  const gzip = n.endsWith('.gz')
  if (gzip) n = n.slice(0, -3)
  const ext = extname(n)
  const format: ImportFormat | undefined =
    ext === '.json' || ext === '.jsonl' || ext === '.ndjson' ? 'json' : ext === '.csv' ? 'csv' : ext === '.tsv' || ext === '.tab' ? 'tsv' : ext === '.bson' ? 'bson' : undefined
  return format ? { format, gzip } : { gzip }
}

/** From the first bytes: JSON starts with { or [, BSON with a plausible length, else CSV. */
export function formatForBytes(head: Buffer): ImportFormat {
  const text = head.toString('utf8', 0, Math.min(head.length, 4096)).replace(/^﻿/, '')
  const first = text.trimStart()[0]
  if (head.length >= 5) {
    const len = head.readInt32LE(0)
    if (len >= 5 && len <= BSON_DOC_MAX && (len > head.length || head[len - 1] === 0) && head[4]! >= 1 && head[4]! <= 0x13 && !(first === '{' || first === '[')) return 'bson'
  }
  if (first === '{' || first === '[') return 'json'
  const line = text.split(/\r?\n/)[0] ?? ''
  return guessDelimiter(line) === '\t' ? 'tsv' : 'csv'
}

function parseJsonDocument(text: string): Document {
  const v = EJSON.parse(text, { relaxed: false }) as unknown
  if (typeof v !== 'object' || v === null || Array.isArray(v) || Object.getPrototypeOf(v) !== Object.prototype) throw new Error('not a document')
  return v as Document
}

/** A CSV cell of the `json` type: relaxed or canonical Extended JSON, as canonical. */
function parseJsonCell(s: string): JsonValue {
  return EJSON.serialize(EJSON.parse(s, { relaxed: false }), { relaxed: false }) as JsonValue
}

async function* counted(src: AsyncIterable<Buffer>, state: ReadState): AsyncGenerator<Buffer> {
  for await (const b of src) {
    state.bytes += b.length
    yield b
  }
}

async function* gunzip(src: AsyncIterable<Buffer>): AsyncGenerator<Buffer> {
  const input = Readable.from(src)
  const z = createGunzip()
  input.on('error', (e) => z.destroy(e))
  input.pipe(z)
  try {
    for await (const c of z) yield c as Buffer
  } finally {
    input.destroy()
    z.destroy()
  }
}

/** The documents of a source, each with its record number (1-based) or why it could not be read. */
export async function* readRecords(chunks: AsyncIterable<Buffer>, format: ImportFormat, options: ImportOptions, state: ReadState, gz = false): AsyncGenerator<RecordItem> {
  const raw = counted(chunks, state)
  const src = gz ? gunzip(raw) : raw
  let n = 0
  if (format === 'json') {
    const decoder = new TextDecoder('utf-8')
    const reader = new JsonRecordReader()
    const each = function* (records: { text: string; line: number }[]): Generator<RecordItem> {
      for (const r of records) {
        n++
        try {
          yield { record: n, doc: parseJsonDocument(r.text), size: r.text.length }
        } catch (error) {
          yield { record: n, error: `Line ${r.line}: ${error instanceof Error ? error.message : String(error)}`, size: r.text.length }
        }
      }
    }
    for await (const chunk of src) yield* each(reader.feed(decoder.decode(chunk, { stream: true })))
    yield* each(reader.feed(decoder.decode()))
    yield* each(reader.end())
    return
  }
  if (format === 'bson') {
    let buf: Buffer = Buffer.alloc(0)
    for await (const chunk of src) {
      buf = buf.length ? Buffer.concat([buf, chunk]) : chunk
      let at = 0
      while (buf.length - at >= 4) {
        const len = buf.readInt32LE(at)
        if (len < 5 || len > BSON_DOC_MAX) throw invalid(`Document ${n + 1} has a length of ${len} bytes: this is not a BSON file, or it is damaged.`)
        if (buf.length - at < len) break
        n++
        try {
          yield { record: n, doc: BSON.deserialize(buf.subarray(at, at + len), EXACT), size: len }
        } catch (error) {
          yield { record: n, error: `Document ${n}: ${error instanceof Error ? error.message : String(error)}`, size: len }
        }
        at += len
      }
      buf = buf.subarray(at)
    }
    if (buf.length) throw invalid(`The file ends in the middle of document ${n + 1}.`)
    return
  }
  // CSV and TSV
  const csv = options.csv ?? { delimiter: format === 'tsv' ? '\t' : ',', header: true, ignoreEmpty: false }
  const delimiter = format === 'tsv' ? '\t' : csv.delimiter || ','
  const reader = new CsvReader(delimiter)
  const decoder = new TextDecoder('utf-8')
  let header: string[] | undefined
  let columns = csv.columns
  if (columns) {
    const problems = mappingProblems(columns)
    if (problems.length) throw invalid(problems.join(' '))
    state.columns = columns
  }
  const pending: { row: string[]; line: number }[] = []
  const toDoc = (row: string[], line: number): RecordItem => {
    n++
    try {
      return { record: n, doc: toBson(rowDocument(columns!, row, csv.ignoreEmpty, parseJsonCell)), size: 0 }
    } catch (error) {
      return { record: n, error: `Line ${line}: ${error instanceof Error ? error.message : String(error)}`, size: 0 }
    }
  }
  const fix = (): void => {
    if (columns) return
    const made = columnsFor(csv.header ? header : undefined, pending.map((p) => p.row))
    columns = made.columns
    state.columns = columns
    state.notes.push(...made.notes)
  }
  const take = function* (rows: string[][], lines: number[]): Generator<RecordItem> {
    for (let i = 0; i < rows.length; i++) {
      const row = rows[i]!
      if (csv.header && !header) {
        header = row
        continue
      }
      if (state.sampleRows.length < INFER_ROWS) state.sampleRows.push(row)
      if (!columns) {
        pending.push({ row, line: lines[i]! })
        if (pending.length < INFER_ROWS) continue
        fix()
        for (const p of pending.splice(0)) yield toDoc(p.row, p.line)
        continue
      }
      yield toDoc(row, lines[i]!)
    }
  }
  for await (const chunk of src) {
    const r = reader.feed(decoder.decode(chunk, { stream: true }))
    yield* take(r.rows, r.lines)
  }
  const tail = reader.feed(decoder.decode())
  yield* take(tail.rows, tail.lines)
  const last = reader.end()
  yield* take(last.rows, last.lines)
  if (!columns) {
    if (pending.length === 0 && !header) return
    if (pending.length === 0 && header) {
      state.columns = columnsFor(header, []).columns
      return
    }
    fix()
    for (const p of pending.splice(0)) yield toDoc(p.row, p.line)
  }
}

// ---- Dump folders ----

export type DumpEntry = { name: string; file?: string; metadata?: string; gzip: boolean; bytes: number }

/** The collections of a mongodump folder: `<name>.bson[.gz]` with `<name>.metadata.json[.gz]`. */
export async function readDumpFolder(dir: string): Promise<DumpEntry[]> {
  const names = await readdir(dir, { withFileTypes: true })
  const files = names.filter((d) => d.isFile()).map((d) => d.name)
  const out = new Map<string, DumpEntry>()
  const decode = (s: string): string => {
    try {
      return decodeURIComponent(s)
    } catch {
      return s
    }
  }
  for (const f of files) {
    const m = /^(.*)\.(bson|metadata\.json)(\.gz)?$/.exec(f)
    if (!m) continue
    const name = decode(m[1]!)
    if (name.startsWith('system.')) continue
    const e = out.get(name) ?? { name, gzip: false, bytes: 0 }
    if (m[2] === 'bson') {
      e.file = join(dir, f)
      e.gzip = Boolean(m[3])
      e.bytes = (await stat(join(dir, f))).size
    } else e.metadata = join(dir, f)
    out.set(name, e)
  }
  return [...out.values()].sort((a, b) => a.name.localeCompare(b.name))
}

type Metadata = { indexes: Document[]; options: Document; type?: string }

export async function readMetadata(path: string): Promise<Metadata> {
  const raw = await readFile(path)
  const text = (path.endsWith('.gz') ? gunzipSync(raw) : raw).toString('utf8')
  const m = EJSON.parse(text, { relaxed: false }) as Document
  return { indexes: Array.isArray(m.indexes) ? (m.indexes as Document[]) : [], options: (m.options as Document | undefined) ?? {}, type: typeof m.type === 'string' ? m.type : undefined }
}

/** The metadata file next to a `.bson` file, if there is one. */
async function metadataBeside(path: string): Promise<string | undefined> {
  const base = path.replace(/\.gz$/, '').replace(/\.bson$/, '')
  for (const candidate of [`${base}.metadata.json`, `${base}.metadata.json.gz`]) {
    if (await stat(candidate).then(() => true, () => false)) return candidate
  }
  return undefined
}

/** Index definitions for createIndexes: without `v` and `ns`, and never `_id_`. */
export function indexDescriptions(specs: readonly Document[]): IndexDescription[] {
  return specs
    .filter((s) => s.name !== '_id_')
    .map((s) => {
      const { v: _v, ns: _ns, key, ...rest } = s
      return { key, ...rest } as IndexDescription
    })
}

/** Options a collection was created with that createCollection takes again. */
export function creationOptions(options: Document): CreateCollectionOptions {
  const { uuid: _uuid, ...rest } = options
  return rest as CreateCollectionOptions
}

// ---- Preview ----

export async function previewImport(source: DataSource, options: ImportOptions, size: number, uploads: Uploads): Promise<ImportPreview> {
  const n = Math.max(1, Math.min(PREVIEW_MAX, Math.floor(size) || 5))
  const info = await sourceSize(source, uploads)
  const signal = new AbortController().signal
  if (info.folder) {
    const entries = await readDumpFolder(info.path!)
    if (entries.length === 0) throw invalid('This folder holds no .bson files. Give the folder mongodump wrote for one database.')
    return {
      docs: [],
      notes: [`A dump folder: ${entries.length} collection${entries.length === 1 ? '' : 's'}, each into a collection of the same name.`],
      errors: [],
      folder: entries.map((e) => ({ name: e.name, file: e.file ? basename(e.file) : '(view or no data)', bytes: e.bytes, metadata: Boolean(e.metadata) })),
      format: 'bson'
    }
  }
  const named = source.kind === 'path' ? formatForName(source.path) : { gzip: false }
  let format = options.format === 'auto' ? named.format : options.format
  if (!format) {
    const head = await firstBytes(source, uploads, named.gzip)
    format = formatForBytes(head)
  }
  const state: ReadState = { bytes: 0, notes: [], sampleRows: [] }
  const docs: JsonObject[] = []
  const errors: ImportPreview['errors'] = []
  const opts = { ...options, csv: options.csv ? { ...options.csv, ...(format === 'tsv' ? { delimiter: '\t' } : {}) } : undefined }
  const gen = readRecords(sourceBytes(source, uploads, signal), format, opts as ImportOptions, state, named.gzip)
  let budget = 0
  try {
    for await (const r of gen) {
      if (r.error) errors.push({ record: r.record, message: r.error })
      else if (docs.length < n) {
        const p = pageCanonical(toCanonical(r.doc!))
        budget += p.bytes
        if (budget > 600 * 1024) break
        docs.push(p.doc)
      }
      if (docs.length >= n && (format === 'json' || format === 'bson' || state.columns)) break
      if (errors.length >= 20) break
    }
  } catch (error) {
    errors.push({ record: 0, message: error instanceof Error ? error.message : String(error) })
  } finally {
    await gen.return(undefined)
  }
  const out: ImportPreview = { docs, notes: state.notes, errors, format, bytes: info.bytes }
  if (named.gzip) out.gzip = true
  if (state.columns && (format === 'csv' || format === 'tsv')) {
    out.columns = state.columns.map((c, i) => ({ ...c, samples: state.sampleRows.map((r) => r[i] ?? '').filter((v) => v !== '').slice(0, 5) }))
  }
  return out
}

async function firstBytes(source: DataSource, uploads: Uploads, gz: boolean): Promise<Buffer> {
  const ac = new AbortController()
  const src = sourceBytes(source, uploads, ac.signal)
  const gen = gz ? gunzip(src) : src
  try {
    for await (const b of gen) return b.subarray(0, 8192)
  } finally {
    await gen.return(undefined)
  }
  return Buffer.alloc(0)
}

// ---- Import ----

async function collectionExists(client: MongoClient, db: string, name: string): Promise<boolean> {
  return (await client.db(db).listCollections({ name }, { nameOnly: true }).toArray()).length > 0
}

export function checkTarget(ns: { db: string; collection?: string }): void {
  if (!ns.db || /[/\\. "$]/.test(ns.db)) throw invalid('Enter a database name without spaces, dots, slashes or $.')
  if (SYSTEM_DB.has(ns.db)) throw invalid(`Mongo Studio does not write into the ${ns.db} database.`)
  if (ns.collection !== undefined) {
    if (!ns.collection) throw invalid('Enter a collection name.')
    if (ns.collection.includes('$') || ns.collection.startsWith('system.')) throw invalid('Collection names can\'t contain $ or start with "system.".')
  }
}

export async function runImport(client: MongoClient, source: DataSource, options: ImportOptions, ns: Namespace, uploads: Uploads, job: JobHandle): Promise<ImportResult> {
  checkTarget({ db: ns.db, ...(ns.collection ? { collection: ns.collection } : {}) })
  const info = await sourceSize(source, uploads)
  const result: ImportResult = { kind: 'import', read: 0, inserted: 0, updated: 0, failed: 0, collections: [] }
  if (info.folder) {
    const entries = await readDumpFolder(info.path!)
    if (entries.length === 0) throw invalid('This folder holds no .bson files.')
    const total = entries.reduce((n, e) => n + e.bytes, 0)
    job.progress({ total, done: 0 })
    let before = 0
    for (const e of entries) {
      checkSignal(job.signal)
      await importOne(client, { kind: 'path', path: e.file ?? '' }, { ...options, format: 'bson' }, { ...ns, collection: e.name }, uploads, job, result, { file: e.file, metadata: e.metadata, gzip: e.gzip, before })
      before += e.bytes
      if (job.errorCount && options.stopOnError) break
    }
    return result
  }
  job.progress({ total: info.bytes, done: 0 })
  await importOne(client, source, options, ns, uploads, job, result, { file: info.path, metadata: info.path && (options.format === 'bson' || options.format === 'auto') ? await metadataBeside(info.path) : undefined, gzip: info.path ? formatForName(info.path).gzip : false, before: 0 })
  return result
}

async function importOne(
  client: MongoClient,
  source: DataSource,
  options: ImportOptions,
  ns: Namespace,
  uploads: Uploads,
  job: JobHandle,
  result: ImportResult,
  where: { file?: string; metadata?: string; gzip: boolean; before: number }
): Promise<void> {
  const label = `${ns.db}.${ns.collection}`
  const db = client.db(ns.db)
  const coll = db.collection(ns.collection)
  let format: ImportFormat | undefined = options.format === 'auto' ? (where.file ? formatForName(where.file).format : undefined) : options.format
  if (!format) format = formatForBytes(await firstBytes(source, uploads, where.gzip))
  const meta = format === 'bson' && where.metadata ? await readMetadata(where.metadata).catch((error: unknown) => {
    job.error({ ns: label, message: `Could not read ${basename(where.metadata!)}: ${error instanceof Error ? error.message : String(error)}` })
    return undefined
  }) : undefined
  if (options.drop) {
    job.progress({ phase: `Dropping ${label}` })
    await coll.drop().catch((error: { codeName?: string }) => {
      if (error.codeName !== 'NamespaceNotFound') throw error
    })
  }
  if (meta?.type === 'view') {
    if (!(await collectionExists(client, ns.db, ns.collection))) await db.createCollection(ns.collection, creationOptions(meta.options))
    result.collections.push(ns.collection)
    return
  }
  if (!where.file && source.kind === 'path') return
  if (meta && Object.keys(meta.options).length && !(await collectionExists(client, ns.db, ns.collection))) {
    await db.createCollection(ns.collection, creationOptions(meta.options))
  }
  result.collections.push(ns.collection)
  const state: ReadState = { bytes: 0, notes: [], sampleRows: [] }
  let written = 0
  const phase = (): string => `Importing into ${label}: ${written.toLocaleString('en-US')} documents`
  const writer = new CollectionWriter(coll, options.mode, options.stopOnError, job, label, (n) => {
    written += n
    job.progress({ phase: phase(), done: where.before + state.bytes })
  })
  job.progress({ phase: phase() })
  const gen = readRecords(sourceBytes(source, uploads, job.signal), format, { ...options, format }, state, where.gzip)
  try {
    for await (const r of gen) {
      result.read++
      if (r.error) {
        result.failed++
        job.error({ record: r.record, ns: label, message: r.error })
        if (options.stopOnError) break
        continue
      }
      await writer.add(r.doc!, r.record, r.size)
      if (writer.stopped) break
    }
    await writer.flush()
  } finally {
    await gen.return(undefined)
    result.inserted += writer.counts.inserted
    result.updated += writer.counts.updated
    result.failed += writer.counts.failed
  }
  if (meta && options.indexes && !job.signal.aborted) {
    const specs = indexDescriptions(meta.indexes)
    if (specs.length) {
      job.progress({ phase: `Creating ${specs.length} index${specs.length === 1 ? '' : 'es'} on ${label}` })
      await coll.createIndexes(specs).catch((error: unknown) => job.error({ ns: label, message: `Indexes: ${error instanceof Error ? error.message : String(error)}` }))
    }
  }
  job.progress({ done: where.before + state.bytes })
}
