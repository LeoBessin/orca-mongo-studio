// Collection tabs: each open collection, view or time-series collection is a tab with its own
// query bar, results, editors, Query Builder and history. All tabs live in one atom, changed
// immutably through `change(id, ...)`, so a tab's state survives switching between tabs.
import { atom, plugin, read, set, update } from 'orca'
import type { CountResult, Namespace, QueryLibrary, QueryPage, QuerySpec, QueryText } from '../protocol'
import { bsonType, fieldPaths, idKey, isObject, toJsonText, toShell, toShellInline, valueAt, type JsonObject, type JsonValue } from '../shared/ejson-view'
import { draftFromValue, valueFromDraft, type FieldDraft } from '../shared/field-edit'
import { builderToFilter, emptyGroup, filterToBuilder, newCondition, type BuilderProblem, type Group } from '../shared/query-builder'
import { fitsHost } from '../shared/host-size'
import { nodeTarget, type NodeKind } from '../shared/nodes'
import { parseShell, parseShellDocument, ShellParseError } from '../shared/shell-parse'
import { errorText, nodeIndex, view } from './state'

export type ResultView = 'table' | 'tree' | 'json'
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
export type TabNotice = { tone: 'success' | 'danger' | 'neutral'; text: string }

export type CollTab = {
  id: string
  ns: Namespace
  kind: NodeKind
  title: string
  readOnly: boolean
  text: QueryText
  fieldErrors: Partial<Record<QueryField, string>>
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
  editor?: Editor
  confirmDelete?: { ids: JsonValue[] }
  builder: Group
  builderProblems: BuilderProblem[]
  builderOpen: boolean
  optionsOpen: boolean
  library?: QueryLibrary
  saveName: string
  librarySelected?: string
  notice?: TabNotice
  /** Results of a shell run, paged from the worker instead of a query. */
  shell?: { runId: string; index: number }
}

export const PAGE_SIZE_OPTIONS = [20, 50, 100, 200, 500]

export const collTabs = atom<Record<string, CollTab>>({})
export const tabOrder = atom<string[]>([])
export const defaultPageSize = atom<number>('mongo-studio.pageSize', 50, { persist: 'plugin' })

const emptyText: QueryText = { filter: '', projection: '', sort: '', collation: '', skip: '', limit: '' }

export function tab(id: string): CollTab | undefined {
  return read(collTabs)[id]
}

