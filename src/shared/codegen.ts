// Driver code generation: an `Operation` (canonical Extended JSON) as a copy-pasteable snippet for
// mongosh and the official drivers. Every BSON value keeps its exact type: Int32 / Int64 / Double /
// Decimal128 never collapse into each other, dates are UTC, regexes keep their flags, and so on.
// When a driver cannot write a type at all (BSON undefined in PyMongo, for example), the closest
// construct is used and a `Note:` comment above the statement says so. Pure and deterministic; it
// imports only relative modules, so the panel can load it.
import { base64Length, bsonType, dateMillis, isObject, isoDate, shellString, uuidText, type JsonObject, type JsonValue } from './ejson-view'
import { operationToShell, type FindOperation, type Operation } from './operation'

export type CodeLanguage = 'mongosh' | 'node' | 'python' | 'java' | 'csharp' | 'php' | 'ruby'

export const CODE_LANGUAGES: { value: CodeLanguage; label: string }[] = [
  { value: 'mongosh', label: 'mongosh' },
  { value: 'node', label: 'Node.js' },
  { value: 'python', label: 'Python' },
  { value: 'java', label: 'Java' },
  { value: 'csharp', label: 'C#' },
  { value: 'php', label: 'PHP' },
  { value: 'ruby', label: 'Ruby' }
]

const URI = 'mongodb://localhost:27017'

/** A document or array goes on one line when its one-line form is at most this long. */
const WIDTH = 72

// ---- Reading canonical values ----

type Ctx = { notes: Set<string>; uses: Set<string> }

/** What a language's scalar writer gets: where the value is, and how to write a nested value. */
type At = { ctx: Ctx; path: string; sub: (v: JsonValue, path: string) => string }

function intText(v: JsonValue): string {
  return typeof v === 'number' ? String(v) : String((v as JsonObject).$numberInt)
}

function longText(v: JsonValue): string {
  return String((v as JsonObject).$numberLong)
}

function doubleOf(v: JsonValue): number {
  return typeof v === 'number' ? v : Number((v as JsonObject).$numberDouble)
}

/** A finite double as a literal every target language reads as a floating-point number. */
function doubleText(n: number): string {
  if (Object.is(n, -0)) return '-0.0'
  const s = String(n)
  return /[.e]/.test(s) ? s : `${s}.0`
}

function doubleKind(n: number): 'nan' | 'inf' | '-inf' | 'num' {
  return Number.isNaN(n) ? 'nan' : n === Infinity ? 'inf' : n === -Infinity ? '-inf' : 'num'
}

const MIN_YEAR_1 = -62135596800000 // 0001-01-01T00:00:00Z
const MAX_YEAR_9999 = 253402300800000 // 10000-01-01T00:00:00Z

/** Whether a date falls in years 1 to 9999, which every language's date-time type can hold. */
function commonEra(ms: number): boolean {
  return ms >= MIN_YEAR_1 && ms < MAX_YEAR_9999
}

function dateParts(ms: number): { y: number; mo: number; d: number; h: number; mi: number; s: number; ms: number } {
  const d = new Date(ms)
  return {
    y: d.getUTCFullYear(),
    mo: d.getUTCMonth() + 1,
    d: d.getUTCDate(),
    h: d.getUTCHours(),
    mi: d.getUTCMinutes(),
    s: d.getUTCSeconds(),
    ms: d.getUTCMilliseconds()
  }
}

type Regex = { pattern: string; options: string }
function regexOf(v: JsonObject): Regex {
  const r = v.$regularExpression as JsonObject
  return { pattern: String(r.pattern), options: String(r.options ?? '') }
}

type Bin = { base64: string; subType: number }
function binaryOf(v: JsonObject): Bin {
  const b = v.$binary as JsonObject
  return { base64: String(b.base64), subType: parseInt(String(b.subType), 16) }
}

/** The UUID text of a subtype-4 value, or undefined when it is not 16 bytes. */
function uuidOf(v: JsonObject): string | undefined {
  if (typeof v.$uuid === 'string') return v.$uuid
  const b = v.$binary as JsonObject
  return base64Length(String(b.base64)) === 16 ? uuidText(String(b.base64)) : undefined
}

/** A subtype-4 value that is not a 16-byte UUID, as plain binary data. */
function uuidAsBinary(v: JsonObject): Bin {
  return isObject(v.$binary) ? binaryOf(v) : { base64: '', subType: 4 }
}

type Ts = { t: number; i: number }
function timestampOf(v: JsonObject): Ts {
  const ts = v.$timestamp as JsonObject
  return { t: Number(ts.t), i: Number(ts.i) }
}

/** Java and C# take the two halves as signed ints; past 2^31 - 1 the 64-bit value is used. */
function timestampFitsInts(ts: Ts): boolean {
  return ts.t <= 2147483647 && ts.i <= 2147483647
}
function timestampLong(ts: Ts): string {
  return BigInt.asIntN(64, (BigInt(ts.t) << 32n) | BigInt(ts.i)).toString()
}

function dbPointerOf(v: JsonObject): { ns: string; id: JsonValue } {
  const p = v.$dbPointer as JsonObject
  return { ns: String(p.$ref), id: p.$id ?? null }
}

function hexOfUuid(uuid: string): string {
  return uuid.replace(/-/g, '').toLowerCase()
}

function hex2(n: number): string {
  return `0x${n.toString(16).padStart(2, '0')}`
}

const TRUNCATED = 'the value was truncated in the results and is written as null; run the query on the full document'

// ---- Layout ----

type Syntax = {
  unit: string
  str(s: string): string
  key(k: string): string
  /** Scalar or wrapped value; undefined for documents and arrays. */
  scalar(v: JsonValue, at: At): string | undefined
  /** `keys` are the raw field names, for languages whose literal syntax depends on them. */
  doc(entries: [string, string][], multi: boolean, pad: string, keys: string[]): string
  arr(items: string[], multi: boolean, pad: string): string
}

/**
 * A value at a line indented by `pad`. Documents and arrays go on one line when short, otherwise
 * one entry per line one indent deeper; `inline` forces one line (used for the first attempt).
 */
function render(s: Syntax, ctx: Ctx, v: JsonValue, pad: string, path: string, inline = false): string {
  const scalar = s.scalar(v, { ctx, path, sub: (x, p) => render(s, ctx, x, pad, p, inline) })
  if (scalar !== undefined) return scalar
  const attempt = (multi: boolean): string => {
    const childPad = multi ? pad + s.unit : pad
    if (Array.isArray(v)) return s.arr(v.map((x, i) => render(s, ctx, x, childPad, `${path}[${i}]`, !multi)), multi, pad)
    const obj = v as JsonObject
    const keys = Object.keys(obj)
    return s.doc(keys.map((k) => [s.key(k), render(s, ctx, obj[k]!, childPad, `${path}.${k}`, !multi)]), multi, pad, keys)
  }
  const one = attempt(false)
  if (inline || fits(one)) return one
  return attempt(true)
}

function fits(text: string): boolean {
  return !text.includes('\n') && text.length <= WIDTH
}

