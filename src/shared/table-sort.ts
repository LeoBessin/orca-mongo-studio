// Sorting the rows a results page already holds, for a click on a table header. It runs in the
// panel without asking the server, so it orders canonical Extended JSON the way MongoDB orders
// BSON: by type first (numbers before strings before documents, and so on), then by value, so
// 9 sorts before 10, a Date by its instant and binary data by its bytes. An array cell sorts by
// its smallest element ascending and its largest descending, as `.sort()` does on the server,
// and strings follow the query's collation when it has one.
//
// Values the worker cut short for the page (`$msTruncated`) sort as what they stand for: a long
// string by the part kept and then its length, a big binary by its real size, a document cut at
// depth with the documents.
import { base64Length, base64ToHex, bsonType, dateMillis, isObject, isTruncated, type BsonType, type JsonObject, type JsonValue } from './ejson-view'

export type SortDirection = 'asc' | 'desc'

/** How two strings order: by code point (MongoDB's binary order), or by a collation. */
export type StringOrder = (a: string, b: string) => number

/** MongoDB's comparison order of BSON types; types on the same rank compare by value. An empty
 *  array cell has its own rank, below undefined and null (see `cellKey`). */
const RANK = {
  minKey: 0,
  emptyArray: 1,
  undefined: 2,
  null: 3,
  number: 4,
  string: 5,
  object: 6,
  array: 7,
  binData: 8,
  objectId: 9,
  bool: 10,
  date: 11,
  timestamp: 12,
  regex: 13,
  dbPointer: 14,
  code: 15,
  codeWithScope: 16,
  maxKey: 17
} as const

const TYPE_RANK: Record<Exclude<BsonType, 'truncated' | 'javascript'>, number> = {
  minKey: RANK.minKey,
  undefined: RANK.undefined,
  null: RANK.null,
  int: RANK.number,
  long: RANK.number,
  double: RANK.number,
  decimal: RANK.number,
  string: RANK.string,
  symbol: RANK.string,
  object: RANK.object,
  array: RANK.array,
  binData: RANK.binData,
  uuid: RANK.binData,
  objectId: RANK.objectId,
  bool: RANK.bool,
  date: RANK.date,
  timestamp: RANK.timestamp,
  regex: RANK.regex,
  dbPointer: RANK.dbPointer,
  maxKey: RANK.maxKey
}

const TRUNCATED_RANK: Record<string, number> = { string: RANK.string, array: RANK.array, object: RANK.object, binary: RANK.binData }

/** A value's rank. A cut-short value ranks as the kind it stands for, whatever its preview. */
function rankOf(v: JsonValue): number {
  if (isTruncated(v)) return TRUNCATED_RANK[v.$msTruncated.kind] ?? RANK.object
  const t = bsonType(v)
  if (t === 'javascript') return '$scope' in (v as JsonObject) ? RANK.codeWithScope : RANK.code
  if (t === 'truncated') return RANK.object
  return TYPE_RANK[t]
}

function cmp<T extends number | bigint | string>(a: T, b: T): number {
  return a < b ? -1 : a > b ? 1 : 0
}

// ---- Strings ----

/** Code-point order, which is the UTF-8 byte order MongoDB compares strings in. JavaScript's
 *  `<` compares UTF-16 code units, which puts characters past U+FFFF before U+E000–U+FFFF. */
export function codePointOrder(a: string, b: string): number {
  const n = Math.min(a.length, b.length)
  for (let i = 0; i < n; ) {
    const x = a.codePointAt(i)!
    const y = b.codePointAt(i)!
    if (x !== y) return x - y
    i += x > 0xffff ? 2 : 1
  }
  return a.length - b.length
}

function intOf(v: JsonValue | undefined): number | undefined {
  if (typeof v === 'number') return v
  if (isObject(v)) {
    const text = v.$numberInt ?? v.$numberLong ?? v.$numberDouble
    if (typeof text === 'string') return Number(text)
  }
  return undefined
}

