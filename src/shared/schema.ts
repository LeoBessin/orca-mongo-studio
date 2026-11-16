// The Schema Explorer's analysis: what a sample of documents holds, field by field (types, how
// often each field is there, number and date histograms, common strings, array lengths), and the
// sample's shape as a JSON Schema or a MongoDB `$jsonSchema` validator. It reads canonical
// Extended JSON, so the worker and the tests share it and every BSON type keeps its name.
import { bsonType, dateMillis, isObject, isoDate, type BsonType, type JsonObject, type JsonValue } from './ejson-view'

/** Array elements are a field named `[]`: `tags[]`, `items[].sku`. */
export const ELEMENT = '[]'

export type Bucket = { label: string; from: number; to: number; count: number }
export type TopValue = { value: string; count: number }

export type SchemaField = {
  /** Dotted path; array elements are `[]`, as in `items[].sku`. */
  path: string
  name: string
  /** The parent's path, or '' for a top-level field. */
  parent: string
  depth: number
  /** Values seen (null included). For a `[]` path, array elements. */
  count: number
  /** Times the parent was there to hold it: sampled documents for a top-level field, objects for
   *  a sub-field, arrays for `[]`. */
  parentCount: number
  types: { type: BsonType; count: number }[]
  numbers?: { min: number; max: number; mean: number; buckets: Bucket[] }
  dates?: { min: number; max: number; buckets: Bucket[] }
  strings?: { minLength: number; maxLength: number; distinct: number; distinctCapped: boolean; top: TopValue[] }
  bools?: { true: number; false: number }
  arrays?: { minLength: number; maxLength: number; avgLength: number }
}

export type SchemaReport = {
  /** Documents analysed. */
  sampled: number
  requested: number
  fields: SchemaField[]
  /** Fields past `maxFields` were left out. */
  fieldsCapped: boolean
  ms: number
}

export type AnalyzeOptions = {
  /** Most fields kept (deepest and rarest go first). Default 1,000. */
  maxFields?: number
  /** Distinct strings counted per field. Default 1,000. */
  maxDistinct?: number
  /** Numbers and dates kept per field for histograms (a reservoir). Default 5,000. */
  maxValues?: number
  maxBuckets?: number
  /** Top strings shown per field. Default 10. */
  topValues?: number
}

type Acc = {
  path: string
  name: string
  parent: string
  depth: number
  count: number
  objects: number
  arrays: number
  types: Map<BsonType, number>
  numbers: number[]
  numberSeen: number
  numberSum: number
  numberMin: number
  numberMax: number
  dates: number[]
  dateSeen: number
  dateMin: number
  dateMax: number
  strings: Map<string, number>
  stringsCapped: boolean
  stringMin: number
  stringMax: number
  boolTrue: number
  boolFalse: number
  arrayMin: number
  arrayMax: number
  arrayTotal: number
}

function newAcc(path: string, name: string, parent: string, depth: number): Acc {
  return {
    path,
    name,
    parent,
    depth,
    count: 0,
    objects: 0,
    arrays: 0,
    types: new Map(),
    numbers: [],
    numberSeen: 0,
    numberSum: 0,
    numberMin: Infinity,
    numberMax: -Infinity,
    dates: [],
    dateSeen: 0,
    dateMin: Infinity,
    dateMax: -Infinity,
    strings: new Map(),
    stringsCapped: false,
    stringMin: Infinity,
    stringMax: 0,
    boolTrue: 0,
    boolFalse: 0,
    arrayMin: Infinity,
    arrayMax: 0,
    arrayTotal: 0
  }
}

/** The number a canonical numeric value holds, or undefined (NaN, infinities, not a number). */
export function numericValue(v: JsonValue): number | undefined {
  let n: number
  if (typeof v === 'number') n = v
  else if (isObject(v)) {
    const raw = v.$numberInt ?? v.$numberLong ?? v.$numberDouble ?? v.$numberDecimal
    if (typeof raw !== 'string') return undefined
    n = Number(raw)
  } else return undefined
  return Number.isFinite(n) ? n : undefined
}

const NUMERIC = new Set<BsonType>(['int', 'long', 'double', 'decimal'])

/** Keeps a uniform sample of a stream in `keep` slots (reservoir sampling, seeded). */
function reservoir(list: number[], seen: number, value: number, keep: number, rand: () => number): void {
  if (list.length < keep) list.push(value)
  else {
    const j = Math.floor(rand() * seen)
    if (j < keep) list[j] = value
  }
}

