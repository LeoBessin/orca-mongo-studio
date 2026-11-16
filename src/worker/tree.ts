// Loads the connection tree one level at a time, with counts and sizes, and the details shown when
// a node is selected. Permission errors fall back to what the user can see instead of failing.
import { BSON, type Db, type Document, type MongoClient } from 'mongodb'
import type { DetailItem, NodeDetails, TreeNode } from '../protocol'
import { AUTH_LABELS, TOPOLOGY_LABELS, type ConnectionDef } from '../shared/model'
import { childKey, formatBytes, formatCount, nodeTarget, type NodeKind } from '../shared/nodes'
import { buildConnectionString, hostLabel } from '../shared/uri'
import { formatHostKey } from './ssh'

const { EJSON } = BSON
const STATS_TIMEOUT_MS = 3000

function json(value: unknown): string {
  return EJSON.stringify(value, undefined, 2, { relaxed: true })
}

async function mapLimit<T, R>(items: readonly T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length)
  let next = 0
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const i = next++
      out[i] = await fn(items[i]!)
    }
  })
  await Promise.all(workers)
  return out
}

type CollStats = { count?: number; size?: number; storageSize?: number; avgObjSize?: number; nindexes?: number; totalIndexSize?: number; indexSizes?: Record<string, number>; capped?: boolean }

async function collStats(db: Db, name: string): Promise<CollStats | undefined> {
  try {
    const [row] = await db
      .collection(name)
      .aggregate([{ $collStats: { storageStats: {} } }], { maxTimeMS: STATS_TIMEOUT_MS })
      .toArray()
    return (row?.storageStats as CollStats | undefined) ?? undefined
  } catch {
    return undefined
  }
}

function collDescription(stats: CollStats | undefined): string | undefined {
  if (!stats) return undefined
  const parts = []
  if (typeof stats.count === 'number') parts.push(formatCount(stats.count, 'doc'))
  if (typeof stats.size === 'number') parts.push(formatBytes(stats.size))
  if (stats.capped) parts.push('capped')
  return parts.join(' · ') || undefined
}

function indexFlags(spec: Document): string[] {
  const flags: string[] = []
  const values = Object.values((spec.key ?? {}) as Record<string, unknown>)
  for (const v of values) {
    if (typeof v === 'string' && !flags.includes(v)) flags.push(v)
  }
  if (spec.unique) flags.push('unique')
  if (spec.sparse) flags.push('sparse')
  if (spec.hidden) flags.push('hidden')
  if (spec.partialFilterExpression) flags.push('partial')
  if (typeof spec.expireAfterSeconds === 'number') flags.push(`TTL ${spec.expireAfterSeconds}s`)
  if (spec.collation) flags.push(`collation ${String((spec.collation as Document).locale ?? '')}`)
  if (String(spec.name).includes('$**') || Object.keys((spec.key ?? {}) as object).some((k) => k.includes('$**'))) flags.push('wildcard')
  return flags
}

export type TreeContext = {
  client(id: string): Promise<MongoClient>
  def(id: string): Promise<ConnectionDef | undefined>
  isOpen(id: string): boolean
}

async function listDatabaseNodes(key: string, client: MongoClient, def: ConnectionDef): Promise<TreeNode[]> {
  const admin = client.db('admin').admin()
  let dbs: { name: string; sizeOnDisk?: number; empty?: boolean }[]
  let limited = false
  try {
    dbs = (await admin.listDatabases()).databases
  } catch {
    try {
      dbs = (await admin.listDatabases({ nameOnly: true, authorizedDatabases: true })).databases
      limited = true
    } catch {
      const fallback = def.options.defaultDatabase || def.auth.authSource || 'admin'
      dbs = [{ name: fallback }]
      limited = true
    }
  }
  const nodes: TreeNode[] = dbs
    .sort((a, b) => a.name.localeCompare(b.name))
    .map((d) => {
      const node: TreeNode = { key: childKey(key, 'db', d.name), kind: 'db', label: d.name, hasChildren: true }
      if (typeof d.sizeOnDisk === 'number') node.description = d.empty ? 'empty' : formatBytes(d.sizeOnDisk)
      return node
    })
  if (limited) {
    nodes.push({ key: childKey(key, 'message', 'limited'), kind: 'message', label: 'Only databases this user has privileges on', hasChildren: false, disabled: true })
  }
  return nodes
}

