// A query's results as a Table, a Tree or JSON, with the pager and the actions for what is
// selected. Table cells are text only, so values show as short text and editing happens in the
// editors under the results.
import {
  Badge,
  Box,
  Button,
  CodeView,
  EmptyState,
  IconButton,
  Row,
  Select,
  Skeleton,
  Switch,
  Table,
  Text,
  Toolbar,
  Tree,
  type OrcaNode,
  type TableColumn,
  type TableRow,
  type TreeItem
} from 'orca'
import { BSON_TYPE_LABELS, bsonType, isContainer, isObject, toJsonText, valueAt, valueText, type JsonObject, type JsonValue } from '../shared/ejson-view'
import {
  addField,
  addToQuery,
  askDelete,
  change,
  cloneDocument,
  currentSort,
  editDocument,
  editField,
  goToPage,
  nextPage,
  PAGE_SIZE_OPTIONS,
  parseTreeKey,
  previousPage,
  recount,
  rowKey,
  selectedDocs,
  setPageSize,
  sortBy,
  treeKey,
  type CollTab,
  type Path,
  type ResultView
} from './collection-state'
import { guard } from './guard'

const MAX_COLUMNS = 40

// ---- Pager ----

function countText(t: CollTab): string {
  const p = t.page
  if (!p) return ''
  const from = p.docs.length ? p.offset + 1 : p.offset
  const to = p.offset + p.docs.length
  const range = p.docs.length ? `${from.toLocaleString('en-US')}–${to.toLocaleString('en-US')}` : 'No documents'
  const c = t.count
  if (c === undefined) return range
  if (c === 'counting') return `${range} of …`
  if (c.count === null) return `${range} (count unavailable)`
  return `${range} of ${c.approximate ? '~' : ''}${c.count.toLocaleString('en-US')}`
}

export function Pager({ t }: { t: CollTab }): OrcaNode {
  const p = t.page
  const c = t.count
  const total = c && c !== 'counting' && c.count !== null ? c.count : undefined
  return (
    <Row gap="xs" align="center" justify="between" wrap>
      <Toolbar label="Pages" gap="xs">
        <IconButton icon="collapse" label="First page" size="sm" variant="ghost" disabled={!p || p.offset === 0 || t.loading} onPress={guard(t.id, () => goToPage(t.id, 0))} />
        <IconButton icon="remove" label="Previous page" size="sm" variant="ghost" disabled={!p || p.offset === 0 || t.loading} onPress={guard(t.id, () => previousPage(t.id))} />
        <IconButton icon="next" label="Next page" size="sm" variant="ghost" disabled={!p?.hasMore || t.loading} onPress={guard(t.id, () => nextPage(t.id))} />
        <IconButton icon="refresh" label="Count again" size="sm" variant="ghost" disabled={!t.spec || c === 'counting'} onPress={guard(t.id, () => recount(t.id))} />
      </Toolbar>
      <Text size="xs" muted={total === undefined}>{countText(t)}</Text>
      <Select label="Page size" labelHidden value={String(t.pageSize)} options={PAGE_SIZE_OPTIONS.map((n) => ({ value: String(n), label: `${n} per page` }))} onChange={(v) => void guard(t.id, () => setPageSize(t.id, Number(v)))()} />
    </Row>
  )
}

// ---- Table ----

function topKeys(docs: readonly JsonObject[]): string[] {
  const keys: string[] = []
  const seen = new Set<string>()
  for (const d of docs) for (const k of Object.keys(d)) if (!seen.has(k)) seen.add(k), keys.push(k)
  return keys.sort((a, b) => (a === '_id' ? -1 : b === '_id' ? 1 : 0))
}

/** Columns: every top-level key, with flattened sub-documents as dotted columns. */
export function tableColumns(t: CollTab): string[] {
  const docs = t.page?.docs ?? []
  const out: string[] = []
  for (const key of topKeys(docs)) {
    if (!t.flattened.includes(key)) {
      out.push(key)
      continue
    }
    const subs: string[] = []
    for (const d of docs) {
      const v = d[key]
      if (v !== undefined && bsonType(v) === 'object') for (const s of Object.keys(v as JsonObject)) if (!subs.includes(s)) subs.push(s)
    }
    out.push(...(subs.length ? subs.map((s) => `${key}.${s}`) : [key]))
  }
  return out.slice(0, MAX_COLUMNS)
}

