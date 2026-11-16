// The GridFS browser: a bucket's files (filtered by name, newest first), a text preview of a file's
// start, chunk checks, download (to the save dialog or a path), upload (pasted text or a file the
// worker reads), rename and delete.
import { stat } from 'node:fs/promises'
import { join } from 'node:path'
import { BSON, GridFSBucket, type Document, type MongoClient } from 'mongodb'
import type { DataSource, ExportDestination, ExportResult, GridFile, GridPreview, GridRef, GridUploadResult } from '../protocol'
import type { JsonObject, JsonValue } from '../shared/ejson-view'
import { checkPath, checkSignal, FileSink, Outbox, sourceBytes, sourceSize, type JobHandle, type Sink, type Uploads } from './jobs'
import { checkTarget } from './import'
import { COUNT_MAX_TIME_MS, EXACT, invalid, toBson, toCanonical } from './query'

const PREVIEW_BYTES = 64 * 1024
const LIST_MAX = 500

function bucketOf(client: MongoClient, ref: GridRef): GridFSBucket {
  if (!ref.bucket || ref.bucket.includes('$')) throw invalid('Name the bucket.')
  return new GridFSBucket(client.db(ref.db), { bucketName: ref.bucket })
}

function fileId(id: JsonValue): unknown {
  return toBson<Document>({ _id: id })._id
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function short(text: string, max = 200): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text
}

export function gridFile(d: Document): GridFile {
  const f: GridFile = {
    id: toCanonical({ _id: d._id })._id!,
    filename: typeof d.filename === 'string' ? d.filename : '',
    length: Number(d.length ?? 0),
    chunkSize: Number(d.chunkSize ?? 0),
    uploadDate: d.uploadDate instanceof Date ? d.uploadDate.getTime() : 0
  }
  const contentType = typeof d.contentType === 'string' ? d.contentType : typeof (d.metadata as Document | undefined)?.contentType === 'string' ? String((d.metadata as Document).contentType) : undefined
  if (contentType) f.contentType = contentType
  if (d.metadata && typeof d.metadata === 'object' && Object.keys(d.metadata as object).length) {
    f.metadata = short(BSON.EJSON.stringify(d.metadata as Document, { relaxed: true }))
  }
  return f
}

export async function listFiles(client: MongoClient, ref: GridRef, filename: string | undefined, skip: number, limit: number): Promise<{ files: GridFile[]; total: number; ms: number }> {
  const started = Date.now()
  if (!Number.isInteger(skip) || skip < 0 || !Number.isInteger(limit) || limit < 1 || limit > LIST_MAX) throw invalid(`List 1 to ${LIST_MAX} files at a time.`)
  const coll = client.db(ref.db).collection(`${ref.bucket}.files`)
  const filter: Document = filename?.trim() ? { filename: { $regex: escapeRegex(filename.trim()), $options: 'i' } } : {}
  const [docs, total] = await Promise.all([
    coll.find(filter, { ...EXACT, promoteValues: true, sort: { uploadDate: -1, _id: -1 }, skip, limit }).toArray(),
    Object.keys(filter).length ? coll.countDocuments(filter, { maxTimeMS: COUNT_MAX_TIME_MS }) : coll.estimatedDocumentCount({ maxTimeMS: COUNT_MAX_TIME_MS })
  ])
  return { files: docs.map(gridFile), total, ms: Date.now() - started }
}

async function fileDoc(client: MongoClient, ref: GridRef, id: JsonValue): Promise<Document> {
  const d = await client.db(ref.db).collection(`${ref.bucket}.files`).findOne({ _id: fileId(id) } as Document, { promoteValues: true })
  if (!d) throw invalid('This file is no longer in the bucket.')
  return d
}

export async function previewFile(client: MongoClient, ref: GridRef, id: JsonValue): Promise<GridPreview> {
  const d = await fileDoc(client, ref, id)
  const length = Number(d.length ?? 0)
  const chunkSize = Number(d.chunkSize ?? 255 * 1024)
  const chunks = await client.db(ref.db).collection(`${ref.bucket}.chunks`).countDocuments({ files_id: d._id }, { maxTimeMS: COUNT_MAX_TIME_MS })
  const expectedChunks = length === 0 ? 0 : Math.ceil(length / chunkSize)
  const out: GridPreview = { cut: length > PREVIEW_BYTES, binary: false, length, chunks, expectedChunks }
  if (length === 0 || chunks < expectedChunks) return out
  const parts: Buffer[] = []
  const stream = bucketOf(client, ref).openDownloadStream(d._id, { start: 0, end: Math.min(length, PREVIEW_BYTES) })
  for await (const c of stream) parts.push(c as Buffer)
  const bytes = Buffer.concat(parts)
  if (bytes.includes(0)) return { ...out, binary: true }
  try {
    // A character cut at the end of the preview is dropped, not an error.
    let text = new TextDecoder('utf-8', { fatal: true }).decode(out.cut ? trimPartial(bytes) : bytes)
    if (text.charCodeAt(0) === 0xfeff) text = text.slice(1)
    return { ...out, text }
  } catch {
    return { ...out, binary: true }
  }
}