/** A list built by hand (pipelines, sort pairs): one line when short, else one item per line. */
function fitList(items: (multi: boolean) => string[], join: (items: string[], multi: boolean) => string): string {
  const one = join(items(false), false)
  return fits(one) ? one : join(items(true), true)
}

/** Comma-separated entries, one per line at `inner`, closed at `pad`. */
function block(open: string, close: string, items: string[], pad: string, inner: string, trailingComma: boolean): string {
  return `${open}\n${items.map((x) => inner + x).join(',\n')}${trailingComma ? ',' : ''}\n${pad}${close}`
}

function noteLines(ctx: Ctx, comment: string, pad: string): string {
  return [...ctx.notes].map((n) => `${pad}${comment} Note: ${n}\n`).join('')
}

/**
 * Characters written as escapes in string literals: controls, C1 controls, line and paragraph
 * separators and the byte-order mark, which are invisible or end a line in some languages.
 */
function invisible(code: number): boolean {
  return code < 0x20 || (code >= 0x7f && code <= 0x9f) || code === 0x2028 || code === 0x2029 || code === 0xfeff
}

function newCtx(): Ctx {
  return { notes: new Set(), uses: new Set() }
}

function note(at: At, text: string): void {
  at.ctx.notes.add(`${at.path}: ${text}`)
}

type FindParts = { projection?: JsonObject; sort?: JsonObject; collation?: JsonObject; skip?: number; limit?: number }

function findParts(op: FindOperation): FindParts {
  const nonEmpty = (o?: JsonObject): JsonObject | undefined => (o && Object.keys(o).length ? o : undefined)
  return {
    projection: nonEmpty(op.projection),
    sort: nonEmpty(op.sort),
    collation: nonEmpty(op.collation),
    skip: op.skip || undefined,
    limit: op.limit || undefined
  }
}

function hasOptions(p: FindParts): boolean {
  return Boolean(p.projection || p.sort || p.collation || p.skip || p.limit)
}

// ---- Collation for the builder-style drivers (Java, C#) ----

type CollationOption = { name: string; value: string | number | boolean }

/** The collation's options in the server's order; unknown ones are reported as notes. */
function collationOptions(collation: JsonObject, ctx: Ctx, path: string): CollationOption[] {
  const out: CollationOption[] = []
  const known: Record<string, 'string' | 'number' | 'boolean'> = {
    locale: 'string',
    caseLevel: 'boolean',
    caseFirst: 'string',
    strength: 'number',
    numericOrdering: 'boolean',
    alternate: 'string',
    maxVariable: 'string',
    normalization: 'boolean',
    backwards: 'boolean'
  }
  for (const [name, raw] of Object.entries(collation)) {
    const t = bsonType(raw)
    const value =
      t === 'string' || t === 'bool'
        ? (raw as string | boolean)
        : t === 'int'
          ? Number(intText(raw))
          : t === 'long'
            ? Number(longText(raw))
            : t === 'double'
              ? doubleOf(raw)
              : undefined
    if (!(name in known) || value === undefined || typeof value !== known[name]) {
      ctx.notes.add(`${path}.${name}: this collation option is not supported here and was left out`)
      continue
    }
    out.push({ name, value })
  }
  return out
}

// ---- mongosh / Node.js ----

const JS_IDENT = /^[A-Za-z_$][A-Za-z0-9_$]*$/
const node: Syntax = {
  unit: '  ',
  str: shellString,
  // `__proto__: 1` would set the prototype instead of adding a field.
  key: (k) => (k === '__proto__' ? "['__proto__']" : JS_IDENT.test(k) ? k : shellString(k)),
  scalar(v, at) {
    const use = (name: string): void => void at.ctx.uses.add(name)
    const o = v as JsonObject
    switch (bsonType(v)) {
      case 'null':
        return 'null'
      case 'string':
        return shellString(v as string)
      case 'bool':
        return String(v)
      case 'int':
        return intText(v)
      case 'double': {
        const n = doubleOf(v)
        const k = doubleKind(n)
        if (k === 'nan') return 'NaN'
        if (k === 'inf') return 'Infinity'
        if (k === '-inf') return '-Infinity'
        // A whole number would be stored as Int32: Double keeps it a double.
        if (Number.isInteger(n)) return use('Double'), `new Double(${doubleText(n)})`
        return doubleText(n)
      }
      case 'long':
        return use('Long'), `Long.fromString(${shellString(longText(v))})`
      case 'decimal':
        return use('Decimal128'), `Decimal128.fromString(${shellString(String(o.$numberDecimal))})`
      case 'objectId':
        return use('ObjectId'), `new ObjectId(${shellString(String(o.$oid))})`
      case 'date': {
        const ms = dateMillis(o)
        return commonEra(ms) ? `new Date(${shellString(isoDate(ms))})` : `new Date(${ms})`
      }
      case 'regex': {
        const r = regexOf(o)
        use('BSONRegExp')
        return `new BSONRegExp(${shellString(r.pattern)}${r.options ? `, ${shellString(r.options)}` : ''})`
      }
      case 'uuid': {
        const uuid = uuidOf(o)
        if (uuid !== undefined) return use('UUID'), `new UUID(${shellString(uuid)})`
        const b = uuidAsBinary(o)
        return use('Binary'), `Binary.createFromBase64(${shellString(b.base64)}, ${b.subType})`
      }
      case 'binData': {
        const b = binaryOf(o)
        return use('Binary'), `Binary.createFromBase64(${shellString(b.base64)}, ${b.subType})`
      }
      case 'timestamp': {
        const ts = timestampOf(o)
        return use('Timestamp'), `new Timestamp({ t: ${ts.t}, i: ${ts.i} })`
      }
      case 'minKey':
        return use('MinKey'), 'new MinKey()'
      case 'maxKey':
        return use('MaxKey'), 'new MaxKey()'
      case 'javascript':
        use('Code')
        return isObject(o.$scope) ? `new Code(${shellString(String(o.$code))}, ${at.sub(o.$scope, `${at.path}.$scope`)})` : `new Code(${shellString(String(o.$code))})`
      case 'symbol':
        return use('BSONSymbol'), `new BSONSymbol(${shellString(String(o.$symbol))})`
      case 'undefined':
        note(at, 'the Node.js driver cannot write BSON undefined (it writes null), so null is used')
        return 'null'
      case 'dbPointer': {
        const p = dbPointerOf(o)
        note(at, 'the Node.js driver cannot write a BSON DBPointer; a { $ref, $id } document is written instead')
        return at.sub({ $ref: p.ns, $id: p.id }, at.path)
      }
      case 'truncated':
        return note(at, TRUNCATED), 'null'
      default:
        return undefined
    }
  },
  doc(entries, multi, pad) {
    const items = entries.map(([k, v]) => `${k}: ${v}`)
    if (!items.length) return '{}'
    return multi ? block('{', '}', items, pad, pad + '  ', false) : `{ ${items.join(', ')} }`
  },
  arr(items, multi, pad) {
    if (!items.length) return '[]'
    return multi ? block('[', ']', items, pad, pad + '  ', false) : `[${items.join(', ')}]`
  }
}

