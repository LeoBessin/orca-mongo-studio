// The shell: each open editor gets a session with its own script thread (shell-thread.mjs), which
// keeps the script's variables between runs. The thread's database calls arrive here over a
// MessagePort and run on the pooled MongoClient; the thread waits on a shared flag until the
// answer is posted. Runs report entries (prints, values, errors) that the editor polls for, and
// results (cursors and documents) that the panel pages through, like a query's.
import { randomUUID } from 'node:crypto'
import { createRequire } from 'node:module'
import { MessageChannel, Worker, type MessagePort } from 'node:worker_threads'
import { BSON, type AbstractCursor, type Document, type MongoClient } from 'mongodb'
import type { QueryPage, ShellEntry, ShellPoll, ShellResultInfo, ShellRunInput, ShellRunSummary } from '../protocol'
import { bsonType, fieldPaths, isObject, toShell, toShellInline, type JsonObject, type JsonValue } from '../shared/ejson-view'
import { hostSize } from '../shared/host-size'
import type { Operation } from '../shared/operation'
import { prepareStatements } from '../shared/shell-prepare'
import { PAGE_BYTE_BUDGET, PAGE_OBJECT_BUDGET, pageCanonical, toCanonical } from './query'

const EXACT = { promoteValues: false, promoteLongs: false, bsonRegExp: true } as const
/** Arguments from the thread keep their exact BSON types. */
const ARGS_READ = { promoteValues: false, promoteLongs: false, bsonRegExp: true } as const
const SESSION_IDLE_MS = 30 * 60_000
const RUN_KEEP_MS = 30 * 60_000
const POLL_WAIT_MS = 20_000
const POLL_TEXT_BUDGET = 600 * 1024
const ENTRY_TEXT_MAX = 64 * 1024
const RUN_TEXT_MAX = 4 * 1024 * 1024
const PREVIEW_DOCS = 20
/** What the panel can page through, per result. */
const RESULT_DOCS_MAX = 10_000
const RESULT_BYTES_MAX = 32 * 1024 * 1024
const COMPLETE_TTL_MS = 60_000
const SAMPLE_SIZE = 100
const THREAD_HEAP_MB = 1024
/** The thread loads the same `bson` the driver uses. */
const BSON_PATH = createRequire(createRequire(import.meta.url).resolve('mongodb')).resolve('bson')

function invalid(message: string, code = 'invalid_params'): Error {
  return Object.assign(new Error(message), { code })
}

// ---- Values from the thread ----

/** Top-level option values as plain numbers: the driver checks options with `typeof`. */
function plainOptions(o: unknown): Document {
  if (!o || typeof o !== 'object') return {}
  const out: Document = {}
  for (const [k, v] of Object.entries(o as Document)) {
    out[k] = k === 'sort' && v && typeof v === 'object' && !Array.isArray(v) ? plainOptions(v) : plainNumber(v)
  }
  return out
}

function plainNumber(v: unknown): unknown {
  if (v && typeof v === 'object') {
    const t = (v as { _bsontype?: string })._bsontype
    if (t === 'Int32' || t === 'Double') return (v as { valueOf(): number }).valueOf()
    if (t === 'Long') return (v as { toNumber(): number }).toNumber()
  }
  return v
}

function copyBytes(b: Uint8Array): Uint8Array {
  return new Uint8Array(b)
}

// ---- Results ----

type Slot = {
  info: ShellResultInfo
  /** Canonical documents read so far. */
  docs: JsonObject[]
  bytes: number
  cursor?: AbstractCursor<Document>
  exhausted: boolean
  /** Reading stopped at RESULT_DOCS_MAX or RESULT_BYTES_MAX. */
  capped: boolean
}

type CursorSpec = {
  kind: 'find' | 'aggregate'
  db: string
  collection: string | null
  filter: JsonObject
  projection: JsonObject | null
  pipeline: JsonObject[] | null
  options: JsonObject
}

type Run = {
  id: string
  session: Session
  connectionId: string
  connectionName: string
  db: string
  started: number
  ended?: number
  entries: ShellEntry[]
  textBytes: number
  done: boolean
  slots: Slot[]
  waiters: Set<() => void>
  lastUsed: number
  /** The editor's lines, for result titles (index 0 is line 1). */
  lines: string[]
  /** Entries still being added, in order. */
  pending?: Promise<void>
}

type Session = {
  editorId: string
  connectionId: string
  thread: Worker
  port: MessagePort
  signal: Int32Array
  cursors: Map<number, AbstractCursor<Document | Buffer>>
  nextHandle: number
  run?: Run
  lastUsed: number
  dead: boolean
}

