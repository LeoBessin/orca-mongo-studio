// The Users and roles tab: two tables, actions on the selected row, and one editor at a time.
import {
  Box,
  Button,
  Callout,
  Card,
  Checkbox,
  CodeView,
  IconButton,
  Input,
  KeyValue,
  read,
  Row,
  Select,
  Skeleton,
  Table,
  Text,
  Textarea,
  Toolbar,
  type OrcaNode
} from 'orca'
import { toShell } from '../shared/ejson-view'
import { adminTabs, aguard, changeAdmin, closeAdmin, connectionName, isReadOnly, type RoleEditor, type UserEditor, type UsersTab } from './admin-state'
import { NoticeBar } from './admin-notice'
import { addGrantedRole, changeEditor, closeEditor, dropConfirmed, editRole, editUser, loadUsers, newRole, newUser, removeGrantedRoles, roleKey, saveEditor } from './users-state'

const refs = (roles: { role: string; db: string }[], db: string): string => roles.map((r) => (r.db === db ? r.role : `${r.role}@${r.db}`)).join(', ') || 'none'

function GrantedRoles({ t, e }: { t: UsersTab; e: UserEditor | RoleEditor }): OrcaNode {
  const custom = t.state?.roles.map((r) => r.role) ?? []
  const builtin = t.state?.builtinRoles ?? []
  const options = [
    ...custom.map((r) => ({ value: r, label: `${r} (custom)` })),
    ...builtin.map((r) => ({ value: r, label: r }))
  ]
  return (
    <Box gap="xs">
      <Text weight="medium">{e.kind === 'user' ? 'Roles' : 'Inherits from'}</Text>
      <Table
        label={e.kind === 'user' ? 'Granted roles' : 'Inherited roles'}
        columns={[
          { key: 'role', label: 'Role' },
          { key: 'db', label: 'Database', width: 'sm' }
        ]}
        rows={e.roles.map((r) => ({ key: roleKey(r), cells: { role: r.role, db: r.db } }))}
        selectionMode="multiple"
        selected={e.rolesSelected}
        emptyText={e.kind === 'user' ? 'No roles: the user can sign in but do nothing.' : 'Inherits nothing.'}
        maxHeight="sm"
        onSelectionChange={({ keys }) => changeEditor(t.id, { rolesSelected: keys })}
      />
      <Row gap="xs" align="end" wrap>
        <Select label="Role" labelHidden value={options.some((o) => o.value === e.addRole) ? e.addRole : ''} placeholder="Choose a role…" options={options} onChange={(addRole) => changeEditor(t.id, { addRole })} />
        <Input label="Role name" labelHidden placeholder="or type a role" value={e.addRole} onChange={(addRole) => changeEditor(t.id, { addRole })} />
        <Input label="On database" labelHidden placeholder={t.db} value={e.addDb} onChange={(addDb) => changeEditor(t.id, { addDb })} />
      </Row>
      <Row gap="xs">
        <Button size="sm" icon="add" disabled={!e.addRole.trim()} onPress={() => addGrantedRole(t.id)}>Add role</Button>
        <Button size="sm" icon="remove" variant="ghost" disabled={!e.rolesSelected.length} onPress={() => removeGrantedRoles(t.id)}>Remove selected</Button>
      </Row>
      {e.kind === 'role' && t.db !== 'admin' ? <Text size="xs" muted>{`A role in ${t.db} inherits only roles of ${t.db}; roles in admin may inherit from any database.`}</Text> : null}
    </Box>
  )
}