/** Drops a UTF-8 character cut short at the end. */
function trimPartial(b: Buffer): Buffer {
  let i = b.length - 1
  let back = 0
  while (i >= 0 && back < 4 && (b[i]! & 0xc0) === 0x80) {
    i--
    back++
  }
  if (i < 0) return b
  const lead = b[i]!
  const need = lead >= 0xf0 ? 4 : lead >= 0xe0 ? 3 : lead >= 0xc0 ? 2 : 1
  return need > back + 1 ? b.subarray(0, i) : b
}

export async function downloadFile(client: MongoClient, ref: GridRef, id: JsonValue, destination: ExportDestination, job: JobHandle): Promise<ExportResult> {
  const d = await fileDoc(client, ref, id)
  const length = Number(d.length ?? 0)
  const name = (typeof d.filename === 'string' && d.filename.split('/').pop()) || 'file'
  job.progress({ total: length, done: 0, phase: `Reading ${name}` })
  let sink: Sink
  let file: FileSink | undefined
  if (destination.kind === 'download') {
    sink = new Outbox()
  } else {
    let path = checkPath(destination.path)
    if (await stat(path).then((s) => s.isDirectory(), () => false)) path = join(path, name)
    file = await FileSink.open(path, destination.overwrite)
    sink = file
  }
  try {
    const stream = bucketOf(client, ref).openDownloadStream(d._id)
    for await (const c of stream) {
      checkSignal(job.signal)
      await sink.write(c as Buffer)
      job.advance((c as Buffer).length)
    }
    if (file) await file.finish()
  } catch (error) {
    await file?.abort()
    throw error
  }
  const contentType = typeof d.contentType === 'string' ? d.contentType : typeof (d.metadata as Document | undefined)?.contentType === 'string' ? String((d.metadata as Document).contentType) : 'application/octet-stream'
  if (sink instanceof Outbox) {
    job.keep(sink)
    return { kind: 'export', docs: 0, collections: 0, bytes: sink.bytes, download: { name, mimeType: contentType, size: sink.bytes } }
  }
  return { kind: 'export', docs: 0, collections: 0, bytes: sink.bytes, written: [file!.path] }
}

export async function uploadFile(client: MongoClient, ref: GridRef, source: DataSource, filename: string, contentType: string | undefined, metadata: JsonObject | undefined, uploads: Uploads, job: JobHandle): Promise<GridUploadResult> {
  checkTarget({ db: ref.db })
  if (!filename.trim()) throw invalid('Name the file.')
  const size = await sourceSize(source, uploads)
  if (size.folder) throw invalid('Give a file, not a folder.')
  job.progress({ total: size.bytes, done: 0, phase: `Uploading ${filename.trim()}` })
  const meta: Document = metadata ? toBson<Document>(metadata) : {}
  if (contentType?.trim()) meta.contentType = contentType.trim()
  const stream = bucketOf(client, ref).openUploadStream(filename.trim(), Object.keys(meta).length ? { metadata: meta } : {})
  try {
    for await (const chunk of sourceBytes(source, uploads, job.signal)) {
      if (!stream.write(chunk)) await new Promise<void>((resolve) => stream.once('drain', () => resolve()))
      job.advance(chunk.length)
    }
    await new Promise<void>((resolve, reject) => {
      stream.once('error', reject)
      stream.end(() => resolve())
    })
  } catch (error) {
    await stream.abort().catch(() => undefined)
    throw error
  }
  return { kind: 'gridfs-upload', id: toCanonical({ _id: stream.id })._id!, bytes: size.bytes }
}

export async function renameFile(client: MongoClient, ref: GridRef, id: JsonValue, filename: string): Promise<void> {
  if (!filename.trim()) throw invalid('Name the file.')
  await fileDoc(client, ref, id)
  await bucketOf(client, ref).rename(fileId(id) as never, filename.trim())
}

export async function deleteFile(client: MongoClient, ref: GridRef, id: JsonValue): Promise<void> {
  await fileDoc(client, ref, id)
  await bucketOf(client, ref).delete(fileId(id) as never)
}
