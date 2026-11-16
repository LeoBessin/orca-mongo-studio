// CSV and TSV for import and export. Reading is incremental (`CsvReader.feed` takes text in pieces,
// quotes may span pieces), columns get a type inferred from a sample or named in the header the way
// mongoimport's `--columnsHaveTypes` does (`age.int32()`), and each cell becomes canonical Extended
// JSON. Writing flattens documents into dotted columns; values that are not plain scalars are
// written as relaxed Extended JSON, which the `json` type reads back.
import { bsonType, dateMillis, isObject, isoDate, toRelaxed, type JsonObject, type JsonValue } from './ejson-view'

export type CsvType = 'string' | 'int' | 'long' | 'double' | 'decimal' | 'bool' | 'date' | 'objectId' | 'json' | 'skip'

export const CSV_TYPES: { value: CsvType; label: string }[] = [
  { value: 'string', label: 'String' },
  { value: 'int', label: 'Int32' },
  { value: 'long', label: 'Int64' },
  { value: 'double', label: 'Double' },
  { value: 'decimal', label: 'Decimal128' },
  { value: 'bool', label: 'Boolean' },
  { value: 'date', label: 'Date' },
  { value: 'objectId', label: 'ObjectId' },
  { value: 'json', label: 'Extended JSON' },
  { value: 'skip', label: 'Skip the column' }
]

/** One column of the file: its header, the field it fills (dotted) and the type of its values. */
export type CsvColumn = { name: string; field: string; type: CsvType }

export type CsvReadOptions = {
  delimiter: string
  /** The first row names the columns; otherwise columns are `field1`, `field2`, … */
  header: boolean
  /** Empty cells leave the field out; otherwise a string column keeps '' and others are null. */
  ignoreEmpty: boolean
}

/** Reads rows of delimited text given in pieces. Handles quotes (with `""` inside), CRLF, LF and
 *  CR line ends, and a byte-order mark at the start. */
export class CsvReader {
  private field = ''
  private row: string[] = []
  private quoted = false
  /** Inside quotes. */
  private inQuotes = false
  /** A quote just closed inside a quoted field: the next char decides (`""` or the end). */
  private quoteEnded = false
  private lastWasCr = false
  private started = false
  private rowHasContent = false
  /** 1-based line where the current row started, for error messages. */
  line = 1
  rowLine = 1

  constructor(private readonly delimiter: string) {
    if (delimiter.length !== 1) throw new Error('The delimiter must be one character.')
  }

  feed(text: string): { rows: string[][]; lines: number[] } {
    const rows: string[][] = []
    const lines: number[] = []
    let i = 0
    if (!this.started) {
      this.started = true
      if (text.charCodeAt(0) === 0xfeff) i = 1
    }
    const d = this.delimiter
    for (; i < text.length; i++) {
      const c = text[i]!
      if (this.lastWasCr) {
        this.lastWasCr = false
        if (c === '\n') continue
      }
      if (this.inQuotes) {
        if (this.quoteEnded) {
          this.quoteEnded = false
          if (c === '"') {
            this.field += '"'
            continue
          }
          this.inQuotes = false
          // fall through: c is read outside quotes
        } else {
          if (c === '"') this.quoteEnded = true
          else {
            if (c === '\n' || c === '\r') this.line++
            if (c === '\r' && text[i + 1] === '\n') {
              this.field += '\r\n'
              i++
              continue
            }
            this.field += c
          }
          continue
        }
      }
      if (c === '"' && this.field === '' && !this.quoted) {
        this.inQuotes = true
        this.quoted = true
        this.rowHasContent = true
        continue
      }
      if (c === d) {
        this.row.push(this.field)
        this.field = ''
        this.quoted = false
        this.rowHasContent = true
        continue
      }
      if (c === '\n' || c === '\r') {
        this.endRow(rows, lines)
        this.line++
        this.rowLine = this.line
        if (c === '\r') this.lastWasCr = true
        continue
      }
      this.field += c
      this.rowHasContent = true
    }
    return { rows, lines }
  }

  end(): { rows: string[][]; lines: number[] } {
    const rows: string[][] = []
    const lines: number[] = []
    if (this.inQuotes && !this.quoteEnded) throw new Error(`Line ${this.rowLine}: a quoted value is never closed.`)
    this.inQuotes = false
    this.quoteEnded = false
    this.endRow(rows, lines)
    return { rows, lines }
  }

