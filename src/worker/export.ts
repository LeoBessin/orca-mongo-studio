// Export a find, a pipeline or a whole database: to JSON (one document per line as mongoexport
// writes, or an array; relaxed or canonical Extended JSON), CSV (chosen dotted fields), BSON (as
// mongodump writes it, with `.metadata.json` for indexes and options), or into a collection on any
// saved connection (copy, and paste between connections). Files go to the save dialog (64 MiB at
// most) or to a path the worker writes.
import { stat } from 'node:fs/promises'
import { join } from 'node:path'
import { BSON, type AbstractCursor, type Document, type MongoClient } from 'mongodb'
import type { ExportDestination, ExportOptions, ExportResult, ExportSource, Namespace } from '../protocol'
import { csvLine, csvRow } from '../shared/csv'
import { fieldPaths, isObject, type JsonObject } from '../shared/ejson-view'
import { hasWriteStage } from '../shared/pipeline'
import { checkPath, checkSignal, ensureFolder, FileSink, Outbox, type JobHandle, type Sink } from './jobs'
import { checkTarget, creationOptions, indexDescriptions } from './import'
import { aggregateOptions, checkPipeline, COUNT_MAX_TIME_MS, EXACT, invalid, toBson, toCanonical } from './query'
import { CollectionWriter } from './writer'

const { EJSON } = BSON
/** Documents read to choose CSV columns when none are given. */
const CSV_FIELD_SAMPLE = 1000

type Part = { name: string; collection?: string; kind: 'collection' | 'view' | 'timeseries'; options: Document; cursor: () => AbstractCursor<Document>; total: () => Promise<number | null> }

/** What an export reads: one cursor, or one per collection of a database. */
async function sourceParts(client: MongoClient, source: ExportSource): Promise<{ parts: Part[]; db: string; connectionId: string }> {
  if (source.kind === 'database') {
    const db = client.db(source.db)
    const infos = (await db.listCollections({}, { authorizedCollections: true }).toArray()) as { name: string; type?: string; options?: Document }[]
    const wanted = source.collections ? new Set(source.collections) : undefined
    const parts = infos
      .filter((c) => !c.name.startsWith('system.') && (!wanted || wanted.has(c.name)))
      .sort((a, b) => a.name.localeCompare(b.name))
      .map((c): Part => {
        const kind = c.type === 'view' ? 'view' : c.type === 'timeseries' ? 'timeseries' : 'collection'
        const coll = db.collection(c.name)
        return {
          name: c.name,
          collection: c.name,
          kind,
          options: c.options ?? {},
          cursor: () => coll.find({}, { ...EXACT }),
          total: () => coll.estimatedDocumentCount({ maxTimeMS: COUNT_MAX_TIME_MS }).catch(() => null)
        }
      })
    return { parts, db: source.db, connectionId: source.connectionId }
  }
  const ns = source.ns
  const coll = client.db(ns.db).collection(ns.collection)
  const info = (await client.db(ns.db).listCollections({ name: ns.collection }).toArray())[0] as { type?: string; options?: Document } | undefined
  const kind = info?.type === 'view' ? 'view' : info?.type === 'timeseries' ? 'timeseries' : 'collection'
  if (source.kind === 'pipeline') {
    checkPipeline(source.pipeline)
    if (hasWriteStage(source.pipeline)) throw invalid('This pipeline writes with $out or $merge: run it in the aggregation tab, then export the collection it writes.')
    const pipeline = source.pipeline.map((s) => toBson<Document>(s))
    return {
      parts: [{ name: ns.collection, kind: 'collection', options: {}, cursor: () => coll.aggregate(pipeline, { ...EXACT, ...aggregateOptions(source.options ?? {}) }), total: async () => null }],
      db: ns.db,
      connectionId: ns.connectionId
    }
  }
  const spec = source.spec
  const filter = toBson<Document>(spec.filter ?? {})
  const findOptions: Document = { ...EXACT }
  if (spec.projection && Object.keys(spec.projection).length) findOptions.projection = toBson(spec.projection)
  if (spec.sort && Object.keys(spec.sort).length) findOptions.sort = toBson(spec.sort)
  if (spec.collation && Object.keys(spec.collation).length) findOptions.collation = toBson(spec.collation)
  if (spec.skip) findOptions.skip = spec.skip
  if (spec.limit) findOptions.limit = spec.limit
  const whole = Object.keys(filter).length === 0 && !spec.skip && !spec.limit && !findOptions.projection
  return {
    parts: [
      {
        name: ns.collection,
        collection: ns.collection,
        kind,
        options: whole ? (info?.options ?? {}) : {},
        cursor: () => coll.find(filter, findOptions),
        total: async () => {
          try {
            if (Object.keys(filter).length === 0) {
              const n = await coll.estimatedDocumentCount({ maxTimeMS: COUNT_MAX_TIME_MS })
              const after = Math.max(0, n - (spec.skip ?? 0))
              return spec.limit ? Math.min(spec.limit, after) : after
            }
            return await coll.countDocuments(filter, { maxTimeMS: COUNT_MAX_TIME_MS, ...(spec.skip ? { skip: spec.skip } : {}), ...(spec.limit ? { limit: spec.limit } : {}) })
          } catch {
            return null
          }
        }
      }
    ],
    db: ns.db,
    connectionId: ns.connectionId
  }
}

