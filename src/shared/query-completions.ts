// What a query field (filter, projection, sort, collation) suggests as you type, and where its
// problem sits, in the shape Orca's CodeInput takes. Pure; tested in query-completions.test.ts.
import { shellProblem } from './shell-parse'
import { GLOBALS, PROJECTION_OPERATORS, QUERY_OPERATORS, type VocabItem } from './shell-vocab'

export type QueryInputKind = 'filter' | 'projection' | 'sort' | 'collation'

/** Orca's `Completion`; declared here since Orca's typings only have it from catalog 5. */
export type CodeCompletion = { label: string; detail?: string; insert?: string; kind?: 'field' | 'operator' | 'function' | 'keyword' | 'value' }
export type CodeDiagnostic = { from: number; to: number; message: string; tone?: 'danger' | 'warning' }

// The value helpers a query can hold; the shell-only globals (db, print, use) can't appear there.
const VALUE_HELPERS = new Set(['ObjectId', 'ISODate', 'NumberInt', 'NumberLong', 'NumberDecimal', 'Long', 'Int32', 'Double', 'Decimal128', 'Timestamp', 'UUID', 'BinData', 'HexData', 'MinKey', 'MaxKey', 'DBRef'])
const HELPERS: CodeCompletion[] = GLOBALS.filter((g) => VALUE_HELPERS.has(g.label)).map((g) => ({ label: g.label, ...(g.detail ? { detail: g.detail } : {}), kind: 'function' }))
const LITERALS: CodeCompletion[] = ['true', 'false', 'null'].map((label) => ({ label, kind: 'value' }))
const COLLATION_KEYS: CodeCompletion[] = [
  ['locale', "'en', 'fr', 'simple'…"],
  ['strength', '1 base letters … 5 identical'],
  ['caseLevel', 'true: compare case at strength 1 or 2'],
  ['caseFirst', "'upper', 'lower' or 'off'"],
  ['numericOrdering', "true: '10' after '9'"],
  ['alternate', "'non-ignorable' or 'shifted'"],
  ['maxVariable', "'punct' or 'space'"],
  ['backwards', 'true: secondary differences from the end']
].map(([label, detail]) => ({ label: label!, detail: detail!, kind: 'keyword' }))

const operators = (items: VocabItem[], detail: string): CodeCompletion[] => items.map((o) => ({ label: o.label, detail: o.detail ?? detail, kind: 'operator' }))
const QUERY = operators(QUERY_OPERATORS, 'query operator')
const PROJECTION = operators(PROJECTION_OPERATORS, 'projection operator')

/** The suggestions for one field: the document's field names first, then what fits there. */
export function queryCompletions(kind: QueryInputKind, fields: readonly string[]): CodeCompletion[] {
  if (kind === 'collation') return COLLATION_KEYS
  const names: CodeCompletion[] = fields.map((label) => ({ label, detail: 'field', kind: 'field' }))
  switch (kind) {
    case 'filter':
      return [...names, ...QUERY, ...HELPERS, ...LITERALS]
    case 'projection':
      return [...names, ...PROJECTION, ...LITERALS]
    case 'sort':
      return names
  }
}

/** Where the text stops parsing, as one marked character, or none when it parses. */
export function queryDiagnostics(what: string, text: string, message: string, now = Date.now()): CodeDiagnostic[] {
  if (!text.trim()) return []
  const problem = shellProblem(text, what, { now })
  if (!problem) return []
  const from = Math.min(problem.offset, Math.max(0, text.length - 1))
  return [{ from, to: from + 1, message }]
}
