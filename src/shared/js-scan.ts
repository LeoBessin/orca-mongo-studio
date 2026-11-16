// A small JavaScript scanner for shell scripts: tokens, top-level statements (with the same
// newline rules as JavaScript's automatic semicolons), the statement under the cursor, and what
// autocomplete should offer at a position. It never evaluates anything, and it tolerates
// unfinished code, since people type into it.

export type TokenType = 'ident' | 'number' | 'string' | 'template' | 'regex' | 'punct' | 'comment'
export type Token = {
  type: TokenType
  value: string
  start: number
  end: number
  /** A line break comes between this token and the one before it. */
  nl: boolean
  /** Strings, templates, regexes and block comments with no closing quote, backtick or slash. */
  open?: boolean
}

const PUNCTUATORS = [
  '>>>=', '...', '===', '!==', '**=', '<<=', '>>=', '>>>', '&&=', '||=', '??=',
  '=>', '==', '!=', '<=', '>=', '&&', '||', '??', '?.', '++', '--', '+=', '-=', '*=', '/=', '%=', '&=', '|=', '^=', '**', '<<', '>>'
]
/** After these words a `/` starts a regex, not a division. */
const REGEX_AFTER_WORDS = new Set(['return', 'typeof', 'case', 'do', 'else', 'in', 'of', 'new', 'delete', 'void', 'throw', 'instanceof', 'yield', 'await'])
const IDENT_START = /[A-Za-z_$\u0080-￿]/
const IDENT_PART = /[A-Za-z0-9_$\u0080-￿]/

function regexAllowed(prev: Token | undefined): boolean {
  if (!prev) return true
  if (prev.type === 'punct') return prev.value !== ')' && prev.value !== ']' && prev.value !== '}'
  if (prev.type === 'ident') return REGEX_AFTER_WORDS.has(prev.value)
  return false
}

type LexResult = { tokens: Token[]; end: number }

