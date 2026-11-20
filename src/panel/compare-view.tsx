// The Compare tab: the other collection, the rules, the counts, the documents of each kind with a
// pair's differences, and the sync.
import {
  Box,
  Button,
  Callout,
  Checkbox,
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
  Toolbar,
  type OrcaNode
} from 'orca'
import { idKey, toShell, valueText } from '../shared/ejson-view'
import { adminTabs, aguard, changeAdmin, closeAdmin, numberText } from './admin-state'
import { NoticeBar } from './admin-notice'
import { bNs, cancelCompare, comparePlaces, compareProblems, idsShown, runCompare, runSync, selectPair, setCompare, syncPlan, type CompareShow, type CompareTab } from './compare-state'
import { jobRunning } from './data-state'
import { TaskSaver } from './tasks-view'
import { JobProgress } from './job-view'
import { connections } from './state'
import { PlaceLine } from './place-view'
import { GAP } from './layout'

function Other({ t }: { t: CompareTab }): OrcaNode {
  const conns = read(connections)?.connections ?? []
  return (
    <Box gap={GAP.group}>
      <Select label="Compare with, on" value={t.b.connectionId} options={conns.map((c) => ({ value: c.id, label: c.name }))} onChange={(v) => setCompare(t.id, { b: { ...t.b, connectionId: v } })} />
      <Box columns={2} gap="xs">
        <Input label="Database" value={t.b.db} onChange={(v) => setCompare(t.id, { b: { ...t.b, db: v } })} />
        <Input label="Collection" value={t.b.collection} placeholder={`${t.a.collection}_copy`} onChange={(v) => setCompare(t.id, { b: { ...t.b, collection: v } })} />
      </Box>
    </Box>
  )
}

const SHOW: { value: CompareShow; label: (n: number) => string }[] = [
  { value: 'differ', label: (n) => `Differ (${numberText(n)})` },
  { value: 'onlyA', label: (n) => `Only in A (${numberText(n)})` },
  { value: 'onlyB', label: (n) => `Only in B (${numberText(n)})` }
]

function Results({ t }: { t: CompareTab }): OrcaNode {
  const r = t.result
  if (!r || !t.ran) return null
  const ids = idsShown(t)
  const counts: Record<CompareShow, number> = { differ: r.differ, onlyA: r.onlyA, onlyB: r.onlyB }
  const equal = r.differ + r.onlyA + r.onlyB === 0
  return (
    <Box gap={GAP.section}>
      <KeyValue
        label="Comparison"
        items={[
          { label: 'The same', value: numberText(r.same), tone: 'success' },
          { label: 'Differ', value: numberText(r.differ), ...(r.differ ? { tone: 'warning' as const } : {}) },
          { label: `Only in A (${t.ran.a.collection})`, value: numberText(r.onlyA), ...(r.onlyA ? { tone: 'warning' as const } : {}) },
          { label: `Only in B (${t.ran.b.collection})`, value: numberText(r.onlyB), ...(r.onlyB ? { tone: 'warning' as const } : {}) }
        ]}
      />
      {equal ? <Callout tone="success" icon="check">{`Every document matches${t.ran.filter ? ' the filter' : ''} on both sides.`}</Callout> : null}
      {!equal ? (
        <Box gap={GAP.group}>
          <Box gap={GAP.tight}>
            <Toolbar label="Show" gap="xs">
              {SHOW.map((s) => (
                <Button key={s.value} size="sm" variant={t.show === s.value ? 'solid' : 'ghost'} tone={t.show === s.value ? 'accent' : 'neutral'} disabled={counts[s.value] === 0} onPress={() => changeAdmin(t.id, 'compare', () => ({ show: s.value, selected: undefined, diff: undefined }))}>
                  {s.label(counts[s.value])}
                </Button>
              ))}
            </Toolbar>
            <Table
              label="Documents"
              columns={[{ key: 'id', label: '_id' }]}
              rows={ids.map((v) => ({ key: idKey(v), cells: { id: valueText(v, 120) } }))}
              selectionMode="single"
              selected={t.selected ? [t.selected] : []}
              emptyText="None."
              maxHeight="md"
              onSelectionChange={({ keys }) => keys[0] && void aguard(t.id, () => selectPair(t.id, keys[0]!))()}
            />
            {r.capped ? <Text size="xs" muted>{`Only the first _ids of each kind are listed (at most ${numberText(1000)}); the counts are complete.`}</Text> : null}
          </Box>
          <Pair t={t} />
        </Box>
      ) : null}
      <SyncSection t={t} />
    </Box>
  )
}

function Pair({ t }: { t: CompareTab }): OrcaNode {
  const d = t.diff
  if (!d) return <Text size="xs" muted>Select a document to see it on both sides.</Text>
  if (d.loading) return <Skeleton lines={4} label="Reading both documents" />
  if (d.error) return <Callout tone="danger" icon="error">{d.error}</Callout>
  return (
    <Box gap={GAP.group}>
      {d.diffs && d.diffs.length ? (
        <Table
          label="Differences"
          columns={[
            { key: 'path', label: 'Field', minWidth: 'xs' },
            { key: 'a', label: 'A' },
            { key: 'b', label: 'B' }
          ]}
          rows={d.diffs.map((x, i) => ({ key: `d${i}`, cells: { path: x.path, a: x.kind === 'added' ? '(missing)' : `${x.a ?? ''}${x.types ? ` · ${x.types[0]}` : ''}`, b: x.kind === 'removed' ? '(missing)' : `${x.b ?? ''}${x.types ? ` · ${x.types[1]}` : ''}` } }))}
          maxHeight="sm"
        />
      ) : null}
      {d.capped ? <Text size="xs" muted>Only the first 500 differences are listed.</Text> : null}
      {d.a ? <CodeView label="A" code={toShell(d.a)} language="javascript" maxHeight="sm" /> : <Text size="sm" muted>Not in A.</Text>}
      {d.b ? <CodeView label="B" code={toShell(d.b)} language="javascript" maxHeight="sm" /> : <Text size="sm" muted>Not in B.</Text>}
    </Box>
  )
}

