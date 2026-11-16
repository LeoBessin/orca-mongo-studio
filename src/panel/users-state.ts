// The Users and roles tab of a database: list them, edit one at a time in a form, drop with a
// confirmation. A typed password lives only in the open form and is cleared once saved.
import { plugin } from 'orca'
import type { RoleRef } from '../protocol'
import { toShell, type JsonObject } from '../shared/ejson-view'
import { parseShell, parseShellDocument, ShellParseError } from '../shared/shell-parse'
import { adminTabId, changeAdmin, refreshTree, sayAdmin, showOrAdd, tabOf, type RoleEditor, type UserEditor, type UsersTab } from './admin-state'
import { errorText } from './state'

export const PRIVILEGE_TEMPLATE = "[\n  { resource: { db: 'shop', collection: 'orders' }, actions: ['find', 'update'] }\n]"

export function usersTabId(connectionId: string, db: string): string {
  return adminTabId('users', [connectionId, db])
}

export async function openUsers(connectionId: string, db: string, focus?: { user?: string; role?: string }): Promise<void> {
  const tab: UsersTab = { id: usersTabId(connectionId, db), kind: 'users', connectionId, title: `Users: ${db}`, db, loading: false }
  const fresh = showOrAdd(tab)
  if (focus) changeAdmin(tab.id, 'users', () => ({ userSelected: focus.user, roleSelected: focus.role }))
  if (fresh) await loadUsers(tab.id)
}

export async function loadUsers(id: string): Promise<void> {
  const t = tabOf(id, 'users')
  if (!t) return
  changeAdmin(id, 'users', () => ({ loading: true }))
  try {
    const state = await plugin.request('users.list', { connectionId: t.connectionId, db: t.db }, { timeoutMs: 30000 })
    changeAdmin(id, 'users', (x) => ({
      state,
      error: undefined,
      userSelected: state.users.some((u) => u.user === x.userSelected) ? x.userSelected : undefined,
      roleSelected: state.roles.some((r) => r.role === x.roleSelected) ? x.roleSelected : undefined
    }))
  } catch (error) {
    changeAdmin(id, 'users', () => ({ error: errorText(error) }))
  } finally {
    changeAdmin(id, 'users', () => ({ loading: false }))
  }
}

export function newUser(id: string): void {
  const t = tabOf(id, 'users')
  if (!t) return
  const editor: UserEditor = { kind: 'user', isNew: true, user: '', password: '', roles: [], customData: '', mechanisms: [], rolesSelected: [], addRole: '', addDb: t.db, saving: false }
  changeAdmin(id, 'users', () => ({ editor, confirmDrop: undefined }))
}

export function editUser(id: string, name: string): void {
  const t = tabOf(id, 'users')
  const u = t?.state?.users.find((x) => x.user === name)
  if (!t || !u) return
  let customData = ''
  if (u.customData) {
    try {
      customData = toShell(JSON.parse(u.customData) as JsonObject)
    } catch {
      customData = u.customData
    }
  }
  const editor: UserEditor = { kind: 'user', isNew: false, user: u.user, password: '', roles: u.roles.map((r) => ({ ...r })), customData, mechanisms: [...u.mechanisms], rolesSelected: [], addRole: '', addDb: t.db, saving: false }
  changeAdmin(id, 'users', () => ({ editor, confirmDrop: undefined }))
}

export function newRole(id: string): void {
  const t = tabOf(id, 'users')
  if (!t) return
  const editor: RoleEditor = { kind: 'role', isNew: true, role: '', privileges: PRIVILEGE_TEMPLATE.replace("'shop'", `'${t.db.replace(/'/g, "\\'")}'`), roles: [], rolesSelected: [], addRole: '', addDb: t.db, saving: false }
  changeAdmin(id, 'users', () => ({ editor, confirmDrop: undefined }))
}

export function editRole(id: string, name: string): void {
  const t = tabOf(id, 'users')
  const r = t?.state?.roles.find((x) => x.role === name)
  if (!t || !r) return
  const editor: RoleEditor = { kind: 'role', isNew: false, role: r.role, privileges: toShell(r.privileges), roles: r.roles.map((x) => ({ ...x })), rolesSelected: [], addRole: '', addDb: t.db, saving: false }
  changeAdmin(id, 'users', () => ({ editor, confirmDrop: undefined }))
}

