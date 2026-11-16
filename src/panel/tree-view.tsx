// Connections tab: the tree, its filter and favourites, and the actions and details for the
// selected node. Orca's components have no context menu, so a node's actions sit in a bar under
// the tree, and every connection-level action is also in the command palette.
import {
  Box,
  Button,
  Callout,
  CodeView,
  EmptyState,
  IconButton,
  Input,
  KeyValue,
  Link,
  read,
  Row,
  set,
  Skeleton,
  Text,
  Toolbar,
  Tree,
  update,
  type IconName,
  type OrcaNode,
  type TreeItem
} from 'orca'
import type { ConnectionSummary, TreeNode } from '../protocol'
import { parseNodeKey, type NodeKind } from '../shared/nodes'
import { closeAdminTabsFor, nodeNamespace } from './admin-state'
import { openAggregationForNode } from './aggregate-state'
import { openDatabase, openNewDatabase } from './database-state'
import { openManage } from './manage-state'
import { openSchema } from './schema-state'
import { openServer } from './server-state'
import { openUsers } from './users-state'
import { closeTabsFor, openCollection } from './collection-state'
import {
  busy,
  children,
  collapsedRoots,
  FAV_PREFIX,
  GROUP_PREFIX,
  realKey,
  cloneConnection,
  confirmDelete,
  connect,
  connections,
  deleteConnection,
  details,
  disconnect,
  expanded,
  filter,
  nodeIndex,
  notice,
  oidc,
  openEditConnection,
  openNewConnection,
  refreshNode,
  refreshState,
  renameGroup,
  renamingGroup,
  selected,
  selectNode,
  toggleFavourite,
  toggleNode,
  view
} from './state'

const ICONS: Record<NodeKind, IconName> = {
  group: 'folder',
  conn: 'database',
  db: 'layers',
  coll: 'file-text',
  view: 'filter',
  timeseries: 'activity',
  bucket: 'package',
  indexes: 'zap',
  index: 'zap',
  users: 'agent',
  user: 'agent',
  roles: 'flag',
  role: 'flag',
  message: 'info'
}


function nodeItem(node: TreeNode): TreeItem {
  const item: TreeItem = { key: node.key, label: node.label, icon: ICONS[node.kind] }
  if (node.description) item.description = node.description
  if (node.disabled) item.disabled = true
  if (node.hasChildren) {
    const loaded = read(children)[node.key]
    if (loaded?.status === 'ok') item.children = loaded.nodes.map(nodeItem)
    else if (loaded?.status === 'error') item.children = [errorItem(node.key, loaded.message)]
    else item.hasChildren = true
  }
  return item
}

function errorItem(parent: string, message: string): TreeItem {
  return { key: `${parent}/message:error`, label: message, icon: 'error', disabled: true }
}

function connectionItem(c: ConnectionSummary): TreeItem {
  return nodeItem({
    key: `conn:${encodeURIComponent(c.id)}`,
    kind: 'conn',
    label: c.name,
    description: c.connected ? `${c.subtitle} · connected` : c.subtitle,
    hasChildren: true
  })
}

/** Keeps items whose label matches, and the parents of those that do. */
function filterItems(items: readonly TreeItem[], text: string): TreeItem[] {
  if (!text) return [...items]
  const needle = text.toLowerCase()
  const out: TreeItem[] = []
  for (const item of items) {
    const kids = item.children ? filterItems(item.children, text) : []
    if (item.label.toLowerCase().includes(needle) || kids.length) {
      out.push(item.children ? { ...item, children: kids.length ? kids : item.children } : item)
    }
  }
  return out
}

function treeItems(): TreeItem[] {
  const state = read(connections)
  if (!state) return []
  const items: TreeItem[] = []
  if (state.favourites.length) {
    items.push({
      key: 'favourites',
      label: 'Favourites',
      icon: 'star',
      description: String(state.favourites.length),
      children: state.favourites.map((f) => ({ key: `${FAV_PREFIX}${f.key}`, label: f.label, description: f.path, icon: ICONS[f.kind] }))
    })
  }
  const groups = [...new Set(state.connections.map((c) => c.group).filter(Boolean))].sort((a, b) => a.localeCompare(b))
  for (const g of groups) {
    const members = state.connections.filter((c) => c.group === g)
    items.push({ key: `${GROUP_PREFIX}${encodeURIComponent(g)}`, label: g, icon: 'folder', description: String(members.length), children: members.map(connectionItem) })
  }
  items.push(...state.connections.filter((c) => !c.group).map(connectionItem))
  return filterItems(items, read(filter).trim())
}