export type ShellHost = {
  client(connectionId: string): Promise<MongoClient>
  connectionName(connectionId: string): Promise<string>
  /** Tells open panels that a run has results. */
  announce(summary: ShellRunSummary): void
  log(message: string): void
}

function clip(text: string, max = ENTRY_TEXT_MAX): string {
  return text.length > max ? `${text.slice(0, max)}\n… (${(text.length - max).toLocaleString('en-US')} more characters)` : text
}

/** A statement's start on one line: `db.orders.aggregate([ { $group: { _id: '$st…`. */
function titleOf(code: string): string {
  const flat = code.replace(/\/\/[^\n]*/g, '').replace(/\s+/g, ' ').trim()
  return flat.length > 60 ? `${flat.slice(0, 59)}…` : flat
}

function isDocument(v: JsonValue): v is JsonObject {
  return isObject(v) && bsonType(v) === 'object'
}

function countText(n: number, one: string, many = `${one}s`): string {
  return `${n.toLocaleString('en-US')} ${n === 1 ? one : many}`
}

/** A find cursor's operation, when its options are ones an Operation holds. */
function cursorOperation(spec: CursorSpec): Operation | undefined {
  if (spec.collection === null) return undefined
  if (spec.kind === 'aggregate') return { kind: 'aggregate', db: spec.db, collection: spec.collection, pipeline: spec.pipeline ?? [] }
  const o = spec.options
  const op: Operation = { kind: 'find', db: spec.db, collection: spec.collection, filter: spec.filter }
  if (spec.projection && Object.keys(spec.projection).length) op.projection = spec.projection
  if (isObject(o.sort) && Object.keys(o.sort).length) op.sort = o.sort
  if (isObject(o.collation)) op.collation = o.collation
  const num = (v: JsonValue | undefined): number | undefined => {
    if (typeof v === 'number') return v
    if (isObject(v)) {
      const n = Number(v.$numberInt ?? v.$numberLong ?? v.$numberDouble)
      return Number.isFinite(n) ? n : undefined
    }
    return undefined
  }
  const skip = num(o.skip)
  const limit = num(o.limit)
  if (skip) op.skip = skip
  if (limit) op.limit = Math.abs(limit)
  return op
}

export class ShellService {
  private readonly sessions = new Map<string, Session>()
  private readonly runs = new Map<string, Run>()
  private latest: string | undefined
  private sweeper: ReturnType<typeof setInterval> | undefined
  private readonly completeCache = new Map<string, { at: number; value: string[] }>()

  constructor(private readonly host: ShellHost) {}

  // ---- Sessions ----

  private startSession(editorId: string, connectionId: string): Session {
    const { port1, port2 } = new MessageChannel()
    const shared = new SharedArrayBuffer(4)
    const thread = new Worker(new URL('./shell-thread.mjs', import.meta.url), {
      workerData: { port: port2, signal: shared, bsonPath: BSON_PATH },
      transferList: [port2],
      resourceLimits: { maxOldGenerationSizeMb: THREAD_HEAP_MB }
    })
    const session: Session = { editorId, connectionId, thread, port: port1, signal: new Int32Array(shared), cursors: new Map(), nextHandle: 1, lastUsed: Date.now(), dead: false }
    port1.on('message', (msg: { method: string; args: Uint8Array }) => void this.answer(session, msg))
    thread.on('message', (msg: { type: string; runId: string; entry?: ThreadEntry; db?: string }) => void this.onThreadMessage(session, msg))
    thread.on('error', (error) => {
      this.host.log(`Shell thread failed: ${String(error)}`)
      this.endSession(session, `The script stopped: ${error instanceof Error ? error.message : String(error)}`)
    })
    thread.on('exit', () => this.endSession(session, 'The script stopped.'))
    thread.unref()
    this.sessions.set(editorId, session)
    this.startSweeper()
    return session
  }

  private endSession(session: Session, reason?: string): void {
    if (session.dead) return
    session.dead = true
    if (this.sessions.get(session.editorId) === session) this.sessions.delete(session.editorId)
    for (const c of session.cursors.values()) void c.close().catch(() => undefined)
    session.cursors.clear()
    session.port.close()
    void session.thread.terminate().catch(() => undefined)
    const run = session.run
    if (run && !run.done) {
      if (reason) this.push(run, { kind: 'error', text: reason })
      void this.finish(run)
    }
  }

  private session(editorId: string, connectionId: string): Session {
    const s = this.sessions.get(editorId)
    if (s && !s.dead && s.connectionId === connectionId) return s
    if (s) this.endSession(s)
    return this.startSession(editorId, connectionId)
  }