function lex(src: string, from: number, stopAtUnmatchedBrace: boolean, keepComments: boolean): LexResult {
  const tokens: Token[] = []
  let i = from
  let nl = false
  let braces = 0
  let prev: Token | undefined
  const push = (t: Token): void => {
    tokens.push(t)
    if (t.type !== 'comment') prev = t
    nl = false
  }
  while (i < src.length) {
    const c = src[i]!
    if (c === '\n' || c === '\r' || c === ' ' || c === ' ') {
      nl = true
      i++
      continue
    }
    if (c === ' ' || c === '\t' || c === '\f' || c === '\v' || c === '﻿' || c === ' ') {
      i++
      continue
    }
    const start = i
    if (c === '/' && src[i + 1] === '/') {
      while (i < src.length && src[i] !== '\n' && src[i] !== '\r') i++
      if (keepComments) tokens.push({ type: 'comment', value: src.slice(start, i), start, end: i, nl })
      continue
    }
    if (c === '/' && src[i + 1] === '*') {
      const close = src.indexOf('*/', i + 2)
      i = close < 0 ? src.length : close + 2
      const text = src.slice(start, i)
      if (/[\n\r]/.test(text)) nl = true
      if (keepComments) tokens.push({ type: 'comment', value: text, start, end: i, nl, ...(close < 0 ? { open: true } : {}) })
      continue
    }
    if (c === '"' || c === "'") {
      i++
      let closed = false
      while (i < src.length) {
        const d = src[i]!
        if (d === '\\') i += 2
        else if (d === c) {
          i++
          closed = true
          break
        } else if (d === '\n' || d === '\r') break
        else i++
      }
      i = Math.min(i, src.length)
      push({ type: 'string', value: src.slice(start, i), start, end: i, nl, ...(closed ? {} : { open: true }) })
      continue
    }
    if (c === '`') {
      i++
      let closed = false
      while (i < src.length) {
        const d = src[i]!
        if (d === '\\') i += 2
        else if (d === '`') {
          i++
          closed = true
          break
        } else if (d === '$' && src[i + 1] === '{') {
          const inner = lex(src, i + 2, true, false)
          i = inner.end
        } else i++
      }
      i = Math.min(i, src.length)
      const text = src.slice(start, i)
      push({ type: 'template', value: text, start, end: i, nl, ...(closed ? {} : { open: true }) })
      continue
    }
    if (c === '/' && regexAllowed(prev)) {
      i++
      let inClass = false
      let closed = false
      while (i < src.length) {
        const d = src[i]!
        if (d === '\\') i += 2
        else if (d === '\n' || d === '\r') break
        else if (inClass) {
          if (d === ']') inClass = false
          i++
        } else if (d === '[') {
          inClass = true
          i++
        } else if (d === '/') {
          i++
          closed = true
          break
        } else i++
      }
      if (closed) while (i < src.length && IDENT_PART.test(src[i]!)) i++
      i = Math.min(i, src.length)
      push({ type: 'regex', value: src.slice(start, i), start, end: i, nl, ...(closed ? {} : { open: true }) })
      continue
    }
    if (/[0-9]/.test(c) || (c === '.' && /[0-9]/.test(src[i + 1] ?? ''))) {
      i++
      while (i < src.length && /[0-9A-Za-z_.]/.test(src[i]!)) {
        if ((src[i] === 'e' || src[i] === 'E') && (src[i + 1] === '+' || src[i + 1] === '-') && !/^0[xX]/.test(src.slice(start, i))) i += 2
        else i++
      }
      push({ type: 'number', value: src.slice(start, i), start, end: i, nl })
      continue
    }
    if (IDENT_START.test(c) || c === '\\') {
      i++
      while (i < src.length && (IDENT_PART.test(src[i]!) || src[i] === '\\')) i++
      push({ type: 'ident', value: src.slice(start, i), start, end: i, nl })
      continue
    }
    if (c === '#' && IDENT_START.test(src[i + 1] ?? '')) {
      i++
      while (i < src.length && IDENT_PART.test(src[i]!)) i++
      push({ type: 'ident', value: src.slice(start, i), start, end: i, nl })
      continue
    }
    if (stopAtUnmatchedBrace) {
      if (c === '{') braces++
      else if (c === '}') {
        if (braces === 0) return { tokens, end: i + 1 }
        braces--
      }
    }
    let p = PUNCTUATORS.find((q) => src.startsWith(q, i))
    if (p === '?.' && /[0-9]/.test(src[i + 2] ?? '')) p = undefined
    const value = p ?? c
    i += value.length
    push({ type: 'punct', value, start, end: i, nl })
  }
  return { tokens, end: src.length }
}

/** Every token of `src`; comments are left out unless asked for. */
export function tokenize(src: string, options: { comments?: boolean } = {}): Token[] {
  return lex(src, 0, false, options.comments === true).tokens
}

export type Statement = {
  start: number
  /** After the last token, including a closing `;`. */
  end: number
  text: string
  /** 1-based line and column of `start`. */
  line: number
  column: number
}

const OPEN = new Set(['(', '[', '{'])
const CLOSE = new Set([')', ']', '}'])
/** Tokens a line may end with and still go on to the next. */
const CONTINUES_AFTER = (t: Token): boolean => {
  if (t.type === 'punct') return !CLOSE.has(t.value) && t.value !== '++' && t.value !== '--' && t.value !== ';'
  if (t.type === 'ident') return t.value === 'else' || t.value === 'do' || t.value === 'in' || t.value === 'instanceof' || t.value === 'of' || t.value === 'new' || t.value === 'typeof' || t.value === 'void' || t.value === 'delete' || t.value === 'await' || t.value === 'yield'
  return false
}
/** Tokens a line may start with and still belong to the line before. */
const CONTINUES_BEFORE = (t: Token): boolean => {
  if (t.type === 'template') return true
  if (t.type === 'punct') return !['++', '--', '!', '~', '{', ';'].includes(t.value)
  if (t.type === 'ident') return t.value === 'else' || t.value === 'catch' || t.value === 'finally' || t.value === 'in' || t.value === 'instanceof' || t.value === 'of'
  return false
}