/** A small deterministic generator, so the same sample gives the same report. */
function seeded(seed: number): () => number {
  let s = seed >>> 0
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0
    return s / 4294967296
  }
}

export function analyzeDocuments(docs: readonly JsonObject[], options: AnalyzeOptions = {}, requested = docs.length, ms = 0): SchemaReport {
  const maxDistinct = options.maxDistinct ?? 1000
  const maxValues = options.maxValues ?? 5000
  const accs = new Map<string, Acc>()
  const rand = seeded(42)

  const visit = (value: JsonValue, path: string, name: string, parent: string, depth: number): void => {
    let acc = accs.get(path)
    if (!acc) accs.set(path, (acc = newAcc(path, name, parent, depth)))
    acc.count++
    const type = bsonType(value)
    acc.types.set(type, (acc.types.get(type) ?? 0) + 1)
    if (NUMERIC.has(type)) {
      const n = numericValue(value)
      if (n !== undefined) {
        acc.numberSeen++
        acc.numberSum += n
        if (n < acc.numberMin) acc.numberMin = n
        if (n > acc.numberMax) acc.numberMax = n
        reservoir(acc.numbers, acc.numberSeen, n, maxValues, rand)
      }
    } else if (type === 'date') {
      const ms = dateMillis(value as JsonObject)
      if (Number.isFinite(ms)) {
        acc.dateSeen++
        if (ms < acc.dateMin) acc.dateMin = ms
        if (ms > acc.dateMax) acc.dateMax = ms
        reservoir(acc.dates, acc.dateSeen, ms, maxValues, rand)
      }
    } else if (type === 'string') {
      const s = value as string
      if (s.length < acc.stringMin) acc.stringMin = s.length
      if (s.length > acc.stringMax) acc.stringMax = s.length
      const seen = acc.strings.get(s)
      if (seen !== undefined) acc.strings.set(s, seen + 1)
      else if (acc.strings.size < maxDistinct) acc.strings.set(s, 1)
      else acc.stringsCapped = true
    } else if (type === 'bool') {
      if (value === true) acc.boolTrue++
      else acc.boolFalse++
    } else if (type === 'object') {
      acc.objects++
      for (const [k, v] of Object.entries(value as JsonObject)) visit(v, `${path}.${k}`, k, path, depth + 1)
    } else if (type === 'array') {
      const items = value as JsonValue[]
      acc.arrays++
      acc.arrayTotal += items.length
      if (items.length < acc.arrayMin) acc.arrayMin = items.length
      if (items.length > acc.arrayMax) acc.arrayMax = items.length
      for (const item of items) visit(item, `${path}${ELEMENT}`, ELEMENT, path, depth + 1)
    }
  }

  for (const doc of docs) for (const [k, v] of Object.entries(doc)) visit(v, k, k, '', 0)

  const parentCount = (a: Acc): number => {
    if (!a.parent) return docs.length
    const p = accs.get(a.parent)
    if (!p) return 0
    return a.name === ELEMENT ? p.arrays : p.objects
  }

  // Depth first, `_id` first, then by name; arrays' elements right under the array.
  const kids = new Map<string, Acc[]>()
  for (const a of accs.values()) {
    const list = kids.get(a.parent) ?? []
    list.push(a)
    kids.set(a.parent, list)
  }
  const order = (x: Acc, y: Acc): number => {
    const rank = (a: Acc): number => (a.name === ELEMENT ? 0 : a.name === '_id' ? 1 : 2)
    return rank(x) - rank(y) || (x.name < y.name ? -1 : x.name > y.name ? 1 : 0)
  }
  const ordered: Acc[] = []
  const walk = (parent: string): void => {
    for (const a of (kids.get(parent) ?? []).sort(order)) {
      ordered.push(a)
      walk(a.path)
    }
  }
  walk('')

  const maxFields = options.maxFields ?? 1000
  let kept = ordered
  let fieldsCapped = false
  if (ordered.length > maxFields) {
    fieldsCapped = true
    // Keep the shallowest, most common fields; a kept field's parent is always kept too.
    const chosen = new Set([...ordered].sort((x, y) => x.depth - y.depth || y.count - x.count).slice(0, maxFields).map((a) => a.path))
    kept = ordered.filter((a) => chosen.has(a.path) && (!a.parent || chosen.has(a.parent)))
  }

  const fields = kept.map((a): SchemaField => {
    const f: SchemaField = {
      path: a.path,
      name: a.name,
      parent: a.parent,
      depth: a.depth,
      count: a.count,
      parentCount: parentCount(a),
      types: [...a.types.entries()].map(([type, count]) => ({ type, count })).sort((x, y) => y.count - x.count || (x.type < y.type ? -1 : 1))
    }
    if (a.numberSeen) f.numbers = { min: a.numberMin, max: a.numberMax, mean: a.numberSum / a.numberSeen, buckets: numberBuckets(a.numbers, a.numberMin, a.numberMax, a.numberSeen, options.maxBuckets) }
    if (a.dateSeen) f.dates = { min: a.dateMin, max: a.dateMax, buckets: dateBuckets(a.dates, a.dateMin, a.dateMax, a.dateSeen, options.maxBuckets) }
    if (a.strings.size) {
      const top = [...a.strings.entries()]
        .sort((x, y) => y[1] - x[1] || (x[0] < y[0] ? -1 : 1))
        .slice(0, options.topValues ?? 10)
        .map(([value, count]) => ({ value: value.length > 80 ? `${value.slice(0, 79)}…` : value, count }))
      f.strings = { minLength: a.stringMin, maxLength: a.stringMax, distinct: a.strings.size, distinctCapped: a.stringsCapped, top }
    }
    if (a.boolTrue || a.boolFalse) f.bools = { true: a.boolTrue, false: a.boolFalse }
    if (a.arrays) f.arrays = { minLength: a.arrayMin, maxLength: a.arrayMax, avgLength: a.arrayTotal / a.arrays }
    return f
  })
  return { sampled: docs.length, requested, fields, fieldsCapped, ms }
}

