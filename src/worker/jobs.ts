// Long data jobs (imports, exports, copies, compares, GridFS transfers) and what they read from and
// write to. A request starts a job and answers its id at once; the panel then asks `job.poll`,
// which waits in the worker until the job moves on, so the panel needs no timers and no request
// runs near Orca's 120 s limit. Downloads stay in the worker (64 MiB at most, Orca's save dialog
// limit) until the panel has read them in pieces.
import { randomUUID } from 'node:crypto'
import { createReadStream, createWriteStream, type WriteStream } from 'node:fs'
import { mkdir, rename, rm, stat } from 'node:fs/promises'
import { dirname, isAbsolute } from 'node:path'
import type { DataSource, JobError, JobKind, JobResult, JobState } from '../protocol'
import { expandPath } from './client'
import { invalid } from './query'

export const DOWNLOAD_MAX = 64 * 1024 * 1024
export const UPLOAD_MAX = 64 * 1024 * 1024
const ERRORS_KEPT = 50
const FINISHED_KEPT_MS = 30 * 60_000
const UPLOAD_KEPT_MS = 30 * 60_000
export const POLL_WAIT_MAX = 20_000
/** Base64 of this many bytes stays well under Orca's 1 MiB answer. */
export const READ_PIECE_MAX = 600 * 1024

export function cancelled(): Error {
  return Object.assign(new Error('Cancelled.'), { code: 'cancelled' })
}

export function checkSignal(signal: AbortSignal): void {
  if (signal.aborted) throw cancelled()
}

// ---- Sinks ----

export interface Sink {
  write(buf: Buffer): Promise<void>
  readonly bytes: number
}

/** Bytes kept for the save dialog. */
export class Outbox implements Sink {
  parts: Buffer[] = []
  bytes = 0
  async write(buf: Buffer): Promise<void> {
    if (this.bytes + buf.length > DOWNLOAD_MAX) throw invalid('This is more than 64 MiB, the most Orca\'s save dialog takes. Write it to a path instead.')
    this.parts.push(buf)
    this.bytes += buf.length
  }
  /** One buffer, built once, for reading in pieces. */
  private joined?: Buffer
  slice(offset: number, size: number): Buffer {
    this.joined ??= Buffer.concat(this.parts)
    this.parts = [this.joined]
    return this.joined.subarray(offset, offset + size)
  }
}

/** A path the person typed: `~` expanded, absolute only. */
export function checkPath(path: string): string {
  const p = expandPath(path.trim())
  if (!p) throw invalid('Enter a path.')
  if (!isAbsolute(p)) throw invalid(`"${path}" is not an absolute path. Start it with / (or ~/).`)
  return p
}

/** Writes to `<path>.part`, then renames it into place, so a failed or cancelled job never leaves
 *  half a file under the real name. */
export class FileSink implements Sink {
  bytes = 0
  private stream?: WriteStream
  private readonly tmp: string
  private constructor(readonly path: string) {
    this.tmp = `${path}.part`
  }

  static async open(path: string, overwrite: boolean): Promise<FileSink> {
    const exists = await stat(path).then((s) => s, () => undefined)
    if (exists?.isDirectory()) throw invalid(`${path} is a folder.`)
    if (exists && !overwrite) throw invalid(`${path} already exists. Tick "Replace an existing file" to write over it.`)
    const parent = await stat(dirname(path)).then((s) => s, () => undefined)
    if (!parent?.isDirectory()) throw invalid(`The folder ${dirname(path)} does not exist.`)
    const sink = new FileSink(path)
    sink.stream = createWriteStream(sink.tmp)
    await new Promise<void>((resolve, reject) => {
      sink.stream!.once('open', () => resolve())
      sink.stream!.once('error', reject)
    })
    return sink
  }

  async write(buf: Buffer): Promise<void> {
    const s = this.stream!
    this.bytes += buf.length
    if (!s.write(buf)) {
      await new Promise<void>((resolve, reject) => {
        const onError = (e: Error): void => reject(e)
        s.once('error', onError)
        s.once('drain', () => {
          s.off('error', onError)
          resolve()
        })
      })
    }
  }

  async finish(): Promise<void> {
    const s = this.stream!
    await new Promise<void>((resolve, reject) => {
      s.once('error', reject)
      s.end(() => resolve())
    })
    await rename(this.tmp, this.path)
  }

