// Collection tabs: each open collection, view or time-series collection is a tab with its own
// query bar, results, editors, Query Builder and history. All tabs live in one atom, changed
// immutably through `change(id, ...)`, so a tab's state survives switching between tabs.
import { atom, plugin, read, set, update } from 'orca'
import type { AggOptions, CopyItem, CountResult, ExplainResult, Namespace, PreviewResult, QueryLibrary, QueryPage, QuerySpec, QueryText, SavedPipeline, UpdatePreview } from '../protocol'
import type { ExplainVerbosity } from '../shared/explain'
import { hasWriteStage, type StageDraft } from '../shared/pipeline'
import { bsonType, fieldPaths, hasTruncated, idKey, isObject, toJsonText, toShell, toShellInline, valueAt, type JsonObject, type JsonValue } from '../shared/ejson-view'
import { draftFromValue, valueFromDraft, type FieldDraft } from '../shared/field-edit'
import { builderToFilter, emptyGroup, filterToBuilder, newCondition, type BuilderProblem, type Group } from '../shared/query-builder'
import { fitsHost, QUERY_TEXT_MAX } from '../shared/host-size'
import { nodeTarget, type NodeKind } from '../shared/nodes'
import { parseShell, parseShellDocument, shellProblem, ShellParseError } from '../shared/shell-parse'
import { compactQuery, formatQuery } from '../shared/query-format'
import { mergeFilterText } from '../shared/table-filter'
import type { SortDirection } from '../shared/table-sort'
import { parseUpdateText, scopeIsEverything, type UpdateScope, type UpdateSpec } from '../shared/update-spec'
import { DEFAULT_PAGE_SIZE, DOC_VIEW_KEYS, PAGE_SIZES, RESULT_VIEW_KEYS, startValue, type DocView, type PageSize, type ResultView } from '../shared/settings'
import { followJob, type JobBox } from './data-state'
import { settings, startRelaxed } from './settings-state'
import { errorText, nodeIndex, view } from './state'

export type { DocView, ResultView }
export type QueryField = keyof QueryText
export type Path = (string | number)[]

export type FieldEditor = {
  kind: 'field'
  id: JsonValue
  path: Path
  /** The value as saved, to tell whether the draft changed it. */
  original: JsonValue | undefined
  draft: FieldDraft
  error?: string
  saving?: boolean
  /** The field is new (Add field): its name is typed in. */
  adding?: boolean
  newName?: string
}
export type DocEditor = {
  kind: 'doc'
  mode: 'edit' | 'insert' | 'clone'
  id?: JsonValue
  syntax: 'shell' | 'ejson'
  text: string
  error?: string
  saving?: boolean
}
export type Editor = FieldEditor | DocEditor
/** Where a tab shows a notice: next to what it is about. `top` is under the tab's Run toolbar,
 *  for the query or pipeline and the tab itself; `results` under the results and their actions
 *  (saving, deleting, copying documents); the others inside their own section. */
export type NoticeAt = 'top' | 'builder' | 'results' | 'library' | 'view'
export type TabNotice = { tone: 'success' | 'danger' | 'neutral'; text: string; at?: NoticeAt }

/** One document, read whole from the server, shown on its own: over a tab's results (opened
 *  from them, closed with Back), or as a document tab's whole content. */
export type DocFocus = {
  id: JsonValue
  doc?: JsonObject
  loading: boolean
  error?: string
  /** It was deleted from here: there is nothing left to show. */
  deleted?: boolean
  view: DocView
  relaxed: boolean
  /** Long strings shown whole in the JSON and Shell views, instead of shortened. */
  fullValues?: boolean
  expanded: string[]
  selected?: string
}

/** A tab's explain plan: the section under the query or pipeline. */
export type ExplainState = {
  open: boolean
  verbosity: ExplainVerbosity
  loading: boolean
  result?: ExplainResult
  error?: string
  mode: 'visual' | 'raw'
  expanded: string[]
  selected?: string
  /** Bumped by each explain, so a slow answer to an older one is dropped. */
  token: number
}

export type AggPreview = {
  stageId: string
  loading: boolean
  result?: PreviewResult
  error?: string
  note?: string
  token: number
}

/** An aggregation tab: the pipeline being built, and what its last run used. */
export type AggState = {
  stages: StageDraft[]
  selected?: string
  /** Parse errors by stage id. */
  errors: Record<string, string>
  previewSize: number
  previewSide: 'input' | 'output'
  preview?: AggPreview
  allowDiskUse: boolean
  textMode: boolean
  text: string
  textError?: string
  /** The pipeline as last run: paging and counting use it, not what is typed now. */
  ran?: { pipeline: JsonObject[]; options: AggOptions }
  /** A pipeline that writes, asked first: the target and the documents it holds now. */
  confirmWrite?: { stage: string; target: string; count?: number | null; exists?: boolean }
  viewName: string
  viewOpen: boolean
  /** A view made from this pipeline, offered to open. */
  created?: string
  saved?: SavedPipeline[]
  saveName: string
  savedSelected?: string
}

/** Which documents Update many changes: the selected rows, every match of the query as last run
 *  (not only the page shown), or the whole collection. */
export type BulkScope = 'selection' | 'query' | 'all'
/** Update many: the scope and the update as typed, then a preview of exactly what would run. */
export type BulkUpdate = {
  scope: BulkScope
  text: string
  /** The time `new Date()` and `ISODate()` in the text stand for: fixed when the text changes,
   *  so that the update previewed and the update run are the same. */
  now: number
  /** Made for `basis` (the scope and update it resolved to); stale once they differ. */
  preview?: { basis: string; scope: UpdateScope; update: UpdateSpec; loading: boolean; result?: UpdatePreview; error?: string }
  /** The collection's name, typed to confirm an update of every document. */
  confirmName: string
  running: boolean
  /** The update running as a worker job. */
  job?: JobBox
  error?: string
}

export type CollTab = {
  id: string
  ns: Namespace
  kind: NodeKind
  title: string
  readOnly: boolean
  text: QueryText
  fieldErrors: Partial<Record<QueryField, string>>
  /** Fields shown as several lines after Format; a field whose text has a line break is too. */
  multiline: Partial<Record<QueryField, boolean>>
  pageSize: number
  /** The query as last run: paging and counting use it, not what is typed now. */
  spec?: QuerySpec
  queryId?: string
  page?: QueryPage
  loading: boolean
  error?: string
  count?: CountResult | 'counting'
  /** Bumped by each run, so a slow answer to an older run is dropped. */
  runToken: number
  resultView: ResultView
  relaxed: boolean
  selectedRows: string[]
  treeExpanded: string[]
  treeSelected?: string
  /** Sub-documents shown as dotted columns in the table. */
  flattened: string[]
  /** A table header clicked: the rows on screen shown in that column's order, sorted here
   *  without a request. The query's own sort is untouched; running the query again clears it. */
  headerSort?: { column: string; direction: SortDirection }
  /** Table columns (dotted names) chosen to filter by the selected rows' values. */
  filterColumns: string[]
  editor?: Editor
  confirmDelete?: { ids: JsonValue[] }
  bulk?: BulkUpdate
  builder: Group
  builderProblems: BuilderProblem[]
  builderOpen: boolean
  optionsOpen: boolean
  library?: QueryLibrary
  saveName: string
  librarySelected?: string
  notice?: TabNotice
  /** Long strings shown whole in the JSON results, instead of shortened. */
  fullValues?: boolean
  /** Results of a shell run, paged from the worker instead of a query. */
  shell?: { runId: string; index: number }
  /** An aggregation tab: results come from its pipeline. */
  agg?: AggState
  explain?: ExplainState
  /** A document opened on its own. In a collection tab it covers the results until Back. */
  focus?: DocFocus
  /** A document tab: it shows only `focus`, for this `_id`, and has no query. */
  docTab?: { id: JsonValue }
}

