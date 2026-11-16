// Reads a shell statement such as `db.orders.find({ status: 'A' }).sort({ at: -1 }).limit(5)` into
// an Operation, for code generation. Arguments must be literals (parsed by shell-parse, never
// evaluated): a statement that uses variables is refused with a reason.
import { isObject, type JsonObject, type JsonValue } from './ejson-view'
import { chainBefore, chainTarget, tokenize, unquote, type ChainPart, type Token } from './js-scan'
import type { Operation } from './operation'
import { parseShell, ShellParseError } from './shell-parse'

export class ShellCallError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ShellCallError'
  }
}

const CURSOR_NOOPS = new Set(['toArray', 'pretty', 'forEach', 'itcount', 'map', 'readPref', 'batchSize', 'maxTimeMS', 'comment', 'allowDiskUse'])

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
      throw new ShellCallError(`The ${what} must be written as a literal value to generate code from it (${error.reason}). Variables and function calls other than BSON constructors can't be read without running the script.`)
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

function count(text: string | undefined, what: string): number {
  const v = text?.trim() ?? ''
  if (!/^\d+$/.test(v)) throw new ShellCallError(`${what} must be a whole number written as a literal.`)
  return Number(v)
}

/** The find or aggregate a statement runs, on `db` unless it names another with getSiblingDB. */
export function operationFromStatement(statement: string, db: string, now?: number): Operation {
  const text = statement.trim().replace(/;\s*$/, '')
  const tokens = tokenize(text)
  if (tokens.length === 0) throw new ShellCallError('Put the cursor in a statement such as db.orders.find({ ... }).')
  const parts = chainBefore(tokens, tokens.length - 1)
  const target = parts && chainTarget(parts, tokens)
  if (!parts || !target || target.collection === undefined) {
    throw new ShellCallError('Code can be generated for db.<collection>.find(...) and db.<collection>.aggregate([...]) statements.')
  }
  for (const p of parts) {
    if (p.name === 'getSiblingDB' && p.call) {
      const arg = tokens.slice(p.args![0] + 1, p.args![1])
      if (arg.length !== 1 || arg[0]!.type !== 'string') throw new ShellCallError('getSiblingDB needs the database name as a string.')
      db = unquote(arg[0]!.value)
    }
  }
  const [first, ...rest] = target.methods
  if (!first?.call) throw new ShellCallError('Code can be generated for db.<collection>.find(...) and db.<collection>.aggregate([...]) statements.')
  const collection = target.collection
  if (first.name === 'aggregate') {
    const args = argTexts(text, tokens, first)
    const pipeline = args[0] === undefined ? [] : literal(args[0], 'pipeline', now)
    if (!Array.isArray(pipeline) || !pipeline.every(isObject)) throw new ShellCallError('The pipeline must be an array of stage documents.')
    for (const m of rest) if (!CURSOR_NOOPS.has(m.name)) throw new ShellCallError(`.${m.name}() after aggregate() is not supported for code generation.`)
    return { kind: 'aggregate', db, collection, pipeline: pipeline as JsonObject[] }
  }
  if (first.name !== 'find' && first.name !== 'findOne') {
    throw new ShellCallError(`Code generation covers find and aggregate; this statement runs ${first.name}().`)
  }
  const args = argTexts(text, tokens, first)
  const op: Operation = { kind: 'find', db, collection, filter: doc(args[0], 'filter', now) ?? {} }
  const projection = doc(args[1], 'projection', now)
  if (projection && Object.keys(projection).length) op.projection = projection
  if (first.name === 'findOne') op.limit = 1
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
      default:
        if (!CURSOR_NOOPS.has(m.name)) throw new ShellCallError(`.${m.name}() is not supported for code generation.`)
    }
  }
  return op
}