function cellValue(doc: JsonObject, column: string, t: CollTab): JsonValue | undefined {
  const dot = column.indexOf('.')
  if (dot > 0 && t.flattened.includes(column.slice(0, dot))) {
    const parent = doc[column.slice(0, dot)]
    return isObject(parent) && bsonType(parent) === 'object' ? parent[column.slice(dot + 1)] : undefined
  }
  return doc[column]
}

function ResultTable({ t }: { t: CollTab }): OrcaNode {
  const docs = t.page?.docs ?? []
  const keys = tableColumns(t)
  const columns: TableColumn[] = keys.map((k) => ({ key: k, label: k, sortable: true, minWidth: k === '_id' ? 'md' : 'sm' }))
  const rows: TableRow[] = docs.map((d, i) => {
    const cells: TableRow['cells'] = {}
    for (const k of keys) {
      const v = cellValue(d, k, t)
      cells[k] = v === undefined ? '' : valueText(v, 80)
    }
    return { key: rowKey(d, i), cells }
  })
  const sort = currentSort(t)
  const objectColumns = topKeys(docs).filter((k) => docs.some((d) => d[k] !== undefined && bsonType(d[k]!) === 'object'))
  return (
    <Box gap="xs">
      <Table
        label="Documents"
        columns={columns}
        rows={rows}
        {...(sort ? { sort } : {})}
        selectionMode={t.readOnly ? 'single' : 'multiple'}
        selected={t.selectedRows}
        loading={t.loading}
        emptyText="No documents match."
        maxHeight="lg"
        onSortChange={({ column, direction }) => void guard(t.id, () => sortBy(t.id, column, direction))()}
        onSelectionChange={({ keys: sel }) => change(t.id, () => ({ selectedRows: sel, confirmDelete: undefined }))}
        onRowAction={({ key }) => {
          const i = rows.findIndex((r) => r.key === key)
          const d = docs[i]
          if (d && '_id' in d) void guard(t.id, () => (t.readOnly ? Promise.resolve(change(t.id, () => ({ resultView: 'tree' as const, treeExpanded: [`r${i}`], treeSelected: `r${i}` }))) : editDocument(t.id, d._id!)))()
        }}
      />
      {objectColumns.length ? (
        <Select
          label="Show a sub-document as columns"
          value=""
          placeholder={t.flattened.length ? `Showing ${t.flattened.join(', ')} as columns` : 'Show a sub-document as columns…'}
          options={objectColumns.map((k) => ({ value: k, label: t.flattened.includes(k) ? `${k} (back to one column)` : k }))}
          onChange={(k) => change(t.id, (x) => ({ flattened: x.flattened.includes(k) ? x.flattened.filter((f) => f !== k) : [...x.flattened, k] }))}
        />
      ) : null}
    </Box>
  )
}

// ---- Tree ----

function childEntries(v: JsonValue): [string | number, JsonValue][] {
  if (Array.isArray(v)) return v.map((x, i) => [i, x])
  return Object.entries(v as JsonObject)
}

function fieldItem(row: number, path: Path, v: JsonValue, expanded: Set<string>): TreeItem {
  const key = treeKey(row, path)
  const name = path[path.length - 1]!
  const container = isContainer(v)
  const item: TreeItem = {
    key,
    label: `${typeof name === 'number' ? `[${name}]` : name}: ${valueText(v, 80)}`,
    description: BSON_TYPE_LABELS[bsonType(v)],
    icon: container ? (Array.isArray(v) ? 'layers' : 'folder') : 'file'
  }
  if (container && childEntries(v).length) {
    if (expanded.has(key)) item.children = childEntries(v).map(([k, x]) => fieldItem(row, [...path, k], x, expanded))
    else item.hasChildren = true
  }
  return item
}

