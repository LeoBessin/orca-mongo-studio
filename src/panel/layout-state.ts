// The panel's layout across panel runs. Orca ends a panel's run whenever another right-sidebar tab
// is shown, and only persisted atoms carry over; the worker, and so every open connection, keeps
// running. This keeps what the person had open (tabs, their queries and pipelines, the tree's open
// nodes) in one workspace atom, and the next run rebuilds it and asks the worker again.
// Results, documents and edits in progress are never saved: they can be large or sensitive, and
// re-running is cheap. Tabs of a connection that is no longer open come back without results and
// never connect by themselves, so restoring cannot prompt for a password or an SSH key.
import { atom, read, set, update } from 'orca'
import type { Namespace, QueryText } from '../protocol'
import type { JsonValue } from '../shared/ejson-view'
import type { NodeKind } from '../shared/nodes'
import { cloneStages, hasWriteStage, pipelineOf, type StageText } from '../shared/pipeline'
import { emptyGroup, filterToBuilder } from '../shared/query-builder'
import { parseShellDocument } from '../shared/shell-parse'
import { adminTabs, type AdminTab } from './admin-state'
import { loadSavedPipelines, newAgg, refreshPreview, runPipeline } from './aggregate-state'
import { collTabs, loadFocus, loadLibrary, newFocus, newTab, runQuery, tabOrder, type CollTab, type DocView, type ResultView } from './collection-state'
import { openDatabase } from './database-state'
import { openGridfs } from './gridfs-state'
import { openManage } from './manage-state'
import { openSchema } from './schema-state'
import { openServer } from './server-state'
import { connections, expanded, realKey, selected, selectNode, toggleNode, view } from './state'
import { openUsers } from './users-state'

type SavedBase = { id: string; ns: Namespace; kind: NodeKind; title: string }
export type SavedTab =
  | (SavedBase & {
      type: 'query'
      text: QueryText
      pageSize: number
      resultView: ResultView
      relaxed: boolean
      flattened: string[]
      optionsOpen: boolean
      builderOpen: boolean
    })
  | (SavedBase & {
      type: 'pipeline'
      stages: StageText[]
      selected: number
      previewSize: number
      allowDiskUse: boolean
      pageSize: number
      resultView: ResultView
      /** It had been run: it runs again, unless it writes. */
      ran: boolean
    })
  | (SavedBase & { type: 'document'; docId: JsonValue; readOnly: boolean; docView: DocView })
  | { type: 'manage' | 'schema'; id: string; ns: Namespace; kind: NodeKind }
  | { type: 'database' | 'users'; id: string; connectionId: string; db: string }
  | { type: 'server'; id: string; connectionId: string }
  | { type: 'gridfs'; id: string; connectionId: string; db: string; bucket: string }

export type Layout = { view: string; order: string[]; tabs: SavedTab[]; expanded: string[]; selected: string | null }

const EMPTY: Layout = { view: 'tree', order: [], tabs: [], expanded: [], selected: null }

export const layout = atom<Layout>('mongo-studio.layout', EMPTY, { persist: 'workspace', version: 1 })

/** False until this run has restored the saved layout: saving earlier would overwrite it with an
 *  empty panel. */
let restored = false
let timer: ReturnType<typeof setTimeout> | undefined

function saveColl(t: CollTab): SavedTab | undefined {
  // Shell results live in the worker's run, which the Shell tab reloads on its own.
  if (t.shell) return undefined
  const base = { id: t.id, ns: t.ns, kind: t.kind, title: t.title }
  if (t.docTab) return { ...base, type: 'document', docId: t.docTab.id, readOnly: t.readOnly, docView: t.focus?.view ?? 'tree' }
  if (t.agg) {
    const a = t.agg
    return {
      ...base,
      type: 'pipeline',
      stages: a.stages.map((s) => ({ op: s.op, body: s.body, enabled: s.enabled })),
      selected: Math.max(0, a.stages.findIndex((s) => s.id === a.selected)),
      previewSize: a.previewSize,
      allowDiskUse: a.allowDiskUse,
      pageSize: t.pageSize,
      resultView: t.resultView,
      ran: Boolean(a.ran)
    }
  }
  return {
    ...base,
    type: 'query',
    text: t.text,
    pageSize: t.pageSize,
    resultView: t.resultView,
    relaxed: t.relaxed,
    flattened: t.flattened,
    optionsOpen: t.optionsOpen,
    builderOpen: t.builderOpen
  }
}