  // ---- Runs ----

  async run(editorId: string, input: ShellRunInput): Promise<{ runId: string }> {
    if (typeof input.code !== 'string' || !input.code.trim()) throw invalid('There is nothing to run.')
    if (typeof input.db !== 'string' || !input.db) throw invalid('Choose a database first.')
    const statements = prepareStatements(input.code, input.line || 1, input.column || 1)
    if (statements.length === 0) throw invalid('There is nothing to run: only comments.')
    const connectionName = await this.host.connectionName(input.connectionId)
    // Connecting first gives a clear error before the script starts.
    await this.host.client(input.connectionId)
    const session = this.session(editorId, input.connectionId)
    if (session.run && !session.run.done) throw invalid('A script is still running in this editor. Stop it first.', 'conflict')
    const run: Run = {
      id: randomUUID(),
      session,
      connectionId: input.connectionId,
      connectionName,
      db: input.db,
      started: Date.now(),
      entries: [],
      textBytes: 0,
      done: false,
      slots: [],
      lines: [...Array<string>(Math.max(0, (input.line || 1) - 1)).fill(''), ...input.code.split('\n')],
      waiters: new Set(),
      lastUsed: Date.now()
    }
    session.run = run
    session.lastUsed = Date.now()
    this.runs.set(run.id, run)
    session.thread.postMessage({ type: 'run', runId: run.id, db: input.db, statements })
    return { runId: run.id }
  }

  async poll(runId: string, after: number, signal?: AbortSignal): Promise<ShellPoll> {
    const run = this.runs.get(runId)
    if (!run) throw invalid('That run is no longer kept. Run the script again.', 'conflict')
    run.lastUsed = Date.now()
    if (run.entries.length <= after && !run.done) {
      await new Promise<void>((resolve) => {
        const done = (): void => {
          clearTimeout(timer)
          run.waiters.delete(done)
          signal?.removeEventListener('abort', done)
          resolve()
        }
        const timer = setTimeout(done, POLL_WAIT_MS)
        run.waiters.add(done)
        signal?.addEventListener('abort', done)
      })
    }
    const entries: ShellEntry[] = []
    let budget = POLL_TEXT_BUDGET
    for (let i = Math.max(0, after); i < run.entries.length; i++) {
      const e = run.entries[i]!
      const size = hostSize(e).bytes
      if (entries.length > 0 && size > budget) break
      entries.push(e)
      budget -= size
    }
    const caughtUp = after + entries.length >= run.entries.length
    // Orca answers only plain JSON: no undefined fields.
    return JSON.parse(JSON.stringify({ entries, done: run.done && caughtUp, db: run.db, ms: (run.ended ?? Date.now()) - run.started })) as ShellPoll
  }

  cancel(runId: string): void {
    const run = this.runs.get(runId)
    if (!run || run.done) return
    this.push(run, { kind: 'info', text: 'Stopped. The script’s variables were cleared.' })
    this.endSession(run.session)
  }

  reset(editorId: string): void {
    const s = this.sessions.get(editorId)
    if (s) this.endSession(s)
  }

  latestSummary(): ShellRunSummary | null {
    const run = this.latest ? this.runs.get(this.latest) : undefined
    return run ? this.summary(run) : null
  }

  private summary(run: Run): ShellRunSummary {
    const summary: ShellRunSummary = { runId: run.id, connectionId: run.connectionId, connectionName: run.connectionName, db: run.db, at: run.started, results: run.slots.map((s) => s.info) }
    // Orca answers only plain JSON: no undefined fields.
    return JSON.parse(JSON.stringify(summary)) as ShellRunSummary
  }

  private push(run: Run, entry: ShellEntry): void {
    if (run.textBytes > RUN_TEXT_MAX) return
    const size = 'text' in entry ? entry.text.length : 0
    run.textBytes += size
    if (run.textBytes > RUN_TEXT_MAX) entry = { kind: 'info', text: 'The output passed 4 MiB, so the rest is not shown. Results still open in the panel.' }
    run.entries.push(entry)
    for (const w of [...run.waiters]) w()
  }

  private async finish(run: Run): Promise<void> {
    if (run.done) return
    run.done = true
    run.ended = Date.now()
    if (run.slots.length) {
      const previous = this.latest ? this.runs.get(this.latest) : undefined
      this.latest = run.id
      // Only the newest run's results stay open; its output stays until the editor reads it.
      if (previous && previous !== run) await this.releaseResults(previous)
      this.host.announce(this.summary(run))
    }
    for (const w of [...run.waiters]) w()
  }

