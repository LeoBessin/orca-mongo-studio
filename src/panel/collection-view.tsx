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
  Table,
  Text,
  Toolbar,
  type OrcaNode
} from 'orca'
import type { QueryText } from '../protocol'
import { needsValue, newCondition, emptyGroup, mapGroup, OPERATORS, removeItem, updateCondition, countConditions, type Condition, type Group, type Operator } from '../shared/query-builder'
import {
  applyBuilder,
  change,
  clearHistory,
  closeTab,
  collTabs,
  deleteSaved,
  insertDocument,
  loadBuilderFromFilter,
  nsLabel,
  resetQuery,
  runQuery,
  sampledFields,
  saveQuery,
  setBuilder,
  setText,
  useQuery,
  type CollTab,
  type QueryField
} from './collection-state'
import { Editors } from './editors-view'
import { guard } from './guard'
import { Results } from './results-view'

function QueryInput({ t, field, label, placeholder }: { t: CollTab; field: QueryField; label: string; placeholder: string }): OrcaNode {
  const error = t.fieldErrors[field]
  return (
    <Field label={label} {...(error ? { error } : {})}>
      <Input label={label} labelHidden placeholder={placeholder} value={t.text[field]} invalid={Boolean(error)} onChange={(v) => setText(t.id, field, v)} onSubmit={() => void guard(t.id, () => runQuery(t.id))()} />
    </Field>
  )
}

function QueryBar({ t }: { t: CollTab }): OrcaNode {
  const extras = [t.text.collation && 'collation', t.text.skip && `skip ${t.text.skip}`, t.text.limit && `limit ${t.text.limit}`].filter(Boolean).join(', ')
  return (
    <Box gap="xs">
      <QueryInput t={t} field="filter" label="Filter" placeholder="{ status: 'shipped', total: { $gt: 100 } }" />
      <Box columns={2} gap="xs">
        <QueryInput t={t} field="projection" label="Projection" placeholder="{ name: 1, _id: 0 }" />
        <QueryInput t={t} field="sort" label="Sort" placeholder="{ createdAt: -1 }" />
      </Box>
      <Collapsible title="Collation, skip and limit" {...(extras ? { description: extras } : {})} open={t.optionsOpen} onChange={(open) => change(t.id, () => ({ optionsOpen: open }))}>
        <Box gap="xs">
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
    <Box gap="xs" padding="xs" border={problem ? 'danger' : true} radius="sm">
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
    <Box gap="xs" {...(depth > 0 ? { padding: 'xs' as const, border: true, radius: 'md' as const, background: 'muted' as const } : {})}>
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

const KIND_LABEL: Partial<Record<CollTab['kind'], string>> = { view: 'View · read only', timeseries: 'Time-series' }

export function CollectionTab({ id }: { id: string }): OrcaNode {
  const t = read(collTabs)[id]
  if (!t) return null
  return (
    <Box gap="sm">
      <Row gap="xs" align="center" justify="between">
        <Box gap="none" grow>
          <Text weight="semibold" truncate>{nsLabel(t.ns)}</Text>
          {KIND_LABEL[t.kind] ? <Row gap="xs"><Badge tone={t.kind === 'view' ? 'warning' : 'neutral'}>{KIND_LABEL[t.kind]}</Badge></Row> : null}
        </Box>
        <IconButton icon="close" label={`Close ${t.title}`} variant="ghost" size="sm" onPress={() => closeTab(t.id)} />
      </Row>
      <QueryBar t={t} />
      <Toolbar label="Query actions" gap="xs">
        <Button variant="solid" tone="accent" icon="play" disabled={t.loading} onPress={guard(t.id, () => runQuery(t.id))}>
          {t.loading ? 'Running…' : 'Run'}
        </Button>
        <IconButton icon="refresh" label="Reset the query" variant="ghost" onPress={guard(t.id, () => resetQuery(t.id))} />
        {!t.readOnly ? <Button icon="add" variant="ghost" onPress={() => insertDocument(t.id)}>Insert document</Button> : null}
      </Toolbar>
      <Builder t={t} />
      {t.notice ? (
        <Callout tone={t.notice.tone} icon={t.notice.tone === 'danger' ? 'error' : t.notice.tone === 'success' ? 'check' : 'info'}>
          <Row justify="between" align="center">
            <Text>{t.notice.text}</Text>
            <IconButton icon="close" label="Dismiss" variant="ghost" size="xs" onPress={() => change(t.id, () => ({ notice: undefined }))} />
          </Row>
        </Callout>
      ) : null}
      {t.error ? <Callout tone="danger" icon="error" title="The query failed">{t.error}</Callout> : null}
      <Results t={t} />
      <Editors t={t} />
      <Library t={t} />
    </Box>
  )
}
