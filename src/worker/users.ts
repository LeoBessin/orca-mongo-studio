// Users and roles of one database: list them, create, change and drop them. A password reaches
// the server once, in createUser or updateUser, and is never kept or sent back.
import type { Document, MongoClient } from 'mongodb'
import type { DbRef, RoleDraft, RoleInfo, RoleRef, UserDraft, UserInfo, UsersState } from '../protocol'
import { isObject } from '../shared/ejson-view'
import { oneLine } from './admin'
import { invalid, toBson, toCanonical } from './query'

function roleRefs(list: unknown): RoleRef[] {
  return Array.isArray(list) ? (list as Document[]).map((r) => ({ role: String(r.role), db: String(r.db) })) : []
}

export async function listUsers(client: MongoClient, ref: DbRef): Promise<UsersState> {
  const db = client.db(ref.db)
  const [u, r, b] = await Promise.all([
    db.command({ usersInfo: 1, showCustomData: true }),
    db.command({ rolesInfo: 1, showPrivileges: true, showBuiltinRoles: false }),
    db.command({ rolesInfo: 1, showBuiltinRoles: true }).catch(() => ({ roles: [] }))
  ])
  const users = ((u.users ?? []) as Document[]).map((x): UserInfo => {
    const info: UserInfo = { user: String(x.user), db: String(x.db), roles: roleRefs(x.roles), mechanisms: ((x.mechanisms ?? []) as string[]).map(String) }
    if (x.customData && Object.keys(x.customData as Document).length) info.customData = oneLine(x.customData, 2000)
    return info
  })
  const roles = ((r.roles ?? []) as Document[]).map((x): RoleInfo => ({
    role: String(x.role),
    db: String(x.db),
    roles: roleRefs(x.roles),
    privileges: ((x.privileges ?? []) as Document[]).map((p) => toCanonical(p)),
    builtin: x.isBuiltin === true
  }))
  const builtinRoles = ((b.roles ?? []) as Document[]).filter((x) => x.isBuiltin === true).map((x) => String(x.role)).sort()
  return { users: users.sort((a, b) => a.user.localeCompare(b.user)), roles: roles.sort((a, b) => a.role.localeCompare(b.role)), builtinRoles }
}

function checkRoles(roles: RoleRef[]): Document[] {
  if (!Array.isArray(roles)) throw invalid('Roles must be a list.')
  return roles.map((r) => {
    if (!r.role?.trim() || !r.db?.trim()) throw invalid('Each role needs a name and a database.')
    return { role: r.role.trim(), db: r.db.trim() }
  })
}

export async function saveUser(client: MongoClient, ref: DbRef, draft: UserDraft, isNew: boolean): Promise<void> {
  const name = draft.user?.trim()
  if (!name) throw invalid('Give the user a name.')
  const external = ref.db === '$external'
  if (external && draft.password) throw invalid('Users in $external sign in elsewhere (X.509, LDAP, Kerberos, AWS, OIDC) and have no password here.')
  if (isNew && !external && !draft.password) throw invalid('Give the new user a password.')
  const cmd: Document = isNew ? { createUser: name } : { updateUser: name }
  if (draft.password) cmd.pwd = draft.password
  cmd.roles = checkRoles(draft.roles)
  if (draft.customData !== undefined) {
    if (draft.customData !== null && !isObject(draft.customData)) throw invalid('Custom data must be a document.')
    if (draft.customData !== null || !isNew) cmd.customData = draft.customData ? toBson<Document>(draft.customData) : {}
  }
  if (draft.mechanisms?.length) {
    const allowed = ['SCRAM-SHA-1', 'SCRAM-SHA-256']
    const bad = draft.mechanisms.filter((m) => !allowed.includes(m))
    if (bad.length) throw invalid(`Unknown mechanism: ${bad.join(', ')}. Use SCRAM-SHA-1 or SCRAM-SHA-256.`)
    // updateUser takes mechanisms only with a new password.
    if (isNew || draft.password) cmd.mechanisms = draft.mechanisms
  }
  await client.db(ref.db).command(cmd)
}

export async function dropUser(client: MongoClient, ref: DbRef, user: string): Promise<void> {
  if (!user) throw invalid('Name the user to drop.')
  await client.db(ref.db).command({ dropUser: user })
}

export async function saveRole(client: MongoClient, ref: DbRef, draft: RoleDraft, isNew: boolean): Promise<void> {
  const name = draft.role?.trim()
  if (!name) throw invalid('Give the role a name.')
  if (!Array.isArray(draft.privileges)) throw invalid('Privileges must be a list.')
  for (const [i, p] of draft.privileges.entries()) {
    if (!isObject(p) || !isObject(p.resource) || !Array.isArray(p.actions)) throw invalid(`Privilege ${i + 1} needs a resource document and a list of actions, like { resource: { db: 'shop', collection: '' }, actions: ['find'] }.`)
  }
  const cmd: Document = isNew ? { createRole: name } : { updateRole: name }
  cmd.privileges = draft.privileges.map((p) => toBson<Document>(p))
  cmd.roles = checkRoles(draft.roles)
  await client.db(ref.db).command(cmd)
}

export async function dropRole(client: MongoClient, ref: DbRef, role: string): Promise<void> {
  if (!role) throw invalid('Name the role to drop.')
  await client.db(ref.db).command({ dropRole: role })
}