function connectionIdOf(key: string): string | null {
  const m = /^conn:([^/]+)/.exec(key)
  return m ? decodeURIComponent(m[1]!) : null
}

function act(run: () => Promise<void>): () => Promise<void> {
  return async () => {
    try {
      await run()
    } catch (error) {
      set(notice, { tone: 'danger', text: error instanceof Error ? error.message : String(error) })
    }
  }
}

function actionBar(key: string): OrcaNode {
  const state = read(connections)
  if (key.startsWith(GROUP_PREFIX)) {
    const group = decodeURIComponent(key.slice(GROUP_PREFIX.length))
    const renaming = read(renamingGroup)
    if (renaming) {
      return (
        <Row gap="xs" align="end">
          <Input label="Group name" value={renaming.to} onChange={(to) => set(renamingGroup, { from: group, to })} onSubmit={(to) => act(() => renameGroup(group, to))()} />
          <Button variant="solid" tone="accent" onPress={act(() => renameGroup(group, renaming.to))}>Rename</Button>
          <Button variant="ghost" onPress={() => set(renamingGroup, null)}>Cancel</Button>
        </Row>
      )
    }
    return (
      <Toolbar label="Group actions" gap="xs">
        <Button size="sm" icon="add" onPress={() => openNewConnection(group)}>New connection here</Button>
        <Button size="sm" icon="edit" variant="ghost" onPress={() => set(renamingGroup, { from: group, to: group })}>Rename group</Button>
        <Button size="sm" icon="remove" variant="ghost" onPress={act(() => renameGroup(group, ''))}>Ungroup</Button>
      </Toolbar>
    )
  }
  const real = realKey(key)
  const meta = read(nodeIndex)[real]
  const id = connectionIdOf(real)
  if (!meta || !id) return null
  const isFavourite = state?.favourites.some((f) => f.key === real) ?? false
  const favourite = meta.kind === 'conn' || meta.kind === 'message' ? null : (
    <IconButton icon="star" label={isFavourite ? 'Remove from favourites' : 'Add to favourites'} variant={isFavourite ? 'solid' : 'ghost'} tone={isFavourite ? 'accent' : 'neutral'} size="sm" onPress={act(() => toggleFavourite(real))} />
  )
  const refresh = <IconButton icon="refresh" label="Refresh" variant="ghost" size="sm" onPress={act(() => refreshNode(real))} />
  if (meta.kind === 'conn') {
    const summary = state?.connections.find((c) => c.id === id)
    const connected = summary?.connected ?? false
    return (
      <Toolbar label="Connection actions" gap="xs">
        {connected ? (
          <Button size="sm" icon="stop" onPress={act(() => disconnect(id))}>Disconnect</Button>
        ) : (
          <Button size="sm" icon="play" variant="solid" tone="accent" disabled={read(busy) === real} onPress={act(() => connect(id))}>
            {read(busy) === real ? 'Connecting…' : 'Connect'}
          </Button>
        )}
        <IconButton icon="edit" label="Edit connection" variant="ghost" size="sm" onPress={act(() => openEditConnection(id))} />
        <IconButton icon="copy" label="Clone connection" variant="ghost" size="sm" onPress={act(() => cloneConnection(id))} />
        {connected ? refresh : null}
        {connected ? <IconButton icon="gauge" label="Server status and operations" variant="ghost" size="sm" onPress={act(() => openServer(id))} /> : null}
        {connected ? <IconButton icon="add" label="New database" variant="ghost" size="sm" onPress={act(async () => openNewDatabase(id))} /> : null}
        <IconButton icon="delete" label="Delete connection" variant="ghost" tone="danger" size="sm" onPress={() => set(confirmDelete, { id, name: summary?.name ?? '' })} />
      </Toolbar>
    )
  }
  const openable = meta.kind === 'coll' || meta.kind === 'view' || meta.kind === 'timeseries'
  const target = nodeNamespace(real)
  const ns = target.ns
  const collKind = (): NodeKind => parseNodeKey(real).find((s) => s.kind === 'coll' || s.kind === 'timeseries')?.kind ?? 'coll'
  if (meta.kind === 'db' && target.db) {
    const db = target.db
    return (
      <Toolbar label={`${meta.label} actions`} gap="xs">
        <Button size="sm" icon="settings" variant="solid" tone="accent" onPress={act(() => openDatabase(id, db))}>Manage</Button>
        <Button size="sm" icon="agent" variant="ghost" onPress={act(() => openUsers(id, db))}>Users</Button>
        {refresh}
        {favourite}
      </Toolbar>
    )
  }
  if ((meta.kind === 'indexes' || meta.kind === 'index') && ns) {
    const index = meta.kind === 'index' ? meta.label : undefined
    return (
      <Toolbar label={`${meta.label} actions`} gap="xs">
        <Button size="sm" icon="settings" variant="solid" tone="accent" onPress={act(() => openManage(ns, collKind(), { section: 'indexes', ...(index ? { index } : {}) }))}>Manage indexes</Button>
        {refresh}
        {favourite}
      </Toolbar>
    )
  }
  if ((meta.kind === 'users' || meta.kind === 'user' || meta.kind === 'roles' || meta.kind === 'role') && target.db) {
    const db = target.db
    const focus = meta.kind === 'user' ? { user: meta.label } : meta.kind === 'role' ? { role: meta.label } : undefined
    return (
      <Toolbar label={`${meta.label} actions`} gap="xs">
        <Button size="sm" icon="agent" variant="solid" tone="accent" onPress={act(() => openUsers(id, db, focus))}>Manage users and roles</Button>
        {refresh}
        {favourite}
      </Toolbar>
    )
  }
  return (
    <Toolbar label={`${meta.label} actions`} gap="xs">
      {openable ? (
        <Button size="sm" icon="open-external" variant="solid" tone="accent" onPress={act(() => openCollection(real))}>
          {meta.kind === 'view' ? 'Open view' : 'Open'}
        </Button>
      ) : null}
      {openable ? (
        <Button size="sm" icon="layers" variant="ghost" onPress={act(() => openAggregationForNode(real))}>
          Aggregate
        </Button>
      ) : null}
      {openable && ns ? <IconButton icon="settings" label={meta.kind === 'view' ? 'Manage the view' : 'Manage the collection: indexes, validation, rename, drop'} variant="ghost" size="sm" onPress={act(() => openManage(ns, meta.kind))} /> : null}
      {openable && ns ? <IconButton icon="bar-chart-3" label="Schema: sample the fields and their types" variant="ghost" size="sm" onPress={act(() => openSchema(ns, meta.kind))} /> : null}
      {refresh}
      {favourite}
    </Toolbar>
  )
}