  private endRow(rows: string[][], lines: number[]): void {
    if (this.inQuotes && this.quoteEnded) {
      this.inQuotes = false
      this.quoteEnded = false
    }
    if (this.rowHasContent || this.field !== '' || this.row.length) {
      this.row.push(this.field)
      rows.push(this.row)
      lines.push(this.rowLine)
    }
    this.row = []
    this.field = ''
    this.quoted = false
    this.rowHasContent = false
  }
}

/** Reads a whole text at once. */
export function parseCsv(text: string, delimiter = ','): string[][] {
  const r = new CsvReader(delimiter)
  return [...r.feed(text).rows, ...r.end().rows]
}

// ---- Header types (mongoimport --columnsHaveTypes) ----

const HEADER_TYPES: Record<string, CsvType> = {
  string: 'string',
  int32: 'int',
  int64: 'long',
  double: 'double',
  decimal: 'decimal',
  boolean: 'bool',
  date: 'date',
  date_iso8601: 'date',
  date_ms: 'date',
  objectid: 'objectId',
  json: 'json'
}

/** `age.int32()` → field `age`, type int. `auto()` and unknown types give no type. */
export function headerColumn(header: string): { field: string; type?: CsvType; note?: string } {
  const m = /^(.*)\.([A-Za-z_0-9]+)\((.*)\)$/.exec(header.trim())
  if (!m) return { field: header.trim() }
  const kind = m[2]!.toLowerCase()
  if (kind === 'auto') return { field: m[1]! }
  const type = HEADER_TYPES[kind]
  if (!type) return { field: m[1]!, note: `"${header}": the ${m[2]}() type is not supported, so its type is inferred.` }
  if (kind === 'date' && m[3]) return { field: m[1]!, type, note: `"${header}": date layouts are not supported; dates are read as ISO 8601 or milliseconds.` }
  return { field: m[1]!, type }
}

// ---- Type inference ----

const INT_RE = /^[-+]?(0|[1-9]\d*)$/
const NUM_RE = /^[-+]?(\d+\.?\d*|\.\d+)([eE][-+]?\d+)?$/
const DATE_RE = /^\d{4}-\d{2}-\d{2}([T ]\d{2}:\d{2}(:\d{2}(\.\d{1,9})?)?(Z|[+-]\d{2}:?\d{2})?)?$/
const OID_RE = /^[0-9a-fA-F]{24}$/
const INT32_MAX = 2147483647
const INT32_MIN = -2147483648
const INT64_MAX = 9223372036854775807n
const INT64_MIN = -9223372036854775808n

function isJsonCell(s: string): boolean {
  const t = s.trim()
  if (!((t.startsWith('{') && t.endsWith('}')) || (t.startsWith('[') && t.endsWith(']')))) return false
  try {
    JSON.parse(t)
    return true
  } catch {
    return false
  }
}

/** The narrowest type every non-empty sample fits, or string. Numbers with leading zeros stay
 *  strings (zip codes, ids). */
export function inferType(samples: readonly string[]): CsvType {
  const values = samples.filter((s) => s !== '')
  if (values.length === 0) return 'string'
  const all = (test: (s: string) => boolean): boolean => values.every(test)
  const leadingZero = (s: string): boolean => /^[-+]?0\d/.test(s)
  if (all((s) => INT_RE.test(s))) {
    if (values.some(leadingZero)) return 'string'
    const big = values.map((s) => BigInt(s))
    if (big.every((n) => n >= BigInt(INT32_MIN) && n <= BigInt(INT32_MAX))) return 'int'
    if (big.every((n) => n >= INT64_MIN && n <= INT64_MAX)) return 'long'
    return 'double'
  }
  if (all((s) => NUM_RE.test(s))) return values.some(leadingZero) ? 'string' : 'double'
  if (all((s) => /^(true|false)$/i.test(s))) return 'bool'
  if (all((s) => DATE_RE.test(s) && !Number.isNaN(Date.parse(dateText(s))))) return 'date'
  if (all((s) => OID_RE.test(s))) return 'objectId'
  if (all(isJsonCell)) return 'json'
  return 'string'
}

/** ISO text Date.parse reads the same everywhere: a space before the time becomes T, and a date
 *  with a time but no zone is UTC. */
function dateText(s: string): string {
  let t = s.replace(' ', 'T')
  if (t.includes('T') && !/(Z|[+-]\d{2}:?\d{2})$/.test(t)) t += 'Z'
  return t
}

