// Reads one shell statement, such as `db.orders.find({ status: 'A' }).sort({ at: -1 }).limit(5)`,
// into what it would do: a find or an aggregate (an Operation, for code generation and the query
// bar), a count, a distinct, or a method only the Mongo Shell runs. Arguments must be literals
// (parsed by shell-parse, never evaluated): a statement that uses variables is refused with a
// reason. The Mongo Shell editor loads this module unbundled, so it imports nothing new.
import { isObject, type JsonObject, type JsonValue } from './ejson-view'
import { chainBefore, chainTarget, splitStatements, tokenize, unquote, type ChainPart, type Token } from './js-scan'
import type { AggregateOperation, FindOperation, Operation } from './operation'
import { parseShell, ShellParseError } from './shell-parse'

export class ShellCallError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ShellCallError'
  }
}

const CURSOR_NOOPS = new Set(['toArray', 'pretty', 'forEach', 'map', 'readPref', 'batchSize', 'maxTimeMS', 'comment', 'allowDiskUse', 'noCursorTimeout', 'hint'])

/** What a statement does, read without running it. */
export type StatementRead =
  | { kind: 'find'; method: 'find' | 'findOne'; op: FindOperation; ignored: string[] }
  | { kind: 'aggregate'; op: AggregateOperation; options: AggregateReadOptions; ignored: string[] }
  | { kind: 'count'; method: CountMethod; db: string; collection: string; filter: JsonObject; skip?: number; limit?: number; collation?: JsonObject; ignored: string[] }
  | { kind: 'distinct'; db: string; collection: string; field: string; filter: JsonObject; collation?: JsonObject; ignored: string[] }
  /** A method only the Mongo Shell runs; `writes` unless it is one known to only read.
   *  `updateMany` keeps its filter and update when both are literals. */
  | { kind: 'shell'; method: string; db: string; collection: string; writes: boolean; updateMany?: { filter: JsonObject; update: JsonObject | JsonObject[] } }

export type AggregateReadOptions = { allowDiskUse?: boolean; collation?: JsonObject }
export type CountMethod = 'countDocuments' | 'count' | 'estimatedDocumentCount'

/** Collection methods that only read but that only the Mongo Shell runs. Any other is taken to
 *  write, like a command read-only connections don't know. */
const SHELL_READS = new Set([
  'getIndexes', 'getIndexKeys', 'getIndexSpecs', 'indexInformation', 'listIndexes', 'getSearchIndexes', 'stats', 'dataSize',
  'storageSize', 'totalSize', 'totalIndexSize', 'latencyStats', 'getShardDistribution', 'getShardVersion', 'isCapped',
  'exists', 'getName', 'getFullName', 'getDB', 'getMongo', 'explain', 'watch', 'validate', 'analyzeShardKey'
])

const READS = 'db.<collection>.find(...), findOne, aggregate([...]), countDocuments, count, estimatedDocumentCount and distinct'

function argTexts(text: string, tokens: Token[], part: ChainPart): string[] {
  const [open, close] = part.args!
  if (close === open + 1) return []
  const out: string[] = []
  let depth = 0
  let from = tokens[open]!.end
  for (let j = open + 1; j < close; j++) {
    const t = tokens[j]!
    if (t.type !== 'punct') continue
    if (t.value === '(' || t.value === '[' || t.value === '{') depth++
    else if (t.value === ')' || t.value === ']' || t.value === '}') depth--
    else if (t.value === ',' && depth === 0) {
      out.push(text.slice(from, t.start))
      from = t.end
    }
  }
  const lastText = text.slice(from, tokens[close]!.start)
  if (lastText.trim() || out.length === 0) out.push(lastText)
  return out
}

function literal(text: string, what: string, now: number | undefined): JsonValue {
  try {
    return parseShell(text, now === undefined ? {} : { now })
  } catch (error) {
    if (error instanceof ShellParseError) {
      throw new ShellCallError(`The ${what} must be written as a literal value (${error.reason}). Variables and function calls other than BSON constructors can't be read without running the script.`)
    }
    throw error
  }
}

function doc(text: string | undefined, what: string, now: number | undefined): JsonObject | undefined {
  if (text === undefined || !text.trim()) return undefined
  const v = literal(text, what, now)
  if (!isObject(v)) throw new ShellCallError(`The ${what} must be a document in { }.`)
  return v
}

/** A whole number from an argument's text, or from a literal option value, which parses as
 *  canonical Extended JSON (`{ $numberInt: '5' }`). */
function count(value: JsonValue | string | undefined, what: string): number {
  const number = isObject(value) ? (value.$numberInt ?? value.$numberLong ?? value.$numberDouble) : value
  const v = typeof number === 'string' ? number.trim() : typeof number === 'number' ? String(number) : ''
  if (!/^\d+$/.test(v)) throw new ShellCallError(`${what} must be a whole number written as a literal.`)
  return Number(v)
}

