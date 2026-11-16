// Saved tasks: an import, export, copy, compare or sync saved with its options and run again on
// demand, from the Tasks tab. A task holds the same request its tab sends to start the job, so a
// run does exactly what the tab would. Nothing runs on a schedule: Orca automations start AI
// agents, and the worker stops when idle. Pure, so the panel, the worker and tests share it.
import type { ExportDestination, ExportOptions, ExportSource, ImportOptions, JobResult, JobStatus, Namespace } from '../protocol'
import type { CompareRules } from './compare'
import { toShellInline, type JsonObject } from './ejson-view'

export type TaskRequest =
  | { kind: 'export'; source: ExportSource; options: ExportOptions; destination: ExportDestination }
  /** Imports read a path: pasted text is gone once the worker stops. */
  | { kind: 'import'; source: { kind: 'path'; path: string }; options: ImportOptions; ns: Namespace }
  | { kind: 'compare'; a: Namespace; b: Namespace; filter?: JsonObject; rules: CompareRules }
  | { kind: 'sync'; from: Namespace; to: Namespace; filter?: JsonObject; rules: CompareRules; insert: boolean; replace: boolean; remove: boolean }

export type TaskKind = TaskRequest['kind']

export type TaskRun = {
  at: number
  status: JobStatus
  ms: number
  /** What it did, in a sentence (or why it failed). */
  summary: string
  errorCount: number
}

export type Task = {
  id: string
  name: string
  request: TaskRequest
  createdAt: number
  updatedAt: number
  lastRun?: TaskRun
}

export const TASK_NAME_MAX = 100

export function taskKindLabel(r: TaskRequest): string {
  if (r.kind === 'export') return r.options.format === 'collection' ? 'Copy' : 'Export'
  return { import: 'Import', compare: 'Compare', sync: 'Sync' }[r.kind]
}

function nsText(ns: Namespace, name: (connectionId: string) => string): string {
  return `${name(ns.connectionId)} · ${ns.db}${ns.collection ? `.${ns.collection}` : ''}`
}

/** Every connection a task uses. */
export function taskConnections(r: TaskRequest): string[] {
  const ids: string[] = []
  if (r.kind === 'export') {
    ids.push(r.source.kind === 'database' ? r.source.connectionId : r.source.ns.connectionId)
    if (r.options.format === 'collection' && r.options.collection) ids.push(r.options.collection.connectionId)
  } else if (r.kind === 'import') ids.push(r.ns.connectionId)
  else if (r.kind === 'compare') ids.push(r.a.connectionId, r.b.connectionId)
  else ids.push(r.from.connectionId, r.to.connectionId)
  return [...new Set(ids)]
}

/** The connection a task writes to, if it writes to a database at all. */
export function taskWriteConnection(r: TaskRequest): string | undefined {
  if (r.kind === 'export') return r.options.format === 'collection' ? r.options.collection?.connectionId : undefined
  if (r.kind === 'import') return r.ns.connectionId
  if (r.kind === 'sync') return r.to.connectionId
  return undefined
}

/**
 * What a run removes or overwrites, for the confirmation before it: `ns` is the collection to
 * count (absent when it is a database's worth of collections).
 */
export function taskDanger(r: TaskRequest, name: (connectionId: string) => string): { title: string; text: string; ns?: Namespace } | undefined {
  if (r.kind === 'import' && r.options.drop) {
    if (!r.ns.collection) return { title: `Replace collections of ${nsText(r.ns, name)}?`, text: 'Each collection the folder holds is dropped with its indexes, then imported into.' }
    return { title: `Drop ${nsText(r.ns, name)}?`, text: 'The collection is dropped with its indexes, then the import writes into it.', ns: r.ns }
  }
  if (r.kind === 'export' && r.options.format === 'collection' && r.options.collection?.mode === 'replace') {
    const c = r.options.collection
    if (r.source.kind === 'database') {
      return { title: `Replace collections of ${name(c.connectionId)} · ${c.db}?`, text: `Each collection of ${c.db} that ${r.source.db} also has is dropped with its indexes, then copied into.` }
    }
    const ns = { connectionId: c.connectionId, db: c.db, collection: c.collection ?? r.source.ns.collection }
    return { title: `Drop ${nsText(ns, name)}?`, text: 'The collection is dropped with its indexes, then copied into.', ns }
  }
  if (r.kind === 'sync') {
    const changes = [r.insert ? 'inserts what is only in the source' : '', r.replace ? 'replaces the documents that differ' : '', r.remove ? 'deletes what is only in the target' : ''].filter(Boolean)
    return { title: `Change ${nsText(r.to, name)}?`, text: `The sync ${changes.join(', ')}, to match ${nsText(r.from, name)}.`, ns: r.to }
  }
  return undefined
}

