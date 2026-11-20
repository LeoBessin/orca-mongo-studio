// Aggregation tabs: a pipeline built stage by stage on one collection, with a preview of the
// selected stage's input and output, a run whose results page like a query's, explain, a view
// made from the pipeline, and saved pipelines. Each tab is a collection tab with `agg` set, so it
// reuses the results views, paging and counting.
import { plugin, read, set, update } from 'orca'
import type { AggOptions, Namespace } from '../protocol'
import type { JsonObject } from '../shared/ejson-view'
import { nodeKey, nodeTarget, type NodeKind } from '../shared/nodes'
import type { AggregateOperation } from '../shared/operation'
import {
  cloneStages,
  hasWriteStage,
  newStage,
  parsePipelineText,
  pipelineOf,
  pipelineText,
  stageId as freshStageId,
  previewPipelines,
  stageTexts,
  templateFor,
  writeTarget,
  type StageDraft
} from '../shared/pipeline'
import { collTabs, change, newTab, nsLabel, openNamespace, recount, say, startResultView, tab, tabIdFor, tabOrder, type AggState, type CollTab } from './collection-state'
import { openExport } from './export-state'
import { errorText, nodeIndex, refreshNode, view } from './state'

export const PREVIEW_SIZES = [5, 10, 20, 50, 100]

/** An aggregation tab's id: like its collection tab's, so reopening finds it. */
export function aggTabId(ns: Namespace): string {
  return tabIdFor(ns).replace(/^coll-/, 'agg-')
}

export function newAgg(stages: StageDraft[]): AggState {
  return {
    stages,
    ...(stages[0] ? { selected: stages[0].id } : {}),
    errors: {},
    previewSize: 10,
    previewSide: 'output',
    allowDiskUse: false,
    textMode: false,
    text: '',
    viewName: '',
    viewOpen: false,
    saveName: ''
  }
}

export function changeAgg(id: string, fn: (a: AggState, t: CollTab) => Partial<AggState>): void {
  change(id, (t) => (t.agg ? { agg: { ...t.agg, ...fn(t.agg, t) } } : {}))
}

/** Opens (or shows) the aggregation tab of a collection; `stages` replace its pipeline. */
export async function openAggregation(ns: Namespace, kind: NodeKind, stages?: StageDraft[], from?: string): Promise<void> {
  const id = aggTabId(ns)
  if (tab(id)) {
    set(view, id)
    if (stages) {
      changeAgg(id, () => ({ stages, selected: stages[0]?.id, errors: {}, textMode: false, confirmWrite: undefined }))
      if (from) say(id, 'neutral', `Loaded the pipeline from ${from}.`)
      await refreshPreview(id)
    }
    return
  }
  const t: CollTab = { ...newTab(id, ns, kind, `${ns.collection} · pipeline`), resultView: startResultView(), readOnly: true, agg: newAgg(stages ?? [newStage('$match')]) }
  if (from) t.notice = { tone: 'neutral', text: `Started from ${from}.` }
  update(collTabs, (prev) => ({ ...prev, [id]: t }))
  update(tabOrder, (prev) => [...prev, id])
  set(view, id)
  await Promise.all([refreshPreview(id), loadSavedPipelines(id)])
}

/** The tree's action: an aggregation tab for the selected collection, view or time-series. */
export async function openAggregationForNode(nodeKey: string): Promise<void> {
  const target = nodeTarget(nodeKey)
  if (!target.connectionId || !target.db || !target.collection) return
  const meta = read(nodeIndex)[nodeKey]
  await openAggregation({ connectionId: target.connectionId, db: target.db, collection: target.collection }, meta?.kind ?? target.kind)
}

// ---- Stages ----

function indexOf(a: AggState, stageId: string | undefined): number {
  return a.stages.findIndex((s) => s.id === stageId)
}

export async function selectStage(id: string, stageId: string): Promise<void> {
  changeAgg(id, () => ({ selected: stageId }))
  await refreshPreview(id)
}

/** Adds a stage after the selected one (or at the end), and selects it. */
export async function addStage(id: string, op: string): Promise<void> {
  const s = newStage(op)
  changeAgg(id, (a) => {
    const at = indexOf(a, a.selected)
    const stages = [...a.stages]
    stages.splice(at < 0 ? stages.length : at + 1, 0, s)
    return { stages, selected: s.id }
  })
  await refreshPreview(id)
}

