// An aggregation tab: the stage list (Orca has no drag and drop, so stages move with buttons), the
// selected stage's editor and preview, the pipeline as text, results, explain, a view from the
// pipeline, saved pipelines and code.
import {
  Badge,
  Box,
  Button,
  Callout,
  Card,
  CodeView,
  Collapsible,
  IconButton,
  Input,
  read,
  Row,
  Select,
  Separator,
  Skeleton,
  Switch,
  Table,
  Text,
  Textarea,
  Toolbar,
  type OrcaNode
} from 'orca'
import { toShell } from '../shared/ejson-view'
import { arrayText, chunkForHighlight, chunkLabel } from '../shared/code-chunks'
import { STAGE_OPTIONS, STAGE_TEMPLATES, stageSummary } from '../shared/pipeline'
import type { PreviewDocs } from '../protocol'
import {
  addStage,
  aggOperation,
  aggTitle,
  applyText,
  cancelWrite,
  changeAgg,
  createViewFromPipeline,
  deleteSavedPipeline,
  duplicateStage,
  editAsText,
  leaveText,
  loadSavedPipeline,
  moveStage,
  openCreatedView,
  PREVIEW_SIZES,
  refreshPreview,
  removeStage,
  runPipeline,
  savePipeline,
  selectStage,
  setAllowDiskUse,
  setPipelineText,
  setPreviewSize,
  setStageBody,
  setStageOp,
  toggleStage,
  exportPipeline
} from './aggregate-state'
import { change, closeTab, collTabs, type AggState, type CollTab } from './collection-state'
import { ExplainSection } from './explain-view'
import { changeExplain, runExplain } from './explain-state'
import { guard } from './guard'
import { AGGREGATION_PLACES, TabNoticeView } from './notice-view'
import { Results } from './results-view'
import { CodeSection } from './shell-view'
import { PlaceLine } from './place-view'

// ---- Stage list ----

function StageList({ t, a }: { t: CollTab; a: AggState }): OrcaNode {
  const at = a.stages.findIndex((s) => s.id === a.selected)
  const sel = a.stages[at]
  return (
    <Box gap="xs">
      <Table
        label="Stages"
        columns={[
          { key: 'n', label: '#', width: 'xs' },
          { key: 'op', label: 'Stage', width: 'sm' },
          { key: 'body', label: 'Value' }
        ]}
        rows={a.stages.map((s, i) => ({
          key: s.id,
          cells: { n: `${i + 1}${a.errors[s.id] ? ' ⚠' : ''}`, op: s.enabled ? s.op : `${s.op} (off)`, body: stageSummary(s) }
        }))}
        selectionMode="single"
        selected={sel ? [sel.id] : []}
        emptyText="No stages: the pipeline passes every document. Add a stage."
        maxHeight="sm"
        onSelectionChange={({ keys }) => {
          if (keys[0]) void guard(t.id, () => selectStage(t.id, keys[0]!))()
        }}
      />
      <Row gap="xs" align="end" wrap>
        <Select label="Add a stage" labelHidden value="" placeholder={sel ? `Add a stage after ${at + 1}…` : 'Add a stage…'} options={STAGE_OPTIONS} onChange={(op) => void guard(t.id, () => addStage(t.id, op))()} />
        {sel ? (
          <Toolbar label="Stage actions" gap="xs">
            <Button size="sm" variant="ghost" disabled={at === 0} onPress={guard(t.id, () => moveStage(t.id, sel.id, -1))}>Up</Button>
            <Button size="sm" variant="ghost" disabled={at === a.stages.length - 1} onPress={guard(t.id, () => moveStage(t.id, sel.id, 1))}>Down</Button>
            <IconButton icon={sel.enabled ? 'pause' : 'play'} label={sel.enabled ? 'Turn the stage off' : 'Turn the stage on'} size="sm" variant="ghost" onPress={guard(t.id, () => toggleStage(t.id, sel.id))} />
            <IconButton icon="copy" label="Duplicate the stage" size="sm" variant="ghost" onPress={guard(t.id, () => duplicateStage(t.id, sel.id))} />
            <IconButton icon="delete" label="Remove the stage" size="sm" variant="ghost" tone="danger" onPress={guard(t.id, () => removeStage(t.id, sel.id))} />
          </Toolbar>
        ) : null}
      </Row>
    </Box>
  )
}

// ---- The selected stage ----

/** The preview's documents in shell syntax, split where Orca's highlighter would stop colouring
 *  (see code-chunks): usually one view. */
