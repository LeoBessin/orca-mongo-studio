// Update many: the card under a collection's results. Choose the documents (the selected rows, the
// query's matches, or the whole collection), write the update, preview it (how many documents, and
// one before and after), confirm, and see what changed.
import { Box, Button, Callout, Card, CodeView, Input, Progress, RadioGroup, Row, Skeleton, Table, Text, Textarea, type OrcaNode } from 'orca'
import { toShell } from '../shared/ejson-view'
import { scopeIsEverything } from '../shared/update-spec'
import { numberText } from './admin-state'
import {
  bulkConfirmed,
  bulkPlan,
  bulkScope,
  closeUpdateMany,
  currentPreview,
  nsLabel,
  previewUpdateMany,
  runUpdateMany,
  setBulk,
  type BulkPlan,
  type BulkScope,
  type BulkUpdate,
  type CollTab
} from './collection-state'
import { guardAt } from './guard'
import { settings } from './settings-state'

// The Update many card opens under the results: its errors show there too.
const guard = guardAt('results')

const plural = (n: number, one: string, many = `${one}s`): string => `${numberText(n)} ${n === 1 ? one : many}`

function scopeOptions(t: CollTab, plan: BulkPlan): { value: BulkScope; label: string; description: string; disabled?: boolean }[] {
  const selection = t.bulk?.scope === 'selection' ? { scope: plan.scope, error: plan.scopeError } : bulkScope(t, 'selection')
  const n = selection.scope?.kind === 'ids' ? selection.scope.ids.length : 0
  const spec = t.spec
  const ignored = spec && (spec.skip || spec.limit) ? ' Skip and limit are not applied.' : ''
  return [
    { value: 'selection', label: n ? `Selected rows (${n})` : 'Selected rows', description: selection.error ?? 'The rows selected in the results, by _id.', disabled: !selection.scope },
    {
      value: 'query',
      label: 'Every match of the query',
      description: spec ? `Every document its filter matches, not only this page.${ignored}` : 'Run the query first.',
      disabled: !spec
    },
    { value: 'all', label: 'Every document in the collection', description: `All of ${nsLabel(t.ns)}, whatever the query.` }
  ]
}

function reachText(p: NonNullable<BulkUpdate['preview']>): string {
  const r = p.result!
  if (r.count === null) return `The number of documents isn't known: ${(r.countError ?? 'counting failed').replace(/\.$/, '')}.`
  if (r.count === 0) return 'No document matches, so nothing would change.'
  return `${r.approximate ? 'About ' : ''}${plural(r.count, 'document')} would be updated.`
}

function Preview({ t, p, plan }: { t: CollTab; p: NonNullable<BulkUpdate['preview']>; plan: BulkPlan }): OrcaNode {
  if (p.loading) return <Skeleton lines={3} label="Counting and trying the update on one document" />
  if (p.error) return <Callout tone="danger" icon="error" title="The preview failed">{p.error}</Callout>
  const r = p.result!
  const s = r.sample
  return (
    <Box gap="xs">
      <Text weight="semibold">{reachText(p)}</Text>
      {s?.error ? <Callout tone="danger" icon="error" title="The server refuses this update on the first document">{s.error}</Callout> : null}
      {s?.note ? <Text size="xs" muted>{s.note}</Text> : null}
      {s?.after ? (
        s.diffs.length ? (
          <Table
            label="Changes to the first document"
            columns={[
              { key: 'path', label: 'Field', minWidth: 'xs' },
              { key: 'before', label: 'Before' },
              { key: 'after', label: 'After' }
            ]}
            rows={s.diffs.map((x, i) => ({
              key: `d${i}`,
              cells: {
                path: x.path,
                before: x.kind === 'added' ? '(missing)' : `${x.a ?? ''}${x.types ? ` · ${x.types[0]}` : ''}`,
                after: x.kind === 'removed' ? '(removed)' : `${x.b ?? ''}${x.types ? ` · ${x.types[1]}` : ''}`
              }
            }))}
            maxHeight="sm"
          />
        ) : (
          <Text size="sm" muted>The first document would stay as it is.</Text>
        )
      ) : null}
      {s?.capped ? <Text size="xs" muted>Only the first 100 changed fields are listed.</Text> : null}
      {s?.tooBig ? <Text size="xs" muted>The document is too big to show here before and after, so it is cut down to its _id.</Text> : null}
      {s ? <CodeView label="Before" code={toShell(s.before)} language="javascript" maxHeight="sm" /> : null}
      {s?.after ? <CodeView label="After" code={toShell(s.after)} language="javascript" maxHeight="sm" /> : null}
      {s?.error ? <Text size="sm" tone="danger">Fix the update first: updateMany would stop at a document like this one, after changing others.</Text> : r.count !== 0 ? <Confirm t={t} p={p} plan={plan} /> : null}
    </Box>
  )
}

