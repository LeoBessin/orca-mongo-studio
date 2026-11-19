// The Manage tab of a collection: statistics, the index manager, validation rules, and rename,
// make capped, clear and drop. Destructive actions ask first, naming the namespace and its count.
import { plugin } from 'orca'
import type { Namespace, ValidationAction, ValidationLevel } from '../protocol'
import { isObject, toShell, type JsonObject } from '../shared/ejson-view'
import { buildIndex, emptyIndexDraft, type IndexDraft, type IndexKeyRow } from '../shared/index-spec'
import type { NodeKind } from '../shared/nodes'
import { parseShellDocument, ShellParseError } from '../shared/shell-parse'
import {
  adminTabId,
  backToTree,
  changeAdmin,
  closeTabsForNs,
  numberText,
  refreshTree,
  sayAdmin,
  showOrAdd,
  tabOf,
  type ManageTab
} from './admin-state'
import { nsLabel } from './collection-state'
import { settings } from './settings-state'
import { errorText } from './state'

export type ManageSection = keyof ManageTab['open']

export function manageTabId(ns: Namespace): string {
  return adminTabId('manage', [ns.connectionId, ns.db, ns.collection])
}

function newManageTab(ns: Namespace, collKind: NodeKind): ManageTab {
  return {
    id: manageTabId(ns),
    kind: 'manage',
    connectionId: ns.connectionId,
    title: ns.collection,
    ns,
    collKind,
    open: { overview: true, indexes: true, validation: false, operations: false },
    loading: false,
    draftErrors: {},
    draftMore: false,
    creating: false,
    validation: { text: '', level: 'strict', action: 'error', loaded: false },
    rename: { to: '', toDb: '', dropTarget: false },
    cappedSize: ''
  }
}

/** Opens (or shows) a collection's Manage tab, with a section open and an index selected. */
export async function openManage(ns: Namespace, collKind: NodeKind, focus?: { section?: ManageSection; index?: string; validator?: string }): Promise<void> {
  const fresh = showOrAdd(newManageTab(ns, collKind))
  const id = manageTabId(ns)
  if (focus?.section) changeAdmin(id, 'manage', (t) => ({ open: { ...t.open, [focus.section!]: true } }))
  if (focus?.index) changeAdmin(id, 'manage', () => ({ indexSelected: focus.index }))
  if (fresh) await loadManage(id)
  if (focus?.validator !== undefined) changeAdmin(id, 'manage', (t) => ({ validation: { ...t.validation, text: focus.validator!, check: undefined, error: undefined, loaded: true } }))
}

export async function loadManage(id: string): Promise<void> {
  const t = tabOf(id, 'manage')
  if (!t) return
  changeAdmin(id, 'manage', () => ({ loading: true }))
  const ns = t.ns
  const [info, indexes] = await Promise.allSettled([plugin.request('admin.collection', { ns }, { timeoutMs: 30000 }), t.collKind === 'view' ? Promise.resolve(undefined) : plugin.request('admin.indexes', { ns }, { timeoutMs: 30000 })])
  changeAdmin(id, 'manage', (x) => {
    const out: Partial<ManageTab> = { loading: false }
    if (info.status === 'fulfilled') {
      out.info = info.value
      out.infoError = undefined
      // The editor keeps what the person typed; it takes the server's rules only when untouched.
      if (!x.validation.loaded) {
        out.validation = { ...x.validation, text: info.value.validator ? toShell(info.value.validator) : '', level: info.value.validationLevel, action: info.value.validationAction, loaded: true }
      }
    } else out.infoError = errorText(info.reason)
    if (indexes.status === 'fulfilled') {
      if (indexes.value) {
        out.indexes = indexes.value
        if (x.indexSelected && !indexes.value.indexes.some((i) => i.name === x.indexSelected)) out.indexSelected = undefined
      }
      out.indexesError = undefined
    } else out.indexesError = errorText(indexes.reason)
    return out
  })
}

export function toggleSection(id: string, section: ManageSection, open: boolean): void {
  changeAdmin(id, 'manage', (t) => ({ open: { ...t.open, [section]: open } }))
}

// ---- Indexes ----

export function selectIndex(id: string, name: string | undefined): void {
  changeAdmin(id, 'manage', (t) => ({ indexSelected: name, confirmDropIndex: undefined, ttlText: name ? t.indexes?.indexes.find((i) => i.name === name)?.ttl?.toString() : undefined }))
}