function nodeCode(op: Operation): string {
  const ctx = newCtx()
  const pad = '    '
  const r = (v: JsonValue, path: string, at = pad): string => render(node, ctx, v, at, path)
  let query: string
  if (op.kind === 'aggregate') {
    query = `${pad}const pipeline = ${r(op.pipeline, 'pipeline')};\n${pad}const cursor = collection.aggregate(pipeline);\n`
  } else {
    const p = findParts(op)
    query = `${pad}const filter = ${r(op.filter, 'filter')};\n`
    const opts: string[] = []
    const inner = pad + '  '
    if (p.projection) opts.push(`projection: ${r(p.projection, 'projection', inner)}`)
    if (p.sort) opts.push(`sort: ${r(p.sort, 'sort', inner)}`)
    if (p.collation) opts.push(`collation: ${r(p.collation, 'collation', inner)}`)
    if (p.skip) opts.push(`skip: ${p.skip}`)
    if (p.limit) opts.push(`limit: ${p.limit}`)
    query += opts.length ? `${pad}const cursor = collection.find(filter, ${block('{', '}', opts, pad, inner, false)});\n` : `${pad}const cursor = collection.find(filter);\n`
  }
  const names = ['MongoClient', ...ctx.uses].sort()
  return (
    `const { ${names.join(', ')} } = require('mongodb');\n\n` +
    `async function run() {\n` +
    `  const client = new MongoClient(${shellString(URI)});\n` +
    `  try {\n` +
    `    const collection = client.db(${shellString(op.db)}).collection(${shellString(op.collection)});\n\n` +
    noteLines(ctx, '//', pad) +
    query +
    `    for await (const doc of cursor) {\n` +
    `      console.log(doc);\n` +
    `    }\n` +
    `  } finally {\n` +
    `    await client.close();\n` +
    `  }\n` +
    `}\n\n` +
    `run().catch(console.error);\n`
  )
}

// ---- Python (PyMongo) ----

function pyStr(s: string): string {
  let out = '"'
  for (const ch of s) {
    const code = ch.codePointAt(0)!
    if (ch === '\\') out += '\\\\'
    else if (ch === '"') out += '\\"'
    else if (ch === '\n') out += '\\n'
    else if (ch === '\r') out += '\\r'
    else if (ch === '\t') out += '\\t'
    else if (invisible(code)) out += code <= 0xff ? `\\x${code.toString(16).padStart(2, '0')}` : `\\u${code.toString(16).padStart(4, '0')}`
    else out += ch
  }
  return `${out}"`
}

const python: Syntax = {
  unit: '    ',
  str: pyStr,
  key: pyStr,
  scalar(v, at) {
    const use = (module: string, name: string): void => void at.ctx.uses.add(`${module}|${name}`)
    const o = v as JsonObject
    switch (bsonType(v)) {
      case 'null':
        return 'None'
      case 'string':
        return pyStr(v as string)
      case 'bool':
        return v ? 'True' : 'False'
      case 'int':
        return intText(v)
      case 'double': {
        const n = doubleOf(v)
        const k = doubleKind(n)
        return k === 'nan' ? 'float("nan")' : k === 'inf' ? 'float("inf")' : k === '-inf' ? 'float("-inf")' : doubleText(n)
      }
      case 'long':
        return use('bson', 'Int64'), `Int64(${longText(v)})`
      case 'decimal':
        return use('bson', 'Decimal128'), `Decimal128(${pyStr(String(o.$numberDecimal))})`
      case 'objectId':
        return use('bson', 'ObjectId'), `ObjectId(${pyStr(String(o.$oid))})`
      case 'date': {
        const ms = dateMillis(o)
        if (!commonEra(ms)) return use('bson.datetime_ms', 'DatetimeMS'), `DatetimeMS(${ms})`
        const d = dateParts(ms)
        use('datetime', 'datetime')
        use('datetime', 'timezone')
        return `datetime(${d.y}, ${d.mo}, ${d.d}, ${d.h}, ${d.mi}, ${d.s}${d.ms ? `, ${d.ms * 1000}` : ''}, tzinfo=timezone.utc)`
      }
      case 'regex': {
        const r = regexOf(o)
        return use('bson', 'Regex'), `Regex(${pyStr(r.pattern)}${r.options ? `, ${pyStr(r.options)}` : ''})`
      }
      case 'uuid': {
        const uuid = uuidOf(o)
        use('bson', 'Binary')
        if (uuid !== undefined) return use('uuid', 'UUID'), `Binary.from_uuid(UUID(${pyStr(uuid)}))`
        const b = uuidAsBinary(o)
        return use('base64', 'b64decode'), `Binary(b64decode(${pyStr(b.base64)}), ${b.subType})`
      }
      case 'binData': {
        const b = binaryOf(o)
        use('bson', 'Binary')
        return use('base64', 'b64decode'), `Binary(b64decode(${pyStr(b.base64)}), ${b.subType})`
      }
      case 'timestamp': {
        const ts = timestampOf(o)
        return use('bson', 'Timestamp'), `Timestamp(${ts.t}, ${ts.i})`
      }
      case 'minKey':
        return use('bson', 'MinKey'), 'MinKey()'
      case 'maxKey':
        return use('bson', 'MaxKey'), 'MaxKey()'
      case 'javascript':
        use('bson', 'Code')
        return isObject(o.$scope) ? `Code(${pyStr(String(o.$code))}, ${at.sub(o.$scope, `${at.path}.$scope`)})` : `Code(${pyStr(String(o.$code))})`
      case 'symbol':
        note(at, 'PyMongo cannot write a BSON symbol, so a string is used')
        return pyStr(String(o.$symbol))
      case 'undefined':
        note(at, 'PyMongo cannot write BSON undefined, so None (null) is used')
        return 'None'
      case 'dbPointer': {
        const p = dbPointerOf(o)
        note(at, 'PyMongo cannot write a BSON DBPointer; a { $ref, $id } document is written instead')
        return at.sub({ $ref: p.ns, $id: p.id }, at.path)
      }
      case 'truncated':
        return note(at, TRUNCATED), 'None'
      default:
        return undefined
    }
  },
  doc(entries, multi, pad) {
    const items = entries.map(([k, v]) => `${k}: ${v}`)
    if (!items.length) return '{}'
    return multi ? block('{', '}', items, pad, pad + '    ', true) : `{${items.join(', ')}}`
  },
  arr(items, multi, pad) {
    if (!items.length) return '[]'
    return multi ? block('[', ']', items, pad, pad + '    ', true) : `[${items.join(', ')}]`
  }
}

const PY_STDLIB = new Set(['base64', 'datetime', 'uuid'])