function UserForm({ t, e }: { t: UsersTab; e: UserEditor }): OrcaNode {
  const external = t.db === '$external'
  return (
    <Card title={e.isNew ? 'New user' : `User ${e.user}`} description={`In ${t.db}`}>
      <Box gap="sm">
        {e.isNew ? <Input label="Name" value={e.user} onChange={(user) => changeEditor(t.id, { user })} /> : null}
        {external ? (
          <Text size="xs" muted>Users in $external sign in elsewhere (X.509, LDAP, Kerberos, AWS, OIDC): name them as that system does, without a password.</Text>
        ) : (
          <Input label={e.isNew ? 'Password' : 'New password'} type="password" placeholder={e.isNew ? '' : 'Leave empty to keep the password'} value={e.password} onChange={(password) => changeEditor(t.id, { password })} />
        )}
        <GrantedRoles t={t} e={e} />
        <Textarea label="Custom data" rows={3} placeholder="{ team: 'ops' }" value={e.customData} onChange={(customData) => changeEditor(t.id, { customData })} />
        {external ? null : (
          <Box gap="xs">
            <Row gap="sm">
              {['SCRAM-SHA-256', 'SCRAM-SHA-1'].map((m) => (
                <Checkbox key={m} label={m} checked={e.mechanisms.includes(m)} onChange={(on) => changeEditor(t.id, { mechanisms: on ? [...e.mechanisms, m] : e.mechanisms.filter((x) => x !== m) })} />
              ))}
            </Row>
            <Text size="xs" muted>{e.isNew ? 'None checked: the server\'s defaults.' : 'Mechanisms change only with a new password.'}</Text>
          </Box>
        )}
        {e.error ? <Text size="xs" tone="danger">{e.error}</Text> : null}
        <Row gap="xs">
          <Button variant="solid" tone="accent" icon="check" disabled={e.saving} onPress={aguard(t.id, () => saveEditor(t.id))}>{e.saving ? 'Saving…' : e.isNew ? 'Create user' : 'Save user'}</Button>
          <Button variant="ghost" onPress={() => closeEditor(t.id)}>Cancel</Button>
        </Row>
      </Box>
    </Card>
  )
}

function RoleForm({ t, e }: { t: UsersTab; e: RoleEditor }): OrcaNode {
  return (
    <Card title={e.isNew ? 'New role' : `Role ${e.role}`} description={`In ${t.db}`}>
      <Box gap="sm">
        {e.isNew ? <Input label="Name" value={e.role} onChange={(role) => changeEditor(t.id, { role })} /> : null}
        <Textarea label="Privileges" rows={8} value={e.privileges} onChange={(privileges) => changeEditor(t.id, { privileges })} />
        <Text size="xs" muted>A list of {'{ resource, actions }'} in shell syntax. collection: '' means every collection of the database; {'{ cluster: true }'} is the whole server.</Text>
        <GrantedRoles t={t} e={e} />
        {e.error ? <Text size="xs" tone="danger">{e.error}</Text> : null}
        <Row gap="xs">
          <Button variant="solid" tone="accent" icon="check" disabled={e.saving} onPress={aguard(t.id, () => saveEditor(t.id))}>{e.saving ? 'Saving…' : e.isNew ? 'Create role' : 'Save role'}</Button>
          <Button variant="ghost" onPress={() => closeEditor(t.id)}>Cancel</Button>
        </Row>
      </Box>
    </Card>
  )
}