function PreviewCode({ label, p }: { label: string; p: PreviewDocs }): OrcaNode {
  if (!p.docs.length) return <CodeView label={label} code="[]" language="javascript" maxHeight="md" />
  const chunks = chunkForHighlight(p.docs.map((d) => toShell(d)))
  return (
    <>
      {chunks.map((c) => (
        <CodeView key={c.from} label={chunkLabel(label, c, 0, chunks.length)} code={arrayText(c.texts)} language="javascript" maxHeight="md" />
      ))}
    </>
  )
}

function countLine(p: PreviewDocs, what: string): string {
  const n = p.docs.length
  if (n === 0) return `${what}: no documents.`
  return `${what}: ${p.more ? 'the first ' : ''}${n} document${n === 1 ? '' : 's'}${p.stoppedForSize ? ', fewer than asked to stay under the size Orca lets a panel receive' : ''}.`
}

function Preview({ t, a }: { t: CollTab; a: AggState }): OrcaNode {
  const p = a.preview
  if (!p || p.stageId !== a.selected) return null
  const r = p.result
  const side = a.previewSide === 'output' && r?.output ? 'output' : 'input'
  const docs = r ? (side === 'output' ? r.output! : r.input) : undefined
  return (
    <Box gap="xs">
      <Row gap="xs" align="center" justify="between" wrap>
        <Toolbar label="Preview" gap="xs">
          {(['input', 'output'] as const).map((s) => (
            <Button key={s} size="sm" disabled={s === 'output' && Boolean(r) && !r!.output} variant={side === s ? 'solid' : 'ghost'} tone={side === s ? 'accent' : 'neutral'} onPress={() => changeAgg(t.id, () => ({ previewSide: s }))}>
              {s === 'input' ? 'Input' : 'Output'}
            </Button>
          ))}
          <IconButton icon="refresh" label="Preview again" size="sm" variant="ghost" disabled={p.loading} onPress={guard(t.id, () => refreshPreview(t.id))} />
        </Toolbar>
        <Select label="Preview size" labelHidden value={String(a.previewSize)} options={PREVIEW_SIZES.map((n) => ({ value: String(n), label: `${n} documents` }))} onChange={(v) => void guard(t.id, () => setPreviewSize(t.id, Number(v)))()} />
      </Row>
      {p.note ? <Text size="xs" muted>{p.note}</Text> : null}
      {p.error ? <Callout tone="danger" icon="error" title="No preview">{p.error}</Callout> : null}
      {p.loading && !r ? <Skeleton lines={4} label="Reading the preview" /> : null}
      {docs ? (
        <Box gap="xs">
          <Row gap="xs" align="center" justify="between">
            <Text size="xs" muted>{countLine(docs, side === 'output' ? 'Output' : 'Input')}</Text>
            <Text size="xs" muted>{p.loading ? 'Updating…' : `${r!.ms.toLocaleString('en-US')} ms`}</Text>
          </Row>
          <PreviewCode label={side === 'output' ? 'Stage output' : 'Stage input'} p={docs} />
        </Box>
      ) : null}
    </Box>
  )
}

function StageEditor({ t, a }: { t: CollTab; a: AggState }): OrcaNode {
  const at = a.stages.findIndex((s) => s.id === a.selected)
  const s = a.stages[at]
  if (!s) return null
  const error = a.errors[s.id]
  const info = STAGE_TEMPLATES.find((x) => x.op === s.op)?.info
  const options = STAGE_OPTIONS.some((o) => o.value === s.op) ? STAGE_OPTIONS : [...STAGE_OPTIONS, { value: s.op, label: s.op }]
  return (
    <Card title={`Stage ${at + 1}: ${s.op}`} {...(s.enabled ? {} : { description: 'Off: the pipeline runs without it.' })}>
      <Box gap="sm">
        <Select label="Stage" value={s.op} options={options} onChange={(op) => setStageOp(t.id, s.id, op)} />
        {info ? <Text size="xs" muted>{info}</Text> : null}
        <Textarea label="Value" rows={8} value={s.body} invalid={Boolean(error)} placeholder="{ field: 'value' }" onChange={(v) => setStageBody(t.id, s.id, v)} onSubmit={() => void guard(t.id, () => refreshPreview(t.id))()} />
        {error ? <Text size="xs" tone="danger">{error}</Text> : <Text size="xs" muted>Shell syntax. Ctrl+Enter updates the preview.</Text>}
        <Row gap="xs">
          <Button size="sm" icon="refresh" onPress={guard(t.id, () => refreshPreview(t.id))}>Update preview</Button>
        </Row>
        <Preview t={t} a={a} />
      </Box>
    </Card>
  )
}

// ---- Text mode ----

