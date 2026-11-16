// The aggregation editor's model: a pipeline as a list of stage drafts (operator, body as typed in
// shell syntax, on or off), and what turns them into a pipeline, back into text, and into the
// pipelines a stage's preview runs. Pure; the panel and its tests use it.
import { bsonType, isObject, toShell, toShellInline, type JsonObject, type JsonValue } from './ejson-view'
import { parseShell, ShellParseError } from './shell-parse'

export type StageDraft = {
  id: string
  /** `$match`, `$group`, … */
  op: string
  /** The stage's value in shell syntax: `{ status: 'A' }`, `10`, `'$items'`. */
  body: string
  enabled: boolean
}

/** A stage as saved: the draft without its id. */
export type StageText = Omit<StageDraft, 'id'>

/** Every stage the editor offers, the common ones first; a body is a starting point to fill in. */
export const STAGE_TEMPLATES: readonly { op: string; body: string; info: string }[] = [
  { op: '$match', body: '{ }', info: 'Keeps documents that match a query.' },
  { op: '$project', body: '{ _id: 0, field: 1 }', info: 'Keeps, drops or computes fields.' },
  { op: '$addFields', body: "{ newField: '$field' }", info: 'Adds computed fields.' },
  { op: '$set', body: "{ newField: '$field' }", info: 'Adds computed fields (same as $addFields).' },
  { op: '$unset', body: "'field'", info: 'Removes fields.' },
  { op: '$group', body: "{ _id: '$field', count: { $sum: 1 } }", info: 'Groups by a key and accumulates.' },
  { op: '$sort', body: '{ field: -1 }', info: 'Sorts the documents.' },
  { op: '$limit', body: '10', info: 'Passes the first n documents.' },
  { op: '$skip', body: '0', info: 'Skips the first n documents.' },
  { op: '$count', body: "'count'", info: 'One document with the number of documents.' },
  { op: '$unwind', body: "{ path: '$items', preserveNullAndEmptyArrays: false }", info: 'One document per array item.' },
  { op: '$lookup', body: "{ from: 'collection', localField: 'field', foreignField: '_id', as: 'joined' }", info: 'Joins documents of another collection.' },
  { op: '$facet', body: '{ byStatus: [{ $sortByCount: \'$status\' }] }', info: 'Runs several pipelines on the same input.' },
  { op: '$bucket', body: "{ groupBy: '$field', boundaries: [0, 100, 1000], default: 'other' }", info: 'Groups into ranges you give.' },
  { op: '$bucketAuto', body: "{ groupBy: '$field', buckets: 5 }", info: 'Groups into a number of even ranges.' },
  { op: '$sortByCount', body: "'$field'", info: 'Counts by a value, most frequent first.' },
  { op: '$replaceRoot', body: "{ newRoot: '$field' }", info: 'Replaces each document with a sub-document.' },
  { op: '$replaceWith', body: "'$field'", info: 'Replaces each document with an expression.' },
  { op: '$sample', body: '{ size: 10 }', info: 'Picks documents at random.' },
  { op: '$unionWith', body: "{ coll: 'collection', pipeline: [] }", info: "Adds another collection's documents." },
  { op: '$graphLookup', body: "{ from: 'collection', startWith: '$field', connectFromField: 'field', connectToField: '_id', as: 'path' }", info: 'Recursive lookup.' },
  { op: '$setWindowFields', body: "{ partitionBy: '$field', sortBy: { date: 1 }, output: { total: { $sum: '$amount', window: { documents: ['unbounded', 'current'] } } } }", info: 'Running totals, ranks and moving windows.' },
  { op: '$densify', body: "{ field: 'date', range: { step: 1, unit: 'day', bounds: 'full' } }", info: 'Fills gaps in a sequence.' },
  { op: '$fill', body: "{ sortBy: { date: 1 }, output: { value: { method: 'locf' } } }", info: 'Fills missing values.' },
  { op: '$redact', body: "{ $cond: { if: true, then: '$$KEEP', else: '$$PRUNE' } }", info: 'Prunes parts of documents.' },
  { op: '$geoNear', body: "{ near: { type: 'Point', coordinates: [0, 0] }, distanceField: 'distance', spherical: true }", info: 'Sorts by distance (first stage only).' },
  { op: '$collStats', body: '{ storageStats: {} }', info: 'Collection statistics (first stage only).' },
  { op: '$indexStats', body: '{}', info: 'Index usage (first stage only).' },
  { op: '$out', body: "'collection'", info: 'Writes the results to a collection, replacing it (last stage only).' },
  { op: '$merge', body: "{ into: 'collection', whenMatched: 'merge', whenNotMatched: 'insert' }", info: 'Merges the results into a collection (last stage only).' }
]