  async abort(): Promise<void> {
    this.stream?.destroy()
    await rm(this.tmp, { force: true }).catch(() => undefined)
  }
}

/** A folder to write a database into: made if missing. */
export async function ensureFolder(path: string): Promise<void> {
  const s = await stat(path).then((x) => x, () => undefined)
  if (s && !s.isDirectory()) throw invalid(`${path} is a file, not a folder.`)
  if (!s) {
    const parent = await stat(dirname(path)).then((x) => x, () => undefined)
    if (!parent?.isDirectory()) throw invalid(`The folder ${dirname(path)} does not exist.`)
    await mkdir(path)
  }
}

// ---- Uploads ----

type Upload = { parts: Buffer[]; bytes: number; at: number }

/** Text the panel sends in pieces, kept until a job reads it or 30 minutes pass. */
export class Uploads {
  private items = new Map<string, Upload>()

  append(uploadId: string | undefined, chunk: string, now = Date.now()): { uploadId: string; bytes: number } {
    this.expire(now)
    if (typeof chunk !== 'string') throw invalid('A piece of an upload is text.')
    const id = uploadId ?? randomUUID()
    const item = uploadId ? this.items.get(uploadId) : { parts: [], bytes: 0, at: now }
    if (!item) throw invalid('This upload has expired. Start it again.')
    const buf = Buffer.from(chunk, 'utf8')
    if (item.bytes + buf.length > UPLOAD_MAX) throw invalid('Pasted text is limited to 64 MiB. Give a path to the file instead.')
    item.parts.push(buf)
    item.bytes += buf.length
    item.at = now
    this.items.set(id, item)
    return { uploadId: id, bytes: item.bytes }
  }

  get(uploadId: string): Buffer {
    const item = this.items.get(uploadId)
    if (!item) throw invalid('This upload has expired. Paste the text again.')
    const one = Buffer.concat(item.parts)
    item.parts = [one]
    return one
  }

  private expire(now: number): void {
    for (const [id, item] of this.items) if (now - item.at > UPLOAD_KEPT_MS) this.items.delete(id)
  }
}

/** The bytes of a source, in pieces. Paths are read as a stream. */
export async function* sourceBytes(source: DataSource, uploads: Uploads, signal: AbortSignal, path?: string): AsyncGenerator<Buffer> {
  if (source.kind === 'upload' && !path) {
    const all = uploads.get(source.uploadId)
    for (let at = 0; at < all.length; at += 1024 * 1024) {
      checkSignal(signal)
      yield all.subarray(at, at + 1024 * 1024)
    }
    return
  }
  const p = path ?? checkPath((source as { path: string }).path)
  const stream = createReadStream(p, { highWaterMark: 1024 * 1024 })
  try {
    for await (const chunk of stream) {
      checkSignal(signal)
      yield chunk as Buffer
    }
  } finally {
    stream.destroy()
  }
}

export async function sourceSize(source: DataSource, uploads: Uploads): Promise<{ bytes: number; folder: boolean; path?: string }> {
  if (source.kind === 'upload') return { bytes: uploads.get(source.uploadId).length, folder: false }
  const p = checkPath(source.path)
  const s = await stat(p).catch(() => {
    throw invalid(`${p} does not exist or can't be read.`)
  })
  return { bytes: s.isDirectory() ? 0 : s.size, folder: s.isDirectory(), path: p }
}

// ---- Jobs ----

export type JobHandle = {
  readonly signal: AbortSignal
  progress(p: { phase?: string; done?: number; total?: number | null }): void
  /** Adds to `done`. */
  advance(n: number): void
  error(e: JobError): void
  readonly errorCount: number
  /** Keeps a download for `job.read`. */
  keep(outbox: Outbox): void
}

type Job = {
  state: JobState
  abort: AbortController
  outbox?: Outbox
  waiters: Set<() => void>
  finishedAt?: number
}

function stripUndefined<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

export class Jobs {
  private jobs = new Map<string, Job>()

  constructor(private readonly log: (message: string) => void = () => undefined) {}