export function newIndex(id: string): void {
  changeAdmin(id, 'manage', () => ({ draft: emptyIndexDraft(), draftErrors: {}, draftMore: false }))
}

export function cancelIndex(id: string): void {
  changeAdmin(id, 'manage', () => ({ draft: undefined, draftErrors: {} }))
}

export function editDraft(id: string, change: Partial<IndexDraft>): void {
  changeAdmin(id, 'manage', (t) => {
    if (!t.draft) return {}
    const errors = { ...t.draftErrors }
    for (const k of Object.keys(change)) delete errors[k]
    return { draft: { ...t.draft, ...change }, draftErrors: errors }
  })
}

export function editKey(id: string, rowId: string, change: Partial<IndexKeyRow>): void {
  changeAdmin(id, 'manage', (t) => {
    if (!t.draft) return {}
    const errors = { ...t.draftErrors }
    delete errors.keys
    return { draft: { ...t.draft, keys: t.draft.keys.map((r) => (r.id === rowId ? { ...r, ...change } : r)) }, draftErrors: errors }
  })
}

export function addKey(id: string): void {
  changeAdmin(id, 'manage', (t) => {
    if (!t.draft) return {}
    const n = Math.max(0, ...t.draft.keys.map((r) => Number(r.id.slice(1)) || 0)) + 1
    return { draft: { ...t.draft, keys: [...t.draft.keys, { id: `k${n}`, field: '', kind: '1' }] } }
  })
}

export function removeKey(id: string, rowId: string): void {
  changeAdmin(id, 'manage', (t) => (t.draft && t.draft.keys.length > 1 ? { draft: { ...t.draft, keys: t.draft.keys.filter((r) => r.id !== rowId) } } : {}))
}

export async function createIndexFromDraft(id: string): Promise<void> {
  const t = tabOf(id, 'manage')
  if (!t?.draft) return
  const built = buildIndex(t.draft)
  if (!built.key) {
    changeAdmin(id, 'manage', () => ({ draftErrors: built.errors, draftMore: t.draftMore || Boolean(built.errors.collation || built.errors.wildcardProjection || built.errors.weights || built.errors.defaultLanguage || built.errors.languageOverride || built.errors.extra) }))
    return
  }
  changeAdmin(id, 'manage', () => ({ creating: true }))
  try {
    const { name } = await plugin.request('admin.createIndex', { ns: t.ns, key: built.key, options: built.options! }, { timeoutMs: 120000 })
    changeAdmin(id, 'manage', () => ({ draft: undefined, draftErrors: {}, indexSelected: name }))
    sayAdmin(id, 'success', `Index ${name} created.`)
    await loadManage(id)
    await refreshTree(t.connectionId, t.ns.db)
  } catch (error) {
    const timeout = (error as { code?: string }).code === 'timeout'
    sayAdmin(id, 'danger', timeout ? 'The index is still building on the server after 2 minutes. Refresh later to see it.' : errorText(error))
  } finally {
    changeAdmin(id, 'manage', () => ({ creating: false }))
  }
}

export async function setIndexHidden(id: string, name: string, hidden: boolean): Promise<void> {
  const t = tabOf(id, 'manage')
  if (!t) return
  await plugin.request('admin.modifyIndex', { ns: t.ns, name, hidden })
  sayAdmin(id, 'success', hidden ? `${name} is hidden: the planner no longer uses it, and it stays up to date.` : `${name} is visible to the planner again.`)
  await loadManage(id)
}

export async function saveTtl(id: string, name: string): Promise<void> {
  const t = tabOf(id, 'manage')
  if (!t) return
  const text = (t.ttlText ?? '').trim()
  if (!/^\d+$/.test(text)) {
    sayAdmin(id, 'danger', 'TTL is a whole number of seconds.')
    return
  }
  await plugin.request('admin.modifyIndex', { ns: t.ns, name, expireAfterSeconds: Number(text) })
  sayAdmin(id, 'success', `Documents now expire ${numberText(Number(text))} s after ${name}'s date.`)
  await loadManage(id)
}

/** Manage tabs with a drop or clear running: pressing again meanwhile does nothing. */
const busy = new Set<string>()

