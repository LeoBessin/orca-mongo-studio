// One collection tab: the query bar, the Query Builder, the results with their editors, and the
// query history and saved queries.
import {
  Badge,
  Box,
  Button,
  Callout,
  Collapsible,
  Field,
  IconButton,
  Input,
  read,
  Row,
  Select,
  Separator,
  Table,
  Text,
  Textarea,
  Toolbar,
  type OrcaNode
} from 'orca'
import type { QueryText } from '../protocol'
import { openManage } from './manage-state'
import { openCompare } from './compare-state'
import { openExport, queryText } from './export-state'
import { openImport } from './import-state'
import { openSchema } from './schema-state'
import { stagesFromFind } from '../shared/pipeline'
import { needsValue, newCondition, emptyGroup, mapGroup, OPERATORS, removeItem, updateCondition, countConditions, type Condition, type Group, type Operator } from '../shared/query-builder'
import {
  applyBuilder,
  change,
  clearHistory,
  compactField,
  formatField,
  isMultiline,
  closeTab,
  collTabs,
  deleteSaved,
  insertDocument,
  canUpdateMany,
  openUpdateMany,
  loadBuilderFromFilter,
  nsLabel,
  resetQuery,
  runQuery,
  sampledFields,
  saveQuery,
  setBuilder,
  setText,
  specFromText,
  useQuery,
  type CollTab,
  type QueryField
} from './collection-state'
import { openAggregation } from './aggregate-state'
import { DocumentView } from './document-view'
import { Editors } from './editors-view'
import { UpdateMany } from './update-view'
import { ExplainSection } from './explain-view'
import { runExplain } from './explain-state'
import { guard } from './guard'
import { CodeSection, tabOperation } from './shell-view'
import { Results } from './results-view'
import { connections } from './state'
import { PlaceLine } from './place-view'
import { settings } from './settings-state'
import { COLLECTION_PLACES, TabNoticeView } from './notice-view'
import { GAP } from './layout'

function QueryInput({ t, field, label, placeholder }: { t: CollTab; field: QueryField; label: string; placeholder: string }): OrcaNode {
  const error = t.fieldErrors[field]
  const value = t.text[field]
  const box = { label, labelHidden: true, placeholder, value, invalid: Boolean(error), onChange: (v: string) => setText(t.id, field, v), onSubmit: () => void guard(t.id, () => runQuery(t.id))() }
  // Skip and limit are numbers: nothing to format.
  const formats = field !== 'skip' && field !== 'limit'
  const multi = formats && isMultiline(t, field)
  // With the Format buttons turned off in Settings, a one-line field has none; a multi-line one
  // keeps "one line", so it can always be put back.
  const button = formats && (multi || settings().formatButtons)
  const name = label.toLowerCase()
  const input = multi ? <Textarea {...box} rows={Math.min(12, Math.max(3, value.split('\n').length))} /> : <Input {...box} />
  return (
    <Field label={label} {...(error ? { error } : multi ? { description: 'Ctrl+Enter or Cmd+Enter runs the query.' } : {})}>
      {button ? (
        <Box direction="row" gap="xs" align="start">
          <Box grow>{input}</Box>
          {multi ? (
            <IconButton icon="collapse" label={`Put the ${name} on one line`} variant="ghost" size="sm" onPress={() => compactField(t.id, field)} />
          ) : (
            <IconButton icon="code" label={`Format the ${name} on several lines`} variant="ghost" size="sm" disabled={!value.trim()} onPress={() => formatField(t.id, field)} />
          )}
        </Box>
      ) : (
        input
      )}
    </Field>
  )
}

function QueryBar({ t }: { t: CollTab }): OrcaNode {
  const extras = [t.text.collation && 'collation', t.text.skip && `skip ${t.text.skip}`, t.text.limit && `limit ${t.text.limit}`].filter(Boolean).join(', ')
  return (
    <Box gap={GAP.group}>
      <QueryInput t={t} field="filter" label="Filter" placeholder="{ status: 'shipped', total: { $gt: 100 } }" />
      <Box columns={2} gap="xs">
        <QueryInput t={t} field="projection" label="Projection" placeholder="{ name: 1, _id: 0 }" />
        <QueryInput t={t} field="sort" label="Sort" placeholder="{ createdAt: -1 }" />
      </Box>
      <Collapsible title="Collation, skip and limit" {...(extras ? { description: extras } : {})} open={t.optionsOpen} onChange={(open) => change(t.id, () => ({ optionsOpen: open }))}>
        <Box gap={GAP.group}>
          <QueryInput t={t} field="collation" label="Collation" placeholder="{ locale: 'fr', strength: 2 }" />
          <Box columns={2} gap="xs">
            <QueryInput t={t} field="skip" label="Skip" placeholder="0" />
            <QueryInput t={t} field="limit" label="Limit" placeholder="0 (none)" />
          </Box>
        </Box>
      </Collapsible>
    </Box>
  )
}

