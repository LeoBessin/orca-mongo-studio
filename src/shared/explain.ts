// Explain output, read: the worker runs `explain` and passes the answer here (relaxed Extended
// JSON, numbers as numbers), which turns it into what the panel draws: a summary (what it returned
// and examined, which indexes, warnings) and a tree of plan stages with their own numbers.
//
// It reads every shape MongoDB 4.4 to 8.x gives:
// - a find, or a pipeline the server pushed down whole: `queryPlanner` + `executionStats`;
// - a pipeline: `stages: [{ $cursor: { queryPlanner, executionStats } }, { $group, nReturned }, …]`;
// - the slot-based engine (7.0+): `winningPlan.queryPlan` for the plan, and SBE stages in
//   `executionStats` matched to it by `planNodeId`;
// - sharded: `SHARD_MERGE` with `shards: [...]`, and a pipeline's `shards: { name: … }` with
//   `splitPipeline`.

export type ExplainVerbosity = 'queryPlanner' | 'executionStats' | 'allPlansExecution'

export const VERBOSITY_OPTIONS: { value: ExplainVerbosity; label: string }[] = [
  { value: 'queryPlanner', label: 'Plan only (queryPlanner)' },
  { value: 'executionStats', label: 'Run it (executionStats)' },
  { value: 'allPlansExecution', label: 'Run every plan (allPlansExecution)' }
]

export type PlanAttr = { label: string; value: string }

export type PlanNode = {
  /** Unique in the tree, letters, digits and `-`: `n0`, `n0-1`. */
  key: string
  stage: string
  /** The one thing to know about the stage: its index, filter, sort, limit. */
  detail?: string
  nReturned?: number
  timeMs?: number
  keysExamined?: number
  docsExamined?: number
  warning?: string
  attrs: PlanAttr[]
  children: PlanNode[]
}

export type ExplainSummary = {
  kind: 'find' | 'aggregate'
  namespace?: string
  /** Whether the server ran the plan (executionStats or allPlansExecution). */
  hasStats: boolean
  nReturned?: number
  timeMs?: number
  keysExamined?: number
  docsExamined?: number
  indexes: string[]
  collectionScan: boolean
  inMemorySort: boolean
  rejectedPlans: number
  sharded: boolean
  serverVersion?: string
  warnings: string[]
  /** In the order to show: a find's plan root (the last stage, reading inputs below it), or a
   *  pipeline's stages first to last. */
  stages: PlanNode[]
}

type Obj = { [key: string]: unknown }