// ---- Encoders ----

type Encoder = { ext: string; mimeType: string; begin(): Buffer | undefined; doc(d: Document): Buffer | undefined; end(): Buffer | undefined }

function jsonEncoder(o: NonNullable<ExportOptions['json']>): Encoder {
  let first = true
  const text = (d: Document): string => EJSON.stringify(d, { relaxed: o.relaxed }, o.pretty ? 2 : undefined)
  if (o.layout === 'array') {
    return {
      ext: 'json',
      mimeType: 'application/json',
      begin: () => Buffer.from('['),
      doc: (d) => {
        const s = `${first ? '\n' : ',\n'}${o.pretty ? text(d).replace(/^/gm, '  ') : text(d)}`
        first = false
        return Buffer.from(s)
      },
      end: () => Buffer.from(first ? ']\n' : '\n]\n')
    }
  }
  return { ext: 'json', mimeType: 'application/x-ndjson', begin: () => undefined, doc: (d) => Buffer.from(`${text(d)}\n`), end: () => undefined }
}

function bsonEncoder(): Encoder {
  return { ext: 'bson', mimeType: 'application/octet-stream', begin: () => undefined, doc: (d) => Buffer.from(BSON.serialize(d)), end: () => undefined }
}

/** CSV with the given fields, or (none given) the fields of the first documents, in the order met. */
function csvEncoder(o: NonNullable<ExportOptions['csv']>): Encoder & { needsFields: boolean; setFields(docs: JsonObject[]): void } {
  let fields = o.fields.map((f) => f.trim()).filter(Boolean)
  const delimiter = o.delimiter || ','
  return {
    ext: delimiter === '\t' ? 'tsv' : 'csv',
    mimeType: delimiter === '\t' ? 'text/tab-separated-values' : 'text/csv',
    needsFields: fields.length === 0,
    setFields(docs) {
      const seen = new Set<string>()
      for (const d of docs) fieldPaths(d, '', seen)
      const all = [...seen]
      fields = all.filter((f) => !all.some((g) => g.startsWith(`${f}.`)))
      this.needsFields = false
    },
    begin: () => (o.header ? Buffer.from(csvLine(fields, delimiter)) : undefined),
    doc: (d) => Buffer.from(csvRow(toCanonical(d), fields, delimiter)),
    end: () => undefined
  }
}

function encoderFor(options: ExportOptions): Encoder {
  if (options.format === 'json') return jsonEncoder(options.json ?? { layout: 'lines', relaxed: true, pretty: false })
  if (options.format === 'csv') return csvEncoder(options.csv ?? { fields: [], delimiter: ',', header: true })
  return bsonEncoder()
}

/** mongodump's `<name>.metadata.json`: indexes and options, canonical Extended JSON. */
async function metadataJson(client: MongoClient, db: string, part: Part): Promise<string> {
  const indexes = part.kind === 'view' ? [] : await client.db(db).collection(part.name).listIndexes().toArray().catch(() => [])
  return EJSON.stringify({ indexes, uuid: '', collectionName: part.name, type: part.kind === 'view' ? 'view' : part.kind === 'timeseries' ? 'timeseries' : 'collection', options: part.options }, { relaxed: false })
}

