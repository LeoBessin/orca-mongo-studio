// The Database tab: overview with its collections, Create a collection (every kind), the profiler
// and its entries, and Drop the database (typing its name to confirm).
import {
  Box,
  Button,
  Callout,
  CodeView,
  Collapsible,
  IconButton,
  Input,
  KeyValue,
  RadioGroup,
  read,
  Row,
  Select,
  Skeleton,
  Table,
  Text,
  Textarea,
  Toolbar,
  type OrcaNode
} from 'orca'
import { adminTabs, aguard, changeAdmin, closeAdmin, connectionName, isReadOnly, numberText, type DatabaseTab } from './admin-state'
import { NoticeBar } from './admin-notice'
import {
  applyProfiler,
  createCollection,
  createCommandText,
  createSpec,
  dropDatabase,
  editCreate,
  loadDatabase,
  openCollectionOf,
  readProfile,
  toggleDbSection
} from './database-state'
import { openUsers } from './users-state'
import { PlaceLine } from './place-view'

const KINDS = [
  { value: 'plain', label: 'Collection', description: 'Documents of any shape' },
  { value: 'capped', label: 'Capped', description: 'A fixed size; the oldest documents make room' },
  { value: 'timeseries', label: 'Time series', description: 'Measurements over time, stored in buckets' },
  { value: 'clustered', label: 'Clustered', description: 'Documents stored in _id order' }
]
const OPS = [
  { value: 'any', label: 'Any operation' },
  { value: 'query', label: 'query' },
  { value: 'insert', label: 'insert' },
  { value: 'update', label: 'update' },
  { value: 'remove', label: 'remove' },
  { value: 'getmore', label: 'getmore' },
  { value: 'command', label: 'command' }
]
const LEVEL_TEXT = ['Off', 'Slow operations', 'Every operation']

function Overview({ t }: { t: DatabaseTab }): OrcaNode {
  const info = t.info
  return (
    <Collapsible title="Overview" description={info ? `${numberText(info.collections.length)} collections and views` : 'Statistics and collections'} open={t.open.overview} onChange={(open) => toggleDbSection(t.id, 'overview', open)}>
      {info ? (
        <Box gap="sm">
          <KeyValue label="Statistics" items={info.stats} />
          <Table
            label="Collections"
            columns={[
              { key: 'name', label: 'Name' },
              { key: 'kind', label: 'Kind', width: 'sm' }
            ]}
            rows={info.collections.map((c) => ({ key: `c:${c.name}`, cells: { name: c.name, kind: c.kind === 'bucket' ? 'GridFS files' : c.kind === 'timeseries' ? 'time series' : c.kind } }))}
            emptyText="No collections yet."
            maxHeight="sm"
            onRowAction={({ key }) => void aguard(t.id, () => openCollectionOf(t.id, key.slice(2)))()}
          />
          {info.collections.length ? <Text size="xs" muted>Enter or a double click opens a collection.</Text> : null}
        </Box>
      ) : (
        <Skeleton lines={4} label="Loading the database" />
      )}
    </Collapsible>
  )
}

