// The Export tab: a find (from a collection tab's query bar), a pipeline (from an aggregation tab)
// or a whole database, to JSON, CSV or BSON (the save dialog or a path), or into a collection on
// any saved connection. Pasting what was copied in the tree opens it set up as a copy.
import { plugin } from 'orca'
import type { AggOptions, ExportDestination, ExportFormat, ExportOptions, ExportSource, Namespace, QuerySpec, WriteMode } from '../protocol'
import type { JsonObject, JsonValue } from '../shared/ejson-view'
import { toShellInline } from '../shared/ejson-view'
import type { NodeKind } from '../shared/nodes'
import { parseShellDocument, ShellParseError } from '../shared/shell-parse'
import { adminTabId, changeAdmin, connectionName, numberText, refreshTree, sayAdmin, showOrAdd, tabOf } from './admin-state'
import { cancelJob, dropDownload, followJob, saveDownload, type Clip, type JobBox } from './data-state'
import type { Place } from './place-view'
import { settings } from './settings-state'
import { errorText } from './state'

export type ExportFrom =
  | { kind: 'query'; ns: Namespace; collKind: NodeKind }
  | { kind: 'pipeline'; ns: Namespace; pipeline: JsonObject[]; options: AggOptions }
  | { kind: 'database'; connectionId: string; db: string }

export type ExportTab = {
  id: string
  kind: 'export'
  connectionId: string
  title: string
  notice?: { tone: 'success' | 'danger' | 'neutral'; text: string }
  from: ExportFrom
  /** A find's text, as typed (shell syntax). */
  query: { filter: string; projection: string; sort: string; limit: string }
  queryErrors: Partial<Record<'filter' | 'projection' | 'sort' | 'limit', string>>
  format: ExportFormat
  json: { layout: 'lines' | 'array'; relaxed: boolean; pretty: boolean }
  csv: { fields: string[]; delimiter: string; header: boolean; available?: string[]; loading: boolean; add: string; selected: string[] }
  bsonMetadata: boolean
  target: { connectionId: string; db: string; collection: string; mode: WriteMode | 'replace'; indexes: boolean; options: boolean }
  destination: 'download' | 'path'
  path: string
  overwrite: boolean
  confirm?: { label: string; count: number | null }
  job?: JobBox
  /** The saved task this tab was opened from, or last saved as. */
  task?: { id: string; name: string }
  /** The name typed for saving it as a task. */
  taskName: string
}

export function exportTabId(from: ExportFrom): string {
  return from.kind === 'database' ? adminTabId('export', ['db', from.connectionId, from.db]) : adminTabId('export', [from.kind, from.ns.connectionId, from.ns.db, from.ns.collection])
}

function fromLabel(from: ExportFrom): string {
  return from.kind === 'database' ? from.db : from.ns.collection
}

function newTab(from: ExportFrom, query?: Partial<ExportTab['query']>): ExportTab {
  const connectionId = from.kind === 'database' ? from.connectionId : from.ns.connectionId
  const db = from.kind === 'database' ? from.db : from.ns.db
  return {
    id: exportTabId(from),
    kind: 'export',
    connectionId,
    title: `Export: ${fromLabel(from)}`,
    from,
    query: { filter: '', projection: '', sort: '', limit: '', ...query },
    queryErrors: {},
    format: 'json',
    json: { layout: 'lines', relaxed: settings().ejson === 'relaxed', pretty: false },
    csv: { fields: [], delimiter: ',', header: true, loading: false, add: '', selected: [] },
    bsonMetadata: true,
    target: { connectionId, db: from.kind === 'database' ? `${db}_copy` : db, collection: from.kind === 'database' ? '' : `${from.ns.collection}_copy`, mode: 'insert', indexes: true, options: true },
    destination: from.kind === 'database' ? 'path' : 'download',
    path: '',
    overwrite: false,
    taskName: ''
  }
}

