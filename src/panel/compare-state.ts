// The Compare tab: two collections (on one connection or two) matched by `_id`; the documents
// that differ or are only on one side, a pair's field differences, and a sync that makes one side
// like the other, asked first with what it will change.
import { plugin } from 'orca'
import type { CompareResult, Namespace } from '../protocol'
import { parseFieldList, type CompareRules, type FieldDiff } from '../shared/compare'
import { idKey, type JsonObject, type JsonValue } from '../shared/ejson-view'
import type { NodeKind } from '../shared/nodes'
import { parseShellDocument, ShellParseError } from '../shared/shell-parse'
import { adminTabId, changeAdmin, connectionName, numberText, sayAdmin, showOrAdd, tabOf } from './admin-state'
import { cancelJob, followJob, type JobBox } from './data-state'
import { errorText } from './state'

export type CompareShow = 'differ' | 'onlyA' | 'onlyB'
export type CompareTab = {
  id: string
  kind: 'compare'
  connectionId: string
  title: string
  notice?: { tone: 'success' | 'danger' | 'neutral'; text: string }
  a: Namespace
  collKind: NodeKind
  b: { connectionId: string; db: string; collection: string }
  filter: string
  filterError?: string
  ignore: string
  ignoreOrder: boolean
  job?: JobBox
  /** The compared pair and rules the result is about. */
  ran?: { a: Namespace; b: Namespace; filter?: JsonObject; rules: CompareRules }
  result?: CompareResult
  show: CompareShow
  selected?: string
  diff?: { key: string; loading: boolean; a?: JsonObject | null; b?: JsonObject | null; diffs?: FieldDiff[]; capped?: boolean; error?: string }
  sync: { open: boolean; direction: 'aToB' | 'bToA'; insert: boolean; replace: boolean; remove: boolean; confirm: boolean; job?: JobBox }
  /** The saved task (a compare or a sync) this tab was opened from, or last saved as. */
  task?: { id: string; name: string; kind: 'compare' | 'sync' }
  taskName: string
}

export function compareTabId(a: Namespace): string {
  return adminTabId('compare', [a.connectionId, a.db, a.collection])
}

export function openCompare(a: Namespace, collKind: NodeKind, b?: Namespace): void {
  const id = compareTabId(a)
  showOrAdd({
    id,
    kind: 'compare',
    connectionId: a.connectionId,
    title: `Compare: ${a.collection}`,
    a,
    collKind,
    b: b ?? { connectionId: a.connectionId, db: a.db, collection: '' },
    filter: '',
    ignore: '',
    ignoreOrder: false,
    show: 'differ',
    sync: { open: false, direction: 'aToB', insert: true, replace: true, remove: false, confirm: false },
    taskName: ''
  })
  if (b) changeAdmin(id, 'compare', () => ({ b }))
}

export function setCompare(id: string, change: Partial<CompareTab>): void {
  changeAdmin(id, 'compare', (t) => ({ ...change, sync: { ...(change.sync ?? t.sync), confirm: false } }))
}

export function bNs(t: CompareTab): Namespace {
  return { connectionId: t.b.connectionId, db: t.b.db.trim(), collection: t.b.collection.trim() }
}

function parsed(id: string): { filter?: JsonObject; rules: CompareRules } {
  const t = tabOf(id, 'compare')!
  let filter: JsonObject | undefined
  if (t.filter.trim()) {
    try {
      filter = parseShellDocument(t.filter, 'filter')
    } catch (error) {
      const message = error instanceof ShellParseError ? error.message : errorText(error)
      changeAdmin(id, 'compare', () => ({ filterError: message }))
      throw new Error('Fix the filter first.')
    }
  }
  return { ...(filter && Object.keys(filter).length ? { filter } : {}), rules: { ignoreFields: parseFieldList(t.ignore), ignoreOrder: t.ignoreOrder } }
}

export function compareProblems(t: CompareTab): string[] {
  const b = bNs(t)
  if (!b.db || !b.collection) return ['Choose the collection to compare with.']
  if (b.connectionId === t.a.connectionId && b.db === t.a.db && b.collection === t.a.collection) return ['Choose another collection: this is the same one.']
  return []
}

/** The comparison as `compare.start` (and a saved task) takes it. */
export function compareRequest(id: string): { a: Namespace; b: Namespace; filter?: JsonObject; rules: CompareRules } {
  const t = tabOf(id, 'compare')!
  const problems = compareProblems(t)
  if (problems.length) throw new Error(problems.join(' '))
  const { filter, rules } = parsed(id)
  return { a: t.a, b: bNs(t), ...(filter ? { filter } : {}), rules }
}

/** The sync as the tab is set up (no comparison needed first), for a saved task. */
export function syncRequest(id: string): { from: Namespace; to: Namespace; filter?: JsonObject; rules: CompareRules; insert: boolean; replace: boolean; remove: boolean } {
  const t = tabOf(id, 'compare')!
  const c = compareRequest(id)
  const s = t.sync
  if (!s.insert && !s.replace && !s.remove) throw new Error('Choose at least one change for the sync.')
  const aToB = s.direction === 'aToB'
  return { from: aToB ? c.a : c.b, to: aToB ? c.b : c.a, ...(c.filter ? { filter: c.filter } : {}), rules: c.rules, insert: s.insert, replace: s.replace, remove: s.remove }
}

