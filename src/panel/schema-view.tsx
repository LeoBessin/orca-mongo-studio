// The Schema Explorer tab. Orca has no charts, so distributions are Progress bars (types) and
// tables with text bars (histograms and common values).
import {
  Box,
  Button,
  Callout,
  Card,
  Checkbox,
  CodeView,
  Collapsible,
  files,
  IconButton,
  Input,
  KeyValue,
  Progress,
  RadioGroup,
  read,
  Row,
  Select,
  Skeleton,
  Table,
  Text,
  Toolbar,
  Tree,
  type KeyValueItem,
  type OrcaNode,
  type TreeItem
} from 'orca'
import { BSON_TYPE_LABELS } from '../shared/ejson-view'
import { bar, ELEMENT, percent, presenceText, rangeText, typeSummary, type Bucket, type SchemaField, type SchemaReport } from '../shared/schema'
import { adminTabs, aguard, changeAdmin, closeAdmin, connectionName, numberText, type SchemaTab } from './admin-state'
import { NoticeBar } from './admin-notice'
import { openManage } from './manage-state'
import { analyze, exportText, fieldKey, SAMPLE_SIZES, setExport, toggleField } from './schema-state'

function treeItems(report: SchemaReport, parent: string, expanded: Set<string>): TreeItem[] {
  return report.fields
    .filter((f) => f.parent === parent)
    .map((f) => {
      const key = fieldKey(f.path)
      const isArray = f.types.some((t) => t.type === 'array')
      const isObject = f.types.some((t) => t.type === 'object')
      const item: TreeItem = {
        key,
        label: f.name === ELEMENT ? 'elements' : f.name,
        description: `${typeSummary(f)} · ${f.name === ELEMENT ? `${numberText(f.count)} in ${numberText(f.parentCount)} arrays` : `${percent(Math.min(f.count, f.parentCount), f.parentCount)}%`}`,
        icon: isArray ? 'layers' : isObject ? 'folder' : f.types[0]?.type === 'date' ? 'calendar' : 'file-text'
      }
      const kids = report.fields.some((x) => x.parent === f.path)
      if (kids) {
        if (expanded.has(key)) item.children = treeItems(report, f.path, expanded)
        else item.hasChildren = true
      }
      return item
    })
}

function bucketRows(buckets: Bucket[], prefix: string) {
  const max = Math.max(1, ...buckets.map((b) => b.count))
  return buckets.map((b, n) => ({ key: `${prefix}${n}`, cells: { range: b.label, count: numberText(b.count), bar: bar(b.count, max, 16) } }))
}

const BAR_COLUMNS = [
  { key: 'range', label: 'Range', minWidth: 'sm' as const },
  { key: 'count', label: 'Count', width: 'xs' as const, align: 'end' as const },
  { key: 'bar', label: 'Share', width: 'md' as const, hideBelow: 'sm' as const }
]

function FieldDetails({ f }: { f: SchemaField }): OrcaNode {
  const items: KeyValueItem[] = [
    { label: 'Path', value: f.path, code: true },
    { label: 'Present', value: presenceText(f) }
  ]
  const range = rangeText(f)
  if (range) items.push({ label: 'Range', value: range })
  if (f.strings) items.push({ label: 'Length', value: f.strings.minLength === f.strings.maxLength ? `${f.strings.minLength} characters` : `${f.strings.minLength} to ${f.strings.maxLength} characters` }, { label: 'Distinct', value: `${numberText(f.strings.distinct)}${f.strings.distinctCapped ? '+' : ''}${f.strings.distinct === f.count && !f.strings.distinctCapped ? ' (every value differs)' : ''}` })
  if (f.arrays) items.push({ label: 'Array length', value: `${f.arrays.minLength} to ${f.arrays.maxLength}, ${Math.round(f.arrays.avgLength * 10) / 10} on average` })
  if (f.bools) items.push({ label: 'true / false', value: `${numberText(f.bools.true)} / ${numberText(f.bools.false)}` })
  const buckets = f.numbers?.buckets ?? f.dates?.buckets
  return (
    <Card title={f.name === ELEMENT ? `${f.parent} elements` : f.name}>
      <Box gap="sm">
        <KeyValue label={`${f.path} details`} items={items} />
        <Box gap="xs">
          {f.types.map((t) => (
            <Progress key={t.type} label={`${BSON_TYPE_LABELS[t.type]}: ${numberText(t.count)} (${percent(t.count, f.count)}%)`} value={percent(t.count, f.count)} />
          ))}
        </Box>
        {buckets && buckets.length > 1 ? <Table label={f.dates ? 'Dates' : 'Values'} columns={BAR_COLUMNS} rows={bucketRows(buckets, 'b')} maxHeight="sm" /> : null}
        {f.strings && f.strings.top.length ? (
          <Table
            label="Most common"
            columns={[{ key: 'range', label: 'Value', minWidth: 'sm' }, BAR_COLUMNS[1]!, BAR_COLUMNS[2]!]}
            rows={f.strings.top.map((v, n) => ({ key: `s${n}`, cells: { range: v.value, count: numberText(v.count), bar: bar(v.count, f.strings!.top[0]!.count, 16) } }))}
            maxHeight="sm"
          />
        ) : null}
      </Box>
    </Card>
  )
}