/**
 * The string order a query's collation asks for, through `Intl.Collator`: locale, strength
 * (1 base letters, 2 and accents, 3 and case), caseLevel, caseFirst and numericOrdering. With
 * no collation, `simple`, or a locale this runtime doesn't know, it is code-point order.
 */
export function stringOrder(collation: JsonObject | undefined): StringOrder {
  const locale = collation?.locale
  if (!collation || typeof locale !== 'string' || locale === 'simple') return codePointOrder
  const strength = intOf(collation.strength) ?? 3
  const sensitivity = strength >= 3 ? 'variant' : strength === 2 ? 'accent' : collation.caseLevel === true ? 'case' : 'base'
  const caseFirst = collation.caseFirst === 'upper' || collation.caseFirst === 'lower' ? collation.caseFirst : 'false'
  try {
    const collator = new Intl.Collator(locale.replace(/_/g, '-'), { sensitivity, caseFirst, numeric: collation.numericOrdering === true, usage: 'sort' })
    return (a, b) => collator.compare(a, b)
  } catch {
    return codePointOrder
  }
}

/** A string, or a cut-short one: its text, and its full length when it was cut. */
function stringParts(v: JsonValue): { text: string; size?: number } {
  if (isTruncated(v)) {
    const p = v.$msTruncated.preview
    return { text: typeof p === 'string' ? p : '', size: v.$msTruncated.size }
  }
  if (typeof v === 'string') return { text: v }
  const s = (v as JsonObject).$symbol
  return { text: typeof s === 'string' ? s : '' }
}

function compareStrings(a: JsonValue, b: JsonValue, strings: StringOrder): number {
  const x = stringParts(a)
  const y = stringParts(b)
  if (x.size === undefined && y.size === undefined) return strings(x.text, y.text)
  // A cut-short string is known only as far as its preview: compare that much of both, then
  // the full lengths, so a long string never ties with its own prefix.
  const n = Math.min(x.text.length, y.text.length)
  return strings(x.text.slice(0, n), y.text.slice(0, n)) || cmp(x.size ?? x.text.length, y.size ?? y.text.length)
}

// ---- Numbers ----

/** A number exactly, as a fraction of BigInts, or one of the values a fraction can't hold. */
type Exact = { n: bigint; d: bigint } | 'nan' | 'inf' | '-inf'

function exactDouble(x: number): Exact {
  if (Number.isNaN(x)) return 'nan'
  if (!Number.isFinite(x)) return x > 0 ? 'inf' : '-inf'
  // Doubling a double is exact, and one with a fraction becomes whole within 1074 doublings.
  let m = x
  let e = 0
  while (!Number.isInteger(m)) {
    m *= 2
    e++
  }
  return { n: BigInt(m), d: 1n << BigInt(e) }
}

function exactDecimal(text: string): Exact {
  const t = text.trim()
  if (/^[+-]?nan$/i.test(t)) return 'nan'
  if (/^[+-]?inf(inity)?$/i.test(t)) return t.startsWith('-') ? '-inf' : 'inf'
  const m = /^([+-]?)(\d*)(?:\.(\d*))?(?:[eE]([+-]?\d+))?$/.exec(t)
  if (!m || !(m[2] || m[3])) return 'nan'
  const frac = m[3] ?? ''
  const exp = Number(m[4] ?? 0) - frac.length
  let n = BigInt(`${m[2] || '0'}${frac}`)
  if (m[1] === '-') n = -n
  return exp >= 0 ? { n: n * 10n ** BigInt(exp), d: 1n } : { n, d: 10n ** BigInt(-exp) }
}

function numberText(v: JsonValue): string {
  const o = v as JsonObject
  return String(o.$numberInt ?? o.$numberLong ?? o.$numberDouble ?? o.$numberDecimal)
}

function exactOf(v: JsonValue): Exact {
  if (typeof v === 'number') return exactDouble(v)
  const o = v as JsonObject
  if (typeof o.$numberDouble === 'string') return exactDouble(Number(o.$numberDouble))
  return exactDecimal(numberText(v))
}

