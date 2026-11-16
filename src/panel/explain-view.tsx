// The Explain plan section of a collection or aggregation tab: a summary with warnings, the plan's
// stages as a tree (select one for its details), and the server's raw answer.
import { Box, Button, Callout, CodeView, Collapsible, KeyValue, Row, Select, Skeleton, Text, Toolbar, Tree, type KeyValueItem, type OrcaNode, type TreeItem } from 'orca'
import { findNode, nodeLabel, nodeStats, VERBOSITY_OPTIONS, type ExplainSummary, type ExplainVerbosity, type PlanNode } from '../shared/explain'
import type { CollTab } from './collection-state'
import { changeExplain, explainOf, runExplain, setVerbosity, toggleNode } from './explain-state'
import { guard } from './guard'

const fmt = (n: number): string => n.toLocaleString('en-US')

function planText(s: ExplainSummary): KeyValueItem {
  if (s.indexes.length) return { label: 'Plan', value: `${s.indexes.length === 1 ? 'Index' : 'Indexes'} ${s.indexes.join(', ')}${s.collectionScan ? ', and a collection scan' : ''}`, tone: s.collectionScan ? 'warning' : 'success' }
  if (s.collectionScan) return { label: 'Plan', value: 'Collection scan', tone: 'warning' }
  return { label: 'Plan', value: 'No collection read (computed, or from a stage such as $documents)' }
}

export function summaryItems(s: ExplainSummary): KeyValueItem[] {
  const items: KeyValueItem[] = [planText(s)]
  if (s.nReturned !== undefined) items.push({ label: 'Returned', value: fmt(s.nReturned) })
  if (s.keysExamined !== undefined) items.push({ label: 'Index keys examined', value: fmt(s.keysExamined) })
  if (s.docsExamined !== undefined) items.push({ label: 'Documents examined', value: fmt(s.docsExamined) })
  if (s.timeMs !== undefined) items.push({ label: 'Time on the server', value: `${fmt(s.timeMs)} ms` })
  if (s.inMemorySort) items.push({ label: 'Sort', value: 'In memory', tone: 'warning' })
  items.push({ label: 'Rejected plans', value: s.rejectedPlans })
  if (s.sharded) items.push({ label: 'Sharded', value: true })
  if (s.namespace) items.push({ label: 'Namespace', value: s.namespace, code: true })
  if (s.serverVersion) items.push({ label: 'Server', value: s.serverVersion })
  return items
}

function treeItem(n: PlanNode, expanded: Set<string>): TreeItem {
  const item: TreeItem = { key: n.key, label: nodeLabel(n), icon: n.warning ? 'warning' : n.stage.startsWith('$') ? 'layers' : n.stage.startsWith('Shard') ? 'database' : 'blocks' }
  const stats = nodeStats(n)
  if (stats) item.description = stats
  if (n.children.length) {
    if (expanded.has(n.key)) item.children = n.children.map((c) => treeItem(c, expanded))
    else item.hasChildren = true
  }
  return item
}

function NodeDetails({ n }: { n: PlanNode }): OrcaNode {
  const items: KeyValueItem[] = []
  if (n.nReturned !== undefined) items.push({ label: 'Returned', value: fmt(n.nReturned) })
  if (n.keysExamined !== undefined) items.push({ label: 'Keys examined', value: fmt(n.keysExamined) })
  if (n.docsExamined !== undefined) items.push({ label: 'Documents examined', value: fmt(n.docsExamined) })
  if (n.timeMs !== undefined) items.push({ label: 'Time (estimate)', value: `${fmt(n.timeMs)} ms` })
  for (const a of n.attrs) items.push({ label: a.label, value: a.value, code: true })
  return (
    <Box gap="xs">
      <Text weight="semibold">{n.stage}</Text>
      {n.warning ? <Text size="xs" tone="warning">{n.warning}</Text> : null}
      {items.length ? <KeyValue label={`${n.stage} details`} items={items} /> : <Text size="xs" muted>No more details for this stage.</Text>}
    </Box>
  )
}