function Export({ t }: { t: SchemaTab }): OrcaNode {
  const text = exportText(t)
  const name = `${t.ns.collection}.schema.json`
  return (
    <Collapsible title="Export the schema" description="As a $jsonSchema validator or a JSON Schema" open={t.exportOpen} onChange={(open) => changeAdmin(t.id, 'schema', () => ({ exportOpen: open }))}>
      <Box gap="sm">
        <RadioGroup
          label="Format"
          value={t.flavor}
          options={[
            { value: 'mongo', label: 'MongoDB validator', description: '{ $jsonSchema: … } with BSON types' },
            { value: 'json', label: 'JSON Schema', description: 'Draft 2020-12, for other tools' }
          ]}
          onChange={(v) => setExport(t.id, { flavor: v as SchemaTab['flavor'] })}
        />
        <Checkbox label="Require fields every sampled document has" checked={t.required} onChange={(required) => setExport(t.id, { required })} />
        <Checkbox label="Refuse fields the sample did not have" checked={t.closed} onChange={(closed) => setExport(t.id, { closed })} />
        <CodeView label="Schema" code={text} language={t.flavor === 'mongo' ? 'javascript' : 'json'} maxHeight="md" />
        <Toolbar label="Export actions" gap="xs">
          {t.flavor === 'mongo' && t.collKind !== 'view' && t.collKind !== 'timeseries' ? (
            <Button size="sm" icon="check" variant="solid" tone="accent" onPress={aguard(t.id, () => openManage(t.ns, t.collKind, { section: 'validation', validator: text }))}>Use as validator</Button>
          ) : null}
          <Button size="sm" icon="download" variant="ghost" onPress={aguard(t.id, async () => {
            await files.saveAs({ suggestedName: t.flavor === 'mongo' ? `${t.ns.collection}.validator.js` : name, mimeType: t.flavor === 'mongo' ? 'text/javascript' : 'application/schema+json', data: text })
          })}>Save as file</Button>
        </Toolbar>
        <Text size="xs" muted>{`Built from ${numberText(t.report?.sampled ?? 0)} sampled documents: check it before using it on writes.`}</Text>
      </Box>
    </Collapsible>
  )
}

export function SchemaTabView({ id }: { id: string }): OrcaNode {
  const t = read(adminTabs)[id]
  if (!t || t.kind !== 'schema') return null
  const r = t.report
  const selected = r?.fields.find((f) => fieldKey(f.path) === t.selected)
  const expanded = new Set(t.expanded)
  return (
    <Box gap="sm">
      <Row gap="xs" align="center" justify="between">
        <Box gap="none" grow>
          <Text weight="semibold" truncate>{`Schema of ${t.ns.db}.${t.ns.collection}`}</Text>
          <Text size="xs" muted truncate>{connectionName(t.connectionId)}</Text>
        </Box>
        <IconButton icon="close" label={`Close the schema of ${t.ns.collection}`} variant="ghost" size="sm" onPress={() => closeAdmin(t.id)} />
      </Row>
      <Row gap="xs" align="end">
        <Box grow>
          <Input label="Filter" placeholder="{ status: 'shipped' }" value={t.filter} invalid={Boolean(t.filterError)} onChange={(v) => changeAdmin(t.id, 'schema', () => ({ filter: v, filterError: undefined }))} onSubmit={() => void aguard(t.id, () => analyze(t.id))()} />
        </Box>
        <Select label="Sample" value={String(t.size)} options={SAMPLE_SIZES.map((n) => ({ value: String(n), label: `${numberText(n)} documents` }))} onChange={(v) => changeAdmin(t.id, 'schema', () => ({ size: Number(v) }))} />
      </Row>
      {t.filterError ? <Text size="xs" tone="danger">{t.filterError}</Text> : null}
      <Row gap="xs" align="center" justify="between">
        <Button variant="solid" tone="accent" icon="play" disabled={t.loading} onPress={aguard(t.id, () => analyze(t.id))}>{t.loading ? 'Sampling…' : r ? 'Sample again' : 'Analyze'}</Button>
        {r ? <Text size="xs" muted>{`${numberText(r.sampled)} document${r.sampled === 1 ? '' : 's'} · ${numberText(r.fields.length)} fields · ${numberText(r.ms)} ms`}</Text> : null}
      </Row>
      <NoticeBar id={t.id} notice={t.notice} />
      {t.error ? <Callout tone="danger" icon="error" title="Could not sample">{t.error}</Callout> : null}
      {t.loading && !r ? <Skeleton lines={6} label="Sampling documents" /> : null}
      {r && r.sampled === 0 ? <Callout tone="neutral" icon="info">No documents matched, so there is nothing to describe.</Callout> : null}
      {r?.fieldsCapped ? <Text size="xs" tone="warning">These documents have very many fields: the deepest and rarest are left out.</Text> : null}
      {r && r.sampled > 0 ? (
        <Box gap="sm">
          <Tree
            label="Fields"
            items={treeItems(r, '', expanded)}
            expanded={t.expanded}
            {...(t.selected ? { selected: t.selected } : {})}
            maxHeight="lg"
            onToggle={({ key, expanded: open }) => toggleField(t.id, key, open)}
            onSelect={({ key }) => changeAdmin(t.id, 'schema', () => ({ selected: key }))}
          />
          {selected ? <FieldDetails f={selected} /> : <Text size="xs" muted>Select a field for its types, histogram and most common values.</Text>}
          <Export t={t} />
        </Box>
      ) : null}
    </Box>
  )
}