async function once(id: string, run: () => Promise<void>): Promise<void> {
  if (busy.has(id)) return
  busy.add(id)
  try {
    await run()
  } finally {
    busy.delete(id)
  }
}

/** Asks before dropping an index, or drops it at once when Settings says not to ask: then no
 *  confirmation shows, so nothing on screen can cancel or repeat it while it runs, or linger if
 *  it fails. */
export function askDropIndex(id: string, name: string): Promise<void> {
  if (!settings().confirmDrop) return dropIndex(id, name)
  changeAdmin(id, 'manage', () => ({ confirmDropIndex: name }))
  return Promise.resolve()
}

export function dropIndexConfirmed(id: string): Promise<void> {
  const name = tabOf(id, 'manage')?.confirmDropIndex
  return name ? dropIndex(id, name) : Promise.resolve()
}

function dropIndex(id: string, name: string): Promise<void> {
  return once(id, async () => {
    const t = tabOf(id, 'manage')
    if (!t) return
    await plugin.request('admin.dropIndex', { ns: t.ns, name })
    changeAdmin(id, 'manage', () => ({ confirmDropIndex: undefined, indexSelected: undefined }))
    sayAdmin(id, 'success', `Index ${name} dropped.`)
    await loadManage(id)
    await refreshTree(t.connectionId, t.ns.db)
  })
}

// ---- Validation ----

export function setValidation(id: string, change: Partial<{ text: string; level: ValidationLevel; action: ValidationAction }>): void {
  changeAdmin(id, 'manage', (t) => ({ validation: { ...t.validation, ...change, error: change.text !== undefined ? undefined : t.validation.error, loaded: true } }))
}

function parseValidator(text: string): { validator?: JsonObject | null; error?: string } {
  if (!text.trim()) return { validator: null }
  try {
    const v = parseShellDocument(text, 'validator')
    return { validator: Object.keys(v).length ? v : null }
  } catch (error) {
    return { error: error instanceof ShellParseError ? error.message : errorText(error) }
  }
}

export async function saveValidation(id: string): Promise<void> {
  const t = tabOf(id, 'manage')
  if (!t) return
  const { validator, error } = parseValidator(t.validation.text)
  if (error) {
    changeAdmin(id, 'manage', (x) => ({ validation: { ...x.validation, error } }))
    return
  }
  await plugin.request('admin.setValidation', { ns: t.ns, validator: validator ?? null, level: t.validation.level, action: t.validation.action })
  sayAdmin(id, 'success', validator ? `Validation rules saved (${t.validation.level}, ${t.validation.action}).` : 'Validation rules removed.')
  changeAdmin(id, 'manage', (x) => ({ validation: { ...x.validation, loaded: false } }))
  await loadManage(id)
}

export async function checkValidation(id: string): Promise<void> {
  const t = tabOf(id, 'manage')
  if (!t) return
  const { validator, error } = parseValidator(t.validation.text)
  if (error || !validator) {
    changeAdmin(id, 'manage', (x) => ({ validation: { ...x.validation, error: error ?? 'Write a validator to check.' } }))
    return
  }
  changeAdmin(id, 'manage', (x) => ({ validation: { ...x.validation, check: 'checking' } }))
  try {
    const check = await plugin.request('admin.checkValidation', { ns: t.ns, validator }, { timeoutMs: 60000 })
    changeAdmin(id, 'manage', (x) => ({ validation: { ...x.validation, check } }))
  } catch (e) {
    changeAdmin(id, 'manage', (x) => ({ validation: { ...x.validation, check: undefined } }))
    throw e
  }
}

// ---- Rename, capped, clear, drop ----

export function setRename(id: string, change: Partial<ManageTab['rename']>): void {
  changeAdmin(id, 'manage', (t) => ({ rename: { ...t.rename, ...change }, confirmRename: undefined }))
}

