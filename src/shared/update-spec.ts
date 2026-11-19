// Update many: the update a person writes (operators like `{ $set: … }`, or an update pipeline),
// checked before it reaches the server, and the scopes it can apply to. Pure, shared by the panel
// (which checks the text as it is typed) and the worker (which checks what it is sent).
import { bsonType, isObject, type JsonObject, type JsonValue } from './ejson-view'
import { fitsHost } from './host-size'
import { parseShell, ShellParseError } from './shell-parse'

/** An update document (`{ $set: { … } }`) or an update pipeline (`[{ $set: { … } }]`). */
export type UpdateSpec = JsonObject | JsonObject[]

/** Which documents an update changes: these `_id`s, those matching a filter, or every one. */
export type UpdateScope =
  | { kind: 'ids'; ids: JsonValue[] }
  | { kind: 'filter'; filter: JsonObject; collation?: JsonObject }
  | { kind: 'all' }

/** At most this many `_id`s in a selection, like a bulk delete. */
export const UPDATE_IDS_MAX = 10_000

/** The operators `updateMany` takes. `$setOnInsert` only acts on upserts, which this never does. */
export const UPDATE_OPERATORS = ['$set', '$unset', '$inc', '$mul', '$rename', '$min', '$max', '$currentDate', '$push', '$addToSet', '$pop', '$pull', '$pullAll', '$bit'] as const

/** The stages an update pipeline may hold (MongoDB 4.2+). */
export const UPDATE_STAGES = ['$set', '$addFields', '$unset', '$project', '$replaceWith', '$replaceRoot'] as const

/** Why an update can't be sent, or undefined when it can. */
export function updateProblem(value: JsonValue): string | undefined {
  if (Array.isArray(value)) {
    if (value.length === 0) return 'An update pipeline needs at least one stage.'
    for (const [i, stage] of value.entries()) {
      const keys = isObject(stage) && bsonType(stage) === 'object' ? Object.keys(stage) : []
      if (keys.length !== 1 || !keys[0]!.startsWith('$')) return `Stage ${i + 1} must be a document with one stage name, like { $set: { … } }.`
      if (!(UPDATE_STAGES as readonly string[]).includes(keys[0]!)) return `${keys[0]} can't be used in an update pipeline. Use ${UPDATE_STAGES.join(', ')}.`
    }
    return undefined
  }
  if (!isObject(value) || bsonType(value) !== 'object') return 'An update is a document of operators, like { $set: { status: "archived" } }, or a pipeline in [ ].'
  const keys = Object.keys(value)
  if (keys.length === 0) return 'Write the change, like { $set: { status: "archived" } }.'
  const plain = keys.find((k) => !k.startsWith('$'))
  if (plain !== undefined) {
    return `"${plain}" is not an update operator. To change fields, name them under one, like { $set: { ${plain}: … } }; replacing whole documents isn't done in bulk.`
  }
  for (const k of keys) {
    if (!(UPDATE_OPERATORS as readonly string[]).includes(k)) return `${k} is not an update operator. Use ${UPDATE_OPERATORS.join(', ')}.`
    const body = value[k]!
    if (!isObject(body) || bsonType(body) !== 'object') return `${k} takes a document of fields, like { ${k}: { field: … } }.`
    if (Object.keys(body).length === 0) return `${k} names no fields.`
  }
  return undefined
}

/** The update text as an update, or why it can't be used. */
export function parseUpdateText(text: string, now = Date.now()): { update?: UpdateSpec; error?: string } {
  if (!text.trim()) return { error: 'Write the change, like { $set: { status: "archived" } }.' }
  let value: JsonValue
  try {
    value = parseShell(text, { now })
  } catch (error) {
    return { error: error instanceof ShellParseError ? error.message : String(error) }
  }
  const problem = updateProblem(value)
  if (problem) return { error: problem }
  if (!fitsHost({ update: value })) return { error: 'This update is too big to send from here: Orca lets a panel send at most 1 MiB and 10,000 values at once. Use the shell for it.' }
  return { update: value as UpdateSpec }
}

/** Why a scope can't be used, or undefined when it can. */
export function scopeProblem(scope: UpdateScope): string | undefined {
  if (!isObject(scope as unknown as JsonValue)) return 'Choose which documents to update.'
  switch (scope.kind) {
    case 'ids':
      if (!Array.isArray(scope.ids) || scope.ids.length === 0) return 'Select the documents to update.'
      if (scope.ids.length > UPDATE_IDS_MAX) return `Update at most ${UPDATE_IDS_MAX.toLocaleString('en-US')} selected documents at a time.`
      return undefined
    case 'filter':
      if (!isObject(scope.filter)) return 'The filter must be a document.'
      if (scope.collation !== undefined && !isObject(scope.collation)) return 'The collation must be a document.'
      return undefined
    case 'all':
      return undefined
    default:
      return 'Choose which documents to update.'
  }
}

/** The filter a scope stands for, in canonical Extended JSON. */
export function scopeFilter(scope: UpdateScope): JsonObject {
  if (scope.kind === 'ids') return { _id: { $in: scope.ids } }
  if (scope.kind === 'filter') return scope.filter
  return {}
}

/** Whether a scope reaches every document of the collection, which asks for a stronger confirmation. */
export function scopeIsEverything(scope: UpdateScope): boolean {
  return scope.kind === 'all' || (scope.kind === 'filter' && Object.keys(scope.filter).length === 0)
}