async function listCollectionNodes(key: string, db: Db): Promise<TreeNode[]> {
  const infos = (await db.listCollections({}, { authorizedCollections: true }).toArray()) as { name: string; type?: string; options?: Document }[]
  const names = new Set(infos.map((c) => c.name))
  const bucketNames = [...names]
    .filter((n) => n.endsWith('.files') && names.has(`${n.slice(0, -6)}.chunks`))
    .map((n) => n.slice(0, -6))
  const inBucket = new Set(bucketNames.flatMap((b) => [`${b}.files`, `${b}.chunks`]))
  const visible = infos
    .filter((c) => !inBucket.has(c.name))
    .filter((c) => c.name !== 'system.views' && !c.name.startsWith('system.buckets.'))
    .sort((a, b) => a.name.localeCompare(b.name))

  const nodes = await mapLimit(visible, 8, async (c): Promise<TreeNode> => {
    const kind: NodeKind = c.type === 'view' ? 'view' : c.type === 'timeseries' ? 'timeseries' : 'coll'
    const node: TreeNode = { key: childKey(key, kind, c.name), kind, label: c.name, hasChildren: kind !== 'view' }
    if (kind === 'view') node.description = `view on ${String(c.options?.viewOn ?? '?')}`
    else {
      const d = collDescription(await collStats(db, c.name))
      const prefix = kind === 'timeseries' ? 'time-series' : ''
      const description = [prefix, d].filter(Boolean).join(' · ')
      if (description) node.description = description
    }
    return node
  })
  const buckets = await mapLimit(bucketNames.sort(), 4, async (b): Promise<TreeNode> => {
    const node: TreeNode = { key: childKey(key, 'bucket', b), kind: 'bucket', label: b, hasChildren: true }
    try {
      const n = await db.collection(`${b}.files`).estimatedDocumentCount({ maxTimeMS: STATS_TIMEOUT_MS })
      node.description = `GridFS · ${formatCount(n, 'file')}`
    } catch {
      node.description = 'GridFS'
    }
    return node
  })
  return [
    ...buckets,
    ...nodes,
    { key: childKey(key, 'users'), kind: 'users', label: 'Users', hasChildren: true },
    { key: childKey(key, 'roles'), kind: 'roles', label: 'Roles', hasChildren: true }
  ]
}

async function listIndexNodes(key: string, db: Db, collection: string): Promise<TreeNode[]> {
  const coll = db.collection(collection)
  const [specs, stats] = await Promise.all([coll.listIndexes().toArray(), collStats(db, collection)])
  return specs.map((spec) => {
    const name = String(spec.name)
    const size = stats?.indexSizes?.[name]
    const parts = [...indexFlags(spec)]
    if (typeof size === 'number') parts.push(formatBytes(size))
    const node: TreeNode = { key: childKey(key, 'index', name), kind: 'index', label: name, hasChildren: false }
    if (parts.length) node.description = parts.join(' · ')
    return node
  })
}

export async function treeChildren(ctx: TreeContext, key: string): Promise<TreeNode[]> {
  const t = nodeTarget(key)
  if (!t.connectionId) return []
  const def = await ctx.def(t.connectionId)
  if (!def) throw new Error('This connection no longer exists.')
  const client = await ctx.client(t.connectionId)
  switch (t.kind) {
    case 'conn':
      return listDatabaseNodes(key, client, def)
    case 'db':
      return listCollectionNodes(key, client.db(t.db!))
    case 'coll':
    case 'timeseries': {
      const specs = await client.db(t.db!).collection(t.collection!).listIndexes().toArray().catch(() => [])
      const node: TreeNode = { key: childKey(key, 'indexes'), kind: 'indexes', label: 'Indexes', hasChildren: true }
      if (specs.length) node.description = formatCount(specs.length, 'index', 'indexes')
      return [node]
    }
    case 'indexes':
      return listIndexNodes(key, client.db(t.db!), t.collection!)
    case 'bucket': {
      const parent = key.slice(0, key.lastIndexOf('/'))
      const db = client.db(t.db!)
      return mapLimit([`${t.collection}.files`, `${t.collection}.chunks`], 2, async (name): Promise<TreeNode> => {
        const node: TreeNode = { key: childKey(parent, 'coll', name), kind: 'coll', label: name, hasChildren: true }
        const d = collDescription(await collStats(db, name))
        if (d) node.description = d
        return node
      })
    }
    case 'users': {
      const res = await client.db(t.db!).command({ usersInfo: 1 })
      const users = (res.users ?? []) as { user: string; roles?: { role: string; db: string }[] }[]
      if (users.length === 0) return [{ key: childKey(key, 'message', 'none'), kind: 'message', label: 'No users in this database', hasChildren: false, disabled: true }]
      return users.map((u) => ({
        key: childKey(key, 'user', u.user),
        kind: 'user' as const,
        label: u.user,
        description: (u.roles ?? []).map((r) => (r.db === t.db ? r.role : `${r.role}@${r.db}`)).join(', ') || 'no roles',
        hasChildren: false
      }))
    }
    case 'roles': {
      const res = await client.db(t.db!).command({ rolesInfo: 1, showBuiltinRoles: false })
      const roles = (res.roles ?? []) as { role: string; privileges?: unknown[]; roles?: unknown[] }[]
      if (roles.length === 0) return [{ key: childKey(key, 'message', 'none'), kind: 'message', label: 'No custom roles in this database', hasChildren: false, disabled: true }]
      return roles.map((r) => ({
        key: childKey(key, 'role', r.role),
        kind: 'role' as const,
        label: r.role,
        description: `${formatCount(r.privileges?.length ?? 0, 'privilege')} · inherits ${r.roles?.length ?? 0}`,
        hasChildren: false
      }))
    }
    default:
      return []
  }
}

