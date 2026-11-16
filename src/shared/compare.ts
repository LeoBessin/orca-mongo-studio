// Comparing documents for Compare and sync: what makes two documents equal (canonical Extended
// JSON, so Int32 1 and Double 1.0 differ; field order counts unless told not to; some fields can be
// left out), and the field-by-field differences shown for one pair.
import { bsonType, isObject, setOwn, valueText, type JsonObject, type JsonValue } from './ejson-view'

export type CompareRules = {
  /** Dotted paths left out of the comparison (`_id` is never compared: it is the key). */
  ignoreFields: string[]
  /** `{ a: 1, b: 2 }` equals `{ b: 2, a: 1 }`. */
  ignoreOrder: boolean
}

function isPlain(v: JsonValue): v is JsonObject {
  return isObject(v) && bsonType(v) === 'object'
}

/** The document as compared: ignored fields removed, keys sorted when order does not count. */
export function comparable(doc: JsonObject, rules: CompareRules): JsonValue {
  const ignore = rules.ignoreFields.map((f) => f.split('.'))
  const walk = (v: JsonValue, path: string[]): JsonValue => {
    if (Array.isArray(v)) return v.map((x) => walk(x, path))
    if (!isPlain(v)) return v
    const keys = Object.keys(v).filter((k) => !ignore.some((p) => p.length === path.length + 1 && p[path.length] === k && path.every((s, i) => p[i] === s)))
    if (rules.ignoreOrder) keys.sort()
    const out: JsonObject = {}
    for (const k of keys) setOwn(out, k, walk(v[k]!, [...path, k]))
    return out
  }
  const out = walk(doc, []) as JsonObject
  delete out._id
  return out
}

/** A stable text for equality: canonical JSON of `comparable`. */
export function compareKey(doc: JsonObject, rules: CompareRules): string {
  return JSON.stringify(comparable(doc, rules))
}

export type FieldDiff = {
  path: string
  kind: 'added' | 'removed' | 'changed'
  /** Short text of each side's value; missing on the side without it. */
  a?: string
  b?: string
  /** Each side's BSON type, when they differ. */
  types?: [string, string]
}

/** Field differences from `a` to `b`: `removed` is only in a, `added` only in b. Sub-documents are
 *  compared field by field, arrays item by item; at most `max` differences. */
export function diffDocuments(a: JsonObject, b: JsonObject, rules: CompareRules, max = 500): { diffs: FieldDiff[]; capped: boolean } {
  const ca = comparable(a, rules)
  const cb = comparable(b, rules)
  const diffs: FieldDiff[] = []
  let capped = false
  const push = (d: FieldDiff): void => {
    if (diffs.length >= max) capped = true
    else diffs.push(d)
  }
  const walk = (x: JsonValue | undefined, y: JsonValue | undefined, path: string): void => {
    if (x === undefined && y === undefined) return
    if (x === undefined) return push({ path, kind: 'added', b: valueText(y!, 80) })
    if (y === undefined) return push({ path, kind: 'removed', a: valueText(x, 80) })
    if (isPlain(x) && isPlain(y)) {
      const keys = [...new Set([...Object.keys(x), ...Object.keys(y)])]
      for (const k of keys) walk(x[k], y[k], path ? `${path}.${k}` : k)
      if (!rules.ignoreOrder && keys.every((k) => k in x && k in y) && JSON.stringify(Object.keys(x)) !== JSON.stringify(Object.keys(y)) && keys.every((k) => JSON.stringify(x[k]) === JSON.stringify(y[k]))) {
        push({ path: path || '(document)', kind: 'changed', a: `fields ${Object.keys(x).join(', ')}`, b: `fields ${Object.keys(y).join(', ')}` })
      }
      return
    }
    if (Array.isArray(x) && Array.isArray(y)) {
      for (let i = 0; i < Math.max(x.length, y.length); i++) walk(x[i], y[i], `${path}.${i}`)
      return
    }
    if (JSON.stringify(x) === JSON.stringify(y)) return
    const tx = bsonType(x)
    const ty = bsonType(y)
    push({ path, kind: 'changed', a: valueText(x, 80), b: valueText(y, 80), ...(tx !== ty ? { types: [tx, ty] as [string, string] } : {}) })
  }
  walk(ca, cb, '')
  return { diffs, capped }
}

/** `a, b.c` → ['a', 'b.c'], without `_id` (always the key). */
export function parseFieldList(text: string): string[] {
  return [...new Set(text.split(/[,\s]+/).map((s) => s.trim()).filter((s) => s && s !== '_id'))]
}