function isObj(v: unknown): v is Obj {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

/** A number, from a plain number or a `$numberLong`-style wrapper. */
export function num(v: unknown): number | undefined {
  if (typeof v === 'number' && Number.isFinite(v)) return v
  if (isObj(v)) {
    const s = v.$numberLong ?? v.$numberInt ?? v.$numberDouble
    if (typeof s === 'string' && s.trim() !== '' && Number.isFinite(Number(s))) return Number(s)
  }
  return undefined
}

const IDENT = /^[A-Za-z_$][A-Za-z0-9_$]*$/

/** Short, shell-like text of a value: `{ status: 1 }`, `["shipped", "shipped"]`. */
export function brief(v: unknown, max = 200): string {
  const out = briefRaw(v, 0)
  return out.length > max ? `${out.slice(0, max - 1)}…` : out
}

function briefRaw(v: unknown, depth: number): string {
  if (v === null || v === undefined) return 'null'
  if (typeof v === 'string') return JSON.stringify(v)
  if (typeof v === 'number' || typeof v === 'boolean') return String(v)
  if (depth > 8) return '…'
  if (Array.isArray(v)) return v.length ? `[${v.map((x) => briefRaw(x, depth + 1)).join(', ')}]` : '[]'
  if (isObj(v)) {
    const n = num(v)
    if (n !== undefined) return String(n)
    if (typeof v.$oid === 'string') return `ObjectId('${v.$oid}')`
    if (isObj(v.$date) || typeof v.$date === 'string') return `ISODate(${JSON.stringify(typeof v.$date === 'string' ? v.$date : num(v.$date))})`
    const entries = Object.entries(v)
    if (!entries.length) return '{}'
    return `{ ${entries.map(([k, x]) => `${IDENT.test(k) ? k : JSON.stringify(k)}: ${briefRaw(x, depth + 1)}`).join(', ')} }`
  }
  return String(v)
}

// ---- Plan trees ----

/** Run-time counters every stage has; not worth a line each. */
const NOISE = new Set([
  'stage', 'planNodeId', 'works', 'advanced', 'needTime', 'needYield', 'saveState', 'restoreState', 'isEOF', 'opens', 'closes',
  'nReturned', 'executionTimeMillisEstimate', 'executionTimeMillis', 'keysExamined', 'docsExamined', 'inputStage', 'inputStages',
  'shards', 'isCached', 'indexVersion', 'multiKeyPaths', 'nss', 'shardName', 'connectionString', 'serverInfo', 'executionStages',
  'winningPlan', 'queryPlan', 'slotBasedPlan', 'rejectedPlans', 'executionSuccess', 'totalKeysExamined', 'totalDocsExamined'
])
const ATTR_MAX = 20

function attrsOf(node: Obj): PlanAttr[] {
  const out: PlanAttr[] = []
  for (const [k, v] of Object.entries(node)) {
    if (NOISE.has(k) || out.length >= ATTR_MAX) continue
    if (isObj(v) && typeof v.stage === 'string') continue
    if (Array.isArray(v) && v.some((x) => isObj(x) && typeof x.stage === 'string')) continue
    out.push({ label: k, value: typeof v === 'string' ? v : brief(v) })
  }
  return out
}

function detailOf(node: Obj): string | undefined {
  if (typeof node.indexName === 'string') return isObj(node.keyPattern) ? `${node.indexName} ${brief(node.keyPattern, 120)}` : node.indexName
  if (isObj(node.filter) && Object.keys(node.filter).length) return brief(node.filter, 120)
  if (isObj(node.sortPattern)) return `by ${brief(node.sortPattern, 120)}`
  if (node.limitAmount !== undefined) return `limit ${brief(node.limitAmount)}`
  if (node.skipAmount !== undefined) return `skip ${brief(node.skipAmount)}`
  if (isObj(node.transformBy)) return brief(node.transformBy, 120)
  if (typeof node.foreignCollection === 'string') return `from ${node.foreignCollection}`
  return undefined
}

/** The plan stages directly under a stage, whatever the key: inputStage, inputStages,
 *  thenStage, outerStage, … */
function childStages(node: Obj): Obj[] {
  const out: Obj[] = []
  for (const [k, v] of Object.entries(node)) {
    if (k === 'shards') continue
    if (isObj(v) && typeof v.stage === 'string') out.push(v)
    else if (Array.isArray(v)) for (const x of v) if (isObj(x) && typeof x.stage === 'string') out.push(x)
  }
  return out
}

type SbeStats = Map<number, { nReturned?: number; timeMs?: number; keys: number; docs: number }>

/** SBE run-time stats by the plan node they belong to: the first (outermost) stage of a node
 *  carries its output count and time. */
function sbeStats(root: Obj): SbeStats {
  const map: SbeStats = new Map()
  const walk = (node: Obj, depth: number): void => {
    if (depth > 200) return
    const id = num(node.planNodeId)
    if (id !== undefined) {
      let s = map.get(id)
      if (!s) {
        s = { keys: 0, docs: 0 }
        const n = num(node.nReturned)
        const t = num(node.executionTimeMillisEstimate)
        if (n !== undefined) s.nReturned = n
        if (t !== undefined) s.timeMs = t
        map.set(id, s)
      }
      s.keys += num(node.keysExamined) ?? 0
      if (node.stage === 'fetch' || node.stage === 'scan' || node.stage === 'seek') s.docs += num(node.numReads) ?? 0
    }
    for (const c of childStages(node)) walk(c, depth + 1)
  }
  walk(root, 0)
  return map
}

/** Whether execution stages are the classic engine's (stage names in capitals) rather than SBE. */
function isClassic(node: Obj): boolean {
  return typeof node.stage === 'string' && node.stage === node.stage.toUpperCase()
}

function planNode(node: Obj, key: string, sbe: SbeStats | undefined, depth = 0): PlanNode {
  const stage = String(node.stage)
  const out: PlanNode = { key, stage, attrs: attrsOf(node), children: [] }
  const detail = detailOf(node)
  if (detail) out.detail = detail
  const id = num(node.planNodeId)
  const fromSbe = sbe && id !== undefined ? sbe.get(id) : undefined
  const nReturned = fromSbe ? fromSbe.nReturned : num(node.nReturned)
  const timeMs = fromSbe ? fromSbe.timeMs : num(node.executionTimeMillisEstimate)
  const keys = fromSbe ? (fromSbe.keys || undefined) : num(node.keysExamined)
  const docs = fromSbe ? (fromSbe.docs || undefined) : num(node.docsExamined)
  if (nReturned !== undefined) out.nReturned = nReturned
  if (timeMs !== undefined) out.timeMs = timeMs
  if (keys !== undefined) out.keysExamined = keys
  if (docs !== undefined) out.docsExamined = docs
  if (stage === 'COLLSCAN') out.warning = 'Reads the whole collection'
  else if (stage === 'SORT') out.warning = node.usedDisk === true ? 'Sorts in memory, and spilled to disk' : 'Sorts in memory'
  else if (node.usedDisk === true) out.warning = 'Spilled to disk'
  if (depth > 100) return out
  if (Array.isArray(node.shards)) {
    out.children = node.shards.filter(isObj).map((sh, i) => shardNode(sh, `${key}-${i}`, depth + 1))
  } else {
    out.children = childStages(node).map((c, i) => planNode(c, `${key}-${i}`, sbe, depth + 1))
  }
  return out
}

function shardNode(sh: Obj, key: string, depth: number): PlanNode {
  const node: PlanNode = { key, stage: `Shard ${typeof sh.shardName === 'string' ? sh.shardName : '?'}`, attrs: [], children: [] }
  const n = num(sh.nReturned)
  const t = num(sh.executionTimeMillis ?? sh.executionTimeMillisEstimate)
  const k = num(sh.totalKeysExamined)
  const d = num(sh.totalDocsExamined)
  if (n !== undefined) node.nReturned = n
  if (t !== undefined) node.timeMs = t
  if (k !== undefined) node.keysExamined = k
  if (d !== undefined) node.docsExamined = d
  if (typeof sh.connectionString === 'string') node.attrs.push({ label: 'connectionString', value: sh.connectionString })
  const exec = isObj(sh.executionStages) ? sh.executionStages : undefined
  const wp = isObj(sh.winningPlan) ? sh.winningPlan : undefined
  const root = exec && isClassic(exec) ? exec : wp ? (isObj(wp.queryPlan) ? wp.queryPlan : wp) : exec
  if (root && typeof root.stage === 'string') {
    node.children = [planNode(root, `${key}-0`, exec && !isClassic(exec) ? sbeStats(exec) : undefined, depth + 1)]
  }
  return node
}

/** A query layer: `{ queryPlanner, executionStats }`, from a find or a pipeline's `$cursor`. */
type Layer = { root?: PlanNode; nReturned?: number; timeMs?: number; keys?: number; docs?: number; rejected: number; namespace?: string; failed?: string; hasStats: boolean }

function layerOf(q: Obj, key: string): Layer {
  const qp = isObj(q.queryPlanner) ? q.queryPlanner : {}
  const es = isObj(q.executionStats) ? q.executionStats : undefined
  const wp = isObj(qp.winningPlan) ? qp.winningPlan : undefined
  const exec = es && isObj(es.executionStages) ? es.executionStages : undefined
  const layer: Layer = { rejected: Array.isArray(qp.rejectedPlans) ? qp.rejectedPlans.length : 0, hasStats: es !== undefined }
  if (typeof qp.namespace === 'string') layer.namespace = qp.namespace
  if (exec && isClassic(exec)) layer.root = planNode(exec, key, undefined)
  else if (wp) {
    const plan = isObj(wp.queryPlan) ? wp.queryPlan : wp
    if (typeof plan.stage === 'string') layer.root = planNode(plan, key, exec ? sbeStats(exec) : undefined)
  }
  if (es) {
    const n = num(es.nReturned)
    const t = num(es.executionTimeMillis)
    const k = num(es.totalKeysExamined)
    const d = num(es.totalDocsExamined)
    if (n !== undefined) layer.nReturned = n
    if (t !== undefined) layer.timeMs = t
    if (k !== undefined) layer.keys = k
    if (d !== undefined) layer.docs = d
    if (es.executionSuccess === false) layer.failed = typeof es.errorMessage === 'string' ? es.errorMessage : 'The plan stopped with an error.'
  }
  return layer
}

/** A pipeline stage of `stages: [...]`: `{ $group: {...}, nReturned, executionTimeMillisEstimate }`. */
function pipelineNode(el: Obj, key: string, layers: Layer[]): PlanNode {
  const name = Object.keys(el).find((k) => k.startsWith('$')) ?? '?'
  const spec = el[name]
  const node: PlanNode = { key, stage: name, attrs: [], children: [] }
  if (name === '$cursor' && isObj(spec)) {
    const layer = layerOf(spec, `${key}-0`)
    layers.push(layer)
    if (layer.root) node.children = [layer.root]
    node.detail = layer.root ? (layer.root.detail ? `${layer.root.stage} ${layer.root.detail}` : layer.root.stage) : 'reads the collection'
  } else {
    node.attrs.push({ label: 'definition', value: brief(spec, 400) })
    const d = brief(spec, 100)
    if (d !== '{}') node.detail = d
  }
  const n = num(el.nReturned)
  const t = num(el.executionTimeMillisEstimate)
  if (n !== undefined) node.nReturned = n
  if (t !== undefined) node.timeMs = t
  for (const [k, v] of Object.entries(el)) {
    if (k === name || k === 'nReturned' || k === 'executionTimeMillisEstimate') continue
    node.attrs.push({ label: k, value: brief(v) })
  }
  if (name === '$sort') node.warning = el.usedDisk === true ? 'Sorts in memory, and spilled to disk' : 'Sorts in memory'
  else if (el.usedDisk === true) node.warning = 'Spilled to disk'
  return node
}

function walkNodes(nodes: readonly PlanNode[], visit: (n: PlanNode) => void): void {
  for (const n of nodes) {
    visit(n)
    walkNodes(n.children, visit)
  }
}

function sum(values: (number | undefined)[]): number | undefined {
  const known = values.filter((v): v is number => v !== undefined)
  return known.length ? known.reduce((a, b) => a + b, 0) : undefined
}

function fmt(n: number): string {
  return n.toLocaleString('en-US')
}

/** Reads an explain answer. `kind` says whether it explained a find or an aggregate. */
export function summarizeExplain(raw: Obj, kind: 'find' | 'aggregate'): ExplainSummary {
  const layers: Layer[] = []
  let stages: PlanNode[] = []
  let sharded = false
  let lastStageReturned: number | undefined
  let lastStageTime: number | undefined

  if (Array.isArray(raw.stages)) {
    stages = raw.stages.filter(isObj).map((el, i) => pipelineNode(el, `n${i}`, layers))
    const last = stages[stages.length - 1]
    lastStageReturned = last?.nReturned
    lastStageTime = last?.timeMs
  } else if (isObj(raw.shards)) {
    // A pipeline on a sharded cluster: each shard's part, then the merging part.
    sharded = true
    const shardNodes: PlanNode[] = Object.entries(raw.shards).map(([name, part], i) => {
      const key = `n0-${i}`
      const node: PlanNode = { key, stage: `Shard ${name}`, attrs: [], children: [] }
      if (isObj(part)) {
        if (Array.isArray(part.stages)) node.children = part.stages.filter(isObj).map((el, j) => pipelineNode(el, `${key}-${j}`, layers))
        else if (isObj(part.queryPlanner)) {
          const layer = layerOf(part, `${key}-0`)
          layers.push(layer)
          if (layer.root) node.children = [layer.root]
        }
      }
      return node
    })
    stages = [{ key: 'n0', stage: 'Shards', detail: `${shardNodes.length} shard${shardNodes.length === 1 ? '' : 's'}`, attrs: [], children: shardNodes }]
    const split = isObj(raw.splitPipeline) ? raw.splitPipeline : undefined
    const merger = split && Array.isArray(split.mergerPart) ? split.mergerPart.filter(isObj) : []
    merger.forEach((el, i) => stages.push({ ...pipelineNode(el, `n${i + 1}`, layers), attrs: [{ label: 'runs on', value: typeof raw.mergeType === 'string' ? raw.mergeType : 'the merging node' }] }))
  } else {
    const layer = layerOf(raw, 'n0')
    layers.push(layer)
    if (layer.root) stages = [layer.root]
  }

  walkNodes(stages, (n) => {
    if (n.stage === 'SHARD_MERGE' || n.stage === 'SINGLE_SHARD' || n.stage === 'SHARD_MERGE_SORT' || n.stage.startsWith('Shard ')) sharded = true
  })

  const indexes = new Set<string>()
  let collectionScan = false
  let inMemorySort = false
  let usedDisk = false
  walkNodes(stages, (n) => {
    const idx = n.attrs.find((a) => a.label === 'indexName')?.value
    if (idx && n.stage !== 'EQ_LOOKUP') indexes.add(idx)
    if (n.stage === 'IDHACK' || n.stage === 'EXPRESS_IXSCAN' || n.stage === 'EXPRESS_CLUSTERED_IXSCAN') indexes.add(idx ?? '_id_')
    if (n.stage === 'COLLSCAN') collectionScan = true
    if (n.stage === 'SORT' || n.stage === '$sort') inMemorySort = true
    if (n.warning?.includes('disk')) usedDisk = true
  })

  const hasStats = layers.some((l) => l.hasStats) || lastStageReturned !== undefined
  const summary: ExplainSummary = {
    kind,
    hasStats,
    indexes: [...indexes],
    collectionScan,
    inMemorySort,
    rejectedPlans: layers.reduce((a, l) => a + l.rejected, 0),
    sharded,
    warnings: [],
    stages
  }
  const namespace = layers.find((l) => l.namespace)?.namespace
  if (namespace) summary.namespace = namespace
  const nReturned = lastStageReturned ?? (layers.length === 1 ? layers[0]!.nReturned : sum(layers.map((l) => l.nReturned)))
  const timeMs = lastStageTime !== undefined ? Math.max(lastStageTime, ...layers.map((l) => l.timeMs ?? 0)) : layers.length ? Math.max(...layers.map((l) => l.timeMs ?? 0)) : undefined
  const keys = sum(layers.map((l) => l.keys))
  const docs = sum(layers.map((l) => l.docs))
  if (hasStats) {
    if (nReturned !== undefined) summary.nReturned = nReturned
    if (timeMs !== undefined) summary.timeMs = timeMs
    if (keys !== undefined) summary.keysExamined = keys
    if (docs !== undefined) summary.docsExamined = docs
  }
  const info = isObj(raw.serverInfo) ? raw.serverInfo : undefined
  if (info && typeof info.version === 'string') summary.serverVersion = info.version

  for (const l of layers) if (l.failed) summary.warnings.push(`The plan stopped: ${l.failed}`)
  if (collectionScan) summary.warnings.push('A collection scan reads every document. An index on the fields the query filters on would avoid it.')
  if (inMemorySort) summary.warnings.push('Results are sorted in memory. An index in the order of the sort avoids that, and a large in-memory sort needs allowDiskUse.')
  if (usedDisk) summary.warnings.push('A stage ran out of memory and spilled to disk, which is slow.')
  if (summary.docsExamined !== undefined && summary.docsExamined >= 1000) {
    const returned = Math.max(summary.nReturned ?? 0, 1)
    if (summary.docsExamined / returned >= 10) {
      summary.warnings.push(`It examined ${fmt(summary.docsExamined)} documents to return ${fmt(summary.nReturned ?? 0)}. A more selective index would examine fewer.`)
    }
  }
  return summary
}

/** The line a plan stage shows in the tree. */
export function nodeLabel(n: PlanNode): string {
  return n.detail ? `${n.stage}  ${n.detail}` : n.stage
}

/** Its numbers, for the tree's description. */
export function nodeStats(n: PlanNode): string {
  const parts: string[] = []
  if (n.nReturned !== undefined) parts.push(`${fmt(n.nReturned)} out`)
  if (n.keysExamined !== undefined) parts.push(`${fmt(n.keysExamined)} keys`)
  if (n.docsExamined !== undefined) parts.push(`${fmt(n.docsExamined)} docs`)
  if (n.timeMs !== undefined) parts.push(`${fmt(n.timeMs)} ms`)
  if (n.warning) parts.push(n.warning)
  return parts.join(' · ')
}

/** Every node key, to open the whole tree. */
export function allNodeKeys(stages: readonly PlanNode[]): string[] {
  const out: string[] = []
  walkNodes(stages, (n) => {
    if (n.children.length) out.push(n.key)
  })
  return out
}

export function findNode(stages: readonly PlanNode[], key: string): PlanNode | undefined {
  let found: PlanNode | undefined
  walkNodes(stages, (n) => {
    if (n.key === key) found = n
  })
  return found
}