/** Opens (or shows) the Export tab of a source. A find's text replaces what the tab held. */
export function openExport(from: ExportFrom, query?: Partial<ExportTab['query']>, setup?: (t: ExportTab) => Partial<ExportTab>): void {
  const tab = newTab(from, query)
  const fresh = showOrAdd(tab)
  if (!fresh) changeAdmin(tab.id, 'export', () => ({ from, ...(query ? { query: { ...tab.query } } : {}), queryErrors: {} }))
  if (setup) changeAdmin(tab.id, 'export', (t) => setup(t))
  changeAdmin(tab.id, 'export', (t) => ({ title: `${t.format === 'collection' ? 'Copy' : 'Export'}: ${fromLabel(t.from)}` }))
}

/** A find's text from a collection tab's query bar. */
export function queryText(spec: { filter?: string; projection?: string; sort?: string; limit?: string }): Partial<ExportTab['query']> {
  return { filter: spec.filter ?? '', projection: spec.projection ?? '', sort: spec.sort ?? '', limit: spec.limit ?? '' }
}

export function setExport(id: string, change: Partial<ExportTab> | ((t: ExportTab) => Partial<ExportTab>)): void {
  changeAdmin(id, 'export', (t) => {
    const c = typeof change === 'function' ? change(t) : change
    const next = { ...t, ...c }
    return { ...c, confirm: undefined, title: `${next.format === 'collection' ? 'Copy' : 'Export'}: ${fromLabel(next.from)}` }
  })
}

/** The find as a spec, or field errors. */
export function exportSpec(t: ExportTab): { spec?: QuerySpec; errors: ExportTab['queryErrors'] } {
  const errors: ExportTab['queryErrors'] = {}
  const doc = (field: 'filter' | 'projection' | 'sort'): JsonObject | undefined => {
    const text = t.query[field].trim()
    if (!text) return undefined
    try {
      return parseShellDocument(text, field)
    } catch (error) {
      errors[field] = error instanceof ShellParseError ? error.message : errorText(error)
      return undefined
    }
  }
  const filter = doc('filter') ?? {}
  const projection = doc('projection')
  const sort = doc('sort')
  const limitText = t.query.limit.trim()
  const limit = limitText ? Number(limitText) : 0
  if (limitText && (!Number.isInteger(limit) || limit < 0)) errors.limit = 'A whole number, 0 for none.'
  if (Object.keys(errors).length) return { errors }
  const spec: QuerySpec = { filter, skip: 0, limit }
  if (projection) spec.projection = projection
  if (sort) spec.sort = sort
  return { spec, errors }
}

function source(t: ExportTab): ExportSource {
  if (t.from.kind === 'database') return { kind: 'database', connectionId: t.from.connectionId, db: t.from.db }
  if (t.from.kind === 'pipeline') return { kind: 'pipeline', ns: t.from.ns, pipeline: t.from.pipeline, options: t.from.options }
  const { spec, errors } = exportSpec(t)
  if (!spec) {
    changeAdmin(t.id, 'export', () => ({ queryErrors: errors }))
    throw new Error('Fix the query first.')
  }
  return { kind: 'query', ns: t.from.ns, spec }
}

function options(t: ExportTab): ExportOptions {
  const o: ExportOptions = { format: t.format }
  if (t.format === 'json') o.json = t.json
  if (t.format === 'csv') o.csv = { fields: t.csv.fields, delimiter: t.csv.delimiter === 'tab' ? '\t' : t.csv.delimiter, header: t.csv.header }
  if (t.format === 'bson') o.bson = { metadata: t.bsonMetadata }
  if (t.format === 'collection') {
    const x = t.target
    o.collection = { connectionId: x.connectionId, db: x.db.trim(), mode: x.mode, indexes: x.indexes, options: x.options, ...(t.from.kind === 'database' ? {} : { collection: x.collection.trim() }) }
  }
  return o
}