export const collTabs = atom<Record<string, CollTab>>({})
export const tabOrder = atom<string[]>([])
export const defaultPageSize = atom<number>('mongo-studio.pageSize', DEFAULT_PAGE_SIZE, { persist: 'plugin' })
/** The results view and document view chosen last. Newly opened tabs and documents start in
 *  them; tabs brought back from the saved layout keep their own. They live in the plugin's
 *  storage rather than the `plugin` scope so that panels open in other windows follow along. */
export const lastResultView = atom<ResultView>('mongo-studio.resultView', 'table', { persist: 'storage' })
export const lastDocView = atom<DocView>('mongo-studio.docView', 'tree', { persist: 'storage' })

/** Every view and its toolbar label. A `Record` so that a new view can't be left out. */
export const RESULT_VIEWS: Record<ResultView, string> = { table: 'Table', tree: 'Tree', json: 'JSON' }
export const DOC_VIEWS: Record<DocView, string> = { tree: 'Tree', json: 'JSON', shell: 'Shell' }

/** The views new tabs and documents start in: the ones chosen in Settings, or the remembered
 *  ones, falling back to the defaults if storage holds something unknown (`storage` values are
 *  kept as written, with no `migrate` step). */
export function startResultView(): ResultView {
  return startValue(settings().resultView, read(lastResultView), RESULT_VIEW_KEYS, 'table')
}

export function startDocView(): DocView {
  return startValue(settings().docView, read(lastDocView), DOC_VIEW_KEYS, 'tree')
}

/** Documents per page in a new tab: the size chosen in Settings, or the one used last. */
export function startPageSize(): PageSize {
  return startValue(settings().pageSize, read(defaultPageSize), PAGE_SIZES, DEFAULT_PAGE_SIZE)
}

const emptyText: QueryText = { filter: '', projection: '', sort: '', collation: '', skip: '', limit: '' }

export function tab(id: string): CollTab | undefined {
  return read(collTabs)[id]
}

export function change(id: string, fn: (t: CollTab) => CollTab | Partial<CollTab>): void {
  update(collTabs, (prev) => {
    const t = prev[id]
    if (!t) return prev
    const next = fn(t)
    const out = 'id' in next && next.id === t.id ? (next as CollTab) : { ...t, ...next }
    return { ...prev, [id]: withBoxes(t, out) }
  })
}

/** A field's text replaced from elsewhere (history, a saved query, the Query Builder, a sorted
 *  column, Filter by) gets the box its new text needs, unless the change chose the box itself. */
function withBoxes(before: CollTab, after: CollTab): CollTab {
  if (after.text === before.text || after.multiline !== before.multiline) return after
  let multiline: CollTab['multiline'] | undefined
  for (const field of Object.keys(after.text) as QueryField[]) {
    if (after.text[field] === before.text[field] || after.multiline[field] === undefined) continue
    multiline ??= { ...after.multiline }
    delete multiline[field]
  }
  return multiline ? { ...after, multiline } : after
}

function patch(id: string, values: Partial<CollTab>): void {
  change(id, () => values)
}

export function nsLabel(ns: Namespace): string {
  return `${ns.db}.${ns.collection}`
}

/** A tab id from the namespace (FNV-1a), so reopening a collection finds its tab. Plain letters
 *  and digits: Orca keys and tab values stay simple. */
export function tabIdFor(ns: Namespace): string {
  return `coll-${hash([ns.connectionId, ns.db, ns.collection])}`
}

function hash(parts: string[]): string {
  let h = 0x811c9dc5
  for (const ch of JSON.stringify(parts)) {
    h ^= ch.codePointAt(0)!
    h = Math.imul(h, 0x01000193) >>> 0
  }
  return h.toString(36)
}

/** A document tab's id: one tab per document, found again when the same document is opened. */
export function docTabIdFor(ns: Namespace, docId: JsonValue): string {
  return `doc-${hash([ns.connectionId, ns.db, ns.collection, idKey(docId)])}`
}

/** Opens (or shows) the tab for a collection, view or time-series node of the tree. */
export async function openCollection(nodeKey: string): Promise<void> {
  const target = nodeTarget(nodeKey)
  if (!target.connectionId || !target.db || !target.collection) return
  const ns: Namespace = { connectionId: target.connectionId, db: target.db, collection: target.collection }
  const meta = read(nodeIndex)[nodeKey]
  await openNamespace(ns, meta?.kind ?? target.kind)
}

/** Opens (or shows) a collection's tab; with `text`, puts that query in its bar and runs it. */
export async function openNamespace(ns: Namespace, kind: NodeKind, text?: QueryText): Promise<void> {
  const existing = read(tabOrder).find((id) => {
    const t = tab(id)
    return t && !t.docTab && !t.agg && t.ns.connectionId === ns.connectionId && t.ns.db === ns.db && t.ns.collection === ns.collection
  })
  if (existing) {
    set(view, existing)
    if (text) {
      patch(existing, { text, fieldErrors: {} })
      await runQuery(existing)
    }
    return
  }
  const id = tabIdFor(ns)
  const t: CollTab = { ...newTab(id, ns, kind, ns.collection), resultView: startResultView() }
  if (text) t.text = text
  update(collTabs, (prev) => ({ ...prev, [id]: t }))
  update(tabOrder, (prev) => [...prev, id])
  set(view, id)
  await Promise.all([runQuery(id, text !== undefined), loadLibrary(id)])
}

export function newTab(id: string, ns: Namespace, kind: NodeKind, title: string): CollTab {
  return {
    id,
    ns,
    kind,
    title,
    readOnly: kind === 'view',
    text: { ...emptyText },
    fieldErrors: {},
    multiline: {},
    pageSize: startPageSize(),
    loading: false,
    runToken: 0,
    resultView: 'table',
    relaxed: startRelaxed(),
    selectedRows: [],
    treeExpanded: [],
    flattened: [],
    filterColumns: [],
    builder: emptyGroup(),
    builderProblems: [],
    builderOpen: false,
    optionsOpen: false,
    saveName: ''
  }
}

