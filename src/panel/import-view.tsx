// The Import tab: target, source (pasted or a path), format and options, a preview with the CSV
// column mapping, and the running import.
import {
  Box,
  Button,
  Callout,
  Checkbox,
  CodeView,
  Collapsible,
  IconButton,
  Input,
  RadioGroup,
  read,
  Row,
  Select,
  Table,
  Text,
  Textarea,
  Toolbar,
  type OrcaNode
} from 'orca'
import { CSV_TYPES, type CsvType } from '../shared/csv'
import { toShell } from '../shared/ejson-view'
import { adminTabs, aguard, changeAdmin, closeAdmin, connectionName, numberText } from './admin-state'
import { NoticeBar } from './admin-notice'
import { openNamespace } from './collection-state'
import { bytesText, jobRunning } from './data-state'
import { TaskSaver } from './tasks-view'
import { JobProgress } from './job-view'
import { cancelImport, DELIMITERS, importProblems, previewImport, setColumn, setImport, startImport, targetLabel, type ImportTab } from './import-state'

const FORMATS = [
  { value: 'auto', label: 'Automatic' },
  { value: 'json', label: 'JSON or mongoexport' },
  { value: 'csv', label: 'CSV' },
  { value: 'tsv', label: 'TSV' },
  { value: 'bson', label: 'BSON or mongodump' }
]

const MODES = [
  { value: 'insert', label: 'Insert', description: 'Add new documents; one whose _id is taken is an error' },
  { value: 'upsert', label: 'Replace by _id', description: 'Replace the document with the same _id, or insert it' },
  { value: 'merge', label: 'Merge by _id', description: 'Set the file\'s fields on the document with the same _id, or insert it' }
]

function Columns({ t }: { t: ImportTab }): OrcaNode {
  const cols = t.columns
  if (!cols) return null
  const sel = cols.find((c) => c.name === t.columnSelected)
  return (
    <Box gap="xs">
      <Table
        label="Columns"
        columns={[
          { key: 'name', label: 'Column', minWidth: 'xs' },
          { key: 'field', label: 'Field', minWidth: 'xs' },
          { key: 'type', label: 'Type', width: 'sm' },
          { key: 'sample', label: 'Values', hideBelow: 'sm' }
        ]}
        rows={cols.map((c) => ({ key: c.name, cells: { name: c.name, field: c.type === 'skip' ? '—' : c.field, type: CSV_TYPES.find((x) => x.value === c.type)?.label ?? c.type, sample: c.samples.join(', ') } }))}
        selectionMode="single"
        selected={sel ? [sel.name] : []}
        maxHeight="sm"
        onSelectionChange={({ keys }) => changeAdmin(t.id, 'import', () => ({ columnSelected: keys[0] }))}
      />
      {sel ? (
        <Box columns={2} gap="xs">
          <Input label={`Field for "${sel.name}"`} value={sel.field} placeholder="name or address.city" onChange={(v) => setColumn(t.id, sel.name, { field: v })} />
          <Select label="Type" value={sel.type} options={CSV_TYPES} onChange={(v) => setColumn(t.id, sel.name, { type: v as CsvType })} />
        </Box>
      ) : (
        <Text size="xs" muted>Select a column to change its field or type. A dotted field (address.city) makes a sub-document.</Text>
      )}
    </Box>
  )
}