  private async dropRun(run: Run): Promise<void> {
    this.runs.delete(run.id)
    await this.releaseResults(run)
  }

  private async releaseResults(run: Run): Promise<void> {
    const slots = run.slots
    run.slots = []
    await Promise.all(slots.map((s) => s.cursor?.close().catch(() => undefined)))
  }

  private async onThreadMessage(session: Session, msg: { type: string; runId: string; entry?: ThreadEntry; db?: string }): Promise<void> {
    const run = this.runs.get(msg.runId)
    if (!run || run.session !== session) return
    if (msg.type === 'entry' && msg.entry) {
      // Entries keep their order even when a result needs a database read first.
      run.pending = (run.pending ?? Promise.resolve()).then(() => this.addEntry(run, msg.entry!))
      await run.pending
    } else if (msg.type === 'done') {
      await (run.pending ?? Promise.resolve())
      if (msg.db) run.db = msg.db
      await this.finish(run)
    }
  }

  private async addEntry(run: Run, e: ThreadEntry): Promise<void> {
    try {
      if (e.kind === 'print') {
        this.push(run, { kind: 'print', text: clip(e.parts.map((p) => ('text' in p && p.kind === undefined ? p.text : describedText(p))).join(' ')) })
      } else if (e.kind === 'info') {
        if (e.db) run.db = e.db
        this.push(run, { kind: 'info', text: e.text })
      } else if (e.kind === 'error') {
        const where = e.line ? `Line ${e.line}${e.column ? `, column ${e.column}` : ''}: ` : ''
        const code = e.codeName ? ` (${e.codeName}${e.code !== undefined && !e.codeName.endsWith(String(e.code)) ? ` ${e.code}` : ''})` : ''
        const name = e.name && e.name !== 'Error' && e.name !== 'ShellError' ? `${e.name}: ` : ''
        this.push(run, { kind: 'error', line: e.line, column: e.column, text: `${where}${name}${e.message}${code}` })
      } else if (e.kind === 'result') {
        await this.addResult(run, e)
      }
    } catch (error) {
      this.push(run, { kind: 'error', line: 'line' in e ? e.line : undefined, text: error instanceof Error ? error.message : String(error) })
    }
  }

  private async addResult(run: Run, e: Extract<ThreadEntry, { kind: 'result' }>): Promise<void> {
    const r = e.result
    if (e.show === 'databases' && r.kind === 'value' && isObject(r.value)) {
      const list = Array.isArray(r.value.databases) ? r.value.databases : []
      const lines = list.filter(isObject).map((d) => `${String(d.name)}  ${sizeText(d.sizeOnDisk)}`)
      this.push(run, { kind: 'result', line: e.line, ms: e.ms, text: lines.join('\n') || '(no databases)' })
      return
    }
    if (e.show === 'lines' && r.kind === 'value' && Array.isArray(r.value)) {
      this.push(run, { kind: 'result', line: e.line, ms: e.ms, text: r.value.map((x) => (typeof x === 'string' ? x : toShell(x))).join('\n') || '(none)' })
      return
    }
    if (r.kind === 'text') {
      this.push(run, { kind: 'result', line: e.line, ms: e.ms, text: clip(r.text), ...(r.note ? { note: r.note } : {}) })
      return
    }
    if (r.kind === 'cursor') {
      await this.addCursor(run, e.line, e.ms, r.cursor)
      return
    }
    if (r.kind === 'undefined') return
    // A value: documents also open in the panel.
    const v = r.value
    const docs = Array.isArray(v) && v.length > 0 && v.every(isDocument) ? v : isDocument(v) && r.docs !== false && Object.keys(v).length > 0 && e.line !== undefined && looksLikeDocument(v) ? [v] : undefined
    if (docs) {
      const slot = this.newSlot(run, e.line, 'docs')
      slot.exhausted = true
      for (const d of docs) {
        if (slot.docs.length >= RESULT_DOCS_MAX || slot.bytes > RESULT_BYTES_MAX) {
          slot.capped = true
          break
        }
        slot.docs.push(d)
        slot.bytes += hostSize(d).bytes
      }
      slot.info.count = slot.docs.length
      const shown = Array.isArray(v) ? `${countText(v.length, 'document')}` : 'document'
      this.push(run, {
        kind: 'result',
        line: e.line,
        ms: e.ms,
        text: previewText(docs, Array.isArray(v)),
        resultIndex: slot.info.index,
        summary: shown,
        ...(r.note || slot.capped ? { note: [r.note, slot.capped ? `The panel shows the first ${slot.docs.length.toLocaleString('en-US')}.` : ''].filter(Boolean).join(' ') } : {})
      })
      return
    }
    this.push(run, { kind: 'result', line: e.line, ms: e.ms, text: clip(toShell(v)), ...(r.note ? { note: r.note } : {}) })
  }