export function closeTab(id: string): void {
  const t = tab(id)
  if (t?.queryId && !t.shell) void plugin.request('query.close', { queryId: t.queryId }).catch(() => undefined)
  const order = read(tabOrder)
  const at = order.indexOf(id)
  const rest = order.filter((x) => x !== id)
  set(tabOrder, rest)
  update(collTabs, (prev) => {
    const next = { ...prev }
    delete next[id]
    return next
  })
  if (read(view) === id) set(view, rest[Math.min(at, rest.length - 1)] ?? 'tree')
}

/** Closes the tabs of a deleted connection. */
export function closeTabsFor(connectionId: string): void {
  for (const id of read(tabOrder)) if (tab(id)?.ns.connectionId === connectionId) closeTab(id)
}

// ---- One document on its own ----

/** Whether a tab's documents can be opened on their own: they must come from the collection
 *  itself, so that reading one by `_id` finds the same document. */
export function canOpenDocuments(t: CollTab): boolean {
  return !t.shell && !t.agg
}

export function newFocus(docId: JsonValue, view: DocView = 'tree'): DocFocus {
  return { id: docId, loading: true, view, relaxed: startRelaxed(), expanded: [treeKey(0, [])] }
}

/** Reads the open document again, whole, from the server. */
export async function loadFocus(id: string): Promise<void> {
  const t = tab(id)
  const f = t?.focus
  if (!t || !f) return
  change(id, (x) => (x.focus ? { focus: { ...x.focus, loading: true, error: undefined } } : {}))
  let next: Partial<DocFocus>
  try {
    const { doc } = await plugin.request('doc.get', { ns: t.ns, id: f.id }, { timeoutMs: 60000 })
    next = doc ? { doc, loading: false } : { doc: undefined, loading: false, error: 'This document is no longer there: it was deleted, or its _id changed.' }
  } catch (error) {
    next = { loading: false, error: errorText(error) }
  }
  change(id, (x) => (x.focus && idKey(x.focus.id) === idKey(f.id) ? { focus: { ...x.focus, ...next } } : {}))
}

/** Opens a document over the tab's results, like a dialog: Back returns to them as they were. */
export async function openDocument(id: string, docId: JsonValue): Promise<void> {
  patch(id, { focus: newFocus(docId, startDocView()), editor: undefined, confirmDelete: undefined })
  await loadFocus(id)
}

/** Closes the document opened over the results. */
export function closeDocument(id: string): void {
  patch(id, { focus: undefined, editor: undefined, confirmDelete: undefined })
}

/** Opens a document in a tab of its own, next to the tab it came from, or shows its tab. */
export async function openDocumentTab(fromId: string, docId: JsonValue): Promise<void> {
  const from = tab(fromId)
  if (!from) return
  const id = docTabIdFor(from.ns, docId)
  if (tab(id)) {
    set(view, id)
    await loadFocus(id)
    return
  }
  const t: CollTab = { ...newTab(id, from.ns, from.kind, `${from.ns.collection} · ${toShellInline(docId).slice(0, 24)}`), readOnly: from.readOnly, docTab: { id: docId }, focus: newFocus(docId, from.focus?.view ?? startDocView()) }
  update(collTabs, (prev) => ({ ...prev, [id]: t }))
  update(tabOrder, (prev) => {
    const at = prev.indexOf(fromId)
    return at < 0 ? [...prev, id] : [...prev.slice(0, at + 1), id, ...prev.slice(at + 1)]
  })
  set(view, id)
  await loadFocus(id)
}

export function setFocus(id: string, values: Partial<DocFocus>): void {
  change(id, (t) => (t.focus ? { focus: { ...t.focus, ...values } } : {}))
}

/** Asks before deleting the open document. */
export function askDeleteFocused(id: string): Promise<void> {
  const f = tab(id)?.focus
  return f ? askDeleteIds(id, [f.id]) : Promise.resolve()
}

export function setText(id: string, field: QueryField, value: string): void {
  change(id, (t) => ({
    text: { ...t.text, [field]: value },
    // Typing keeps the box it is typed in: joining the last two lines doesn't swap a multi-line
    // box for a one-line one under the cursor.
    multiline: { ...t.multiline, [field]: isMultiline(t, field) || value.includes('\n') },
    fieldErrors: withLiveProblem(t.fieldErrors, field, value)
  }))
}

/** A field's text written by Mongo Studio (a sorted column, Filter by, the Query Builder): the box
 *  follows the new text, multi-line only when it has a line break. */
function replaceText(id: string, field: QueryField, value: string): void {
  change(id, (t) => {
    const multiline = { ...t.multiline }
    delete multiline[field]
    return { text: { ...t.text, [field]: value }, multiline, fieldErrors: withLiveProblem(t.fieldErrors, field, value) }
  })
}

/** The error to show while a field is typed: what running it would say, unless the text only
 *  stopped early (a bracket, string or comment not closed yet, a name or number still being
 *  typed at the end), which waits for Run. */
export function liveProblem(field: QueryField, value: string, now = Date.now()): string | undefined {
  if (field === 'skip' || field === 'limit') return countProblem(field, value)
  const problem = shellProblem(value, FIELD_NAMES[field], { now })
  return problem && !problem.unfinished ? problem.message : undefined
}

function withLiveProblem(errors: CollTab['fieldErrors'], field: QueryField, value: string): CollTab['fieldErrors'] {
  const out = { ...errors }
  // With checking while typing turned off, an error waits for Run, and typing clears it.
  const problem = settings().liveCheck ? liveProblem(field, value) : undefined
  if (problem) out[field] = problem
  else delete out[field]
  return out
}

/** A multi-line box after Format or while typed in one; otherwise one when the text has a line
 *  break (a formatted query from history, a restored tab). */
export function isMultiline(t: CollTab, field: QueryField): boolean {
  return t.multiline[field] ?? t.text[field].includes('\n')
}

/** Pretty-prints a field onto several lines and keeps it as a multi-line box. */
export function formatField(id: string, field: QueryField): void {
  change(id, (t) => {
    const result = formatQuery(t.text[field])
    const multiline = { ...t.multiline, [field]: true }
    // Not closed yet: the box still gets the room to finish it.
    if (!result.ok) return { multiline, fieldErrors: { ...t.fieldErrors, [field]: `Can't format: ${result.problem}` } }
    if (result.text.length > QUERY_TEXT_MAX) {
      const size = (n: number): string => n.toLocaleString('en-US')
      return { fieldErrors: { ...t.fieldErrors, [field]: `Formatted, this would be ${size(result.text.length)} characters, and the query history keeps up to ${size(QUERY_TEXT_MAX)}. Left as it is.` } }
    }
    return { text: { ...t.text, [field]: result.text }, multiline, fieldErrors: withLiveProblem(t.fieldErrors, field, result.text) }
  })
}