function Preview({ t }: { t: ImportTab }): OrcaNode {
  const p = t.preview
  if (!p) return null
  return (
    <Box gap="sm">
      {p.folder ? (
        <Table
          label="Collections in the folder"
          columns={[
            { key: 'name', label: 'Collection' },
            { key: 'file', label: 'File', hideBelow: 'sm' },
            { key: 'bytes', label: 'Size', width: 'xs', align: 'end' },
            { key: 'meta', label: 'Indexes', width: 'xs' }
          ]}
          rows={p.folder.map((f) => ({ key: f.name, cells: { name: f.name, file: f.file, bytes: bytesText(f.bytes), meta: f.metadata ? 'yes' : 'no' } }))}
          maxHeight="sm"
        />
      ) : null}
      {p.notes.map((n) => (
        <Text key={n} size="xs" muted>{n}</Text>
      ))}
      {p.errors.length ? (
        <Callout tone="warning" icon="warning" title={`${p.errors.length} record${p.errors.length === 1 ? '' : 's'} could not be read`}>
          <Box gap="xs">
            {p.errors.slice(0, 5).map((e) => (
              <Text key={`${e.record}:${e.message}`} size="sm">{e.message}</Text>
            ))}
          </Box>
        </Callout>
      ) : null}
      <Columns t={t} />
      {p.docs.length ? <CodeView label="First documents" code={p.docs.map((d) => toShell(d)).join('\n')} language="javascript" maxHeight="md" /> : null}
    </Box>
  )
}

