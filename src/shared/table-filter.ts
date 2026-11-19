// Filter by the selected rows: a filter made from the values that table columns hold in the
// rows selected, and merging it into the filter already typed. Values stay canonical Extended
// JSON, so an ObjectId, a Date or a Decimal128 is matched as that type, not as its text.
import { bsonType, setOwn, type JsonObject, type JsonValue } from './ejson-view'

/** A column picked to filter by: its dotted path, and its value in each selected row
 *  (`undefined` where the row has no such field). */
export type FilterColumn = { path: string; values: readonly (JsonValue | undefined)[] }

function same(a: JsonValue, b: JsonValue): boolean {
  return JSON.stringify(a) === JSON.stringify(b)
}

/** Whether a value, anywhere inside, was cut short for the results page: it would match nothing. */
function cutShort(v: JsonValue): boolean {
  return JSON.stringify(v).includes('"$msTruncated"')
}

/** One condition per column, ANDed: a single value is an equality, several distinct values an
 *  `$in`. A missing field counts as `null`, which matches both null and missing in MongoDB. */
export function filterFromColumns(columns: readonly FilterColumn[]): { filter?: JsonObject; error?: string } {
  if (columns.length === 0) return { error: 'Choose a column to filter by.' }
  const filter: JsonObject = {}
  for (const c of columns) {
    const values: JsonValue[] = []
    for (const v of c.values) {
      const x = v === undefined ? null : v
      if (!values.some((y) => same(x, y))) values.push(x)
    }
    if (values.length === 0) return { error: 'Select the rows to filter by first.' }
    if (values.some(cutShort)) return { error: `A selected ${c.path} is too long to show here, so it can't be matched. Filter on it in the Query Builder instead.` }
    // A regular expression as a value would match by pattern; $eq matches the stored expression
    // itself. $in has no such form, so several values can't include one.
    const regex = values.some((v) => bsonType(v) === 'regex')
    if (regex && values.length > 1) return { error: `${c.path} holds a regular expression in one of the selected rows; select only that row to match it.` }
    setOwn(filter, c.path, values.length > 1 ? { $in: values } : regex ? { $eq: values[0]! } : values[0]!)
  }
  return { filter }
}

/** `add` ANDed onto `base`. Fields `base` doesn't name join it; a field it names with the same
 *  condition is left as is; one it names differently goes into an `$and`, so both still apply. */
export function mergeFilters(base: JsonObject, add: JsonObject): JsonObject {
  const merged: JsonObject = { ...base }
  const clash: JsonObject = {}
  for (const [k, v] of Object.entries(add)) {
    if (!Object.hasOwn(base, k)) setOwn(merged, k, v)
    else if (!same(base[k]!, v)) setOwn(clash, k, v)
  }
  return Object.keys(clash).length ? { $and: [merged, clash] } : merged
}

/** Whether a column can be named in a filter: a dot or a leading `$` in a field's own name would
 *  read as a path or an operator, and an empty name can't be written as one. */
export function filterablePath(parts: readonly string[]): boolean {
  return parts.every((p) => p !== '' && !p.includes('.') && !p.startsWith('$'))
}