/** Puts a field back on one line, as a single-line box. */
export function compactField(id: string, field: QueryField): void {
  change(id, (t) => {
    const result = compactQuery(t.text[field])
    if (!result.ok) return { fieldErrors: { ...t.fieldErrors, [field]: `Can't put on one line: ${result.problem}` } }
    return { text: { ...t.text, [field]: result.text }, multiline: { ...t.multiline, [field]: false }, fieldErrors: withLiveProblem(t.fieldErrors, field, result.text) }
  })
}

function countProblem(field: 'skip' | 'limit', value: string): string | undefined {
  const v = value.trim()
  return v === '' || /^\d+$/.test(v) ? undefined : `${field === 'skip' ? 'Skip' : 'Limit'} is a whole number, 0 or more.`
}

const FIELD_NAMES: Record<QueryField, string> = { filter: 'filter', projection: 'projection', sort: 'sort', collation: 'collation', skip: 'skip', limit: 'limit' }

/** The query bar as a spec, or an error per field that doesn't parse. */
export function specFromText(text: QueryText, now = Date.now()): { spec?: QuerySpec; errors: Partial<Record<QueryField, string>> } {
  const errors: Partial<Record<QueryField, string>> = {}
  const doc = (field: 'filter' | 'projection' | 'sort' | 'collation'): JsonObject | undefined => {
    try {
      return parseShellDocument(text[field], FIELD_NAMES[field], { now })
    } catch (error) {
      errors[field] = error instanceof ShellParseError ? error.message : errorText(error)
      return undefined
    }
  }
  const num = (field: 'skip' | 'limit'): number => {
    const problem = countProblem(field, text[field])
    if (problem) errors[field] = problem
    return problem ? 0 : Number(text[field].trim() || 0)
  }
  const filter = doc('filter')
  const projection = doc('projection')
  const sort = doc('sort')
  const collation = doc('collation')
  const skip = num('skip')
  const limit = num('limit')
  if (Object.keys(errors).length || !filter) return { errors }
  const spec: QuerySpec = { filter, skip, limit }
  if (projection && Object.keys(projection).length) spec.projection = projection
  if (sort && Object.keys(sort).length) spec.sort = sort
  if (collation && Object.keys(collation).length) spec.collation = collation
  return { spec, errors }
}

/** Runs what the query bar holds. `record` adds it to the history (not for the first open). */
export async function runQuery(id: string, record = true): Promise<void> {
  const t = tab(id)
  if (!t || t.agg) return
  if (t.shell) return goToPage(id, 0)
  const { spec, errors } = specFromText(t.text)
  if (!spec) {
    patch(id, { fieldErrors: errors })
    return
  }
  if (t.queryId) void plugin.request('query.close', { queryId: t.queryId }).catch(() => undefined)
  const token = t.runToken + 1
  patch(id, { ...dropBulkPreview(t), loading: true, error: undefined, fieldErrors: {}, runToken: token, spec, count: 'counting', headerSort: undefined, selectedRows: [], editor: undefined, confirmDelete: undefined, treeSelected: undefined, treeExpanded: [], notice: undefined })
  const input = { ns: t.ns, spec, pageSize: t.pageSize, ...(record ? { text: t.text } : {}) }
  const counting = countQuery(id, token, spec)
  try {
    const page = await plugin.request('query.run', input, { timeoutMs: 120000 })
    if (tab(id)?.runToken !== token) {
      void plugin.request('query.close', { queryId: page.queryId }).catch(() => undefined)
      return
    }
    patch(id, { page, queryId: page.queryId, loading: false })
  } catch (error) {
    if (tab(id)?.runToken === token) patch(id, { loading: false, error: errorText(error), page: undefined, queryId: undefined })
  }
  await counting
  if (record) await loadLibrary(id)
}

async function countQuery(id: string, token: number, spec: QuerySpec | undefined): Promise<void> {
  const t = tab(id)
  if (!t) return
  const ran = t.agg?.ran
  try {
    const count = ran
      ? await plugin.request('agg.count', { ns: t.ns, pipeline: ran.pipeline, options: ran.options }, { timeoutMs: 60000 })
      : await plugin.request('query.count', { ns: t.ns, spec: spec! }, { timeoutMs: 60000 })
    if (tab(id)?.runToken === token) patch(id, { count })
  } catch (error) {
    if (tab(id)?.runToken === token) patch(id, { count: { count: null, approximate: false, ms: 0, error: errorText(error) } })
  }
}

export async function recount(id: string): Promise<void> {
  const t = tab(id)
  if (!t || t.shell || !(t.agg ? t.agg.ran && !hasWriteStage(t.agg.ran.pipeline) : t.spec)) return
  patch(id, { count: 'counting' })
  await countQuery(id, t.runToken, t.spec)
}

export async function goToPage(id: string, offset: number): Promise<void> {
  const t = tab(id)
  if (!t) return
  const ran = t.agg?.ran
  if (!(t.shell || (ran ? t.queryId : t.spec && t.queryId))) return
  if (ran && hasWriteStage(ran.pipeline)) {
    say(id, 'neutral', 'This pipeline writes to a collection, so it is not run again for a page. Run it to repeat the write.', 'results')
    return
  }
  const token = t.runToken
  patch(id, { ...dropBulkPreview(t), loading: true, error: undefined, selectedRows: [], editor: undefined, confirmDelete: undefined, treeSelected: undefined, treeExpanded: [] })
  try {
    const page = t.shell
      ? await plugin.request('shell.page', { runId: t.shell.runId, index: t.shell.index, offset: Math.max(0, offset), pageSize: t.pageSize }, { timeoutMs: 120000 })
      : ran
      ? await plugin.request('agg.page', { queryId: t.queryId!, ns: t.ns, pipeline: ran.pipeline, options: ran.options, offset: Math.max(0, offset), pageSize: t.pageSize }, { timeoutMs: 120000 })
      : await plugin.request('query.page', { queryId: t.queryId!, ns: t.ns, spec: t.spec!, offset: Math.max(0, offset), pageSize: t.pageSize }, { timeoutMs: 120000 })
    if (tab(id)?.runToken === token) patch(id, { page, loading: false })
  } catch (error) {
    if (tab(id)?.runToken === token) patch(id, { loading: false, error: errorText(error) })
  }
}

export function nextPage(id: string): Promise<void> {
  const p = tab(id)?.page
  return p ? goToPage(id, p.offset + p.docs.length) : Promise.resolve()
}

export function previousPage(id: string): Promise<void> {
  const t = tab(id)
  return t?.page ? goToPage(id, t.page.offset - t.pageSize) : Promise.resolve()
}

/** Shows a tab's results as `v`, with `extra` changes (such as the row to select). The choice
 *  is remembered for the next tab only from a collection's own tab: Shell and pipeline results
 *  are read-only, and a view picked to read them would leave new collection tabs without the
 *  Table's row actions. */
export function setResultView(id: string, v: ResultView, extra: Partial<CollTab> = {}): void {
  const t = tab(id)
  if (t && canOpenDocuments(t) && read(lastResultView) !== v) set(lastResultView, v)
  patch(id, { ...extra, resultView: v })
}

