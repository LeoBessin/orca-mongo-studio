// Compare two collections (on the same or different connections) by `_id`, and sync one to the
// other. Two passes, each in batches, so memory stays small whatever the size: A's documents are
// looked up in B by `_id`, then B's `_id`s are looked up in A. Sync makes the same passes and
// writes as it goes, so it is never limited by the ids a comparison kept.
import type { AnyBulkWriteOperation, Collection, Document, MongoClient } from 'mongodb'
import { MongoBulkWriteError } from 'mongodb'
import type { CompareResult, Namespace, SyncResult } from '../protocol'
import { compareKey, diffDocuments, type CompareRules, type FieldDiff } from '../shared/compare'
import { idKey, type JsonObject, type JsonValue } from '../shared/ejson-view'
import { hostSize } from '../shared/host-size'
import { checkSignal, type JobHandle } from './jobs'
import { COUNT_MAX_TIME_MS, EXACT, invalid, pageCanonical, toBson, toCanonical } from './query'

export const COMPARE_ID_MAX = 1000
const ID_BYTES = 400 * 1024
const ID_OBJECTS = 6000
const BATCH = 500
const ID_BATCH = 1000

function checkRules(rules: CompareRules): CompareRules {
  if (!rules || !Array.isArray(rules.ignoreFields)) throw invalid('Say which fields to leave out (or none).')
  return { ignoreFields: rules.ignoreFields.filter((f) => typeof f === 'string' && f.trim()).map((f) => f.trim()), ignoreOrder: rules.ignoreOrder === true }
}

function scoped(filter: Document, ids: unknown[]): Document {
  return Object.keys(filter).length ? { $and: [filter, { _id: { $in: ids } }] } : { _id: { $in: ids } }
}

async function count(coll: Collection, filter: Document): Promise<number | null> {
  try {
    return Object.keys(filter).length ? await coll.countDocuments(filter, { maxTimeMS: COUNT_MAX_TIME_MS }) : await coll.estimatedDocumentCount({ maxTimeMS: COUNT_MAX_TIME_MS })
  } catch {
    return null
  }
}

/** Batches of a cursor's documents. */
async function* batches(coll: Collection, filter: Document, size: number, projection?: Document): AsyncGenerator<Document[]> {
  const cursor = coll.find(filter, { ...EXACT, sort: { _id: 1 }, batchSize: size, ...(projection ? { projection } : {}) })
  let batch: Document[] = []
  try {
    for await (const d of cursor) {
      batch.push(d)
      if (batch.length >= size) {
        yield batch
        batch = []
      }
    }
    if (batch.length) yield batch
  } finally {
    await cursor.close().catch(() => undefined)
  }
}

type Pass = { onlyA: (ids: Document[]) => Promise<void> | void; differ: (a: Document, b: Document) => Promise<void> | void; same: (n: number) => void; onlyB: (ids: unknown[]) => Promise<void> | void }

async function passes(a: Collection, b: Collection, filter: Document, rules: CompareRules, job: JobHandle, labels: [string, string], on: Pass): Promise<void> {
  job.progress({ phase: 'Counting documents' })
  const [na, nb] = await Promise.all([count(a, filter), count(b, filter)])
  job.progress({ total: na !== null && nb !== null ? na + nb : null, done: 0, phase: `Reading ${labels[0]}` })
  for await (const batch of batches(a, filter, BATCH)) {
    checkSignal(job.signal)
    const found = await b.find(scoped(filter, batch.map((d) => d._id)), { ...EXACT }).toArray()
    const byId = new Map(found.map((d) => [idKey(toCanonical({ _id: d._id })._id!), d]))
    const missing: Document[] = []
    let same = 0
    for (const d of batch) {
      const other = byId.get(idKey(toCanonical({ _id: d._id })._id!))
      if (!other) missing.push(d)
      else if (compareKey(toCanonical(d), rules) === compareKey(toCanonical(other), rules)) same++
      else await on.differ(d, other)
    }
    if (missing.length) await on.onlyA(missing)
    on.same(same)
    job.advance(batch.length)
  }
  job.progress({ phase: `Reading ${labels[1]}` })
  for await (const batch of batches(b, filter, ID_BATCH, { _id: 1 })) {
    checkSignal(job.signal)
    const ids = batch.map((d) => d._id)
    const found = await a.find(scoped(filter, ids), { ...EXACT, projection: { _id: 1 } }).toArray()
    const have = new Set(found.map((d) => idKey(toCanonical({ _id: d._id })._id!)))
    const missing = ids.filter((id) => !have.has(idKey(toCanonical({ _id: id })._id!)))
    if (missing.length) await on.onlyB(missing)
    job.advance(batch.length)
  }
}

const idOf = (d: Document): JsonValue => toCanonical({ _id: d._id })._id!

