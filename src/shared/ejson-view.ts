// Values travel between worker and panel as canonical Extended JSON, so the panel always knows each
// value's BSON type. This module reads that form without the `bson` package (panels can't import
// npm packages): it names types, writes the relaxed form, shell syntax and short cell text.
// Golden tests compare `toRelaxed` with bson's own EJSON output.

export type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue }
export type JsonObject = { [key: string]: JsonValue }

export type BsonType =
  | 'double'
  | 'string'
  | 'object'
  | 'array'
  | 'binData'
  | 'uuid'
  | 'objectId'
  | 'bool'
  | 'date'
  | 'null'
  | 'regex'
  | 'javascript'
  | 'int'
  | 'timestamp'
  | 'long'
  | 'decimal'
  | 'minKey'
  | 'maxKey'
  | 'symbol'
  | 'dbPointer'
  | 'undefined'
  | 'truncated'

export const BSON_TYPE_LABELS: Record<BsonType, string> = {
  double: 'Double',
  string: 'String',
  object: 'Object',
  array: 'Array',
  binData: 'Binary',
  uuid: 'UUID',
  objectId: 'ObjectId',
  bool: 'Boolean',
  date: 'Date',
  null: 'Null',
  regex: 'Regular expression',
  javascript: 'JavaScript',
  int: 'Int32',
  timestamp: 'Timestamp',
  long: 'Int64 (Long)',
  decimal: 'Decimal128',
  minKey: 'MinKey',
  maxKey: 'MaxKey',
  symbol: 'Symbol',
  dbPointer: 'DBPointer',
  undefined: 'Undefined',
  truncated: 'Truncated'
}

/**
 * What the worker puts in place of a value too big for a results page. The full document is
 * fetched by `_id` before anything is edited.
 */
export type Truncated = { $msTruncated: { kind: 'string' | 'array' | 'binary' | 'object'; size: number; preview: JsonValue } }