/** The task in a few lines, for its details. */
export function describeTask(r: TaskRequest, name: (connectionId: string) => string): { label: string; value: string }[] {
  const out: { label: string; value: string }[] = []
  const filterText = (f: JsonObject | undefined): string => (f && Object.keys(f).length ? toShellInline(f) : 'all documents')
  if (r.kind === 'export') {
    const s = r.source
    if (s.kind === 'database') out.push({ label: 'From', value: `${name(s.connectionId)} · database ${s.db}` })
    else {
      out.push({ label: 'From', value: nsText(s.ns, name) })
      if (s.kind === 'query') out.push({ label: 'Query', value: `${filterText(s.spec.filter)}${s.spec.limit ? `, at most ${s.spec.limit.toLocaleString('en-US')}` : ''}` })
      else out.push({ label: 'Pipeline', value: `${s.pipeline.length} stage${s.pipeline.length === 1 ? '' : 's'}` })
    }
    const o = r.options
    if (o.format === 'collection' && o.collection) {
      const c = o.collection
      out.push({ label: 'Into', value: `${name(c.connectionId)} · ${c.db}${c.collection ? `.${c.collection}` : ''}` })
      out.push({ label: 'Writes', value: { insert: 'insert new documents', upsert: 'replace by _id', merge: 'merge by _id', replace: 'drop first, then insert' }[c.mode] })
    } else {
      out.push({ label: 'Format', value: o.format === 'json' ? `JSON${o.json?.layout === 'array' ? ' array' : ' lines'}${o.json?.relaxed === false ? ', canonical' : ''}` : o.format.toUpperCase() })
      out.push({ label: 'To', value: r.destination.kind === 'path' ? `${r.destination.path}${r.destination.overwrite ? ' (replaced)' : ''}` : 'the save dialog, after the run' })
    }
  } else if (r.kind === 'import') {
    out.push({ label: 'From', value: r.source.path })
    out.push({ label: 'Into', value: nsText(r.ns, name) })
    out.push({ label: 'Format', value: r.options.format === 'auto' ? 'from the file' : r.options.format.toUpperCase() })
    out.push({ label: 'Writes', value: `${{ insert: 'insert new documents', upsert: 'replace by _id', merge: 'merge by _id' }[r.options.mode]}${r.options.drop ? ', after dropping the collection' : ''}` })
  } else if (r.kind === 'compare') {
    out.push({ label: 'A', value: nsText(r.a, name) }, { label: 'B', value: nsText(r.b, name) }, { label: 'Documents', value: filterText(r.filter) })
    if (r.rules.ignoreFields.length) out.push({ label: 'Left out', value: r.rules.ignoreFields.join(', ') })
  } else {
    out.push({ label: 'From', value: nsText(r.from, name) }, { label: 'To', value: nsText(r.to, name) }, { label: 'Documents', value: filterText(r.filter) })
    out.push({ label: 'Changes', value: [r.insert ? 'insert' : '', r.replace ? 'replace' : '', r.remove ? 'delete' : ''].filter(Boolean).join(', ') })
  }
  return out
}

const n = (x: number): string => x.toLocaleString('en-US')
const docs = (x: number): string => `${n(x)} document${x === 1 ? '' : 's'}`

/** A finished job's result in a sentence. */
export function resultSummary(result: JobResult): string {
  switch (result.kind) {
    case 'import':
      return `Read ${docs(result.read)}: ${n(result.inserted)} inserted${result.updated ? `, ${n(result.updated)} updated` : ''}${result.failed ? `, ${n(result.failed)} failed` : ''}.`
    case 'export':
      if (result.inserted !== undefined || result.updated !== undefined) {
        return `Copied ${docs(result.docs)}${result.collections > 1 ? ` of ${result.collections} collections` : ''}: ${n(result.inserted ?? 0)} inserted${result.updated ? `, ${n(result.updated)} updated` : ''}${result.failed ? `, ${n(result.failed)} failed` : ''}.`
      }
      if (result.written?.length) return `Wrote ${docs(result.docs)} to ${result.written.length === 1 ? result.written[0] : `${result.written.length} files`}.`
      return `Exported ${docs(result.docs)}${result.download ? `, ready to save as ${result.download.name}` : ''}.`
    case 'compare':
      return `${n(result.same)} the same, ${n(result.differ)} differ, ${n(result.onlyA)} only in A, ${n(result.onlyB)} only in B.`
    case 'sync':
      return `${n(result.inserted)} inserted, ${n(result.replaced)} replaced, ${n(result.deleted)} deleted${result.failed ? `, ${n(result.failed)} failed` : ''}.`
    case 'gridfs-upload':
      return `Uploaded ${n(result.bytes)} bytes.`
  }
}

