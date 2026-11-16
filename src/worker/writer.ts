// Writes documents into a collection in batches, the way imports and copies need: insert, replace
// by `_id` (upsert) or set fields by `_id` (merge). Write errors are counted against the record they
// came from; with `stopOnError` the first failing batch ends the job.
import { MongoBulkWriteError, type AnyBulkWriteOperation, type Collection, type Document } from 'mongodb'
import type { WriteMode } from '../protocol'
import { checkSignal, type JobHandle } from './jobs'

export const BATCH_DOCS = 1000
/** The driver splits a batch further by size; this keeps one batch's memory in check. */
const BATCH_BYTES = 24 * 1024 * 1024

export type WriteCounts = { inserted: number; updated: number; failed: number }

export class CollectionWriter {
  readonly counts: WriteCounts = { inserted: 0, updated: 0, failed: 0 }
  private docs: Document[] = []
  private records: number[] = []
  private bytes = 0
  /** Set when a batch failed with `stopOnError`. */
  stopped = false

  constructor(
    private readonly coll: Collection,
    private readonly mode: WriteMode,
    private readonly stopOnError: boolean,
    private readonly job: JobHandle,
    private readonly ns: string,
    /** Called with each batch's size once written (or tried). */
    private readonly onBatch: (n: number) => void = (n) => job.advance(n)
  ) {}

  /** Queues a document; writes a batch when one is full. `size` is its byte size, when known. */
  async add(doc: Document, record: number, size = 0): Promise<void> {
    this.docs.push(doc)
    this.records.push(record)
    this.bytes += size
    if (this.docs.length >= BATCH_DOCS || this.bytes >= BATCH_BYTES) await this.flush()
  }

  async flush(): Promise<void> {
    if (this.docs.length === 0 || this.stopped) return
    checkSignal(this.job.signal)
    const docs = this.docs
    const records = this.records
    this.docs = []
    this.records = []
    this.bytes = 0
    const ordered = this.stopOnError
    try {
      if (this.mode === 'insert') {
        const r = await this.coll.insertMany(docs, { ordered })
        this.counts.inserted += r.insertedCount
      } else {
        const r = await this.coll.bulkWrite(docs.map((d) => operation(d, this.mode)), { ordered })
        this.counts.inserted += r.insertedCount + r.upsertedCount
        this.counts.updated += r.matchedCount
      }
      this.onBatch(docs.length)
    } catch (error) {
      if (!(error instanceof MongoBulkWriteError)) throw error
      const r = error.result
      this.counts.inserted += r.insertedCount + r.upsertedCount
      this.counts.updated += r.matchedCount
      const writeErrors = Array.isArray(error.writeErrors) ? error.writeErrors : [error.writeErrors]
      for (const w of writeErrors) {
        this.counts.failed++
        this.job.error({ record: records[w.index], ns: this.ns, message: w.errmsg ?? error.message })
      }
      // Unordered: every other document of the batch was tried. Ordered: the rest were not.
      if (ordered) {
        const tried = (writeErrors[0]?.index ?? docs.length) + 1
        this.onBatch(tried)
        this.stopped = true
      } else this.onBatch(docs.length)
    }
  }
}

function operation(d: Document, mode: WriteMode): AnyBulkWriteOperation {
  if (d._id === undefined) return { insertOne: { document: d } }
  if (mode === 'upsert') return { replaceOne: { filter: { _id: d._id }, replacement: d, upsert: true } }
  const { _id, ...rest } = d
  return { updateOne: { filter: { _id }, update: { $set: Object.keys(rest).length ? rest : { _id } }, upsert: true } }
}