/** Shows the open document as `v`, and remembers it for the next document opened. */
export function setDocView(id: string, v: DocView): void {
  if (read(lastDocView) !== v) set(lastDocView, v)
  setFocus(id, { view: v })
}

export async function setPageSize(id: string, size: number): Promise<void> {
  set(defaultPageSize, size)
  patch(id, { pageSize: size })
  const t = tab(id)
  if (t?.page) await goToPage(id, t.page.offset)
}

/** Reloads what is on screen after an edit: the page, and the document open on its own. */
export async function reloadPage(id: string): Promise<void> {
  const t = tab(id)
  if (!t) return
  if (t.docTab) return loadFocus(id)
  if (t.focus) void loadFocus(id)
  if (!t.page) return runQuery(id, false)
  const keepNotice = t.notice
  await goToPage(id, t.page.offset)
  patch(id, { notice: keepNotice })
  void recount(id)
}

/** Header click: show the rows on screen in that column's order. Only the panel sorts them;
 *  the query bar and the server's results stay as they were. */
export function sortBy(id: string, column: string, direction: SortDirection): void {
  patch(id, { headerSort: { column, direction } })
}

export function resetQuery(id: string): Promise<void> {
  patch(id, { text: { ...emptyText }, fieldErrors: {}, multiline: {} })
  return runQuery(id)
}

// ---- Rows, selection and documents ----

/** Orca refuses a whole Table when a row key passes 1,024 characters or two rows share one. */
const ROW_KEY_MAX = 1000

/** Table row keys for a page: each document's `_id`, or its place on the page (`#3`) when it has
 *  none, when the `_id` is too long for a key, or when it repeats (as `$unwind` makes it). An `_id`
 *  key is JSON, so a string `_id` is quoted and never looks like a place. */
export function rowKeys(docs: readonly JsonObject[]): string[] {
  const seen = new Set<string>()
  return docs.map((d, i) => {
    const id = '_id' in d ? idKey(d._id!) : ''
    const key = id && id.length <= ROW_KEY_MAX && !seen.has(id) ? id : `#${i}`
    seen.add(key)
    return key
  })
}

export function selectedDocs(t: CollTab): JsonObject[] {
  const selected = new Set(t.selectedRows)
  const docs = t.page?.docs ?? []
  const keys = rowKeys(docs)
  return docs.filter((_, i) => selected.has(keys[i]!))
}

/** Fields sampled from the documents on screen, for the builder and the field picker. */
export function sampledFields(t: CollTab): string[] {
  const out = new Set<string>()
  for (const d of t.page?.docs ?? []) fieldPaths(d, '', out)
  return [...out].sort((a, b) => (a === '_id' ? -1 : b === '_id' ? 1 : a.localeCompare(b)))
}

export function say(id: string, tone: TabNotice['tone'], text: string, at: NoticeAt = 'top'): void {
  patch(id, { notice: { tone, text, at } })
}

/** Whether a document the page shortened can be read again whole for a copy: only from a
 *  collection (in a view or a time-series collection `_id` need not be unique), by a query with no
 *  projection (a re-read would add fields the person projected away and drop computed ones), and
 *  with an `_id` that was not shortened itself. */
function canReread(t: CollTab, doc: JsonObject): boolean {
  if (t.shell || t.agg || t.kind !== 'coll') return false
  if (t.spec?.projection && Object.keys(t.spec.projection).length) return false
  return '_id' in doc && !hasTruncated(doc._id)
}

/** Copies documents to the system clipboard as Extended JSON, relaxed or canonical as the tab
 *  shows it (or as `relaxed` says, for an open document): one document as an object, several as
 *  an array. What is copied is what the page
 *  shows; a document whose values the page shortened is read again whole when it can be. The
 *  worker writes the text, so the page goes to it compact rather than indented. */
export async function copyAsJson(id: string, docs: readonly JsonObject[], relaxed?: boolean): Promise<void> {
  const t = tab(id)
  if (!t || docs.length === 0) return
  const page = t.page
  const cut = (d: JsonObject): boolean => (page ? page.truncated.includes(page.docs.indexOf(d)) : false)
  const items: CopyItem[] = docs.map((doc) => (cut(doc) && canReread(t, doc) ? { doc, reread: true } : { doc }))
  const r = await plugin.request('clipboard.copyDocuments', { ns: t.ns, items, relaxed: relaxed ?? t.relaxed }, { timeoutMs: 60000 })
  const shortened = items.filter((item) => !item.reread && cut(item.doc)).length + r.gone
  const n = r.copied
  const what = `${n.toLocaleString('en-US')} document${n === 1 ? '' : 's'}`
  const note = shortened
    ? ` ${shortened === n ? (n === 1 ? 'It has' : 'They have') : `${shortened.toLocaleString('en-US')} of them have`} long values shortened, as on this page.`
    : ''
  say(id, 'success', `Copied ${what} as JSON.${note}`, 'results')
}

async function fullDocument(t: CollTab, docId: JsonValue): Promise<JsonObject> {
  const { doc } = await plugin.request('doc.get', { ns: t.ns, id: docId }, { timeoutMs: 60000 })
  if (!doc) throw new Error('That document is no longer there: it was deleted, or its _id changed. Run the query again.')
  return doc
}

/** Opens the field editor on a field of a document, with the whole document fetched first. */
export async function editField(id: string, docId: JsonValue, path: Path): Promise<void> {
  const t = tab(id)
  if (!t) return
  try {
    const doc = await fullDocument(t, docId)
    const value = valueAt(doc, path)
    if (value === undefined) throw new Error('That field is not in the document any more. Run the query again.')
    patch(id, { editor: { kind: 'field', id: docId, path, original: value, draft: draftFromValue(value) }, confirmDelete: undefined })
  } catch (error) {
    say(id, 'danger', errorText(error), 'results')
  }
}

/** A new top-level field, typed in by name. */
export function addField(id: string, docId: JsonValue): void {
  patch(id, { editor: { kind: 'field', id: docId, path: [], original: undefined, draft: draftFromValue(''), adding: true, newName: '' }, confirmDelete: undefined })
}

export function setDraft(id: string, draft: FieldDraft): void {
  change(id, (t) => (t.editor?.kind === 'field' ? { editor: { ...t.editor, draft, error: undefined } } : {}))
}

export function setNewFieldName(id: string, name: string): void {
  change(id, (t) => (t.editor?.kind === 'field' ? { editor: { ...t.editor, newName: name, error: undefined } } : {}))
}

export function closeEditor(id: string): void {
  patch(id, { editor: undefined })
}

function editorError(id: string, error: string): void {
  change(id, (t) => (t.editor ? { editor: { ...t.editor, error, saving: false } } : {}))
}