/** Converts a cell to canonical Extended JSON. `undefined` leaves the field out. Throws a short
 *  message when the cell does not fit the type. */
export function cellValue(text: string, type: CsvType, ignoreEmpty: boolean, parseJson: (s: string) => JsonValue = defaultJson): JsonValue | undefined {
  if (type === 'skip') return undefined
  if (text === '') {
    if (ignoreEmpty) return undefined
    return type === 'string' ? '' : null
  }
  const s = type === 'string' ? text : text.trim()
  switch (type) {
    case 'string':
      return s
    case 'int': {
      if (!INT_RE.test(s)) throw new Error(`"${short(text)}" is not a whole number`)
      const n = Number(s)
      if (n < INT32_MIN || n > INT32_MAX) throw new Error(`${s} is outside the Int32 range`)
      return { $numberInt: String(n) }
    }
    case 'long': {
      if (!INT_RE.test(s)) throw new Error(`"${short(text)}" is not a whole number`)
      const n = BigInt(s)
      if (n < INT64_MIN || n > INT64_MAX) throw new Error(`${s} is outside the Int64 range`)
      return { $numberLong: n.toString() }
    }
    case 'double': {
      if (!NUM_RE.test(s) && !/^[-+]?(Infinity|NaN)$/.test(s)) throw new Error(`"${short(text)}" is not a number`)
      const n = Number(s)
      return { $numberDouble: Number.isInteger(n) && Math.abs(n) < 1e21 ? `${n}.0` : String(n) }
    }
    case 'decimal': {
      if (!NUM_RE.test(s)) throw new Error(`"${short(text)}" is not a number`)
      return { $numberDecimal: s.replace(/^\+/, '') }
    }
    case 'bool': {
      if (/^(true|1|yes)$/i.test(s)) return true
      if (/^(false|0|no)$/i.test(s)) return false
      throw new Error(`"${short(text)}" is not true or false`)
    }
    case 'date': {
      if (INT_RE.test(s)) return { $date: { $numberLong: s.replace(/^\+/, '') } }
      if (!DATE_RE.test(s)) throw new Error(`"${short(text)}" is not an ISO 8601 date`)
      const ms = Date.parse(dateText(s))
      if (Number.isNaN(ms)) throw new Error(`"${short(text)}" is not a valid date`)
      return { $date: { $numberLong: String(ms) } }
    }
    case 'objectId':
      if (!OID_RE.test(s)) throw new Error(`"${short(text)}" is not an ObjectId (24 hex digits)`)
      return { $oid: s.toLowerCase() }
    case 'json':
      try {
        return parseJson(s)
      } catch (error) {
        throw new Error(`"${short(text)}" is not Extended JSON: ${error instanceof Error ? error.message : String(error)}`)
      }
  }
}

function defaultJson(s: string): JsonValue {
  return JSON.parse(s) as JsonValue
}

function short(s: string): string {
  return s.length > 40 ? `${s.slice(0, 40)}…` : s
}

/** Columns for a file: from its header (with mongoimport types) or numbered, typed from samples. */
export function columnsFor(header: readonly string[] | undefined, sample: readonly (readonly string[])[]): { columns: CsvColumn[]; notes: string[] } {
  const width = Math.max(header?.length ?? 0, ...sample.map((r) => r.length))
  const notes: string[] = []
  const columns: CsvColumn[] = []
  const seen = new Set<string>()
  for (let i = 0; i < width; i++) {
    const raw = header?.[i] ?? `field${i + 1}`
    const h = header ? headerColumn(raw) : { field: raw }
    if (h.note) notes.push(h.note)
    let field = h.field || `field${i + 1}`
    if (seen.has(field)) {
      notes.push(`Column ${i + 1} repeats "${field}", so it is skipped.`)
      columns.push({ name: raw, field, type: 'skip' })
      continue
    }
    seen.add(field)
    columns.push({ name: raw, field, type: h.type ?? inferType(sample.map((r) => r[i] ?? '')) })
  }
  return { columns, notes }
}

