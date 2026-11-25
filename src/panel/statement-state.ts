// Whole shell statements where a query is expected: Shell mode's statement (a collection tab's
// default), or `db.orders.find({…}).sort({…})` pasted into the filter in Fields mode, run with Run. A find fills the query bar and runs; an aggregate opens
// the collection's aggregation tab; a count or distinct runs its filter and says what it found. A
// statement on another collection asks before going there, and one that writes, or that can't be
// read without running it, is offered to the Mongo Shell (and an updateMany to Update many) but
// never run from here. The statement is read by `readStatement`, never evaluated.
import { plugin, read } from 'orca'
import type { Namespace, QueryText } from '../protocol'
import { toShell, toShellInline, type JsonObject, type JsonValue } from '../shared/ejson-view'
import { isShellStatement, readStatement, ShellCallError, type StatementRead } from '../shared/shell-call'
import { newStage, stagesFromPipeline } from '../shared/pipeline'
import { openAggregation } from './aggregate-state'
import { canUpdateMany, change, chooseQueryMode, hasShellMode, nsLabel, openNamespace, openUpdateMany, runQuery, say, setBulk, tab, type CollTab, type QueryMode } from './collection-state'
import { queryStatement } from '../shared/query-statement'
import { queryTextOf } from './shell-state'
import { connections, errorText, view } from './state'

/** Distinct values a notice lists before saying how many more there are. */
const DISTINCT_SHOWN = 100
const DISTINCT_CHARS = 2000

/** Whether the tab's connection is read-only (the tab's own `readOnly` is about views). */
export function connectionReadOnly(ns: Namespace): boolean {
  return read(connections)?.connections.find((c) => c.id === ns.connectionId)?.readOnly === true
}

/** Run: Shell mode's statement, or in Fields mode the fields, or a statement pasted as the filter. */
export async function runBar(id: string): Promise<void> {
  const t = tab(id)
  if (!t) return
  const shell = hasShellMode(t) && t.queryMode === 'shell'
  if (!shell && (!hasShellMode(t) || !isShellStatement(t.text.filter))) return runQuery(id)
  const text = (shell ? t.shellText : t.text.filter).trim()
  if (shell && !isShellStatement(text)) {
    change(id, () => ({ shellError: `Write a statement on db, such as db.getCollection(${JSON.stringify(t.ns.collection)}).find({}).`, statement: undefined }))
    return
  }
  let r: StatementRead
  try {
    r = readStatement(text, t.ns.db)
  } catch (error) {
    if (!(error instanceof ShellCallError)) throw error
    change(id, () => ({ statement: { kind: 'shell', text, reason: error.message, writes: false }, fieldErrors: {} }))
    return
  }
  if (r.kind === 'shell') {
    const reason = r.writes
      ? `${r.method}() changes data, so the query bar doesn't run it.`
      : `The query bar reads find, findOne, aggregate, count and distinct; ${r.method}() runs in the Mongo Shell.`
    change(id, () => ({ statement: { kind: 'shell', text, reason, writes: r.writes, ...(r.updateMany ? { updateMany: r.updateMany } : {}) }, fieldErrors: {} }))
    return
  }
  const target = targetOf(r, t.ns)
  if (target.db !== t.ns.db || target.collection !== t.ns.collection) {
    change(id, () => ({ statement: { kind: 'elsewhere', read: r, target }, fieldErrors: {} }))
    return
  }
  await useRead(id, r, shell)
}

function targetOf(r: Exclude<StatementRead, { kind: 'shell' }>, ns: Namespace): Namespace {
  const { db, collection } = r.kind === 'find' || r.kind === 'aggregate' ? r.op : r
  return { connectionId: ns.connectionId, db, collection }
}

/** The query bar text that runs what a find, count or distinct reads, its filter and options. */
function barText(r: Exclude<StatementRead, { kind: 'shell' | 'aggregate' }>): QueryText {
  if (r.kind === 'find') return queryTextOf(r.op)
  const doc = (v: JsonObject | undefined): string => (v && Object.keys(v).length ? toShellInline(v) : '')
  return {
    filter: doc(r.filter),
    projection: '',
    sort: '',
    collation: doc(r.collation),
    skip: r.kind === 'count' && r.skip ? String(r.skip) : '',
    limit: r.kind === 'count' && r.limit ? String(r.limit) : ''
  }
}

/** Uses what a statement reads in tab `id`, on that tab's collection whatever the statement named.
 *  `keepShell`: the statement came from Shell mode and names this collection, so it stays as typed;
 *  otherwise Shell mode's statement is written again from the fields. */