// ---- Histograms ----

/** 1, 2 or 5 times a power of ten, at least `raw`. */
export function niceStep(raw: number): number {
  if (!(raw > 0) || !Number.isFinite(raw)) return 1
  const p = 10 ** Math.floor(Math.log10(raw))
  for (const m of [1, 2, 5, 10]) if (m * p >= raw * (1 - 1e-9)) return m * p
  return 10 * p
}

export function formatNumber(n: number): string {
  if (Number.isInteger(n)) return n.toLocaleString('en-US')
  const abs = Math.abs(n)
  if (abs !== 0 && (abs < 0.001 || abs >= 1e15)) return n.toExponential(2)
  return n.toLocaleString('en-US', { maximumFractionDigits: abs < 1 ? 4 : 2 })
}

/** Scales the counts of a reservoir up to every value seen. */
function scaled(buckets: Bucket[], kept: number, seen: number): Bucket[] {
  if (kept === seen || kept === 0) return buckets
  const f = seen / kept
  return buckets.map((b) => ({ ...b, count: Math.round(b.count * f) }))
}

export function numberBuckets(values: readonly number[], min: number, max: number, seen = values.length, maxBuckets = 10): Bucket[] {
  if (!values.length) return []
  if (min === max) return scaled([{ label: formatNumber(min), from: min, to: max, count: values.length }], values.length, seen)
  // Past 2^53 a whole number plus one is itself, so very large numbers are bucketed as doubles.
  const ints = Number.isSafeInteger(min) && Number.isSafeInteger(max) && values.every(Number.isInteger)
  // Few whole numbers: one bar each.
  if (ints && max - min < maxBuckets) {
    const out: Bucket[] = []
    for (let v = min; v <= max; v++) out.push({ label: formatNumber(v), from: v, to: v, count: 0 })
    for (const v of values) out[v - min]!.count++
    return scaled(out, values.length, seen)
  }
  let step = niceStep((max - min) / maxBuckets)
  if (ints && step < 1) step = 1
  const start = Math.floor(min / step) * step
  const n = Math.max(1, Math.min(maxBuckets + 1, Math.floor((max - start) / step) + 1))
  const out: Bucket[] = Array.from({ length: n }, (_, i) => {
    const from = start + i * step
    const to = from + step
    return { label: `${formatNumber(round(from))} – ${formatNumber(round(to))}`, from: round(from), to: round(to), count: 0 }
  })
  for (const v of values) out[Math.min(n - 1, Math.max(0, Math.floor((v - start) / step)))]!.count++
  return scaled(out, values.length, seen)
}

function round(n: number): number {
  return Number(n.toPrecision(12))
}

type DateUnit = { name: 'hour' | 'day' | 'month' | 'year'; label: (ms: number) => string }
const HOUR = 3_600_000
const DAY = 24 * HOUR