  private newSlot(run: Run, line: number, kind: 'cursor' | 'docs', op?: Operation): Slot {
    const info: ShellResultInfo = { index: run.slots.length, title: titleOf(run.lines.slice(line - 1, line + 3).join('\n')), line, kind, ...(op ? { op } : {}) }
    const slot: Slot = { info, docs: [], bytes: 0, exhausted: false, capped: false }
    run.slots.push(slot)
    return slot
  }

  private async addCursor(run: Run, line: number, ms: number, value: JsonValue): Promise<void> {
    const spec = BSON.EJSON.deserialize(value as Document, { relaxed: false }) as Document
    const canonicalSpec = value as unknown as CursorSpec
    const client = await this.host.client(run.connectionId)
    const db = client.db(String(spec.db))
    const options = plainOptions(spec.options)
    let cursor: AbstractCursor<Document>
    if (spec.kind === 'find') {
      const c = db.collection(String(spec.collection)).find(spec.filter ?? {}, { ...EXACT, ...options, ...(spec.projection ? { projection: spec.projection } : {}) })
      cursor = c
    } else if (spec.collection !== null) {
      cursor = db.collection(String(spec.collection)).aggregate(spec.pipeline ?? [], { ...EXACT, ...options })
    } else {
      cursor = db.aggregate(spec.pipeline ?? [], { ...EXACT, ...options })
    }
    const slot = this.newSlot(run, line, 'cursor', cursorOperation(canonicalSpec))
    slot.cursor = cursor
    const started = Date.now()
    await this.readUntil(slot, PREVIEW_DOCS + 1)
    const more = slot.docs.length > PREVIEW_DOCS || !slot.exhausted
    const shown = slot.docs.slice(0, PREVIEW_DOCS)
    const target = `${String(spec.db)}${spec.collection !== null ? `.${String(spec.collection)}` : ''}`
    this.push(run, {
      kind: 'result',
      line,
      ms: ms + Date.now() - started,
      text: shown.length ? previewText(shown, true) : '(no documents)',
      resultIndex: slot.info.index,
      summary: `${spec.kind === 'find' ? 'find' : 'aggregate'} on ${target}: ${more ? `first ${countText(shown.length, 'document')}` : countText(shown.length, 'document')}`,
      ...(more ? { note: 'More in the Mongo Studio panel, which pages through the whole result.' } : {})
    })
  }

  private async readUntil(slot: Slot, count: number): Promise<void> {
    const cursor = slot.cursor
    while (slot.docs.length < count && !slot.exhausted && cursor) {
      if (slot.docs.length >= RESULT_DOCS_MAX || slot.bytes > RESULT_BYTES_MAX) {
        slot.capped = true
        slot.exhausted = true
        await cursor.close().catch(() => undefined)
        break
      }
      const doc = await cursor.next()
      if (doc === null) {
        slot.exhausted = true
        break
      }
      const c = toCanonical(doc)
      slot.docs.push(c)
      slot.bytes += hostSize(c).bytes
    }
    if (slot.exhausted) slot.info.count = slot.docs.length
    else delete slot.info.count
  }

  async page(runId: string, index: number, offset: number, pageSize: number): Promise<QueryPage> {
    const run = this.runs.get(runId)
    const slot = run?.slots[index]
    if (!run || !slot) throw invalid('Those results are no longer kept. Run the script again.', 'conflict')
    if (!Number.isInteger(offset) || offset < 0) throw invalid('The page offset must be 0 or more.')
    if (!Number.isInteger(pageSize) || pageSize < 1 || pageSize > 1000) throw invalid('Page size must be from 1 to 1000.')
    run.lastUsed = Date.now()
    const started = Date.now()
    await this.readUntil(slot, offset + pageSize + 1)
    const docs: JsonObject[] = []
    const truncated: number[] = []
    let bytes = 0
    let objects = 0
    let stoppedForSize = false
    let i = offset
    for (; i < slot.docs.length && docs.length < pageSize; i++) {
      const shown = pageCanonical(slot.docs[i]!)
      if (docs.length > 0 && (bytes + shown.bytes > PAGE_BYTE_BUDGET || objects + shown.objects > PAGE_OBJECT_BUDGET)) {
        stoppedForSize = true
        break
      }
      if (shown.cut) truncated.push(docs.length)
      docs.push(shown.doc)
      bytes += shown.bytes
      objects += shown.objects
    }
    const hasMore = i < slot.docs.length || !slot.exhausted
    return { queryId: `${runId}:${index}`, offset, docs, truncated, hasMore, stoppedForSize, ms: Date.now() - started }
  }