async function useRead(id: string, r: Exclude<StatementRead, { kind: 'shell' }>, keepShell = false): Promise<void> {
  const t = tab(id)
  if (!t) return
  if (r.kind === 'aggregate') return openPipeline(t.ns, t.kind, r, t.agg ? undefined : `the query bar of ${t.title}`)
  const text = barText(r)
  change(id, () => ({ text, ...(keepShell ? { shellRead: text } : {}), fieldErrors: {}, statement: undefined, shellError: undefined, ...(text.collation || text.skip || text.limit ? { optionsOpen: true } : {}) }))
  await runQuery(id)
  await report(id, r)
}

/** Opens (or shows) a collection's tab and uses what a find, count or distinct reads there. Its
 *  Shell mode gets the statement as typed, which names that collection. */
async function openRead(ns: Namespace, r: Exclude<StatementRead, { kind: 'shell' | 'aggregate' }>, statement: string): Promise<void> {
  await openNamespace(ns, 'coll', barText(r))
  const id = read(view)
  if (!tab(id)) return
  change(id, (t) => ({ shellText: statement, shellRead: t.text, shellError: undefined }))
  await report(id, r)
}

/** Opens (or shows) a collection's aggregation tab with the statement's pipeline and options. */
async function openPipeline(ns: Namespace, kind: CollTab['kind'], r: Extract<StatementRead, { kind: 'aggregate' }>, from?: string): Promise<void> {
  const { stages, error } = stagesFromPipeline(r.op.pipeline)
  if (!stages) throw new Error(error)
  await openAggregation(ns, kind, stages.length ? stages : [newStage('$match')], from, r)
}

/** Says what a count or distinct found, or what the query bar left out of a find. */
async function report(id: string, r: Exclude<StatementRead, { kind: 'shell' | 'aggregate' }>): Promise<void> {
  const t = tab(id)
  if (!t || t.error) return
  const n = (x: number): string => x.toLocaleString('en-US')
  if (r.kind === 'find') {
    if (r.ignored.length) say(id, 'neutral', `Left out what the query bar doesn't take: ${r.ignored.join(', ')}.`)
    return
  }
  if (r.kind === 'count') {
    if (r.method === 'estimatedDocumentCount') {
      const { count } = await plugin.request('data.count', { ns: t.ns })
      if (count === null) say(id, 'danger', `${nsLabel(t.ns)} has no estimated count: a view has none, and the server may have refused or taken too long.`)
      else say(id, 'success', `estimatedDocumentCount: about ${n(count)} documents, from the collection's metadata.`)
      return
    }
    const c = t.count
    if (!c || c === 'counting') return
    if (c.count === null) say(id, 'danger', `${r.method} failed: ${c.error ?? 'the server gave no count.'}`)
    else say(id, 'success', `${r.method}: ${n(c.count)} ${c.count === 1 ? 'document' : 'documents'}${c.approximate ? ", estimated from the collection's metadata" : ''}.`)
    return
  }
  const result = await plugin.request('query.distinct', { ns: t.ns, field: r.field, filter: r.filter, ...(r.collation ? { collation: r.collation } : {}) }, { timeoutMs: 120000 })
  say(id, 'success', distinctText(r.field, result.values, result.total))
}

/** `distinct('status'): 3 values: 'A', 'B', 'C'.`, listing the first ones when there are many. */
export function distinctText(field: string, values: readonly JsonValue[], total: number): string {
  const head = `distinct(${toShellInline(field)}): ${total.toLocaleString('en-US')} ${total === 1 ? 'value' : 'values'}`
  if (total === 0) return `${head}.`
  const shown: string[] = []
  let chars = 0
  for (const v of values.slice(0, DISTINCT_SHOWN)) {
    const s = toShellInline(v)
    if (shown.length && chars + s.length > DISTINCT_CHARS) break
    shown.push(s)
    chars += s.length + 2
  }
  const more = total - shown.length
  return `${head}: ${shown.join(', ')}${more > 0 ? `, and ${more.toLocaleString('en-US')} more` : ''}.`
}

// ---- The offer's buttons ----

/** Opens the collection the statement names and uses it there. */
export async function openElsewhere(id: string): Promise<void> {
  const s = tab(id)?.statement
  if (s?.kind !== 'elsewhere') return
  change(id, () => ({ statement: undefined }))
  const r = s.read
  if (r.kind === 'shell') return
  if (r.kind === 'aggregate') return openPipeline(s.target, 'coll', r, `a statement in ${tab(id)?.title ?? 'another tab'}`)
  const t = tab(id)
  return openRead(s.target, r, t && t.queryMode === 'shell' ? t.shellText.trim() : t?.text.filter.trim() ?? '')
}

