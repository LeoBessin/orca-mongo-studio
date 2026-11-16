// The Tasks tab: saved imports, exports, copies, compares and syncs, run on demand. A task holds
// the request its tab would send; "Open in its tab" lays that request back into the tab, where it
// can be changed and saved again. Runs are followed like any other job, one per task at a time.
import { atom, plugin, read, set, update } from 'orca'
import type { Namespace, TasksState } from '../protocol'
import { toShellInline } from '../shared/ejson-view'
import { resultSummary, taskDanger, type Task, type TaskRequest } from '../shared/tasks'
import { adminTab, changeAdmin, connectionName, refreshTree, sayAdmin } from './admin-state'
import { compareRequest, compareTabId, openCompare, syncRequest } from './compare-state'
import { cancelJob, dropDownload, followJob, saveDownload, type JobBox } from './data-state'
import { exportRequest, openExport, type ExportFrom } from './export-state'
import { importTabId, importTaskRequest, openImport } from './import-state'
import { errorText, view, type Notice } from './state'

export const TASKS_TAB = 'tasks'

export type TasksUi = {
  selected?: string
  renaming?: { id: string; name: string }
  confirmDelete?: string
  /** Asked before a run that drops, replaces or deletes: what and how many documents. */
  confirmRun?: { id: string; title: string; text: string; count: number | null; exists: boolean }
  notice?: Notice
  /** The run each task has going, or had last in this panel. */
  runs: Record<string, JobBox>
}

export const tasksOpen = atom(false)
export const taskList = atom<Task[] | null>(null)
export const tasksError = atom<string | null>(null)
export const tasksUi = atom<TasksUi>({ runs: {} })

function ui(change: Partial<TasksUi> | ((u: TasksUi) => Partial<TasksUi>)): void {
  update(tasksUi, (u) => ({ ...u, ...(typeof change === 'function' ? change(u) : change) }))
}

export function sayTasks(tone: Notice['tone'], text: string): void {
  ui({ notice: { tone, text } })
}

export function setTasks(state: TasksState): void {
  set(taskList, state.tasks)
  set(tasksError, null)
  const ids = new Set(state.tasks.map((t) => t.id))
  ui((u) => (u.selected && !ids.has(u.selected) ? { selected: undefined, confirmRun: undefined, confirmDelete: undefined, renaming: undefined } : {}))
}

export async function loadTasks(): Promise<void> {
  try {
    setTasks(await plugin.request('tasks.list'))
  } catch (error) {
    set(tasksError, errorText(error))
  }
}

export function openTasks(select?: string): void {
  set(tasksOpen, true)
  set(view, TASKS_TAB)
  if (select) ui({ selected: select, confirmRun: undefined, confirmDelete: undefined, renaming: undefined })
  void loadTasks()
}

export function closeTasks(): void {
  for (const box of Object.values(read(tasksUi).runs)) dropDownload(box)
  set(tasksOpen, false)
  ui({ runs: {} })
  if (read(view) === TASKS_TAB) set(view, 'tree')
}

export function taskById(id: string | undefined): Task | undefined {
  return id ? read(taskList)?.find((t) => t.id === id) : undefined
}

export function selectTask(id: string | undefined): void {
  ui({ selected: id, confirmRun: undefined, confirmDelete: undefined, renaming: undefined })
}

// ---- Running ----

function putRun(id: string, box: JobBox): void {
  ui((u) => ({ runs: { ...u.runs, [id]: box } }))
}

/** Runs a task, asking first when it drops, replaces or deletes (with the document count). */
export async function runTask(id: string, confirmed = false): Promise<void> {
  const task = taskById(id)
  if (!task) return
  const danger = taskDanger(task.request, connectionName)
  if (danger && !confirmed) {
    let count: number | null = null
    let exists = true
    if (danger.ns) {
      const c = await plugin.request('data.count', { ns: danger.ns })
      count = c.count
      exists = c.exists
    }
    // A collection that isn't there yet loses nothing: an import or copy into it just creates it.
    if (danger.ns && !exists && task.request.kind !== 'sync') return runTask(id, true)
    ui({ confirmRun: { id, title: danger.title, text: danger.text, count, exists } })
    return
  }
  ui((u) => {
    dropDownload(u.runs[id])
    return { confirmRun: undefined, notice: undefined }
  })
  const { jobId } = await plugin.request('tasks.run', { id })
  putRun(id, { jobId })
  const end = await followJob(jobId, () => read(tasksUi).runs[id], (box) => putRun(id, box))
  if (end?.status === 'done' && end.result) {
    const touched = writtenTo(task.request)
    if (touched) await refreshTree(touched.connectionId, touched.db)
    sayTasks(end.errorCount ? 'neutral' : 'success', `${task.name}: ${resultSummary(end.result)}`)
  }
}

