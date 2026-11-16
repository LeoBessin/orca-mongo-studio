// Administration tabs: managing a collection (statistics, indexes, validation, rename, clear and
// drop), a database (create collections, profiler, drop), its users and roles, a server's status
// and current operations, and the Schema Explorer. They sit in the panel's tab row next to the
// collection tabs (`tabOrder`), with their own state in one atom, changed through `changeAdmin`.
import { atom, read, set, update } from 'orca'
import type {
  CollectionInfo,
  CurrentOp,
  CurrentOpsFilter,
  DatabaseInfo,
  IndexList,
  Namespace,
  ProfileEntry,
  ProfilerStatus,
  ServerStatus,
  UsersState,
  ValidationAction,
  ValidationCheck,
  ValidationLevel
} from '../protocol'
import type { IndexDraft } from '../shared/index-spec'
import { nodeTarget, type NodeKind } from '../shared/nodes'
import type { SchemaFlavor, SchemaReport } from '../shared/schema'
import { closeTab, collTabs, tabOrder, type TabNotice } from './collection-state'
import type { CompareTab } from './compare-state'
import type { ExportTab } from './export-state'
import type { GridfsTab } from './gridfs-state'
import type { ImportTab } from './import-state'
import { dropDownload } from './data-state'
import { connections, errorText, nodeIndex, notice, refreshNode, view } from './state'

export type AdminKind = 'manage' | 'database' | 'users' | 'server' | 'schema' | 'import' | 'export' | 'compare' | 'gridfs'

type Base = { id: string; connectionId: string; title: string; notice?: TabNotice }

export type ConfirmAction = 'drop' | 'clear'
export type ManageTab = Base & {
  kind: 'manage'
  ns: Namespace
  collKind: NodeKind
  open: { overview: boolean; indexes: boolean; validation: boolean; operations: boolean }
  info?: CollectionInfo
  infoError?: string
  loading: boolean
  indexes?: IndexList
  indexesError?: string
  indexSelected?: string
  /** The New index form, while open. */
  draft?: IndexDraft
  draftErrors: Partial<Record<string, string>>
  draftMore: boolean
  creating: boolean
  confirmDropIndex?: string
  ttlText?: string
  validation: { text: string; level: ValidationLevel; action: ValidationAction; error?: string; check?: ValidationCheck | 'checking'; loaded: boolean }
  rename: { to: string; toDb: string; dropTarget: boolean }
  cappedSize: string
  confirm?: ConfirmAction
  /** Renaming over a collection that exists: it is dropped first. */
  confirmRename?: { target: string; count: number | null }
}

export type CollectionDraft = {
  name: string
  kind: 'plain' | 'capped' | 'timeseries' | 'clustered'
  size: string
  max: string
  timeField: string
  metaField: string
  granularity: '' | 'seconds' | 'minutes' | 'hours'
  expire: string
  validator: string
  level: ValidationLevel
  action: ValidationAction
  collation: string
}
export type DatabaseTab = Base & {
  kind: 'database'
  db: string
  /** A database not created yet: its name is typed with the first collection. */
  isNew: boolean
  newDb: string
  open: { overview: boolean; create: boolean; profiler: boolean; drop: boolean }
  info?: DatabaseInfo
  infoError?: string
  loading: boolean
  create: CollectionDraft
  createErrors: Partial<Record<string, string>>
  creating: boolean
  profiler?: ProfilerStatus
  profilerError?: string
  profilerDraft: { level: string; slowms: string; sampleRate: string }
  profileFilter: { op: string; minMs: string; ns: string }
  entries?: ProfileEntry[]
  entriesMs?: number
  entrySelected?: string
  reading: boolean
  dropName: string
}

export type UserEditor = {
  kind: 'user'
  isNew: boolean
  user: string
  password: string
  roles: { role: string; db: string }[]
  customData: string
  mechanisms: string[]
  rolesSelected: string[]
  addRole: string
  addDb: string
  error?: string
  saving: boolean
}
export type RoleEditor = {
  kind: 'role'
  isNew: boolean
  role: string
  privileges: string
  roles: { role: string; db: string }[]
  rolesSelected: string[]
  addRole: string
  addDb: string
  error?: string
  saving: boolean
}
export type UsersTab = Base & {
  kind: 'users'
  db: string
  state?: UsersState
  error?: string
  loading: boolean
  userSelected?: string
  roleSelected?: string
  editor?: UserEditor | RoleEditor
  confirmDrop?: { kind: 'user' | 'role'; name: string }
}

export type ServerTab = Base & {
  kind: 'server'
  status?: ServerStatus
  previous?: ServerStatus
  statusError?: string
  loading: boolean
  live: boolean
  /** Bumped when live refresh starts or stops, so an old loop ends. */
  liveToken: number
  opsOpen: boolean
  ops?: CurrentOp[]
  opsCapped: boolean
  opsError?: string
  opsLoading: boolean
  opsFilter: CurrentOpsFilter & { nsText: string; minText: string }
  opSelected?: string
  confirmKill?: string
}

export type SchemaTab = Base & {
  kind: 'schema'
  ns: Namespace
  collKind: NodeKind
  size: number
  filter: string
  filterError?: string
  loading: boolean
  error?: string
  report?: SchemaReport
  expanded: string[]
  selected?: string
  exportOpen: boolean
  flavor: SchemaFlavor
  required: boolean
  closed: boolean
  token: number
}

export type AdminTab = ManageTab | DatabaseTab | UsersTab | ServerTab | SchemaTab | ImportTab | ExportTab | CompareTab | GridfsTab

export const adminTabs = atom<Record<string, AdminTab>>({})