function destination(t: ExportTab): ExportDestination {
  if (t.format === 'collection' || t.destination === 'download') return { kind: 'download' }
  if (!t.path.trim()) throw new Error(t.from.kind === 'database' ? 'Enter the folder to write the collections into.' : 'Enter the path of the file to write.')
  return { kind: 'path', path: t.path.trim(), overwrite: t.overwrite }
}

/** Problems that stop the export before it starts. */
export function exportProblems(t: ExportTab): string[] {
  const out: string[] = []
  if (t.format === 'collection') {
    if (!t.target.db.trim()) out.push('Enter the database to copy into.')
    if (t.from.kind !== 'database' && !t.target.collection.trim()) out.push('Enter the collection to copy into.')
    if (t.from.kind !== 'database' && t.target.connectionId === t.connectionId && t.target.db.trim() === t.from.ns.db && t.target.collection.trim() === t.from.ns.collection) out.push('That is the collection being copied: choose another name or database.')
  } else if (t.from.kind === 'database' && t.destination === 'download') out.push('A whole database is written to a folder: choose "Write to a path".')
  return out
}

function targetNs(t: ExportTab): Namespace {
  return { connectionId: t.target.connectionId, db: t.target.db.trim(), collection: t.target.collection.trim() }
}

/** What the tab would start, as `export.start` (and a saved task) takes it. */
export function exportRequest(t: ExportTab): { source: ExportSource; options: ExportOptions; destination: ExportDestination } {
  const problems = exportProblems(t)
  if (problems.length) throw new Error(problems.join(' '))
  return { source: source(t), options: options(t), destination: destination(t) }
}

export async function startExport(id: string, confirmed = false): Promise<void> {
  const t = tabOf(id, 'export')
  if (!t) return
  const { source: src, options: opts, destination: dest } = exportRequest(t)
  if (t.format === 'collection' && t.target.mode === 'replace' && !confirmed) {
    const from = t.from
    if (from.kind === 'database') {
      changeAdmin(id, 'export', () => ({ confirm: { label: `the collections of ${t.target.db.trim()} on ${connectionName(t.target.connectionId)} that ${from.db} also has`, count: null } }))
      return
    }
    const c = await plugin.request('data.count', { ns: targetNs(t) })
    if (c.exists) {
      changeAdmin(id, 'export', () => ({ confirm: { label: `${t.target.db.trim()}.${t.target.collection.trim()} on ${connectionName(t.target.connectionId)}`, count: c.count } }))
      return
    }
  }
  changeAdmin(id, 'export', (x) => {
    dropDownload(x.job)
    return { confirm: undefined, job: undefined, queryErrors: {} }
  })
  const { jobId } = await plugin.request('export.start', { source: src, options: opts, destination: dest })
  changeAdmin(id, 'export', () => ({ job: { jobId } }))
  const end = await followJob(jobId, () => tabOf(id, 'export')?.job, (job) => changeAdmin(id, 'export', () => ({ job })))
  const r = end?.result
  if (end?.status !== 'done' || r?.kind !== 'export') return
  if (t.format === 'collection') {
    sayAdmin(id, end.errorCount ? 'neutral' : 'success', `Copied ${numberText(r.docs)} document${r.docs === 1 ? '' : 's'}${r.collections > 1 ? ` of ${r.collections} collections` : ''}: ${numberText(r.inserted ?? 0)} inserted${r.updated ? `, ${numberText(r.updated)} updated` : ''}${r.failed ? `, ${numberText(r.failed)} failed` : ''}${r.indexes ? `, ${numberText(r.indexes)} indexes` : ''}.`)
    await refreshTree(t.target.connectionId, t.target.db.trim())
  } else if (r.written) sayAdmin(id, 'success', `Wrote ${numberText(r.docs)} document${r.docs === 1 ? '' : 's'} to ${r.written.length === 1 ? r.written[0] : `${r.written.length} files`}.`)
}

