// The Manage tab of a collection. Sections: Overview (statistics and options), Indexes (table,
// actions on the selected index, New index form), Validation (rules editor and a check of existing
// documents) and Rename, clear and drop.
import {
  Badge,
  Box,
  Button,
  Callout,
  Card,
  Checkbox,
  CodeView,
  Collapsible,
  IconButton,
  Input,
  KeyValue,
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
import type { IndexInfo } from '../protocol'
import { toShell, toShellInline, valueText } from '../shared/ejson-view'
import { buildIndex, createIndexCommand, defaultIndexName, INDEX_KIND_OPTIONS, type IndexKeyKind } from '../shared/index-spec'
import { formatBytes } from '../shared/nodes'
import { adminTabs, aguard, changeAdmin, closeAdmin, connectionName, isReadOnly, numberText, type ManageTab } from './admin-state'
import { openNamespace } from './collection-state'
import {
  addKey,
  askConfirm,
  askDropIndex,
  cancelIndex,
  checkValidation,
  confirmed,
  convertToCapped,
  countText,
  createIndexFromDraft,
  dropIndexConfirmed,
  editDraft,
  editKey,
  isTimeseries,
  loadManage,
  newIndex,
  readonlyReason,
  removeKey,
  renameCollection,
  saveTtl,
  saveValidation,
  selectIndex,
  setIndexHidden,
  setRename,
  setValidation,
  toggleSection
} from './manage-state'
import { openSchema } from './schema-state'
import { NoticeBar } from './admin-notice'
import { PlaceLine } from './place-view'

const LEVELS = [
  { value: 'strict', label: 'Strict: every insert and update' },
  { value: 'moderate', label: 'Moderate: skip documents already invalid' },
  { value: 'off', label: 'Off' }
]
const ACTIONS = [
  { value: 'error', label: 'Error: refuse the write' },
  { value: 'warn', label: 'Warn: log it, allow the write' },
  { value: 'errorAndLog', label: 'Error and log (MongoDB 8)' }
]

// ---- Indexes ----

function indexRow(i: IndexInfo) {
  return {
    key: `i:${i.name}`,
    cells: {
      name: i.hidden ? `${i.name} (hidden)` : i.name,
      key: toShellInline(i.key),
      kinds: i.kinds.join(', ') || 'regular',
      size: i.size !== undefined ? formatBytes(i.size) : '',
      used: i.ops !== undefined ? numberText(i.ops) : ''
    }
  }
}

function IndexActions({ t, i }: { t: ManageTab; i: IndexInfo }): OrcaNode {
  const isId = i.name === '_id_'
  const ro = isReadOnly(t.connectionId)
  return (
    <Box gap="xs">
      {ro || isId ? null : (
        <Toolbar label={`${i.name} actions`} gap="xs">
          <Button size="sm" icon={i.hidden ? 'play' : 'pause'} variant="ghost" onPress={aguard(t.id, () => setIndexHidden(t.id, i.name, !i.hidden))}>
            {i.hidden ? 'Unhide' : 'Hide'}
          </Button>
          <Button size="sm" icon="delete" variant="ghost" tone="danger" onPress={aguard(t.id, () => askDropIndex(t.id, i.name))}>
            Drop
          </Button>
        </Toolbar>
      )}
      {i.ttl !== undefined && !ro ? (
        <Row gap="xs" align="end">
          <Input label="Expire after (seconds)" value={t.ttlText ?? String(i.ttl)} onChange={(v) => changeAdmin(t.id, 'manage', () => ({ ttlText: v }))} onSubmit={() => void aguard(t.id, () => saveTtl(t.id, i.name))()} />
          <Button size="sm" disabled={(t.ttlText ?? String(i.ttl)) === String(i.ttl)} onPress={aguard(t.id, () => saveTtl(t.id, i.name))}>Change TTL</Button>
        </Row>
      ) : null}
      {t.confirmDropIndex === i.name ? (
        <Callout tone="danger" icon="warning" title={`Drop ${i.name} from ${t.ns.db}.${t.ns.collection}?`}>
          <Box gap="sm">
            <Text>{`Queries that use it fall back to other indexes or a collection scan. Building it again takes time${typeof t.info?.count === 'number' ? ` over ${numberText(t.info.count)} document${t.info.count === 1 ? '' : 's'}` : ' on a big collection'}${i.hidden ? '' : '; hiding it first shows what happens without it'}. The documents are not touched.`}</Text>
            <Row gap="xs">
              <Button variant="solid" tone="danger" onPress={aguard(t.id, () => dropIndexConfirmed(t.id))}>Drop index</Button>
              <Button variant="ghost" onPress={() => changeAdmin(t.id, 'manage', () => ({ confirmDropIndex: undefined }))}>Cancel</Button>
            </Row>
          </Box>
        </Callout>
      ) : null}
      <KeyValue
        label={`${i.name} details`}
        items={[
          { label: 'Key', value: toShellInline(i.key), code: true },
          { label: 'Kind', value: i.kinds.join(', ') || 'ascending/descending' },
          ...(i.ttl !== undefined ? [{ label: 'Expires after', value: `${numberText(i.ttl)} s` }] : []),
          ...(i.size !== undefined ? [{ label: 'Size', value: formatBytes(i.size) }] : []),
          ...(i.ops !== undefined ? [{ label: 'Used', value: `${numberText(i.ops)} times${i.since ? ` since ${new Date(i.since).toISOString().slice(0, 16).replace('T', ' ')}` : ''}` }] : []),
          ...(i.hidden ? [{ label: 'Hidden', value: 'yes: the planner ignores it', tone: 'warning' as const }] : [])
        ]}
      />
      <CodeView label="Index definition" code={toShell(i.spec)} language="javascript" maxHeight="sm" />
    </Box>
  )
}

function NewIndex({ t }: { t: ManageTab }): OrcaNode {
  const d = t.draft!
  const e = t.draftErrors
  const built = buildIndex(d)
  const hasText = d.keys.some((k) => k.kind === 'text')
  return (
    <Card title="New index" description={`On ${t.ns.db}.${t.ns.collection}`}>
      <Box gap="sm">
        {d.keys.map((k, n) => (
          <Row key={k.id} gap="xs" align="end">
            <Box grow>
              <Input label={`Field ${n + 1}`} placeholder={k.kind === 'wildcard' ? 'empty: every field' : 'address.city'} value={k.field} onChange={(v) => editKey(t.id, k.id, { field: v })} />
            </Box>
            <Select label={`Field ${n + 1} kind`} labelHidden value={k.kind} options={INDEX_KIND_OPTIONS} onChange={(v) => editKey(t.id, k.id, { kind: v as IndexKeyKind })} />
            <IconButton icon="remove" label={`Remove field ${n + 1}`} variant="ghost" size="sm" disabled={d.keys.length === 1} onPress={() => removeKey(t.id, k.id)} />
          </Row>
        ))}
        {e.keys ? <Text size="xs" tone="danger">{e.keys}</Text> : null}
        <Row gap="xs">
          <Button size="sm" icon="add" variant="ghost" onPress={() => addKey(t.id)}>Add a field</Button>
        </Row>
        <Input label="Name" placeholder={built.key ? defaultIndexName(built.key) : 'Given by MongoDB'} value={d.name} invalid={Boolean(e.name)} onChange={(v) => editDraft(t.id, { name: v })} />
        {e.name ? <Text size="xs" tone="danger">{e.name}</Text> : null}
        <Row gap="sm" wrap>
          <Checkbox label="Unique" checked={d.unique} onChange={(v) => editDraft(t.id, { unique: v })} />
          <Checkbox label="Sparse" checked={d.sparse} onChange={(v) => editDraft(t.id, { sparse: v })} />
          <Checkbox label="Hidden" description="Built, but unused by queries" checked={d.hidden} onChange={(v) => editDraft(t.id, { hidden: v })} />
        </Row>
        {e.unique ? <Text size="xs" tone="danger">{e.unique}</Text> : null}
        <Input label="Expire documents after (seconds, TTL)" placeholder="Leave empty to keep documents" value={d.ttl} invalid={Boolean(e.ttl)} onChange={(v) => editDraft(t.id, { ttl: v })} />
        {e.ttl ? <Text size="xs" tone="danger">{e.ttl}</Text> : null}
        <Textarea label="Partial filter" rows={2} placeholder="{ status: { $exists: true } }" value={d.partial} invalid={Boolean(e.partial)} onChange={(v) => editDraft(t.id, { partial: v })} />
        {e.partial ? <Text size="xs" tone="danger">{e.partial}</Text> : null}
        <Collapsible title="More options" description="Collation, wildcard projection, text weights and languages, other options" open={t.draftMore} onChange={(open) => changeAdmin(t.id, 'manage', () => ({ draftMore: open }))}>
          <Box gap="sm">
            <Input label="Collation" placeholder="{ locale: 'en', strength: 2 }" value={d.collation} invalid={Boolean(e.collation)} onChange={(v) => editDraft(t.id, { collation: v })} />
            {e.collation ? <Text size="xs" tone="danger">{e.collation}</Text> : null}
            <Input label="Wildcard projection" placeholder="{ secret: 0 }" value={d.wildcardProjection} invalid={Boolean(e.wildcardProjection)} onChange={(v) => editDraft(t.id, { wildcardProjection: v })} />
            {e.wildcardProjection ? <Text size="xs" tone="danger">{e.wildcardProjection}</Text> : null}
            {hasText || d.weights || d.defaultLanguage || d.languageOverride ? (
              <Box gap="sm">
                <Input label="Text weights" placeholder="{ title: 10, body: 1 }" value={d.weights} invalid={Boolean(e.weights)} onChange={(v) => editDraft(t.id, { weights: v })} />
                {e.weights ? <Text size="xs" tone="danger">{e.weights}</Text> : null}
                <Row gap="xs">
                  <Input label="Default language" placeholder="english" value={d.defaultLanguage} invalid={Boolean(e.defaultLanguage)} onChange={(v) => editDraft(t.id, { defaultLanguage: v })} />
                  <Input label="Language field" placeholder="language" value={d.languageOverride} invalid={Boolean(e.languageOverride)} onChange={(v) => editDraft(t.id, { languageOverride: v })} />
                </Row>
                {e.defaultLanguage || e.languageOverride ? <Text size="xs" tone="danger">{e.defaultLanguage ?? e.languageOverride}</Text> : null}
              </Box>
            ) : null}
            <Input label="Other options" placeholder="{ bits: 26, min: -180, max: 180 }" value={d.extra} invalid={Boolean(e.extra)} onChange={(v) => editDraft(t.id, { extra: v })} />
            {e.extra ? <Text size="xs" tone="danger">{e.extra}</Text> : <Text size="xs" muted>2d bits, min and max; textIndexVersion; 2dsphereIndexVersion; storageEngine.</Text>}
          </Box>
        </Collapsible>
        {built.key ? <CodeView label="mongosh" code={createIndexCommand(t.ns.collection, built.key, built.options!)} language="javascript" wrap /> : null}
        <Row gap="xs">
          <Button variant="solid" tone="accent" icon="check" disabled={t.creating} onPress={aguard(t.id, () => createIndexFromDraft(t.id))}>
            {t.creating ? 'Building…' : 'Create index'}
          </Button>
          <Button variant="ghost" onPress={() => cancelIndex(t.id)}>Cancel</Button>
        </Row>
        <Text size="xs" muted>The build runs on the server. Big collections take a while, and reads and writes go on meanwhile.</Text>
      </Box>
    </Card>
  )
}

function Indexes({ t }: { t: ManageTab }): OrcaNode {
  const list = t.indexes
  const sel = list?.indexes.find((i) => i.name === t.indexSelected)
  const total = list?.indexes.reduce((s, i) => s + (i.size ?? 0), 0) ?? 0
  return (
    <Collapsible
      title="Indexes"
      description={list ? `${list.indexes.length} index${list.indexes.length === 1 ? '' : 'es'}${total ? ` · ${formatBytes(total)}` : ''}` : 'Every kind, with sizes and use'}
      open={t.open.indexes}
      onChange={(open) => toggleSection(t.id, 'indexes', open)}
    >
      <Box gap="sm">
        {t.indexesError ? <Callout tone="danger" icon="error" title="Could not list the indexes">{t.indexesError}</Callout> : null}
        {list?.building.map((b, n) => (
          <Callout key={`b${n}`} tone="accent" icon="refresh" title="Building">{`${b.names.join(', ')}${b.progress ? `: ${b.progress}` : ''}${b.secs !== undefined ? `, ${b.secs} s so far` : ''}. Refresh to follow it.`}</Callout>
        ))}
        {!list && !t.indexesError ? <Skeleton lines={3} label="Loading the indexes" /> : null}
        {list ? (
          <Table
            label="Indexes"
            columns={[
              { key: 'name', label: 'Name', width: 'md' },
              { key: 'key', label: 'Key', minWidth: 'sm' },
              { key: 'kinds', label: 'Kind', hideBelow: 'md' },
              { key: 'size', label: 'Size', width: 'xs', align: 'end', hideBelow: 'sm' },
              { key: 'used', label: 'Used', width: 'xs', align: 'end', hideBelow: 'md' }
            ]}
            rows={list.indexes.map(indexRow)}
            selectionMode="single"
            selected={sel ? [`i:${sel.name}`] : []}
            maxHeight="sm"
            onSelectionChange={({ keys }) => selectIndex(t.id, keys[0]?.slice(2))}
          />
        ) : null}
        {t.draft || isReadOnly(t.connectionId) ? null : (
          <Row gap="xs">
            <Button size="sm" icon="add" onPress={() => newIndex(t.id)}>New index</Button>
          </Row>
        )}
        {t.draft ? <NewIndex t={t} /> : null}
        {sel ? <IndexActions t={t} i={sel} /> : list?.indexes.length ? <Text size="xs" muted>Select an index for its details and actions. Used counts start again when the server restarts.</Text> : null}
      </Box>
    </Collapsible>
  )
}

// ---- Validation ----

function Validation({ t }: { t: ManageTab }): OrcaNode {
  const v = t.validation
  const check = v.check
  const ro = isReadOnly(t.connectionId)
  return (
    <Collapsible
      title="Validation"
      description={t.info ? (t.info.validator ? `Rules on · ${t.info.validationLevel}, ${t.info.validationAction}` : 'No rules') : 'Rules every write must pass'}
      open={t.open.validation}
      onChange={(open) => toggleSection(t.id, 'validation', open)}
    >
      <Box gap="sm">
        <Textarea label="Validator" rows={10} placeholder={"{\n  $jsonSchema: {\n    bsonType: 'object',\n    required: ['name']\n  }\n}"} value={v.text} invalid={Boolean(v.error)} onChange={(text) => setValidation(t.id, { text })} onSubmit={() => void aguard(t.id, () => checkValidation(t.id))()} />
        {v.error ? <Text size="xs" tone="danger">{v.error}</Text> : <Text size="xs" muted>{ro ? 'A query filter or $jsonSchema, in shell syntax. Check documents tries rules without saving them.' : 'A query filter or $jsonSchema, in shell syntax. Empty removes the rules.'}</Text>}
        {ro ? null : <Select label="Level" value={v.level} options={LEVELS} onChange={(level) => setValidation(t.id, { level: level as typeof v.level })} />}
        {ro ? null : <Select label="Action" value={v.action} options={ACTIONS} onChange={(action) => setValidation(t.id, { action: action as typeof v.action })} />}
        <Toolbar label="Validation actions" gap="xs">
          {ro ? null : <Button size="sm" variant="solid" tone="accent" icon="check" onPress={aguard(t.id, () => saveValidation(t.id))}>Save rules</Button>}
          <Button size="sm" icon="search" variant="ghost" disabled={check === 'checking'} onPress={aguard(t.id, () => checkValidation(t.id))}>
            {check === 'checking' ? 'Checking…' : 'Check documents'}
          </Button>
          <Button size="sm" icon="bar-chart-3" variant="ghost" onPress={aguard(t.id, () => openSchema(t.ns, t.collKind, true))}>From the schema</Button>
        </Toolbar>
        {check && check !== 'checking' ? (
          check.error ? (
            <Callout tone="danger" icon="error" title="Could not check">{check.error}</Callout>
          ) : (
            <Callout tone={check.failing ? 'warning' : 'success'} icon={check.failing ? 'warning' : 'check'}>
              {check.failing
                ? `${numberText(check.failing)} of ${check.checked !== null ? numberText(check.checked) : 'the'} documents break these rules${check.firstId !== undefined ? `, the first with _id ${valueText(check.firstId, 60)}` : ''}. With level strict, updates to them must fix them; moderate leaves them be.`
                : `Every document${check.checked !== null ? ` (${numberText(check.checked)})` : ''} passes these rules.`}
            </Callout>
          )
        ) : null}
      </Box>
    </Collapsible>
  )
}

// ---- Rename, clear and drop ----

function Operations({ t }: { t: ManageTab }): OrcaNode {
  const view = t.collKind === 'view' || t.info?.kind === 'view'
  const what = `${t.ns.db}.${t.ns.collection}`
  return (
    <Collapsible title={view ? 'Drop' : 'Rename, clear and drop'} description={view ? 'Remove the view' : 'Change the name or remove the data'} open={t.open.operations} onChange={(open) => toggleSection(t.id, 'operations', open)}>
      <Box gap="sm">
        {view ? null : (
          <Box gap="xs">
            <Row gap="xs" align="end">
              <Input label="New name" placeholder={t.ns.collection} value={t.rename.to} onChange={(to) => setRename(t.id, { to })} />
              <Input label="In database" placeholder={t.ns.db} value={t.rename.toDb} onChange={(toDb) => setRename(t.id, { toDb })} />
            </Row>
            <Row gap="xs" align="center" justify="between" wrap>
              <Checkbox label="Replace a collection that has the name" checked={t.rename.dropTarget} onChange={(dropTarget) => setRename(t.id, { dropTarget })} />
              <Button size="sm" icon="edit" disabled={!t.rename.to.trim() || Boolean(t.confirmRename)} onPress={aguard(t.id, () => renameCollection(t.id))}>Rename</Button>
            </Row>
            {t.confirmRename ? (
              <Callout tone="danger" icon="warning" title={`Replace ${t.confirmRename.target}?`}>
                <Box gap="sm">
                  <Text>{`${t.confirmRename.target} on ${connectionName(t.connectionId)} is dropped${t.confirmRename.count === null ? '' : ` with its ${numberText(t.confirmRename.count)} document${t.confirmRename.count === 1 ? '' : 's'}`} and its indexes, then ${what} takes its name. This can't be undone.`}</Text>
                  <Row gap="xs">
                    <Button variant="solid" tone="danger" onPress={aguard(t.id, () => renameCollection(t.id, true))}>Replace and rename</Button>
                    <Button variant="ghost" onPress={() => changeAdmin(t.id, 'manage', () => ({ confirmRename: undefined }))}>Cancel</Button>
                  </Row>
                </Box>
              </Callout>
            ) : null}
          </Box>
        )}
        {view || t.info?.capped || isTimeseries(t) ? null : (
          <Row gap="xs" align="end">
            <Input label="Make capped at (bytes)" placeholder="1048576" value={t.cappedSize} onChange={(v) => changeAdmin(t.id, 'manage', () => ({ cappedSize: v }))} />
            <Button size="sm" disabled={!t.cappedSize.trim()} onPress={aguard(t.id, () => convertToCapped(t.id))}>Make capped</Button>
          </Row>
        )}
        <Toolbar label="Remove" gap="xs">
          {view || t.info?.capped ? null : (
            <Button size="sm" icon="remove" variant="ghost" tone="danger" onPress={aguard(t.id, () => askConfirm(t.id, 'clear'))}>Delete all documents</Button>
          )}
          <Button size="sm" icon="delete" variant="ghost" tone="danger" onPress={aguard(t.id, () => askConfirm(t.id, 'drop'))}>{view ? 'Drop view' : 'Drop collection'}</Button>
        </Toolbar>
        {t.confirm ? (
          <Callout tone="danger" icon="warning" title={t.confirm === 'clear' ? `Delete every document in ${what}?` : `Drop ${what}?`}>
            <Box gap="sm">
              <Text>
                {t.confirm === 'clear'
                  ? `${countText(t)} are deleted. The collection, its indexes and its rules stay.`
                  : view
                    ? 'The view is removed. Its source collection is not touched.'
                    : `The collection is removed with ${countText(t)} and its ${t.indexes ? `${t.indexes.indexes.length} index${t.indexes.indexes.length === 1 ? '' : 'es'}` : 'indexes'}. This can't be undone.`}
              </Text>
              <Row gap="xs">
                <Button variant="solid" tone="danger" onPress={aguard(t.id, () => confirmed(t.id))}>{t.confirm === 'clear' ? 'Delete documents' : view ? 'Drop view' : 'Drop collection'}</Button>
                <Button variant="ghost" onPress={() => void askConfirm(t.id, undefined)}>Cancel</Button>
              </Row>
            </Box>
          </Callout>
        ) : null}
      </Box>
    </Collapsible>
  )
}

// ---- The tab ----

export function ManageTabView({ id }: { id: string }): OrcaNode {
  const t = read(adminTabs)[id]
  if (!t || t.kind !== 'manage') return null
  const info = t.info
  const noIndexes = readonlyReason(t)
  return (
    <Box gap="sm">
      <Row gap="xs" align="center" justify="between">
        <Box gap="none" grow>
          <Text weight="semibold" truncate>{`${t.ns.db}.${t.ns.collection}`}</Text>
          <Row gap="xs">
            <PlaceLine places={[{ connectionId: t.connectionId, writes: true }]} />
            {info ? <Badge tone="neutral">{info.kind === 'timeseries' ? 'time series' : info.kind}</Badge> : null}
            {info?.capped ? <Badge tone="neutral">capped</Badge> : null}
          </Row>
        </Box>
        <IconButton icon="close" label={`Close managing ${t.ns.collection}`} variant="ghost" size="sm" onPress={() => closeAdmin(t.id)} />
      </Row>
      <Toolbar label="Collection actions" gap="xs">
        <Button size="sm" icon="refresh" variant="ghost" disabled={t.loading} onPress={aguard(t.id, () => loadManage(t.id))}>Refresh</Button>
        <Button size="sm" icon="open-external" variant="ghost" onPress={aguard(t.id, () => openNamespace(t.ns, t.collKind))}>Open</Button>
        <Button size="sm" icon="bar-chart-3" variant="ghost" onPress={aguard(t.id, () => openSchema(t.ns, t.collKind))}>Schema</Button>
      </Toolbar>
      <NoticeBar id={t.id} notice={t.notice} />
      {t.infoError ? <Callout tone="danger" icon="error" title="Could not read the collection">{t.infoError}</Callout> : null}
      <Collapsible title="Overview" description="Statistics and options" open={t.open.overview} onChange={(open) => toggleSection(t.id, 'overview', open)}>
        {info ? (
          <Box gap="sm">
            <KeyValue label="Statistics" items={info.stats} />
            {Object.keys(info.options).length ? <CodeView label="Options" code={toShell(info.options)} language="javascript" maxHeight="sm" /> : null}
          </Box>
        ) : (
          <Skeleton lines={4} label="Loading the statistics" />
        )}
      </Collapsible>
      {noIndexes ? <Text size="xs" muted>{noIndexes}</Text> : <Indexes t={t} />}
      {noIndexes || isTimeseries(t) ? null : <Validation t={t} />}
      {isReadOnly(t.connectionId) ? null : <Operations t={t} />}
    </Box>
  )
}