function writtenTo(r: TaskRequest): { connectionId: string; db: string } | undefined {
  if (r.kind === 'import') return { connectionId: r.ns.connectionId, db: r.ns.db }
  if (r.kind === 'sync') return { connectionId: r.to.connectionId, db: r.to.db }
  if (r.kind === 'export' && r.options.format === 'collection' && r.options.collection) return { connectionId: r.options.collection.connectionId, db: r.options.collection.db }
  return undefined
}

export async function cancelTaskRun(id: string): Promise<void> {
  await cancelJob(read(tasksUi).runs[id])
}

export async function saveTaskDownload(id: string): Promise<void> {
  const box = read(tasksUi).runs[id]
  if (await saveDownload(box)) sayTasks('success', `Saved ${box?.download?.name ?? 'the file'}.`)
}

// ---- Changing the list ----

export function startRename(id: string): void {
  const t = taskById(id)
  if (t) ui({ renaming: { id, name: t.name }, confirmDelete: undefined, confirmRun: undefined })
}

export async function renameTask(id: string, name: string): Promise<void> {
  setTasks(await plugin.request('tasks.rename', { id, name }))
  ui({ renaming: undefined })
}

export async function duplicateTask(id: string): Promise<void> {
  const r = await plugin.request('tasks.duplicate', { id })
  setTasks(r)
  selectTask(r.id)
}

export async function deleteTask(id: string): Promise<void> {
  const name = taskById(id)?.name ?? 'The task'
  setTasks(await plugin.request('tasks.delete', { id }))
  ui((u) => {
    dropDownload(u.runs[id])
    const runs = { ...u.runs }
    delete runs[id]
    return { runs, confirmDelete: undefined, selected: u.selected === id ? undefined : u.selected }
  })
  sayTasks('neutral', `Deleted ${name}.`)
}

// ---- Tabs and tasks ----

const csvDelimiter = (d: string): string => (d === '\t' ? 'tab' : d)
/** Shell text for a one-line field. */
const shellText = (v: unknown): string => (v && typeof v === 'object' && Object.keys(v).length ? toShellInline(v as never) : '')

/** Opens a task's settings in the tab it was saved from, where it can be changed and saved. */
export function openTaskInTab(id: string): void {
  const task = taskById(id)
  if (!task) return
  const r = task.request
  const ref = { id: task.id, name: task.name }
  if (r.kind === 'export') {
    const s = r.source
    const from: ExportFrom = s.kind === 'database' ? { kind: 'database', connectionId: s.connectionId, db: s.db } : s.kind === 'pipeline' ? { kind: 'pipeline', ns: s.ns, pipeline: s.pipeline, options: s.options } : { kind: 'query', ns: s.ns, collKind: 'coll' }
    const query = s.kind === 'query' ? { filter: shellText(s.spec.filter), projection: shellText(s.spec.projection), sort: shellText(s.spec.sort), limit: s.spec.limit ? String(s.spec.limit) : '' } : undefined
    const o = r.options
    openExport(from, query, (t) => ({
      format: o.format,
      ...(o.json ? { json: o.json } : {}),
      ...(o.csv ? { csv: { ...t.csv, fields: o.csv.fields, delimiter: csvDelimiter(o.csv.delimiter), header: o.csv.header } } : {}),
      ...(o.bson ? { bsonMetadata: o.bson.metadata } : {}),
      ...(o.collection ? { target: { connectionId: o.collection.connectionId, db: o.collection.db, collection: o.collection.collection ?? '', mode: o.collection.mode, indexes: o.collection.indexes, options: o.collection.options } } : {}),
      destination: r.destination.kind,
      ...(r.destination.kind === 'path' ? { path: r.destination.path, overwrite: r.destination.overwrite } : {}),
      task: ref,
      taskName: task.name
    }))
    return
  }
  if (r.kind === 'import') {
    openImport({ connectionId: r.ns.connectionId, db: r.ns.db, ...(r.ns.collection ? { collection: r.ns.collection } : {}) })
    const tabId = importTabId(r.ns.connectionId, r.ns.db, r.ns.collection)
    const o = r.options
    changeAdmin(tabId, 'import', () => ({
      sourceKind: 'path',
      path: r.source.path,
      format: o.format,
      ...(o.csv ? { csv: { delimiter: csvDelimiter(o.csv.delimiter), header: o.csv.header, ignoreEmpty: o.csv.ignoreEmpty } } : {}),
      columns: o.csv?.columns ? o.csv.columns.map((c) => ({ ...c, samples: [] })) : undefined,
      mode: o.mode,
      drop: o.drop,
      stopOnError: o.stopOnError,
      indexes: o.indexes,
      preview: undefined,
      stale: true,
      confirmDrop: undefined,
      task: ref,
      taskName: task.name
    }))
    return
  }
  const a: Namespace = r.kind === 'compare' ? r.a : r.from
  const b: Namespace = r.kind === 'compare' ? r.b : r.to
  openCompare(a, 'coll', b)
  const tabId = compareTabId(a)
  changeAdmin(tabId, 'compare', (t) => ({
    b,
    filter: shellText(r.filter),
    filterError: undefined,
    ignore: r.rules.ignoreFields.join(', '),
    ignoreOrder: r.rules.ignoreOrder,
    sync: r.kind === 'sync' ? { ...t.sync, open: true, direction: 'aToB', insert: r.insert, replace: r.replace, remove: r.remove, confirm: false } : t.sync,
    task: { ...ref, kind: r.kind },
    taskName: task.name
  }))
}