export function adminTab(id: string): AdminTab | undefined {
  return read(adminTabs)[id]
}

export function tabOf<K extends AdminKind>(id: string, kind: K): Extract<AdminTab, { kind: K }> | undefined {
  const t = adminTab(id)
  return t && t.kind === kind ? (t as Extract<AdminTab, { kind: K }>) : undefined
}

export function changeAdmin<K extends AdminKind>(id: string, kind: K, fn: (t: Extract<AdminTab, { kind: K }>) => Partial<Extract<AdminTab, { kind: K }>>): void {
  update(adminTabs, (prev) => {
    const t = prev[id]
    if (!t || t.kind !== kind) return prev
    return { ...prev, [id]: { ...t, ...fn(t as Extract<AdminTab, { kind: K }>) } as AdminTab }
  })
}

export function sayAdmin(id: string, tone: TabNotice['tone'], text: string): void {
  update(adminTabs, (prev) => (prev[id] ? { ...prev, [id]: { ...prev[id]!, notice: { tone, text } } } : prev))
}

/** Runs an action and shows its error in that tab instead of losing it. */
export function aguard(id: string, run: () => Promise<unknown> | unknown): () => Promise<void> {
  return async () => {
    try {
      await run()
    } catch (error) {
      sayAdmin(id, 'danger', errorText(error))
    }
  }
}

/** Letters and digits only (FNV-1a), so tab values stay simple. */
export function adminTabId(kind: AdminKind, parts: readonly string[]): string {
  let h = 0x811c9dc5
  for (const ch of JSON.stringify(parts)) {
    h ^= ch.codePointAt(0)!
    h = Math.imul(h, 0x01000193) >>> 0
  }
  return `adm-${kind}-${h.toString(36)}`
}

export function connectionName(connectionId: string): string {
  return read(connections)?.connections.find((c) => c.id === connectionId)?.name ?? 'Connection'
}

/** Shows the tab if open; otherwise adds it. Answers whether it was new. */
export function showOrAdd(tab: AdminTab): boolean {
  const exists = Boolean(adminTab(tab.id))
  if (!exists) {
    update(adminTabs, (prev) => ({ ...prev, [tab.id]: tab }))
    update(tabOrder, (prev) => [...prev, tab.id])
  }
  set(view, tab.id)
  return !exists
}

export function closeAdmin(id: string): void {
  const t = adminTab(id)
  if (t?.kind === 'server') changeAdmin(id, 'server', (s) => ({ live: false, liveToken: s.liveToken + 1 }))
  // A running job keeps going in the worker; its tab just stops following it.
  if (t?.kind === 'export') dropDownload(t.job)
  if (t?.kind === 'gridfs') dropDownload(t.download.job)
  const order = read(tabOrder)
  const at = order.indexOf(id)
  const rest = order.filter((x) => x !== id)
  set(tabOrder, rest)
  update(adminTabs, (prev) => {
    const next = { ...prev }
    delete next[id]
    return next
  })
  if (read(view) === id) set(view, rest[Math.min(at, rest.length - 1)] ?? 'tree')
}

/** Closes every tab of a connection: admin tabs here, collection tabs in collection-state. */
export function closeAdminTabsFor(connectionId: string): void {
  for (const id of Object.keys(read(adminTabs))) if (adminTab(id)?.connectionId === connectionId) closeAdmin(id)
}

function sameNs(a: Namespace, b: Namespace): boolean {
  return a.connectionId === b.connectionId && a.db === b.db && a.collection === b.collection
}

/** After a drop or rename: closes the tabs that show that collection (or, with no collection,
 *  every collection of that database). `keep` stays open. */
export function closeTabsForNs(ns: Namespace | { connectionId: string; db: string }, keep?: string): void {
  const matches = (other: Namespace): boolean => ('collection' in ns ? sameNs(other, ns) : other.connectionId === ns.connectionId && other.db === ns.db)
  for (const id of [...read(tabOrder)]) {
    if (id === keep) continue
    const c = read(collTabs)[id]
    if (c && matches(c.ns)) closeTab(id)
    const a = adminTab(id)
    if (a && 'ns' in a && matches(a.ns)) closeAdmin(id)
    if (a && !('collection' in ns) && 'db' in a && a.connectionId === ns.connectionId && a.db === ns.db) closeAdmin(id)
  }
}

/** The tree's key for a connection or database. */
export function treeKeyOf(connectionId: string, db?: string): string {
  const conn = `conn:${encodeURIComponent(connectionId)}`
  return db === undefined ? conn : `${conn}/db:${encodeURIComponent(db)}`
}

/** Reloads the tree under a database (or a connection) if it is open. */
export async function refreshTree(connectionId: string, db?: string): Promise<void> {
  await refreshNode(treeKeyOf(connectionId, db)).catch(() => undefined)
}

/** Goes back to the Connections tab with a message there. */
export function backToTree(tone: TabNotice['tone'], text: string): void {
  set(view, 'tree')
  set(notice, { tone, text })
}

/** What a tree node points at, for the tree's action bar. */
export function nodeNamespace(nodeKey: string): { ns?: Namespace; db?: string; connectionId?: string; kind: NodeKind } {
  const t = nodeTarget(nodeKey)
  const kind = read(nodeIndex)[nodeKey]?.kind ?? t.kind
  const out: { ns?: Namespace; db?: string; connectionId?: string; kind: NodeKind } = { kind }
  if (t.connectionId) out.connectionId = t.connectionId
  if (t.db) out.db = t.db
  if (t.connectionId && t.db && t.collection) out.ns = { connectionId: t.connectionId, db: t.db, collection: t.collection }
  return out
}

export const numberText = (n: number): string => n.toLocaleString('en-US')
