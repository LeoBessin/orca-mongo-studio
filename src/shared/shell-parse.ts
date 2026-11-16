// A deterministic parser for mongo shell literals: never `eval`. It reads what people type in a
// query bar or document editor (unquoted keys, single quotes, regex literals, trailing commas,
// comments, and the shell's BSON constructors) and returns canonical Extended JSON as plain data.
// The panel uses it to check input as it is typed; the worker turns its output into BSON with
// `EJSON.parse`. Keys that start with `$` and were typed as Extended JSON pass through as written.
import { setOwn, type JsonValue } from './ejson-view'

export class ShellParseError extends Error {
  constructor(
    message: string,
    readonly line: number,
    readonly column: number,
    readonly offset: number
  ) {
    super(`${message} (line ${line}, column ${column})`)
    this.name = 'ShellParseError'
  }
  /** The message without the position. */
  get reason(): string {
    return this.message.replace(/ \(line \d+, column \d+\)$/, '')
  }
}

export type ParseOptions = {
  /** What `new Date()` and `ISODate()` with no argument mean; the parser never reads the clock. */
  now?: number
}

const INT32_MIN = -2147483648
const INT32_MAX = 2147483647
const INT64_MIN = -(2n ** 63n)
const INT64_MAX = 2n ** 63n - 1n

/** Canonical Extended JSON for a JavaScript number, as the shell would store it. */
export function numberValue(n: number): JsonValue {
  if (Number.isInteger(n) && !Object.is(n, -0) && n >= INT32_MIN && n <= INT32_MAX) return { $numberInt: String(n) }
  return { $numberDouble: doubleText(n) }
}

export function doubleText(n: number): string {
  if (Number.isNaN(n)) return 'NaN'
  if (n === Infinity) return 'Infinity'
  if (n === -Infinity) return '-Infinity'
  if (Object.is(n, -0)) return '-0.0'
  // Canonical doubles keep a decimal point or exponent, as bson's EJSON writes them.
  const s = String(n)
  return Number.isInteger(n) && !/e/i.test(s) ? `${s}.0` : s
}