function CreateCollection({ t }: { t: DatabaseTab }): OrcaNode {
  const d = t.create
  const e = t.createErrors
  const { spec } = createSpec(d)
  const db = t.isNew ? t.newDb.trim() : t.db
  return (
    <Collapsible title={t.isNew ? 'First collection' : 'Create a collection'} description="Plain, capped, time series or clustered, with rules" open={t.open.create} onChange={(open) => toggleDbSection(t.id, 'create', open)}>
      <Box gap="sm">
        <Input label="Name" placeholder="orders" value={d.name} invalid={Boolean(e.name)} onChange={(name) => editCreate(t.id, { name })} />
        {e.name ? <Text size="xs" tone="danger">{e.name}</Text> : null}
        <RadioGroup label="Kind" value={d.kind} options={KINDS} onChange={(v) => editCreate(t.id, { kind: v as typeof d.kind })} />
        {d.kind === 'capped' ? (
          <Box gap="xs">
            <Row gap="xs">
              <Input label="Size (bytes)" placeholder="1048576" value={d.size} invalid={Boolean(e.size)} onChange={(size) => editCreate(t.id, { size })} />
              <Input label="Most documents" placeholder="No limit" value={d.max} invalid={Boolean(e.max)} onChange={(max) => editCreate(t.id, { max })} />
            </Row>
            {e.size || e.max ? <Text size="xs" tone="danger">{e.size ?? e.max}</Text> : null}
          </Box>
        ) : null}
        {d.kind === 'timeseries' ? (
          <Box gap="xs">
            <Row gap="xs">
              <Input label="Time field" placeholder="ts" value={d.timeField} invalid={Boolean(e.timeField)} onChange={(timeField) => editCreate(t.id, { timeField })} />
              <Input label="Meta field" placeholder="sensor" value={d.metaField} invalid={Boolean(e.metaField)} onChange={(metaField) => editCreate(t.id, { metaField })} />
            </Row>
            {e.timeField || e.metaField ? <Text size="xs" tone="danger">{e.timeField ?? e.metaField}</Text> : null}
            <Select
              label="Granularity"
              value={d.granularity || 'default'}
              options={[
                { value: 'default', label: 'Server default (seconds)' },
                { value: 'seconds', label: 'Seconds' },
                { value: 'minutes', label: 'Minutes' },
                { value: 'hours', label: 'Hours' }
              ]}
              onChange={(v) => editCreate(t.id, { granularity: v === 'default' ? '' : (v as typeof d.granularity) })}
            />
          </Box>
        ) : null}
        {d.kind === 'timeseries' || d.kind === 'clustered' ? (
          <Box gap="xs">
            <Input label="Delete documents after (seconds)" placeholder="Keep them" value={d.expire} invalid={Boolean(e.expire)} onChange={(expire) => editCreate(t.id, { expire })} />
            {e.expire ? <Text size="xs" tone="danger">{e.expire}</Text> : null}
          </Box>
        ) : null}
        {d.kind === 'timeseries' ? null : (
          <Box gap="xs">
            <Textarea label="Validator" rows={4} placeholder="{ $jsonSchema: { bsonType: 'object', required: ['name'] } }" value={d.validator} invalid={Boolean(e.validator)} onChange={(validator) => editCreate(t.id, { validator })} />
            {e.validator ? <Text size="xs" tone="danger">{e.validator}</Text> : null}
            {d.validator.trim() ? (
              <Row gap="xs">
                <Select label="Level" value={d.level} options={[{ value: 'strict', label: 'Strict' }, { value: 'moderate', label: 'Moderate' }, { value: 'off', label: 'Off' }]} onChange={(v) => editCreate(t.id, { level: v as typeof d.level })} />
                <Select label="Action" value={d.action} options={[{ value: 'error', label: 'Error' }, { value: 'warn', label: 'Warn' }, { value: 'errorAndLog', label: 'Error and log' }]} onChange={(v) => editCreate(t.id, { action: v as typeof d.action })} />
              </Row>
            ) : null}
          </Box>
        )}
        <Input label="Collation" placeholder="{ locale: 'en', strength: 2 }" value={d.collation} invalid={Boolean(e.collation)} onChange={(collation) => editCreate(t.id, { collation })} />
        {e.collation ? <Text size="xs" tone="danger">{e.collation}</Text> : null}
        {spec && db ? <CodeView label="mongosh" code={createCommandText(db, spec)} language="javascript" wrap /> : null}
        <Row gap="xs">
          <Button variant="solid" tone="accent" icon="add" disabled={t.creating} onPress={aguard(t.id, () => createCollection(t.id))}>
            {t.creating ? 'Creating…' : t.isNew ? 'Create database' : 'Create collection'}
          </Button>
        </Row>
      </Box>
    </Collapsible>
  )
}