// ---- Running ----

async function writeDocs(cursor: AbstractCursor<Document>, enc: Encoder, sink: Sink, job: JobHandle): Promise<number> {
  let n = 0
  const csv = enc as ReturnType<typeof csvEncoder>
  const held: Document[] = []
  try {
    if (csv.needsFields) {
      // next(), not for-await: leaving a for-await loop would close the cursor.
      while (held.length < CSV_FIELD_SAMPLE) {
        const d = await cursor.next()
        if (!d) break
        held.push(d)
      }
      csv.setFields(held.map((d) => toCanonical(d)))
    }
    const head = enc.begin()
    if (head) await sink.write(head)
    let pending = 0
    const each = async (d: Document): Promise<void> => {
      checkSignal(job.signal)
      const b = enc.doc(d)
      if (b) await sink.write(b)
      n++
      if (++pending >= 500) {
        job.advance(pending)
        pending = 0
      }
    }
    for (const d of held) await each(d)
    for await (const d of cursor) await each(d)
    job.advance(pending)
    const tail = enc.end()
    if (tail) await sink.write(tail)
  } finally {
    await cursor.close().catch(() => undefined)
  }
  return n
}

export async function runExport(client: MongoClient, target: (connectionId: string) => Promise<MongoClient>, source: ExportSource, options: ExportOptions, destination: ExportDestination, job: JobHandle): Promise<ExportResult> {
  const { parts, db } = await sourceParts(client, source)
  if (parts.length === 0) throw invalid('There is nothing to export: the database has no collections you can read.')
  job.progress({ phase: 'Counting documents' })
  // A dump keeps a view as its definition only, and a copy of a database recreates it: no documents.
  const totals = await Promise.all(parts.map((p) => (p.kind === 'view' && source.kind === 'database' && options.format !== 'json' && options.format !== 'csv' ? 0 : p.total())))
  job.progress({ total: totals.every((t) => t !== null) ? totals.reduce<number>((a, b) => a + (b ?? 0), 0) : null, done: 0 })
  const result: ExportResult = { kind: 'export', docs: 0, collections: 0, bytes: 0 }
  if (options.format === 'collection') return copyParts(client, await target(options.collection?.connectionId ?? ''), source, parts, db, options, job, result)

  const many = source.kind === 'database'
  if (destination.kind === 'download') {
    if (many) throw invalid('A whole database is written to a folder (give a path), or copied into another database.')
    const part = parts[0]!
    const enc = encoderFor(options)
    const box = new Outbox()
    job.progress({ phase: `Exporting ${db}.${part.name}` })
    result.docs = await writeDocs(part.cursor(), enc, box, job)
    result.collections = 1
    result.bytes = box.bytes
    result.download = { name: `${part.name}.${enc.ext}`, mimeType: enc.mimeType, size: box.bytes }
    job.keep(box)
    return result
  }
  const base = checkPath(destination.path)
  const isFolder = many || (await stat(base).then((s) => s.isDirectory(), () => false))
  if (many) await ensureFolder(base)
  result.written = []
  for (const part of parts) {
    checkSignal(job.signal)
    const enc = encoderFor(options)
    const file = isFolder ? join(base, `${encodeName(part.name)}.${enc.ext}`) : base
    job.progress({ phase: `Exporting ${db}.${part.name}` })
    if (part.kind === 'view' && options.format === 'bson' && many) {
      // mongodump keeps a view as its metadata only.
      if (options.bson?.metadata) await writeText(join(base, `${encodeName(part.name)}.metadata.json`), await metadataJson(client, db, part), destination.overwrite, result)
      continue
    }
    const sink = await FileSink.open(file, destination.overwrite)
    try {
      result.docs += await writeDocs(part.cursor(), enc, sink, job)
      await sink.finish()
    } catch (error) {
      await sink.abort()
      throw error
    }
    result.bytes += sink.bytes
    result.collections++
    result.written.push(file)
    if (options.format === 'bson' && options.bson?.metadata && part.collection) {
      await writeText(file.replace(/\.bson$/, '') + '.metadata.json', await metadataJson(client, db, part), destination.overwrite, result)
    }
  }
  return result
}

