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
import { BSON_TYPE_LABELS, bsonType, isContainer, isObject, toJsonText, toShellInline, valueAt, valueText, type JsonObject, type JsonValue } from '../shared/ejson-view'
import { QUERY_TEXT_MAX } from '../shared/host-size'
import { PAGE_SIZES } from '../shared/settings'
import { filterablePath, filterFromRows, projectionKeeps } from '../shared/table-filter'
import {
  addField,
  addToQuery,
  askDelete,
  canUpdateMany,
  dropBulkPreview,
  openUpdateMany,
  canFilterBySelection,
  canOpenDocuments,
  change,
  cloneDocument,
  currentSort,
  editDocument,
  editField,
  filterBySelection,
  goToPage,
  nextPage,
  openDocument,
  openDocumentTab,
  parseTreeKey,
  previousPage,
  recount,
  RESULT_VIEWS,
  rowKeys,
  say,
  selectedDocs,
  setPageSize,
  setResultView,
  sortBy,
  toggleFilterColumn,
  treeKey,
  type CollTab,
  type Path,
  type ResultView
} from './collection-state'
import { copyToClipboard } from './data-state'
import { guard } from './guard'

/** Orca draws a Table of at most 32 columns, and refuses the whole table past that. */
const MAX_COLUMNS = 32

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
        <IconButton icon="refresh" label="Count again" size="sm" variant="ghost" disabled={!(t.spec || t.agg?.ran) || c === 'counting'} onPress={guard(t.id, () => recount(t.id))} />
      </Toolbar>
      <Text size="xs" muted={total === undefined}>{countText(t)}</Text>
      <Select label="Page size" labelHidden value={String(t.pageSize)} options={PAGE_SIZES.map((n) => ({ value: String(n), label: `${n} per page` }))} onChange={(v) => void guard(t.id, () => setPageSize(t.id, Number(v)))()} />
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

/** A table column: the field it shows (a top-level key, or a sub-document's key when that
 *  sub-document is shown as columns) and its dotted name. */
export type ResultColumn = { field: string; sub?: string; name: string }

/** Columns: every top-level key, with sub-documents shown as columns spread into their keys.
 *  Past 32, `_id` and the sub-document columns asked for stay, and the last other fields go. */
export function tableColumns(t: CollTab): { columns: ResultColumn[]; total: number } {
  const docs = t.page?.docs ?? []
  const all: ResultColumn[] = []
  for (const key of topKeys(docs)) {
    if (!t.flattened.includes(key)) {
      all.push({ field: key, name: key })
      continue
    }
    const subs: string[] = []
    for (const d of docs) {
      const v = d[key]
      if (v !== undefined && bsonType(v) === 'object') for (const s of Object.keys(v as JsonObject)) if (!subs.includes(s)) subs.push(s)
    }
    all.push(...(subs.length ? subs.map((s) => ({ field: key, sub: s, name: `${key}.${s}` })) : [{ field: key, name: key }]))
  }
  const keep = [...all]
  for (let i = keep.length - 1; keep.length > MAX_COLUMNS && i >= 0; i--) {
    const c = keep[i]!
    if (c.field !== '_id' && c.sub === undefined) keep.splice(i, 1)
  }
  return { columns: keep.slice(0, MAX_COLUMNS), total: all.length }
}

/** Orca needs column keys of 1 to 64 characters, each used once. A column's key is its dotted
 *  name when that fits; an empty or long name, or one that repeats (a top-level `a.b` next to `a`
 *  shown as columns), gets its place instead (`#3`). */
export function columnKeys(columns: readonly ResultColumn[]): string[] {
  const used = new Set<string>()
  return columns.map((c, i) => {
    let key = c.name && c.name.length <= 64 && !used.has(c.name) ? c.name : `#${i}`
    while (used.has(key)) key = `${key}'`
    used.add(key)
    return key
  })
}