function Profiler({ t }: { t: DatabaseTab }): OrcaNode {
  const ro = isReadOnly(t.connectionId)
  const p = t.profiler
  const d = t.profilerDraft
  const f = t.profileFilter
  const sel = t.entries?.find((e) => e.key === t.entrySelected)
  return (
    <Collapsible
      title="Profiler"
      description={p ? `${LEVEL_TEXT[p.level] ?? `Level ${p.level}`}${p.level === 1 ? ` over ${p.slowms} ms` : ''}` : 'Record slow operations'}
      open={t.open.profiler}
      onChange={(open) => toggleDbSection(t.id, 'profiler', open)}
    >
      <Box gap="sm">
        {t.profilerError ? <Callout tone="warning" icon="warning" title="The profiler can't be read here">{t.profilerError}</Callout> : null}
        {ro ? null : (
          <Box gap="sm">
            <RadioGroup
              label="Record"
              orientation="horizontal"
              value={d.level}
              options={[
                { value: '0', label: 'Nothing' },
                { value: '1', label: 'Slow operations' },
                { value: '2', label: 'Everything' }
              ]}
              onChange={(level) => changeAdmin(t.id, 'database', (x) => ({ profilerDraft: { ...x.profilerDraft, level } }))}
            />
            <Row gap="xs" align="end">
              <Input label="Slow means over (ms)" value={d.slowms} onChange={(slowms) => changeAdmin(t.id, 'database', (x) => ({ profilerDraft: { ...x.profilerDraft, slowms } }))} />
              <Input label="Sample rate (0 to 1)" value={d.sampleRate} onChange={(sampleRate) => changeAdmin(t.id, 'database', (x) => ({ profilerDraft: { ...x.profilerDraft, sampleRate } }))} />
              <Button onPress={aguard(t.id, () => applyProfiler(t.id))}>Apply</Button>
            </Row>
          </Box>
        )}
        {ro ? null : <Text size="xs" muted>The slow threshold and sample rate apply to the whole server, and to its log. Recording everything slows the server down.</Text>}
        {p?.note ? <Text size="xs" muted>{p.note}</Text> : null}
        <Row gap="xs" align="end" wrap>
          <Select label="Operation" value={f.op || 'any'} options={OPS} onChange={(op) => changeAdmin(t.id, 'database', (x) => ({ profileFilter: { ...x.profileFilter, op: op === 'any' ? '' : op } }))} />
          <Input label="Slower than (ms)" value={f.minMs} onChange={(minMs) => changeAdmin(t.id, 'database', (x) => ({ profileFilter: { ...x.profileFilter, minMs } }))} />
          <Input label="Collection" placeholder="orders" value={f.ns} onChange={(ns) => changeAdmin(t.id, 'database', (x) => ({ profileFilter: { ...x.profileFilter, ns } }))} onSubmit={() => void aguard(t.id, () => readProfile(t.id))()} />
        </Row>
        <Row gap="xs" align="center" justify="between">
          <Button size="sm" icon="search" disabled={t.reading} onPress={aguard(t.id, () => readProfile(t.id))}>{t.reading ? 'Reading…' : t.entries ? 'Read again' : 'Read entries'}</Button>
          {t.entries ? <Text size="xs" muted>{`${numberText(t.entries.length)} newest entries · ${numberText(t.entriesMs ?? 0)} ms`}</Text> : null}
        </Row>
        {t.entries ? (
          <Table
            label="Profiler entries"
            columns={[
              { key: 'at', label: 'When', width: 'sm' },
              { key: 'op', label: 'Operation', width: 'sm' },
              { key: 'ns', label: 'Namespace', hideBelow: 'md' },
              { key: 'ms', label: 'ms', width: 'xs', align: 'end' },
              { key: 'plan', label: 'Plan', hideBelow: 'sm' }
            ]}
            rows={t.entries.map((e) => ({ key: e.key, cells: { at: { type: 'relative', at: e.at, format: 'short' }, op: e.op, ns: e.ns, ms: e.ms, plan: e.plan ?? '' } }))}
            selectionMode="single"
            selected={sel ? [sel.key] : []}
            emptyText="No entries. Turn the profiler on, then run something."
            maxHeight="md"
            onSelectionChange={({ keys }) => changeAdmin(t.id, 'database', () => ({ entrySelected: keys[0] }))}
          />
        ) : null}
        {sel ? (
          <Box gap="xs">
            <KeyValue
              label="Entry"
              items={[
                { label: 'Namespace', value: sel.ns, code: true },
                { label: 'Took', value: `${numberText(sel.ms)} ms` },
                ...(sel.plan ? [{ label: 'Plan', value: sel.plan, ...(sel.plan.startsWith('COLLSCAN') ? { tone: 'warning' as const } : {}) }] : []),
                ...(sel.keysExamined !== undefined ? [{ label: 'Keys examined', value: numberText(sel.keysExamined) }] : []),
                ...(sel.docsExamined !== undefined ? [{ label: 'Documents examined', value: numberText(sel.docsExamined) }] : []),
                ...(sel.returned !== undefined ? [{ label: 'Returned', value: numberText(sel.returned) }] : []),
                ...(sel.user ? [{ label: 'User', value: sel.user }] : []),
                ...(sel.app ? [{ label: 'Application', value: sel.app }] : [])
              ]}
            />
            <CodeView label="Profiler entry" code={sel.raw} language="json" maxHeight="md" />
          </Box>
        ) : null}
      </Box>
    </Collapsible>
  )
}

