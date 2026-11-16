// The Shell tab: results of the newest shell run (from any .mongodb.js editor), paged like a
// query's. A find result can open as a query in its collection's tab, and any find or aggregate
// becomes driver code.
import { atom, plugin, read, set, update } from 'orca'
import type { QueryText, ShellResultInfo, ShellRunSummary } from '../protocol'
import type { CodeLanguage } from '../shared/codegen'
import { toShellInline } from '../shared/ejson-view'
import type { Operation } from '../shared/operation'
import { collTabs, defaultPageSize, goToPage, newTab, openNamespace, tab, type CollTab } from './collection-state'
import { stagesFromPipeline } from '../shared/pipeline'
import { openAggregation } from './aggregate-state'
import { errorText, view } from './state'

export const SHELL_TAB = 'shell'

export const shellRun = atom<ShellRunSummary | null>(null)
export const codeLanguage = atom<CodeLanguage>('mongo-studio.codeLanguage', 'node', { persist: 'plugin' })

function resultTitle(r: ShellResultInfo): string {
  const what = r.op ? `${r.op.kind} on ${r.op.collection}` : r.kind === 'cursor' ? 'cursor' : r.count === 1 ? 'document' : 'documents'
  const count = r.count !== undefined ? ` · ${r.count.toLocaleString('en-US')} ${r.count === 1 ? 'document' : 'documents'}` : ''
  return `${r.index + 1}. ${r.title || `Line ${r.line}: ${what}`}${count}`
}

export function resultOptions(run: ShellRunSummary): { value: string; label: string }[] {
  return run.results.map((r) => ({ value: String(r.index), label: resultTitle(r) }))
}

/** Shows a run's results; the last one first, as the newest thing the script produced. */
export async function showRun(run: ShellRunSummary, focus: boolean): Promise<void> {
  set(shellRun, run)
  if (!run.results.length) return
  await selectResult(run.results.length - 1)
  if (focus) set(view, SHELL_TAB)
}

export async function selectResult(index: number): Promise<void> {
  const run = read(shellRun)
  const info = run?.results[index]
  if (!run || !info) return
  const previous = tab(SHELL_TAB)
  const ns = { connectionId: run.connectionId, db: info.op?.db ?? run.db, collection: info.op?.collection ?? '(shell)' }
  const t: CollTab = {
    ...newTab(SHELL_TAB, ns, 'coll', 'Shell'),
    readOnly: true,
    pageSize: previous?.pageSize ?? read(defaultPageSize),
    resultView: previous?.resultView ?? 'table',
    relaxed: previous?.relaxed ?? true,
    shell: { runId: run.runId, index },
    runToken: (previous?.runToken ?? 0) + 1,
    ...(info.count !== undefined ? { count: { count: info.count, approximate: false, ms: 0 } } : {})
  }
  update(collTabs, (prev) => ({ ...prev, [SHELL_TAB]: t }))
  await goToPage(SHELL_TAB, 0)
}

export function closeShell(): void {
  set(shellRun, null)
  update(collTabs, (prev) => {
    const next = { ...prev }
    delete next[SHELL_TAB]
    return next
  })
  if (read(view) === SHELL_TAB) set(view, 'tree')
}

export async function loadLatestRun(): Promise<void> {
  try {
    const { run } = await plugin.request('shell.latest')
    if (run && !read(shellRun)) await showRun(run, false)
  } catch {
    // No worker yet: nothing to show.
  }
}

/** A find's query bar text, as the collection tab shows it. */
export function queryTextOf(op: Extract<Operation, { kind: 'find' }>): QueryText {
  const doc = (v: Record<string, unknown> | undefined): string => (v && Object.keys(v).length ? toShellInline(v as never) : '')
  return {
    filter: doc(op.filter),
    projection: doc(op.projection),
    sort: doc(op.sort),
    collation: doc(op.collation),
    skip: op.skip ? String(op.skip) : '',
    limit: op.limit ? String(op.limit) : ''
  }
}

export async function openAsQuery(info: ShellResultInfo): Promise<void> {
  const run = read(shellRun)
  if (!run || info.op?.kind !== 'find') return
  try {
    await openNamespace({ connectionId: run.connectionId, db: info.op.db, collection: info.op.collection }, 'coll', queryTextOf(info.op))
  } catch (error) {
    update(collTabs, (prev) => {
      const t = prev[SHELL_TAB]
      return t ? { ...prev, [SHELL_TAB]: { ...t, notice: { tone: 'danger' as const, text: errorText(error) } } } : prev
    })
  }
}

/** An aggregate result's pipeline, in its collection's aggregation tab. */
export async function openAsPipeline(info: ShellResultInfo): Promise<void> {
  const run = read(shellRun)
  if (!run || info.op?.kind !== 'aggregate') return
  const { stages, error } = stagesFromPipeline(info.op.pipeline)
  if (!stages) throw new Error(error)
  await openAggregation({ connectionId: run.connectionId, db: info.op.db, collection: info.op.collection }, 'coll', stages, `the shell (line ${info.line})`)
}