function item(label: string, value: DetailItem['value'], extra: Partial<DetailItem> = {}): DetailItem {
  return { label, value, ...extra }
}

export async function treeDetails(ctx: TreeContext, key: string): Promise<NodeDetails> {
  const t = nodeTarget(key)
  if (!t.connectionId) return { title: t.group ?? '', subtitle: 'Group', items: [] }
  const def = await ctx.def(t.connectionId)
  if (!def) throw new Error('This connection no longer exists.')

  if (t.kind === 'conn') {
    const items: DetailItem[] = [
      item('Type', TOPOLOGY_LABELS[def.topology]),
      item('Hosts', def.hosts.map(hostLabel).join(', '), { code: true }),
      item('Authentication', AUTH_LABELS[def.auth.mechanism]),
      item('TLS', def.tls.enabled ? 'on' : 'off', def.tls.enabled ? { tone: 'success' } : {}),
      item('SSH tunnel', def.ssh.enabled ? `${def.ssh.username}@${def.ssh.host}:${def.ssh.port}` : 'none')
    ]
    if (def.ssh.enabled && def.ssh.knownHostKey) items.push(item('SSH host key', formatHostKey(def.ssh.knownHostKey), { code: true }))
    if (def.replicaSet) items.push(item('Replica set', def.replicaSet))
    if (def.options.defaultDatabase) items.push(item('Default database', def.options.defaultDatabase))
    items.push(item('Read preference', def.options.readPreference))
    if (ctx.isOpen(def.id)) {
      try {
        const client = await ctx.client(def.id)
        const admin = client.db('admin')
        const [build, hello] = await Promise.all([admin.command({ buildInfo: 1 }), admin.command({ hello: 1 })])
        items.unshift(item('Status', 'connected', { tone: 'success' }))
        items.push(item('Server version', String(build.version)))
        if (hello.setName) items.push(item('Primary', String(hello.primary ?? '?'), { code: true }))
      } catch (error) {
        items.unshift(item('Status', (error as Error).message, { tone: 'danger' }))
      }
    } else {
      items.unshift(item('Status', 'not connected'))
    }
    return { title: def.name, subtitle: 'Connection', items, json: buildConnectionString(def, { maskPassword: true }) }
  }

  const client = await ctx.client(t.connectionId)
  const db = client.db(t.db!)
  switch (t.kind) {
    case 'db': {
      const s = await db.command({ dbStats: 1, scale: 1 })
      return {
        title: t.db!,
        subtitle: 'Database',
        items: [
          item('Collections', Number(s.collections ?? 0)),
          item('Views', Number(s.views ?? 0)),
          item('Documents', Number(s.objects ?? 0).toLocaleString('en-US')),
          item('Data size', formatBytes(Number(s.dataSize ?? 0))),
          item('Storage size', formatBytes(Number(s.storageSize ?? 0))),
          item('Indexes', Number(s.indexes ?? 0)),
          item('Index size', formatBytes(Number(s.indexSize ?? 0)))
        ]
      }
    }
    case 'coll':
    case 'timeseries': {
      const [stats, [info]] = await Promise.all([collStats(db, t.collection!), db.listCollections({ name: t.collection! }).toArray()])
      const items: DetailItem[] = []
      if (stats) {
        if (typeof stats.count === 'number') items.push(item('Documents', stats.count.toLocaleString('en-US')))
        if (typeof stats.size === 'number') items.push(item('Data size', formatBytes(stats.size)))
        if (typeof stats.avgObjSize === 'number') items.push(item('Average document', formatBytes(stats.avgObjSize)))
        if (typeof stats.storageSize === 'number') items.push(item('Storage size', formatBytes(stats.storageSize)))
        if (typeof stats.nindexes === 'number') items.push(item('Indexes', stats.nindexes))
        if (typeof stats.totalIndexSize === 'number') items.push(item('Index size', formatBytes(stats.totalIndexSize)))
        if (stats.capped) items.push(item('Capped', true))
      } else {
        items.push(item('Statistics', 'not available to this user', { tone: 'warning' }))
      }
      const options = (info as { options?: Document } | undefined)?.options ?? {}
      if (options.validator) items.push(item('Validation', `${String(options.validationLevel ?? 'strict')} / ${String(options.validationAction ?? 'error')}`))
      if (options.clusteredIndex) items.push(item('Clustered', true))
      if (options.timeseries) items.push(item('Time field', String((options.timeseries as Document).timeField)))
      const result: NodeDetails = { title: t.collection!, subtitle: t.kind === 'timeseries' ? 'Time-series collection' : 'Collection', items }
      if (Object.keys(options).length) result.json = json(options)
      return result
    }
    case 'view': {
      const [info] = (await db.listCollections({ name: t.collection! }).toArray()) as { options?: Document }[]
      const options = info?.options ?? {}
      return {
        title: t.collection!,
        subtitle: 'View',
        items: [item('View on', String(options.viewOn ?? '?')), item('Stages', Array.isArray(options.pipeline) ? options.pipeline.length : 0)],
        json: json(options.pipeline ?? [])
      }
    }
    case 'bucket': {
      const files = db.collection(`${t.collection}.files`)
      const [agg] = await files
        .aggregate([{ $group: { _id: null, n: { $sum: 1 }, bytes: { $sum: '$length' }, latest: { $max: '$uploadDate' } } }], { maxTimeMS: STATS_TIMEOUT_MS })
        .toArray()
      const items: DetailItem[] = [item('Files', Number(agg?.n ?? 0)), item('Total size', formatBytes(Number(agg?.bytes ?? 0)))]
      if (agg?.latest instanceof Date) items.push(item('Last upload', agg.latest.toISOString().replace('T', ' ').slice(0, 16)))
      return { title: t.collection!, subtitle: 'GridFS bucket', items }
    }
    case 'indexes': {
      const n = (await db.collection(t.collection!).listIndexes().toArray()).length
      return { title: 'Indexes', subtitle: `${t.db}.${t.collection}`, items: [item('Indexes', n)] }
    }
    case 'index': {
      const coll = db.collection(t.collection!)
      const [specs, stats, usage] = await Promise.all([
        coll.listIndexes().toArray(),
        collStats(db, t.collection!),
        coll.aggregate([{ $indexStats: {} }, { $match: { name: t.index! } }], { maxTimeMS: STATS_TIMEOUT_MS }).toArray().catch(() => [])
      ])
      const spec = specs.find((s) => s.name === t.index)
      if (!spec) throw new Error('This index no longer exists. Refresh the tree.')
      const items: DetailItem[] = [item('Kind', indexFlags(spec).join(', ') || 'ascending/descending')]
      const size = stats?.indexSizes?.[t.index!]
      if (typeof size === 'number') items.push(item('Size', formatBytes(size)))
      const u = usage[0] as { accesses?: { ops?: unknown; since?: unknown } } | undefined
      if (u?.accesses) {
        items.push(item('Used', `${Number(u.accesses.ops ?? 0).toLocaleString('en-US')} times`))
        if (u.accesses.since instanceof Date) items.push(item('Counting since', u.accesses.since.toISOString().replace('T', ' ').slice(0, 16)))
      }
      return { title: t.index!, subtitle: `Index on ${t.db}.${t.collection}`, items, json: json(spec) }
    }
    case 'users': {
      const res = await db.command({ usersInfo: 1 })
      return { title: 'Users', subtitle: `Database ${t.db}`, items: [item('Users', (res.users as unknown[]).length)] }
    }
    case 'roles': {
      const res = await db.command({ rolesInfo: 1, showBuiltinRoles: false })
      return { title: 'Roles', subtitle: `Database ${t.db}`, items: [item('Custom roles', (res.roles as unknown[]).length)] }
    }
    case 'user': {
      const res = await db.command({ usersInfo: { user: t.user!, db: t.db! }, showPrivileges: false })
      const u = (res.users as Document[])[0]
      if (!u) throw new Error('This user no longer exists. Refresh the tree.')
      return {
        title: t.user!,
        subtitle: `User in ${t.db}`,
        items: [
          item('Roles', ((u.roles ?? []) as Document[]).map((r) => `${String(r.role)}@${String(r.db)}`).join(', ') || 'none'),
          item('Mechanisms', ((u.mechanisms ?? []) as string[]).join(', ') || '—')
        ],
        json: json(u)
      }
    }
    case 'role': {
      const res = await db.command({ rolesInfo: { role: t.role!, db: t.db! }, showPrivileges: true })
      const r = (res.roles as Document[])[0]
      if (!r) throw new Error('This role no longer exists. Refresh the tree.')
      return {
        title: t.role!,
        subtitle: `Role in ${t.db}`,
        items: [item('Privileges', ((r.privileges ?? []) as unknown[]).length), item('Inherits', ((r.roles ?? []) as Document[]).map((x) => `${String(x.role)}@${String(x.db)}`).join(', ') || 'nothing')],
        json: json(r)
      }
    }
    default:
      return { title: '', subtitle: '', items: [] }
  }
}