function lineCol(src: string, offset: number): { line: number; column: number } {
  let line = 1
  let last = -1
  for (let i = 0; i < offset; i++) {
    if (src[i] === '\n') {
      line++
      last = i
    }
  }
  return { line, column: offset - last }
}

/** The script's top-level statements, in order. Comments between statements belong to none. */
export function splitStatements(src: string): Statement[] {
  const tokens = tokenize(src)
  const out: Statement[] = []
  let first = -1
  let depth = 0
  // `if (...)`, `for (...)`, `while (...)`, `with (...)`: the body may sit on the next line.
  let headerDepth = -1
  let headerClosedAt = -1
  let startsWithDo = false
  const finish = (lastIndex: number): void => {
    if (first < 0) return
    const start = tokens[first]!.start
    const end = tokens[lastIndex]!.end
    out.push({ start, end, text: src.slice(start, end), ...lineCol(src, start) })
    first = -1
    depth = 0
    headerDepth = -1
    headerClosedAt = -1
    startsWithDo = false
  }
  for (let k = 0; k < tokens.length; k++) {
    const t = tokens[k]!
    if (first >= 0 && depth === 0 && t.nl) {
      const prev = tokens[k - 1]!
      const go =
        CONTINUES_AFTER(prev) ||
        CONTINUES_BEFORE(t) ||
        headerClosedAt === k - 1 ||
        (startsWithDo && prev.value === '}' && t.value === 'while')
      if (!go) finish(k - 1)
    }
    if (first < 0) {
      if (t.type === 'punct' && t.value === ';') continue
      first = k
      startsWithDo = t.type === 'ident' && t.value === 'do'
    }
    if (t.type === 'ident' && depth === 0 && (t.value === 'if' || t.value === 'for' || t.value === 'while' || t.value === 'with') && tokens[k + 1]?.value === '(') {
      headerDepth = 0
    }
    if (t.type === 'punct') {
      if (OPEN.has(t.value)) depth++
      else if (CLOSE.has(t.value)) {
        depth = Math.max(0, depth - 1)
        if (depth === 0 && headerDepth === 0 && t.value === ')') {
          headerClosedAt = k
          headerDepth = -1
        }
      } else if (t.value === ';' && depth === 0) {
        finish(k)
        continue
      }
    }
  }
  if (first >= 0) finish(tokens.length - 1)
  return out
}

/**
 * The statement to run for a cursor at `offset`: the one around it, else one ending earlier on
 * the same line, else one starting later on the same line.
 */
export function statementAt(src: string, offset: number): Statement | undefined {
  const all = splitStatements(src)
  const inside = all.find((s) => s.start <= offset && offset <= s.end)
  if (inside) return inside
  const lineStart = src.lastIndexOf('\n', offset - 1) + 1
  const nextBreak = src.indexOf('\n', offset)
  const lineEnd = nextBreak < 0 ? src.length : nextBreak
  const before = [...all].reverse().find((s) => s.end <= offset && s.end >= lineStart)
  if (before) return before
  return all.find((s) => s.start >= offset && s.start <= lineEnd)
}

// ---- Autocomplete ----

export type KeyFlavor = 'query' | 'update' | 'stage' | 'expression' | 'accumulator' | 'projection' | 'fields'

export type CompletionContext =
  | { kind: 'global'; from: number; prefix: string }
  | { kind: 'db'; from: number; prefix: string }
  | { kind: 'collection'; from: number; prefix: string; collection: string }
  | { kind: 'cursor'; from: number; prefix: string; cursor: 'find' | 'aggregate' }
  /** A key in a document: field names, and operators that fit where the document is. */
  | { kind: 'key'; from: number; prefix: string; collection?: string; flavor: KeyFlavor; quote?: '"' | "'" }
  /** A `'$field'` path in an aggregation string. */
  | { kind: 'fieldRef'; from: number; prefix: string; collection?: string; quote: '"' | "'" }