function Visual({ t }: { t: CollTab }): OrcaNode {
  const ex = explainOf(t.id)
  const s = ex.result!.summary
  const selected = ex.selected ? findNode(s.stages, ex.selected) : undefined
  const expanded = new Set(ex.expanded)
  return (
    <Box gap="sm">
      {s.warnings.map((w, i) => (
        <Callout key={`w${i}`} tone="warning" icon="warning">{w}</Callout>
      ))}
      {!s.hasStats ? <Text size="xs" muted>Plan only: the server chose a plan without running it. Explain with executionStats to see what each stage returned and examined.</Text> : null}
      <KeyValue label="Explain summary" items={summaryItems(s)} />
      {s.stages.length ? (
        <Tree
          label="Plan stages"
          items={s.stages.map((n) => treeItem(n, expanded))}
          expanded={ex.expanded}
          {...(ex.selected ? { selected: ex.selected } : {})}
          maxHeight="md"
          onToggle={({ key, expanded: open }) => toggleNode(t.id, key, open)}
          onSelect={({ key }) => changeExplain(t.id, { selected: key })}
        />
      ) : (
        <Text size="xs" muted>The answer has no plan stages to show. The raw view has all of it.</Text>
      )}
      {selected ? <NodeDetails n={selected} /> : s.stages.length ? <Text size="xs" muted>{s.kind === 'aggregate' ? 'Stages run top to bottom. ' : 'Each stage reads from the ones under it. '}Select a stage to see its details.</Text> : null}
    </Box>
  )
}

export function ExplainSection({ t }: { t: CollTab }): OrcaNode {
  const ex = explainOf(t.id)
  const r = ex.result
  const what = t.agg ? 'the pipeline' : 'the query'
  return (
    <Collapsible title="Explain plan" description={r ? `${r.summary.indexes.length ? `Index ${r.summary.indexes.join(', ')}` : r.summary.collectionScan ? 'Collection scan' : 'Plan'} · ${r.verbosity}` : `How the server runs ${what}`} open={ex.open} onChange={(open) => changeExplain(t.id, { open })}>
      <Box gap="sm">
        <Row gap="xs" align="end">
          <Select label="Verbosity" value={ex.verbosity} options={VERBOSITY_OPTIONS} onChange={(v) => setVerbosity(t.id, v as ExplainVerbosity)} />
          <Button icon="gauge" disabled={ex.loading} onPress={guard(t.id, () => runExplain(t.id))}>
            {ex.loading ? 'Explaining…' : r ? 'Explain again' : 'Explain'}
          </Button>
        </Row>
        {ex.verbosity !== 'queryPlanner' ? <Text size="xs" muted>{`executionStats and allPlansExecution run ${what} on the server to measure it.`}</Text> : null}
        {ex.error ? <Callout tone="danger" icon="error" title="Could not explain">{ex.error}</Callout> : null}
        {ex.loading && !r ? <Skeleton lines={5} label="Explaining" /> : null}
        {r ? (
          <Box gap="sm">
            <Row gap="xs" align="center" justify="between" wrap>
              <Toolbar label="Show the plan as" gap="xs">
                {(['visual', 'raw'] as const).map((m) => (
                  <Button key={m} size="sm" variant={ex.mode === m ? 'solid' : 'ghost'} tone={ex.mode === m ? 'accent' : 'neutral'} onPress={() => changeExplain(t.id, { mode: m })}>
                    {m === 'visual' ? 'Visual' : 'Raw'}
                  </Button>
                ))}
              </Toolbar>
              <Text size="xs" muted>{`${fmt(r.ms)} ms`}</Text>
            </Row>
            {r.note ? <Text size="xs" muted>{r.note}</Text> : null}
            {ex.mode === 'visual' ? <Visual t={t} /> : <CodeView label="Explain output" code={r.raw} language="json" lineNumbers maxHeight="lg" />}
            {ex.mode === 'raw' && r.rawCut ? <Text size="xs" muted>The answer is too long to show whole; the visual view covers all of it.</Text> : null}
          </Box>
        ) : null}
      </Box>
    </Collapsible>
  )
}
