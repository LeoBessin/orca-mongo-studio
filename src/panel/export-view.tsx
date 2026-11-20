// The Export tab: what is exported, the format and its options, where it goes, and the job.
import {
  Box,
  Button,
  Callout,
  Checkbox,
  Field,
  IconButton,
  Input,
  RadioGroup,
  read,
  Row,
  Select,
  Table,
  Text,
  Toolbar,
  type OrcaNode
} from 'orca'
import { adminTabs, aguard, changeAdmin, closeAdmin, numberText } from './admin-state'
import { NoticeBar } from './admin-notice'
import { openNamespace } from './collection-state'
import { jobRunning } from './data-state'
import { cancelExport, exportProblems, loadFields, moveField, saveExport, setExport, setFields, exportPlaces, sourceDetail, startExport, type ExportTab } from './export-state'
import { DELIMITERS } from './import-state'
import { TaskSaver } from './tasks-view'
import { JobProgress } from './job-view'
import { connections } from './state'
import { PlaceLine } from './place-view'
import { GAP } from './layout'

function QueryFields({ t }: { t: ExportTab }): OrcaNode {
  if (t.from.kind !== 'query') return null
  const field = (key: keyof ExportTab['query'], label: string, placeholder: string): OrcaNode => {
    const error = t.queryErrors[key]
    return (
      <Field label={label} {...(error ? { error } : {})}>
        <Input label={label} labelHidden value={t.query[key]} placeholder={placeholder} invalid={Boolean(error)} onChange={(v) => setExport(t.id, (x) => ({ query: { ...x.query, [key]: v }, queryErrors: { ...x.queryErrors, [key]: undefined } }))} />
      </Field>
    )
  }
  return (
    <Box gap={GAP.group}>
      {field('filter', 'Filter', '{} for every document')}
      <Box columns={3} gap="xs">
        {field('projection', 'Projection', '{ name: 1 }')}
        {field('sort', 'Sort', '{ _id: 1 }')}
        {field('limit', 'Limit', '0 (none)')}
      </Box>
    </Box>
  )
}

function CsvOptions({ t }: { t: ExportTab }): OrcaNode {
  const c = t.csv
  const sel = c.selected.filter((f) => c.fields.includes(f))
  const one = sel.length === 1 ? sel[0]! : undefined
  const missing = (c.available ?? []).filter((f) => !c.fields.includes(f))
  return (
    <Box gap={GAP.group}>
      <Row gap="xs" align="end">
        <Select label="Delimiter" value={c.delimiter} options={DELIMITERS} onChange={(v) => setExport(t.id, { csv: { ...c, delimiter: v } })} />
        <Box grow>
          <Checkbox label="A first row with the field names" checked={c.header} onChange={(header) => setExport(t.id, { csv: { ...c, header } })} />
        </Box>
      </Row>
      <Table
        label="Columns"
        columns={[
          { key: 'n', label: '#', width: 'xs', align: 'end' },
          { key: 'field', label: 'Field' }
        ]}
        rows={c.fields.map((f, i) => ({ key: f, cells: { n: i + 1, field: f } }))}
        selectionMode="multiple"
        selected={sel}
        emptyText={t.from.kind === 'database' ? 'Each collection writes the fields of its first 1,000 documents.' : 'No columns chosen: the fields of the first 1,000 documents are used. Load the fields to choose.'}
        maxHeight="sm"
        onSelectionChange={({ keys }) => changeAdmin(t.id, 'export', (x) => ({ csv: { ...x.csv, selected: keys } }))}
      />
      <Toolbar label="Column actions" gap="xs">
        {t.from.kind !== 'database' ? <Button size="sm" icon="search" variant="ghost" disabled={c.loading} onPress={aguard(t.id, () => loadFields(t.id))}>{c.loading ? 'Sampling…' : 'Load the fields'}</Button> : null}
        {one ? <IconButton icon="expand" label="Move up" size="sm" variant="ghost" onPress={() => moveField(t.id, one, -1)} /> : null}
        {one ? <IconButton icon="collapse" label="Move down" size="sm" variant="ghost" onPress={() => moveField(t.id, one, 1)} /> : null}
        {sel.length ? <Button size="sm" icon="remove" variant="ghost" onPress={() => setFields(t.id, c.fields.filter((f) => !sel.includes(f)))}>{`Remove ${sel.length}`}</Button> : null}
        {c.fields.length ? <Button size="sm" icon="delete" variant="ghost" onPress={() => setFields(t.id, [])}>Clear</Button> : null}
      </Toolbar>
      <Row gap="xs" align="end">
        <Box grow>
          {missing.length ? (
            <Select label="Add a field" value="" placeholder={`${missing.length} more sampled`} options={missing.map((f) => ({ value: f, label: f }))} onChange={(f) => setFields(t.id, [...c.fields, f])} />
          ) : (
            <Input label="Add a field" placeholder="address.city" value={c.add} onChange={(v) => changeAdmin(t.id, 'export', (x) => ({ csv: { ...x.csv, add: v } }))} onSubmit={(v) => setExport(t.id, (x) => ({ csv: { ...x.csv, add: '', fields: [...new Set([...x.csv.fields, v.trim()].filter(Boolean))] } }))} />
          )}
        </Box>
      </Row>
      <Text size="xs" muted>Dates are written as ISO 8601 and ObjectIds as hex; arrays and sub-documents as Extended JSON, which Import reads back.</Text>
    </Box>
  )
}