function SyncSection({ t }: { t: CompareTab }): OrcaNode {
  const s = t.sync
  const plan = syncPlan(t)
  const r = t.result
  if (!plan || !r || !t.ran) return null
  const running = jobRunning(s.job)
  const from = s.direction === 'aToB' ? 'A' : 'B'
  const to = s.direction === 'aToB' ? 'B' : 'A'
  const set = (change: Partial<CompareTab['sync']>): void => changeAdmin(t.id, 'compare', (x) => ({ sync: { ...x.sync, ...change, confirm: false } }))
  const total = plan.insert + plan.replace + plan.remove
  return (
    <Collapsible title="Sync" description={`Make one side like the other`} open={s.open} onChange={(open) => changeAdmin(t.id, 'compare', (x) => ({ sync: { ...x.sync, open } }))}>
      <Box gap="sm">
        <RadioGroup
          label="Direction"
          value={s.direction}
          options={[
            { value: 'aToB', label: `A → B: change ${t.ran.b.db}.${t.ran.b.collection}` },
            { value: 'bToA', label: `B → A: change ${t.ran.a.db}.${t.ran.a.collection}` }
          ]}
          onChange={(v) => set({ direction: v as CompareTab['sync']['direction'] })}
        />
        <Checkbox label={`Insert what is only in ${from}`} checked={s.insert} onChange={(insert) => set({ insert })} />
        <Checkbox label={`Replace the documents that differ with ${from}'s`} checked={s.replace} onChange={(replace) => set({ replace })} />
        <Checkbox label={`Delete what is only in ${to}`} checked={s.remove} onChange={(remove) => set({ remove })} />
        {t.ran.rules.ignoreFields.length ? <Text size="xs" muted>Replacing writes the whole document, the left-out fields included.</Text> : null}
        {s.confirm ? (
          <Callout tone="danger" icon="warning" title={`Change ${plan.to}?`}>
            <Box gap="sm">
              <Text>{`From the last comparison: ${numberText(plan.insert)} inserted, ${numberText(plan.replace)} replaced, ${numberText(plan.remove)} deleted. Documents changed since are synced as they are now.`}</Text>
              <Row gap="xs">
                <Button variant="solid" tone="danger" onPress={aguard(t.id, () => runSync(t.id, true))}>Sync</Button>
                <Button variant="ghost" onPress={() => set({})}>Cancel</Button>
              </Row>
            </Box>
          </Callout>
        ) : (
          <Row gap="xs">
            <Button icon="refresh" variant="solid" tone="accent" disabled={running || total === 0} onPress={aguard(t.id, () => runSync(t.id))}>{running ? 'Syncing…' : `Sync ${numberText(total)} document${total === 1 ? '' : 's'}`}</Button>
          </Row>
        )}
        <JobProgress box={s.job} what="sync" onCancel={aguard(t.id, () => cancelCompare(t.id))} />
      </Box>
    </Collapsible>
  )
}

export function CompareTabView({ id }: { id: string }): OrcaNode {
  const t = read(adminTabs)[id]
  if (!t || t.kind !== 'compare') return null
  const running = jobRunning(t.job)
  const problems = compareProblems(t)
  const b = bNs(t)
  return (
    <Box gap="sm">
      <Row gap="xs" align="center" justify="between">
        <Box gap="none" grow>
          <Text weight="semibold" truncate>{`Compare ${t.a.db}.${t.a.collection}`}</Text>
          <PlaceLine places={comparePlaces(t)} />
        </Box>
        <IconButton icon="close" label="Close the comparison" variant="ghost" size="sm" onPress={() => closeAdmin(t.id)} />
      </Row>
      <Other t={t} />
      <Input label="Filter (both sides)" value={t.filter} placeholder="{} for every document" invalid={Boolean(t.filterError)} onChange={(v) => setCompare(t.id, { filter: v, filterError: undefined })} />
      {t.filterError ? <Text size="xs" tone="danger">{t.filterError}</Text> : null}
      <Input label="Leave out fields" value={t.ignore} placeholder="updatedAt, meta.version" onChange={(v) => setCompare(t.id, { ignore: v })} />
      <Checkbox label="Field order doesn't count" description="{ a, b } equals { b, a }; types always count (1 and 1.0 differ)" checked={t.ignoreOrder} onChange={(ignoreOrder) => setCompare(t.id, { ignoreOrder })} />
      {problems.length && b.collection ? <Text size="xs" tone="danger">{problems.join(' ')}</Text> : null}
      <Row gap="xs" align="center">
        <Button variant="solid" tone="accent" icon="branch" disabled={running || problems.length > 0} onPress={aguard(t.id, () => runCompare(t.id))}>{running ? 'Comparing…' : t.result ? 'Compare again' : 'Compare'}</Button>
        <Text size="xs" muted>Documents are matched by _id.</Text>
      </Row>
      <NoticeBar id={t.id} notice={t.notice} />
      <JobProgress box={t.job?.state?.status === 'done' ? undefined : t.job} what="comparison" onCancel={aguard(t.id, () => cancelCompare(t.id))} />
      <Results t={t} />
      <TaskSaver
        tabId={t.id}
        task={t.task}
        taskName={t.taskName}
        placeholder={t.title}
        kinds={[{ kind: 'compare', label: 'Save the comparison as a task' }, ...(t.ran ? [{ kind: 'sync' as const, label: 'Save the sync as a task' }] : [])]}
      />
    </Box>
  )
}
