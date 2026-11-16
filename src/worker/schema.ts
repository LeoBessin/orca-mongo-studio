// The Schema Explorer's sample: `$sample` (after the filter, when one is given) read with every
// BSON type kept, then analysed by src/shared/schema.ts. The report goes back as JSON text.
import type { Document, MongoClient } from 'mongodb'
import type { Namespace } from '../protocol'
import { isObject, type JsonObject } from '../shared/ejson-view'
import { HOST_MAX_BYTES } from '../shared/host-size'
import { analyzeDocuments } from '../shared/schema'
import { EXACT, invalid, toBson, toCanonical } from './query'

export const SAMPLE_MAX = 10_000
const SAMPLE_MAX_TIME_MS = 60_000

export async function analyzeSchema(client: MongoClient, ns: Namespace, size: number, filter?: JsonObject): Promise<{ report: string }> {
  if (!Number.isInteger(size) || size < 1 || size > SAMPLE_MAX) throw invalid(`Sample 1 to ${SAMPLE_MAX.toLocaleString('en-US')} documents.`)
  if (filter !== undefined && !isObject(filter)) throw invalid('The filter must be a document.')
  const started = Date.now()
  const pipeline: Document[] = []
  if (filter && Object.keys(filter).length) pipeline.push({ $match: toBson<Document>(filter) })
  pipeline.push({ $sample: { size } })
  const raw = await client.db(ns.db).collection(ns.collection).aggregate(pipeline, { ...EXACT, maxTimeMS: SAMPLE_MAX_TIME_MS, allowDiskUse: true }).toArray()
  const docs = raw.map((d) => toCanonical(d))
  const ms = Date.now() - started
  // Very wide collections: fewer fields until the text fits in an answer.
  for (let maxFields = 1000; ; maxFields = Math.floor(maxFields / 2)) {
    const text = JSON.stringify(analyzeDocuments(docs, { maxFields }, size, ms))
    if (Buffer.byteLength(text) < HOST_MAX_BYTES * 0.85 || maxFields < 20) return { report: text }
  }
}
