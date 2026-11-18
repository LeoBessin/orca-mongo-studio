// Panel state and the actions that change it. The worker owns all data; atoms here hold what the
// panel shows and the edits in progress. Secrets typed into the form live only in `formSecrets`
// until saved, and the worker never sends them back.
import { atom, derived, plugin, read, set, update } from 'orca'
import type { ConnectionsState, NodeDetails, TestReport, TreeNode } from '../protocol'
import {
  cloneDef,
  emptyConnection,
  type ConnectionDef,
  type FieldError,
  type SecretDraft,
  type SecretFlags
} from '../shared/model'
import { normalizeGroup } from '../shared/groups'
import type { NodeKind } from '../shared/nodes'
import { buildConnectionString, ConnectionStringError, parseConnectionString } from '../shared/uri'

/** `tree`, `form`, `transfer`, or a collection tab's id. */
export type View = string
export type ChildState = { status: 'loading' } | { status: 'ok'; nodes: TreeNode[] } | { status: 'error'; message: string }
export type Notice = { tone: 'success' | 'danger' | 'neutral'; text: string }

export const connections = atom<ConnectionsState | null>(null)
export const view = atom<View>('tree')
/** Each saved group (trimmed, sorted) with the ids of its connections. Derived once per
 *  `connections` change, not on every render of the tree or the connection form. */
export const savedGroups = derived(() => {
  const members = new Map<string, string[]>()
  for (const c of read(connections)?.connections ?? []) {
    const name = normalizeGroup(c.group)
    if (name) members.set(name, [...(members.get(name) ?? []), c.id])
  }
  return [...members.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([name, ids]) => ({ name, ids }))
})
export const children = atom<Record<string, ChildState>>({})
/** Node metadata by key, so actions know a selected node's kind and label. */
export const nodeIndex = atom<Record<string, { kind: NodeKind; label: string; path: string }>>({})
export const expanded = atom<string[]>([])
export const selected = atom<string | null>(null)
export const details = atom<{ key: string; status: 'loading' | 'ok' | 'error'; data?: NodeDetails; error?: string } | null>(null)
export const filter = atom('')
export const confirmDelete = atom<{ id: string; name: string } | null>(null)
export const renamingGroup = atom<{ from: string; to: string } | null>(null)
export const notice = atom<Notice | null>(null)
export const oidc = atom<{ connectionId: string; name: string; url: string } | null>(null)
export const busy = atom<string | null>(null)

// Connection form
export const formDef = atom<ConnectionDef | null>(null)
export const formIsNew = atom(true)
export const formSecrets = atom<SecretDraft>({})
export const formFlags = atom<SecretFlags>({})
export const formErrors = atom<FieldError[]>([])
export const formMode = atom<'form' | 'uri'>('mongo-studio.formMode', 'form', { persist: 'plugin' })
export const uriText = atom('')
export const uriProblem = atom<{ error?: string; warnings: string[] }>({ warnings: [] })
export const testReport = atom<TestReport | null>(null)
export const testing = atom(false)
export const saving = atom(false)

// Import / export
export const importText = atom('')
export const importResult = atom<import('../protocol').ImportReport | null>(null)
export const exportSelection = atom<string[] | null>(null)
export const exportJson = atom<{ json: string; count: number; tasks: number } | null>(null)
/** Saved tasks that use only the chosen connections go into the file too. */
export const exportTasks = atom<boolean>(true)

export function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function say(tone: Notice['tone'], text: string): void {
  set(notice, { tone, text })
}

export const FAV_PREFIX = 'fav/'
export const GROUP_PREFIX = 'group:'
/** Favourites and group rows open by default; this lists the ones the person closed. */
export const collapsedRoots = atom<string[]>('mongo-studio.collapsedRoots', [], { persist: 'plugin' })

/** Favourite rows point at real nodes; actions and details use those. */
export function realKey(key: string): string {
  return key.startsWith(FAV_PREFIX) ? key.slice(FAV_PREFIX.length) : key
}

export function setConnections(state: ConnectionsState): void {
  set(connections, state)
  remember(state.connections.map((c) => ({ key: `conn:${encodeURIComponent(c.id)}`, kind: 'conn' as const, label: c.name })), '')
  update(nodeIndex, (prev) => {
    const next = { ...prev }
    for (const f of state.favourites) if (!next[f.key]) next[f.key] = { kind: f.kind, label: f.label, path: f.path }
    return next
  })
}

export async function refreshState(): Promise<void> {
  setConnections(await plugin.request('connections.state'))
}