  /** `onEnd` hears the final state once (done, failed or cancelled). */
  start(kind: JobKind, unit: JobState['unit'], run: (h: JobHandle) => Promise<JobResult>, onEnd?: (state: JobState) => void): string {
    this.expire()
    const jobId = randomUUID()
    const job: Job = {
      state: { jobId, kind, status: 'running', version: 1, phase: 'Starting', done: 0, total: null, unit, errors: [], errorCount: 0, started: Date.now(), ms: 0 },
      abort: new AbortController(),
      waiters: new Set()
    }
    this.jobs.set(jobId, job)
    const bump = (): void => {
      job.state.version++
      job.state.ms = Date.now() - job.state.started
      for (const w of job.waiters) w()
      job.waiters.clear()
    }
    const handle: JobHandle = {
      signal: job.abort.signal,
      progress: (p) => {
        if (p.phase !== undefined) job.state.phase = p.phase
        if (p.done !== undefined) job.state.done = p.done
        if (p.total !== undefined) job.state.total = p.total
        bump()
      },
      advance: (n) => {
        job.state.done += n
        bump()
      },
      error: (e) => {
        job.state.errorCount++
        if (job.state.errors.length < ERRORS_KEPT) job.state.errors.push(e.message.length > 500 ? { ...e, message: `${e.message.slice(0, 499)}…` } : e)
        bump()
      },
      get errorCount() {
        return job.state.errorCount
      },
      keep: (outbox) => {
        job.outbox = outbox
      }
    }
    void (async () => {
      try {
        const result = await run(handle)
        job.state.result = stripUndefined(result)
        job.state.status = job.abort.signal.aborted ? 'cancelled' : 'done'
        job.state.phase = job.abort.signal.aborted ? 'Cancelled' : 'Done'
      } catch (error) {
        const cancelledNow = job.abort.signal.aborted || (error as { code?: string }).code === 'cancelled'
        job.state.status = cancelledNow ? 'cancelled' : 'failed'
        job.state.phase = cancelledNow ? 'Cancelled' : 'Failed'
        if (!cancelledNow) {
          job.state.message = error instanceof Error ? error.message : String(error)
          this.log(`Job ${kind} failed: ${job.state.message}`)
        }
        job.outbox = undefined
      }
      job.finishedAt = Date.now()
      bump()
      if (onEnd) {
        try {
          onEnd(stripUndefined(job.state))
        } catch (error) {
          this.log(`After job ${kind}: ${String(error)}`)
        }
      }
    })()
    return jobId
  }

  private get(jobId: string): Job {
    const job = this.jobs.get(jobId)
    if (!job) throw invalid('This job is no longer known: it finished long ago, or the plugin restarted.')
    return job
  }

  async poll(jobId: string, version: number, waitMs: number, signal?: AbortSignal): Promise<JobState> {
    const job = this.get(jobId)
    if (job.state.version <= version && job.state.status === 'running') {
      const wait = Math.max(0, Math.min(POLL_WAIT_MAX, waitMs))
      await new Promise<void>((resolve) => {
        const done = (): void => {
          clearTimeout(timer)
          signal?.removeEventListener('abort', done)
          job.waiters.delete(done)
          resolve()
        }
        const timer = setTimeout(done, wait)
        signal?.addEventListener('abort', done)
        job.waiters.add(done)
      })
    }
    job.state.ms = (job.finishedAt ?? Date.now()) - job.state.started
    return stripUndefined(job.state)
  }

  cancel(jobId: string): void {
    const job = this.jobs.get(jobId)
    if (job && job.state.status === 'running') {
      job.state.phase = 'Stopping'
      job.abort.abort()
    }
  }

  read(jobId: string, offset: number, size: number): { base64: string; total: number } {
    const job = this.get(jobId)
    if (!job.outbox) throw invalid('This job has no download ready.')
    if (!Number.isInteger(offset) || offset < 0 || !Number.isInteger(size) || size < 1) throw invalid('Read a piece by offset and size.')
    return { base64: job.outbox.slice(offset, Math.min(size, READ_PIECE_MAX)).toString('base64'), total: job.outbox.bytes }
  }

  close(jobId: string): void {
    const job = this.jobs.get(jobId)
    if (!job) return
    job.outbox = undefined
    if (job.state.status !== 'running') this.jobs.delete(jobId)
  }

  closeAll(): void {
    for (const job of this.jobs.values()) job.abort.abort()
    this.jobs.clear()
  }

  private expire(): void {
    const now = Date.now()
    for (const [id, job] of this.jobs) if (job.finishedAt && now - job.finishedAt > FINISHED_KEPT_MS) this.jobs.delete(id)
  }
}
