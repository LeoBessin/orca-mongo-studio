// Update many: how many documents a scope reaches, one of them before and after the change, and
// the `updateMany` itself. The "after" comes from the server, never from a copy of its rules: an
// update pipeline runs as an aggregation on the sample, and update operators run on it inside a
// transaction that is always aborted, so nothing is saved. A standalone server has no
// transactions; there the preview shows the document before only.
import type { ClientSession, CollationOptions, Document, MongoClient } from 'mongodb'
import type { Namespace, UpdatePreview, WriteResult } from '../protocol'
import { diffDocuments } from '../shared/compare'
import type { JsonObject } from '../shared/ejson-view'
import { scopeFilter, scopeProblem, updateProblem, type UpdateScope, type UpdateSpec } from '../shared/update-spec'
import { COUNT_MAX_TIME_MS, EXACT, FIND_MAX_TIME_MS, invalid, pageCanonical, toBson, toCanonical } from './query'

/** Field differences listed for the sample; the documents themselves show the rest. */
const DIFFS_MAX = 100

function check(scope: UpdateScope, update: UpdateSpec): void {
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

/** The server can't run a transaction here: a standalone server, or a collection that refuses
 *  writes in one (time-series, capped on old servers, system collections). */
function noTransaction(error: unknown): boolean {
  const e = error as ServerError
  const message = e.message ?? ''
  return (
    e.code === 20 ||
    e.code === 263 ||
    e.codeName === 'OperationNotSupportedInTransaction' ||
    /Transaction numbers are only allowed|transactions are not supported|not supported in (a )?(multi-document )?transaction/i.test(message)
  )
}

async function count(client: MongoClient, ns: Namespace, scope: UpdateScope): Promise<Pick<UpdatePreview, 'count' | 'approximate' | 'countError'>> {
  const coll = client.db(ns.db).collection(ns.collection)
  try {
    if (scope.kind === 'all') {
      try {
        return { count: await coll.estimatedDocumentCount({ maxTimeMS: COUNT_MAX_TIME_MS }), approximate: true }
      } catch {
        // Views and some sharded setups refuse it: count for real.
      }
    }
    const collation = collationOf(scope)
    const n = await coll.countDocuments(filterOf(scope), { maxTimeMS: COUNT_MAX_TIME_MS, ...(collation ? { collation } : {}) })
    return { count: n, approximate: false }
  } catch (error) {
    const e = error as ServerError
    if (e.code === 50 || e.codeName === 'MaxTimeMSExpired') return { count: null, approximate: false, countError: `Counting took longer than ${COUNT_MAX_TIME_MS / 1000} s, so it stopped.` }
    return { count: null, approximate: false, countError: e.message ?? String(error) }
  }
}

/** The sample document as the update would leave it, or why that isn't known. */
async function sampleAfter(client: MongoClient, ns: Namespace, id: unknown, update: UpdateSpec): Promise<{ after?: Document; note?: string; error?: string }> {
  const coll = client.db(ns.db).collection(ns.collection)
  if (Array.isArray(update)) {
    try {
      const [after] = await coll.aggregate([{ $match: { _id: id } }, ...(updateOf(update) as Document[])], { ...EXACT, maxTimeMS: FIND_MAX_TIME_MS }).toArray()
      return after ? { after } : { error: 'The document was deleted while previewing.' }
    } catch (error) {
      return { error: (error as ServerError).message ?? String(error) }
    }
  }
  let session: ClientSession | undefined
  try {
    session = client.startSession()
    session.startTransaction()
    const r = await coll.updateOne({ _id: id } as Document, updateOf(update), { session })
    if (r.matchedCount === 0) return { error: 'The document was deleted while previewing.' }
    const after = await coll.findOne({ _id: id } as Document, { ...EXACT, session })
    return after ? { after } : { error: 'The document was deleted while previewing.' }
  } catch (error) {
    if (noTransaction(error)) {
      return { note: "This server can't try the change in a transaction (a standalone server, or a collection that refuses them), so only the document before is shown. Check the update, then run it." }
    }
    return { error: (error as ServerError).message ?? String(error) }
  } finally {
    if (session) {
      if (session.inTransaction()) await session.abortTransaction().catch(() => undefined)
      await session.endSession().catch(() => undefined)
    }
  }
}

export async function previewUpdate(client: MongoClient, ns: Namespace, scope: UpdateScope, update: UpdateSpec): Promise<UpdatePreview> {
  check(scope, update)
  const started = Date.now()
  const coll = client.db(ns.db).collection(ns.collection)
  const collation = collationOf(scope)
  const [counted, first] = await Promise.all([
    count(client, ns, scope),
    coll.findOne(filterOf(scope), { ...EXACT, maxTimeMS: FIND_MAX_TIME_MS, ...(collation ? { collation } : {}) })
  ])
  const preview: UpdatePreview = { ...counted, ms: 0 }
  if (first) {
    const before = toCanonical(first)
    const r = '_id' in first ? await sampleAfter(client, ns, first._id, update) : { note: 'This document has no _id, so the change is not tried on it.' }
    const sample: NonNullable<UpdatePreview['sample']> = { before: pageCanonical(before).doc, diffs: [], capped: false }
    if (r.after) {
      const after = toCanonical(r.after)
      const { diffs, capped } = diffDocuments(before, after, { ignoreFields: [], ignoreOrder: false }, DIFFS_MAX)
      // `diffDocuments` leaves `_id` out, being the key a comparison pairs on; an update can't change it.
      sample.after = pageCanonical(after).doc
      sample.diffs = diffs
      sample.capped = capped
    }
    if (r.note) sample.note = r.note
    if (r.error) sample.error = r.error
    preview.sample = sample
  }
  preview.ms = Date.now() - started
  return preview
}

export async function updateMany(client: MongoClient, ns: Namespace, scope: UpdateScope, update: UpdateSpec): Promise<WriteResult> {
  check(scope, update)
  const collation = collationOf(scope)
  const r = await client
    .db(ns.db)
    .collection(ns.collection)
    .updateMany(filterOf(scope), updateOf(update), collation ? { collation } : {})
  return { matched: r.matchedCount, modified: r.modifiedCount }
}