function TextEditor({ t, a }: { t: CollTab; a: AggState }): OrcaNode {
  const off = a.stages.filter((s) => !s.enabled).length
  return (
    <Box gap="xs">
      <Textarea label="Pipeline" rows={16} value={a.text} invalid={Boolean(a.textError)} onChange={(v) => setPipelineText(t.id, v)} onSubmit={() => void guard(t.id, () => applyText(t.id))()} />
      {a.textError ? <Text size="xs" tone="danger">{a.textError}</Text> : <Text size="xs" muted>An array of stages in shell syntax. Ctrl+Enter applies it.</Text>}
      {off ? <Text size="xs" tone="warning">{`${off} stage${off === 1 ? ' is' : 's are'} off and left out of the text; applying it removes ${off === 1 ? 'it' : 'them'}.`}</Text> : null}
      <Row gap="xs">
        <Button size="sm" variant="solid" tone="accent" icon="check" onPress={guard(t.id, () => applyText(t.id))}>Apply</Button>
        <Button size="sm" variant="ghost" onPress={() => leaveText(t.id)}>Cancel</Button>
      </Row>
    </Box>
  )
}

// ---- Views and saved pipelines ----

function CreateView({ t, a }: { t: CollTab; a: AggState }): OrcaNode {
  return (
    <Collapsible title="Create a view" description={`A read-only view on ${t.ns.collection} from this pipeline`} open={a.viewOpen} onChange={(open) => changeAgg(t.id, () => ({ viewOpen: open }))}>
      <Box gap="sm">
        <TabNoticeView id={t.id} at="view" places={AGGREGATION_PLACES} />
        <Row gap="xs" align="end">
          <Input label="View name" placeholder="shipped_orders" value={a.viewName} onChange={(v) => changeAgg(t.id, () => ({ viewName: v }))} onSubmit={() => void guard(t.id, () => createViewFromPipeline(t.id), 'view')()} />
          <Button icon="add" disabled={!a.viewName.trim()} onPress={guard(t.id, () => createViewFromPipeline(t.id), 'view')}>Create view</Button>
        </Row>
        <Text size="xs" muted>{`The view is created in ${t.ns.db} with the stages that are on. It runs the pipeline each time it is read.`}</Text>
        {a.created ? (
          <Row gap="xs" align="center">
            <Text size="sm">{`${t.ns.db}.${a.created} is ready.`}</Text>
            <Button size="sm" icon="open-external" onPress={guard(t.id, () => openCreatedView(t.id))}>Open the view</Button>
          </Row>
        ) : null}
      </Box>
    </Collapsible>
  )
}

function Saved({ t, a }: { t: CollTab; a: AggState }): OrcaNode {
  const saved = a.saved ?? []
  const sel = saved.find((s) => `p:${s.name}` === a.savedSelected)
  return (
    <Collapsible title="Saved pipelines" description={`${saved.length} saved`}>
      <Box gap="sm">
        <TabNoticeView id={t.id} at="library" places={AGGREGATION_PLACES} />
        <Row gap="xs" align="end">
          <Input label="Save this pipeline as" placeholder="Name" value={a.saveName} onChange={(v) => changeAgg(t.id, () => ({ saveName: v }))} onSubmit={() => void guard(t.id, () => savePipeline(t.id), 'library')()} />
          <Button icon="star" disabled={!a.saveName.trim()} onPress={guard(t.id, () => savePipeline(t.id), 'library')}>Save</Button>
        </Row>
        <Table
          label="Saved pipelines"
          columns={[
            { key: 'name', label: 'Name', width: 'sm' },
            { key: 'stages', label: 'Stages' },
            { key: 'at', label: 'Saved', width: 'sm', hideBelow: 'sm' }
          ]}
          rows={saved.map((s) => ({ key: `p:${s.name}`, cells: { name: s.name, stages: s.stages.map((x) => x.op).join(' → ') || '(none)', at: { type: 'relative', at: s.at, format: 'short' } } }))}
          selectionMode="single"
          selected={sel ? [a.savedSelected!] : []}
          emptyText="No saved pipelines for this collection."
          maxHeight="sm"
          onSelectionChange={({ keys }) => changeAgg(t.id, () => ({ savedSelected: keys[0] }))}
          onRowAction={({ key }) => void guard(t.id, () => loadSavedPipeline(t.id, key.slice(2)))()}
        />
        <Toolbar label="Saved pipeline actions" gap="xs">
          <Button size="sm" icon="download" disabled={!sel} onPress={guard(t.id, () => loadSavedPipeline(t.id, sel!.name))}>Load</Button>
          <Button size="sm" icon="delete" variant="ghost" tone="danger" disabled={!sel} onPress={guard(t.id, () => deleteSavedPipeline(t.id, sel!.name), 'library')}>Delete</Button>
        </Toolbar>
      </Box>
    </Collapsible>
  )
}