export async function removeStage(id: string, stageId: string): Promise<void> {
  changeAgg(id, (a) => {
    const at = indexOf(a, stageId)
    const stages = a.stages.filter((s) => s.id !== stageId)
    const errors = { ...a.errors }
    delete errors[stageId]
    return { stages, errors, selected: stages[Math.min(Math.max(at, 0), stages.length - 1)]?.id }
  })
  await refreshPreview(id)
}

export async function moveStage(id: string, stageId: string, delta: -1 | 1): Promise<void> {
  changeAgg(id, (a) => {
    const at = indexOf(a, stageId)
    const to = at + delta
    if (at < 0 || to < 0 || to >= a.stages.length) return {}
    const stages = [...a.stages]
    ;[stages[at], stages[to]] = [stages[to]!, stages[at]!]
    return { stages }
  })
  await refreshPreview(id)
}

export async function duplicateStage(id: string, stageId: string): Promise<void> {
  changeAgg(id, (a) => {
    const at = indexOf(a, stageId)
    if (at < 0) return {}
    const copy = { ...a.stages[at]!, id: freshStageId() }
    const stages = [...a.stages]
    stages.splice(at + 1, 0, copy)
    return { stages, selected: copy.id }
  })
  await refreshPreview(id)
}

export async function toggleStage(id: string, stageId: string): Promise<void> {
  changeAgg(id, (a) => ({ stages: a.stages.map((s) => (s.id === stageId ? { ...s, enabled: !s.enabled } : s)) }))
  await refreshPreview(id)
}

/** A new operator keeps what was typed, unless it was the old operator's template. */
export function setStageOp(id: string, stageId: string, op: string): void {
  changeAgg(id, (a) => {
    const errors = { ...a.errors }
    delete errors[stageId]
    return {
      errors,
      stages: a.stages.map((s) => (s.id !== stageId ? s : { ...s, op, body: !s.body.trim() || s.body === templateFor(s.op) ? templateFor(op) : s.body }))
    }
  })
}

export function setStageBody(id: string, stageId: string, body: string): void {
  changeAgg(id, (a) => {
    const errors = { ...a.errors }
    delete errors[stageId]
    return { errors, stages: a.stages.map((s) => (s.id === stageId ? { ...s, body } : s)) }
  })
}

// ---- Preview ----

function options(a: AggState): AggOptions {
  return a.allowDiskUse ? { allowDiskUse: true } : {}
}

/** Reads the selected stage's input and output again. */
export async function refreshPreview(id: string): Promise<void> {
  const t = tab(id)
  const a = t?.agg
  if (!t || !a) return
  const at = indexOf(a, a.selected)
  if (at < 0) {
    changeAgg(id, () => ({ preview: undefined }))
    return
  }
  const stageId = a.stages[at]!.id
  const token = (a.preview?.token ?? 0) + 1
  const p = previewPipelines(a.stages, at)
  const failed = Object.keys(p.errors)
  if (failed.length) {
    const first = a.stages.findIndex((s) => p.errors[s.id])
    changeAgg(id, (x) => ({
      errors: { ...x.errors, ...p.errors },
      preview: { stageId, loading: false, token, error: first === at ? `This stage does not parse: ${p.errors[stageId]}` : `Stage ${first + 1} does not parse, so there is nothing to preview. Fix it first.` }
    }))
    return
  }
  if (!p.before) {
    changeAgg(id, () => ({ preview: { stageId, loading: false, token, ...(p.note ? { note: p.note } : {}) } }))
    return
  }
  changeAgg(id, (x) => ({ preview: { stageId, loading: true, token, ...(x.preview?.stageId === stageId && x.preview.result ? { result: x.preview.result } : {}), ...(p.note ? { note: p.note } : {}) } }))
  try {
    const result = await plugin.request('agg.preview', { ns: t.ns, before: p.before, ...(p.stage ? { stage: p.stage } : {}), size: a.previewSize, options: options(a) }, { timeoutMs: 60000 })
    changeAgg(id, (x) => (x.preview?.token === token ? { preview: { ...x.preview, loading: false, result, error: undefined } } : {}))
  } catch (error) {
    changeAgg(id, (x) => (x.preview?.token === token ? { preview: { stageId, loading: false, token, error: errorText(error) } } : {}))
  }
}