/** A literal's value, or undefined when it isn't one: for the arguments of a method only the
 *  shell runs, which are kept only when they can be. */
function maybe(text: string | undefined, now: number | undefined): JsonValue | undefined {
  if (text === undefined || !text.trim()) return undefined
  try {
    return parseShell(text, now === undefined ? {} : { now })
  } catch {
    return undefined
  }
}

/** Whether text is a shell statement on `db` rather than a document: what tells a statement pasted
 *  into the query bar's filter from a filter. */
export function isShellStatement(text: string): boolean {
  const tokens = tokenize(text)
  const next = tokens[1]
  return tokens[0]?.type === 'ident' && tokens[0].value === 'db' && next?.type === 'punct' && (next.value === '.' || next.value === '?.' || next.value === '[')
}

/** What one statement does, on `db` unless it names another with getSiblingDB. */
export function readStatement(statement: string, db: string, now?: number): StatementRead {
  const statements = splitStatements(statement)
  if (statements.length > 1) throw new ShellCallError(`This holds ${statements.length} statements. Give one statement at a time.`)
  const text = statement.trim().replace(/;\s*$/, '')
  const tokens = tokenize(text)
  if (tokens.length === 0) throw new ShellCallError('Write a statement such as db.orders.find({ ... }).')
  const parts = chainBefore(tokens, tokens.length - 1)
  const target = parts && chainTarget(parts, tokens)
  if (!parts || !target || target.collection === undefined) throw new ShellCallError(`Statements read without running them are ${READS}.`)
  for (const p of parts) {
    if (p.name === 'getSiblingDB' && p.call) {
      const arg = tokens.slice(p.args![0] + 1, p.args![1])
      if (arg.length !== 1 || arg[0]!.type !== 'string') throw new ShellCallError('getSiblingDB needs the database name as a string.')
      db = unquote(arg[0]!.value)
    }
  }
  const [first, ...rest] = target.methods
  if (!first?.call) throw new ShellCallError(`Statements read without running them are ${READS}.`)
  const collection = target.collection
  const args = argTexts(text, tokens, first)
  switch (first.name) {
    case 'aggregate':
      return readAggregate(text, tokens, args, rest, db, collection, now)
    case 'find':
    case 'findOne':
      return readFind(text, tokens, first.name, args, rest, db, collection, now)
    case 'countDocuments':
    case 'count':
    case 'estimatedDocumentCount': {
      noMore(rest, first.name)
      const filter = first.name === 'estimatedDocumentCount' ? {} : (doc(args[0], 'filter', now) ?? {})
      const ignored: string[] = []
      const out: Extract<StatementRead, { kind: 'count' }> = { kind: 'count', method: first.name, db, collection, filter, ignored }
      const options = doc(first.name === 'estimatedDocumentCount' ? args[0] : args[1], 'options', now) ?? {}
      for (const [k, v] of Object.entries(options)) {
        if (first.name !== 'estimatedDocumentCount' && (k === 'skip' || k === 'limit')) out[k] = count(v, k === 'skip' ? 'Skip' : 'Limit')
        else if (first.name !== 'estimatedDocumentCount' && k === 'collation' && isObject(v)) out.collation = v
        else ignored.push(k)
      }
      return out
    }
    case 'distinct': {
      noMore(rest, 'distinct')
      const field = args[0] === undefined ? undefined : literal(args[0], 'field name', now)
      if (typeof field !== 'string' || !field) throw new ShellCallError("distinct needs the field's name as a string, like distinct('status').")
      const out: Extract<StatementRead, { kind: 'distinct' }> = { kind: 'distinct', db, collection, field, filter: doc(args[1], 'filter', now) ?? {}, ignored: [] }
      for (const [k, v] of Object.entries(doc(args[2], 'options', now) ?? {})) {
        if (k === 'collation' && isObject(v)) out.collation = v
        else out.ignored.push(k)
      }
      return out
    }
    default: {
      const out: Extract<StatementRead, { kind: 'shell' }> = { kind: 'shell', method: first.name, db, collection, writes: !SHELL_READS.has(first.name) }
      const options = maybe(args[2], now)
      const multi = first.name === 'updateMany' || (first.name === 'update' && isObject(options) && options.multi === true)
      // Update many changes every match and never upserts or filters arrays: only an update that
      // does the same is offered there.
      const plain = options === undefined || (isObject(options) && Object.keys(options).every((k) => k === 'multi' || (k === 'upsert' && options[k] === false)))
      if (multi && plain && rest.length === 0) {
        const filter = maybe(args[0], now)
        const update = maybe(args[1], now)
        if (isObject(filter) && (isObject(update) || (Array.isArray(update) && update.every(isObject)))) out.updateMany = { filter, update: update as JsonObject | JsonObject[] }
      }
      return out
    }
  }
}