export async function saveExport(id: string): Promise<void> {
  const t = tabOf(id, 'export')
  if (await saveDownload(t?.job)) sayAdmin(id, 'success', `Saved ${t?.job?.download?.name ?? 'the file'}.`)
}

export async function cancelExport(id: string): Promise<void> {
  await cancelJob(tabOf(id, 'export')?.job)
}

/** Samples the collection's fields for the CSV columns. */
export async function loadFields(id: string): Promise<void> {
  const t = tabOf(id, 'export')
  if (!t || t.from.kind === 'database') return
  changeAdmin(id, 'export', (x) => ({ csv: { ...x.csv, loading: true } }))
  try {
    const parsed = t.from.kind === 'query' ? exportSpec(t).spec : undefined
    const { fields } = await plugin.request('export.fields', { ns: t.from.ns, ...(parsed && Object.keys(parsed.filter).length ? { filter: parsed.filter } : {}) }, { timeoutMs: 60000 })
    changeAdmin(id, 'export', (x) => ({ csv: { ...x.csv, available: fields, loading: false, fields: x.csv.fields.length ? x.csv.fields : fields } }))
  } catch (error) {
    changeAdmin(id, 'export', (x) => ({ csv: { ...x.csv, loading: false } }))
    throw error
  }
}

export function setFields(id: string, fields: string[]): void {
  setExport(id, (t) => ({ csv: { ...t.csv, fields: [...new Set(fields.map((f) => f.trim()).filter(Boolean))] } }))
}

export function moveField(id: string, field: string, delta: -1 | 1): void {
  setExport(id, (t) => {
    const f = [...t.csv.fields]
    const i = f.indexOf(field)
    const j = i + delta
    if (i < 0 || j < 0 || j >= f.length) return {}
    ;[f[i], f[j]] = [f[j]!, f[i]!]
    return { csv: { ...t.csv, fields: f } }
  })
}

// ---- Paste ----

/** Where a paste lands: a database, a collection, or a connection (for a database). */
export type PasteTarget = { connectionId: string; db?: string; collection?: string }

/** Opens the Export tab set up to copy what the clipboard holds into the target. */
export function paste(clip: Clip, at: PasteTarget): void {
  if (clip.kind === 'database') {
    openExport({ kind: 'database', connectionId: clip.connectionId, db: clip.db }, undefined, (t) => ({
      format: 'collection',
      target: { ...t.target, connectionId: at.connectionId, db: at.db ?? clip.db, mode: 'insert' }
    }))
    return
  }
  const ns = clip.ns
  const query = clip.kind === 'documents' ? { filter: `{ _id: { $in: ${toShellInline(clip.ids as JsonValue[])} } }` } : {}
  openExport({ kind: 'query', ns, collKind: clip.kind === 'collection' ? clip.collKind : 'coll' }, queryText(query), (t) => ({
    format: 'collection',
    target: { ...t.target, connectionId: at.connectionId, db: at.db ?? ns.db, collection: at.collection ?? ns.collection, mode: clip.kind === 'documents' ? 'upsert' : 'insert' }
  }))
}

/** Where the tab works: the source it reads, and for a copy the collection or database it writes. */
export function exportPlaces(t: ExportTab): Place[] {
  const f = t.from
  const from: Place = f.kind === 'database' ? { connectionId: f.connectionId, db: f.db } : { ...f.ns }
  if (t.format !== 'collection') return [from]
  const into: Place = { ...targetNs(t), writes: true }
  if (f.kind === 'database') delete into.collection
  return [{ ...from, label: 'From' }, { ...into, label: 'Into' }]
}

/** What a pipeline export runs, beside its places. */
export function sourceDetail(t: ExportTab): string | undefined {
  const f = t.from
  return f.kind === 'pipeline' ? `pipeline of ${f.pipeline.length} stage${f.pipeline.length === 1 ? '' : 's'}` : undefined
}