export async function runCompare(id: string): Promise<void> {
  const t = tabOf(id, 'compare')
  if (!t) return
  const problems = compareProblems(t)
  if (problems.length) throw new Error(problems.join(' '))
  const { filter, rules } = parsed(id)
  const b = bNs(t)
  changeAdmin(id, 'compare', () => ({ filterError: undefined, job: undefined, result: undefined, ran: undefined, selected: undefined, diff: undefined, sync: { ...t.sync, confirm: false } }))
  const { jobId } = await plugin.request('compare.start', { a: t.a, b, ...(filter ? { filter } : {}), rules })
  changeAdmin(id, 'compare', () => ({ job: { jobId } }))
  const end = await followJob(jobId, () => tabOf(id, 'compare')?.job, (job) => changeAdmin(id, 'compare', () => ({ job })))
  if (end?.status === 'done' && end.result?.kind === 'compare') {
    const r = end.result
    changeAdmin(id, 'compare', () => ({ result: r, ran: { a: t.a, b, ...(filter ? { filter } : {}), rules }, show: r.differ ? 'differ' : r.onlyA ? 'onlyA' : r.onlyB ? 'onlyB' : 'differ' }))
  }
}

export function idsShown(t: CompareTab): JsonValue[] {
  return t.result?.ids[t.show] ?? []
}

export async function selectPair(id: string, key: string): Promise<void> {
  const t = tabOf(id, 'compare')
  if (!t?.ran) return
  const value = idsShown(t).find((v) => idKey(v) === key)
  if (value === undefined) return
  changeAdmin(id, 'compare', () => ({ selected: key, diff: { key, loading: true } }))
  try {
    const d = await plugin.request('compare.diff', { a: t.ran.a, b: t.ran.b, id: value, rules: t.ran.rules })
    changeAdmin(id, 'compare', (x) => (x.selected === key ? { diff: { key, loading: false, a: d.a, b: d.b, diffs: d.diffs, capped: d.capped } } : {}))
  } catch (error) {
    changeAdmin(id, 'compare', (x) => (x.selected === key ? { diff: { key, loading: false, error: errorText(error) } } : {}))
  }
}

/** What a sync would change, from the comparison: counts by kind. */
export function syncPlan(t: CompareTab): { to: string; insert: number; replace: number; remove: number } | undefined {
  const r = t.result
  if (!r || !t.ran) return undefined
  const s = t.sync
  const aToB = s.direction === 'aToB'
  const to = aToB ? t.ran.b : t.ran.a
  return {
    to: `${to.db}.${to.collection} on ${connectionName(to.connectionId)}`,
    insert: s.insert ? (aToB ? r.onlyA : r.onlyB) : 0,
    replace: s.replace ? r.differ : 0,
    remove: s.remove ? (aToB ? r.onlyB : r.onlyA) : 0
  }
}

export async function runSync(id: string, confirmed = false): Promise<void> {
  const t = tabOf(id, 'compare')
  if (!t?.ran || !t.result) throw new Error('Compare first, to see what a sync would change.')
  const s = t.sync
  if (!s.insert && !s.replace && !s.remove) throw new Error('Choose at least one change.')
  if (!confirmed) {
    changeAdmin(id, 'compare', (x) => ({ sync: { ...x.sync, confirm: true } }))
    return
  }
  const from = s.direction === 'aToB' ? t.ran.a : t.ran.b
  const to = s.direction === 'aToB' ? t.ran.b : t.ran.a
  changeAdmin(id, 'compare', (x) => ({ sync: { ...x.sync, confirm: false, job: undefined } }))
  const { jobId } = await plugin.request('compare.sync', { from, to, ...(t.ran.filter ? { filter: t.ran.filter } : {}), rules: t.ran.rules, insert: s.insert, replace: s.replace, remove: s.remove })
  changeAdmin(id, 'compare', (x) => ({ sync: { ...x.sync, job: { jobId } } }))
  const end = await followJob(jobId, () => tabOf(id, 'compare')?.sync.job, (job) => changeAdmin(id, 'compare', (x) => ({ sync: { ...x.sync, job } })))
  if (end?.status === 'done' && end.result?.kind === 'sync') {
    const r = end.result
    sayAdmin(id, r.failed ? 'neutral' : 'success', `Synced ${to.db}.${to.collection}: ${numberText(r.inserted)} inserted, ${numberText(r.replaced)} replaced, ${numberText(r.deleted)} deleted${r.failed ? `, ${numberText(r.failed)} failed` : ''}. Compare again to check.`)
  }
}

export async function cancelCompare(id: string): Promise<void> {
  const t = tabOf(id, 'compare')
  await cancelJob(t?.sync.job && t.sync.job.state?.status === 'running' ? t.sync.job : t?.job)
}