export function closeEditor(id: string): void {
  changeAdmin(id, 'users', () => ({ editor: undefined }))
}

export function changeEditor(id: string, change: Partial<UserEditor> | Partial<RoleEditor>): void {
  changeAdmin(id, 'users', (t) => (t.editor ? { editor: { ...t.editor, ...change, error: undefined } as UserEditor | RoleEditor } : {}))
}

export function roleKey(r: RoleRef): string {
  return `r:${r.role}@${r.db}`
}

export function addGrantedRole(id: string): void {
  const t = tabOf(id, 'users')
  const e = t?.editor
  if (!t || !e) return
  const role = e.addRole.trim()
  const db = e.addDb.trim() || t.db
  if (!role) return
  if (e.roles.some((r) => r.role === role && r.db === db)) {
    changeEditor(id, { error: `${role}@${db} is in the list already.` })
    return
  }
  changeEditor(id, { roles: [...e.roles, { role, db }], addRole: '' })
}

export function removeGrantedRoles(id: string): void {
  const e = tabOf(id, 'users')?.editor
  if (!e) return
  changeEditor(id, { roles: e.roles.filter((r) => !e.rolesSelected.includes(roleKey(r))), rolesSelected: [] })
}

export async function saveEditor(id: string): Promise<void> {
  const t = tabOf(id, 'users')
  const e = t?.editor
  if (!t || !e) return
  const ref = { connectionId: t.connectionId, db: t.db }
  try {
    if (e.kind === 'user') {
      let customData: JsonObject | null = null
      if (e.customData.trim()) customData = parseShellDocument(e.customData, 'custom data')
      changeEditor(id, { saving: true })
      await plugin.request('users.save', { ...ref, isNew: e.isNew, draft: { user: e.user.trim(), ...(e.password ? { password: e.password } : {}), roles: e.roles, customData, ...(e.mechanisms.length ? { mechanisms: e.mechanisms } : {}) } })
      sayAdmin(id, 'success', e.isNew ? `User ${e.user.trim()} created.` : `User ${e.user}${e.password ? ' and its password' : ''} saved.`)
      changeAdmin(id, 'users', () => ({ editor: undefined, userSelected: e.user.trim() }))
    } else {
      const parsed = e.privileges.trim() ? parseShell(e.privileges) : []
      if (!Array.isArray(parsed)) throw new Error('Privileges are a list: [{ resource: { … }, actions: [ … ] }].')
      changeEditor(id, { saving: true })
      await plugin.request('roles.save', { ...ref, isNew: e.isNew, draft: { role: e.role.trim(), privileges: parsed as JsonObject[], roles: e.roles } })
      sayAdmin(id, 'success', e.isNew ? `Role ${e.role.trim()} created.` : `Role ${e.role} saved.`)
      changeAdmin(id, 'users', () => ({ editor: undefined, roleSelected: e.role.trim() }))
    }
  } catch (error) {
    changeEditor(id, { saving: false })
    changeAdmin(id, 'users', (x) => (x.editor ? { editor: { ...x.editor, error: error instanceof ShellParseError ? error.message : errorText(error) } } : {}))
    return
  }
  await loadUsers(id)
  await refreshTree(t.connectionId, t.db)
}

export async function dropConfirmed(id: string): Promise<void> {
  const t = tabOf(id, 'users')
  const c = t?.confirmDrop
  if (!t || !c) return
  const ref = { connectionId: t.connectionId, db: t.db }
  if (c.kind === 'user') await plugin.request('users.drop', { ...ref, user: c.name })
  else await plugin.request('roles.drop', { ...ref, role: c.name })
  changeAdmin(id, 'users', () => ({ confirmDrop: undefined, editor: undefined }))
  sayAdmin(id, 'success', `${c.kind === 'user' ? 'User' : 'Role'} ${c.name} dropped.`)
  await loadUsers(id)
  await refreshTree(t.connectionId, t.db)
}