function ResultTree({ t }: { t: CollTab }): OrcaNode {
  const docs = t.page?.docs ?? []
  const expanded = new Set(t.treeExpanded)
  const items: TreeItem[] = docs.map((d, i) => {
    const key = treeKey(i, [])
    const item: TreeItem = { key, label: '_id' in d ? valueText(d._id!, 80) : `Document ${t.page!.offset + i + 1}`, description: `${Object.keys(d).length} fields${t.page!.truncated.includes(i) ? ' · truncated' : ''}`, icon: 'file-text' }
    if (expanded.has(key)) item.children = Object.entries(d).map(([k, v]) => fieldItem(i, [k], v, expanded))
    else item.hasChildren = true
    return item
  })
  return (
    <Tree
      label="Documents"
      items={items}
      expanded={t.treeExpanded}
      {...(t.treeSelected ? { selected: t.treeSelected } : {})}
      maxHeight="lg"
      onToggle={({ key, expanded: open }) => change(t.id, (x) => ({ treeExpanded: open ? [...new Set([...x.treeExpanded, key])] : x.treeExpanded.filter((k) => k !== key && !k.startsWith(`${key}/`)) }))}
      onSelect={({ key }) => change(t.id, () => ({ treeSelected: key, confirmDelete: undefined }))}
      onAction={({ key }) => {
        const { row, path } = parseTreeKey(key)
        const d = docs[row]
        if (!d || !('_id' in d) || t.readOnly) return
        void guard(t.id, () => (path.length ? editField(t.id, d._id!, path) : editDocument(t.id, d._id!)))()
      }}
    />
  )
}

// ---- JSON ----

function ResultJson({ t }: { t: CollTab }): OrcaNode {
  const docs = t.page?.docs ?? []
  return (
    <Box gap="xs">
      <Switch label="Relaxed Extended JSON" checked={t.relaxed} onChange={(relaxed) => change(t.id, () => ({ relaxed }))} />
      <CodeView label="Documents as Extended JSON" code={toJsonText(docs, t.relaxed)} language="json" lineNumbers maxHeight="lg" />
    </Box>
  )
}

// ---- Selection actions ----