  // ---- The thread's database calls ----

  private async answer(session: Session, msg: { method: string; args: Uint8Array }): Promise<void> {
    let reply: { value?: Uint8Array; docs?: Uint8Array[]; error?: Document }
    try {
      const args = BSON.deserialize(msg.args, ARGS_READ).a as unknown[]
      const out = await this.dispatch(session, msg.method, args)
      reply = out.docs ? { docs: out.docs } : { value: copyBytes(BSON.serialize({ v: out.value }, { ignoreUndefined: true })) }
    } catch (error) {
      const e = error as { message?: string; name?: string; code?: unknown; codeName?: unknown; errorLabels?: unknown }
      reply = {
        error: {
          message: e.message ?? String(error),
          name: typeof e.name === 'string' ? e.name : 'Error',
          ...(typeof e.code === 'number' || typeof e.code === 'string' ? { code: e.code } : {}),
          ...(typeof e.codeName === 'string' ? { codeName: e.codeName } : {})
        }
      }
    }
    if (session.dead) return
    session.port.postMessage(reply)
    Atomics.store(session.signal, 0, 1)
    Atomics.notify(session.signal, 0)
  }

  private async dispatch(session: Session, method: string, args: unknown[]): Promise<{ value?: unknown; docs?: Uint8Array[] }> {
    session.lastUsed = Date.now()
    const client = await this.host.client(session.connectionId)
    const target = (t: unknown): { db: string; collection: string | null } => {
      const o = t as { db?: unknown; collection?: unknown }
      if (typeof o?.db !== 'string') throw invalid('No database named.')
      return { db: o.db, collection: typeof o.collection === 'string' ? o.collection : null }
    }
    switch (method) {
      case 'find.open': {
        const t = target(args[0])
        const options = plainOptions(args[3])
        const projection = args[2] && typeof args[2] === 'object' ? (args[2] as Document) : undefined
        const cursor = client.db(t.db).collection(t.collection!).find((args[1] ?? {}) as Document, { ...options, ...(projection ? { projection } : {}), raw: true })
        return { value: this.keepCursor(session, cursor as unknown as AbstractCursor<Buffer>) }
      }
      case 'aggregate.open': {
        const t = target(args[0])
        const pipeline = (args[1] ?? []) as Document[]
        const options = { ...plainOptions(args[2]), raw: true }
        const cursor = t.collection === null ? client.db(t.db).aggregate(pipeline, options) : client.db(t.db).collection(t.collection).aggregate(pipeline, options)
        return { value: this.keepCursor(session, cursor as unknown as AbstractCursor<Buffer>) }
      }
      case 'cursor.next': {
        const handle = Number(plainNumber(args[0]))
        const n = Math.max(1, Math.min(Number(plainNumber(args[1])) || 100, 1000))
        const cursor = session.cursors.get(handle)
        if (!cursor) return { docs: [] }
        const first = (await cursor.next()) as Buffer | null
        if (first === null) {
          session.cursors.delete(handle)
          await cursor.close().catch(() => undefined)
          return { docs: [] }
        }
        const rest = cursor.readBufferedDocuments(Math.min(n - 1, cursor.bufferedCount())) as Buffer[]
        return { docs: [first, ...rest].map(copyBytes) }
      }
      case 'cursor.close': {
        const handle = Number(plainNumber(args[0]))
        const cursor = session.cursors.get(handle)
        session.cursors.delete(handle)
        await cursor?.close().catch(() => undefined)
        return { value: null }
      }
      case 'collection':
        return { value: await this.collectionCall(client, target(args[0]), String(args[1]), (args[2] ?? []) as unknown[]) }
      case 'database':
        return { value: await this.databaseCall(client, String(args[0]), String(args[1]), (args[2] ?? []) as unknown[]) }
      default:
        throw invalid(`Unknown shell call ${method}.`)
    }
  }

  private keepCursor(session: Session, cursor: AbstractCursor<Buffer>): number {
    const handle = session.nextHandle++
    session.cursors.set(handle, cursor)
    return handle
  }