function Confirm({ t, p, plan }: { t: CollTab; p: NonNullable<BulkUpdate['preview']>; plan: BulkPlan }): OrcaNode {
  const b = t.bulk!
  const everything = scopeIsEverything(p.scope)
  const n = p.result!.count
  const what = n === null ? 'the documents' : `${p.result!.approximate ? 'about ' : ''}${plural(n, 'document')}`
  const title = everything ? `Update every document in ${nsLabel(t.ns)}?` : `Update ${what} in ${nsLabel(t.ns)}?`
  return (
    <Callout tone={everything ? 'danger' : 'warning'} icon="warning" title={title}>
      <Box gap="sm">
        <Text>{`This changes ${everything ? 'the whole collection' : what}. It can't be undone.`}</Text>
        {everything && settings().confirmByName ? (
          <Input label={`Type ${t.ns.collection} to confirm`} value={b.confirmName} onChange={(confirmName) => setBulk(t.id, { confirmName })} onSubmit={() => void guard(t.id, () => runUpdateMany(t.id))()} />
        ) : null}
        <Row gap="xs">
          <Button variant="solid" tone="danger" icon="check" disabled={b.running || !bulkConfirmed(t, plan)} onPress={guard(t.id, () => runUpdateMany(t.id))}>
            {b.running ? 'Updating…' : everything ? 'Update every document' : n === null ? 'Update documents' : `Update ${plural(n, 'document')}`}
          </Button>
        </Row>
      </Box>
    </Callout>
  )
}

export function UpdateMany({ t }: { t: CollTab }): OrcaNode {
  const b = t.bulk
  if (!b) return null
  const plan = bulkPlan(t)
  const p = currentPreview(t, plan)
  const typed = b.text.trim() !== ''
  return (
    <Card title="Update documents" description={`updateMany on ${nsLabel(t.ns)}`}>
      <Box gap="sm">
        <RadioGroup label="Documents" value={b.scope} options={scopeOptions(t, plan)} disabled={b.running} onChange={(v) => setBulk(t.id, { scope: v as BulkScope })} />
        {plan.skipped ? <Text size="xs" tone="warning">{`${plural(plan.skipped, 'selected row')} without an _id ${plan.skipped === 1 ? 'is' : 'are'} left out.`}</Text> : null}
        <Textarea
          label="Update"
          rows={6}
          placeholder="{ $set: { status: 'archived' } }   or a pipeline: [{ $set: { … } }]"
          value={b.text}
          invalid={typed && Boolean(plan.updateError)}
          disabled={b.running}
          onChange={(text) => setBulk(t.id, { text })}
          onSubmit={() => void guard(t.id, () => previewUpdateMany(t.id))()}
        />
        {typed && plan.updateError ? <Text size="xs" tone="danger">{plan.updateError}</Text> : <Text size="xs" muted>Update operators, or an update pipeline in [ ]. Ctrl+Enter previews.</Text>}
        <Row gap="xs">
          <Button variant={p ? 'ghost' : 'solid'} tone="accent" icon="search" disabled={!plan.basis || p?.loading || b.running} onPress={guard(t.id, () => previewUpdateMany(t.id))}>
            {p ? 'Preview again' : 'Preview'}
          </Button>
          <Button variant="ghost" disabled={b.running} onPress={() => closeUpdateMany(t.id)}>Cancel</Button>
        </Row>
        {p ? <Preview t={t} p={p} plan={plan} /> : null}
        {b.running ? <Progress label={`${b.job?.state?.phase ?? 'Starting the update'}…`} /> : null}
        {b.error ? <Callout tone="danger" icon="error" title="The update failed">{b.error}</Callout> : null}
      </Box>
    </Card>
  )
}