export const FIND_LIKE = new Set(['find', 'findOne', 'countDocuments', 'count', 'deleteOne', 'deleteMany', 'distinct', 'findOneAndDelete', 'findOneAndUpdate', 'findOneAndReplace', 'updateOne', 'updateMany', 'replaceOne', 'remove', 'update', 'watch'])
const UPDATE_METHODS = new Set(['updateOne', 'updateMany', 'findOneAndUpdate', 'update'])
const STAGES_WITH_QUERY = new Set(['$match'])
const STAGES_WITH_ACCUMULATORS = new Set(['$group', '$bucket', '$bucketAuto', '$setWindowFields'])
const STAGES_WITH_FIELDS = new Set(['$project', '$addFields', '$set', '$sort', '$unset', '$replaceRoot', '$replaceWith', '$fill', '$densify'])

/** The pieces of a member chain ending at token `end`, outermost first. `args` are the token
 *  indexes of a call's parentheses. */
export type ChainPart = { name: string; call: boolean; args?: [number, number]; index?: string }

export function chainBefore(tokens: Token[], end: number): ChainPart[] | undefined {
  const parts: ChainPart[] = []
  let k = end
  while (k >= 0) {
    const t = tokens[k]!
    let part: ChainPart | undefined
    if (t.type === 'punct' && t.value === ')') {
      const open = matchBack(tokens, k, '(', ')')
      if (open < 1) return undefined
      const callee = tokens[open - 1]!
      if (callee.type !== 'ident') return undefined
      part = { name: callee.value, call: true, args: [open, k] }
      k = open - 2
    } else if (t.type === 'punct' && t.value === ']') {
      const open = matchBack(tokens, k, '[', ']')
      if (open < 1) return undefined
      const inner = tokens.slice(open + 1, k)
      part = { name: '[]', call: false, index: inner.length === 1 && inner[0]!.type === 'string' ? unquote(inner[0]!.value) : undefined }
      k = open - 1
      parts.unshift(part)
      continue
    } else if (t.type === 'ident') {
      part = { name: t.value, call: false }
      k -= 1
    } else return undefined
    parts.unshift(part)
    const dot = tokens[k]
    if (!dot || dot.type !== 'punct' || (dot.value !== '.' && dot.value !== '?.')) break
    k--
  }
  return parts
}

function matchBack(tokens: Token[], close: number, openCh: string, closeCh: string): number {
  let depth = 0
  for (let k = close; k >= 0; k--) {
    const v = tokens[k]!
    if (v.type !== 'punct') continue
    if (v.value === closeCh) depth++
    else if (v.value === openCh) {
      depth--
      if (depth === 0) return k
    }
  }
  return -1
}

export function unquote(s: string): string {
  const q = s[0]
  if (q !== '"' && q !== "'") return s
  const body = s.endsWith(q) && s.length > 1 ? s.slice(1, -1) : s.slice(1)
  return body.replace(/\\(.)/g, '$1')
}

/** Which collection and method a chain names: `db.orders.find`, `db.getCollection('x').aggregate`. */
export function chainTarget(parts: ChainPart[], tokens: Token[]): { collection?: string; methods: ChainPart[]; dbOnly: boolean } | undefined {
  if (parts[0]?.name !== 'db' || parts[0].call) return undefined
  let i = 1
  while (parts[i]?.name === 'getSiblingDB' && parts[i]!.call) i++
  const p = parts[i]
  if (!p) return { methods: [], dbOnly: true }
  let collection: string | undefined
  if (p.name === 'getCollection' && p.call && p.args) {
    const inner = tokens.slice(p.args[0] + 1, p.args[1])
    if (inner.length === 1 && inner[0]!.type === 'string') collection = unquote(inner[0]!.value)
  } else if (p.name === '[]') collection = p.index
  else if (!p.call && !DB_METHOD_NAMES.has(p.name)) collection = p.name
  else return { methods: parts.slice(i), dbOnly: true }
  if (collection === undefined) return undefined
  return { collection, methods: parts.slice(i + 1), dbOnly: false }
}