// ---- The tab ----

export function AggregationTab({ id }: { id: string }): OrcaNode {
  const t = read(collTabs)[id]
  const a = t?.agg
  if (!t || !a) return null
  const on = a.stages.filter((s) => s.enabled).length
  // Sections: the header, what runs the pipeline (with its notice), the stages, the results, then
  // the sections that open on demand.
  return (
    <Box gap="md">
      <Row gap="xs" align="center" justify="between">
        <Box gap="none" grow>
          <Text weight="semibold" truncate>{aggTitle(t)}</Text>
          <PlaceLine places={[{ connectionId: t.ns.connectionId, writes: true }]} />
          <Row gap="xs">
            <Badge tone="neutral">{`${on} of ${a.stages.length} stage${a.stages.length === 1 ? '' : 's'} on`}</Badge>
            {t.kind === 'view' ? <Badge tone="warning">On a view</Badge> : null}
          </Row>
        </Box>
        <IconButton icon="close" label={`Close ${t.title}`} variant="ghost" size="sm" onPress={() => closeTab(t.id)} />
      </Row>
      <Box gap="sm">
        <Toolbar label="Pipeline actions" gap="xs">
          <Button variant="solid" tone="accent" icon="play" disabled={t.loading} onPress={guard(t.id, () => runPipeline(t.id))}>
            {t.loading ? 'Running…' : 'Run'}
          </Button>
          <Button icon="gauge" variant="ghost" onPress={guard(t.id, async () => {
            changeExplain(t.id, { open: true })
            await runExplain(t.id)
          })}>Explain</Button>
          {a.textMode ? null : <Button icon="code" variant="ghost" onPress={() => editAsText(t.id)}>Edit as text</Button>}
          {a.textMode ? null : <IconButton icon="download" label="Export the results: JSON, CSV, BSON or another collection" variant="ghost" onPress={guard(t.id, () => exportPipeline(t.id))} />}
        </Toolbar>
        <Switch label="Allow disk use (for big $group and $sort stages)" checked={a.allowDiskUse} onChange={(v) => void guard(t.id, () => setAllowDiskUse(t.id, v))()} />
        {a.confirmWrite ? (
          <Callout tone="danger" icon="warning" title={`Run ${a.confirmWrite.stage} into ${a.confirmWrite.target}?`}>
            <Box gap="sm">
              <Text>{`${a.confirmWrite.stage === '$out' ? `$out replaces everything in ${a.confirmWrite.target} with this pipeline's results.` : `$merge writes this pipeline's results into ${a.confirmWrite.target}.`}${a.confirmWrite.exists === false ? ' It does not exist yet.' : typeof a.confirmWrite.count === 'number' ? ` It holds ${a.confirmWrite.count.toLocaleString('en-US')} document${a.confirmWrite.count === 1 ? '' : 's'} now${a.confirmWrite.stage === '$out' ? ', all replaced' : ''}.` : ''}`}</Text>
              <Row gap="xs">
                <Button variant="solid" tone="danger" onPress={guard(t.id, () => runPipeline(t.id, true))}>Run and write</Button>
                <Button variant="ghost" onPress={() => cancelWrite(t.id)}>Cancel</Button>
              </Row>
            </Box>
          </Callout>
        ) : null}
        <TabNoticeView id={t.id} at="top" places={AGGREGATION_PLACES} />
        {t.error ? <Callout tone="danger" icon="error" title="The pipeline failed">{t.error}</Callout> : null}
      </Box>
      <Separator />
      {a.textMode ? (
        <TextEditor t={t} a={a} />
      ) : (
        <Box gap="sm">
          <StageList t={t} a={a} />
          <StageEditor t={t} a={a} />
        </Box>
      )}
      {t.page || t.loading ? <Separator /> : null}
      <Box gap="sm">
        {t.page || t.loading ? <Text weight="semibold">Results</Text> : null}
        <Results t={t} />
        <TabNoticeView id={t.id} at="results" places={AGGREGATION_PLACES} />
      </Box>
      <Separator />
      <Box gap="sm">
        <ExplainSection t={t} />
        <Separator />
        <CreateView t={t} a={a} />
        <Separator />
        <Saved t={t} a={a} />
        <Separator />
        <CodeSection op={aggOperation(t)} description="The stages that are on, as driver code." emptyText="A stage does not parse yet: fix it to see its code." />
      </Box>
    </Box>
  )
}