export async function setPreviewSize(id: string, size: number): Promise<void> {
  changeAgg(id, () => ({ previewSize: size }))
  await refreshPreview(id)
}

export async function setAllowDiskUse(id: string, allowDiskUse: boolean): Promise<void> {
  changeAgg(id, () => ({ allowDiskUse }))
  await refreshPreview(id)
}

// ---- Running ----

/** The enabled stages, or nothing with the broken stages marked and the first selected. */
function parsed(id: string): JsonObject[] | undefined {
  const a = tab(id)?.agg
  if (!a) return undefined
  const { pipeline, errors } = pipelineOf(a.stages)
  if (pipeline) return pipeline
  const first = a.stages.find((s) => errors[s.id])
  changeAgg(id, (x) => ({ errors: { ...x.errors, ...errors }, ...(first ? { selected: first.id } : {}) }))
  say(id, 'danger', `Stage ${a.stages.indexOf(first!) + 1} (${first!.op}) does not parse: ${errors[first!.id]}`)
  return undefined
}

/** Opens the Export tab with the enabled stages, as they are now. */
export function exportPipeline(id: string): void {
  const t = tab(id)
  const a = t?.agg
  if (!t || !a) return
  if (a.textMode) throw new Error('Apply the text first, then export.')
  const pipeline = parsed(id)
  if (!pipeline) return
  if (hasWriteStage(pipeline)) throw new Error('This pipeline writes with $out or $merge: run it, then export the collection it writes.')
  openExport({ kind: 'pipeline', ns: t.ns, pipeline, options: options(a) })
}

/** Runs the enabled stages. A pipeline that writes asks first; `confirmed` is the answer. */
export async function runPipeline(id: string, confirmed = false): Promise<void> {
  const t = tab(id)
  const a = t?.agg
  if (!t || !a) return
  const pipeline = parsed(id)
  if (!pipeline) return
  const write = writeTarget(pipeline, t.ns.db)
  if (write && !confirmed) {
    const target = write.ns
    const c = target ? await plugin.request('data.count', { ns: { connectionId: t.ns.connectionId, ...target } }).catch(() => undefined) : undefined
    changeAgg(id, () => ({ confirmWrite: { stage: write.stage, target: write.target, ...(c ? { count: c.count, exists: c.exists } : {}) } }))
    return
  }
  if (t.queryId) void plugin.request('query.close', { queryId: t.queryId }).catch(() => undefined)
  const ran = { pipeline, options: options(a) }
  const token = t.runToken + 1
  change(id, (x) => ({
    loading: true,
    error: undefined,
    runToken: token,
    agg: { ...x.agg!, ran, confirmWrite: undefined },
    count: write ? undefined : 'counting',
    selectedRows: [],
    treeSelected: undefined,
    treeExpanded: [],
    notice: undefined,
    page: undefined,
    queryId: undefined
  }))
  try {
    const page = await plugin.request('agg.run', { ns: t.ns, pipeline, options: ran.options, pageSize: t.pageSize }, { timeoutMs: 120000 })
    if (tab(id)?.runToken !== token) {
      void plugin.request('query.close', { queryId: page.queryId }).catch(() => undefined)
      return
    }
    change(id, () => ({ page, queryId: page.queryId, loading: false }))
    if (write) say(id, 'success', `Ran the pipeline: ${write.stage} wrote its results to ${write.target}.`)
  } catch (error) {
    if (tab(id)?.runToken === token) change(id, () => ({ loading: false, error: errorText(error), page: undefined, queryId: undefined, count: undefined }))
    return
  }
  if (!write) await recount(id)
}

export function cancelWrite(id: string): void {
  changeAgg(id, () => ({ confirmWrite: undefined }))
}

/** The pipeline as an operation, for code generation; undefined while a stage doesn't parse. */
export function aggOperation(t: CollTab): AggregateOperation | undefined {
  if (!t.agg) return undefined
  const { pipeline } = pipelineOf(t.agg.stages)
  return pipeline ? { kind: 'aggregate', db: t.ns.db, collection: t.ns.collection, pipeline } : undefined
}