function floorUnit(ms: number, unit: DateUnit['name'], every: number): number {
  const d = new Date(ms)
  switch (unit) {
    case 'hour':
      return Math.floor(ms / (HOUR * every)) * HOUR * every
    case 'day':
      return Math.floor(ms / (DAY * every)) * DAY * every
    case 'month': {
      const months = d.getUTCFullYear() * 12 + d.getUTCMonth()
      const m = Math.floor(months / every) * every
      return Date.UTC(Math.floor(m / 12), m % 12, 1)
    }
    case 'year': {
      const y = Math.floor(d.getUTCFullYear() / every) * every
      return Date.UTC(y, 0, 1)
    }
  }
}

function addUnit(ms: number, unit: DateUnit['name'], every: number): number {
  const d = new Date(ms)
  switch (unit) {
    case 'hour':
      return ms + HOUR * every
    case 'day':
      return ms + DAY * every
    case 'month':
      return Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + every, 1)
    case 'year':
      return Date.UTC(d.getUTCFullYear() + every, 0, 1)
  }
}

function dateLabel(ms: number, unit: DateUnit['name']): string {
  const iso = isoDate(ms)
  switch (unit) {
    case 'hour':
      return `${iso.slice(0, 13).replace('T', ' ')}:00`
    case 'day':
      return iso.slice(0, 10)
    case 'month':
      return iso.slice(0, 7)
    case 'year':
      return iso.slice(0, 4)
  }
}

/** Buckets of whole hours, days, months or years (UTC), as many as fit in `maxBuckets`. */
export function dateBuckets(values: readonly number[], min: number, max: number, seen = values.length, maxBuckets = 12): Bucket[] {
  if (!values.length) return []
  const span = max - min
  const unit: DateUnit['name'] = span <= 2 * DAY ? 'hour' : span <= 62 * DAY ? 'day' : span <= 3 * 366 * DAY ? 'month' : 'year'
  const steps = { hour: [1, 2, 3, 6, 12], day: [1, 2, 7, 14], month: [1, 2, 3, 6, 12], year: [1, 2, 5, 10, 20, 50, 100, 200, 500, 1000] }[unit]
  let every = 1
  for (const e of steps) {
    every = e
    let n = 0
    for (let at = floorUnit(min, unit, e); at <= max; at = addUnit(at, unit, e)) if (++n > maxBuckets) break
    if (n <= maxBuckets) break
  }
  const out: Bucket[] = []
  for (let at = floorUnit(min, unit, every); at <= max && out.length < 1000; at = addUnit(at, unit, every)) {
    const to = addUnit(at, unit, every)
    const first = dateLabel(at, unit)
    out.push({ label: every === 1 ? first : `${first} – ${dateLabel(addUnit(at, unit, every - 1), unit)}`, from: at, to, count: 0 })
  }
  for (const v of values) {
    let lo = 0
    let hi = out.length - 1
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1
      if (out[mid]!.from <= v) lo = mid
      else hi = mid - 1
    }
    out[lo]!.count++
  }
  return scaled(out, values.length, seen)
}

// ---- Reading a report ----

export function percent(part: number, whole: number): number {
  return whole > 0 ? Math.round((part / whole) * 1000) / 10 : 0
}

/** "string 80% · int 20%": how a field's values split by type. */
export function typeSummary(f: SchemaField): string {
  return f.types.map((t) => `${t.type} ${percent(t.count, f.count)}%`).join(' · ')
}

/** "in 95% of documents", or for array elements "4.2 per array". */
export function presenceText(f: SchemaField): string {
  if (f.name === ELEMENT) return `${f.count.toLocaleString('en-US')} element${f.count === 1 ? '' : 's'} in ${f.parentCount.toLocaleString('en-US')} array${f.parentCount === 1 ? '' : 's'}`
  const where = f.parent ? 'of its parent objects' : 'of documents'
  return `in ${percent(Math.min(f.count, f.parentCount), f.parentCount)}% ${where}`
}

/** A text bar for a share, `width` characters at 100%. */
export function bar(part: number, whole: number, width = 20): string {
  if (whole <= 0 || part <= 0) return ''
  const eighths = Math.max(1, Math.round((part / whole) * width * 8))
  const full = Math.floor(eighths / 8)
  const rest = eighths % 8
  return '█'.repeat(full) + (rest ? ' ▏▎▍▌▋▊▉'[rest] : '')
}