// ---- Query Builder ----

function ConditionRow({ t, c, fields }: { t: CollTab; c: Condition; fields: string[] }): OrcaNode {
  const set = (values: Partial<Omit<Condition, 'kind' | 'id'>>): void => setBuilder(t.id, updateCondition(t.builder, c.id, values))
  const problem = t.builderProblems.find((p) => p.id === c.id)
  const known = fields.includes(c.field)
  return (
    <Box gap={GAP.group} padding="sm" border={problem ? 'danger' : true} radius="sm">
      <Row gap="xs" align="end">
        {known || (c.field === '' && fields.length) ? (
          <Select label="Field" value={c.field} placeholder="Field…" options={[...fields.map((f) => ({ value: f, label: f })), { value: '\u0000other', label: 'Another field…' }]} onChange={(v) => set({ field: v === '\u0000other' ? ' ' : v })} />
        ) : (
          <Input label="Field" value={c.field.trim()} placeholder="a.b.c" onChange={(v) => set({ field: v })} />
        )}
        <IconButton icon="close" label="Remove condition" variant="ghost" size="sm" onPress={() => setBuilder(t.id, removeItem(t.builder, c.id))} />
      </Row>
      <Row gap="xs" align="end">
        <Select label="Operator" value={c.op} options={OPERATORS.map((o) => ({ value: o.value, label: o.label }))} onChange={(v) => set({ op: v as Operator })} />
        {needsValue(c.op) ? <Input label="Value" value={c.value} placeholder={c.op === 'in' || c.op === 'nin' ? "['a', 'b']" : c.op === 'regex' ? '/^abc/i' : "'text', 42, ObjectId('…')"} invalid={Boolean(problem)} onChange={(v) => set({ value: v })} onSubmit={() => void guard(t.id, () => applyBuilder(t.id))()} /> : null}
      </Row>
      {problem ? <Text size="xs" tone="danger">{problem.message}</Text> : null}
    </Box>
  )
}

function GroupBlock({ t, g, fields, depth }: { t: CollTab; g: Group; fields: string[]; depth: number }): OrcaNode {
  return (
    <Box gap={GAP.group} {...(depth > 0 ? { padding: 'sm' as const, border: true, radius: 'md' as const, background: 'muted' as const } : {})}>
      <Row gap="xs" align="end" justify="between">
        <Select
          label={depth === 0 ? 'Match' : 'Group'}
          value={g.join}
          options={[
            { value: 'and', label: 'All of these (AND)' },
            { value: 'or', label: 'Any of these (OR)' }
          ]}
          onChange={(v) => setBuilder(t.id, mapGroup(t.builder, g.id, (x) => ({ ...x, join: v as 'and' | 'or' })))}
        />
        {depth > 0 ? <IconButton icon="close" label="Remove group" variant="ghost" size="sm" onPress={() => setBuilder(t.id, removeItem(t.builder, g.id))} /> : null}
      </Row>
      {g.items.map((item) => (item.kind === 'cond' ? <ConditionRow key={item.id} t={t} c={item} fields={fields} /> : <GroupBlock key={item.id} t={t} g={item} fields={fields} depth={depth + 1} />))}
      <Row gap="xs">
        <Button size="sm" icon="add" variant="ghost" onPress={() => setBuilder(t.id, mapGroup(t.builder, g.id, (x) => ({ ...x, items: [...x.items, newCondition(fields.find((f) => f !== '_id') ?? '')] })))}>
          Condition
        </Button>
        {depth < 3 ? (
          <Button size="sm" icon="add" variant="ghost" onPress={() => setBuilder(t.id, mapGroup(t.builder, g.id, (x) => ({ ...x, items: [...x.items, { ...emptyGroup(x.join === 'and' ? 'or' : 'and'), items: [newCondition(fields.find((f) => f !== '_id') ?? '')] }] })))}>
            Group
          </Button>
        ) : null}
      </Row>
    </Box>
  )
}

function Builder({ t }: { t: CollTab }): OrcaNode {
  const n = countConditions(t.builder)
  const fields = sampledFields(t)
  return (
    <Collapsible title="Query Builder" description={n ? `${n} condition${n === 1 ? '' : 's'}` : 'Build a filter from fields and operators'} open={t.builderOpen} onChange={(open) => change(t.id, () => ({ builderOpen: open }))}>
      <Box gap="sm">
        <TabNoticeView id={t.id} at="builder" places={COLLECTION_PLACES} />
        <GroupBlock t={t} g={t.builder} fields={fields} depth={0} />
        {fields.length === 0 ? <Text size="xs" muted>Run a query to list the fields of its results here.</Text> : null}
        <Row gap="xs" wrap>
          <Button size="sm" variant="solid" tone="accent" icon="play" disabled={n === 0} onPress={guard(t.id, () => applyBuilder(t.id))}>Apply to filter and run</Button>
          <Button size="sm" variant="ghost" icon="download" onPress={() => loadBuilderFromFilter(t.id)}>Load from filter</Button>
          {n ? <Button size="sm" variant="ghost" icon="delete" onPress={() => setBuilder(t.id, emptyGroup())}>Clear</Button> : null}
        </Row>
      </Box>
    </Collapsible>
  )
}