function pythonImports(uses: Set<string>): string {
  const byModule = new Map<string, Set<string>>()
  for (const u of [...uses, 'pymongo|MongoClient']) {
    const [module, name] = u.split('|') as [string, string]
    if (!byModule.has(module)) byModule.set(module, new Set())
    byModule.get(module)!.add(name)
  }
  const line = (m: string): string => `from ${m} import ${[...byModule.get(m)!].sort().join(', ')}\n`
  const modules = [...byModule.keys()].sort()
  const std = modules.filter((m) => PY_STDLIB.has(m)).map(line).join('')
  const third = modules.filter((m) => !PY_STDLIB.has(m)).map(line).join('')
  return std ? `${std}\n${third}` : third
}

function pythonCode(op: Operation): string {
  const ctx = newCtx()
  const r = (v: JsonValue, path: string, pad = ''): string => render(python, ctx, v, pad, path)
  let query: string
  if (op.kind === 'aggregate') {
    query = `pipeline = ${r(op.pipeline, 'pipeline')}\n\ncursor = collection.aggregate(pipeline)\n`
  } else {
    const p = findParts(op)
    query = `query = ${r(op.filter, 'query')}\n\n`
    const args: string[] = ['query']
    const inner = '    '
    if (p.projection) args.push(`projection=${r(p.projection, 'projection', inner)}`)
    if (p.sort) {
      // PyMongo takes the sort as (key, direction) pairs.
      const sort = p.sort
      const pairs = fitList(
        (multi) => Object.entries(sort).map(([k, v]) => `(${pyStr(k)}, ${render(python, ctx, v, multi ? inner + '    ' : inner, `sort.${k}`, !multi)})`),
        (items, multi) => (multi ? block('[', ']', items, inner, inner + '    ', true) : `[${items.join(', ')}]`)
      )
      args.push(`sort=${pairs}`)
    }
    if (p.collation) args.push(`collation=${r(p.collation, 'collation', inner)}`)
    if (p.skip) args.push(`skip=${p.skip}`)
    if (p.limit) args.push(`limit=${p.limit}`)
    query += args.length > 1 ? `cursor = collection.find${block('(', ')', args, '', inner, true)}\n` : 'cursor = collection.find(query)\n'
  }
  return (
    pythonImports(ctx.uses) +
    `\nclient = MongoClient(${pyStr(URI)})\n` +
    `collection = client[${pyStr(op.db)}][${pyStr(op.collection)}]\n\n` +
    noteLines(ctx, '#', '') +
    query +
    `for doc in cursor:\n` +
    `    print(doc)\n`
  )
}

// ---- Java (sync driver) ----

function javaStr(s: string): string {
  let out = '"'
  for (let i = 0; i < s.length; i++) {
    const ch = s[i]!
    const code = s.charCodeAt(i)
    if (ch === '\\') out += '\\\\'
    else if (ch === '"') out += '\\"'
    else if (ch === '\n') out += '\\n'
    else if (ch === '\r') out += '\\r'
    else if (ch === '\t') out += '\\t'
    // Octal, not \u: Java reads \u escapes before strings, so \u000a would end the line.
    else if (code < 0x20 || code === 0x7f) out += `\\${code.toString(8).padStart(3, '0')}`
    // Non-ASCII as \u escapes, so the source compiles the same whatever the file encoding.
    else if (code > 0x7e) out += `\\u${code.toString(16).padStart(4, '0')}`
    else out += ch
  }
  return `${out}"`
}

const JAVA_SUBTYPES: Record<number, string> = {
  0: 'BINARY',
  1: 'FUNCTION',
  2: 'OLD_BINARY',
  3: 'UUID_LEGACY',
  4: 'UUID_STANDARD',
  5: 'MD5',
  6: 'ENCRYPTED',
  7: 'COLUMN',
  128: 'USER_DEFINED'
}

const java: Syntax = {
  unit: '    ',
  str: javaStr,
  key: javaStr,
  scalar(v, at) {
    const use = (cls: string): void => void at.ctx.uses.add(cls)
    const o = v as JsonObject
    switch (bsonType(v)) {
      case 'null':
        return 'null'
      case 'string':
        return javaStr(v as string)
      case 'bool':
        return String(v)
      case 'int':
        return intText(v)
      case 'double': {
        const n = doubleOf(v)
        const k = doubleKind(n)
        return k === 'nan' ? 'Double.NaN' : k === 'inf' ? 'Double.POSITIVE_INFINITY' : k === '-inf' ? 'Double.NEGATIVE_INFINITY' : doubleText(n)
      }
      case 'long':
        return `${longText(v)}L`
      case 'decimal':
        return use('org.bson.types.Decimal128'), `Decimal128.parse(${javaStr(String(o.$numberDecimal))})`
      case 'objectId':
        return use('org.bson.types.ObjectId'), `new ObjectId(${javaStr(String(o.$oid))})`
      case 'date': {
        const ms = dateMillis(o)
        use('java.util.Date')
        if (!commonEra(ms)) return `new Date(${ms}L)`
        return use('java.time.Instant'), `Date.from(Instant.parse(${javaStr(isoDate(ms))}))`
      }
      case 'regex': {
        const r = regexOf(o)
        use('org.bson.BsonRegularExpression')
        return `new BsonRegularExpression(${javaStr(r.pattern)}${r.options ? `, ${javaStr(r.options)}` : ''})`
      }
      case 'uuid': {
        const uuid = uuidOf(o)
        if (uuid !== undefined) {
          use('org.bson.BsonBinary')
          return use('java.util.UUID'), `new BsonBinary(UUID.fromString(${javaStr(uuid)}))`
        }
        return javaBinary(uuidAsBinary(o), use)
      }
      case 'binData':
        return javaBinary(binaryOf(o), use)
      case 'timestamp': {
        const ts = timestampOf(o)
        use('org.bson.BsonTimestamp')
        return timestampFitsInts(ts) ? `new BsonTimestamp(${ts.t}, ${ts.i})` : `new BsonTimestamp(${timestampLong(ts)}L)`
      }
      case 'minKey':
        return use('org.bson.types.MinKey'), 'new MinKey()'
      case 'maxKey':
        return use('org.bson.types.MaxKey'), 'new MaxKey()'
      case 'javascript':
        if (isObject(o.$scope)) return use('org.bson.types.CodeWithScope'), `new CodeWithScope(${javaStr(String(o.$code))}, ${at.sub(o.$scope, `${at.path}.$scope`)})`
        return use('org.bson.types.Code'), `new Code(${javaStr(String(o.$code))})`
      case 'symbol':
        return use('org.bson.types.Symbol'), `new Symbol(${javaStr(String(o.$symbol))})`
      case 'undefined':
        return use('org.bson.BsonUndefined'), 'new BsonUndefined()'
      case 'dbPointer': {
        const p = dbPointerOf(o)
        use('org.bson.BsonDbPointer')
        return `new BsonDbPointer(${javaStr(p.ns)}, ${at.sub(p.id, `${at.path}.$id`)})`
      }
      case 'truncated':
        return note(at, TRUNCATED), 'null'
      default:
        return undefined
    }
  },
  doc(entries, multi, pad) {
    if (!entries.length) return 'new Document()'
    if (multi) return `new Document()${entries.map(([k, v]) => `\n${pad}    .append(${k}, ${v})`).join('')}`
    const [[k0, v0], ...rest] = entries as [[string, string], ...[string, string][]]
    return `new Document(${k0}, ${v0})${rest.map(([k, v]) => `.append(${k}, ${v})`).join('')}`
  },
  arr(items, multi, pad) {
    // A lone null would be taken as the varargs array itself.
    const list = items.length === 1 && items[0] === 'null' ? ['(Object) null'] : items
    if (multi) return `Arrays.asList(\n${list.map((x) => pad + '    ' + x).join(',\n')})`
    return `Arrays.asList(${list.join(', ')})`
  }
}