type SavableKind = 'export' | 'import' | 'compare' | 'sync'

/** The request a tab would start, as a task saves it. */
function tabRequest(tabId: string, kind: SavableKind): TaskRequest {
  const t = adminTab(tabId)
  if (!t) throw new Error('The tab is closed.')
  if (kind === 'export' && t.kind === 'export') return { kind: 'export', ...exportRequest(t) }
  if (kind === 'import' && t.kind === 'import') return { kind: 'import', ...importTaskRequest(t) }
  if (kind === 'compare' && t.kind === 'compare') return { kind: 'compare', ...compareRequest(tabId) }
  if (kind === 'sync' && t.kind === 'compare') return { kind: 'sync', ...syncRequest(tabId) }
  throw new Error('This tab can\'t be saved as that kind of task.')
}

/**
 * Saves what a tab is set up to do as a task: a new one, or (with `update`) the one the tab came
 * from. The tab remembers the task, so the next save can update it.
 */
export async function saveTabAsTask(tabId: string, kind: SavableKind, update: boolean): Promise<void> {
  const t = adminTab(tabId)
  if (!t || (t.kind !== 'export' && t.kind !== 'import' && t.kind !== 'compare')) return
  const name = t.taskName.trim() || t.task?.name || t.title
  const request = tabRequest(tabId, kind)
  const id = update && t.task && (t.kind !== 'compare' || t.task.kind === kind) ? t.task.id : undefined
  const r = await plugin.request('tasks.save', { ...(id ? { id } : {}), name, request })
  setTasks(r)
  const saved = r.tasks.find((x) => x.id === r.id)
  const ref = { id: r.id, name: saved?.name ?? name }
  if (t.kind === 'export') changeAdmin(tabId, 'export', () => ({ task: ref, taskName: ref.name }))
  if (t.kind === 'import') changeAdmin(tabId, 'import', () => ({ task: ref, taskName: ref.name }))
  if (t.kind === 'compare') changeAdmin(tabId, 'compare', () => ({ task: { ...ref, kind: kind === 'sync' ? 'sync' : 'compare' }, taskName: ref.name }))
  sayAdmin(tabId, 'success', `${id ? 'Updated' : 'Saved'} the task "${ref.name}". Run it again from Saved tasks.`)
}

export function setTaskName(tabId: string, name: string): void {
  const t = adminTab(tabId)
  if (t?.kind === 'export') changeAdmin(tabId, 'export', () => ({ taskName: name }))
  if (t?.kind === 'import') changeAdmin(tabId, 'import', () => ({ taskName: name }))
  if (t?.kind === 'compare') changeAdmin(tabId, 'compare', () => ({ taskName: name }))
}