function cellValue(doc: JsonObject, column: ResultColumn): JsonValue | undefined {
  const v = doc[column.field]
  if (column.sub === undefined) return v
  return v !== undefined && isObject(v) && bsonType(v) === 'object' ? v[column.sub] : undefined
}

type Columns = ReturnType<typeof tableColumns>

function ResultTable({ t, cols }: { t: CollTab; cols: Columns }): OrcaNode {
  const docs = t.page?.docs ?? []
  const { columns: shown, total } = cols
  const colKeys = columnKeys(shown)
  const columns: TableColumn[] = shown.map((c, i) => ({ key: colKeys[i]!, label: c.name || '(empty name)', sortable: true, minWidth: c.field === '_id' ? 'md' : 'sm' }))
  const keys = rowKeys(docs)
  const rows: TableRow[] = docs.map((d, i) => {
    const cells: TableRow['cells'] = {}
    shown.forEach((c, j) => {
      const v = cellValue(d, c)
      cells[colKeys[j]!] = v === undefined ? '' : valueText(v, 80)
    })
    return { key: keys[i]!, cells }
  })
  const sorted = currentSort(t)
  const sortAt = sorted ? shown.findIndex((c) => c.name === sorted.column) : -1
  const sort = sorted && sortAt >= 0 ? { column: colKeys[sortAt]!, direction: sorted.direction } : undefined
  const objectColumns = topKeys(docs).filter((k) => k !== '' && k.length <= 1000 && docs.some((d) => d[k] !== undefined && bsonType(d[k]!) === 'object'))
  return (
    <Box gap="xs">
      <Table
        label="Documents"
        columns={columns}
        rows={rows}
        {...(sort ? { sort } : {})}
        selectionMode={canFilterBySelection(t) ? 'multiple' : 'single'}
        selected={t.selectedRows}
        loading={t.loading}
        emptyText="No documents match."
        maxHeight="lg"
        onSortChange={({ column, direction }) => {
          const c = shown[colKeys.indexOf(column)]
          if (c) void guard(t.id, () => sortBy(t.id, c.name, direction))()
        }}
        onSelectionChange={({ keys: sel }) => change(t.id, (x) => ({ ...dropBulkPreview(x), selectedRows: sel, confirmDelete: undefined }))}
        onRowAction={({ key }) => {
          const i = keys.indexOf(key)
          const d = docs[i]
          if (!d || !('_id' in d)) return
          if (!t.readOnly) void guard(t.id, () => editDocument(t.id, d._id!))()
          else if (canOpenDocuments(t)) void guard(t.id, () => openDocument(t.id, d._id!))()
          else setResultView(t.id, 'tree', { treeExpanded: [`r${i}`], treeSelected: `r${i}` })
        }}
      />
      {total > shown.length ? <Text size="xs" muted>{`Showing ${shown.length} of ${total} columns, as many as Orca draws. Tree, JSON and Open show every field.`}</Text> : null}
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

/** Open (over the results) and Open in a tab, for one document of the collection. */
function OpenButtons({ t, doc }: { t: CollTab; doc: JsonObject | undefined }): OrcaNode {
  if (!doc || !('_id' in doc) || !canOpenDocuments(t)) return null
  return (
    <>
      <Button size="sm" icon="expand" variant="ghost" onPress={guard(t.id, () => openDocument(t.id, doc._id!))}>Open</Button>
      <IconButton icon="file-text" label="Open in a tab" size="sm" variant="ghost" onPress={guard(t.id, () => openDocumentTab(t.id, doc._id!))} />
    </>
  )
}

function TableActions({ t, cols }: { t: CollTab; cols: Columns }): OrcaNode {
  const docs = selectedDocs(t)
  if (docs.length === 0) {
    // Filtering goes with opening: both need the tab's own query (not shell results or a
    // pipeline), and every tab that can edit has one.
    const hint = !t.readOnly
      ? 'Select rows to open, edit, clone, delete or filter by. Enter on a row edits it.'
      : canFilterBySelection(t)
        ? 'Select a row to open it, or rows to filter by. Enter on a row opens it.'
        : 'Select a row to look at it in the Tree view.'
    return <Text muted size="xs">{hint}</Text>
  }
  const one = docs.length === 1 ? docs[0]! : undefined
  const hasId = docs.every((d) => '_id' in d)
  const copy = hasId && !t.shell ? (
    <IconButton icon="copy" label={`Copy ${docs.length === 1 ? 'this document' : `these ${docs.length} documents`}, to paste into another collection`} size="sm" variant="ghost" onPress={() => {
      copyToClipboard({ kind: 'documents', ns: t.ns, ids: docs.map((d) => d._id!) })
      say(t.id, 'neutral', `Copied ${docs.length} document${docs.length === 1 ? '' : 's'}. Select a collection or database in the tree and press Paste.`)
    }} />
  ) : null
  if (t.readOnly) {
    return (
      <Box gap="xs">
        <Toolbar label="Row actions" gap="xs">
          <OpenButtons t={t} doc={one} />
          {one ? <Button size="sm" icon="search" variant="ghost" onPress={() => {
                const key = treeKey(t.page!.docs.indexOf(one), [])
                setResultView(t.id, 'tree', { treeExpanded: [key], treeSelected: key })
              }}>Show in Tree</Button> : null}
          {copy}
        </Toolbar>
        <FilterBySelection t={t} docs={docs} cols={cols} />
      </Box>
    )
  }
  // Orca refuses a Select option with an empty value, and $set can't name an empty field either.
  const fields = one ? Object.keys(one).filter((k) => k !== '_id' && k !== '' && k.length <= 1000) : []
  return (
    <Box gap="xs">
      <Toolbar label="Row actions" gap="xs">
        {one && hasId ? <Button size="sm" icon="edit" onPress={guard(t.id, () => editDocument(t.id, one._id!))}>Edit document</Button> : null}
        <OpenButtons t={t} doc={one} />
        {one && hasId ? <Button size="sm" icon="copy" variant="ghost" onPress={guard(t.id, () => cloneDocument(t.id, one._id!))}>Clone</Button> : null}
        {hasId && docs.length > 1 && canUpdateMany(t) ? (
          <Button size="sm" icon="edit" variant="ghost" onPress={() => openUpdateMany(t.id, 'selection')}>{`Update ${docs.length}`}</Button>
        ) : null}
        {hasId ? (
          <Button size="sm" icon="delete" variant="ghost" tone="danger" onPress={guard(t.id, () => askDelete(t.id))}>
            {docs.length === 1 ? 'Delete' : `Delete ${docs.length}`}
          </Button>
        ) : null}
        {copy}
      </Toolbar>
      {one && hasId ? (
        <Row gap="xs" align="end" wrap>
          <Select label="Edit a field" value="" placeholder="Choose a field to edit…" options={fields.map((f) => ({ value: f, label: f }))} onChange={(f) => void guard(t.id, () => editField(t.id, one._id!, [f]))()} />
          <Button size="sm" icon="add" variant="ghost" onPress={() => addField(t.id, one._id!)}>Add field</Button>
        </Row>
      ) : null}
      {!hasId ? <Text muted size="xs">Documents without an _id (from a projection or a view) can't be edited here.</Text> : null}
      <FilterBySelection t={t} docs={docs} cols={cols} />
    </Box>
  )
}

/** The longest filter shown before it is cut short; the filter run is the whole of it. */
const FILTER_PREVIEW_MAX = 300

/** Filter by the selected rows: pick columns, and their values in those rows become the filter,
 *  an equality per column or an `$in` where the rows differ. Orca's Table selects rows, not
 *  cells, so the columns are picked here. */
function FilterBySelection({ t, docs, cols }: { t: CollTab; docs: JsonObject[]; cols: Columns }): OrcaNode {
  if (!canFilterBySelection(t)) return null
  const options = cols.columns.filter(filterablePath)
  if (!options.length) return null
  // The page shows what the projection returned, but the filter matches stored documents: a
  // column the projection changes would build a filter that misses the rows it came from.
  const usable = (c: ResultColumn): boolean => projectionKeeps(t.spec?.projection, c.name)
  const chosen = options.filter((c) => t.filterColumns.includes(c.name) && usable(c))
  const built = chosen.length ? filterFromRows(docs, chosen) : undefined
  const text = built?.filter ? toShellInline(built.filter) : ''
  const error = built?.error ?? (text.length > QUERY_TEXT_MAX ? `This filter would be ${text.length.toLocaleString('en-US')} characters, and the query history keeps up to ${QUERY_TEXT_MAX.toLocaleString('en-US')}. Select fewer rows.` : undefined)
  const filter = error ? undefined : built?.filter
  return (
    <Box gap="xs">
      <Row gap="xs" align="end" wrap>
        <Select
          label="Filter by"
          value=""
          placeholder={chosen.length ? chosen.map((c) => c.name).join(', ') : 'Choose columns…'}
          options={options.map((c) => ({
            value: c.name,
            label: !usable(c) ? `${c.name} (changed by the projection)` : t.filterColumns.includes(c.name) ? `${c.name} (remove)` : c.name,
            disabled: !usable(c)
          }))}
          onChange={(name) => toggleFilterColumn(t.id, name)}
        />
        <Button size="sm" icon="filter" variant="ghost" disabled={!filter} onPress={guard(t.id, () => filterBySelection(t.id, filter!, 'replace'))}>Replace filter</Button>
        <Button size="sm" icon="add" variant="ghost" disabled={!filter} onPress={guard(t.id, () => filterBySelection(t.id, filter!, 'merge'))}>Add to filter</Button>
      </Row>
      {error ? (
        <Text size="xs" tone="danger">{error}</Text>
      ) : filter ? (
        <Text size="xs" muted>{text.length > FILTER_PREVIEW_MAX ? `${text.slice(0, FILTER_PREVIEW_MAX - 1)}…` : text}</Text>
      ) : (
        <Text size="xs" muted>Choose columns: their values in the selected rows become the filter.</Text>
      )}
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
      {!path.length ? <OpenButtons t={t} doc={doc} /> : null}
      {path.length && !path.some((p) => typeof p === 'number') ? (
        <Button size="sm" icon="filter" variant="ghost" onPress={() => addToQuery(t.id, path, value)}>Add to query</Button>
      ) : null}
      {value !== undefined ? <Badge>{BSON_TYPE_LABELS[bsonType(value)]}</Badge> : null}
    </Toolbar>
  )
}

const VIEWS = Object.entries(RESULT_VIEWS).map(([value, label]) => ({ value: value as ResultView, label }))

export function Results({ t }: { t: CollTab }): OrcaNode {
  if (!t.page && t.loading) return <Skeleton lines={6} label="Running the query" />
  if (!t.page) return null
  const p = t.page
  // Worked out once: the table and its Filter by both use the columns.
  const cols = t.resultView === 'table' ? tableColumns(t) : undefined
  return (
    <Box gap="sm">
      <Row gap="xs" align="center" justify="between" wrap>
        <Toolbar label="Show results as" gap="xs">
          {VIEWS.map((v) => (
            <Button key={v.value} size="sm" variant={t.resultView === v.value ? 'solid' : 'ghost'} tone={t.resultView === v.value ? 'accent' : 'neutral'} onPress={() => setResultView(t.id, v.value)}>
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
      ) : cols ? (
        <ResultTable t={t} cols={cols} />
      ) : t.resultView === 'tree' ? (
        <ResultTree t={t} />
      ) : (
        <ResultJson t={t} />
      )}
      {p.docs.length && cols ? <TableActions t={t} cols={cols} /> : null}
      {p.docs.length && t.resultView === 'tree' ? <TreeActions t={t} /> : null}
    </Box>
  )
}
