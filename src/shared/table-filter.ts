// Filter by the selected rows: a filter made from the values that table columns hold in the
// rows selected, and that filter merged into the filter already typed. Values stay canonical
// Extended JSON, so an ObjectId, a Date or a Decimal128 is matched as that type, not as its text.
import { bsonType, hasTruncated, isObject, isTruncated, setOwn, toShellInline, type JsonObject, type JsonValue } from './ejson-view'
import { tokenize } from './js-scan'

/** A table column: a top-level field, or a key of a sub-document shown as columns, and its
 *  dotted name, which is also its path in a filter. */
export type FilterColumn = { field: string; sub?: string; name: string }

function key(v: JsonValue): string {
  return JSON.stringify(v)
}

function same(a: JsonValue | undefined, b: JsonValue): boolean {
  return a !== undefined && key(a) === key(b)
}

/** A page row the worker could only send as its `_id`: the document was too big to show. */
export function isStubRow(doc: JsonObject): boolean {
  return isTruncated(doc['(document)']) && Object.keys(doc).every((k) => k === '_id' || k === '(document)')
}

/** What a column holds in a row, as a filter would match it: a missing field is `null`, which
 *  matches both null and missing in MongoDB. */
function cellFor(doc: JsonObject, c: FilterColumn): { value: JsonValue } | { error: string } {
  if (isStubRow(doc) && !(c.field === '_id' && c.sub === undefined)) {
    return { error: 'A selected document is too big to show here, so its fields can’t be read. Open it, or filter in the Query Builder.' }
  }
  const top = doc[c.field]
  if (c.sub === undefined) return { value: top === undefined ? null : top }
  // The filter's dotted path reaches into arrays of sub-documents too, which the table shows
  // as an empty cell; the value it would have to match isn't on screen.
  if (Array.isArray(top)) return { error: `${c.field} is an array in a selected row, so ${c.name} can’t be matched from the table. Filter on it in the Query Builder.` }
  if (top !== undefined && isTruncated(top)) return { error: `A selected ${c.field} is too long to show here, so it can’t be matched. Filter on it in the Query Builder.` }
  const v = top !== undefined && isObject(top) && bsonType(top) === 'object' ? top[c.sub] : undefined
  return { value: v === undefined ? null : v }
}

/** Values that an equality would read as something else: a regular expression matches by
 *  pattern, and a sub-document whose first key starts with `$` reads as operators. `$eq`
 *  matches them as stored. */
function needsEq(v: JsonValue): boolean {
  const t = bsonType(v)
  return t === 'regex' || (t === 'object' && Object.keys(v as JsonObject).some((k) => k.startsWith('$')))
}

/** One condition per column, ANDed: a single value is an equality, several distinct values an
 *  `$in`. */
export function filterFromRows(rows: readonly JsonObject[], columns: readonly FilterColumn[]): { filter?: JsonObject; error?: string } {
  if (rows.length === 0) return { error: 'Select the rows to filter by first.' }
  if (columns.length === 0) return { error: 'Choose a column to filter by.' }
  const filter: JsonObject = {}
  for (const c of columns) {
    const seen = new Set<string>()
    const values: JsonValue[] = []
    for (const row of rows) {
      const cell = cellFor(row, c)
      if ('error' in cell) return { error: cell.error }
      const k = key(cell.value)
      if (!seen.has(k)) seen.add(k), values.push(cell.value)
    }
    if (values.some(hasTruncated)) return { error: `A selected ${c.name} is too long to show here, so it can’t be matched. Filter on it in the Query Builder.` }
    // $in has no form that matches a regular expression as stored.
    if (values.length > 1 && values.some((v) => bsonType(v) === 'regex')) {
      return { error: `${c.name} holds a regular expression in one of the selected rows; select only that row to match it.` }
    }
    const v = values[0]!
    setOwn(filter, c.name, values.length > 1 ? { $in: values } : needsEq(v) ? { $eq: v } : v)
  }
  return { filter }
}

/** A projection value: kept (`1`, `true`), left out (`0`, `false`), or an expression such as
 *  `$slice` or `'$amount'`, which changes the value. */
function projectionFlag(v: JsonValue): 'in' | 'out' | 'expression' {
  let n: number | undefined
  if (typeof v === 'boolean') n = v ? 1 : 0
  else if (typeof v === 'number') n = v
  else if (isObject(v)) {
    const t = bsonType(v)
    if (t === 'int' || t === 'long' || t === 'double' || t === 'decimal') n = Number(Object.values(v)[0])
  }
  return n === undefined ? 'expression' : n ? 'in' : 'out'
}