function Drop({ t }: { t: DatabaseTab }): OrcaNode {
  const system = ['admin', 'local', 'config'].includes(t.db)
  return (
    <Collapsible title="Drop the database" description={system ? 'System databases are never dropped here' : 'Remove it with everything in it'} open={t.open.drop} onChange={(open) => toggleDbSection(t.id, 'drop', open)}>
      {system ? (
        <Text size="sm" muted>{`${t.db} is a system database. Mongo Studio does not drop it.`}</Text>
      ) : (
        <Callout tone="danger" icon="warning" title={`Drop ${t.db}?`}>
          <Box gap="sm">
            <Text>{`Every collection${t.info ? ` (${numberText(t.info.collections.length)})` : ''}, document${typeof t.info?.documents === 'number' ? ` (${numberText(t.info.documents)})` : ''}, index and user of ${t.db} on ${connectionName(t.connectionId)} is deleted. This can't be undone. Type the database's name to confirm.`}</Text>
            <Input label="Database name" placeholder={t.db} value={t.dropName} onChange={(dropName) => changeAdmin(t.id, 'database', () => ({ dropName }))} />
            <Row gap="xs">
              <Button variant="solid" tone="danger" icon="delete" disabled={t.dropName !== t.db} onPress={aguard(t.id, () => dropDatabase(t.id))}>Drop database</Button>
            </Row>
          </Box>
        </Callout>
      )}
    </Collapsible>
  )
}

export function DatabaseTabView({ id }: { id: string }): OrcaNode {
  const t = read(adminTabs)[id]
  if (!t || t.kind !== 'database') return null
  const ro = isReadOnly(t.connectionId)
  return (
    <Box gap="sm">
      <Row gap="xs" align="center" justify="between">
        <Box gap="none" grow>
          <Text weight="semibold" truncate>{t.isNew ? 'New database' : `Database ${t.db}`}</Text>
          <PlaceLine places={[{ connectionId: t.connectionId, ...(t.isNew ? { db: t.newDb } : {}), writes: true }]} />
        </Box>
        <IconButton icon="close" label={`Close ${t.isNew ? 'the new database' : t.db}`} variant="ghost" size="sm" onPress={() => closeAdmin(t.id)} />
      </Row>
      {t.isNew ? null : (
        <Toolbar label="Database actions" gap="xs">
          <Button size="sm" icon="refresh" variant="ghost" disabled={t.loading} onPress={aguard(t.id, () => loadDatabase(t.id))}>Refresh</Button>
          <Button size="sm" icon="agent" variant="ghost" onPress={aguard(t.id, () => openUsers(t.connectionId, t.db))}>Users and roles</Button>
        </Toolbar>
      )}
      <NoticeBar id={t.id} notice={t.notice} />
      {t.infoError ? <Callout tone="danger" icon="error" title="Could not read the database">{t.infoError}</Callout> : null}
      {t.isNew ? (
        <Box gap="xs">
          <Input label="Database name" placeholder="inventory" value={t.newDb} onChange={(newDb) => changeAdmin(t.id, 'database', () => ({ newDb }))} />
          <Text size="xs" muted>MongoDB creates a database with its first collection.</Text>
        </Box>
      ) : (
        <Overview t={t} />
      )}
      {ro ? null : <CreateCollection t={t} />}
      {t.isNew ? null : <Profiler t={t} />}
      {t.isNew || ro ? null : <Drop t={t} />}
    </Box>
  )
}
