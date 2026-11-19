// Update many: how many documents a scope reaches, one of them before and after the change, and
// the `updateMany` itself (run as a job, so a long one isn't cut off by Orca's request limit).
// The "after" comes from the server, never from a copy of its rules: the update runs on the sample
// with `updateOne`, inside a transaction that is always aborted, so nothing is saved and every
// error the real update would raise shows. A standalone server has no transactions: there an
// update pipeline runs as an aggregation instead, and update operators show the "before" only.
// Everything reads from the primary, where the update itself goes.
import type { ClientSession, CollationOptions, Document, MongoClient } from 'mongodb'
import type { Namespace, UpdatePreview, WriteResult } from '../protocol'
import { diffDocuments } from '../shared/compare'
import type { JsonObject } from '../shared/ejson-view'
import { fitsHost } from '../shared/host-size'
import { scopeFilter, scopeProblem, updateProblem, type UpdateScope, type UpdateSpec } from '../shared/update-spec'
import { countMatching, EXACT, FIND_MAX_TIME_MS, invalid, pageCanonical, toBson, toCanonical } from './query'

/** Field differences listed for the sample; the documents themselves show the rest. */
const DIFFS_MAX = 100
const PRIMARY = { readPreference: 'primary' } as const

/** Refuses a scope or update that can't be sent, before anything runs. */
export function checkUpdate(scope: UpdateScope, update: UpdateSpec): void {
  const s = scopeProblem(scope)
  if (s) throw invalid(s)
  const u = updateProblem(update)
  if (u) throw invalid(u)
}

function filterOf(scope: UpdateScope): Document {
  return toBson<Document>(scopeFilter(scope))
}

function collationOf(scope: UpdateScope): CollationOptions | undefined {
  return scope.kind === 'filter' && scope.collation && Object.keys(scope.collation).length ? toBson<CollationOptions>(scope.collation) : undefined
}

function updateOf(update: UpdateSpec): Document | Document[] {
  return Array.isArray(update) ? update.map((s) => toBson<Document>(s)) : toBson<Document>(update)
}

type ServerError = { code?: unknown; codeName?: unknown; message?: string }

function messageOf(error: unknown): string {
  return (error as ServerError).message ?? String(error)
}

/** The server can't run a transaction here: a standalone server, or a collection that refuses
 *  writes in one (time-series, capped on old servers, system collections). */
function noTransaction(error: unknown): boolean {
  const e = error as ServerError
  return (
    e.code === 20 ||
    e.code === 263 ||
    e.codeName === 'OperationNotSupportedInTransaction' ||
    /Transaction numbers are only allowed|transactions are not supported|not supported in (a )?(multi-document )?transaction/i.test(e.message ?? '')
  )
}

type Tried = { after?: Document; note?: string; error?: string }
const GONE = 'The document was deleted while previewing.'

/** Runs the update on one document in a transaction, reads it back, and aborts. The transaction's
 *  options are set here, not taken from the connection: a transaction reads only from the primary,
 *  and refuses an unacknowledged write concern. */
async function tryInTransaction(client: MongoClient, ns: Namespace, id: unknown, update: UpdateSpec, collation: CollationOptions | undefined): Promise<Tried | 'no-transaction'> {
  const coll = client.db(ns.db).collection(ns.collection)
  let session: ClientSession | undefined
  try {
    session = client.startSession()
    session.startTransaction({ ...PRIMARY, readConcern: { level: 'snapshot' }, writeConcern: { w: 'majority' } })
    const r = await coll.updateOne({ _id: id } as Document, updateOf(update), { session, ...(collation ? { collation } : {}) })
    if (r.matchedCount === 0) return { error: GONE }
    const after = await coll.findOne({ _id: id } as Document, { ...EXACT, session })
    return after ? { after } : { error: GONE }
  } catch (error) {
    return noTransaction(error) ? 'no-transaction' : { error: messageOf(error) }
  } finally {
    if (session) {
      if (session.inTransaction()) await session.abortTransaction().catch(() => undefined)
      await session.endSession().catch(() => undefined)
    }
  }
}