function javaBinary(b: Bin, use: (cls: string) => void): string {
  use('org.bson.types.Binary')
  use('java.util.Base64')
  const named = JAVA_SUBTYPES[b.subType]
  if (named) use('org.bson.BsonBinarySubType')
  const subtype = named ? `BsonBinarySubType.${named}` : `(byte) ${hex2(b.subType)}`
  return `new Binary(${subtype}, Base64.getDecoder().decode(${javaStr(b.base64)}))`
}

const JAVA_COLLATION: Record<string, (v: string | number | boolean, use: (c: string) => void) => string | undefined> = {
  locale: (v) => `.locale(${javaStr(String(v))})`,
  caseLevel: (v) => `.caseLevel(${String(v)})`,
  caseFirst: (v, use) => {
    const e = ({ upper: 'UPPER', lower: 'LOWER', off: 'OFF' } as Record<string, string>)[String(v)]
    return e && (use('com.mongodb.client.model.CollationCaseFirst'), `.collationCaseFirst(CollationCaseFirst.${e})`)
  },
  strength: (v, use) => {
    const e = ['PRIMARY', 'SECONDARY', 'TERTIARY', 'QUATERNARY', 'IDENTICAL'][Number(v) - 1]
    return e && (use('com.mongodb.client.model.CollationStrength'), `.collationStrength(CollationStrength.${e})`)
  },
  numericOrdering: (v) => `.numericOrdering(${String(v)})`,
  alternate: (v, use) => {
    const e = ({ 'non-ignorable': 'NON_IGNORABLE', shifted: 'SHIFTED' } as Record<string, string>)[String(v)]
    return e && (use('com.mongodb.client.model.CollationAlternate'), `.collationAlternate(CollationAlternate.${e})`)
  },
  maxVariable: (v, use) => {
    const e = ({ punct: 'PUNCT', space: 'SPACE' } as Record<string, string>)[String(v)]
    return e && (use('com.mongodb.client.model.CollationMaxVariable'), `.collationMaxVariable(CollationMaxVariable.${e})`)
  },
  normalization: (v) => `.normalization(${String(v)})`,
  backwards: (v) => `.backwards(${String(v)})`
}

function javaCode(op: Operation): string {
  const ctx = newCtx()
  const use = (c: string): void => void ctx.uses.add(c)
  const pad = '            '
  const inner = pad + '    '
  const r = (v: JsonValue, path: string, at = pad): string => render(java, ctx, v, at, path)
  let query: string
  if (op.kind === 'aggregate') {
    use('java.util.List')
    use('com.mongodb.client.AggregateIterable')
    query = `${pad}List<Document> pipeline = ${r(op.pipeline, 'pipeline')};\n${pad}AggregateIterable<Document> results = collection.aggregate(pipeline);\n`
  } else {
    const p = findParts(op)
    use('com.mongodb.client.FindIterable')
    query = `${pad}Document filter = ${r(op.filter, 'filter')};\n${pad}FindIterable<Document> results = collection.find(filter)`
    if (p.projection) query += `\n${inner}.projection(${r(p.projection, 'projection', inner)})`
    if (p.sort) query += `\n${inner}.sort(${r(p.sort, 'sort', inner)})`
    if (p.collation) {
      use('com.mongodb.client.model.Collation')
      const calls = collationOptions(p.collation, ctx, 'collation').flatMap((c) => {
        const call = JAVA_COLLATION[c.name]!(c.value, use)
        if (call === undefined) ctx.notes.add(`collation.${c.name}: the value ${JSON.stringify(c.value)} is not a known option and was left out`)
        return call === undefined ? [] : [call]
      })
      query += `\n${inner}.collation(Collation.builder()${[...calls, '.build()'].map((c) => `\n${inner}    ${c}`).join('')})`
    }
    if (p.skip) query += `\n${inner}.skip(${p.skip})`
    if (p.limit) query += `\n${inner}.limit(${p.limit})`
    query += ';\n'
  }
  if (query.includes('Arrays.asList(')) use('java.util.Arrays')
  const imports = [...ctx.uses, 'com.mongodb.client.MongoClient', 'com.mongodb.client.MongoClients', 'com.mongodb.client.MongoCollection', 'org.bson.Document'].sort()
  return (
    imports.map((c) => `import ${c};\n`).join('') +
    `\npublic class Main {\n` +
    `    public static void main(String[] args) {\n` +
    `        try (MongoClient client = MongoClients.create(${javaStr(URI)})) {\n` +
    `            MongoCollection<Document> collection = client.getDatabase(${javaStr(op.db)}).getCollection(${javaStr(op.collection)});\n\n` +
    noteLines(ctx, '//', pad) +
    query +
    `            for (Document doc : results) {\n` +
    `                System.out.println(doc.toJson());\n` +
    `            }\n` +
    `        }\n` +
    `    }\n` +
    `}\n`
  )
}

// ---- C# (MongoDB.Driver) ----

function csStr(s: string): string {
  let out = '"'
  for (const ch of s) {
    const code = ch.codePointAt(0)!
    if (ch === '\\') out += '\\\\'
    else if (ch === '"') out += '\\"'
    else if (ch === '\n') out += '\\n'
    else if (ch === '\r') out += '\\r'
    else if (ch === '\t') out += '\\t'
    // C# also ends a line at U+0085, U+2028 and U+2029.
    else if (invisible(code)) out += `\\u${code.toString(16).padStart(4, '0')}`
    else out += ch
  }
  return `${out}"`
}

const CS_SUBTYPES: Record<number, string> = {
  0: 'Binary',
  1: 'Function',
  2: 'OldBinary',
  3: 'UuidLegacy',
  4: 'UuidStandard',
  5: 'MD5',
  6: 'Encrypted',
  7: 'Column',
  128: 'UserDefined'
}