/** The nearest double: rounding never reverses an order, so two different doubles settle it. */
function approxOf(v: JsonValue): number {
  if (typeof v === 'number') return v
  const text = numberText(v)
  const e = exactDecimal(text)
  return e === 'nan' ? NaN : e === 'inf' ? Infinity : e === '-inf' ? -Infinity : Number(text)
}

const SPECIAL = { nan: 0, '-inf': 1, inf: 3 } as const

function compareNumbers(a: JsonValue, b: JsonValue): number {
  const x = approxOf(a)
  const y = approxOf(b)
  // MongoDB sorts NaN below every other number.
  if (Number.isNaN(x) || Number.isNaN(y)) return Number.isNaN(x) ? (Number.isNaN(y) ? 0 : -1) : 1
  if (x !== y) return x < y ? -1 : 1
  // The same double: a long past 2^53 or a long decimal can still differ, so compare exactly.
  const p = exactOf(a)
  const q = exactOf(b)
  if (typeof p === 'string' || typeof q === 'string') {
    return cmp(typeof p === 'string' ? SPECIAL[p] : 2, typeof q === 'string' ? SPECIAL[q] : 2)
  }
  return cmp(p.n * q.d, q.n * p.d)
}

// ---- Binary ----

/** Binary data as its size, subtype and bytes (hex, whose text order is byte order). A cut-short
 *  binary keeps its real size; its bytes are the part the page kept. */
function binaryParts(v: JsonValue): { size: number; sub: number; hex: string } {
  let size: number | undefined
  if (isTruncated(v)) {
    size = v.$msTruncated.size
    v = v.$msTruncated.preview ?? { $binary: { base64: '', subType: '00' } }
  }
  const o = v as JsonObject
  if (typeof o.$uuid === 'string') {
    const hex = o.$uuid.replace(/-/g, '').toLowerCase()
    return { size: size ?? hex.length / 2, sub: 4, hex }
  }
  const b = isObject(o.$binary) ? o.$binary : {}
  const base64 = typeof b.base64 === 'string' ? b.base64 : ''
  return { size: size ?? base64Length(base64), sub: parseInt(String(b.subType ?? '0'), 16) || 0, hex: base64ToHex(base64) }
}

function compareBinary(a: JsonValue, b: JsonValue): number {
  const x = binaryParts(a)
  const y = binaryParts(b)
  const n = Math.min(x.hex.length, y.hex.length)
  return cmp(x.size, y.size) || cmp(x.sub, y.sub) || cmp(x.hex.slice(0, n), y.hex.slice(0, n))
}

// ---- Documents and arrays ----

/** A document's fields, or none for one cut short at depth (its preview is null). */
function fieldsOf(v: JsonValue): { entries: [string, JsonValue][]; size: number } {
  if (isTruncated(v)) {
    const p = v.$msTruncated.preview
    return { entries: isObject(p) ? Object.entries(p) : [], size: v.$msTruncated.size }
  }
  const entries = Object.entries(v as JsonObject)
  return { entries, size: entries.length }
}

function elementsOf(v: JsonValue): { items: JsonValue[]; size: number } {
  if (isTruncated(v)) {
    const p = v.$msTruncated.preview
    return { items: Array.isArray(p) ? p : [], size: v.$msTruncated.size }
  }
  const items = v as JsonValue[]
  return { items, size: items.length }
}

function compareDocuments(a: JsonValue, b: JsonValue, strings: StringOrder): number {
  const x = fieldsOf(a)
  const y = fieldsOf(b)
  for (let i = 0; i < Math.min(x.entries.length, y.entries.length); i++) {
    const [ka, va] = x.entries[i]!
    const [kb, vb] = y.entries[i]!
    const c = cmp(rankOf(va), rankOf(vb)) || codePointOrder(ka, kb) || compareValues(va, vb, strings)
    if (c) return c
  }
  return cmp(x.size, y.size)
}