/** Uses the statement on this tab's collection instead of the one it names. */
export async function useHere(id: string): Promise<void> {
  const s = tab(id)?.statement
  if (s?.kind !== 'elsewhere' || s.read.kind === 'shell') return
  await useRead(id, s.read)
}

export function dismissStatement(id: string): void {
  change(id, () => ({ statement: undefined }))
}

// ---- Shell mode ----

/** Shell mode's statement as typed: a choice offered for the one before no longer applies. */
export function setShellText(id: string, value: string): void {
  change(id, () => ({ shellText: value, shellError: undefined, statement: undefined }))
}

/** Switches a tab between Shell and Fields mode, and remembers the choice for new tabs. Going to
 *  Fields, a find on this collection typed since the last run fills the fields; any other
 *  statement leaves them as last run, and says so. */
export function setQueryMode(id: string, mode: QueryMode): void {
  const t = tab(id)
  if (!t || !hasShellMode(t)) return
  chooseQueryMode(mode)
  if (t.queryMode === mode) return
  if (mode === 'fields') {
    const from = fieldsFromShell(t)
    change(id, () => ({ queryMode: mode, statement: undefined, shellError: undefined, ...from.values }))
    if (from.note) say(id, 'neutral', from.note)
    return
  }
  change(id, () => ({ queryMode: mode, statement: undefined }))
}

/** The fields that Shell mode's statement stands for, when it is a find on this collection. */
function fieldsFromShell(t: CollTab): { values?: Partial<CollTab>; note?: string } {
  const statement = t.shellText.trim()
  if (statement === queryStatement(t.ns.collection, t.text)) return {}
  let r: StatementRead | undefined
  try {
    r = isShellStatement(statement) ? readStatement(statement, t.ns.db) : undefined
  } catch {
    r = undefined
  }
  if (r?.kind === 'find' && r.op.db === t.ns.db && r.op.collection === t.ns.collection) {
    const text = barText(r)
    return { values: { text, shellRead: text, fieldErrors: {}, ...(text.collation || text.skip || text.limit ? { optionsOpen: true } : {}) } }
  }
  return { note: "The statement isn't a find on this collection, so the fields keep the query as last run. Shell mode keeps the statement." }
}

/** Before something uses the query as the fields hold it (Explain, Export, the aggregation editor):
 *  in Shell mode, a find on this collection typed since the last run fills them first. */
export function syncFromShell(id: string): void {
  const t = tab(id)
  if (!t || !hasShellMode(t) || t.queryMode !== 'shell') return
  const from = fieldsFromShell(t)
  if (from.values) change(id, () => from.values!)
}

/** Copies the statement, to paste into a Mongo Shell editor. Not for a write on a read-only
 *  connection, which the shell would refuse. */
export async function copyForShell(id: string): Promise<void> {
  const t = tab(id)
  const s = t?.statement
  if (!t || s?.kind !== 'shell' || (s.writes && connectionReadOnly(t.ns))) return
  try {
    await plugin.request('clipboard.copyText', { text: s.text })
  } catch (error) {
    say(id, 'danger', `Could not copy the statement: ${errorText(error)}. Select it and copy it.`)
    return
  }
  say(id, 'success', 'Copied the statement. Paste it into a Mongo Shell editor (Mongo Studio: New shell script) and run it there.')
}

/** Whether an updateMany statement can go to this tab's Update many. */
export function canOfferUpdateMany(t: CollTab): boolean {
  return t.statement?.kind === 'shell' && t.statement.updateMany !== undefined && canUpdateMany(t) && !connectionReadOnly(t.ns)
}

/** Runs the updateMany's filter as the query, then opens Update many over its matches with the
 *  update filled in. Nothing changes until Update many is previewed and confirmed there. */
export async function openInUpdateMany(id: string): Promise<void> {
  const t = tab(id)
  const s = t?.statement
  if (!t || s?.kind !== 'shell' || !s.updateMany || !canOfferUpdateMany(t)) return
  const { filter, update } = s.updateMany
  change(id, (x) => ({ text: { ...x.text, filter: toShellInline(filter), projection: '', sort: '', collation: '', skip: '', limit: '' }, fieldErrors: {}, statement: undefined }))
  await runQuery(id)
  if (!tab(id)?.spec || tab(id)?.error) return
  openUpdateMany(id, 'query')
  setBulk(id, { text: toShell(update) })
}