function TableActions({ t }: { t: CollTab }): OrcaNode {
  const docs = selectedDocs(t)
  if (docs.length === 0) return <Text muted size="xs">{t.readOnly ? 'Select a row to look at it in the Tree view.' : 'Select rows to edit, clone or delete. Enter on a row edits it.'}</Text>
  const one = docs.length === 1 ? docs[0]! : undefined
  const hasId = docs.every((d) => '_id' in d)
  if (t.readOnly) {
    return one ? (
      <Toolbar label="Row actions" gap="xs">
        <Button size="sm" icon="search" onPress={() => change(t.id, (x) => ({ resultView: 'tree' as const, treeExpanded: [treeKey(x.page!.docs.indexOf(one), [])], treeSelected: treeKey(x.page!.docs.indexOf(one), []) }))}>Show in Tree</Button>
      </Toolbar>
    ) : null
  }
  const fields = one ? Object.keys(one).filter((k) => k !== '_id') : []
  return (
    <Box gap="xs">
      <Toolbar label="Row actions" gap="xs">
        {one && hasId ? <Button size="sm" icon="edit" onPress={guard(t.id, () => editDocument(t.id, one._id!))}>Edit document</Button> : null}
        {one && hasId ? <Button size="sm" icon="copy" variant="ghost" onPress={guard(t.id, () => cloneDocument(t.id, one._id!))}>Clone</Button> : null}
        {hasId ? (
          <Button size="sm" icon="delete" variant="ghost" tone="danger" onPress={() => askDelete(t.id)}>
            {docs.length === 1 ? 'Delete' : `Delete ${docs.length}`}
          </Button>
        ) : null}
      </Toolbar>
      {one && hasId ? (
        <Row gap="xs" align="end" wrap>
          <Select label="Edit a field" value="" placeholder="Choose a field to edit…" options={fields.map((f) => ({ value: f, label: f }))} onChange={(f) => void guard(t.id, () => editField(t.id, one._id!, [f]))()} />
          <Button size="sm" icon="add" variant="ghost" onPress={() => addField(t.id, one._id!)}>Add field</Button>
        </Row>
      ) : null}
      {!hasId ? <Text muted size="xs">Documents without an _id (from a projection or a view) can't be edited here.</Text> : null}
    </Box>
  )
}

function TreeActions({ t }: { t: CollTab }): OrcaNode {
  if (!t.treeSelected) return <Text muted size="xs">{t.readOnly ? 'Select a field to add it to the Query Builder.' : 'Select a field to edit it or add it to the query. Enter edits.'}</Text>
  const { row, path } = parseTreeKey(t.treeSelected)
  const doc = t.page?.docs[row]
  if (!doc) return null
  const value = path.length ? valueAt(doc, path) : undefined
  const canEdit = !t.readOnly && '_id' in doc
  return (
    <Toolbar label="Field actions" gap="xs">
      {canEdit && path.length && path[0] !== '_id' ? <Button size="sm" icon="edit" onPress={guard(t.id, () => editField(t.id, doc._id!, path))}>Edit field</Button> : null}
      {canEdit && !path.length ? <Button size="sm" icon="edit" onPress={guard(t.id, () => editDocument(t.id, doc._id!))}>Edit document</Button> : null}
      {canEdit && !path.length ? <Button size="sm" icon="add" variant="ghost" onPress={() => addField(t.id, doc._id!)}>Add field</Button> : null}
      {path.length && !path.some((p) => typeof p === 'number') ? (
        <Button size="sm" icon="filter" variant="ghost" onPress={() => addToQuery(t.id, path, value)}>Add to query</Button>
      ) : null}
      {value !== undefined ? <Badge>{BSON_TYPE_LABELS[bsonType(value)]}</Badge> : null}
    </Toolbar>
  )
}

const VIEWS: { value: ResultView; label: string }[] = [
  { value: 'table', label: 'Table' },
  { value: 'tree', label: 'Tree' },
  { value: 'json', label: 'JSON' }
]

export function Results({ t }: { t: CollTab }): OrcaNode {
  if (!t.page && t.loading) return <Skeleton lines={6} label="Running the query" />
  if (!t.page) return null
  const p = t.page
  return (
    <Box gap="sm">
      <Row gap="xs" align="center" justify="between" wrap>
        <Toolbar label="Show results as" gap="xs">
          {VIEWS.map((v) => (
            <Button key={v.value} size="sm" variant={t.resultView === v.value ? 'solid' : 'ghost'} tone={t.resultView === v.value ? 'accent' : 'neutral'} onPress={() => change(t.id, () => ({ resultView: v.value }))}>
              {v.label}
            </Button>
          ))}
        </Toolbar>
        <Text size="xs" muted>{`${p.ms.toLocaleString('en-US')} ms`}</Text>
      </Row>
      <Pager t={t} />
      {p.stoppedForSize ? <Text size="xs" muted>This page holds fewer documents than the page size, to stay under the size Orca lets a panel receive. Next page goes on from here.</Text> : null}
      {p.truncated.length ? <Text size="xs" muted>{`${p.truncated.length} document${p.truncated.length === 1 ? ' has' : 's have'} long values cut short here. Editing loads the whole document.`}</Text> : null}
      {p.docs.length === 0 && !t.loading ? (
        <EmptyState icon="search" title="No documents" description={p.offset > 0 ? 'There are no more results.' : 'Nothing matches this query.'} />
      ) : t.resultView === 'table' ? (
        <ResultTable t={t} />
      ) : t.resultView === 'tree' ? (
        <ResultTree t={t} />
      ) : (
        <ResultJson t={t} />
      )}
      {p.docs.length && t.resultView === 'table' ? <TableActions t={t} /> : null}
      {p.docs.length && t.resultView === 'tree' ? <TreeActions t={t} /> : null}
    </Box>
  )
}