export function isObject(v: JsonValue | undefined): v is JsonObject {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

/**
 * Sets a field as an own property. `o[k] = v` with `k === '__proto__'` would set the object's
 * prototype instead, and the field would be lost; data from JSON.parse can hold such a key.
 */
export function setOwn<T>(o: { [key: string]: T }, k: string, v: T): void {
  if (k === '__proto__') Object.defineProperty(o, k, { value: v, writable: true, enumerable: true, configurable: true })
  else o[k] = v
}

export function isTruncated(v: JsonValue | undefined): v is Truncated {
  return isObject(v) && isObject(v.$msTruncated) && Object.keys(v).length === 1
}

/** Whether a value, or anything inside it, was cut short for a results page. */
export function hasTruncated(v: JsonValue | undefined): boolean {
  if (isTruncated(v)) return true
  if (Array.isArray(v)) return v.some(hasTruncated)
  return isObject(v) && Object.values(v).some(hasTruncated)
}

/** The type of a canonical Extended JSON value; plain JSON numbers read as the shell stores them. */
export function bsonType(v: JsonValue): BsonType {
  if (v === null) return 'null'
  if (typeof v === 'string') return 'string'
  if (typeof v === 'boolean') return 'bool'
  if (typeof v === 'number') return Number.isInteger(v) && v >= -2147483648 && v <= 2147483647 ? 'int' : 'double'
  if (Array.isArray(v)) return 'array'
  const keys = Object.keys(v)
  if (keys.length === 1) {
    const k = keys[0]!
    const inner = v[k]
    switch (k) {
      case '$oid':
        if (typeof inner === 'string') return 'objectId'
        break
      case '$date':
        if (typeof inner === 'string' || typeof inner === 'number' || (isObject(inner) && typeof inner.$numberLong === 'string')) return 'date'
        break
      case '$numberInt':
        if (typeof inner === 'string') return 'int'
        break
      case '$numberLong':
        if (typeof inner === 'string') return 'long'
        break
      case '$numberDouble':
        if (typeof inner === 'string') return 'double'
        break
      case '$numberDecimal':
        if (typeof inner === 'string') return 'decimal'
        break
      case '$binary':
        if (isObject(inner) && typeof inner.base64 === 'string') return inner.subType === '04' ? 'uuid' : 'binData'
        break
      case '$uuid':
        if (typeof inner === 'string') return 'uuid'
        break
      case '$regularExpression':
        if (isObject(inner) && typeof inner.pattern === 'string') return 'regex'
        break
      case '$timestamp':
        if (isObject(inner) && typeof inner.t === 'number') return 'timestamp'
        break
      case '$minKey':
        if (inner === 1) return 'minKey'
        break
      case '$maxKey':
        if (inner === 1) return 'maxKey'
        break
      case '$code':
        if (typeof inner === 'string') return 'javascript'
        break
      case '$symbol':
        if (typeof inner === 'string') return 'symbol'
        break
      case '$dbPointer':
        if (isObject(inner)) return 'dbPointer'
        break
      case '$undefined':
        if (inner === true) return 'undefined'
        break
      case '$msTruncated':
        if (isObject(inner)) return 'truncated'
        break
    }
  }
  if (keys.length === 2 && typeof v.$code === 'string' && isObject(v.$scope)) return 'javascript'
  return 'object'
}

/** Whether a value is a document or array with its own fields (not a wrapped scalar). */
export function isContainer(v: JsonValue): v is JsonObject | JsonValue[] {
  const t = bsonType(v)
  return t === 'object' || t === 'array'
}

const MAX_RELAXED_DATE = 253402300800000

/** Milliseconds since 1970 of a canonical `$date`. */
export function dateMillis(v: JsonObject): number {
  const d = v.$date
  if (typeof d === 'number') return d
  if (typeof d === 'string') return Date.parse(d)
  return Number((d as JsonObject).$numberLong)
}

/** The ISO text bson's relaxed EJSON writes: milliseconds only when there are some. */
export function isoDate(ms: number): string {
  const iso = new Date(ms).toISOString()
  return iso.endsWith('.000Z') ? `${iso.slice(0, -5)}Z` : iso
}

/** Canonical → relaxed Extended JSON, matching bson's `EJSON.stringify(x, { relaxed: true })`. */
export function toRelaxed(v: JsonValue): JsonValue {
  if (Array.isArray(v)) return v.map(toRelaxed)
  if (!isObject(v)) return v
  switch (bsonType(v)) {
    case 'int':
      return typeof v.$numberInt === 'string' ? Number(v.$numberInt) : v
    case 'double': {
      const n = Number(v.$numberDouble)
      // Relaxed EJSON writes finite doubles as numbers; -0 keeps its wrapper only in canonical.
      return Number.isFinite(n) ? n : v
    }
    case 'long':
      // bson's relaxed form turns every Long into a JavaScript number, even past 2^53.
      return Number(v.$numberLong)
    case 'date': {
      const ms = dateMillis(v)
      return ms >= 0 && ms < MAX_RELAXED_DATE ? { $date: isoDate(ms) } : { $date: { $numberLong: String(ms) } }
    }
    case 'object': {
      const out: JsonObject = {}
      for (const [k, val] of Object.entries(v)) setOwn(out, k, toRelaxed(val))
      return out
    }
    default:
      return v
  }
}

export function toJsonText(v: JsonValue, relaxed: boolean, indent = 2): string {
  return JSON.stringify(relaxed ? toRelaxed(v) : v, null, indent)
}

// ---- Shell syntax ----

const IDENT = /^[A-Za-z_$][A-Za-z0-9_$]*$/

export function shellString(s: string): string {
  let out = "'"
  for (const ch of s) {
    const code = ch.codePointAt(0)!
    if (ch === "'") out += "\\'"
    else if (ch === '\\') out += '\\\\'
    else if (ch === '\n') out += '\\n'
    else if (ch === '\r') out += '\\r'
    else if (ch === '\t') out += '\\t'
    else if (code < 0x20 || code === 0x2028 || code === 0x2029) out += `\\u${code.toString(16).padStart(4, '0')}`
    else out += ch
  }
  return `${out}'`
}

function shellKey(k: string): string {
  // `__proto__: v`, quoted or not, sets the prototype in JavaScript; a computed key adds a field.
  if (k === '__proto__') return "['__proto__']"
  return IDENT.test(k) ? k : shellString(k)
}

export function base64ToHex(b64: string): string {
  const clean = b64.replace(/=+$/, '')
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'
  let hex = ''
  let buf = 0
  let bits = 0
  for (const ch of clean) {
    buf = (buf << 6) | alphabet.indexOf(ch)
    bits += 6
    if (bits >= 8) {
      bits -= 8
      hex += ((buf >> bits) & 0xff).toString(16).padStart(2, '0')
    }
  }
  return hex
}

export function base64Length(b64: string): number {
  const clean = b64.replace(/\s+/g, '')
  const pad = clean.endsWith('==') ? 2 : clean.endsWith('=') ? 1 : 0
  return Math.floor((clean.length * 3) / 4) - pad
}

export function uuidText(b64: string): string {
  const h = base64ToHex(b64)
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`
}

function doubleShell(text: string): string {
  if (text === 'NaN' || text === 'Infinity' || text === '-Infinity') return text
  if (text === '-0.0' || text === '-0') return '-0.0'
  const n = Number(text)
  const s = String(n)
  return /[.eE]/.test(s) || !Number.isFinite(n) ? s : `${s}.0`
}

/** A scalar in shell syntax, or undefined for documents and arrays. */
export function shellScalar(v: JsonValue): string | undefined {
  if (v === null) return 'null'
  if (typeof v === 'string') return shellString(v)
  if (typeof v === 'boolean') return String(v)
  if (typeof v === 'number') return Number.isInteger(v) ? String(v) : doubleShell(String(v))
  const t = bsonType(v)
  const o = v as JsonObject
  switch (t) {
    case 'objectId':
      return `ObjectId(${shellString(String(o.$oid))})`
    case 'date': {
      const ms = dateMillis(o)
      return ms >= 0 && ms < MAX_RELAXED_DATE ? `ISODate(${shellString(isoDate(ms))})` : `new Date(${ms})`
    }
    case 'int':
      return String(o.$numberInt)
    case 'double':
      return doubleShell(String(o.$numberDouble))
    case 'long':
      return `NumberLong(${shellString(String(o.$numberLong))})`
    case 'decimal':
      return `NumberDecimal(${shellString(String(o.$numberDecimal))})`
    case 'uuid': {
      const b = o.$binary as JsonObject | undefined
      if (b && base64Length(String(b.base64)) === 16) return `UUID(${shellString(uuidText(String(b.base64)))})`
      if (typeof o.$uuid === 'string') return `UUID(${shellString(o.$uuid)})`
      return `BinData(4, ${shellString(String(b?.base64 ?? ''))})`
    }
    case 'binData': {
      const b = o.$binary as JsonObject
      return `BinData(${parseInt(String(b.subType), 16)}, ${shellString(String(b.base64))})`
    }
    case 'regex': {
      const r = o.$regularExpression as JsonObject
      const pattern = String(r.pattern)
      const flags = String(r.options ?? '')
      // A literal works when the pattern has no bare slash or line break.
      if (!/(^|[^\\])(\\\\)*\//.test(pattern) && !/[\n\r]/.test(pattern) && !pattern.endsWith('\\')) return `/${pattern}/${flags}`
      return `RegExp(${shellString(pattern)}${flags ? `, ${shellString(flags)}` : ''})`
    }
    case 'timestamp': {
      const ts = o.$timestamp as JsonObject
      return `Timestamp({ t: ${String(ts.t)}, i: ${String(ts.i)} })`
    }
    case 'minKey':
      return 'MinKey()'
    case 'maxKey':
      return 'MaxKey()'
    case 'javascript':
      return typeof o.$scope === 'object' ? undefined : `Code(${shellString(String(o.$code))})`
    case 'truncated': {
      const tr = (o as Truncated).$msTruncated
      return `/* truncated: ${tr.size.toLocaleString('en-US')} ${tr.kind === 'string' ? 'characters' : tr.kind === 'array' ? 'items' : 'bytes'} */ null`
    }
    default:
      return undefined
  }
}

/** Shell syntax that `parseShell` reads back to the same canonical value. */
export function toShell(v: JsonValue, indent = 2, depth = 0): string {
  const scalar = shellScalar(v)
  if (scalar !== undefined) return scalar
  const pad = ' '.repeat(indent * (depth + 1))
  const end = ' '.repeat(indent * depth)
  if (Array.isArray(v)) {
    if (v.length === 0) return '[]'
    return `[\n${v.map((x) => pad + toShell(x, indent, depth + 1)).join(',\n')}\n${end}]`
  }
  const entries = Object.entries(v as JsonObject)
  if (entries.length === 0) return '{}'
  return `{\n${entries.map(([k, x]) => `${pad}${shellKey(k)}: ${toShell(x, indent, depth + 1)}`).join(',\n')}\n${end}}`
}

/** One line of shell syntax, for query fields: `{ a: 1, b: { $gt: 2 } }`. */
export function toShellInline(v: JsonValue): string {
  const scalar = shellScalar(v)
  if (scalar !== undefined) return scalar
  if (Array.isArray(v)) return v.length ? `[${v.map(toShellInline).join(', ')}]` : '[]'
  const entries = Object.entries(v as JsonObject)
  return entries.length ? `{ ${entries.map(([k, x]) => `${shellKey(k)}: ${toShellInline(x)}`).join(', ')} }` : '{}'
}

// ---- Short text for tables and trees ----

function clip(s: string, max: number): string {
  return s.length > max ? `${s.slice(0, max - 1)}…` : s
}

function formatDate(ms: number): string {
  return Number.isFinite(ms) ? isoDate(ms) : 'Invalid date'
}

/** What a table cell or tree label shows for a value. */
export function valueText(v: JsonValue, max = 120): string {
  const t = bsonType(v)
  switch (t) {
    case 'string':
      return clip((v as string).replace(/\s+/g, ' '), max)
    case 'null':
      return 'null'
    case 'bool':
      return String(v)
    case 'int':
    case 'double':
      return typeof v === 'number' ? String(v) : String((v as JsonObject).$numberInt ?? doubleShell(String((v as JsonObject).$numberDouble)))
    case 'long':
      return String((v as JsonObject).$numberLong)
    case 'decimal':
      return String((v as JsonObject).$numberDecimal)
    case 'objectId':
      return `ObjectId(${String((v as JsonObject).$oid)})`
    case 'date':
      return formatDate(dateMillis(v as JsonObject))
    case 'uuid': {
      const b = (v as JsonObject).$binary as JsonObject | undefined
      return `UUID(${b ? uuidText(String(b.base64)) : String((v as JsonObject).$uuid)})`
    }
    case 'binData': {
      const b = (v as JsonObject).$binary as JsonObject
      return `Binary(${parseInt(String(b.subType), 16)}, ${base64Length(String(b.base64)).toLocaleString('en-US')} bytes)`
    }
    case 'array': {
      const n = (v as JsonValue[]).length
      return `[${n} item${n === 1 ? '' : 's'}]`
    }
    case 'object': {
      const n = Object.keys(v as JsonObject).length
      return `{${n} field${n === 1 ? '' : 's'}}`
    }
    case 'truncated': {
      const tr = (v as Truncated).$msTruncated
      if (tr.kind === 'string') return `${clip(String(tr.preview).replace(/\s+/g, ' '), max - 12)}… (${tr.size.toLocaleString('en-US')} chars)`
      if (tr.kind === 'array') return `[${tr.size.toLocaleString('en-US')} items]`
      if (tr.kind === 'object') return `{${tr.size.toLocaleString('en-US')} fields}`
      return `Binary(${tr.size.toLocaleString('en-US')} bytes)`
    }
    default:
      return clip(shellScalar(v) ?? JSON.stringify(v), max)
  }
}

/** Every dotted path of a document's fields (not into arrays), for field pickers and builders. */
export function fieldPaths(doc: JsonValue, prefix = '', out: Set<string> = new Set(), depth = 0): Set<string> {
  if (!isObject(doc) || bsonType(doc) !== 'object' || depth > 6) return out
  for (const [k, v] of Object.entries(doc)) {
    const path = prefix ? `${prefix}.${k}` : k
    out.add(path)
    if (bsonType(v) === 'object') fieldPaths(v, path, out, depth + 1)
  }
  return out
}

/** The value at a path of keys and array indexes, or undefined. */
export function valueAt(doc: JsonValue, path: readonly (string | number)[]): JsonValue | undefined {
  let cur: JsonValue | undefined = doc
  for (const seg of path) {
    if (Array.isArray(cur) && typeof seg === 'number') cur = cur[seg]
    else if (isObject(cur) && bsonType(cur) === 'object' && typeof seg === 'string') cur = cur[seg]
    else return undefined
  }
  return cur
}

/** Dotted text for a path, as people read it: `items.0.sku`. */
export function pathText(path: readonly (string | number)[]): string {
  return path.map(String).join('.')
}

/** A stable text key for an `_id` value, for table rows and selection. */
export function idKey(id: JsonValue): string {
  return JSON.stringify(id)
}
