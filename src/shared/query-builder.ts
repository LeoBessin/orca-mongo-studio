// The Query Builder's model: rows of field, operator and value in nested AND/OR groups. It turns a
// builder into a filter, and a filter back into a builder when the filter fits the builder's shape
// (otherwise the person keeps editing the filter text). Values are shell literals, so
// `ObjectId(...)`, `ISODate(...)` and regexes work in a row as they do in the filter.
import { bsonType, isObject, toShellInline, type JsonObject, type JsonValue } from './ejson-view'
import { parseShell, ShellParseError } from './shell-parse'

export type Operator = 'eq' | 'ne' | 'gt' | 'gte' | 'lt' | 'lte' | 'in' | 'nin' | 'exists' | 'notExists' | 'regex' | 'size' | 'type'

export const OPERATORS: { value: Operator; label: string; needsValue: boolean }[] = [
  { value: 'eq', label: 'equals', needsValue: true },
  { value: 'ne', label: 'does not equal', needsValue: true },
  { value: 'gt', label: 'greater than', needsValue: true },
  { value: 'gte', label: 'greater or equal', needsValue: true },
  { value: 'lt', label: 'less than', needsValue: true },
  { value: 'lte', label: 'less or equal', needsValue: true },
  { value: 'in', label: 'is one of', needsValue: true },
  { value: 'nin', label: 'is none of', needsValue: true },
  { value: 'regex', label: 'matches', needsValue: true },
  { value: 'exists', label: 'exists', needsValue: false },
  { value: 'notExists', label: 'does not exist', needsValue: false },
  { value: 'size', label: 'array size is', needsValue: true },
  { value: 'type', label: 'has type', needsValue: true }
]

const MONGO_OP: Partial<Record<Operator, string>> = { ne: '$ne', gt: '$gt', gte: '$gte', lt: '$lt', lte: '$lte', in: '$in', nin: '$nin', size: '$size', type: '$type' }
const FROM_MONGO: Record<string, Operator> = Object.fromEntries(Object.entries(MONGO_OP).map(([k, v]) => [v, k as Operator]))

export type Condition = { kind: 'cond'; id: string; field: string; op: Operator; value: string }
export type Group = { kind: 'group'; id: string; join: 'and' | 'or'; items: (Condition | Group)[] }
export type BuilderProblem = { id: string; message: string }

let counter = 0
/** Ids only need to be unique within the panel run. */
export function newId(prefix: string): string {
  counter += 1
  return `${prefix}${counter}`
}

export function emptyGroup(join: 'and' | 'or' = 'and'): Group {
  return { kind: 'group', id: newId('g'), join, items: [] }
}

export function newCondition(field = '', op: Operator = 'eq', value = ''): Condition {
  return { kind: 'cond', id: newId('c'), field, op, value }
}

function needsValue(op: Operator): boolean {
  return OPERATORS.find((o) => o.value === op)?.needsValue ?? true
}