function TargetOptions({ t }: { t: ExportTab }): OrcaNode {
  const x = t.target
  const conns = read(connections)?.connections ?? []
  const many = t.from.kind === 'database'
  return (
    <Box gap={GAP.group}>
      <Select label="Connection" value={x.connectionId} options={conns.map((c) => ({ value: c.id, label: c.name }))} onChange={(v) => setExport(t.id, { target: { ...x, connectionId: v } })} />
      <Box columns={many ? 1 : 2} gap="xs">
        <Input label="Database" value={x.db} onChange={(v) => setExport(t.id, { target: { ...x, db: v } })} />
        {many ? null : <Input label="Collection" value={x.collection} onChange={(v) => setExport(t.id, { target: { ...x, collection: v } })} />}
      </Box>
      {many ? <Text size="xs" muted>Each collection keeps its name; views are created again as views.</Text> : null}
      <RadioGroup
        label="When the documents are there already"
        value={x.mode}
        options={[
          { value: 'insert', label: 'Insert', description: 'A document whose _id is taken is an error' },
          { value: 'upsert', label: 'Replace by _id', description: 'Replace the document with the same _id, or insert it' },
          { value: 'merge', label: 'Merge by _id', description: 'Set the copied fields on it, or insert it' },
          { value: 'replace', label: many ? 'Drop each collection first' : 'Drop the collection first', description: 'Its documents and indexes are deleted, then the copy writes' }
        ]}
        onChange={(v) => setExport(t.id, { target: { ...x, mode: v as ExportTab['target']['mode'] } })}
      />
      {t.from.kind !== 'pipeline' ? (
        <Box gap={GAP.tight}>
          <Checkbox label="Copy the indexes" checked={x.indexes} onChange={(indexes) => setExport(t.id, { target: { ...x, indexes } })} />
          <Checkbox label="Create a new collection with the same options" description="Capped size, validation, collation, time series" checked={x.options} onChange={(options) => setExport(t.id, { target: { ...x, options } })} />
        </Box>
      ) : null}
    </Box>
  )
}

const FORMATS = [
  { value: 'json', label: 'JSON', description: 'Extended JSON, as mongoexport writes' },
  { value: 'csv', label: 'CSV', description: 'Chosen fields, one column each' },
  { value: 'bson', label: 'BSON', description: 'As mongodump writes, for mongorestore' },
  { value: 'collection', label: 'Another collection', description: 'On this or another connection' }
]