export const STAGE_OPTIONS: { value: string; label: string }[] = STAGE_TEMPLATES.map((s) => ({ value: s.op, label: s.op }))

/** Stages that write: a pipeline with one runs only on Run, after a confirmation. */
export const WRITE_STAGES = new Set(['$out', '$merge'])

let nextId = 0

/** A fresh stage id, unique in this panel run (letters and digits only). */
export function stageId(): string {
  nextId++
  return `st${nextId.toString(36)}`
}

export function templateFor(op: string): string {
  return STAGE_TEMPLATES.find((s) => s.op === op)?.body ?? '{ }'
}

export function newStage(op = '$match', body = templateFor(op)): StageDraft {
  return { id: stageId(), op, body, enabled: true }
}

/** A stage draft as a pipeline element, or why it isn't one. */
export function parseStage(s: StageDraft, now = Date.now()): { stage?: JsonObject; error?: string } {
  if (!/^\$[A-Za-z]+$/.test(s.op)) return { error: `"${s.op}" is not a stage name: stages start with $.` }
  if (!s.body.trim()) return { error: `Give ${s.op} a value.` }
  try {
    return { stage: { [s.op]: parseShell(s.body, { now }) } }
  } catch (error) {
    return { error: error instanceof ShellParseError ? error.message : String(error) }
  }
}

/** The enabled stages as a pipeline, or an error per stage id that doesn't parse. */
export function pipelineOf(stages: readonly StageDraft[], now = Date.now()): { pipeline?: JsonObject[]; errors: Record<string, string> } {
  const errors: Record<string, string> = {}
  const pipeline: JsonObject[] = []
  for (const s of stages) {
    if (!s.enabled) continue
    const r = parseStage(s, now)
    if (r.error) errors[s.id] = r.error
    else pipeline.push(r.stage!)
  }
  return Object.keys(errors).length ? { errors } : { pipeline, errors }
}

/** Stage drafts from a pipeline's elements: each must be a one-key document whose key starts with $. */
export function stagesFromPipeline(pipeline: readonly JsonValue[]): { stages?: StageDraft[]; error?: string } {
  const stages: StageDraft[] = []
  for (const [i, el] of pipeline.entries()) {
    // A one-key `{ $numberInt: … }` is a value, not a stage: only plain documents count.
    const keys = isObject(el) && bsonType(el) === 'object' ? Object.keys(el) : []
    if (!isObject(el) || keys.length !== 1 || !keys[0]!.startsWith('$')) {
      return { error: `Stage ${i + 1} must be a document with one stage name, like { $match: { … } }.` }
    }
    const op = keys[0]!
    stages.push({ id: stageId(), op, body: bodyText(el[op]!), enabled: true })
  }
  return { stages }
}

/** A stage body as the editor shows it: short values on one line, documents laid out. */
export function bodyText(v: JsonValue): string {
  const inline = toShellInline(v)
  return inline.length <= 60 ? inline : toShell(v)
}

/** The whole pipeline typed as one array: `[{ $match: … }, …]`. */
export function parsePipelineText(text: string, now = Date.now()): { stages?: StageDraft[]; error?: string } {
  if (!text.trim()) return { stages: [] }
  let value: JsonValue
  try {
    value = parseShell(text, { now })
  } catch (error) {
    return { error: error instanceof ShellParseError ? error.message : String(error) }
  }
  if (!Array.isArray(value)) {
    // One stage on its own is fine too.
    if (isObject(value) && bsonType(value) === 'object') return stagesFromPipeline([value])
    return { error: 'A pipeline is an array of stages: [{ $match: { … } }, { $group: { … } }].' }
  }
  return stagesFromPipeline(value)
}