/** Names in a folder: a slash or a NUL can't be in a file name (mongodump %-encodes them too). */
function encodeName(name: string): string {
  return name.replace(/[/\\\0%]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase().padStart(2, '0')}`)
}

async function writeText(path: string, text: string, overwrite: boolean, result: ExportResult): Promise<void> {
  const sink = await FileSink.open(path, overwrite)
  try {
    await sink.write(Buffer.from(text))
    await sink.finish()
  } catch (error) {
    await sink.abort()
    throw error
  }
  result.written?.push(path)
}

async function copyParts(source: MongoClient, target: MongoClient, from: ExportSource, parts: Part[], db: string, options: ExportOptions, job: JobHandle, result: ExportResult): Promise<ExportResult> {
  const o = options.collection
  if (!o) throw invalid('Choose the collection to copy into.')
  const many = from.kind === 'database'
  const toDb = o.db.trim()
  checkTarget({ db: toDb })
  result.inserted = 0
  result.updated = 0
  result.failed = 0
  result.indexes = 0
  const sameServer = source === target
  for (const part of parts) {
    checkSignal(job.signal)
    const toName = many ? part.name : (o.collection ?? '').trim()
    checkTarget({ db: toDb, collection: toName })
    if (sameServer && toDb === db && toName === part.name) throw invalid(`${db}.${part.name} would be copied onto itself. Choose another database or collection name.`)
    const label = `${toDb}.${toName}`
    const tdb = target.db(toDb)
    const coll = tdb.collection(toName)
    if (o.mode === 'replace') {
      job.progress({ phase: `Dropping ${label}` })
      await coll.drop().catch((error: { codeName?: string }) => {
        if (error.codeName !== 'NamespaceNotFound') throw error
      })
    }
    const exists = (await tdb.listCollections({ name: toName }, { nameOnly: true }).toArray()).length > 0
    if (part.kind === 'view' && many) {
      if (!exists) await tdb.createCollection(toName, creationOptions(part.options))
      else job.error({ ns: label, message: 'A collection of this name exists already, so the view was not copied.' })
      result.collections++
      continue
    }
    if (!exists && (o.options || part.kind === 'timeseries') && part.kind !== 'view' && Object.keys(part.options).length) {
      await tdb.createCollection(toName, creationOptions(part.options))
    }
    job.progress({ phase: `Copying ${db}.${part.name} to ${label}` })
    const writer = new CollectionWriter(coll, o.mode === 'replace' ? 'insert' : o.mode, false, job, label)
    const cursor = part.cursor()
    let n = 0
    try {
      for await (const d of cursor) {
        n++
        await writer.add(d, n)
      }
      await writer.flush()
    } finally {
      await cursor.close().catch(() => undefined)
    }
    result.docs += n
    result.inserted += writer.counts.inserted
    result.updated += writer.counts.updated
    result.failed += writer.counts.failed
    result.collections++
    if (o.indexes && part.collection && part.kind !== 'view') {
      const specs = indexDescriptions(await source.db(db).collection(part.name).listIndexes().toArray().catch(() => []))
      if (specs.length) {
        job.progress({ phase: `Creating ${specs.length} index${specs.length === 1 ? '' : 'es'} on ${label}` })
        try {
          await coll.createIndexes(specs)
          result.indexes += specs.length
        } catch (error) {
          job.error({ ns: label, message: `Indexes: ${error instanceof Error ? error.message : String(error)}` })
        }
      }
    }
  }
  return result
}

/** Dotted fields of a sample of documents, for choosing CSV columns. */
export async function sampleFields(client: MongoClient, ns: Namespace, filter?: JsonObject): Promise<string[]> {
  const pipeline: Document[] = []
  if (filter && Object.keys(filter).length) pipeline.push({ $match: toBson<Document>(filter) })
  pipeline.push({ $sample: { size: 200 } })
  const docs = await client.db(ns.db).collection(ns.collection).aggregate(pipeline, { ...EXACT, maxTimeMS: 30_000 }).toArray()
  const out = new Set<string>()
  for (const d of docs) fieldPaths(toCanonical(d), '', out)
  // Leaves only: a sub-document's fields stand for it.
  const all = [...out]
  return all.filter((f) => !all.some((g) => g.startsWith(`${f}.`))).sort((a, b) => (a === '_id' ? -1 : b === '_id' ? 1 : 0))
}