/** Checks a column mapping: fields given, not repeated, and no field inside another. */
export function mappingProblems(columns: readonly CsvColumn[]): string[] {
  const out: string[] = []
  const used = columns.filter((c) => c.type !== 'skip')
  const fields = new Set<string>()
  for (const c of used) {
    const f = c.field.trim()
    if (!f) out.push(`Column "${c.name}" needs a field name, or skip it.`)
    else if (f.split('.').some((p) => p === '')) out.push(`"${f}": a dotted field can't have an empty part.`)
    else if (f.startsWith('$')) out.push(`"${f}": field names can't start with $.`)
    else if (fields.has(f)) out.push(`Two columns fill "${f}".`)
    fields.add(f)
  }
  for (const f of fields) {
    for (const g of fields) if (g !== f && g.startsWith(`${f}.`)) out.push(`"${f}" and "${g}": one field can't be both a value and a sub-document.`)
  }
  return [...new Set(out)]
}

/** A row as a document. Dotted fields become sub-documents. */
export function rowDocument(columns: readonly CsvColumn[], row: readonly string[], ignoreEmpty: boolean, parseJson?: (s: string) => JsonValue): JsonObject {
  const doc: JsonObject = {}
  for (let i = 0; i < columns.length; i++) {
    const c = columns[i]!
    if (c.type === 'skip') continue
    let v: JsonValue | undefined
    try {
      v = cellValue(row[i] ?? '', c.type, ignoreEmpty, parseJson)
    } catch (error) {
      throw new Error(`${c.name}: ${error instanceof Error ? error.message : String(error)}`)
    }
    if (v === undefined) continue
    const parts = c.field.trim().split('.')
    let at = doc
    for (const p of parts.slice(0, -1)) {
      const next = at[p]
      if (next === undefined) at = at[p] = {}
      else if (isObject(next) && bsonType(next) === 'object') at = next
      else throw new Error(`${c.name}: "${p}" is already a value`)
    }
    at[parts[parts.length - 1]!] = v
  }
  if (row.length > columns.length && row.slice(columns.length).some((x) => x !== '')) throw new Error(`The row has ${row.length} values for ${columns.length} columns.`)
  return doc
}

// ---- Writing ----

export type CsvWriteOptions = { delimiter: string; header: boolean }

/** The value at a dotted path, going into sub-documents (and array items by number). */
export function valueAtDotted(doc: JsonValue, field: string): JsonValue | undefined {
  let at: JsonValue | undefined = doc
  for (const p of field.split('.')) {
    if (Array.isArray(at)) {
      if (!/^\d+$/.test(p)) return undefined
      at = at[Number(p)]
    } else if (isObject(at) && bsonType(at) === 'object') at = at[p]
    else return undefined
    if (at === undefined) return undefined
  }
  return at
}

/** A canonical value as one cell: scalars as text, dates as ISO 8601, ObjectIds as hex, anything
 *  else as relaxed Extended JSON. Missing and null are empty. */
export function cellText(v: JsonValue | undefined): string {
  if (v === undefined || v === null) return ''
  if (typeof v === 'string') return v
  if (typeof v === 'boolean' || typeof v === 'number') return String(v)
  if (Array.isArray(v)) return JSON.stringify(toRelaxed(v))
  switch (bsonType(v)) {
    case 'int':
      return String((v as { $numberInt: string }).$numberInt)
    case 'long':
      return String((v as { $numberLong: string }).$numberLong)
    case 'double': {
      const d = String((v as { $numberDouble: string }).$numberDouble)
      return d.endsWith('.0') ? d.slice(0, -2) : d
    }
    case 'decimal':
      return String((v as { $numberDecimal: string }).$numberDecimal)
    case 'objectId':
      return String((v as { $oid: string }).$oid)
    case 'date':
      return isoDate(dateMillis(v as JsonObject))
    default:
      return JSON.stringify(toRelaxed(v))
  }
}

export function csvEscape(s: string, delimiter: string): string {
  if (s === '') return ''
  if (s.includes(delimiter) || s.includes('"') || s.includes('\n') || s.includes('\r') || s !== s.trim()) return `"${s.replace(/"/g, '""')}"`
  return s
}

export function csvLine(cells: readonly string[], delimiter: string): string {
  return `${cells.map((c) => csvEscape(c, delimiter)).join(delimiter)}\r\n`
}

export function csvRow(doc: JsonObject, fields: readonly string[], delimiter: string): string {
  return csvLine(fields.map((f) => cellText(valueAtDotted(doc, f))), delimiter)
}

/** The delimiter a path or pasted text most likely uses. */
export function guessDelimiter(firstLine: string): string {
  const counts = [',', ';', '\t', '|'].map((d) => [d, firstLine.split(d).length - 1] as const)
  counts.sort((a, b) => b[1] - a[1])
  return counts[0]![1] > 0 ? counts[0]![0] : ','
}
