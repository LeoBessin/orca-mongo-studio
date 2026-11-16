// Tree node keys: a path of `kind:name` segments, names %-encoded, unique across the whole tree.
// e.g. `conn:abc/db:shop/coll:orders/indexes/index:email_unique`.

export type NodeKind =
  | 'group'
  | 'conn'
  | 'db'
  | 'coll'
  | 'view'
  | 'timeseries'
  | 'bucket'
  | 'indexes'
  | 'index'
  | 'users'
  | 'user'
  | 'roles'
  | 'role'
  | 'message'

export type NodeSegment = { kind: NodeKind; name: string }

export function nodeKey(segments: readonly NodeSegment[]): string {
  return segments.map((s) => (s.name === '' ? s.kind : `${s.kind}:${encodeURIComponent(s.name)}`)).join('/')
}

export function parseNodeKey(key: string): NodeSegment[] {
  return key.split('/').map((part) => {
    const at = part.indexOf(':')
    if (at < 0) return { kind: part as NodeKind, name: '' }
    return { kind: part.slice(0, at) as NodeKind, name: decodeURIComponent(part.slice(at + 1)) }
  })
}

export function childKey(parent: string, kind: NodeKind, name = ''): string {
  return `${parent}/${nodeKey([{ kind, name }])}`
}

/** What a node points at, for the worker: connection, database, collection, index or user. */
export type NodeTarget = {
  kind: NodeKind
  connectionId?: string
  group?: string
  db?: string
  collection?: string
  index?: string
  user?: string
  role?: string
}

export function nodeTarget(key: string): NodeTarget {
  const segs = parseNodeKey(key)
  const t: NodeTarget = { kind: segs[segs.length - 1]?.kind ?? 'message' }
  for (const s of segs) {
    if (s.kind === 'group') t.group = s.name
    if (s.kind === 'conn') t.connectionId = s.name
    if (s.kind === 'db') t.db = s.name
    if (s.kind === 'coll' || s.kind === 'view' || s.kind === 'timeseries' || s.kind === 'bucket') t.collection = s.name
    if (s.kind === 'index') t.index = s.name
    if (s.kind === 'user') t.user = s.name
    if (s.kind === 'role') t.role = s.name
  }
  return t
}

export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return ''
  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  let v = bytes
  let i = 0
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024
    i++
  }
  return `${v >= 100 || i === 0 ? Math.round(v) : v.toFixed(1)} ${units[i]}`
}

export function formatCount(n: number, one: string, many = `${one}s`): string {
  return `${n.toLocaleString('en-US')} ${n === 1 ? one : many}`
}