// ---- Checking a request from the panel ----

function fail(message: string): never {
  throw Object.assign(new Error(message), { code: 'invalid_params' })
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

function checkNs(v: unknown, what: string): Namespace {
  if (!isRecord(v) || typeof v.connectionId !== 'string' || typeof v.db !== 'string' || typeof v.collection !== 'string' || !v.db || !v.collection) fail(`The task's ${what} is not a collection.`)
  return { connectionId: v.connectionId, db: v.db, collection: v.collection }
}

/** The task name, trimmed, or an error. */
export function checkTaskName(name: unknown): string {
  const t = typeof name === 'string' ? name.trim() : ''
  if (!t) fail('Give the task a name.')
  if (t.length > TASK_NAME_MAX) fail(`A task name has at most ${TASK_NAME_MAX} characters.`)
  return t
}

/** Checks a request's shape; the job's own start checks the rest when it runs. */
export function checkTaskRequest(raw: unknown): TaskRequest {
  if (!isRecord(raw)) fail('A task needs a request.')
  switch (raw.kind) {
    case 'export': {
      const s = raw.source
      if (!isRecord(s) || !['query', 'pipeline', 'database'].includes(String(s.kind))) fail('The task has no source to export.')
      if (s.kind === 'database') {
        if (typeof s.connectionId !== 'string' || typeof s.db !== 'string' || !s.db) fail('The task\'s source database is missing.')
      } else {
        checkNs(s.ns, 'source')
        if (s.kind === 'query' && !isRecord(s.spec)) fail('The task\'s query is missing.')
        if (s.kind === 'pipeline' && !Array.isArray(s.pipeline)) fail('The task\'s pipeline is missing.')
      }
      const o = raw.options
      if (!isRecord(o) || !['json', 'csv', 'bson', 'collection'].includes(String(o.format))) fail('The task has no export format.')
      if (o.format === 'collection' && (!isRecord(o.collection) || typeof o.collection.connectionId !== 'string' || typeof o.collection.db !== 'string' || !o.collection.db)) fail('The task has no collection to copy into.')
      const d = raw.destination
      if (!isRecord(d) || (d.kind !== 'download' && d.kind !== 'path')) fail('The task has no destination.')
      if (d.kind === 'path' && (typeof d.path !== 'string' || !d.path.trim())) fail('The task has no path to write to.')
      return raw as TaskRequest
    }
    case 'import': {
      const s = raw.source
      if (!isRecord(s) || s.kind !== 'path' || typeof s.path !== 'string' || !s.path.trim()) fail('A saved import reads a file or folder by its path: pasted text can\'t be saved in a task.')
      if (!isRecord(raw.options)) fail('The task has no import options.')
      if (!isRecord(raw.ns) || typeof raw.ns.connectionId !== 'string' || typeof raw.ns.db !== 'string' || !raw.ns.db) fail('The task has no database to import into.')
      return raw as TaskRequest
    }
    case 'compare': {
      checkNs(raw.a, 'collection A')
      checkNs(raw.b, 'collection B')
      if (!isRecord(raw.rules)) fail('The task has no comparison rules.')
      return raw as TaskRequest
    }
    case 'sync': {
      checkNs(raw.from, 'source')
      checkNs(raw.to, 'target')
      if (!isRecord(raw.rules)) fail('The task has no comparison rules.')
      if (!raw.insert && !raw.replace && !raw.remove) fail('A sync task needs at least one change: insert, replace or delete.')
      return raw as TaskRequest
    }
    default:
      return fail('Unknown kind of task.')
  }
}

/** A name not taken yet: `name`, else `name (2)`, `name (3)`, … */
export function freeTaskName(name: string, taken: readonly string[]): string {
  const lower = new Set(taken.map((t) => t.toLowerCase()))
  if (!lower.has(name.toLowerCase())) return name
  for (let i = 2; ; i++) {
    const next = `${name} (${i})`
    if (!lower.has(next.toLowerCase())) return next
  }
}