const csharp: Syntax = {
  unit: '    ',
  str: csStr,
  key: csStr,
  scalar(v, at) {
    const o = v as JsonObject
    switch (bsonType(v)) {
      case 'null':
        return 'BsonNull.Value'
      case 'string':
        return csStr(v as string)
      case 'bool':
        return String(v)
      case 'int':
        return intText(v)
      case 'double': {
        const n = doubleOf(v)
        const k = doubleKind(n)
        return k === 'nan' ? 'double.NaN' : k === 'inf' ? 'double.PositiveInfinity' : k === '-inf' ? 'double.NegativeInfinity' : doubleText(n)
      }
      case 'long':
        return `${longText(v)}L`
      case 'decimal':
        return `Decimal128.Parse(${csStr(String(o.$numberDecimal))})`
      case 'objectId':
        return `new ObjectId(${csStr(String(o.$oid))})`
      case 'date': {
        const ms = dateMillis(o)
        if (!commonEra(ms)) return `new BsonDateTime(${ms})`
        const d = dateParts(ms)
        return `new DateTime(${d.y}, ${d.mo}, ${d.d}, ${d.h}, ${d.mi}, ${d.s}${d.ms ? `, ${d.ms}` : ''}, DateTimeKind.Utc)`
      }
      case 'regex': {
        const r = regexOf(o)
        return `new BsonRegularExpression(${csStr(r.pattern)}${r.options ? `, ${csStr(r.options)}` : ''})`
      }
      case 'uuid': {
        const uuid = uuidOf(o)
        if (uuid !== undefined) return `new BsonBinaryData(Guid.Parse(${csStr(uuid)}), GuidRepresentation.Standard)`
        return csBinary(uuidAsBinary(o))
      }
      case 'binData':
        return csBinary(binaryOf(o))
      case 'timestamp': {
        const ts = timestampOf(o)
        return timestampFitsInts(ts) ? `new BsonTimestamp(${ts.t}, ${ts.i})` : `new BsonTimestamp(${timestampLong(ts)}L)`
      }
      case 'minKey':
        return 'BsonMinKey.Value'
      case 'maxKey':
        return 'BsonMaxKey.Value'
      case 'javascript':
        if (isObject(o.$scope)) return `new BsonJavaScriptWithScope(${csStr(String(o.$code))}, ${at.sub(o.$scope, `${at.path}.$scope`)})`
        return `new BsonJavaScript(${csStr(String(o.$code))})`
      case 'symbol':
        return `BsonSymbolTable.Lookup(${csStr(String(o.$symbol))})`
      case 'undefined':
        return 'BsonUndefined.Value'
      case 'dbPointer': {
        const p = dbPointerOf(o)
        note(at, 'the .NET driver cannot write a BSON DBPointer; a { $ref, $id } document is written instead')
        return at.sub({ $ref: p.ns, $id: p.id }, at.path)
      }
      case 'truncated':
        return note(at, TRUNCATED), 'BsonNull.Value'
      default:
        return undefined
    }
  },
  doc(entries, multi, pad) {
    if (!entries.length) return 'new BsonDocument()'
    const items = entries.map(([k, v]) => `{ ${k}, ${v} }`)
    if (multi) return `new BsonDocument\n${pad}${block('{', '}', items, pad, pad + '    ', false)}`
    if (entries.length === 1) return `new BsonDocument(${entries[0]![0]}, ${entries[0]![1]})`
    return `new BsonDocument { ${items.join(', ')} }`
  },
  arr(items, multi, pad) {
    if (!items.length) return 'new BsonArray()'
    if (multi) return `new BsonArray\n${pad}${block('{', '}', items, pad, pad + '    ', false)}`
    return `new BsonArray { ${items.join(', ')} }`
  }
}

function csBinary(b: Bin): string {
  const named = CS_SUBTYPES[b.subType]
  return `new BsonBinaryData(Convert.FromBase64String(${csStr(b.base64)}), ${named ? `BsonBinarySubType.${named}` : `(BsonBinarySubType)${hex2(b.subType)}`})`
}

const CS_COLLATION: Record<string, (v: string | number | boolean) => string | undefined> = {
  caseLevel: (v) => String(v),
  caseFirst: (v) => {
    const e = ({ upper: 'Upper', lower: 'Lower', off: 'Off' } as Record<string, string>)[String(v)]
    return e && `CollationCaseFirst.${e}`
  },
  strength: (v) => {
    const e = ['Primary', 'Secondary', 'Tertiary', 'Quaternary', 'Identical'][Number(v) - 1]
    return e && `CollationStrength.${e}`
  },
  numericOrdering: (v) => String(v),
  alternate: (v) => {
    const e = ({ 'non-ignorable': 'NonIgnorable', shifted: 'Shifted' } as Record<string, string>)[String(v)]
    return e && `CollationAlternate.${e}`
  },
  maxVariable: (v) => {
    const e = ({ punct: 'Punctuation', space: 'Space' } as Record<string, string>)[String(v)]
    return e && `CollationMaxVariable.${e}`
  },
  normalization: (v) => String(v),
  backwards: (v) => String(v)
}
const CS_COLLATION_ORDER = ['caseLevel', 'caseFirst', 'strength', 'numericOrdering', 'alternate', 'maxVariable', 'normalization', 'backwards']

function csCollation(collation: JsonObject, ctx: Ctx): string {
  const opts = collationOptions(collation, ctx, 'collation')
  const locale = opts.find((o) => o.name === 'locale')
  if (!locale) ctx.notes.add('collation: a collation needs a locale; "simple" is used')
  const args = [csStr(locale ? String(locale.value) : 'simple')]
  for (const name of CS_COLLATION_ORDER) {
    const opt = opts.find((o) => o.name === name)
    if (!opt) continue
    const value = CS_COLLATION[name]!(opt.value)
    if (value === undefined) ctx.notes.add(`collation.${name}: the value ${JSON.stringify(opt.value)} is not a known option and was left out`)
    else args.push(`${name}: ${value}`)
  }
  const one = `new Collation(${args.join(', ')})`
  return fits(one) ? one : `new Collation(\n${args.map((a) => `        ${a}`).join(',\n')})`
}

function csharpCode(op: Operation): string {
  const ctx = newCtx()
  const r = (v: JsonValue, path: string, pad = ''): string => render(csharp, ctx, v, pad, path)
  let query: string
  if (op.kind === 'aggregate') {
    const pipeline = op.pipeline
    const stages = fitList(
      (multi) => pipeline.map((s, i) => render(csharp, ctx, s, multi ? '    ' : '', `pipeline[${i}]`, !multi)),
      (items, multi) => (!items.length ? 'Array.Empty<BsonDocument>()' : multi ? `new BsonDocument[]\n${block('{', '}', items, '', '    ', false)}` : `new BsonDocument[] { ${items.join(', ')} }`)
    )
    query = `var pipeline = ${stages};\n\nvar results = collection.Aggregate<BsonDocument>(pipeline);\n`
  } else {
    const p = findParts(op)
    query = `var filter = ${r(op.filter, 'filter')};\n\n`
    if (p.collation) query += `var options = new FindOptions\n{\n    Collation = ${csCollation(p.collation, ctx)}\n};\n`
    query += `var results = collection.Find(filter${p.collation ? ', options' : ''})`
    if (p.projection) query += `\n    .Project(${r(p.projection, 'projection', '    ')})`
    if (p.sort) query += `\n    .Sort(${r(p.sort, 'sort', '    ')})`
    if (p.skip) query += `\n    .Skip(${p.skip})`
    if (p.limit) query += `\n    .Limit(${p.limit})`
    query += ';\n'
  }
  return (
    `using System;\nusing MongoDB.Bson;\nusing MongoDB.Driver;\n\n` +
    `var client = new MongoClient(${csStr(URI)});\n` +
    `var collection = client.GetDatabase(${csStr(op.db)}).GetCollection<BsonDocument>(${csStr(op.collection)});\n\n` +
    noteLines(ctx, '//', '') +
    query +
    `\nforeach (var doc in results.ToEnumerable())\n` +
    `{\n` +
    `    Console.WriteLine(doc);\n` +
    `}\n`
  )
}