/** The enabled stages as shell text. A stage that doesn't parse is copied as typed. */
export function pipelineText(stages: readonly StageDraft[], now = Date.now()): string {
  const on = stages.filter((s) => s.enabled)
  if (on.length === 0) return '[]'
  const parts = on.map((s) => {
    const r = parseStage(s, now)
    if (r.stage) return indent(toShell(r.stage), '  ')
    return `  { ${s.op}: ${indent(s.body.trim(), '  ').trimStart()} }`
  })
  return `[\n${parts.join(',\n')}\n]`
}

function indent(text: string, pad: string): string {
  return text
    .split('\n')
    .map((l) => pad + l)
    .join('\n')
}

/** Where a pipeline's last stage writes, when it is `$out` or `$merge`. */
export function writeTarget(pipeline: readonly JsonObject[], db: string): { stage: '$out' | '$merge'; target: string; ns?: { db: string; collection: string } } | undefined {
  const last = pipeline[pipeline.length - 1]
  if (!last) return undefined
  const op = Object.keys(last)[0]
  if (op !== '$out' && op !== '$merge') return undefined
  const v = last[op]!
  const into = op === '$out' || !isObject(v) ? v : v.into
  const ns = ((x: JsonValue | undefined): { db: string; collection: string } | undefined => {
    if (typeof x === 'string') return { db, collection: x }
    if (isObject(x) && typeof x.coll === 'string') return { db: typeof x.db === 'string' ? x.db : db, collection: x.coll }
    return undefined
  })(into)
  return ns ? { stage: op, target: `${ns.db}.${ns.collection}`, ns } : { stage: op, target: 'another collection' }
}

/** Whether any stage writes, wherever it stands (the server refuses one that isn't last). */
export function hasWriteStage(pipeline: readonly JsonObject[]): boolean {
  return pipeline.some((s) => WRITE_STAGES.has(Object.keys(s)[0] ?? ''))
}

/** A find, as the stages that do the same: `$match`, `$sort`, `$skip`, `$limit`, `$project`. */
export function stagesFromFind(find: { filter: JsonObject; projection?: JsonObject; sort?: JsonObject; skip?: number; limit?: number }): StageDraft[] {
  const out: StageDraft[] = [newStage('$match', bodyText(find.filter))]
  if (find.sort && Object.keys(find.sort).length) out.push(newStage('$sort', bodyText(find.sort)))
  if (find.skip) out.push(newStage('$skip', String(find.skip)))
  if (find.limit) out.push(newStage('$limit', String(find.limit)))
  if (find.projection && Object.keys(find.projection).length) out.push(newStage('$project', bodyText(find.projection)))
  return out
}

/** One line for the stage list. */
export function stageSummary(s: StageDraft, max = 80): string {
  const flat = s.body.replace(/\s+/g, ' ').trim()
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat
}

/**
 * What a stage's preview runs: the enabled stages before it give its input, and with the stage
 * itself (when it is on) its output. `selected` is the stage's place in the whole list.
 */
export function previewPipelines(
  stages: readonly StageDraft[],
  selected: number,
  now = Date.now()
): { before?: JsonObject[]; stage?: JsonObject; errors: Record<string, string>; note?: string } {
  const prior = pipelineOf(stages.slice(0, selected), now)
  const s = stages[selected]
  if (!prior.pipeline || !s) return { errors: prior.errors }
  if (hasWriteStage(prior.pipeline)) return { errors: {}, note: 'A $out or $merge stage comes before this one. It must be the last stage, so there is nothing to preview.' }
  if (!s.enabled) return { before: prior.pipeline, errors: {}, note: 'This stage is off, so its output is its input.' }
  const r = parseStage(s, now)
  if (r.error) return { before: prior.pipeline, errors: { [s.id]: r.error } }
  if (WRITE_STAGES.has(s.op)) return { before: prior.pipeline, errors: {}, note: `${s.op} writes to a collection, so it runs only when you run the whole pipeline. Its input is shown.` }
  return { before: prior.pipeline, stage: r.stage!, errors: {} }
}

export function cloneStages(stages: readonly StageText[]): StageDraft[] {
  return stages.map((s) => ({ id: stageId(), op: s.op, body: s.body, enabled: s.enabled }))
}

export function stageTexts(stages: readonly StageDraft[]): StageText[] {
  return stages.map(({ op, body, enabled }) => ({ op, body, enabled }))
}