/** Splits a typed field name into a path: `a.b` is nested, as $set reads it. */
function typedPath(name: string): Path | string {
  const n = name.trim()
  if (!n) return 'Name the field.'
  if (n.startsWith('$')) return 'A field name cannot start with $.'
  if (n.split('.').some((s) => s === '')) return 'A field name cannot have an empty part between dots.'
  if (n === '_id' || n.startsWith('_id.')) return "A document's _id can't change. Clone the document to give the copy a new _id."
  return n.split('.')
}

export async function saveField(id: string): Promise<void> {
  const t = tab(id)
  const e = t?.editor
  if (!t || e?.kind !== 'field') return
  const result = valueFromDraft(e.draft)
  if (!result.ok) return editorError(id, result.error)
  let path = e.path
  if (e.adding) {
    const typed = typedPath(e.newName ?? '')
    if (typeof typed === 'string') return editorError(id, typed)
    path = typed
  }
  change(id, (x) => (x.editor ? { editor: { ...x.editor, saving: true, error: undefined } } : {}))
  try {
    const r = await plugin.request('doc.updateField', { ns: t.ns, id: e.id, path, value: result.value }, { timeoutMs: 60000 })
    patch(id, { editor: undefined })
    say(id, 'success', r.modified ? `Saved ${path.join('.')}.` : `${path.join('.')} already had that value.`, 'results')
    await reloadPage(id)
  } catch (error) {
    editorError(id, errorText(error))
  }
}

export async function removeField(id: string): Promise<void> {
  const t = tab(id)
  const e = t?.editor
  if (!t || e?.kind !== 'field' || e.adding) return
  change(id, (x) => (x.editor ? { editor: { ...x.editor, saving: true, error: undefined } } : {}))
  try {
    await plugin.request('doc.updateField', { ns: t.ns, id: e.id, path: e.path, remove: true }, { timeoutMs: 60000 })
    patch(id, { editor: undefined })
    say(id, 'success', `Removed ${e.path.join('.')}.`, 'results')
    await reloadPage(id)
  } catch (error) {
    editorError(id, errorText(error))
  }
}

function docText(doc: JsonValue, syntax: 'shell' | 'ejson'): string {
  return syntax === 'shell' ? toShell(doc) : toJsonText(doc, false)
}

export async function editDocument(id: string, docId: JsonValue): Promise<void> {
  const t = tab(id)
  if (!t) return
  try {
    const doc = await fullDocument(t, docId)
    patch(id, { editor: { kind: 'doc', mode: 'edit', id: docId, syntax: 'shell', text: docText(doc, 'shell') }, confirmDelete: undefined })
  } catch (error) {
    say(id, 'danger', errorText(error), 'results')
  }
}

export async function cloneDocument(id: string, docId: JsonValue): Promise<void> {
  const t = tab(id)
  if (!t) return
  try {
    const { _id: _drop, ...copy } = await fullDocument(t, docId)
    void _drop
    patch(id, { editor: { kind: 'doc', mode: 'clone', syntax: 'shell', text: docText(copy, 'shell') }, confirmDelete: undefined })
  } catch (error) {
    say(id, 'danger', errorText(error), 'results')
  }
}

export function insertDocument(id: string): void {
  patch(id, { editor: { kind: 'doc', mode: 'insert', syntax: 'shell', text: '{\n  \n}' }, confirmDelete: undefined })
}

export function setDocText(id: string, text: string): void {
  change(id, (t) => (t.editor?.kind === 'doc' ? { editor: { ...t.editor, text, error: undefined } } : {}))
}

/** Shell ↔ Extended JSON: the text is converted when it parses, otherwise it says why not. */
export function setDocSyntax(id: string, syntax: 'shell' | 'ejson'): void {
  change(id, (t) => {
    const e = t.editor
    if (e?.kind !== 'doc' || e.syntax === syntax) return {}
    try {
      return { editor: { ...e, syntax, text: docText(parseShell(e.text), syntax), error: undefined } }
    } catch (error) {
      return { editor: { ...e, error: `Fix the document before switching: ${errorText(error)}` } }
    }
  })
}

/** The document text as a document, or why it can't be saved. */
export function parseDocText(text: string): { doc?: JsonObject; error?: string } {
  try {
    const doc = parseShell(text, { now: Date.now() })
    if (bsonType(doc) !== 'object') return { error: 'A document is written in { }.' }
    if (!fitsHost({ doc })) {
      return { error: 'This document is too big to send from here: Orca lets a panel send at most 1 MiB and 10,000 values at once. Use the shell for it.' }
    }
    return { doc: doc as JsonObject }
  } catch (error) {
    return { error: errorText(error) }
  }
}

export async function saveDocument(id: string): Promise<void> {
  const t = tab(id)
  const e = t?.editor
  if (!t || e?.kind !== 'doc') return
  const { doc, error } = parseDocText(e.text)
  if (!doc) return editorError(id, error!)
  change(id, (x) => (x.editor ? { editor: { ...x.editor, saving: true, error: undefined } } : {}))
  try {
    if (e.mode === 'edit') {
      const r = await plugin.request('doc.replace', { ns: t.ns, id: e.id!, doc }, { timeoutMs: 60000 })
      say(id, 'success', r.modified ? 'Document saved.' : 'Nothing changed.', 'results')
    } else {
      const r = await plugin.request('doc.insert', { ns: t.ns, docs: [doc] }, { timeoutMs: 60000 })
      say(id, 'success', `Inserted a document with _id ${toShellInline(r.insertedIds[0] ?? null)}.`, 'results')
    }
    patch(id, { editor: undefined })
    await reloadPage(id)
  } catch (error) {
    editorError(id, errorText(error))
  }
}

/** Asks before deleting the selected documents, or deletes them at once when Settings says not
 *  to ask. */
export function askDelete(id: string): Promise<void> {
  const t = tab(id)
  if (!t) return Promise.resolve()
  const docs = selectedDocs(t).filter((d) => '_id' in d)
  return docs.length ? askDeleteIds(id, docs.map((d) => d._id!)) : Promise.resolve()
}

/** Asks first, or deletes at once when Settings says not to ask: then no confirmation shows, so
 *  nothing on screen can cancel or repeat it while it runs. */
function askDeleteIds(id: string, ids: JsonValue[]): Promise<void> {
  if (!settings().confirmDeleteDocs) {
    patch(id, { editor: undefined })
    return deleteDocuments(id, ids)
  }
  patch(id, { confirmDelete: { ids }, editor: undefined })
  return Promise.resolve()
}

export function confirmDeletion(id: string): Promise<void> {
  const ids = tab(id)?.confirmDelete?.ids
  return ids ? deleteDocuments(id, ids) : Promise.resolve()
}

/** Tabs with a deletion running: pressing Delete again meanwhile does nothing. */
const deleting = new Set<string>()

