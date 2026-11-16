// The field editor's model: a canonical Extended JSON value becomes a draft with one input per
// part (text, subtype, flags, seconds and increment), and a draft becomes a value again or an error
// a person can act on. Changing the type is its own step, which carries the text over when it can.
import { base64Length, bsonType, dateMillis, isoDate, toShell, uuidText, type BsonType, type JsonObject, type JsonValue } from './ejson-view'
import { base64ToBytes, dateValue, doubleText, int64Text, parseDateText, parseShell, regexValue, ShellParseError, uuidValue } from './shell-parse'

/** The types the editor writes; others (Symbol, DBPointer, Undefined) are shown but not edited. */
export type EditType =
  | 'string'
  | 'int'
  | 'long'
  | 'double'
  | 'decimal'
  | 'bool'
  | 'date'
  | 'objectId'
  | 'null'
  | 'object'
  | 'array'
  | 'binData'
  | 'uuid'
  | 'regex'
  | 'timestamp'
  | 'javascript'
  | 'minKey'
  | 'maxKey'

export const EDIT_TYPES: { value: EditType; label: string }[] = [
  { value: 'string', label: 'String' },
  { value: 'int', label: 'Int32' },
  { value: 'long', label: 'Int64 (Long)' },
  { value: 'double', label: 'Double' },
  { value: 'decimal', label: 'Decimal128' },
  { value: 'bool', label: 'Boolean' },
  { value: 'date', label: 'Date' },
  { value: 'objectId', label: 'ObjectId' },
  { value: 'null', label: 'Null' },
  { value: 'object', label: 'Object' },
  { value: 'array', label: 'Array' },
  { value: 'binData', label: 'Binary' },
  { value: 'uuid', label: 'UUID' },
  { value: 'regex', label: 'Regular expression' },
  { value: 'timestamp', label: 'Timestamp' },
  { value: 'javascript', label: 'JavaScript' },
  { value: 'minKey', label: 'MinKey' },
  { value: 'maxKey', label: 'MaxKey' }
]

export type FieldDraft = {
  type: EditType
  /** The main text: the string, number, ISO date, hex, base64, pattern, code, or shell syntax. */
  text: string
  /** Binary subtype, 0 to 255. */
  subtype: string
  /** Regular expression flags. */
  flags: string
  /** Timestamp seconds and increment. */
  t: string
  i: string
}

export type DraftResult = { ok: true; value: JsonValue } | { ok: false; error: string }

const blank: FieldDraft = { type: 'string', text: '', subtype: '0', flags: '', t: '0', i: '0' }

export function editableType(t: BsonType): EditType | undefined {
  return EDIT_TYPES.some((e) => e.value === t) ? (t as EditType) : undefined
}

/** A draft that shows `value` as it is. */
export function draftFromValue(value: JsonValue): FieldDraft {
  const t = bsonType(value)
  const o = value as JsonObject
  switch (t) {
    case 'string':
      return { ...blank, type: 'string', text: value as string }
    case 'int':
      return { ...blank, type: 'int', text: typeof value === 'number' ? String(value) : String(o.$numberInt) }
    case 'long':
      return { ...blank, type: 'long', text: String(o.$numberLong) }
    case 'double':
      return { ...blank, type: 'double', text: typeof value === 'number' ? String(value) : String(o.$numberDouble) }
    case 'decimal':
      return { ...blank, type: 'decimal', text: String(o.$numberDecimal) }
    case 'bool':
      return { ...blank, type: 'bool', text: String(value) }
    case 'date':
      return { ...blank, type: 'date', text: isoDate(dateMillis(o)) }
    case 'objectId':
      return { ...blank, type: 'objectId', text: String(o.$oid) }
    case 'null':
      return { ...blank, type: 'null' }
    case 'object':
      return { ...blank, type: 'object', text: toShell(value) }
    case 'array':
      return { ...blank, type: 'array', text: toShell(value) }
    case 'uuid': {
      const b = o.$binary as JsonObject | undefined
      return { ...blank, type: 'uuid', text: b ? uuidText(String(b.base64)) : String(o.$uuid) }
    }
    case 'binData': {
      const b = o.$binary as JsonObject
      return { ...blank, type: 'binData', text: String(b.base64), subtype: String(parseInt(String(b.subType), 16)) }
    }
    case 'regex': {
      const r = o.$regularExpression as JsonObject
      return { ...blank, type: 'regex', text: String(r.pattern), flags: String(r.options ?? '') }
    }
    case 'timestamp': {
      const ts = o.$timestamp as JsonObject
      return { ...blank, type: 'timestamp', t: String(ts.t), i: String(ts.i) }
    }
    case 'javascript':
      return { ...blank, type: 'javascript', text: String(o.$code) }
    case 'minKey':
      return { ...blank, type: 'minKey' }
    case 'maxKey':
      return { ...blank, type: 'maxKey' }
    default:
      // Symbol, DBPointer, Undefined and truncated values: shown as shell text, saved as a string.
      return { ...blank, type: 'string', text: toShell(value) }
  }
}