/** Database methods: a name after `db.` that is one of these is not a collection. */
export const DB_METHOD_NAMES = new Set([
  'getName', 'getCollection', 'getCollectionNames', 'getCollectionInfos', 'getSiblingDB', 'createCollection', 'createView',
  'dropDatabase', 'runCommand', 'adminCommand', 'aggregate', 'stats', 'serverStatus', 'hostInfo', 'version', 'currentOp',
  'killOp', 'getUsers', 'getRoles', 'getUser', 'getRole', 'listCommands', 'printCollectionStats', 'getMongo'
])

/** What to offer for a cursor at `offset`. */
export function completionContext(src: string, offset: number): CompletionContext | undefined {
  const tokens = tokenize(src.slice(0, offset), { comments: true })
  const last = tokens[tokens.length - 1]
  if (last?.type === 'comment' && (last.open || !last.value.startsWith('/*'))) return undefined
  if (last && last.type === 'comment' && last.end === offset) return undefined
  const code = tokens.filter((t) => t.type !== 'comment')
  let k = code.length - 1
  let cur = code[k]

  // Inside a string: a key in quotes, or a '$field' path.
  if (cur && cur.type === 'string' && cur.end === offset && (cur.open || cur.value.length === 1)) {
    const quote = cur.value[0] as '"' | "'"
    const prefix = cur.value.slice(1)
    const from = cur.start + 1
    const place = documentPlace(code, k - 1)
    if (prefix.startsWith('$')) {
      if (place?.position === 'value' || place?.position === 'array') return { kind: 'fieldRef', from: from + 1, prefix: prefix.slice(1), collection: place.collection, quote }
    }
    if (place?.position === 'key') return { kind: 'key', from, prefix, collection: place.collection, flavor: place.flavor, quote }
    return undefined
  }
  if (cur && (cur.type === 'string' || cur.type === 'template' || cur.type === 'regex' || cur.type === 'number') && cur.end >= offset) return undefined

  let prefix = ''
  let from = offset
  if (cur && cur.type === 'ident' && cur.end === offset) {
    prefix = cur.value
    from = cur.start
    k--
    cur = code[k]
  }
  if (cur && cur.type === 'punct' && (cur.value === '.' || cur.value === '?.')) {
    const parts = chainBefore(code, k - 1)
    if (!parts) return undefined
    const target = chainTarget(parts, code)
    if (!target) return undefined
    if (target.dbOnly && target.methods.length === 0) return { kind: 'db', from, prefix }
    if (target.dbOnly) return target.methods[target.methods.length - 1]?.name === 'aggregate' ? { kind: 'cursor', from, prefix, cursor: 'aggregate' } : undefined
    if (target.methods.length === 0) return { kind: 'collection', from, prefix, collection: target.collection! }
    const firstCall = target.methods[0]!
    if (firstCall.name === 'find' && target.methods.every((m) => m.call)) return { kind: 'cursor', from, prefix, cursor: 'find' }
    if (firstCall.name === 'aggregate' && target.methods.every((m) => m.call)) return { kind: 'cursor', from, prefix, cursor: 'aggregate' }
    return undefined
  }
  const place = documentPlace(code, k)
  if (place?.position === 'key') return { kind: 'key', from, prefix, collection: place.collection, flavor: place.flavor }
  if (place) {
    // In a value: `$` names are operators only in documents; offer globals otherwise.
    return { kind: 'global', from, prefix }
  }
  if (cur && cur.type === 'ident' && (cur.value === 'use' || cur.value === 'show') && !cur.nl) return undefined
  return { kind: 'global', from, prefix }
}

type Place = { position: 'key' | 'value' | 'array' | 'args'; collection?: string; flavor: KeyFlavor }

/**
 * Where a cursor after token `k` sits in the documents around it: the key or value of a document,
 * an array item, or an argument, and what call the outermost document belongs to.
 */