async function deleteDocuments(id: string, ids: JsonValue[]): Promise<void> {
  const t = tab(id)
  if (!t || deleting.has(id)) return
  deleting.add(id)
  try {
    const r = await plugin.request('doc.deleteMany', { ns: t.ns, ids }, { timeoutMs: 120000 })
    patch(id, { confirmDelete: undefined, selectedRows: [] })
    say(id, 'success', `Deleted ${r.deleted.toLocaleString('en-US')} document${r.deleted === 1 ? '' : 's'} from ${nsLabel(t.ns)}.`, 'results')
    const focused = t.focus && ids.some((x) => idKey(x) === idKey(t.focus!.id))
    if (focused && t.docTab) return setFocus(id, { deleted: true, doc: undefined, error: undefined })
    if (focused) patch(id, { focus: undefined })
    await reloadPage(id)
  } catch (error) {
    patch(id, { confirmDelete: undefined })
    say(id, 'danger', errorText(error), 'results')
  } finally {
    deleting.delete(id)
  }
}

// ---- Update many ----

/** Whether a tab can update documents in bulk: a collection's own query, not a view, shell
 *  results, an aggregation or one document. */
export function canUpdateMany(t: CollTab): boolean {
  return !t.readOnly && t.kind !== 'view' && !t.shell && !t.agg && !t.docTab
}

/** A page shows long values cut down; such an `_id` would match nothing. */
function usableId(id: JsonValue): boolean {
  return !hasTruncated(id)
}

/** The documents a scope stands for now, or why it can't be used. `skipped`: selected rows
 *  without an `_id`, or with one too long to show, which can't be named. */
export function bulkScope(t: CollTab, kind: BulkScope): { scope?: UpdateScope; error?: string; skipped?: number } {
  if (kind === 'all') return { scope: { kind: 'all' } }
  if (kind === 'query') {
    if (!t.spec) return { error: 'Run the query first: the update reaches what it matched.' }
    return { scope: { kind: 'filter', filter: t.spec.filter, ...(t.spec.collation ? { collation: t.spec.collation } : {}) } }
  }
  const docs = selectedDocs(t)
  const ids = docs.filter((d) => '_id' in d && usableId(d._id!)).map((d) => d._id!)
  if (docs.length === 0) return { error: 'Select rows in the results first.' }
  if (ids.length === 0) return { error: "The selected documents have no _id that can be named (a projection left it out, or it is too long to show)." }
  return { scope: { kind: 'ids', ids }, skipped: docs.length - ids.length }
}

export type BulkPlan = { scope?: UpdateScope; update?: UpdateSpec; basis?: string; scopeError?: string; updateError?: string; skipped?: number }

/** The scope and update the card holds now, and the key a preview of them is made for. Worked
 *  out once per render and passed along: it parses the update and walks the selection. */
export function bulkPlan(t: CollTab): BulkPlan {
  const b = t.bulk
  if (!b) return {}
  const s = bulkScope(t, b.scope)
  const u = parseUpdateText(b.text, b.now)
  const basis = s.scope && u.update ? JSON.stringify([s.scope, u.update]) : undefined
  return { scope: s.scope, update: u.update, basis, scopeError: s.error, updateError: u.error, skipped: s.skipped }
}

/** The preview, when it was made for what the card holds now. */
export function currentPreview(t: CollTab, plan: BulkPlan = bulkPlan(t)): BulkUpdate['preview'] {
  const p = t.bulk?.preview
  return p && p.basis === plan.basis ? p : undefined
}

/** What a tab change that makes a preview stale (a new run, another page, another selection) does
 *  to the card: the preview and its confirmation go, so going back never brings them back. */
export function dropBulkPreview(t: CollTab): Partial<CollTab> {
  return t.bulk && !t.bulk.running && t.bulk.preview ? { bulk: { ...t.bulk, preview: undefined, confirmName: '' } } : {}
}

export function openUpdateMany(id: string, scope?: BulkScope): void {
  const t = tab(id)
  if (!t || !canUpdateMany(t)) return
  // A running update keeps its card until it ends.
  if (t.bulk?.running) return
  const start: BulkScope = scope ?? (selectedDocs(t).some((d) => '_id' in d) ? 'selection' : 'query')
  patch(id, { bulk: { scope: start, text: t.bulk?.text ?? '', now: Date.now(), confirmName: '', running: false }, editor: undefined, confirmDelete: undefined })
}

export function closeUpdateMany(id: string): void {
  if (tab(id)?.bulk?.running) return
  patch(id, { bulk: undefined })
}

/** Changes the scope or the text; what was previewed or confirmed no longer applies. */
export function setBulk(id: string, values: Partial<Pick<BulkUpdate, 'scope' | 'text' | 'confirmName'>>): void {
  change(id, (t) => {
    if (!t.bulk || t.bulk.running) return {}
    const reset = 'scope' in values || 'text' in values ? { preview: undefined, confirmName: '', error: undefined } : {}
    const now = 'text' in values ? { now: Date.now() } : {}
    return { bulk: { ...t.bulk, ...reset, ...now, ...values } }
  })
}

/** Counts what the update reaches and tries it on one document, without saving anything. */
export async function previewUpdateMany(id: string): Promise<void> {
  const t = tab(id)
  if (!t?.bulk || t.bulk.running) return
  const plan = bulkPlan(t)
  if (!plan.scope || !plan.update || !plan.basis) return
  const { scope, update, basis } = plan
  change(id, (x) => (x.bulk ? { bulk: { ...x.bulk, error: undefined, confirmName: '', preview: { basis, scope, update, loading: true } } } : {}))
  let next: Partial<NonNullable<BulkUpdate['preview']>>
  try {
    next = { loading: false, result: await plugin.request('doc.updatePreview', { ns: t.ns, scope, update }, { timeoutMs: 120000 }) }
  } catch (error) {
    next = { loading: false, error: errorText(error) }
  }
  change(id, (x) => (x.bulk?.preview?.basis === basis ? { bulk: { ...x.bulk, preview: { ...x.bulk.preview, ...next } } } : {}))
}

/** Whether the update can run: a preview of what the card holds, where the server didn't refuse
 *  the change on the first document (updateMany would stop partway, after changing others), and
 *  for every document, the collection's name typed exactly, unless Settings turned that off. */
export function bulkConfirmed(t: CollTab, plan: BulkPlan = bulkPlan(t)): boolean {
  const p = currentPreview(t, plan)
  if (!t.bulk || t.bulk.running || !p?.result || p.result.sample?.error) return false
  return !scopeIsEverything(p.scope) || !settings().confirmByName || t.bulk.confirmName === t.ns.collection
}