// ---- History and saved queries ----

function summary(q: QueryText): string {
  const parts = [q.filter.trim() || '{}']
  if (q.projection.trim()) parts.push(`project ${q.projection.trim()}`)
  if (q.sort.trim()) parts.push(`sort ${q.sort.trim()}`)
  if (q.skip.trim()) parts.push(`skip ${q.skip.trim()}`)
  if (q.limit.trim()) parts.push(`limit ${q.limit.trim()}`)
  return parts.join(' · ')
}

function Library({ t }: { t: CollTab }): OrcaNode {
  const lib = t.library
  const saved = lib?.saved ?? []
  const history = lib?.history ?? []
  const sel = t.librarySelected
  const selSaved = sel?.startsWith('s:') ? saved.find((s) => `s:${s.name}` === sel) : undefined
  const selHistory = sel?.startsWith('h:') ? history[Number(sel.slice(2))] : undefined
  return (
    <Collapsible title="History and saved queries" description={`${saved.length} saved · ${history.length} recent`}>
      <Box gap="sm">
        <TabNoticeView id={t.id} at="library" places={COLLECTION_PLACES} />
        <Row gap="xs" align="end">
          <Input label="Save this query as" placeholder="Name" value={t.saveName} onChange={(v) => change(t.id, () => ({ saveName: v }))} onSubmit={() => void guard(t.id, () => saveQuery(t.id))()} />
          <Button icon="star" disabled={!t.saveName.trim()} onPress={guard(t.id, () => saveQuery(t.id))}>Save</Button>
        </Row>
        <Table
          label="Saved queries"
          columns={[
            { key: 'name', label: 'Name', width: 'sm' },
            { key: 'query', label: 'Query' }
          ]}
          rows={saved.map((s) => ({ key: `s:${s.name}`, cells: { name: s.name, query: summary(s.query) } }))}
          selectionMode="single"
          selected={selSaved ? [sel!] : []}
          emptyText="No saved queries for this collection."
          maxHeight="sm"
          onSelectionChange={({ keys }) => change(t.id, () => ({ librarySelected: keys[0] }))}
          onRowAction={({ key }) => {
            const s = saved.find((x) => `s:${x.name}` === key)
            if (s) void guard(t.id, () => useQuery(t.id, s.query))()
          }}
        />
        <Table
          label="Recent queries"
          columns={[
            { key: 'at', label: 'When', width: 'sm' },
            { key: 'query', label: 'Query' }
          ]}
          rows={history.map((h, i) => ({ key: `h:${i}`, cells: { at: { type: 'relative', at: h.at, format: 'short' }, query: summary(h.query) } }))}
          selectionMode="single"
          selected={selHistory ? [sel!] : []}
          emptyText="Queries you run here are listed here."
          maxHeight="sm"
          onSelectionChange={({ keys }) => change(t.id, () => ({ librarySelected: keys[0] }))}
          onRowAction={({ key }) => {
            const h = history[Number(key.slice(2))]
            if (h) void guard(t.id, () => useQuery(t.id, h.query))()
          }}
        />
        <Toolbar label="Query library actions" gap="xs">
          <Button size="sm" icon="play" disabled={!selSaved && !selHistory} onPress={guard(t.id, () => useQuery(t.id, (selSaved ?? selHistory)!.query))}>Run selected</Button>
          {selSaved ? <Button size="sm" icon="delete" variant="ghost" tone="danger" onPress={guard(t.id, () => deleteSaved(t.id, selSaved.name))}>Delete saved query</Button> : null}
          <Button size="sm" icon="remove" variant="ghost" disabled={history.length === 0} onPress={guard(t.id, () => clearHistory(t.id))}>Clear history</Button>
        </Toolbar>
      </Box>
    </Collapsible>
  )
}

// ---- The tab ----

/** The aggregation tab of this collection, started from the query in the bar when it parses. */
function openAsAggregation(t: CollTab): Promise<void> {
  const { spec } = specFromText(t.text)
  const typed = spec && (Object.keys(spec.filter).length || spec.projection || spec.sort || spec.skip || spec.limit)
  return openAggregation(t.ns, t.kind, typed ? stagesFromFind(spec) : undefined, typed ? 'the query bar' : undefined)
}