export function change(id: string, fn: (t: CollTab) => CollTab | Partial<CollTab>): void {
  update(collTabs, (prev) => {
    const t = prev[id]
    if (!t) return prev
    const next = fn(t)
    return { ...prev, [id]: 'id' in next && next.id === t.id ? (next as CollTab) : { ...t, ...next } }
  })
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
  let h = 0x811c9dc5
  for (const ch of JSON.stringify([ns.connectionId, ns.db, ns.collection])) {
    h ^= ch.codePointAt(0)!
    h = Math.imul(h, 0x01000193) >>> 0
  }
  return `coll-${h.toString(36)}`
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
    return t && t.ns.connectionId === ns.connectionId && t.ns.db === ns.db && t.ns.collection === ns.collection
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
  const t: CollTab = newTab(id, ns, kind, ns.collection)
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
    pageSize: read(defaultPageSize),
    loading: false,
    runToken: 0,
    resultView: 'table',
    relaxed: true,
    selectedRows: [],
    treeExpanded: [],
    flattened: [],
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

export function setText(id: string, field: QueryField, value: string): void {
  change(id, (t) => {
    const fieldErrors = { ...t.fieldErrors }
    delete fieldErrors[field]
    return { text: { ...t.text, [field]: value }, fieldErrors }
  })
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
    const v = text[field].trim()
    if (v === '') return 0
    if (!/^\d+$/.test(v)) {
      errors[field] = `${field === 'skip' ? 'Skip' : 'Limit'} is a whole number, 0 or more.`
      return 0
    }
    return Number(v)
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
  if (!t) return
  if (t.shell) return goToPage(id, 0)
  const { spec, errors } = specFromText(t.text)
  if (!spec) {
    patch(id, { fieldErrors: errors })
    return
  }
  if (t.queryId) void plugin.request('query.close', { queryId: t.queryId }).catch(() => undefined)
  const token = t.runToken + 1
  patch(id, { loading: true, error: undefined, fieldErrors: {}, runToken: token, spec, count: 'counting', selectedRows: [], editor: undefined, confirmDelete: undefined, treeSelected: undefined, treeExpanded: [], notice: undefined })
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

async function countQuery(id: string, token: number, spec: QuerySpec): Promise<void> {
  const t = tab(id)
  if (!t) return
  try {
    const count = await plugin.request('query.count', { ns: t.ns, spec }, { timeoutMs: 60000 })
    if (tab(id)?.runToken === token) patch(id, { count })
  } catch (error) {
    if (tab(id)?.runToken === token) patch(id, { count: { count: null, approximate: false, ms: 0, error: errorText(error) } })
  }
}

export async function recount(id: string): Promise<void> {
  const t = tab(id)
  if (!t?.spec || t.shell) return
  patch(id, { count: 'counting' })
  await countQuery(id, t.runToken, t.spec)
}

export async function goToPage(id: string, offset: number): Promise<void> {
  const t = tab(id)
  if (!t || (!t.shell && (!t.spec || !t.queryId))) return
  const token = t.runToken
  patch(id, { loading: true, error: undefined, selectedRows: [], editor: undefined, confirmDelete: undefined, treeSelected: undefined, treeExpanded: [] })
  try {
    const page = t.shell
      ? await plugin.request('shell.page', { runId: t.shell.runId, index: t.shell.index, offset: Math.max(0, offset), pageSize: t.pageSize }, { timeoutMs: 120000 })
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

export async function setPageSize(id: string, size: number): Promise<void> {
  set(defaultPageSize, size)
  patch(id, { pageSize: size })
  const t = tab(id)
  if (t?.page) await goToPage(id, t.page.offset)
}

/** Reloads the page on screen, after an edit. */
export async function reloadPage(id: string): Promise<void> {
  const t = tab(id)
  if (!t?.page) return runQuery(id, false)
  const keepNotice = t.notice
  await goToPage(id, t.page.offset)
  patch(id, { notice: keepNotice })
  void recount(id)
}

/** Header click: sort by that column, flipping on a second click. */
export async function sortBy(id: string, column: string, direction: 'asc' | 'desc'): Promise<void> {
  if (tab(id)?.shell) {
    say(id, 'neutral', 'Shell results keep the order the script gave them. Add .sort({ … }) to the statement and run it again.')
    return
  }
  const key = /^[A-Za-z_$][A-Za-z0-9_$.]*$/.test(column) ? column : `'${column.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`
  setText(id, 'sort', `{ ${key}: ${direction === 'asc' ? 1 : -1} }`)
  await runQuery(id)
}

/** The column and direction of a one-key sort in the query that ran, for the table header. */
export function currentSort(t: CollTab): { column: string; direction: 'asc' | 'desc' } | undefined {
  const sort = t.spec?.sort
  if (!sort) return undefined
  const entries = Object.entries(sort)
  if (entries.length !== 1) return undefined
  const [column, v] = entries[0]!
  const n = typeof v === 'number' ? v : isObject(v) ? Number(v.$numberInt ?? v.$numberDouble ?? v.$numberLong) : NaN
  return n === 1 || n === -1 ? { column, direction: n === 1 ? 'asc' : 'desc' } : undefined
}

export function resetQuery(id: string): Promise<void> {
  patch(id, { text: { ...emptyText }, fieldErrors: {} })
  return runQuery(id)
}

// ---- Rows, selection and documents ----

/** Table row key for a document: its `_id`, or its place on the page when it has none. */
export function rowKey(doc: JsonObject, index: number): string {
  return '_id' in doc ? idKey(doc._id!) : `#${index}`
}

export function selectedDocs(t: CollTab): JsonObject[] {
  const keys = new Set(t.selectedRows)
  return (t.page?.docs ?? []).filter((d, i) => keys.has(rowKey(d, i)))
}

/** Fields sampled from the documents on screen, for the builder and the field picker. */
export function sampledFields(t: CollTab): string[] {
  const out = new Set<string>()
  for (const d of t.page?.docs ?? []) fieldPaths(d, '', out)
  return [...out].sort((a, b) => (a === '_id' ? -1 : b === '_id' ? 1 : a.localeCompare(b)))
}

export function say(id: string, tone: TabNotice['tone'], text: string): void {
  patch(id, { notice: { tone, text } })
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
    say(id, 'danger', errorText(error))
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
    say(id, 'success', r.modified ? `Saved ${path.join('.')}.` : `${path.join('.')} already had that value.`)
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
    say(id, 'success', `Removed ${e.path.join('.')}.`)
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
    say(id, 'danger', errorText(error))
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
    say(id, 'danger', errorText(error))
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
      say(id, 'success', r.modified ? 'Document saved.' : 'Nothing changed.')
    } else {
      const r = await plugin.request('doc.insert', { ns: t.ns, docs: [doc] }, { timeoutMs: 60000 })
      say(id, 'success', `Inserted a document with _id ${toShellInline(r.insertedIds[0] ?? null)}.`)
    }
    patch(id, { editor: undefined })
    await reloadPage(id)
  } catch (error) {
    editorError(id, errorText(error))
  }
}

export function askDelete(id: string): void {
  const t = tab(id)
  if (!t) return
  const docs = selectedDocs(t).filter((d) => '_id' in d)
  if (docs.length === 0) return
  patch(id, { confirmDelete: { ids: docs.map((d) => d._id!) }, editor: undefined })
}

export async function confirmDeletion(id: string): Promise<void> {
  const t = tab(id)
  const ids = t?.confirmDelete?.ids
  if (!t || !ids) return
  try {
    const r = await plugin.request('doc.deleteMany', { ns: t.ns, ids }, { timeoutMs: 120000 })
    patch(id, { confirmDelete: undefined, selectedRows: [] })
    say(id, 'success', `Deleted ${r.deleted.toLocaleString('en-US')} document${r.deleted === 1 ? '' : 's'} from ${nsLabel(t.ns)}.`)
    await reloadPage(id)
  } catch (error) {
    patch(id, { confirmDelete: undefined })
    say(id, 'danger', errorText(error))
  }
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
  say(id, 'neutral', `Added ${field} to the Query Builder. Apply it to the filter to run it.`)
}

export async function applyBuilder(id: string): Promise<void> {
  const t = tab(id)
  if (!t) return
  const { filter, problems } = builderToFilter(t.builder)
  if (problems.length) {
    patch(id, { builderProblems: problems })
    return
  }
  setText(id, 'filter', Object.keys(filter).length ? toShellInline(filter) : '')
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
      say(id, 'neutral', "This filter uses operators the Query Builder can't show. Keep editing it as text.")
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
    say(id, 'success', `Saved the query as "${t.saveName.trim()}".`)
  } catch (error) {
    say(id, 'danger', errorText(error))
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