  private async collectionCall(client: MongoClient, t: { db: string; collection: string | null }, method: string, a: unknown[]): Promise<unknown> {
    if (t.collection === null) throw invalid('No collection named.')
    const coll = client.db(t.db).collection(t.collection)
    const doc = (i: number): Document => (a[i] ?? {}) as Document
    const o = (i: number): Document => plainOptions(a[i])
    switch (method) {
      case 'findOne':
        return coll.findOne(doc(0), { ...EXACT, ...o(1) })
      case 'countDocuments':
        return coll.countDocuments(doc(0), o(1))
      case 'estimatedDocumentCount':
        return coll.estimatedDocumentCount(o(0))
      case 'distinct':
        return coll.distinct(String(a[0]), doc(1), { ...EXACT, ...o(2) })
      case 'insertOne':
        return coll.insertOne(doc(0), o(1))
      case 'insertMany':
        if (!Array.isArray(a[0])) throw invalid('insertMany needs an array of documents.')
        return coll.insertMany(a[0] as Document[], o(1))
      case 'updateOne':
        return coll.updateOne(doc(0), a[1] as Document, o(2))
      case 'updateMany':
        return coll.updateMany(doc(0), a[1] as Document, o(2))
      case 'replaceOne':
        return coll.replaceOne(doc(0), doc(1), o(2))
      case 'deleteOne':
        return coll.deleteOne(doc(0), o(1))
      case 'deleteMany':
        return coll.deleteMany(doc(0), o(1))
      case 'findOneAndUpdate':
        return coll.findOneAndUpdate(doc(0), a[1] as Document, { ...EXACT, ...o(2) })
      case 'findOneAndReplace':
        return coll.findOneAndReplace(doc(0), doc(1), { ...EXACT, ...o(2) })
      case 'findOneAndDelete':
        return coll.findOneAndDelete(doc(0), { ...EXACT, ...o(1) })
      case 'bulkWrite':
        if (!Array.isArray(a[0])) throw invalid('bulkWrite needs an array of operations.')
        return coll.bulkWrite(a[0] as never, o(1))
      case 'createIndex':
        return coll.createIndex(doc(0) as never, o(1))
      case 'createIndexes':
        return coll.createIndexes(a[0] as never, o(1))
      case 'indexes':
        return coll.indexes({ ...EXACT })
      case 'dropIndex':
        return coll.dropIndex(a[0] as never)
      case 'dropIndexes':
        return a.length ? client.db(t.db).command({ dropIndexes: t.collection, index: a[0] as never }, EXACT) : coll.dropIndexes()
      case 'drop':
        return coll.drop(o(0))
      case 'rename':
        await coll.rename(String(a[0]), o(1))
        return { ok: 1 }
      case 'isCapped':
        return coll.isCapped()
      case 'stats': {
        const [s] = await coll.aggregate([{ $collStats: { storageStats: {}, count: {} } }], EXACT).toArray()
        return s ?? null
      }
      default:
        throw invalid(`Unknown collection method ${method}.`)
    }
  }

  private async databaseCall(client: MongoClient, dbName: string, method: string, a: unknown[]): Promise<unknown> {
    const db = client.db(dbName)
    switch (method) {
      case 'collectionNames':
        return (await db.listCollections({}, { nameOnly: true, authorizedCollections: true }).toArray()).map((c) => c.name)
      case 'collectionInfos':
        return db.listCollections((a[0] ?? {}) as Document, plainOptions(a[1])).toArray()
      case 'createCollection':
        await db.createCollection(String(a[0]), plainOptions(a[1]))
        return { ok: 1 }
      case 'dropDatabase':
        return db.dropDatabase()
      case 'command':
        return db.command((a[0] ?? {}) as Document, { ...EXACT, ...plainOptions(a[1]) })
      case 'listDatabases':
        return client.db('admin').admin().listDatabases({ authorizedDatabases: true })
      default:
        throw invalid(`Unknown database method ${method}.`)
    }
  }

  // ---- Autocomplete and databases ----

  async databases(connectionId: string): Promise<string[]> {
    const client = await this.host.client(connectionId)
    const r = await client.db('admin').admin().listDatabases({ nameOnly: true, authorizedDatabases: true })
    return r.databases.map((d) => d.name).sort()
  }