/** The Export tab, with the query in the bar (as typed: it is checked there). */
function exportQuery(t: CollTab): void {
  openExport({ kind: 'query', ns: t.ns, collKind: t.kind }, queryText(t.text))
}

const KIND_LABEL: Partial<Record<CollTab['kind'], string>> = { view: 'View · read only', timeseries: 'Time-series' }

export function CollectionTab({ id }: { id: string }): OrcaNode {
  const raw = read(collTabs)[id]
  if (!raw) return null
  // A read-only connection's tab offers no editing, like a view's (the worker refuses it anyway).
  const t = !raw.readOnly && read(connections)?.connections.find((c) => c.id === raw.ns.connectionId)?.readOnly ? { ...raw, readOnly: true } : raw
  // A document opened on its own covers the query and results until Back; a document tab is only that.
  if (t.focus) {
    return (
      <Box gap="md">
        <TabNoticeView id={t.id} />
        <DocumentView t={t} />
        <Editors t={t} />
      </Box>
    )
  }
  // Sections, top to bottom: the tab's header; the query and what runs it, with its notice and
  // error; the results with what acts on them; then the sections that open on demand.
  return (
    <Box gap="md">
      <Row gap="xs" align="center" justify="between">
        <Box gap="none" grow>
          <Text weight="semibold" truncate>{nsLabel(t.ns)}</Text>
          <PlaceLine places={[{ connectionId: t.ns.connectionId, writes: t.kind !== 'view' }]} />
          {KIND_LABEL[t.kind] ? <Row gap="xs"><Badge tone={t.kind === 'view' ? 'warning' : 'neutral'}>{KIND_LABEL[t.kind]}</Badge></Row> : null}
        </Box>
        <IconButton icon="close" label={`Close ${t.title}`} variant="ghost" size="sm" onPress={() => closeTab(t.id)} />
      </Row>
      <Box gap="sm">
        <QueryBar t={t} />
        <Toolbar label="Query actions" gap="xs">
          <Button variant="solid" tone="accent" icon="play" disabled={t.loading} onPress={guard(t.id, () => runQuery(t.id))}>
            {t.loading ? 'Running…' : 'Run'}
          </Button>
          <IconButton icon="refresh" label="Reset the query" variant="ghost" onPress={guard(t.id, () => resetQuery(t.id))} />
          <IconButton icon="gauge" label="Explain the query" variant="ghost" onPress={guard(t.id, () => runExplain(t.id))} />
          <IconButton icon="layers" label="Open in the aggregation editor" variant="ghost" onPress={guard(t.id, () => openAsAggregation(t))} />
          {t.shell ? null : <IconButton icon="download" label="Export this query: JSON, CSV, BSON or another collection" variant="ghost" onPress={guard(t.id, () => exportQuery(t))} />}
          {t.shell ? null : <IconButton icon="bar-chart-3" label="Schema of this collection" variant="ghost" onPress={guard(t.id, () => openSchema(t.ns, t.kind))} />}
          {t.shell ? null : <IconButton icon="branch" label="Compare with another collection" variant="ghost" onPress={() => openCompare(t.ns, t.kind)} />}
        </Toolbar>
        <Toolbar label="Collection actions" gap="xs">
          {!t.readOnly ? <Button size="sm" icon="add" variant="ghost" onPress={() => insertDocument(t.id)}>Insert document</Button> : null}
          {canUpdateMany(t) ? <Button size="sm" icon="edit" variant="ghost" onPress={() => openUpdateMany(t.id)}>Update many</Button> : null}
          {t.shell || t.readOnly ? null : <IconButton icon="upload" label="Import into this collection" variant="ghost" size="sm" onPress={() => openImport(t.ns)} />}
          {t.shell ? null : <IconButton icon="settings" label="Manage: indexes, validation, rename, drop" variant="ghost" size="sm" onPress={guard(t.id, () => openManage(t.ns, t.kind))} />}
        </Toolbar>
        <TabNoticeView id={t.id} at="top" places={COLLECTION_PLACES} />
        {t.error ? <Callout tone="danger" icon="error" title="The query failed">{t.error}</Callout> : null}
        <Builder t={t} />
      </Box>
      {t.page || t.loading ? <Separator /> : null}
      <Box gap={GAP.section}>
        <Results t={t} />
        <TabNoticeView id={t.id} at="results" places={COLLECTION_PLACES} />
        <Editors t={t} />
        <UpdateMany t={t} />
      </Box>
      <Separator />
      <Box gap="sm">
        <ExplainSection t={t} />
        <Separator />
        <Library t={t} />
        <Separator />
        <CodeSection op={tabOperation(t)} description="The query in the bar as driver code." />
      </Box>
    </Box>
  )
}