// ---- Text mode ----

export function editAsText(id: string): void {
  changeAgg(id, (a) => ({ textMode: true, text: pipelineText(a.stages), textError: undefined }))
}

export function setPipelineText(id: string, text: string): void {
  changeAgg(id, () => ({ text, textError: undefined }))
}

export function leaveText(id: string): void {
  changeAgg(id, () => ({ textMode: false, textError: undefined }))
}

/** Replaces the stages with the typed pipeline. */
export async function applyText(id: string): Promise<void> {
  const a = tab(id)?.agg
  if (!a) return
  const r = parsePipelineText(a.text)
  if (!r.stages) {
    changeAgg(id, () => ({ textError: r.error }))
    return
  }
  const stages = r.stages.length ? r.stages : [newStage('$match')]
  changeAgg(id, () => ({ stages, selected: stages[0]!.id, errors: {}, textMode: false, textError: undefined }))
  await refreshPreview(id)
}

// ---- Views ----

export async function createViewFromPipeline(id: string): Promise<void> {
  const t = tab(id)
  const a = t?.agg
  if (!t || !a) return
  const pipeline = parsed(id)
  if (!pipeline) return
  if (writeTarget(pipeline, t.ns.db)) {
    say(id, 'danger', 'A view cannot hold a $out or $merge stage. Turn it off or remove it first.', 'view')
    return
  }
  const { name } = await plugin.request('view.create', { ns: t.ns, name: a.viewName, pipeline }, { timeoutMs: 60000 })
  changeAgg(id, () => ({ created: name, viewName: '' }))
  say(id, 'success', `Created the view ${t.ns.db}.${name} on ${t.ns.collection}, with ${pipeline.length} stage${pipeline.length === 1 ? '' : 's'}.`, 'view')
  await refreshNode(nodeKey([{ kind: 'conn', name: t.ns.connectionId }, { kind: 'db', name: t.ns.db }])).catch(() => undefined)
}

export async function openCreatedView(id: string): Promise<void> {
  const t = tab(id)
  const name = t?.agg?.created
  if (!t || !name) return
  changeAgg(id, () => ({ created: undefined }))
  await openNamespace({ connectionId: t.ns.connectionId, db: t.ns.db, collection: name }, 'view')
}

// ---- Saved pipelines ----

export async function loadSavedPipelines(id: string): Promise<void> {
  const t = tab(id)
  if (!t?.agg) return
  try {
    const { saved } = await plugin.request('pipelines.list', { ns: t.ns })
    changeAgg(id, () => ({ saved }))
  } catch {
    // A convenience: the tab works without it.
  }
}

export async function savePipeline(id: string): Promise<void> {
  const t = tab(id)
  const a = t?.agg
  if (!t || !a) return
  const name = a.saveName.trim()
  const { saved } = await plugin.request('pipelines.save', { ns: t.ns, name, stages: stageTexts(a.stages) })
  changeAgg(id, () => ({ saved, saveName: '', savedSelected: `p:${name}` }))
  say(id, 'success', `Saved the pipeline as "${name}".`, 'library')
}

export async function loadSavedPipeline(id: string, name: string): Promise<void> {
  const t = tab(id)
  const s = t?.agg?.saved?.find((x) => x.name === name)
  if (!t || !s) return
  const stages = s.stages.length ? cloneStages(s.stages) : [newStage('$match')]
  changeAgg(id, () => ({ stages, selected: stages[0]!.id, errors: {}, textMode: false, confirmWrite: undefined }))
  say(id, 'neutral', `Loaded "${name}". Run it to see its results.`)
  await refreshPreview(id)
}

export async function deleteSavedPipeline(id: string, name: string): Promise<void> {
  const t = tab(id)
  if (!t?.agg) return
  const { saved } = await plugin.request('pipelines.delete', { ns: t.ns, name })
  changeAgg(id, () => ({ saved, savedSelected: undefined }))
}

export function aggTitle(t: CollTab): string {
  return `${nsLabel(t.ns)} · aggregation`
}