export function ImportTabView({ id }: { id: string }): OrcaNode {
  const t = read(adminTabs)[id]
  if (!t || t.kind !== 'import') return null
  const p = t.preview
  const folder = Boolean(p?.folder)
  const fmt = t.format === 'auto' ? p?.format : t.format
  const csvLike = fmt === 'csv' || fmt === 'tsv'
  const running = jobRunning(t.job)
  const problems = importProblems(t)
  return (
    <Box gap="sm">
      <Row gap="xs" align="center" justify="between">
        <Box gap="none" grow>
          <Text weight="semibold" truncate>Import</Text>
          <Text size="xs" muted truncate>{targetLabel(t)}</Text>
        </Box>
        <IconButton icon="close" label="Close the import" variant="ghost" size="sm" onPress={() => closeAdmin(t.id)} />
      </Row>
      <Box columns={2} gap="xs">
        <Input label="Database" value={t.db} onChange={(v) => setImport(t.id, { db: v })} />
        <Input label="Collection" value={t.collection} placeholder={folder ? 'One per file' : 'Name'} disabled={folder} onChange={(v) => setImport(t.id, { collection: v })} />
      </Box>
      <RadioGroup
        label="Source"
        orientation="horizontal"
        value={t.sourceKind}
        options={[
          { value: 'paste', label: 'Paste text' },
          { value: 'path', label: 'A file or folder' }
        ]}
        onChange={(v) => setImport(t.id, { sourceKind: v as ImportTab['sourceKind'], preview: undefined }, true)}
      />
      {t.sourceKind === 'paste' ? (
        <Textarea label="Documents" labelHidden rows={8} value={t.text} placeholder={'[{ "name": "Ada" }, { "name": "Grace" }]\nor one JSON document per line, or CSV with a header row'} onChange={(v) => setImport(t.id, { text: v }, true)} />
      ) : (
        <Box gap="xs">
          <Input label="Path" value={t.path} placeholder="~/exports/orders.json, orders.csv, dump/shop/orders.bson or the dump/shop folder" onChange={(v) => setImport(t.id, { path: v }, true)} onSubmit={() => void aguard(t.id, () => previewImport(t.id))()} />
          <Text size="xs" muted>Read by Mongo Studio on this computer. .gz files (mongodump --gzip) are read too.</Text>
        </Box>
      )}
      <Row gap="xs" align="end">
        <Select label="Format" value={t.format} options={FORMATS} onChange={(v) => setImport(t.id, { format: v as ImportTab['format'] }, true)} />
        {csvLike ? <Select label="Delimiter" value={t.csv.delimiter} options={DELIMITERS} onChange={(v) => setImport(t.id, { csv: { ...t.csv, delimiter: v } }, true)} /> : null}
      </Row>
      {csvLike ? (
        <Box gap="xs">
          <Checkbox label="The first row names the columns" description="Names like age.int32() also give the type, as mongoimport reads them" checked={t.csv.header} onChange={(header) => setImport(t.id, { csv: { ...t.csv, header } }, true)} />
          <Checkbox label="Leave out empty cells" checked={t.csv.ignoreEmpty} onChange={(ignoreEmpty) => setImport(t.id, { csv: { ...t.csv, ignoreEmpty } })} />
        </Box>
      ) : null}
      <Toolbar label="Preview actions" gap="xs">
        <Button icon="search" disabled={t.previewing || running} onPress={aguard(t.id, () => previewImport(t.id))}>{t.previewing ? 'Reading…' : p ? 'Preview again' : 'Preview'}</Button>
        {p && t.stale ? <Text size="xs" muted>Changed since the preview.</Text> : null}
        {p?.bytes ? <Text size="xs" muted>{bytesText(p.bytes)}</Text> : null}
      </Toolbar>
      {t.previewError ? <Callout tone="danger" icon="error" title="Could not read the source">{t.previewError}</Callout> : null}
      <Preview t={t} />
      <Collapsible title="How to write" description={MODES.find((m) => m.value === t.mode)?.label ?? ''}>
        <Box gap="xs">
          <RadioGroup label="Documents" value={t.mode} options={MODES} onChange={(v) => setImport(t.id, { mode: v as ImportTab['mode'] })} />
          <Checkbox label={folder ? 'Drop each collection first' : 'Drop the collection first'} description="Its documents and indexes are deleted before the import" checked={t.drop} onChange={(drop) => setImport(t.id, { drop })} />
          <Checkbox label="Stop at the first error" checked={t.stopOnError} onChange={(stopOnError) => setImport(t.id, { stopOnError })} />
          {fmt === 'bson' ? <Checkbox label="Create the indexes of the .metadata.json" description="Read next to each .bson file, as mongorestore does" checked={t.indexes} onChange={(indexes) => setImport(t.id, { indexes })} /> : null}
        </Box>
      </Collapsible>
      <NoticeBar id={t.id} notice={t.notice} />
      {t.confirmDrop ? (
        <Callout tone="danger" icon="warning" title={`Drop ${t.db}.${t.collection}?`}>
          <Box gap="sm">
            <Text>{`On ${connectionName(t.connectionId)}: its ${t.confirmDrop.count === null ? '' : `${numberText(t.confirmDrop.count)} `}documents and its indexes are deleted, then the import writes into it.`}</Text>
            <Row gap="xs">
              <Button variant="solid" tone="danger" onPress={aguard(t.id, () => startImport(t.id, true))}>Drop and import</Button>
              <Button variant="ghost" onPress={() => changeAdmin(t.id, 'import', () => ({ confirmDrop: undefined }))}>Cancel</Button>
            </Row>
          </Box>
        </Callout>
      ) : null}
      {problems.length && p ? <Text size="xs" tone="danger">{problems.join(' ')}</Text> : null}
      <Row gap="xs" align="center">
        <Button variant="solid" tone="accent" icon="upload" disabled={running || Boolean(t.confirmDrop)} onPress={aguard(t.id, () => startImport(t.id))}>
          {running ? 'Importing…' : 'Import'}
        </Button>
        {t.job?.state?.status === 'done' && !folder && t.collection ? (
          <Button variant="ghost" icon="open-external" onPress={aguard(t.id, () => openNamespace({ connectionId: t.connectionId, db: t.db, collection: t.collection }, 'coll'))}>Open the collection</Button>
        ) : null}
      </Row>
      <JobProgress box={t.job} what="import" onCancel={aguard(t.id, () => cancelImport(t.id))} />
      {t.sourceKind === 'path' ? (
        <TaskSaver tabId={t.id} task={t.task} taskName={t.taskName} placeholder={t.title} kinds={[{ kind: 'import', label: 'Save the import as a task' }]} />
      ) : (
        <Text size="xs" muted>An import from a file or folder path can be saved as a task; pasted text can't.</Text>
      )}
    </Box>
  )
}