/** Switches type, keeping what still makes sense: digits stay digits, text stays text. */
export function changeType(draft: FieldDraft, type: EditType): FieldDraft {
  const next: FieldDraft = { ...draft, type }
  const text = draft.text.trim()
  const numeric = text !== '' && !Number.isNaN(Number(text))
  switch (type) {
    case 'int':
    case 'long':
      next.text = numeric ? String(Math.trunc(Number(text))) : draft.type === 'bool' ? (text === 'true' ? '1' : '0') : '0'
      if (type === 'long' && /^[+-]?\d+$/.test(text)) next.text = text
      break
    case 'double':
    case 'decimal':
      next.text = numeric ? text : '0'
      break
    case 'bool':
      next.text = text === 'true' || (numeric && Number(text) !== 0) ? 'true' : 'false'
      break
    case 'date':
      next.text = draft.type === 'date' ? draft.text : numeric ? isoDate(Number(text)) : parseDateText(text) !== undefined ? text : isoDate(0)
      break
    case 'objectId':
      next.text = /^[0-9a-fA-F]{24}$/.test(text) ? text : ''
      break
    case 'object':
      next.text = draft.type === 'object' ? draft.text : '{}'
      break
    case 'array':
      next.text = draft.type === 'array' ? draft.text : draft.type === 'null' || text === '' ? '[]' : `[${draft.type === 'string' ? JSON.stringify(draft.text) : text}]`
      break
    case 'uuid':
      next.text = /^[0-9a-fA-F-]{32,36}$/.test(text) ? text : ''
      break
    case 'binData':
      next.text = base64ToBytes(text) !== undefined ? text : ''
      break
    case 'string':
    case 'regex':
    case 'javascript':
      next.text = draft.type === 'object' || draft.type === 'array' || draft.type === 'null' ? '' : draft.text
      break
    default:
      break
  }
  return next
}

function fail(error: string): DraftResult {
  return { ok: false, error }
}

function catching(build: () => JsonValue): DraftResult {
  try {
    return { ok: true, value: build() }
  } catch (error) {
    if (error instanceof ShellParseError) return fail(error.message)
    if (error instanceof DraftError) return fail(error.message)
    throw error
  }
}

class DraftError extends Error {}
const raise = (message: string): never => {
  throw new DraftError(message)
}