export function UsersTabView({ id }: { id: string }): OrcaNode {
  const t = read(adminTabs)[id]
  if (!t || t.kind !== 'users') return null
  const s = t.state
  const user = s?.users.find((u) => u.user === t.userSelected)
  const role = s?.roles.find((r) => r.role === t.roleSelected)
  const c = t.confirmDrop
  const ro = isReadOnly(t.connectionId)
  return (
    <Box gap="sm">
      <Row gap="xs" align="center" justify="between">
        <Box gap="none" grow>
          <Text weight="semibold" truncate>{`Users and roles in ${t.db}`}</Text>
          <Text size="xs" muted truncate>{connectionName(t.connectionId)}</Text>
        </Box>
        <IconButton icon="close" label={`Close users and roles of ${t.db}`} variant="ghost" size="sm" onPress={() => closeAdmin(t.id)} />
      </Row>
      <Toolbar label="Users and roles actions" gap="xs">
        {ro ? null : <Button size="sm" icon="add" onPress={() => newUser(t.id)}>New user</Button>}
        {ro ? null : <Button size="sm" icon="add" variant="ghost" onPress={() => newRole(t.id)}>New role</Button>}
        <IconButton icon="refresh" label="Refresh" size="sm" variant="ghost" disabled={t.loading} onPress={aguard(t.id, () => loadUsers(t.id))} />
      </Toolbar>
      <NoticeBar id={t.id} notice={t.notice} />
      {t.error ? <Callout tone="danger" icon="error" title="Could not list users and roles">{t.error}</Callout> : null}
      {!s && !t.error ? <Skeleton lines={4} label="Loading users and roles" /> : null}
      {t.editor?.kind === 'user' ? <UserForm t={t} e={t.editor} /> : null}
      {t.editor?.kind === 'role' ? <RoleForm t={t} e={t.editor} /> : null}
      {c ? (
        <Callout tone="danger" icon="warning" title={`Drop ${c.kind} ${c.name} from ${t.db}?`}>
          <Box gap="sm">
            <Text>{c.kind === 'user' ? 'The user can no longer sign in, and its open sessions lose their rights.' : 'Users and roles that have it lose its privileges.'}</Text>
            <Row gap="xs">
              <Button variant="solid" tone="danger" onPress={aguard(t.id, () => dropConfirmed(t.id))}>{c.kind === 'user' ? 'Drop user' : 'Drop role'}</Button>
              <Button variant="ghost" onPress={() => changeAdmin(t.id, 'users', () => ({ confirmDrop: undefined }))}>Cancel</Button>
            </Row>
          </Box>
        </Callout>
      ) : null}
      {s ? (
        <Box gap="sm">
          <Text weight="semibold">Users</Text>
          <Table
            label="Users"
            columns={[
              { key: 'user', label: 'User', width: 'md' },
              { key: 'roles', label: 'Roles' },
              { key: 'mech', label: 'Sign-in', hideBelow: 'md' }
            ]}
            rows={s.users.map((u) => ({ key: `u:${u.user}`, cells: { user: u.user, roles: refs(u.roles, t.db), mech: u.mechanisms.join(', ') || 'external' } }))}
            selectionMode="single"
            selected={user ? [`u:${user.user}`] : []}
            emptyText={`No users in ${t.db}.`}
            maxHeight="sm"
            onSelectionChange={({ keys }) => changeAdmin(t.id, 'users', () => ({ userSelected: keys[0]?.slice(2), confirmDrop: undefined }))}
            onRowAction={({ key }) => (ro ? undefined : editUser(t.id, key.slice(2)))}
          />
          {user ? (
            <Box gap="xs">
              {ro ? null : (
                <Toolbar label={`${user.user} actions`} gap="xs">
                  <Button size="sm" icon="edit" onPress={() => editUser(t.id, user.user)}>Edit</Button>
                  <Button size="sm" icon="delete" variant="ghost" tone="danger" onPress={() => changeAdmin(t.id, 'users', () => ({ confirmDrop: { kind: 'user', name: user.user } }))}>Drop</Button>
                </Toolbar>
              )}
              <KeyValue label={`${user.user} details`} items={[{ label: 'Roles', value: refs(user.roles, '') }, { label: 'Sign-in', value: user.mechanisms.join(', ') || 'external' }, ...(user.customData ? [{ label: 'Custom data', value: user.customData, code: true }] : [])]} />
            </Box>
          ) : null}
          <Text weight="semibold">Custom roles</Text>
          <Table
            label="Custom roles"
            columns={[
              { key: 'role', label: 'Role', width: 'md' },
              { key: 'privileges', label: 'Privileges', width: 'sm' },
              { key: 'inherits', label: 'Inherits', hideBelow: 'sm' }
            ]}
            rows={s.roles.map((r) => ({ key: `r:${r.role}`, cells: { role: r.role, privileges: r.privileges.length, inherits: refs(r.roles, t.db) } }))}
            selectionMode="single"
            selected={role ? [`r:${role.role}`] : []}
            emptyText={`No custom roles in ${t.db}. Built-in roles such as read and readWrite are always there.`}
            maxHeight="sm"
            onSelectionChange={({ keys }) => changeAdmin(t.id, 'users', () => ({ roleSelected: keys[0]?.slice(2), confirmDrop: undefined }))}
            onRowAction={({ key }) => (ro ? undefined : editRole(t.id, key.slice(2)))}
          />
          {role ? (
            <Box gap="xs">
              {ro ? null : (
                <Toolbar label={`${role.role} actions`} gap="xs">
                  <Button size="sm" icon="edit" onPress={() => editRole(t.id, role.role)}>Edit</Button>
                  <Button size="sm" icon="delete" variant="ghost" tone="danger" onPress={() => changeAdmin(t.id, 'users', () => ({ confirmDrop: { kind: 'role', name: role.role } }))}>Drop</Button>
                </Toolbar>
              )}
              <CodeView label={`${role.role} privileges`} code={toShell(role.privileges)} language="javascript" maxHeight="sm" />
            </Box>
          ) : null}
        </Box>
      ) : null}
    </Box>
  )
}