export function remember(nodes: readonly { key: string; kind: NodeKind; label: string }[], path: string): void {
  update(nodeIndex, (prev) => {
    const next = { ...prev }
    for (const n of nodes) next[n.key] = { kind: n.kind, label: n.label, path }
    return next
  })
}

function setChild(key: string, value: ChildState): void {
  update(children, (prev) => ({ ...prev, [key]: value }))
}

export async function loadChildren(key: string): Promise<void> {
  setChild(key, { status: 'loading' })
  try {
    const { nodes } = await plugin.request('tree.children', { key }, { timeoutMs: 60000 })
    const parent = read(nodeIndex)[key]
    remember(nodes, parent ? `${parent.path} › ${parent.label}` : '')
    setChild(key, { status: 'ok', nodes })
  } catch (error) {
    setChild(key, { status: 'error', message: errorText(error) })
  }
}

/** Forgets loaded children under `key` (and `key` itself), then reloads it if it is open. */
export async function refreshNode(key: string): Promise<void> {
  update(children, (prev) => Object.fromEntries(Object.entries(prev).filter(([k]) => k !== key && !k.startsWith(`${key}/`))))
  if (read(expanded).includes(key)) await loadChildren(key)
  if (isSelected(key)) await loadDetails(key)
}

export async function toggleNode(key: string, open: boolean): Promise<void> {
  update(expanded, (prev) => (open ? [...new Set([...prev, key])] : prev.filter((k) => k !== key)))
  const loaded = read(children)[key]
  if (open && (!loaded || loaded.status === 'error')) await loadChildren(key)
}

function isSelected(key: string): boolean {
  const sel = read(selected)
  return sel !== null && realKey(sel) === key
}

export async function loadDetails(key: string): Promise<void> {
  const meta = read(nodeIndex)[key]
  if (!meta || meta.kind === 'group' || meta.kind === 'message') {
    set(details, null)
    return
  }
  set(details, { key, status: 'loading' })
  try {
    const data = await plugin.request('tree.details', { key }, { timeoutMs: 30000 })
    if (isSelected(key)) set(details, { key, status: 'ok', data })
  } catch (error) {
    if (isSelected(key)) set(details, { key, status: 'error', error: errorText(error) })
  }
}

export async function selectNode(key: string): Promise<void> {
  set(selected, key)
  set(confirmDelete, null)
  set(renamingGroup, null)
  await loadDetails(realKey(key))
}

export async function connect(id: string): Promise<void> {
  const key = `conn:${encodeURIComponent(id)}`
  set(busy, key)
  try {
    await toggleNode(key, true)
    const state = read(children)[key]
    if (state?.status === 'error') say('danger', state.message)
  } finally {
    set(busy, null)
  }
  if (isSelected(key)) await loadDetails(key)
}

export async function disconnect(id: string): Promise<void> {
  const key = `conn:${encodeURIComponent(id)}`
  await plugin.request('connections.disconnect', { id })
  update(expanded, (prev) => prev.filter((k) => k !== key && !k.startsWith(`${key}/`)))
  update(children, (prev) => Object.fromEntries(Object.entries(prev).filter(([k]) => k !== key && !k.startsWith(`${key}/`))))
  if (isSelected(key)) await loadDetails(key)
}

export async function cloneConnection(id: string): Promise<void> {
  const { id: copy } = await plugin.request('connections.clone', { id })
  await refreshState()
  await selectNode(`conn:${encodeURIComponent(copy)}`)
  say('success', 'Connection cloned, with its saved secrets.')
}

export async function deleteConnection(id: string): Promise<void> {
  await plugin.request('connections.delete', { id })
  set(confirmDelete, null)
  set(selected, null)
  set(details, null)
  await refreshState()
  say('neutral', 'Connection deleted, with its saved passwords and keys.')
}

export async function toggleFavourite(key: string): Promise<void> {
  const meta = read(nodeIndex)[key]
  if (!meta) return
  const { favourites } = await plugin.request('favourites.toggle', { key, label: meta.label, kind: meta.kind, path: meta.path })
  update(connections, (prev) => (prev ? { ...prev, favourites } : prev))
}

export async function renameGroup(from: string, to: string): Promise<void> {
  await plugin.request('connections.renameGroup', { from, to })
  set(renamingGroup, null)
  await refreshState()
}

// ---- Form ----

function syncUri(def: ConnectionDef): void {
  set(uriText, buildConnectionString(def))
  set(uriProblem, { warnings: [] })
}

export function openNewConnection(group = ''): void {
  const def = emptyConnection('', Date.now())
  def.group = group
  set(formDef, def)
  set(formIsNew, true)
  set(formSecrets, {})
  set(formFlags, {})
  set(formErrors, [])
  set(testReport, null)
  syncUri(def)
  set(view, 'form')
}