function isOpenable(key: string): boolean {
  const kind = read(nodeIndex)[key]?.kind
  return kind === 'coll' || kind === 'view' || kind === 'timeseries'
}

function detailsBlock(): OrcaNode {
  const d = read(details)
  const key = read(selected)
  if (!d || !key || d.key !== realKey(key)) return null
  if (d.status === 'loading') return <Skeleton lines={4} label="Loading details" />
  if (d.status === 'error') return <Callout tone="danger" icon="error">{d.error}</Callout>
  const data = d.data!
  return (
    <Box gap="sm">
      <Box gap="none">
        <Text weight="semibold" truncate>{data.title}</Text>
        <Text muted size="xs">{data.subtitle}</Text>
      </Box>
      {data.items.length ? <KeyValue label={`${data.title} details`} items={data.items} /> : null}
      {data.json ? <CodeView label={data.subtitle === 'Connection' ? 'Connection string' : 'Definition'} code={data.json} language={data.subtitle === 'Connection' ? 'text' : 'json'} wrap maxHeight="md" /> : null}
    </Box>
  )
}

export function TreeView(): OrcaNode {
  const state = read(connections)
  const sel = read(selected)
  const pending = read(confirmDelete)
  const sign = read(oidc)
  const n = read(notice)
  return (
    <Box gap="sm">
      <Toolbar label="Connections">
        <IconButton icon="add" label="New connection" variant="solid" tone="accent" onPress={() => openNewConnection()} />
        <IconButton icon="upload" label="Import connections" onPress={() => set(view, 'transfer')} />
        <IconButton icon="download" label="Export connections" onPress={() => set(view, 'transfer')} />
        <IconButton icon="refresh" label="Refresh all" onPress={act(async () => {
          await refreshState()
          for (const key of read(expanded)) if (/^conn:[^/]+$/.test(key)) await refreshNode(key)
        })} />
      </Toolbar>
      {state?.secretsProtection === 'unavailable' ? (
        <Callout tone="warning" icon="warning" title="Secrets are not saved">
          Orca can't encrypt secrets on this computer, so passwords and keys are kept only until the plugin stops. Set up your system keyring to save them.
        </Callout>
      ) : null}
      {sign ? (
        <Callout tone="accent" icon="link" title={`Sign in to ${sign.name}`}>
          <Link href={sign.url}>Open the sign-in page</Link> in your browser. Mongo Studio connects once you have signed in.
        </Callout>
      ) : null}
      {n ? (
        <Callout tone={n.tone === 'neutral' ? 'neutral' : n.tone} icon={n.tone === 'danger' ? 'error' : 'check'}>
          <Row justify="between" align="center">
            <Text>{n.text}</Text>
            <IconButton icon="close" label="Dismiss" variant="ghost" size="xs" onPress={() => set(notice, null)} />
          </Row>
        </Callout>
      ) : null}
      {!state ? (
        <Skeleton lines={5} label="Loading connections" />
      ) : state.connections.length === 0 ? (
        <EmptyState icon="database" title="No connections yet" description="Add a MongoDB server or Atlas cluster, or import connection strings or a Compass export.">
          <Row gap="xs" justify="center">
            <Button variant="solid" tone="accent" icon="add" onPress={() => openNewConnection()}>New connection</Button>
            <Button icon="upload" onPress={() => set(view, 'transfer')}>Import</Button>
          </Row>
        </EmptyState>
      ) : (
        <Box gap="sm">
          <Input label="Filter" labelHidden type="search" placeholder="Filter loaded connections, databases and collections" value={read(filter)} onChange={(v) => set(filter, v)} />
          <Tree
            label="Connections"
            items={treeItems()}
            expanded={[...read(expanded), ...rootKeys().filter((k) => !read(collapsedRoots).includes(k))]}
            {...(sel ? { selected: sel } : {})}
            maxHeight="lg"
            onToggle={({ key, expanded: open }) => {
              if (rootKeys().includes(key)) update(collapsedRoots, (prev) => (open ? prev.filter((k) => k !== key) : [...prev, key]))
              else void act(() => toggleNode(key, open))()
            }}
            onSelect={({ key }) => void act(() => selectNode(key))()}
            onAction={({ key }) => {
              const real = realKey(key)
              const id = connectionIdOf(real)
              if (/^conn:[^/]+$/.test(real) && id) void act(() => connect(id))()
              else if (isOpenable(real)) void act(() => openCollection(real))()
              else void act(() => toggleNode(real, !read(expanded).includes(real)))()
            }}
          />
          {sel ? actionBar(sel) : <Text muted size="xs">Select a connection or collection to see its actions and details. Enter connects, or opens a collection.</Text>}
          {pending ? (
            <Callout tone="danger" icon="warning" title={`Delete "${pending.name}"?`}>
              <Box gap="sm">
                <Text>The connection and its saved passwords and keys are removed. Your databases are not touched.</Text>
                <Row gap="xs">
                  <Button variant="solid" tone="danger" onPress={act(async () => {
                    closeTabsFor(pending.id)
                    closeAdminTabsFor(pending.id)
                    await deleteConnection(pending.id)
                  })}>Delete connection</Button>
                  <Button variant="ghost" onPress={() => set(confirmDelete, null)}>Cancel</Button>
                </Row>
              </Box>
            </Callout>
          ) : null}
          {detailsBlock()}
        </Box>
      )}
    </Box>
  )
}

/** Favourites and group rows: open unless the person closed them. */
function rootKeys(): string[] {
  const state = read(connections)
  if (!state) return []
  return ['favourites', ...new Set(state.connections.filter((c) => c.group).map((c) => `${GROUP_PREFIX}${encodeURIComponent(c.group)}`))]
}