// ---- PHP (mongodb/mongodb) ----

function needsDoubleQuotes(s: string): boolean {
  for (const ch of s) if (invisible(ch.codePointAt(0)!)) return true
  return false
}

function phpStr(s: string): string {
  if (!needsDoubleQuotes(s)) return `'${s.replace(/[\\']/g, (c) => `\\${c}`)}'`
  let out = '"'
  for (const ch of s) {
    const code = ch.codePointAt(0)!
    if (ch === '\\' || ch === '"' || ch === '$') out += `\\${ch}`
    else if (ch === '\n') out += '\\n'
    else if (ch === '\r') out += '\\r'
    else if (ch === '\t') out += '\\t'
    // \x writes a raw byte, so past ASCII the code point form is needed.
    else if (invisible(code)) out += code < 0x80 ? `\\x${code.toString(16).padStart(2, '0')}` : `\\u{${code.toString(16)}}`
    else out += ch
  }
  return `${out}"`
}

const PHP_SUBTYPES: Record<number, string> = {
  0: 'TYPE_GENERIC',
  1: 'TYPE_FUNCTION',
  2: 'TYPE_OLD_BINARY',
  3: 'TYPE_OLD_UUID',
  4: 'TYPE_UUID',
  5: 'TYPE_MD5',
  6: 'TYPE_ENCRYPTED',
  7: 'TYPE_COLUMN',
  128: 'TYPE_USER_DEFINED'
}

const php: Syntax = {
  unit: '    ',
  str: phpStr,
  key: phpStr,
  scalar(v, at) {
    const use = (cls: string): void => void at.ctx.uses.add(`MongoDB\\BSON\\${cls}`)
    const o = v as JsonObject
    switch (bsonType(v)) {
      case 'null':
        return 'null'
      case 'string':
        return phpStr(v as string)
      case 'bool':
        return String(v)
      case 'int':
        return intText(v)
      case 'double': {
        const n = doubleOf(v)
        const k = doubleKind(n)
        return k === 'nan' ? 'NAN' : k === 'inf' ? 'INF' : k === '-inf' ? '-INF' : doubleText(n)
      }
      case 'long':
        // A string, since PHP reads -9223372036854775808 as a float.
        return use('Int64'), `new Int64(${phpStr(longText(v))})`
      case 'decimal':
        return use('Decimal128'), `new Decimal128(${phpStr(String(o.$numberDecimal))})`
      case 'objectId':
        return use('ObjectId'), `new ObjectId(${phpStr(String(o.$oid))})`
      case 'date': {
        const ms = dateMillis(o)
        use('UTCDateTime')
        return commonEra(ms) ? `new UTCDateTime(new DateTimeImmutable(${phpStr(isoDate(ms))}))` : `new UTCDateTime(${ms})`
      }
      case 'regex': {
        const r = regexOf(o)
        return use('Regex'), `new Regex(${phpStr(r.pattern)}${r.options ? `, ${phpStr(r.options)}` : ''})`
      }
      case 'uuid': {
        const uuid = uuidOf(o)
        if (uuid !== undefined) return use('Binary'), `new Binary(hex2bin(${phpStr(hexOfUuid(uuid))}), Binary::TYPE_UUID)`
        return phpBinary(uuidAsBinary(o), use)
      }
      case 'binData':
        return phpBinary(binaryOf(o), use)
      case 'timestamp': {
        // Named, since the constructor takes the increment first.
        const ts = timestampOf(o)
        return use('Timestamp'), `new Timestamp(increment: ${ts.i}, timestamp: ${ts.t})`
      }
      case 'minKey':
        return use('MinKey'), 'new MinKey()'
      case 'maxKey':
        return use('MaxKey'), 'new MaxKey()'
      case 'javascript':
        use('Javascript')
        return isObject(o.$scope) ? `new Javascript(${phpStr(String(o.$code))}, ${at.sub(o.$scope, `${at.path}.$scope`)})` : `new Javascript(${phpStr(String(o.$code))})`
      case 'symbol':
        note(at, 'the PHP driver cannot write a BSON symbol, so a string is used')
        return phpStr(String(o.$symbol))
      case 'undefined':
        note(at, 'the PHP driver cannot write BSON undefined, so null is used')
        return 'null'
      case 'dbPointer': {
        const p = dbPointerOf(o)
        note(at, 'the PHP driver cannot write a BSON DBPointer; a { $ref, $id } document is written instead')
        return at.sub({ $ref: p.ns, $id: p.id }, at.path)
      }
      case 'truncated':
        return note(at, TRUNCATED), 'null'
      default:
        return undefined
    }
  },
  doc(entries, multi, pad, keys) {
    // An empty array, or one keyed 0, 1, 2..., would be written as a BSON array.
    const cast = keys.every((k, i) => k === String(i)) ? '(object) ' : ''
    const items = entries.map(([k, v]) => `${k} => ${v}`)
    if (!items.length) return `${cast}[]`
    return cast + (multi ? block('[', ']', items, pad, pad + '    ', true) : `[${items.join(', ')}]`)
  },
  arr(items, multi, pad) {
    if (!items.length) return '[]'
    return multi ? block('[', ']', items, pad, pad + '    ', true) : `[${items.join(', ')}]`
  }
}

function phpBinary(b: Bin, use: (cls: string) => void): string {
  use('Binary')
  const named = PHP_SUBTYPES[b.subType]
  return `new Binary(base64_decode(${phpStr(b.base64)}), ${named ? `Binary::${named}` : String(b.subType)})`
}

function phpCode(op: Operation): string {
  const ctx = newCtx()
  const r = (v: JsonValue, path: string, pad = ''): string => render(php, ctx, v, pad, path)
  let query: string
  if (op.kind === 'aggregate') {
    query = `$pipeline = ${r(op.pipeline, 'pipeline')};\n\n$cursor = $collection->aggregate($pipeline);\n`
  } else {
    const p = findParts(op)
    // An empty filter is a document at the top level, so the plain [] is fine there.
    query = `$filter = ${Object.keys(op.filter).length ? r(op.filter, 'filter') : '[]'};\n\n`
    const opts: string[] = []
    const inner = '    '
    if (p.projection) opts.push(`'projection' => ${r(p.projection, 'projection', inner)}`)
    if (p.sort) opts.push(`'sort' => ${r(p.sort, 'sort', inner)}`)
    if (p.collation) opts.push(`'collation' => ${r(p.collation, 'collation', inner)}`)
    if (p.skip) opts.push(`'skip' => ${p.skip}`)
    if (p.limit) opts.push(`'limit' => ${p.limit}`)
    query += opts.length ? `$cursor = $collection->find($filter, ${block('[', ']', opts, '', inner, true)});\n` : '$cursor = $collection->find($filter);\n'
  }
  const uses = [...ctx.uses, 'MongoDB\\Client'].sort()
  return (
    `<?php\n\n` +
    `require 'vendor/autoload.php';\n\n` +
    uses.map((u) => `use ${u};\n`).join('') +
    `\n$client = new Client(${phpStr(URI)});\n` +
    `$collection = $client->selectCollection(${phpStr(op.db)}, ${phpStr(op.collection)});\n\n` +
    noteLines(ctx, '//', '') +
    query +
    `\nforeach ($cursor as $document) {\n` +
    `    echo json_encode($document), PHP_EOL;\n` +
    `}\n`
  )
}