function documentPlace(tokens: Token[], k: number): Place | undefined {
  // The open brackets around the cursor, innermost last.
  const stack: number[] = []
  for (let j = 0; j <= k; j++) {
    const t = tokens[j]!
    if (t.type !== 'punct') continue
    if (OPEN.has(t.value)) stack.push(j)
    else if (CLOSE.has(t.value)) stack.pop()
    else if (t.value === ';' && stack.length === 0) stack.length = 0
  }
  if (stack.length === 0) return undefined
  const innermost = tokens[stack[stack.length - 1]!]!
  const prev = tokens[k]
  let position: Place['position']
  if (innermost.value === '{') {
    position = prev && prev.type === 'punct' && (prev.value === '{' || prev.value === ',') ? 'key' : 'value'
  } else if (innermost.value === '[') position = 'array'
  else position = 'args'

  // Find the call the brackets belong to: the outermost `(` preceded by a chain on a collection.
  let callIndex = -1
  for (let s = stack.length - 1; s >= 0; s--) {
    const at = stack[s]!
    if (tokens[at]!.value === '(' && tokens[at - 1]?.type === 'ident') {
      const parts = chainBefore(tokens, at - 1)
      const target = parts && chainTarget(parts, tokens)
      if (target && (target.collection !== undefined || target.methods.some((m) => m.name === 'aggregate'))) {
        callIndex = s
        break
      }
    }
  }
  if (callIndex < 0) return { position, flavor: 'fields' }
  const callAt = stack[callIndex]!
  const parts = chainBefore(tokens, callAt - 1)!
  const target = chainTarget(parts, tokens)!
  const method = tokens[callAt - 1]!.value
  const collection = target.collection
  // Which argument of the call, and the keys of the documents between it and the cursor.
  const argIndex = commasAtDepth(tokens, callAt, stack[callIndex + 1] ?? k + 1)
  const keys: (string | null)[] = []
  for (let s = callIndex + 1; s < stack.length; s++) {
    const at = stack[s]!
    if (tokens[at]!.value !== '{') {
      keys.push(null)
      continue
    }
    keys.push(keyBefore(tokens, at))
  }
  const docLevel = keys.length // how many brackets inside the call
  let flavor: KeyFlavor = 'fields'
  if (method === 'aggregate') {
    // aggregate([ { $stage: { ... } } ])
    const stage = keys[2] ?? undefined
    if (docLevel === 2) flavor = 'stage'
    else if (stage && STAGES_WITH_QUERY.has(stage)) flavor = 'query'
    else if (stage && STAGES_WITH_ACCUMULATORS.has(stage)) flavor = docLevel === 3 ? 'fields' : 'accumulator'
    else if (stage && STAGES_WITH_FIELDS.has(stage)) flavor = docLevel === 3 ? (stage === '$sort' || stage === '$unset' ? 'fields' : 'projection') : 'expression'
    else flavor = 'expression'
    if (keys.slice(3).some((x) => x === '$expr')) flavor = 'expression'
  } else if (UPDATE_METHODS.has(method) && argIndex === 1) {
    flavor = docLevel === 1 ? 'update' : 'fields'
  } else if ((method === 'find' || method === 'findOne') && argIndex === 1) {
    flavor = 'projection'
  } else if (FIND_LIKE.has(method) && argIndex === 0) {
    flavor = keys.some((x) => x === '$expr') ? 'expression' : 'query'
  } else if (method === 'sort' || method === 'createIndex' || method === 'hint') {
    flavor = 'fields'
  }
  return { position, collection, flavor }
}

function commasAtDepth(tokens: Token[], open: number, until: number): number {
  let depth = 0
  let n = 0
  for (let j = open + 1; j < until && j < tokens.length; j++) {
    const v = tokens[j]!
    if (v.type !== 'punct') continue
    if (OPEN.has(v.value)) depth++
    else if (CLOSE.has(v.value)) depth--
    else if (v.value === ',' && depth === 0) n++
  }
  return n
}

/** `{ key: {` : the key the document at `open` is the value of. */
function keyBefore(tokens: Token[], open: number): string | null {
  const colon = tokens[open - 1]
  const key = tokens[open - 2]
  if (colon?.value !== ':' || !key) return null
  if (key.type === 'ident') return key.value
  if (key.type === 'string') return unquote(key.value)
  return null
}
