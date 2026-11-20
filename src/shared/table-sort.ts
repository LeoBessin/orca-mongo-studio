// Sorting the rows a results page already holds, for a click on a table header. It runs in the
// panel without asking the server, so it compares canonical Extended JSON values the way
// MongoDB orders BSON: by type first (numbers before strings before documents, and so on),
// then by value, so 9 sorts before 10 and a Date by its instant rather than by its text.
import { base64Length, bsonType, dateMillis, isObject, type BsonType, type JsonObject, type JsonValue } from './ejson-view'

export type SortDirection = 'asc' | 'desc'

/** MongoDB's comparison order of BSON types; types on the same rank compare by value. */
const RANK: Record<BsonType, number> = {
  minKey: 0,
  undefined: 1,
  null: 1,
  int: 2,
  long: 2,
  double: 2,
  decimal: 2,
  string: 3,
  symbol: 3,
  object: 4,
  array: 5,
  binData: 6,
  uuid: 6,
  objectId: 7,
  bool: 8,
  date: 9,
  timestamp: 10,
  regex: 11,
  dbPointer: 12,
  javascript: 13,
  maxKey: 14,
  truncated: 3
}

function cmp<T extends number | bigint | string>(a: T, b: T): number {
  return a < b ? -1 : a > b ? 1 : 0
}

/** A number's value: a long stays a BigInt so two longs past 2^53 still compare exactly. */
function numberOf(v: JsonValue): number | bigint {
  if (typeof v === 'number') return v
  const o = v as JsonObject
  if (typeof o.$numberLong === 'string') {
    try {
      return BigInt(o.$numberLong)
    } catch {
      return NaN
    }
  }
  const text = (o.$numberInt ?? o.$numberDouble ?? o.$numberDecimal) as string
  return text === 'Infinity' ? Infinity : text === '-Infinity' ? -Infinity : Number(text)
}

function compareNumbers(a: number | bigint, b: number | bigint): number {
  if (typeof a === 'bigint' && typeof b === 'bigint') return cmp(a, b)
  const x = Number(a)
  const y = Number(b)
  // MongoDB sorts NaN below every other number.
  if (Number.isNaN(x) || Number.isNaN(y)) return Number.isNaN(x) ? (Number.isNaN(y) ? 0 : -1) : 1
  return cmp(x, y)
}

/** A cut-short value compares by the part the page kept. */
function untruncated(v: JsonValue): JsonValue {
  const t = isObject(v) && isObject(v.$msTruncated) ? v.$msTruncated.preview : undefined
  return t === undefined ? v : untruncated(t)
}

function stringOf(v: JsonValue): string {
  if (typeof v === 'string') return v
  const s = (v as JsonObject).$symbol
  return typeof s === 'string' ? s : ''
}

function binaryOf(v: JsonValue): { size: number; sub: string; data: string } {
  const o = v as JsonObject
  if (typeof o.$uuid === 'string') return { size: 16, sub: '04', data: o.$uuid.replace(/-/g, '').toLowerCase() }
  const b = o.$binary as JsonObject
  const data = String(b.base64)
  return { size: base64Length(data), sub: String(b.subType ?? '00'), data }
}

/** Two values in MongoDB's order: negative when `a` sorts first. */
export function compareValues(a: JsonValue, b: JsonValue): number {
  a = untruncated(a)
  b = untruncated(b)
  const ta = bsonType(a)
  const tb = bsonType(b)
  const rank = cmp(RANK[ta], RANK[tb])
  if (rank) return rank
  switch (RANK[ta]) {
    case RANK.int:
      return compareNumbers(numberOf(a), numberOf(b))
    case RANK.string:
      return cmp(stringOf(a), stringOf(b))
    case RANK.object: {
      const ea = Object.entries(a as JsonObject)
      const eb = Object.entries(b as JsonObject)
      for (let i = 0; i < Math.min(ea.length, eb.length); i++) {
        const byType = cmp(RANK[bsonType(ea[i]![1])], RANK[bsonType(eb[i]![1])])
        if (byType) return byType
        const byName = cmp(ea[i]![0], eb[i]![0])
        if (byName) return byName
        const byValue = compareValues(ea[i]![1], eb[i]![1])
        if (byValue) return byValue
      }
      return cmp(ea.length, eb.length)
    }
    case RANK.array: {
      const xa = a as JsonValue[]
      const xb = b as JsonValue[]
      for (let i = 0; i < Math.min(xa.length, xb.length); i++) {
        const c = compareValues(xa[i]!, xb[i]!)
        if (c) return c
      }
      return cmp(xa.length, xb.length)
    }
    case RANK.binData: {
      const x = binaryOf(a)
      const y = binaryOf(b)
      return cmp(x.size, y.size) || cmp(x.sub, y.sub) || cmp(x.data, y.data)
    }
    case RANK.objectId:
      return cmp(String((a as JsonObject).$oid).toLowerCase(), String((b as JsonObject).$oid).toLowerCase())
    case RANK.bool:
      return cmp(Number(a), Number(b))
    case RANK.date:
      return compareNumbers(dateMillis(a as JsonObject), dateMillis(b as JsonObject))
    case RANK.timestamp: {
      const x = (a as JsonObject).$timestamp as JsonObject
      const y = (b as JsonObject).$timestamp as JsonObject
      return cmp(Number(x.t), Number(y.t)) || cmp(Number(x.i), Number(y.i))
    }
    case RANK.regex: {
      const x = (a as JsonObject).$regularExpression as JsonObject
      const y = (b as JsonObject).$regularExpression as JsonObject
      return cmp(String(x.pattern), String(y.pattern)) || cmp(String(x.options ?? ''), String(y.options ?? ''))
    }
    default:
      return cmp(JSON.stringify(a), JSON.stringify(b))
  }
}

/**
 * The order to show rows in: indexes into `values`, one cell per row, sorted by them. A missing
 * cell (`undefined`) goes last in either direction, and rows that compare equal keep the order
 * the page gave them.
 */
export function sortedOrder(values: readonly (JsonValue | undefined)[], direction: SortDirection): number[] {
  const sign = direction === 'asc' ? 1 : -1
  return values
    .map((_, i) => i)
    .sort((i, j) => {
      const a = values[i]
      const b = values[j]
      if (a === undefined || b === undefined) return a === undefined ? (b === undefined ? 0 : 1) : -1
      return sign * compareValues(a, b)
    })
}