/** Runs exactly what was previewed, as a worker job, and follows it to its end. */
export async function runUpdateMany(id: string): Promise<void> {
  const t = tab(id)
  const p = t && currentPreview(t)
  if (!t?.bulk || !p?.result || !bulkConfirmed(t)) return
  change(id, (x) => (x.bulk ? { bulk: { ...x.bulk, running: true, error: undefined, job: undefined } } : {}))
  // However it ends short of success, the preview goes: the collection may have changed, and
  // pressing again must not repeat an update that may have run.
  const fail = (error: string): void => change(id, (x) => (x.bulk ? { bulk: { ...x.bulk, running: false, job: undefined, preview: undefined, confirmName: '', error } } : {}))
  let jobId: string
  try {
    jobId = (await plugin.request('doc.updateMany', { ns: t.ns, scope: p.scope, update: p.update }, { timeoutMs: 60000 })).jobId
  } catch (error) {
    return fail(errorText(error))
  }
  change(id, (x) => (x.bulk ? { bulk: { ...x.bulk, job: { jobId } } } : {}))
  const end = await followJob(
    jobId,
    () => tab(id)?.bulk?.job,
    (job) => change(id, (x) => (x.bulk ? { bulk: { ...x.bulk, job } } : {}))
  )
  if (end?.status === 'done' && end.result?.kind === 'update') {
    patch(id, { bulk: undefined, selectedRows: [] })
    say(id, 'success', `Updated ${nsLabel(t.ns)}: ${end.result.matched.toLocaleString('en-US')} matched, ${end.result.modified.toLocaleString('en-US')} modified.`, 'results')
    await reloadPage(id)
    return
  }
  if (end) return fail(end.message ?? `The update ended: ${end.status}.`)
  const lost = tab(id)?.bulk?.job?.error
  fail(`Lost track of the update${lost ? ` (${lost})` : ''}. The server may still be applying it: preview again to see what is left.`)
}

// ---- Tree view keys ----

/** `r3` is the fourth document; `r3/items/#0/sku` a field in it. */
export function treeKey(row: number, path: Path): string {
  return [`r${row}`, ...path.map((s) => (typeof s === 'number' ? `#${s}` : encodeURIComponent(s)))].join('/')
}

export function parseTreeKey(key: string): { row: number; path: Path } {
  const [head, ...rest] = key.split('/')
  return { row: Number(head!.slice(1)), path: rest.map((s) => (s.startsWith('#') ? Number(s.slice(1)) : decodeURIComponent(s))) }
}

// ---- Query Builder ----

export function setBuilder(id: string, builder: Group): void {
  patch(id, { builder, builderProblems: [] })
}

/** "Add to query": a condition on this field and value, in the builder. */
export function addToQuery(id: string, path: Path, value: JsonValue | undefined): void {
  const field = path.filter((p) => typeof p === 'string').join('.')
  const usable = value !== undefined && bsonType(value) !== 'truncated' && bsonType(value) !== 'object' && bsonType(value) !== 'array'
  const cond = newCondition(field, usable ? 'eq' : 'exists', usable ? toShellInline(value) : '')
  change(id, (t) => ({ builder: { ...t.builder, items: [...t.builder.items, cond] }, builderOpen: true, builderProblems: [] }))
  say(id, 'neutral', `Added ${field} to the Query Builder. Apply it to the filter to run it.`, 'builder')
}

/** Whether the table can filter by its selected rows: the tab's own query, which has a filter
 *  to put them in. Document tabs show no table; shell results and pipelines have no filter. */
export function canFilterBySelection(t: CollTab): boolean {
  return canOpenDocuments(t)
}

export function toggleFilterColumn(id: string, name: string): void {
  change(id, (t) => ({ filterColumns: t.filterColumns.includes(name) ? t.filterColumns.filter((c) => c !== name) : [...t.filterColumns, name] }))
}

/** Filter by the selected rows: `filter` (from `filterFromRows`) replaces the filter typed, or
 *  is ANDed onto it as typed, and the query runs from its first match. */
export async function filterBySelection(id: string, filter: JsonObject, mode: 'replace' | 'merge'): Promise<void> {
  const t = tab(id)
  if (!t) return
  let text = toShellInline(filter)
  if (mode === 'merge') {
    let base: JsonObject
    try {
      base = parseShellDocument(t.text.filter, 'filter', { now: Date.now() })
    } catch (error) {
      patch(id, { fieldErrors: { ...t.fieldErrors, filter: errorText(error) } })
      return
    }
    const merged = mergeFilterText(t.text.filter, base, filter)
    if (merged === undefined) return say(id, 'neutral', 'The filter already has these conditions.', 'results')
    text = merged
  }
  if (text.length > QUERY_TEXT_MAX) {
    return say(id, 'danger', `This filter would be ${text.length.toLocaleString('en-US')} characters, and the query history keeps up to ${QUERY_TEXT_MAX.toLocaleString('en-US')}. Select fewer rows.`, 'results')
  }
  replaceText(id, 'filter', text)
  // The new filter matches fewer documents: a skip typed for the old one could pass them all.
  replaceText(id, 'skip', '')
  await runQuery(id)
}

export async function applyBuilder(id: string): Promise<void> {
  const t = tab(id)
  if (!t) return
  const { filter, problems } = builderToFilter(t.builder)
  if (problems.length) {
    patch(id, { builderProblems: problems })
    return
  }
  replaceText(id, 'filter', Object.keys(filter).length ? toShellInline(filter) : '')
  patch(id, { builderProblems: [] })
  await runQuery(id)
}

export function loadBuilderFromFilter(id: string): void {
  const t = tab(id)
  if (!t) return
  try {
    const filter = parseShellDocument(t.text.filter, 'filter', { now: Date.now() })
    const g = filterToBuilder(filter)
    if (!g) {
      say(id, 'neutral', "This filter uses operators the Query Builder can't show. Keep editing it as text.", 'builder')
      return
    }
    patch(id, { builder: g, builderProblems: [], builderOpen: true })
  } catch (error) {
    patch(id, { fieldErrors: { ...t.fieldErrors, filter: errorText(error) } })
  }
}

// ---- History and saved queries ----

export async function loadLibrary(id: string): Promise<void> {
  const t = tab(id)
  if (!t) return
  try {
    patch(id, { library: await plugin.request('history.list', { ns: t.ns }) })
  } catch {
    // History is a convenience; the tab works without it.
  }
}

export function useQuery(id: string, query: QueryText): Promise<void> {
  patch(id, { text: { ...query }, fieldErrors: {}, optionsOpen: Boolean(query.collation || query.skip || query.limit) })
  return runQuery(id)
}

export async function saveQuery(id: string): Promise<void> {
  const t = tab(id)
  if (!t) return
  try {
    const library = await plugin.request('saved.save', { ns: t.ns, name: t.saveName, query: t.text })
    patch(id, { library, saveName: '' })
    say(id, 'success', `Saved the query as "${t.saveName.trim()}".`, 'library')
  } catch (error) {
    say(id, 'danger', errorText(error), 'library')
  }
}

export async function deleteSaved(id: string, name: string): Promise<void> {
  const t = tab(id)
  if (!t) return
  patch(id, { library: await plugin.request('saved.delete', { ns: t.ns, name }), librarySelected: undefined })
}

export async function clearHistory(id: string): Promise<void> {
  const t = tab(id)
  if (!t) return
  patch(id, { library: await plugin.request('history.clear', { ns: t.ns }), librarySelected: undefined })
}