/** The draft as canonical Extended JSON, or why it can't be saved. */
export function valueFromDraft(d: FieldDraft): DraftResult {
  const text = d.text.trim()
  switch (d.type) {
    case 'string':
      return { ok: true, value: d.text }
    case 'int': {
      if (!/^[+-]?\d+$/.test(text)) return fail('An Int32 is a whole number, such as 42.')
      const n = Number(text)
      if (n < -2147483648 || n > 2147483647) return fail('An Int32 is from -2,147,483,648 to 2,147,483,647. Use Int64 for bigger numbers.')
      return { ok: true, value: { $numberInt: String(n) } }
    }
    case 'long':
      return catching(() => ({ $numberLong: int64Text(text, raise) }))
    case 'double': {
      const special = { nan: 'NaN', infinity: 'Infinity', '+infinity': 'Infinity', '-infinity': '-Infinity' }[text.toLowerCase()]
      if (special) return { ok: true, value: { $numberDouble: special } }
      if (text === '' || Number.isNaN(Number(text))) return fail('A Double is a number, such as 3.14, 1e-6, NaN or Infinity.')
      return { ok: true, value: { $numberDouble: doubleText(Number(text)) } }
    }
    case 'decimal':
      if (!/^[+-]?(?:(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?|Infinity|NaN)$/i.test(text)) return fail('A Decimal128 is a decimal number, such as 0.1 or 1.5E+3.')
      return { ok: true, value: { $numberDecimal: text } }
    case 'bool':
      if (text !== 'true' && text !== 'false') return fail('Choose true or false.')
      return { ok: true, value: text === 'true' }
    case 'date': {
      const ms = /^[+-]?\d+$/.test(text) ? Number(text) : parseDateText(text)
      if (ms === undefined || !Number.isFinite(ms)) return fail('Write the date as 2026-01-02 or 2026-01-02T03:04:05.678Z (UTC), or as milliseconds since 1970.')
      return { ok: true, value: dateValue(ms) }
    }
    case 'objectId':
      if (!/^[0-9a-fA-F]{24}$/.test(text)) return fail('An ObjectId is 24 hex digits.')
      return { ok: true, value: { $oid: text.toLowerCase() } }
    case 'null':
      return { ok: true, value: null }
    case 'object':
    case 'array':
      return catching(() => {
        const v = parseShell(d.text)
        if (d.type === 'object' && bsonType(v) !== 'object') raise('An Object is written in { }, such as { a: 1 }.')
        if (d.type === 'array' && !Array.isArray(v)) raise('An Array is written in [ ], such as [1, 2].')
        return v
      })
    case 'uuid':
      return catching(() => uuidValue(text, raise))
    case 'binData': {
      const sub = Number(d.subtype)
      if (!Number.isInteger(sub) || sub < 0 || sub > 255) return fail('The subtype is a number from 0 to 255.')
      if (base64ToBytes(text) === undefined) return fail('The data must be base64 text.')
      return { ok: true, value: { $binary: { base64: text.replace(/\s+/g, ''), subType: sub.toString(16).padStart(2, '0') } } }
    }
    case 'regex':
      if (d.text === '') return fail('Write a pattern.')
      return catching(() => regexValue(d.text, d.flags.trim(), raise))
    case 'timestamp': {
      const t = Number(d.t)
      const i = Number(d.i)
      for (const n of [t, i]) if (d.t.trim() === '' || d.i.trim() === '' || !Number.isInteger(n) || n < 0 || n > 4294967295) return fail('Seconds and increment are whole numbers from 0 to 4,294,967,295.')
      return { ok: true, value: { $timestamp: { t, i } } }
    }
    case 'javascript':
      return { ok: true, value: { $code: d.text } }
    case 'minKey':
      return { ok: true, value: { $minKey: 1 } }
    case 'maxKey':
      return { ok: true, value: { $maxKey: 1 } }
  }
}

/** A short note under the editor for types whose input needs explaining. */
export function draftHint(d: FieldDraft): string | undefined {
  switch (d.type) {
    case 'date':
      return 'UTC, as 2026-01-02T03:04:05.678Z. Milliseconds since 1970 also work.'
    case 'long':
      return 'Kept exactly, up to ±9,223,372,036,854,775,807.'
    case 'binData':
      return `Base64. ${d.text ? `${base64Length(d.text).toLocaleString('en-US')} bytes.` : ''}`.trim()
    case 'object':
    case 'array':
      return 'Shell syntax: unquoted keys, ObjectId(...), ISODate(...) and the other constructors work.'
    case 'regex':
      return 'The pattern without slashes. Flags: i, m, s, x, u.'
    default:
      return undefined
  }
}