export function childrenOf(report: SchemaReport, parent: string): SchemaField[] {
  return report.fields.filter((f) => f.parent === parent)
}

// ---- JSON Schema ----

export type SchemaFlavor = 'mongo' | 'json'
export type SchemaExportOptions = {
  flavor: SchemaFlavor
  /** Lists fields every sampled parent had as `required`. */
  required: boolean
  /** Refuses fields the sample did not have (`additionalProperties: false`). */
  closed: boolean
}

const JSON_TYPES: Partial<Record<BsonType, JsonObject>> = {
  string: { type: 'string' },
  int: { type: 'integer' },
  long: { type: 'integer' },
  double: { type: 'number' },
  decimal: { type: 'number' },
  bool: { type: 'boolean' },
  null: { type: 'null' },
  object: { type: 'object' },
  array: { type: 'array' },
  date: { type: 'string', format: 'date-time' },
  objectId: { type: 'string', pattern: '^[0-9a-fA-F]{24}$' },
  uuid: { type: 'string', format: 'uuid' }
}

function mongoType(t: BsonType): string | undefined {
  if (t === 'uuid') return 'binData'
  if (t === 'truncated') return undefined
  return t
}

function fieldSchema(report: SchemaReport, f: SchemaField, options: SchemaExportOptions): JsonObject {
  const types = f.types.map((t) => t.type)
  const out: JsonObject = {}
  if (options.flavor === 'mongo') {
    const names = [...new Set(types.map(mongoType).filter((x): x is string => Boolean(x)))]
    if (names.length === 1) out.bsonType = names[0]!
    else if (names.length) out.bsonType = names
  } else {
    // Integers are numbers too: one `number` covers both.
    const set = new Set(types)
    if (set.has('double') || set.has('decimal')) {
      set.delete('int')
      set.delete('long')
    }
    const simple: string[] = []
    const rich: JsonObject[] = []
    for (const t of set) {
      const s = JSON_TYPES[t]
      if (!s) continue
      if (Object.keys(s).length === 1) {
        if (!simple.includes(s.type as string)) simple.push(s.type as string)
      } else rich.push(s)
    }
    if (rich.length === 0) {
      if (simple.length === 1) out.type = simple[0]!
      else if (simple.length) out.type = simple
    } else if (simple.length === 0 && rich.length === 1) Object.assign(out, rich[0]!)
    else out.anyOf = [...rich, ...(simple.length ? [{ type: simple.length === 1 ? simple[0]! : simple }] : [])]
  }
  if (types.includes('object')) Object.assign(out, objectSchema(report, f.path, f.count === 0 ? 0 : objectsOf(report, f), options))
  if (types.includes('array')) {
    const items = report.fields.find((x) => x.parent === f.path && x.name === ELEMENT)
    if (items) out.items = fieldSchema(report, items, options)
  }
  return out
}

function objectsOf(report: SchemaReport, f: SchemaField): number {
  return f.types.find((t) => t.type === 'object')?.count ?? 0
}

function objectSchema(report: SchemaReport, parent: string, seen: number, options: SchemaExportOptions): JsonObject {
  const props: JsonObject = {}
  const required: string[] = []
  for (const f of childrenOf(report, parent)) {
    if (f.name === ELEMENT) continue
    props[f.name] = fieldSchema(report, f, options)
    if (options.required && seen > 0 && f.count >= seen) required.push(f.name)
  }
  const out: JsonObject = {}
  if (required.length) out.required = required
  out.properties = props
  if (options.closed) out.additionalProperties = false
  return out
}

/** The sample's shape: `{ $jsonSchema: … }` for MongoDB, or a draft 2020-12 JSON Schema. */
export function toJsonSchema(report: SchemaReport, options: SchemaExportOptions): JsonObject {
  const root = objectSchema(report, '', report.sampled, options)
  if (options.flavor === 'mongo') return { $jsonSchema: { bsonType: 'object', ...root } }
  return { $schema: 'https://json-schema.org/draft/2020-12/schema', type: 'object', ...root }
}

/** Range text for a field's numbers or dates. */
export function rangeText(f: SchemaField): string | undefined {
  if (f.numbers) return `${formatNumber(f.numbers.min)} to ${formatNumber(f.numbers.max)}, mean ${formatNumber(round(f.numbers.mean))}`
  if (f.dates) return `${isoDate(f.dates.min)} to ${isoDate(f.dates.max)}`
  return undefined
}