export async function openEditConnection(id: string): Promise<void> {
  const { def, secrets } = await plugin.request('connections.get', { id })
  set(formDef, def)
  set(formIsNew, false)
  set(formSecrets, {})
  set(formFlags, secrets)
  set(formErrors, [])
  set(testReport, null)
  syncUri(def)
  set(view, 'form')
}

export function closeForm(): void {
  set(formDef, null)
  set(formSecrets, {})
  set(testReport, null)
  set(view, 'tree')
}

/** Changes the draft; the URI view follows. */
export function edit(change: (def: ConnectionDef) => void): void {
  const current = read(formDef)
  if (!current) return
  const next = cloneDef(current)
  change(next)
  set(formDef, next)
  syncUri(next)
}

/** Changes a field a connection string can't express (name, group, read only). It leaves the
 *  URI text alone, so in Connection string mode a half-typed string isn't replaced. */
export function editMeta(change: (def: ConnectionDef) => void): void {
  const current = read(formDef)
  if (!current) return
  const next = cloneDef(current)
  change(next)
  set(formDef, next)
}

export function setSecret(key: keyof SecretDraft, value: string | null): void {
  update(formSecrets, (prev) => ({ ...prev, [key]: value }))
}

/** URI mode: parse what was typed into the draft, keeping what a URI can't express. */
export function editUri(text: string): void {
  set(uriText, text)
  const current = read(formDef)
  if (!current) return
  try {
    const parsed = parseConnectionString(text, current.id, current.createdAt)
    const next = parsed.def
    next.name = current.name
    next.group = current.group
    next.readOnly = current.readOnly
    next.ssh = current.ssh
    if (next.tls.ca.kind === 'none' && current.tls.ca.kind === 'inline') next.tls.ca = current.tls.ca
    if (next.tls.clientCert.kind === 'none' && current.tls.clientCert.kind === 'inline') next.tls.clientCert = current.tls.clientCert
    if (!/[?&]appName=/i.test(text)) next.options.appName = current.options.appName
    set(formDef, next)
    update(formSecrets, (prev) => ({ ...prev, ...parsed.secrets }))
    set(uriProblem, { warnings: parsed.warnings })
  } catch (error) {
    set(uriProblem, { error: error instanceof ConnectionStringError ? error.message : errorText(error), warnings: [] })
  }
}

export async function runTest(): Promise<void> {
  const def = read(formDef)
  if (!def) return
  set(testing, true)
  set(testReport, null)
  try {
    const input = { def, secrets: read(formSecrets), ...(def.id ? { id: def.id } : {}) }
    const report = await plugin.request('connections.test', input, { timeoutMs: 120000 })
    set(testReport, report)
    if (report.sshHostKey) edit((d) => (d.ssh.knownHostKey = report.sshHostKey ?? ''))
  } catch (error) {
    set(testReport, { ok: false, steps: [{ id: 'handshake', title: 'Test connection', status: 'failed', ms: 0, detail: errorText(error) }] })
  } finally {
    set(testing, false)
    set(oidc, null)
  }
}

export async function saveForm(): Promise<void> {
  const def = read(formDef)
  if (!def) return
  set(saving, true)
  try {
    const result = await plugin.request('connections.save', { def, secrets: read(formSecrets) })
    if (!result.ok) {
      set(formErrors, result.errors)
      return
    }
    const wasNew = read(formIsNew)
    closeForm()
    await refreshState()
    const key = `conn:${encodeURIComponent(result.id)}`
    await refreshNode(key)
    await selectNode(key)
    say('success', wasNew ? 'Connection saved.' : 'Connection updated. It reconnects with the new settings.')
  } catch (error) {
    set(formErrors, [{ field: 'form', message: errorText(error) }])
  } finally {
    set(saving, false)
  }
}

export async function forgetHostKey(id: string): Promise<void> {
  await plugin.request('connections.forgetHostKey', { id })
  edit((d) => (d.ssh.knownHostKey = ''))
}

// ---- Import / export ----

export async function runImport(): Promise<void> {
  try {
    const report = await plugin.request('connections.import', { text: read(importText) })
    set(importResult, report)
    if (report.imported.length) set(importText, '')
    await refreshState()
    await refreshExport()
  } catch (error) {
    set(importResult, { imported: [], errors: [errorText(error)] })
  }
}

export async function refreshExport(): Promise<void> {
  const ids = read(exportSelection)
  set(exportJson, await plugin.request('connections.export', { ...(ids ? { ids } : {}), tasks: read(exportTasks) }))
}