/** Whether the page shows `path` as stored, so that a filter on its value matches what the
 *  table shows. A projection can leave out part of it, cut an array (`$slice`, `$elemMatch`)
 *  or put a computed value under its name. */
export function projectionKeeps(projection: JsonObject | undefined, path: string): boolean {
  const entries = Object.entries(projection ?? {})
  if (entries.length === 0) return true
  let kept = false
  for (const [k, v] of entries) {
    if (k.startsWith(`${path}.`)) return false
    if (k === path || path.startsWith(`${k}.`)) {
      if (projectionFlag(v) !== 'in') return false
      kept = true
    }
  }
  if (kept) return true
  // Not named: shown whole by an exclusion projection; by an inclusion one only `_id` is.
  const inclusion = entries.some(([k, v]) => k !== '_id' && projectionFlag(v) !== 'out')
  return !inclusion || path === '_id'
}

/** Whether `filter` already holds this condition, at its top level or inside its `$and`. */
function holds(filter: JsonObject, k: string, v: JsonValue): boolean {
  if (same(Object.hasOwn(filter, k) ? filter[k] : undefined, v)) return true
  const and = filter.$and
  return Array.isArray(and) && and.some((x) => isObject(x) && holds(x, k, v))
}

/** `add` ANDed onto `base`: conditions `base` already holds are left out, fields it doesn't name
 *  join it, and a field it names differently goes into an `$and`, so both still apply.
 *  `undefined` when `base` already holds all of `add`. */
export function mergeFilters(base: JsonObject, add: JsonObject): JsonObject | undefined {
  const fresh = freshPart(base, add)
  if (!fresh) return undefined
  if (Object.keys(fresh).some((k) => Object.hasOwn(base, k))) return { $and: [base, fresh] }
  const merged: JsonObject = { ...base }
  for (const [k, v] of Object.entries(fresh)) setOwn(merged, k, v)
  return merged
}

function freshPart(base: JsonObject, add: JsonObject): JsonObject | undefined {
  const fresh: JsonObject = {}
  for (const [k, v] of Object.entries(add)) if (!holds(base, k, v)) setOwn(fresh, k, v)
  return Object.keys(fresh).length ? fresh : undefined
}

/**
 * The filter text with `add` ANDed onto it, as `mergeFilters` decides, but written into the
 * text as typed: `new Date()`, comments and layout stay. `base` is that text parsed. New fields
 * go before its closing brace; a clash wraps the text in `{ $and: [ … ] }`. `undefined` when
 * the filter already holds all of `add`.
 */
export function mergeFilterText(text: string, base: JsonObject, add: JsonObject): string | undefined {
  const fresh = freshPart(base, add)
  if (!fresh) return undefined
  const tokens = tokenize(text)
  if (tokens.length === 0) return toShellInline(fresh)
  const first = tokens[0]!
  const last = tokens[tokens.length - 1]!
  if (tokens.length < 2 || first.value !== '{' || last.value !== '}') return toShellInline(mergeFilters(base, add)!)
  const freshText = toShellInline(fresh)
  if (Object.keys(fresh).some((k) => Object.hasOwn(base, k))) {
    return `${text.slice(0, first.start)}{ $and: [${text.slice(first.start, last.end)}, ${freshText}] }${text.slice(last.end)}`
  }
  // After the last token inside the braces, so that a line comment before `}` stays after it.
  const prev = tokens[tokens.length - 2]!
  const sep = prev.value === '{' || prev.value === ',' ? ' ' : ', '
  const after = text.slice(prev.end)
  return `${text.slice(0, prev.end)}${sep}${freshText.slice(2, -2)}${after.startsWith('}') ? ' ' : ''}${after}`
}

/** Whether a column can be named in a filter: a dot or a leading `$` in a field's own name would
 *  read as a path or an operator, an empty name can't be written as one, and Orca refuses
 *  option values past 1,000 characters. */
export function filterablePath(c: FilterColumn): boolean {
  const parts = c.sub === undefined ? [c.field] : [c.field, c.sub]
  return c.name.length <= 1000 && parts.every((p) => p !== '' && !p.includes('.') && !p.startsWith('$'))
}