export function ExportTabView({ id }: { id: string }): OrcaNode {
  const t = read(adminTabs)[id]
  if (!t || t.kind !== 'export') return null
  const running = jobRunning(t.job)
  const problems = exportProblems(t)
  const many = t.from.kind === 'database'
  const copied = t.job?.state?.status === 'done' && t.format === 'collection' && !many
  return (
    <Box gap={GAP.section}>
      <Row gap="xs" align="center" justify="between">
        <Box gap="none" grow>
          <Text weight="semibold" truncate>{t.format === 'collection' ? 'Copy' : 'Export'}</Text>
          <PlaceLine places={exportPlaces(t)} detail={sourceDetail(t)} />
        </Box>
        <IconButton icon="close" label="Close the export" variant="ghost" size="sm" onPress={() => closeAdmin(t.id)} />
      </Row>
      <QueryFields t={t} />
      {t.from.kind === 'pipeline' ? <Text size="xs" muted>The pipeline as it was when Export was pressed. Export again from the aggregation tab after changing it.</Text> : null}
      <RadioGroup label="Format" value={t.format} options={FORMATS} onChange={(v) => setExport(t.id, { format: v as ExportTab['format'] })} />
      {t.format === 'json' ? (
        <Box gap={GAP.group}>
          <RadioGroup
            label="Layout"
            orientation="horizontal"
            value={t.json.layout}
            options={[
              { value: 'lines', label: 'One per line' },
              { value: 'array', label: 'An array' }
            ]}
            onChange={(v) => setExport(t.id, { json: { ...t.json, layout: v as 'lines' | 'array' } })}
          />
          <Checkbox label="Relaxed Extended JSON" description="Numbers and dates as plain JSON; canonical keeps every type exactly" checked={t.json.relaxed} onChange={(relaxed) => setExport(t.id, { json: { ...t.json, relaxed } })} />
          <Checkbox label="Indented" checked={t.json.pretty} onChange={(pretty) => setExport(t.id, { json: { ...t.json, pretty } })} />
        </Box>
      ) : null}
      {t.format === 'csv' ? <CsvOptions t={t} /> : null}
      {t.format === 'bson' ? <Checkbox label="Write .metadata.json with the indexes and options" description="Only when writing to a path" checked={t.bsonMetadata} onChange={(bsonMetadata) => setExport(t.id, { bsonMetadata })} /> : null}
      {t.format === 'collection' ? <TargetOptions t={t} /> : (
        <Box gap={GAP.group}>
          <RadioGroup
            label="Save to"
            value={t.destination}
            options={[
              { value: 'download', label: 'The save dialog', description: 'Up to 64 MiB', disabled: many },
              { value: 'path', label: 'A path', description: many ? 'A folder: one file per collection' : 'A file, or a folder to write into' }
            ]}
            onChange={(v) => setExport(t.id, { destination: v as ExportTab['destination'] })}
          />
          {t.destination === 'path' ? (
            <Box gap={GAP.tight}>
              <Input label={many ? 'Folder' : 'Path'} value={t.path} placeholder={many ? '~/dumps/shop' : `~/exports/${t.from.kind === 'database' ? '' : t.from.ns.collection}.${t.format === 'csv' ? 'csv' : t.format}`} onChange={(v) => setExport(t.id, { path: v })} />
              <Checkbox label="Replace an existing file" checked={t.overwrite} onChange={(overwrite) => setExport(t.id, { overwrite })} />
            </Box>
          ) : null}
        </Box>
      )}
      <NoticeBar id={t.id} notice={t.notice} />
      {t.confirm ? (
        <Callout tone="danger" icon="warning" title="Drop before copying?">
          <Box gap="sm">
            <Text>{`This drops ${t.confirm.label}${t.confirm.count === null ? '' : ` (${numberText(t.confirm.count)} documents)`}, with its indexes, and then copies into it.`}</Text>
            <Row gap="xs">
              <Button variant="solid" tone="danger" onPress={aguard(t.id, () => startExport(t.id, true))}>Drop and copy</Button>
              <Button variant="ghost" onPress={() => changeAdmin(t.id, 'export', () => ({ confirm: undefined }))}>Cancel</Button>
            </Row>
          </Box>
        </Callout>
      ) : null}
      {problems.length ? <Text size="xs" tone="danger">{problems.join(' ')}</Text> : null}
      <Row gap="xs" align="center">
        <Button variant="solid" tone="accent" icon={t.format === 'collection' ? 'copy' : 'download'} disabled={running || problems.length > 0 || Boolean(t.confirm)} onPress={aguard(t.id, () => startExport(t.id))}>
          {running ? (t.format === 'collection' ? 'Copying…' : 'Exporting…') : t.format === 'collection' ? 'Copy' : 'Export'}
        </Button>
        {copied ? (
          <Button variant="ghost" icon="open-external" onPress={aguard(t.id, () => openNamespace({ connectionId: t.target.connectionId, db: t.target.db.trim(), collection: t.target.collection.trim() }, 'coll'))}>Open the copy</Button>
        ) : null}
      </Row>
      <JobProgress box={t.job} what={t.format === 'collection' ? 'copy' : 'export'} onCancel={aguard(t.id, () => cancelExport(t.id))} onSave={aguard(t.id, () => saveExport(t.id))} />
      <TaskSaver tabId={t.id} task={t.task} taskName={t.taskName} placeholder={t.title} kinds={[{ kind: 'export', label: t.format === 'collection' ? 'Save the copy as a task' : 'Save the export as a task' }]} />
    </Box>
  )
}