/** Renames; over a collection that exists ("Replace…"), asks first with its document count. */
export async function renameCollection(id: string, confirmed = false): Promise<void> {
  const t = tabOf(id, 'manage')
  if (!t) return
  const to = t.rename.to.trim()
  const toDb = t.rename.toDb.trim() || t.ns.db
  if (!to) return
  if (t.rename.dropTarget && !confirmed) {
    const c = await plugin.request('data.count', { ns: { connectionId: t.connectionId, db: toDb, collection: to } })
    if (c.exists) {
      changeAdmin(id, 'manage', () => ({ confirmRename: { target: `${toDb}.${to}`, count: c.count } }))
      return
    }
  }
  changeAdmin(id, 'manage', () => ({ confirmRename: undefined }))
  await plugin.request('admin.renameCollection', { ns: t.ns, to, ...(toDb !== t.ns.db ? { toDb } : {}), dropTarget: t.rename.dropTarget })
  const from = nsLabel(t.ns)
  closeTabsForNs(t.ns)
  await refreshTree(t.connectionId, t.ns.db)
  if (toDb !== t.ns.db) await refreshTree(t.connectionId, toDb)
  const next: Namespace = { connectionId: t.connectionId, db: toDb, collection: to }
  await openManage(next, t.collKind, { section: 'operations' })
  sayAdmin(manageTabId(next), 'success', `${from} is now ${nsLabel(next)}.`)
}

export async function convertToCapped(id: string): Promise<void> {
  const t = tabOf(id, 'manage')
  if (!t) return
  const size = Number(t.cappedSize.trim())
  if (!Number.isInteger(size) || size < 4096) {
    sayAdmin(id, 'danger', 'A capped collection is at least 4096 bytes.')
    return
  }
  await plugin.request('admin.convertToCapped', { ns: t.ns, size }, { timeoutMs: 120000 })
  sayAdmin(id, 'success', `${nsLabel(t.ns)} is capped at ${numberText(size)} bytes.`)
  await loadManage(id)
  await refreshTree(t.connectionId, t.ns.db)
}

/** Asks before dropping or clearing the collection, or goes ahead at once when Settings says not
 *  to ask (with no confirmation shown, as for an index). `undefined` cancels. */
export function askConfirm(id: string, confirm: ManageTab['confirm']): Promise<void> {
  if (confirm && !settings().confirmDrop) return clearOrDrop(id, confirm)
  changeAdmin(id, 'manage', () => ({ confirm }))
  return Promise.resolve()
}

export function confirmed(id: string): Promise<void> {
  const kind = tabOf(id, 'manage')?.confirm
  return kind ? clearOrDrop(id, kind) : Promise.resolve()
}

function clearOrDrop(id: string, kind: NonNullable<ManageTab['confirm']>): Promise<void> {
  return once(id, () => clearOrDropNow(id, kind))
}

async function clearOrDropNow(id: string, kind: NonNullable<ManageTab['confirm']>): Promise<void> {
  const t = tabOf(id, 'manage')
  if (!t) return
  const what = nsLabel(t.ns)
  if (kind === 'clear') {
    const { deleted } = await plugin.request('admin.clearCollection', { ns: t.ns }, { timeoutMs: 120000 })
    changeAdmin(id, 'manage', () => ({ confirm: undefined }))
    sayAdmin(id, 'success', `Deleted ${numberText(deleted)} document${deleted === 1 ? '' : 's'} from ${what}. Its indexes and options stay.`)
    await loadManage(id)
    await refreshTree(t.connectionId, t.ns.db)
    return
  }
  await plugin.request('admin.dropCollection', { ns: t.ns }, { timeoutMs: 60000 })
  closeTabsForNs(t.ns)
  await refreshTree(t.connectionId, t.ns.db)
  backToTree('neutral', `${what} was dropped${t.collKind === 'view' ? '' : ', with its documents and indexes'}.`)
}

/** The count a confirmation names: what the statistics said last. */
export function countText(t: ManageTab): string {
  const n = t.info?.count
  return typeof n === 'number' ? `${numberText(n)} document${n === 1 ? '' : 's'}` : 'all its documents'
}

export function shellValidator(v: JsonObject | null): string {
  return v && isObject(v) ? toShell(v) : ''
}

export const COLL_KIND_LABEL: Record<string, string> = { collection: 'Collection', view: 'View', timeseries: 'Time series' }

export function readonlyReason(t: ManageTab): string | undefined {
  if (t.collKind === 'view' || t.info?.kind === 'view') return 'A view has no indexes or validation of its own.'
  return undefined
}

export function isTimeseries(t: ManageTab): boolean {
  return t.collKind === 'timeseries' || t.info?.kind === 'timeseries'
}