export async function runCompare(ca: MongoClient, cb: MongoClient, a: Namespace, b: Namespace, filter: JsonObject | undefined, rulesIn: CompareRules, job: JobHandle): Promise<CompareResult> {
  const rules = checkRules(rulesIn)
  const f = toBson<Document>(filter ?? {})
  const r: CompareResult = { kind: 'compare', same: 0, differ: 0, onlyA: 0, onlyB: 0, ids: { differ: [], onlyA: [], onlyB: [] }, capped: false }
  // The ids go back in a job.poll answer: keep them well under Orca's measure (compound _ids
  // cost more than one object each).
  let cost = { bytes: 0, objects: 0 }
  const keep = (list: JsonValue[], values: JsonValue[]): void => {
    for (const v of values) {
      const size = hostSize(v)
      if (list.length < COMPARE_ID_MAX && cost.bytes + size.bytes < ID_BYTES && cost.objects + size.objects < ID_OBJECTS) {
        list.push(v)
        cost = { bytes: cost.bytes + size.bytes, objects: cost.objects + size.objects }
      } else r.capped = true
    }
  }
  await passes(ca.db(a.db).collection(a.collection), cb.db(b.db).collection(b.collection), f, rules, job, [`${a.db}.${a.collection}`, `${b.db}.${b.collection}`], {
    same: (n) => {
      r.same += n
    },
    differ: (d) => {
      r.differ++
      keep(r.ids.differ, [idOf(d)])
    },
    onlyA: (docs) => {
      r.onlyA += docs.length
      keep(r.ids.onlyA, docs.map(idOf))
    },
    onlyB: (ids) => {
      r.onlyB += ids.length
      keep(r.ids.onlyB, ids.map((id) => toCanonical({ _id: id })._id!))
    }
  })
  return r
}

export async function diffPair(ca: MongoClient, cb: MongoClient, a: Namespace, b: Namespace, id: JsonValue, rulesIn: CompareRules): Promise<{ a: JsonObject | null; b: JsonObject | null; diffs: FieldDiff[]; capped: boolean }> {
  const rules = checkRules(rulesIn)
  const filter = { _id: toBson<Document>({ _id: id })._id }
  const [da, db] = await Promise.all([ca.db(a.db).collection(a.collection).findOne(filter, { ...EXACT }), cb.db(b.db).collection(b.collection).findOne(filter, { ...EXACT })])
  const xa = da ? toCanonical(da) : null
  const xb = db ? toCanonical(db) : null
  const d = xa && xb ? diffDocuments(xa, xb, rules) : { diffs: [], capped: false }
  return { a: xa ? pageCanonical(xa).doc : null, b: xb ? pageCanonical(xb).doc : null, diffs: d.diffs, capped: d.capped }
}

export async function runSync(
  cf: MongoClient,
  ct: MongoClient,
  from: Namespace,
  to: Namespace,
  filter: JsonObject | undefined,
  rulesIn: CompareRules,
  actions: { insert: boolean; replace: boolean; remove: boolean },
  job: JobHandle
): Promise<SyncResult> {
  const rules = checkRules(rulesIn)
  if (!actions.insert && !actions.replace && !actions.remove) throw invalid('Choose at least one change to make.')
  if (cf === ct && from.db === to.db && from.collection === to.collection) throw invalid('A collection can\'t be synced with itself.')
  const info = (await ct.db(to.db).listCollections({ name: to.collection }).toArray())[0] as { type?: string } | undefined
  if (info?.type === 'view') throw invalid(`${to.db}.${to.collection} is a view, so it can't be changed.`)
  const f = toBson<Document>(filter ?? {})
  const target = ct.db(to.db).collection(to.collection)
  const label = `${to.db}.${to.collection}`
  const r: SyncResult = { kind: 'sync', inserted: 0, replaced: 0, deleted: 0, failed: 0 }
  const write = async (ops: AnyBulkWriteOperation[]): Promise<void> => {
    if (!ops.length) return
    try {
      const res = await target.bulkWrite(ops, { ordered: false })
      r.inserted += res.insertedCount
      r.replaced += res.modifiedCount
    } catch (error) {
      if (!(error instanceof MongoBulkWriteError)) throw error
      r.inserted += error.result.insertedCount
      r.replaced += error.result.modifiedCount
      const list = Array.isArray(error.writeErrors) ? error.writeErrors : [error.writeErrors]
      for (const w of list) {
        r.failed++
        job.error({ ns: label, message: w.errmsg ?? error.message })
      }
    }
  }
  let replaceOps: AnyBulkWriteOperation[] = []
  await passes(cf.db(from.db).collection(from.collection), target, f, rules, job, [`${from.db}.${from.collection}`, label], {
    same: () => undefined,
    differ: async (d) => {
      if (!actions.replace) return
      replaceOps.push({ replaceOne: { filter: { _id: d._id }, replacement: d } })
      if (replaceOps.length >= BATCH) {
        const ops = replaceOps
        replaceOps = []
        await write(ops)
      }
    },
    onlyA: async (docs) => {
      if (actions.insert) await write(docs.map((d) => ({ insertOne: { document: d } })))
    },
    onlyB: async (ids) => {
      if (replaceOps.length) {
        const ops = replaceOps
        replaceOps = []
        await write(ops)
      }
      if (!actions.remove) return
      const res = await target.deleteMany(scoped(f, ids))
      r.deleted += res.deletedCount
    }
  })
  await write(replaceOps)
  return r
}