function noMore(rest: ChainPart[], method: string): void {
  const extra = rest.find((m) => !CURSOR_NOOPS.has(m.name))
  if (extra) throw new ShellCallError(`.${extra.name}() after ${method}() can't be read without running it.`)
}

function readAggregate(text: string, tokens: Token[], args: string[], rest: ChainPart[], db: string, collection: string, now: number | undefined): StatementRead {
  const value = args[0] === undefined ? [] : literal(args[0], 'pipeline', now)
  // The shell also takes the stages as separate arguments: aggregate({ $match: … }, { $group: … }).
  const spread = !Array.isArray(value) && isObject(value) && Object.keys(value).length === 1 && Object.keys(value)[0]!.startsWith('$')
  const pipeline = spread ? args.map((a) => literal(a, 'pipeline', now)) : value
  if (!Array.isArray(pipeline) || !pipeline.every(isObject)) throw new ShellCallError('The pipeline must be an array of stage documents.')
  const options: AggregateReadOptions = {}
  const ignored: string[] = []
  for (const [k, v] of Object.entries((spread ? undefined : doc(args[1], 'options', now)) ?? {})) {
    if (k === 'allowDiskUse' && typeof v === 'boolean') options.allowDiskUse = v
    else if (k === 'collation' && isObject(v)) options.collation = v
    else ignored.push(k)
  }
  for (const m of rest) {
    if (m.name === 'allowDiskUse' && m.call) {
      const a = argTexts(text, tokens, m)
      options.allowDiskUse = a[0] === undefined ? true : literal(a[0], 'allowDiskUse', now) !== false
    } else if (!CURSOR_NOOPS.has(m.name)) throw new ShellCallError(`.${m.name}() after aggregate() can't be read without running it.`)
  }
  return { kind: 'aggregate', op: { kind: 'aggregate', db, collection, pipeline: pipeline as JsonObject[] }, options, ignored }
}

function readFind(text: string, tokens: Token[], method: 'find' | 'findOne', args: string[], rest: ChainPart[], db: string, collection: string, now: number | undefined): StatementRead {
  const op: FindOperation = { kind: 'find', db, collection, filter: doc(args[0], 'filter', now) ?? {} }
  const ignored: string[] = []
  const projection = doc(args[1], 'projection', now)
  if (projection && Object.keys(projection).length) op.projection = projection
  // mongosh's third argument: the options of the find command.
  for (const [k, v] of Object.entries(doc(args[2], 'options', now) ?? {})) {
    if ((k === 'projection' || k === 'sort' || k === 'collation') && isObject(v)) op[k] = v
    else if (k === 'skip' || k === 'limit') op[k] = count(v, k === 'skip' ? 'Skip' : 'Limit')
    else ignored.push(k)
  }
  if (method === 'findOne') op.limit = 1
  for (const m of rest) {
    if (!m.call) throw new ShellCallError(`.${m.name} is not a cursor method.`)
    const a = argTexts(text, tokens, m)
    switch (m.name) {
      case 'sort':
        op.sort = doc(a[0], 'sort', now)
        break
      case 'project':
      case 'projection':
        op.projection = doc(a[0], 'projection', now)
        break
      case 'collation':
        op.collation = doc(a[0], 'collation', now)
        break
      case 'skip':
        op.skip = count(a[0], 'Skip')
        break
      case 'limit':
        op.limit = count(a[0], 'Limit')
        break
      case 'count':
      case 'itcount':
      case 'size': {
        if (method === 'findOne') throw new ShellCallError(`findOne() returns a document, not a cursor: .${m.name}() can't follow it.`)
        const after = rest.slice(rest.indexOf(m) + 1)
        noMore(after, m.name)
        // count() leaves the cursor's skip and limit out unless told otherwise; the others apply them.
        const applied = m.name !== 'count' || maybe(a[0], now) === true
        const out: Extract<StatementRead, { kind: 'count' }> = { kind: 'count', method: 'count', db, collection, filter: op.filter, ignored }
        if (op.collation) out.collation = op.collation
        if (applied && op.skip) out.skip = op.skip
        if (applied && op.limit) out.limit = op.limit
        return out
      }
      default:
        if (!CURSOR_NOOPS.has(m.name)) throw new ShellCallError(`.${m.name}() after ${method}() can't be read without running it.`)
    }
  }
  return { kind: 'find', method, op, ignored }
}

/** The find or aggregate a statement runs, for code generation. */
export function operationFromStatement(statement: string, db: string, now?: number): Operation {
  const r = readStatement(statement, db, now)
  if (r.kind === 'find' || r.kind === 'aggregate') return r.op
  const method = r.kind === 'shell' || r.kind === 'count' ? r.method : r.kind
  throw new ShellCallError(`Code generation covers find and aggregate; this statement runs ${method}().`)
}