/** The sample document as the update would leave it, or why that isn't known. */
async function sampleAfter(client: MongoClient, ns: Namespace, before: Document, update: UpdateSpec, collation: CollationOptions | undefined): Promise<Tried> {
  const tried = await tryInTransaction(client, ns, before._id, update, collation)
  if (tried !== 'no-transaction') return tried
  if (!Array.isArray(update)) {
    return { note: "This server can't try the change in a transaction (a standalone server, or a collection that refuses them), so only the document before is shown. Check the update, then run it." }
  }
  // No transaction: an update pipeline's stages run the same as an aggregation's.
  const note = "This server can't try the change in a transaction, so the pipeline ran as an aggregation on the document instead."
  try {
    const [after] = await client
      .db(ns.db)
      .collection(ns.collection)
      .aggregate([{ $match: { _id: before._id } }, ...(updateOf(update) as Document[])], { ...EXACT, ...PRIMARY, maxTimeMS: FIND_MAX_TIME_MS, ...(collation ? { collation } : {}) })
      .toArray()
    if (!after) return { note, error: GONE }
    // An aggregation may change `_id`; an update can't, and the server would refuse it.
    if (JSON.stringify(toCanonical({ v: after._id })) !== JSON.stringify(toCanonical({ v: before._id }))) {
      return { note, error: "This update changes the document's _id, which can't change: the server refuses it." }
    }
    return { note, after }
  } catch (error) {
    return { note, error: messageOf(error) }
  }
}

/** A document cut down to its `_id`, for a preview that would not fit in one answer otherwise. */
function stub(doc: JsonObject): JsonObject {
  const marker: JsonObject = { $msTruncated: { kind: 'object', size: Object.keys(doc).length, preview: null } }
  return '_id' in doc ? { _id: doc._id!, '(document)': marker } : { '(document)': marker }
}

export async function previewUpdate(client: MongoClient, ns: Namespace, scope: UpdateScope, update: UpdateSpec): Promise<UpdatePreview> {
  checkUpdate(scope, update)
  const started = Date.now()
  const coll = client.db(ns.db).collection(ns.collection)
  const collation = collationOf(scope)
  const [counted, first] = await Promise.all([
    countMatching(coll, scopeFilter(scope), { ...(scope.kind === 'filter' && scope.collation ? { collation: scope.collation } : {}), primary: true }),
    coll.findOne(filterOf(scope), { ...EXACT, ...PRIMARY, maxTimeMS: FIND_MAX_TIME_MS, ...(collation ? { collation } : {}) })
  ])
  const preview: UpdatePreview = { count: counted.count, approximate: counted.approximate, ...(counted.error ? { countError: counted.error } : {}), ms: 0 }
  if (first) {
    const before = toCanonical(first)
    const r: Tried = '_id' in first ? await sampleAfter(client, ns, first, update, collation) : { note: 'This document has no _id, so the change is not tried on it.' }
    const sample: NonNullable<UpdatePreview['sample']> = { before: pageCanonical(before).doc, diffs: [], capped: false }
    if (r.after) {
      const after = toCanonical(r.after)
      const { diffs, capped } = diffDocuments(before, after, { ignoreFields: [], ignoreOrder: false }, DIFFS_MAX)
      sample.after = pageCanonical(after).doc
      sample.diffs = diffs
      sample.capped = capped
    }
    if (r.note) sample.note = r.note
    if (r.error) sample.error = r.error
    preview.sample = sample
    // Each document alone fits a page; both together may not fit one answer. The changed fields
    // matter most, so the documents give way first, "after" before "before".
    if (!fitsHost(preview) && sample.after) {
      sample.after = stub(sample.after)
      sample.tooBig = true
    }
    if (!fitsHost(preview)) {
      sample.before = stub(sample.before)
      sample.tooBig = true
    }
  }
  preview.ms = Date.now() - started
  return preview
}

export async function updateMany(client: MongoClient, ns: Namespace, scope: UpdateScope, update: UpdateSpec): Promise<WriteResult> {
  checkUpdate(scope, update)
  const collation = collationOf(scope)
  const r = await client
    .db(ns.db)
    .collection(ns.collection)
    .updateMany(filterOf(scope), updateOf(update), collation ? { collation } : {})
  return { matched: r.matchedCount, modified: r.modifiedCount }
}