function compareArrays(a: JsonValue, b: JsonValue, strings: StringOrder): number {
  const x = elementsOf(a)
  const y = elementsOf(b)
  for (let i = 0; i < Math.min(x.items.length, y.items.length); i++) {
    const c = compareValues(x.items[i]!, y.items[i]!, strings)
    if (c) return c
  }
  return cmp(x.size, y.size)
}

// ---- Values ----

/** Two values in MongoDB's order: negative when `a` sorts first. */
export function compareValues(a: JsonValue, b: JsonValue, strings: StringOrder = codePointOrder): number {
  const rank = rankOf(a)
  const byRank = cmp(rank, rankOf(b))
  if (byRank) return byRank
  switch (rank) {
    case RANK.number:
      return compareNumbers(a, b)
    case RANK.string:
      return compareStrings(a, b, strings)
    case RANK.object:
      return compareDocuments(a, b, strings)
    case RANK.array:
      return compareArrays(a, b, strings)
    case RANK.binData:
      return compareBinary(a, b)
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
      return codePointOrder(String(x.pattern), String(y.pattern)) || codePointOrder(String(x.options ?? ''), String(y.options ?? ''))
    }
    case RANK.dbPointer: {
      // By the namespace's length, then the namespace, then the id.
      const x = (a as JsonObject).$dbPointer as JsonObject
      const y = (b as JsonObject).$dbPointer as JsonObject
      const nx = String(x.$ref ?? '')
      const ny = String(y.$ref ?? '')
      return cmp(nx.length, ny.length) || codePointOrder(nx, ny) || compareValues(x.$id ?? null, y.$id ?? null)
    }
    case RANK.code:
      return codePointOrder(String((a as JsonObject).$code), String((b as JsonObject).$code))
    case RANK.codeWithScope:
      return codePointOrder(String((a as JsonObject).$code), String((b as JsonObject).$code)) || compareDocuments((a as JsonObject).$scope!, (b as JsonObject).$scope!, strings)
    default:
      // MinKey, MaxKey, undefined and null each have one value.
      return 0
  }
}

// ---- Cells ----

/** What a cell sorts by. An array sorts by its smallest element ascending and its largest
 *  descending, as `.sort()` does; an empty one sorts below null. */
type CellKey = { empty: true } | { empty: false; value: JsonValue }

function cellKey(v: JsonValue, direction: SortDirection, strings: StringOrder): CellKey {
  if (rankOf(v) !== RANK.array) return { empty: false, value: v }
  const { items } = elementsOf(v)
  if (!items.length) return isTruncated(v) ? { empty: false, value: v } : { empty: true }
  let best: JsonValue = items[0] as JsonValue
  for (const x of items.slice(1)) {
    const c = compareValues(x, best, strings)
    if (direction === 'asc' ? c < 0 : c > 0) best = x
  }
  return { empty: false, value: best }
}

function compareKeys(a: CellKey, b: CellKey, strings: StringOrder): number {
  if (a.empty || b.empty) return cmp(a.empty ? RANK.emptyArray : rankOf(a.value), b.empty ? RANK.emptyArray : rankOf(b.value))
  return compareValues(a.value, b.value, strings)
}

/**
 * The order to show rows in: indexes into `values`, one cell per row, sorted by them. A missing
 * cell (`undefined`) goes last in either direction, and rows that compare equal keep the order
 * the page gave them. `collation` is the query's, for strings.
 */
export function sortedOrder(values: readonly (JsonValue | undefined)[], direction: SortDirection, collation?: JsonObject): number[] {
  const strings = stringOrder(collation)
  const sign = direction === 'asc' ? 1 : -1
  // Each cell's key is worked out once, not on every comparison.
  const keys = values.map((v) => (v === undefined ? undefined : cellKey(v, direction, strings)))
  return keys
    .map((_, i) => i)
    .sort((i, j) => {
      const a = keys[i]
      const b = keys[j]
      if (a === undefined || b === undefined) return a === undefined ? (b === undefined ? 0 : 1) : -1
      return sign * compareKeys(a, b, strings)
    })
}