function saveAdmin(t: AdminTab): SavedTab | undefined {
  switch (t.kind) {
    case 'manage':
    case 'schema':
      return { type: t.kind, id: t.id, ns: t.ns, kind: t.collKind }
    case 'database':
      return t.isNew ? undefined : { type: 'database', id: t.id, connectionId: t.connectionId, db: t.db }
    case 'users':
      return { type: 'users', id: t.id, connectionId: t.connectionId, db: t.db }
    case 'server':
      return { type: 'server', id: t.id, connectionId: t.connectionId }
    case 'gridfs':
      return { type: 'gridfs', id: t.id, connectionId: t.connectionId, db: t.db, bucket: t.bucket }
    default:
      // Import, export and compare hold jobs and typed input that do not outlive the run.
      return undefined
  }
}

/** The layout as it is now. */
export function currentLayout(): Layout {
  const colls = read(collTabs)
  const admins = read(adminTabs)
  const tabs: SavedTab[] = []
  for (const id of read(tabOrder)) {
    const c = colls[id]
    const a = admins[id]
    const saved = c ? saveColl(c) : a ? saveAdmin(a) : undefined
    if (saved) tabs.push(saved)
  }
  return { view: read(view), order: tabs.map((t) => t.id), tabs, expanded: read(expanded), selected: read(selected) }
}

/** Called after each render of the panel: saves the layout shortly after it settles. */
export function scheduleLayoutSave(): void {
  if (!restored) return
  if (timer !== undefined) clearTimeout(timer)
  timer = setTimeout(() => {
    timer = undefined
    const next = currentLayout()
    if (JSON.stringify(next) !== JSON.stringify(read(layout))) set(layout, next)
  }, 300)
}

function connectionOfKey(key: string): string | undefined {
  const m = /^conn:([^/]+)/.exec(realKey(key))
  return m ? decodeURIComponent(m[1]!) : undefined
}

function connectionOf(t: SavedTab): string {
  return 'ns' in t ? t.ns.connectionId : t.connectionId
}

function restoreColl(t: SavedTab & { type: 'query' | 'pipeline' | 'document' }, open: boolean): Promise<unknown> {
  const tab = newTab(t.id, t.ns, t.kind, t.title)
  if (t.type === 'query') {
    let builder = emptyGroup()
    if (t.builderOpen && t.text.filter.trim()) {
      try {
        builder = filterToBuilder(parseShellDocument(t.text.filter, 'filter', { now: Date.now() })) ?? builder
      } catch {
        // The filter is shown as text with its error when it runs.
      }
    }
    Object.assign(tab, {
      text: { ...t.text },
      pageSize: t.pageSize,
      resultView: t.resultView,
      relaxed: t.relaxed,
      flattened: [...t.flattened],
      optionsOpen: t.optionsOpen,
      builderOpen: t.builderOpen,
      builder
    })
  } else if (t.type === 'pipeline') {
    const stages = cloneStages(t.stages)
    const agg = newAgg(stages)
    const sel = stages[Math.min(t.selected, stages.length - 1)]
    Object.assign(tab, {
      readOnly: true,
      pageSize: t.pageSize,
      resultView: t.resultView,
      agg: { ...agg, ...(sel ? { selected: sel.id } : {}), previewSize: t.previewSize, allowDiskUse: t.allowDiskUse }
    })
  } else {
    Object.assign(tab, { readOnly: t.readOnly, docTab: { id: t.docId }, focus: { ...newFocus(t.docId), view: t.docView } })
  }
  if (!open) {
    if (tab.focus) tab.focus = { ...tab.focus, loading: false }
    tab.notice = { tone: 'neutral', text: 'This connection is not open. Connect to it in Connections, then run again.' }
  }
  update(collTabs, (prev) => ({ ...prev, [t.id]: tab }))
  update(tabOrder, (prev) => [...prev, t.id])
  if (!open) return Promise.resolve()
  if (t.type === 'query') return Promise.all([runQuery(t.id, false), loadLibrary(t.id)])
  if (t.type === 'document') return loadFocus(t.id)
  const { pipeline } = pipelineOf(tab.agg!.stages)
  // A pipeline with $out or $merge never runs again by itself.
  const rerun = t.ran && pipeline !== undefined && !hasWriteStage(pipeline)
  return Promise.all([rerun ? runPipeline(t.id) : refreshPreview(t.id), loadSavedPipelines(t.id)])
}