const DECIMAL = /^[+-]?(?:(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?|Infinity|inf|NaN)$/i

class Parser {
  private pos = 0
  constructor(
    private readonly src: string,
    private readonly options: ParseOptions
  ) {}

  fail(message: string, at = this.pos): never {
    let line = 1
    let col = 1
    for (let i = 0; i < at && i < this.src.length; i++) {
      if (this.src[i] === '\n') {
        line++
        col = 1
      } else col++
    }
    throw new ShellParseError(message, line, col, at)
  }

  private skip(): void {
    for (;;) {
      const c = this.src[this.pos]
      if (c === ' ' || c === '\t' || c === '\n' || c === '\r' || c === ' ' || c === '﻿') this.pos++
      else if (c === '/' && this.src[this.pos + 1] === '/') {
        while (this.pos < this.src.length && this.src[this.pos] !== '\n') this.pos++
      } else if (c === '/' && this.src[this.pos + 1] === '*') {
        const end = this.src.indexOf('*/', this.pos + 2)
        if (end < 0) this.fail('This comment is never closed with */')
        this.pos = end + 2
      } else return
    }
  }

  private peek(): string | undefined {
    this.skip()
    return this.src[this.pos]
  }

  private expect(ch: string): void {
    if (this.peek() !== ch) this.fail(this.pos >= this.src.length ? `Expected "${ch}" but the text ended` : `Expected "${ch}" but found "${this.src[this.pos]}"`)
    this.pos++
  }

  document(): JsonValue {
    const value = this.value()
    this.skip()
    // A shell statement may end with a semicolon.
    if (this.src[this.pos] === ';') {
      this.pos++
      this.skip()
    }
    if (this.pos < this.src.length) this.fail(`Unexpected "${this.src[this.pos]}" after the value`)
    return value
  }

  value(): JsonValue {
    const c = this.peek()
    if (c === undefined) this.fail('Expected a value but the text ended')
    if (c === '{') return this.object()
    if (c === '[') return this.array()
    if (c === '"' || c === "'") return this.string()
    if (c === '/') return this.regex()
    if (c === '-' || c === '+' || c === '.' || (c >= '0' && c <= '9')) return this.number()
    if (/[A-Za-z_$]/.test(c)) return this.word()
    this.fail(`Unexpected "${c}"`)
  }

  private object(): JsonValue {
    const start = this.pos
    this.pos++
    const out: { [key: string]: JsonValue } = {}
    for (;;) {
      const c = this.peek()
      if (c === '}') {
        this.pos++
        return out
      }
      if (c === undefined) this.fail('This object is never closed with }', start)
      const keyAt = this.pos
      const key = this.key()
      this.expect(':')
      if (Object.prototype.hasOwnProperty.call(out, key)) this.fail(`The key "${key}" appears twice`, keyAt)
      setOwn(out, key, this.value())
      const next = this.peek()
      if (next === ',') this.pos++
      else if (next !== '}') this.fail(next === undefined ? 'This object is never closed with }' : `Expected "," or "}" but found "${next}"`, next === undefined ? start : this.pos)
    }
  }

  private key(): string {
    const c = this.peek()
    if (c === '"' || c === "'") return this.quoted()
    if (c === '[') {
      // A computed key holding a string, as `toShell` writes `['__proto__']`.
      const start = this.pos
      this.pos++
      const q = this.peek()
      if (q !== '"' && q !== "'") this.fail('A key in [ ] must be a quoted string', start)
      const key = this.quoted()
      this.expect(']')
      return key
    }
    const m = /^[A-Za-z0-9_$][A-Za-z0-9_$.]*/.exec(this.src.slice(this.pos))
    if (!m) this.fail(c === ',' ? 'Expected a key after ","' : `Expected a key but found "${c}"`)
    this.pos += m[0].length
    return m[0]
  }

  private array(): JsonValue {
    const start = this.pos
    this.pos++
    const out: JsonValue[] = []
    for (;;) {
      const c = this.peek()
      if (c === ']') {
        this.pos++
        return out
      }
      if (c === undefined) this.fail('This array is never closed with ]', start)
      out.push(this.value())
      const next = this.peek()
      if (next === ',') this.pos++
      else if (next !== ']') this.fail(next === undefined ? 'This array is never closed with ]' : `Expected "," or "]" but found "${next}"`, next === undefined ? start : this.pos)
    }
  }

  private string(): JsonValue {
    return this.quoted()
  }

  private quoted(): string {
    const quote = this.src[this.pos]!
    const start = this.pos
    this.pos++
    let out = ''
    for (;;) {
      const c = this.src[this.pos]
      if (c === undefined || c === '\n') this.fail('This string is never closed', start)
      this.pos++
      if (c === quote) return out
      if (c !== '\\') {
        out += c
        continue
      }
      const e = this.src[this.pos++]
      switch (e) {
        case 'n': out += '\n'; break
        case 't': out += '\t'; break
        case 'r': out += '\r'; break
        case 'b': out += '\b'; break
        case 'f': out += '\f'; break
        case 'v': out += '\v'; break
        case '0': out += '\0'; break
        case '\n': break
        case 'x': {
          const hex = this.src.slice(this.pos, this.pos + 2)
          if (!/^[0-9a-fA-F]{2}$/.test(hex)) this.fail('\\x needs two hex digits', this.pos - 2)
          out += String.fromCharCode(parseInt(hex, 16))
          this.pos += 2
          break
        }
        case 'u': {
          if (this.src[this.pos] === '{') {
            const end = this.src.indexOf('}', this.pos)
            const hex = end > 0 ? this.src.slice(this.pos + 1, end) : ''
            if (!/^[0-9a-fA-F]{1,6}$/.test(hex) || parseInt(hex, 16) > 0x10ffff) this.fail('Bad \\u{...} escape', this.pos - 2)
            out += String.fromCodePoint(parseInt(hex, 16))
            this.pos = end + 1
          } else {
            const hex = this.src.slice(this.pos, this.pos + 4)
            if (!/^[0-9a-fA-F]{4}$/.test(hex)) this.fail('\\u needs four hex digits', this.pos - 2)
            out += String.fromCharCode(parseInt(hex, 16))
            this.pos += 4
          }
          break
        }
        case undefined: this.fail('This string is never closed', start)
        // eslint-disable-next-line no-fallthrough
        default: out += e
      }
    }
  }

  private regex(): JsonValue {
    const start = this.pos
    this.pos++
    let pattern = ''
    let inClass = false
    for (;;) {
      const c = this.src[this.pos]
      if (c === undefined || c === '\n') this.fail('This regular expression is never closed with /', start)
      this.pos++
      if (c === '\\') {
        const next = this.src[this.pos]
        if (next === undefined || next === '\n') this.fail('This regular expression is never closed with /', start)
        pattern += c + next
        this.pos++
        continue
      }
      if (c === '[') inClass = true
      else if (c === ']') inClass = false
      else if (c === '/' && !inClass) break
      pattern += c
    }
    if (pattern === '') this.fail('Empty regular expression', start)
    const m = /^[a-z]*/.exec(this.src.slice(this.pos))!
    this.pos += m[0].length
    return regexValue(pattern, m[0], (msg) => this.fail(msg, start))
  }

  private number(): JsonValue {
    const start = this.pos
    const m = /^[+-]?(?:0[xX][0-9a-fA-F]+|(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?|Infinity)/.exec(this.src.slice(this.pos))
    if (!m) this.fail(`Expected a number`, start)
    this.pos += m[0].length
    const text = m[0]
    const sign = text.startsWith('-') ? -1 : 1
    const body = text.replace(/^[+-]/, '')
    const n = /^0[xX]/.test(body) ? sign * parseInt(body.slice(2), 16) : body === 'Infinity' ? sign * Infinity : Number(text)
    if (/[A-Za-z_$]/.test(this.src[this.pos] ?? '')) this.fail(`Unexpected "${this.src[this.pos]}" after the number`)
    // Unlike JavaScript, a decimal point or exponent keeps the number a double, so 3.0 written by
    // the document editor reads back as a double.
    if (!/^0[xX]/.test(body) && /[.eE]/.test(body)) return { $numberDouble: doubleText(n) }
    return numberValue(n)
  }

  private identifier(): string {
    const m = /^[A-Za-z_$][A-Za-z0-9_$]*/.exec(this.src.slice(this.pos))
    if (!m) this.fail('Expected a name')
    this.pos += m[0].length
    return m[0]
  }

  /** Literals, and the shell's constructors with or without `new`. */
  private word(): JsonValue {
    const start = this.pos
    let name = this.identifier()
    let isNew = false
    if (name === 'new') {
      this.skip()
      isNew = true
      name = this.identifier()
    }
    if (!isNew) {
      if (name === 'true') return true
      if (name === 'false') return false
      if (name === 'null') return null
      if (name === 'NaN') return { $numberDouble: 'NaN' }
      if (name === 'Infinity') return { $numberDouble: 'Infinity' }
      if (name === 'undefined') this.fail('undefined is not stored by MongoDB. Use null', start)
    }
    const args = this.peek() === '(' ? this.args() : null
    const ctor = CONSTRUCTORS[name]
    if (!ctor) this.fail(`Unknown name "${name}"`, start)
    if (args === null && !ctor.bare) this.fail(`${name} needs arguments, as in ${ctor.example}`, start)
    return ctor.build(args ?? [], (msg) => this.fail(msg, start), this.options, isNew)
  }

  private args(): Arg[] {
    this.pos++
    const out: Arg[] = []
    for (;;) {
      const c = this.peek()
      if (c === ')') {
        this.pos++
        return out
      }
      const at = this.pos
      const raw = c === '"' || c === "'" ? { kind: 'string' as const, text: this.quoted() } : null
      if (raw) out.push({ ...raw, at })
      else {
        const signed = c === '-' || c === '+' || c === '.' || (c !== undefined && c >= '0' && c <= '9')
        if (signed) {
          const m = /^[+-]?(?:0[xX][0-9a-fA-F]+|(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?)/.exec(this.src.slice(this.pos))
          if (!m) this.fail('Expected a number')
          this.pos += m[0].length
          out.push({ kind: 'number', text: m[0], at })
        } else out.push({ kind: 'value', value: this.value(), at })
      }
      const next = this.peek()
      if (next === ',') this.pos++
      else if (next !== ')') this.fail(next === undefined ? 'Expected ")" but the text ended' : `Expected "," or ")" but found "${next}"`)
    }
  }
}

type Arg = ({ kind: 'string'; text: string } | { kind: 'number'; text: string } | { kind: 'value'; value: JsonValue }) & { at: number }
type Fail = (message: string) => never
type Ctor = {
  example: string
  /** Allowed without parentheses (`MinKey`). */
  bare?: boolean
  build(args: Arg[], fail: Fail, options: ParseOptions, isNew: boolean): JsonValue
}

function argText(arg: Arg | undefined, what: string, fail: Fail): string {
  if (!arg) fail(`${what} is missing`)
  if (arg.kind === 'value') {
    const v = arg.value
    if (typeof v === 'string') return v
    fail(`${what} must be a string or a number`)
  }
  return arg.text
}

function argNumber(arg: Arg | undefined, what: string, fail: Fail): number {
  if (!arg) fail(`${what} is missing`)
  if (arg.kind === 'number') return Number(arg.text)
  if (arg.kind === 'string' && arg.text.trim() !== '' && !Number.isNaN(Number(arg.text))) return Number(arg.text)
  if (arg.kind === 'value') {
    const n = plainNumber(arg.value)
    if (n !== undefined) return n
  }
  fail(`${what} must be a number`)
}

function plainNumber(v: JsonValue): number | undefined {
  if (typeof v === 'number') return v
  if (v && typeof v === 'object' && !Array.isArray(v)) {
    if (typeof v.$numberInt === 'string') return Number(v.$numberInt)
    if (typeof v.$numberDouble === 'string') return Number(v.$numberDouble)
    if (typeof v.$numberLong === 'string') return Number(v.$numberLong)
  }
  return undefined
}

function maxArgs(args: Arg[], n: number, name: string, fail: Fail): void {
  if (args.length > n) fail(`${name} takes at most ${n} argument${n === 1 ? '' : 's'}`)
}

export function regexValue(pattern: string, flags: string, fail: Fail): JsonValue {
  for (const f of flags) if (!'imsxlu'.includes(f)) fail(`Unknown regular expression flag "${f}". MongoDB accepts i, m, s, x and u`)
  // Canonical Extended JSON lists the options in alphabetical order.
  const options = [...new Set(flags)].sort().join('')
  return { $regularExpression: { pattern, options } }
}

export function dateValue(ms: number): JsonValue {
  return { $date: { $numberLong: String(Math.trunc(ms)) } }
}

/** `2026-01-02`, `2026-01-02T03:04:05Z`, with an offset or fraction; refused when not a date. */
export function parseDateText(text: string): number | undefined {
  const t = text.trim()
  if (!/^[+-]?\d{4,6}-\d{2}(-\d{2})?([T ]\d{2}:\d{2}(:\d{2}(\.\d{1,9})?)?)?(Z|[+-]\d{2}:?\d{2})?$/i.test(t)) return undefined
  // A date-time without a zone is UTC, as ISODate() reads it in the shell.
  let normal = t.replace(' ', 'T')
  if (/T/.test(normal) && !/(Z|[+-]\d{2}:?\d{2})$/i.test(normal)) normal += 'Z'
  normal = normal.replace(/([+-]\d{2})(\d{2})$/, '$1:$2').replace(/(\.\d{3})\d+/, '$1')
  const ms = Date.parse(normal)
  return Number.isNaN(ms) ? undefined : ms
}

function hexToBase64(hex: string): string {
  const bytes = new Uint8Array(hex.length / 2)
  for (let i = 0; i < bytes.length; i++) bytes[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16)
  return bytesToBase64(bytes)
}

const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'

export function bytesToBase64(bytes: Uint8Array): string {
  let out = ''
  for (let i = 0; i < bytes.length; i += 3) {
    const a = bytes[i]!
    const b = bytes[i + 1]
    const c = bytes[i + 2]
    out += B64[a >> 2]! + B64[((a & 3) << 4) | ((b ?? 0) >> 4)]!
    out += b === undefined ? '=' : B64[((b & 15) << 2) | ((c ?? 0) >> 6)]!
    out += c === undefined ? '=' : B64[c & 63]!
  }
  return out
}

export function base64ToBytes(text: string): Uint8Array | undefined {
  const t = text.replace(/\s+/g, '')
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(t) || t.length % 4 === 1) return undefined
  const clean = t.replace(/=+$/, '')
  const out: number[] = []
  let buf = 0
  let bits = 0
  for (const ch of clean) {
    buf = (buf << 6) | B64.indexOf(ch)
    bits += 6
    if (bits >= 8) {
      bits -= 8
      out.push((buf >> bits) & 0xff)
    }
  }
  return new Uint8Array(out)
}

export function uuidValue(text: string, fail: Fail): JsonValue {
  const hex = text.replace(/-/g, '')
  if (!/^[0-9a-fA-F]{32}$/.test(hex)) fail('A UUID has 32 hex digits, as in UUID("3b241101-e2bb-4255-8caf-4136c566a962")')
  return { $binary: { base64: hexToBase64(hex.toLowerCase()), subType: '04' } }
}

function subtypeHex(n: number, fail: Fail): string {
  if (!Number.isInteger(n) || n < 0 || n > 255) fail('The binary subtype is a number from 0 to 255')
  return n.toString(16).padStart(2, '0')
}

export function int64Text(text: string, fail: Fail): string {
  const t = text.trim()
  if (!/^[+-]?\d+$/.test(t)) fail(`"${text}" is not a whole number`)
  const n = BigInt(t)
  if (n < INT64_MIN || n > INT64_MAX) fail('The number is outside the 64-bit integer range')
  return n.toString()
}

const CONSTRUCTORS: Record<string, Ctor> = {}

function define(names: string[], ctor: Ctor): void {
  for (const n of names) CONSTRUCTORS[n] = ctor
}

define(['ObjectId', 'ObjectID'], {
  example: 'ObjectId("6542f1a2b3c4d5e6f7a8b9c0")',
  build(args, fail) {
    maxArgs(args, 1, 'ObjectId', fail)
    if (args.length === 0) fail('ObjectId() needs its 24 hex digits. To have one made, leave _id out of the document')
    const hex = argText(args[0], 'The ObjectId', fail)
    if (!/^[0-9a-fA-F]{24}$/.test(hex)) fail('An ObjectId has 24 hex digits')
    return { $oid: hex.toLowerCase() }
  }
})

define(['ISODate', 'Date'], {
  example: 'ISODate("2026-01-02T03:04:05Z")',
  build(args, fail, options, isNew) {
    maxArgs(args, 1, 'A date', fail)
    if (args.length === 0) {
      if (options.now === undefined) return fail('new Date() needs a date here, as in ISODate("2026-01-02")')
      return dateValue(options.now)
    }
    const a = args[0]!
    if (a.kind === 'number' || (a.kind === 'value' && plainNumber(a.value) !== undefined)) {
      // new Date(ms) is milliseconds since 1970; Date(ms) without new is a string in JavaScript,
      // but people mean the same date.
      void isNew
      const ms = argNumber(a, 'The date', fail)
      if (!Number.isFinite(ms)) fail('A date needs a finite number of milliseconds')
      return dateValue(ms)
    }
    const text = argText(a, 'The date', fail)
    const ms = parseDateText(text)
    if (ms === undefined) return fail(`"${text}" is not a date. Write it as 2026-01-02 or 2026-01-02T03:04:05Z`)
    return dateValue(ms)
  }
})

define(['NumberInt', 'Int32'], {
  example: 'NumberInt(42)',
  build(args, fail) {
    maxArgs(args, 1, 'NumberInt', fail)
    const n = args.length ? argNumber(args[0], 'The number', fail) : 0
    if (!Number.isInteger(n) || n < INT32_MIN || n > INT32_MAX) fail('NumberInt takes a whole number from -2147483648 to 2147483647')
    return { $numberInt: String(n) }
  }
})

define(['NumberLong', 'Long'], {
  example: 'NumberLong("9007199254740993")',
  build(args, fail) {
    maxArgs(args, 1, 'NumberLong', fail)
    if (!args.length) return { $numberLong: '0' }
    const a = args[0]!
    if (a.kind === 'value') {
      const n = plainNumber(a.value)
      if (n === undefined || !Number.isInteger(n)) fail('NumberLong takes a whole number')
      return { $numberLong: int64Text(String(n), fail) }
    }
    if (a.kind === 'number' && !/^[+-]?\d+$/.test(a.text)) {
      const n = Number(a.text)
      if (!Number.isInteger(n)) fail('NumberLong takes a whole number')
      return { $numberLong: int64Text(BigInt(n).toString(), fail) }
    }
    if (a.kind === 'number' && Math.abs(Number(a.text)) > Number.MAX_SAFE_INTEGER) {
      fail(`${a.text} is past what a JavaScript number keeps exactly. Quote it: NumberLong("${a.text}")`)
    }
    return { $numberLong: int64Text(a.text, fail) }
  }
})

define(['NumberDecimal', 'Decimal128'], {
  example: 'NumberDecimal("0.1")',
  build(args, fail) {
    maxArgs(args, 1, 'NumberDecimal', fail)
    const text = args.length ? argText(args[0], 'The decimal', fail).trim() : '0'
    if (!DECIMAL.test(text)) fail(`"${text}" is not a decimal number`)
    return { $numberDecimal: text }
  }
})

define(['Double', 'NumberDouble'], {
  example: 'Double(1.5)',
  build(args, fail) {
    maxArgs(args, 1, 'Double', fail)
    const n = args.length ? argNumber(args[0], 'The number', fail) : 0
    return { $numberDouble: doubleText(n) }
  }
})

define(['UUID'], {
  example: 'UUID("3b241101-e2bb-4255-8caf-4136c566a962")',
  build(args, fail) {
    maxArgs(args, 1, 'UUID', fail)
    if (!args.length) fail('UUID() needs its hex digits here, as in UUID("3b241101-e2bb-4255-8caf-4136c566a962")')
    return uuidValue(argText(args[0], 'The UUID', fail), fail)
  }
})

define(['BinData'], {
  example: 'BinData(0, "SGVsbG8=")',
  build(args, fail) {
    if (args.length !== 2) fail('BinData takes a subtype and base64 text, as in BinData(0, "SGVsbG8=")')
    const sub = subtypeHex(argNumber(args[0], 'The subtype', fail), fail)
    const text = argText(args[1], 'The data', fail)
    if (base64ToBytes(text) === undefined) fail('The data must be base64 text')
    return { $binary: { base64: text.replace(/\s+/g, ''), subType: sub } }
  }
})

define(['HexData'], {
  example: 'HexData(0, "48656c6c6f")',
  build(args, fail) {
    if (args.length !== 2) fail('HexData takes a subtype and hex text, as in HexData(0, "48656c6c6f")')
    const sub = subtypeHex(argNumber(args[0], 'The subtype', fail), fail)
    const hex = argText(args[1], 'The data', fail)
    if (!/^([0-9a-fA-F]{2})*$/.test(hex)) fail('The data must be hex digits, two per byte')
    return { $binary: { base64: hexToBase64(hex), subType: sub } }
  }
})

define(['Timestamp'], {
  example: 'Timestamp({ t: 1794835766, i: 7 })',
  build(args, fail) {
    let t: number
    let i: number
    const first = args[0]
    if (args.length === 1 && first?.kind === 'value' && first.value && typeof first.value === 'object' && !Array.isArray(first.value)) {
      const o = first.value
      const tv = plainNumber(o.t ?? null)
      const iv = plainNumber(o.i ?? null)
      if (tv === undefined || iv === undefined) return fail('Timestamp takes { t: seconds, i: increment }')
      t = tv
      i = iv
    } else if (args.length === 2) {
      t = argNumber(args[0], 'The seconds', fail)
      i = argNumber(args[1], 'The increment', fail)
    } else if (args.length === 0) {
      t = 0
      i = 0
    } else return fail('Timestamp takes { t: seconds, i: increment } or (seconds, increment)')
    for (const n of [t, i]) if (!Number.isInteger(n) || n < 0 || n > 4294967295) fail('Timestamp parts are whole numbers from 0 to 4294967295')
    return { $timestamp: { t, i } }
  }
})

define(['MinKey'], { example: 'MinKey()', bare: true, build: (args, fail) => (maxArgs(args, 0, 'MinKey', fail), { $minKey: 1 }) })
define(['MaxKey'], { example: 'MaxKey()', bare: true, build: (args, fail) => (maxArgs(args, 0, 'MaxKey', fail), { $maxKey: 1 }) })

define(['RegExp'], {
  example: 'RegExp("^a", "i")',
  build(args, fail) {
    maxArgs(args, 2, 'RegExp', fail)
    const pattern = argText(args[0], 'The pattern', fail)
    const flags = args.length > 1 ? argText(args[1], 'The flags', fail) : ''
    return regexValue(pattern, flags, fail)
  }
})

define(['Code'], {
  example: 'Code("function () { return 1 }")',
  build(args, fail) {
    maxArgs(args, 1, 'Code', fail)
    return { $code: argText(args[0], 'The code', fail) }
  }
})

/** Parses one shell literal (usually a document) into canonical Extended JSON. */
export function parseShell(text: string, options: ParseOptions = {}): JsonValue {
  return new Parser(text, options).document()
}

/** A document, or `{}` when the text is blank: query bar fields. */
export function parseShellDocument(text: string, what: string, options: ParseOptions = {}): { [key: string]: JsonValue } {
  if (!text.trim()) return {}
  const value = parseShell(text, options)
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new ShellParseError(`The ${what} must be a document in { }`, 1, 1, 0)
  return value
}

/** `null` when it parses; the error otherwise. For checking a field as it is typed. */
export function shellProblem(text: string, what: string, options: ParseOptions = {}): ShellParseError | null {
  try {
    parseShellDocument(text, what, options)
    return null
  } catch (error) {
    if (error instanceof ShellParseError) return error
    throw error
  }
}