function parseValue(c: Condition, problems: BuilderProblem[]): JsonValue | undefined {
  const text = c.value.trim()
  if (!text) {
    problems.push({ id: c.id, message: `Give "${c.field || 'this row'}" a value.` })
    return undefined
  }
  try {
    const v = parseShell(text)
    if ((c.op === 'in' || c.op === 'nin') && !Array.isArray(v)) {
      problems.push({ id: c.id, message: `"${OPERATORS.find((o) => o.value === c.op)!.label}" takes a list, such as [1, 2, 3].` })
      return undefined
    }
    return v
  } catch (error) {
    if (!(error instanceof ShellParseError)) throw error
    // A bare word reads as a string, so `shipped` works as well as 'shipped'.
    if (/^[^\s'"{}[\](),:]+$/.test(text) && c.op !== 'in' && c.op !== 'nin') return text
    problems.push({ id: c.id, message: `${c.field || 'Value'}: ${error.message}` })
    return undefined
  }
}

/** One condition as `{ field: ... }`, or undefined when the row is incomplete. */
function conditionFilter(c: Condition, problems: BuilderProblem[]): JsonObject | undefined {
  const field = c.field.trim()
  if (!field) {
    problems.push({ id: c.id, message: 'Choose a field for each row.' })
    return undefined
  }
  if (c.op === 'exists') return { [field]: { $exists: true } }
  if (c.op === 'notExists') return { [field]: { $exists: false } }
  const value = parseValue(c, problems)
  if (value === undefined) return undefined
  if (c.op === 'eq') return { [field]: value }
  if (c.op === 'regex') {
    if (bsonType(value) === 'regex') return { [field]: value }
    if (typeof value === 'string') return { [field]: { $regex: value } }
    problems.push({ id: c.id, message: `"matches" takes a pattern, such as /^abc/i.` })
    return undefined
  }
  return { [field]: { [MONGO_OP[c.op]!]: value } }
}

function isOperatorDoc(v: JsonValue): v is JsonObject {
  return isObject(v) && bsonType(v) === 'object' && Object.keys(v).length > 0 && Object.keys(v).every((k) => k.startsWith('$'))
}

/** ANDs filters into one document: fields merge where they can, `$and` where they clash. */
function mergeAnd(parts: JsonObject[]): JsonObject {
  const out: JsonObject = {}
  const rest: JsonObject[] = []
  // A document with several fields is already an AND of them, so each field merges on its own.
  for (const [field, value] of parts.flatMap((p) => Object.entries(p))) {
    if (!(field in out)) {
      out[field] = value
      continue
    }
    if (field.startsWith('$')) {
      rest.push({ [field]: value })
      continue
    }
    const prev = out[field]!
    if (isOperatorDoc(prev) && isOperatorDoc(value) && Object.keys(value).every((k) => !(k in prev))) {
      out[field] = { ...prev, ...value }
    } else rest.push({ [field]: value })
  }
  if (rest.length === 0) return out
  const and = [...(Object.keys(out).length ? Object.entries(out).map(([k, v]) => ({ [k]: v })) : []), ...rest]
  return and.length === 1 ? and[0]! : { $and: and }
}

function groupFilter(g: Group, problems: BuilderProblem[]): JsonObject | undefined {
  const parts: JsonObject[] = []
  for (const item of g.items) {
    const f = item.kind === 'cond' ? conditionFilter(item, problems) : groupFilter(item, problems)
    if (f && Object.keys(f).length) parts.push(f)
  }
  if (parts.length === 0) return {}
  if (g.join === 'and') return mergeAnd(parts)
  return parts.length === 1 ? parts[0] : { $or: parts }
}

/** The builder as a filter document, with a problem for each row that can't be used. */
export function builderToFilter(root: Group): { filter: JsonObject; problems: BuilderProblem[] } {
  const problems: BuilderProblem[] = []
  const filter = groupFilter(root, problems) ?? {}
  return { filter, problems }
}

// ---- Filter → builder ----

function valueText(v: JsonValue): string {
  return toShellInline(v)
}

function fieldConditions(field: string, value: JsonValue): Condition[] | null {
  if (!isOperatorDoc(value)) return [newCondition(field, 'eq', valueText(value))]
  const out: Condition[] = []
  const ops = value
  for (const [k, v] of Object.entries(ops)) {
    if (k === '$exists') {
      if (typeof v !== 'boolean') return null
      out.push(newCondition(field, v ? 'exists' : 'notExists'))
    } else if (k === '$regex') {
      if (typeof v !== 'string' && bsonType(v) !== 'regex') return null
      const options = ops.$options
      if (options !== undefined) {
        if (typeof options !== 'string' || typeof v !== 'string') return null
        out.push(newCondition(field, 'regex', valueText({ $regularExpression: { pattern: v, options: [...options].sort().join('') } })))
      } else out.push(newCondition(field, 'regex', typeof v === 'string' ? valueText({ $regularExpression: { pattern: v, options: '' } }) : valueText(v)))
    } else if (k === '$options') {
      if (!('$regex' in ops)) return null
    } else if (k === '$eq') {
      out.push(newCondition(field, 'eq', valueText(v)))
    } else {
      const op = FROM_MONGO[k]
      if (!op) return null
      out.push(newCondition(field, op, valueText(v)))
    }
  }
  return out
}

function filterToItems(filter: JsonObject, depth: number): (Condition | Group)[] | null {
  if (depth > 6) return null
  const items: (Condition | Group)[] = []
  for (const [k, v] of Object.entries(filter)) {
    if (k === '$and' || k === '$or') {
      if (!Array.isArray(v) || v.length === 0) return null
      const group: Group = { kind: 'group', id: newId('g'), join: k === '$and' ? 'and' : 'or', items: [] }
      for (const part of v) {
        if (!isObject(part) || bsonType(part) !== 'object') return null
        const sub = filterToItems(part, depth + 1)
        if (!sub) return null
        // A clause with several conditions is an AND inside the OR.
        if (sub.length === 1 || group.join === 'and') group.items.push(...sub)
        else group.items.push({ kind: 'group', id: newId('g'), join: 'and', items: sub })
      }
      items.push(group)
    } else if (k.startsWith('$')) {
      return null
    } else {
      const conds = fieldConditions(k, v)
      if (!conds) return null
      items.push(...conds)
    }
  }
  return items
}

/** A builder for the filter, or null when the filter uses something the builder can't show. */
export function filterToBuilder(filter: JsonObject): Group | null {
  const items = filterToItems(filter, 0)
  if (!items) return null
  // A filter that is only `{ $or: [...] }` becomes that OR group itself.
  if (items.length === 1 && items[0]!.kind === 'group') return items[0]
  return { kind: 'group', id: newId('g'), join: 'and', items }
}

// ---- Editing helpers (immutable) ----

export function mapGroup(root: Group, id: string, change: (g: Group) => Group): Group {
  if (root.id === id) return change(root)
  return { ...root, items: root.items.map((item) => (item.kind === 'group' ? mapGroup(item, id, change) : item)) }
}

export function updateCondition(root: Group, id: string, change: Partial<Omit<Condition, 'kind' | 'id'>>): Group {
  return {
    ...root,
    items: root.items.map((item) => (item.kind === 'cond' ? (item.id === id ? { ...item, ...change } : item) : updateCondition(item, id, change)))
  }
}

export function removeItem(root: Group, id: string): Group {
  return {
    ...root,
    items: root.items.filter((item) => item.id !== id).map((item) => (item.kind === 'group' ? removeItem(item, id) : item))
  }
}

export function countConditions(g: Group): number {
  return g.items.reduce((n, item) => n + (item.kind === 'cond' ? 1 : countConditions(item)), 0)
}

export { needsValue }