function restoreAdmin(t: SavedTab): Promise<unknown> {
  switch (t.type) {
    case 'manage':
      return openManage(t.ns, t.kind)
    case 'schema':
      return openSchema(t.ns, t.kind)
    case 'database':
      return openDatabase(t.connectionId, t.db)
    case 'users':
      return openUsers(t.connectionId, t.db)
    case 'server':
      return openServer(t.connectionId)
    case 'gridfs':
      return openGridfs(t.connectionId, t.db, t.bucket)
    default:
      return Promise.resolve()
  }
}

/** Rebuilds the saved layout. Call once per run, after the connections' state has loaded (or
 *  failed to: then every connection counts as closed). */
export async function restoreLayout(): Promise<void> {
  const saved = read(layout)
  const state = read(connections)
  const known = new Set(state?.connections.map((c) => c.id) ?? [])
  const open = new Set(state?.connections.filter((c) => c.connected).map((c) => c.id) ?? [])
  const pending: Promise<unknown>[] = []
  try {
    const existing = new Set(read(tabOrder))
    for (const t of saved.tabs) {
      const conn = connectionOf(t)
      if (!known.has(conn) || existing.has(t.id)) continue
      if (t.type === 'query' || t.type === 'pipeline' || t.type === 'document') pending.push(restoreColl(t, open.has(conn)))
      // Administration tabs read the server as they open: only for open connections.
      else if (open.has(conn)) pending.push(restoreAdmin(t))
    }
    // Openers append in the order they were called and show their tab; put back both.
    const order = read(tabOrder)
    const rank = new Map(saved.order.map((id, i) => [id, i]))
    set(tabOrder, [...order].sort((a, b) => (rank.get(a) ?? Infinity) - (rank.get(b) ?? Infinity)))
    set(view, saved.view === 'tree' || order.includes(saved.view) ? saved.view : 'tree')

    // The tree: open nodes of open connections, parents before children.
    const keys = saved.expanded.filter((k) => {
      const conn = connectionOfKey(k)
      return conn === undefined || open.has(conn)
    })
    const depth = (k: string): number => realKey(k).split('/').length
    for (const d of [...new Set(keys.map(depth))].sort((a, b) => a - b)) {
      await Promise.all(keys.filter((k) => depth(k) === d).map((k) => toggleNode(k, true).catch(() => undefined)))
    }
    const sel = saved.selected
    const selConn = sel === null ? undefined : connectionOfKey(sel)
    if (sel !== null && (selConn === undefined ? true : open.has(selConn))) await selectNode(sel).catch(() => undefined)
  } finally {
    restored = true
  }
  await Promise.all(pending.map((p) => p.catch(() => undefined)))
}

/** For tests: forget that this run restored. */
export function resetLayoutRun(): void {
  restored = false
  if (timer !== undefined) clearTimeout(timer)
  timer = undefined
}
