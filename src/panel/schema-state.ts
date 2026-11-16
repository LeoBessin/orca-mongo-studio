// The Schema Explorer tab: samples a collection (optionally filtered), shows its fields as a tree
// with types and presence, a selected field's histogram and common values, and exports the shape
// as a JSON Schema or a $jsonSchema validator for the Manage tab.
import { plugin } from 'orca'
import type { Namespace } from '../protocol'
import { toShell } from '../shared/ejson-view'
import type { NodeKind } from '../shared/nodes'
import { toJsonSchema, type SchemaFlavor, type SchemaReport } from '../shared/schema'
import { parseShellDocument, ShellParseError } from '../shared/shell-parse'
import { adminTabId, changeAdmin, showOrAdd, tabOf, type SchemaTab } from './admin-state'
import { errorText } from './state'

export const SAMPLE_SIZES = [100, 500, 1000, 5000, 10000]

export function schemaTabId(ns: Namespace): string {
  return adminTabId('schema', [ns.connectionId, ns.db, ns.collection])
}

/** Opens (or shows) the Schema tab; `forValidator` opens the export as a validator. */
export async function openSchema(ns: Namespace, collKind: NodeKind, forValidator = false): Promise<void> {
  const tab: SchemaTab = {
    id: schemaTabId(ns),
    kind: 'schema',
    connectionId: ns.connectionId,
    title: `Schema: ${ns.collection}`,
    ns,
    collKind,
    size: 1000,
    filter: '',
    loading: false,
    expanded: [],
    exportOpen: forValidator,
    flavor: 'mongo',
    required: true,
    closed: false,
    token: 0
  }
  const fresh = showOrAdd(tab)
  if (forValidator) changeAdmin(tab.id, 'schema', () => ({ exportOpen: true, flavor: 'mongo' }))
  if (fresh) await analyze(tab.id)
}

export async function analyze(id: string): Promise<void> {
  const t = tabOf(id, 'schema')
  if (!t) return
  let filter: Record<string, import('../shared/ejson-view').JsonValue> | undefined
  if (t.filter.trim()) {
    try {
      filter = parseShellDocument(t.filter, 'filter')
    } catch (error) {
      changeAdmin(id, 'schema', () => ({ filterError: error instanceof ShellParseError ? error.message : errorText(error) }))
      return
    }
  }
  const token = t.token + 1
  changeAdmin(id, 'schema', () => ({ loading: true, error: undefined, filterError: undefined, token }))
  try {
    const { report } = await plugin.request('schema.analyze', { ns: t.ns, size: t.size, ...(filter && Object.keys(filter).length ? { filter } : {}) }, { timeoutMs: 120000 })
    if (tabOf(id, 'schema')?.token !== token) return
    const parsed = JSON.parse(report) as SchemaReport
    changeAdmin(id, 'schema', (x) => ({
      loading: false,
      report: parsed,
      // Top-level objects and arrays start open; a field selected before stays if still there.
      expanded: x.report ? x.expanded : parsed.fields.filter((f) => !f.parent && f.types.some((ty) => ty.type === 'object' || ty.type === 'array')).map((f) => fieldKey(f.path)),
      selected: x.selected && parsed.fields.some((f) => fieldKey(f.path) === x.selected) ? x.selected : undefined
    }))
  } catch (error) {
    if (tabOf(id, 'schema')?.token === token) changeAdmin(id, 'schema', () => ({ loading: false, error: errorText(error) }))
  }
}

export function fieldKey(path: string): string {
  return `f:${path}`
}

export function toggleField(id: string, key: string, open: boolean): void {
  changeAdmin(id, 'schema', (t) => ({ expanded: open ? [...new Set([...t.expanded, key])] : t.expanded.filter((k) => k !== key) }))
}

/** The export as text: a validator in shell syntax, or JSON Schema as JSON. */
export function exportText(t: SchemaTab): string {
  if (!t.report) return ''
  const schema = toJsonSchema(t.report, { flavor: t.flavor, required: t.required, closed: t.closed })
  return t.flavor === 'mongo' ? toShell(schema) : JSON.stringify(schema, null, 2)
}

export function setExport(id: string, change: Partial<{ flavor: SchemaFlavor; required: boolean; closed: boolean }>): void {
  changeAdmin(id, 'schema', () => change)
}