  async complete(connectionId: string, db: string, collection?: string): Promise<{ collections: string[]; fields: string[] }> {
    const client = await this.host.client(connectionId)
    const cached = async (key: string, load: () => Promise<string[]>): Promise<string[]> => {
      const hit = this.completeCache.get(key)
      if (hit && Date.now() - hit.at < COMPLETE_TTL_MS) return hit.value
      const value = await load().catch(() => [] as string[])
      this.completeCache.set(key, { at: Date.now(), value })
      if (this.completeCache.size > 200) this.completeCache.delete(this.completeCache.keys().next().value!)
      return value
    }
    const collections = await cached(JSON.stringify([connectionId, db]), async () =>
      (await client.db(db).listCollections({}, { nameOnly: true, authorizedCollections: true }).toArray()).map((c) => c.name).sort()
    )
    const fields = collection
      ? await cached(JSON.stringify([connectionId, db, collection]), async () => {
          const docs = await client.db(db).collection(collection).aggregate([{ $sample: { size: SAMPLE_SIZE } }], { ...EXACT, maxTimeMS: 5000 }).toArray()
          const out = new Set<string>()
          for (const d of docs) fieldPaths(toCanonical(d), '', out)
          return [...out].sort((x, y) => (x === '_id' ? -1 : y === '_id' ? 1 : x.localeCompare(y))).slice(0, 500)
        })
      : []
    return { collections, fields }
  }

  // ---- Clean-up ----

  async closeFor(connectionId: string): Promise<void> {
    for (const s of [...this.sessions.values()]) if (s.connectionId === connectionId) this.endSession(s, 'The connection closed.')
    for (const r of [...this.runs.values()]) if (r.connectionId === connectionId) await this.dropRun(r)
    if (this.latest && !this.runs.has(this.latest)) this.latest = undefined
  }

  async closeAll(): Promise<void> {
    for (const s of [...this.sessions.values()]) this.endSession(s)
    for (const r of [...this.runs.values()]) await this.dropRun(r)
    this.latest = undefined
    this.stopSweeper()
  }

  private startSweeper(): void {
    if (this.sweeper) return
    this.sweeper = setInterval(() => {
      const now = Date.now()
      for (const s of [...this.sessions.values()]) if (now - s.lastUsed > SESSION_IDLE_MS && !(s.run && !s.run.done)) this.endSession(s)
      for (const r of [...this.runs.values()]) if (r.done && r.id !== this.latest && now - r.lastUsed > RUN_KEEP_MS) void this.dropRun(r)
      if (this.sessions.size === 0 && this.runs.size === 0) this.stopSweeper()
    }, 60_000)
    this.sweeper.unref?.()
  }

  private stopSweeper(): void {
    if (this.sweeper) clearInterval(this.sweeper)
    this.sweeper = undefined
  }
}

// ---- What the thread posts ----

type Described =
  | { kind: 'value'; value: JsonValue; note?: string; docs?: boolean }
  | { kind: 'cursor'; cursor: JsonValue }
  | { kind: 'text'; text: string; note?: string }
  | { kind: 'undefined' }

type ThreadEntry =
  | { kind: 'print'; parts: ({ text: string; kind?: undefined } | Described)[] }
  | { kind: 'info'; text: string; db?: string }
  | { kind: 'result'; line: number; ms: number; result: Described; show?: 'databases' | 'lines' }
  | { kind: 'error'; line?: number; column?: number; name?: string; message: string; code?: string | number; codeName?: string }

function describedText(p: Described): string {
  if (p.kind === 'text') return p.text
  if (p.kind === 'value') return typeof p.value === 'string' ? p.value : toShell(p.value)
  if (p.kind === 'cursor') return '[cursor]'
  return 'undefined'
}

/** Documents one per line when they are short, as a list reads best; long ones in full. */
function previewText(docs: JsonValue[], asList: boolean): string {
  if (!asList) return clip(toShell(docs[0]!))
  return clip(
    docs
      .map((d) => {
        const inline = toShellInline(d)
        return inline.length <= 160 ? inline : toShell(d)
      })
      .join('\n')
  )
}

function sizeText(v: JsonValue | undefined): string {
  const n = typeof v === 'number' ? v : isObject(v) ? Number(v.$numberDouble ?? v.$numberLong ?? v.$numberInt) : NaN
  if (!Number.isFinite(n)) return ''
  const units = ['B', 'KiB', 'MiB', 'GiB', 'TiB']
  let x = n
  let u = 0
  while (x >= 1024 && u < units.length - 1) {
    x /= 1024
    u++
  }
  return `${u === 0 ? x : x.toFixed(1)} ${units[u]}`
}

/** A write's answer (`{ acknowledged, insertedId }`) is shown as text, not opened as a result. */
function looksLikeDocument(v: JsonObject): boolean {
  const keys = Object.keys(v)
  if (keys.includes('acknowledged')) return false
  if (keys.length <= 3 && keys.includes('ok')) return false
  return true
}