// ---- Ruby (mongo gem) ----

function rubyStr(s: string): string {
  if (!needsDoubleQuotes(s)) return `'${s.replace(/[\\']/g, (c) => `\\${c}`)}'`
  let out = '"'
  for (const ch of s) {
    const code = ch.codePointAt(0)!
    if (ch === '\\' || ch === '"' || ch === '#') out += `\\${ch}`
    else if (ch === '\n') out += '\\n'
    else if (ch === '\r') out += '\\r'
    else if (ch === '\t') out += '\\t'
    else if (invisible(code)) out += `\\u${code.toString(16).padStart(4, '0')}`
    else out += ch
  }
  return `${out}"`
}

const RUBY_SUBTYPES: Record<number, string> = {
  0: ':generic',
  1: ':function',
  2: ':old',
  3: ':uuid_old',
  4: ':uuid',
  5: ':md5',
  6: ':ciphertext',
  7: ':column',
  128: ':user'
}

const ruby: Syntax = {
  unit: '  ',
  str: rubyStr,
  key: rubyStr,
  scalar(v, at) {
    const o = v as JsonObject
    switch (bsonType(v)) {
      case 'null':
        return 'nil'
      case 'string':
        return rubyStr(v as string)
      case 'bool':
        return String(v)
      case 'int':
        return intText(v)
      case 'double': {
        const n = doubleOf(v)
        const k = doubleKind(n)
        return k === 'nan' ? 'Float::NAN' : k === 'inf' ? 'Float::INFINITY' : k === '-inf' ? '-Float::INFINITY' : doubleText(n)
      }
      case 'long':
        return `BSON::Int64.new(${longText(v)})`
      case 'decimal':
        return `BSON::Decimal128.new(${rubyStr(String(o.$numberDecimal))})`
      case 'objectId':
        return `BSON::ObjectId.from_string(${rubyStr(String(o.$oid))})`
      case 'date': {
        const d = dateParts(dateMillis(o))
        return `Time.utc(${d.y}, ${d.mo}, ${d.d}, ${d.h}, ${d.mi}, ${d.s}${d.ms ? `, ${d.ms * 1000}` : ''})`
      }
      case 'regex': {
        const r = regexOf(o)
        return `BSON::Regexp::Raw.new(${rubyStr(r.pattern)}${r.options ? `, ${rubyStr(r.options)}` : ''})`
      }
      case 'uuid': {
        const uuid = uuidOf(o)
        if (uuid !== undefined) return `BSON::Binary.from_uuid(${rubyStr(uuid)})`
        return rubyBinary(uuidAsBinary(o))
      }
      case 'binData':
        return rubyBinary(binaryOf(o))
      case 'timestamp': {
        const ts = timestampOf(o)
        return `BSON::Timestamp.new(${ts.t}, ${ts.i})`
      }
      case 'minKey':
        return 'BSON::MinKey.new'
      case 'maxKey':
        return 'BSON::MaxKey.new'
      case 'javascript':
        if (isObject(o.$scope)) return `BSON::CodeWithScope.new(${rubyStr(String(o.$code))}, ${at.sub(o.$scope, `${at.path}.$scope`)})`
        return `BSON::Code.new(${rubyStr(String(o.$code))})`
      case 'symbol':
        // A Ruby Symbol is written as a BSON string; Raw keeps the symbol type.
        return `BSON::Symbol::Raw.new(${rubyStr(String(o.$symbol))})`
      case 'undefined':
        return 'BSON::Undefined.new'
      case 'dbPointer': {
        const p = dbPointerOf(o)
        return `BSON::DbPointer.new(${rubyStr(p.ns)}, ${at.sub(p.id, `${at.path}.$id`)})`
      }
      case 'truncated':
        return note(at, TRUNCATED), 'nil'
      default:
        return undefined
    }
  },
  doc(entries, multi, pad) {
    const items = entries.map(([k, v]) => `${k} => ${v}`)
    if (!items.length) return '{}'
    return multi ? block('{', '}', items, pad, pad + '  ', false) : `{ ${items.join(', ')} }`
  },
  arr(items, multi, pad) {
    if (!items.length) return '[]'
    return multi ? block('[', ']', items, pad, pad + '  ', false) : `[${items.join(', ')}]`
  }
}

function rubyBinary(b: Bin): string {
  return `BSON::Binary.new(${rubyStr(b.base64)}.unpack1('m'), ${RUBY_SUBTYPES[b.subType] ?? hex2(b.subType)})`
}

function rubyCode(op: Operation): string {
  const ctx = newCtx()
  const r = (v: JsonValue, path: string, pad = ''): string => render(ruby, ctx, v, pad, path)
  let query: string
  if (op.kind === 'aggregate') {
    query = `pipeline = ${r(op.pipeline, 'pipeline')}\n\ncursor = collection.aggregate(pipeline)\n`
  } else {
    const p = findParts(op)
    query = `filter = ${r(op.filter, 'filter')}\n\n`
    const args = ['filter']
    const inner = '  '
    if (p.projection) args.push(`projection: ${r(p.projection, 'projection', inner)}`)
    if (p.sort) args.push(`sort: ${r(p.sort, 'sort', inner)}`)
    if (p.collation) args.push(`collation: ${r(p.collation, 'collation', inner)}`)
    if (p.skip) args.push(`skip: ${p.skip}`)
    if (p.limit) args.push(`limit: ${p.limit}`)
    query += args.length > 1 ? `cursor = collection.find${block('(', ')', args, '', inner, false)}\n` : 'cursor = collection.find(filter)\n'
  }
  return (
    `require 'mongo'\n\n` +
    `client = Mongo::Client.new(${rubyStr(URI)}, database: ${rubyStr(op.db)})\n` +
    `collection = client[${rubyStr(op.collection)}]\n\n` +
    noteLines(ctx, '#', '') +
    query +
    `cursor.each do |doc|\n` +
    `  puts doc\n` +
    `end\n`
  )
}

// ---- Entry point ----

/** A complete snippet that runs the operation with the official driver of a language. */
export function generateCode(op: Operation, lang: CodeLanguage): string {
  switch (lang) {
    case 'mongosh':
      return operationToShell(op)
    case 'node':
      return nodeCode(op)
    case 'python':
      return pythonCode(op)
    case 'java':
      return javaCode(op)
    case 'csharp':
      return csharpCode(op)
    case 'php':
      return phpCode(op)
    case 'ruby':
      return rubyCode(op)
  }
}
