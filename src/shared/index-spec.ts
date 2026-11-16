// The index manager's form: key rows (field and kind) plus options, checked and turned into the
// key and options `createIndexes` takes, as canonical Extended JSON. Also the mongosh command
// that does the same, and the name MongoDB gives an index by default.
import { isObject, shellString, toShellInline, type JsonObject, type JsonValue } from './ejson-view'
import { parseShellDocument, ShellParseError } from './shell-parse'

export type IndexKeyKind = '1' | '-1' | 'text' | '2dsphere' | '2d' | 'hashed' | 'wildcard'

export const INDEX_KIND_OPTIONS: { value: IndexKeyKind; label: string }[] = [
  { value: '1', label: 'Ascending (1)' },
  { value: '-1', label: 'Descending (-1)' },
  { value: 'text', label: 'Text' },
  { value: '2dsphere', label: '2dsphere (GeoJSON)' },
  { value: '2d', label: '2d (flat pairs)' },
  { value: 'hashed', label: 'Hashed' },
  { value: 'wildcard', label: 'Wildcard ($**)' }
]

export type IndexKeyRow = { id: string; field: string; kind: IndexKeyKind }

export type IndexDraft = {
  keys: IndexKeyRow[]
  name: string
  unique: boolean
  sparse: boolean
  hidden: boolean
  /** Seconds, as typed; empty for no TTL. */
  ttl: string
  /** Shell syntax documents, empty when unset. */
  partial: string
  collation: string
  wildcardProjection: string
  weights: string
  defaultLanguage: string
  languageOverride: string
  /** Any other options, as a shell document (`{ bits: 26 }`). */
  extra: string
}

export type IndexDraftField = keyof Omit<IndexDraft, 'keys'> | 'keys'
export type IndexBuild = { key?: JsonObject; options?: JsonObject; errors: Partial<Record<IndexDraftField, string>> }

export function emptyIndexDraft(): IndexDraft {
  return { keys: [{ id: 'k1', field: '', kind: '1' }], name: '', unique: false, sparse: false, hidden: false, ttl: '', partial: '', collation: '', wildcardProjection: '', weights: '', defaultLanguage: '', languageOverride: '', extra: '' }
}

const KNOWN_OPTIONS = new Set(['name', 'unique', 'sparse', 'hidden', 'expireAfterSeconds', 'partialFilterExpression', 'collation', 'wildcardProjection', 'weights', 'default_language', 'language_override', 'textIndexVersion', '2dsphereIndexVersion', 'bits', 'min', 'max', 'storageEngine', 'clustered'])
/** Options `createIndexes` accepts from the form's "other options". */
export const EXTRA_OPTIONS = ['textIndexVersion', '2dsphereIndexVersion', 'bits', 'min', 'max', 'storageEngine']

/** The key path of a row: wildcard rows put `$**` under the field, or alone. */
export function keyField(row: IndexKeyRow): string {
  const f = row.field.trim()
  if (row.kind !== 'wildcard') return f
  return f ? `${f}.$**` : '$**'
}

function keyValue(kind: IndexKeyKind): JsonValue {
  if (kind === '1' || kind === 'wildcard') return { $numberInt: '1' }
  if (kind === '-1') return { $numberInt: '-1' }
  return kind
}

/** MongoDB's default name: each field and its value joined by `_` (`email_1_name_-1`). */
export function defaultIndexName(key: JsonObject): string {
  return Object.entries(key)
    .map(([f, v]) => `${f}_${isObject(v) ? String(v.$numberInt ?? v.$numberDouble ?? v.$numberLong ?? '1') : String(v)}`)
    .join('_')
}

export function buildIndex(draft: IndexDraft, now = Date.now()): IndexBuild {
  const errors: IndexBuild['errors'] = {}
  const key: JsonObject = {}
  const rows = draft.keys.filter((r) => r.field.trim() || r.kind === 'wildcard')
  if (rows.length === 0) errors.keys = 'Add at least one field.'
  const kinds = rows.map((r) => r.kind)
  for (const r of rows) {
    const f = keyField(r)
    if (f.startsWith('$') && f !== '$**') errors.keys = `"${f}" is not a field name: names can't start with $.`
    else if (/\.\.|^\.|\.$/.test(r.field.trim())) errors.keys = `"${r.field.trim()}" has an empty part between dots.`
    else if (f in key) errors.keys = `${f} is in the key twice.`
    else key[f] = keyValue(r.kind)
  }
  const count = (k: IndexKeyKind) => kinds.filter((x) => x === k).length
  if (!errors.keys) {
    if (count('wildcard') > 1) errors.keys = 'An index has one wildcard field at most.'
    else if (count('hashed') > 1) errors.keys = 'An index has one hashed field at most.'
    else if (count('2d') > 1) errors.keys = 'An index has one 2d field at most.'
    else if (count('2d') && kinds[0] !== '2d') errors.keys = 'The 2d field comes first in a compound index.'
    else if (count('wildcard') && kinds.some((k) => k === 'text' || k === 'hashed' || k === '2d' || k === '2dsphere')) errors.keys = 'A wildcard index can be compound only with ascending and descending fields.'
  }

  const options: JsonObject = {}
  const name = draft.name.trim()
  if (name) {
    if (name === '*') errors.name = 'An index can\'t be named "*".'
    else options.name = name
  }
  if (draft.unique) {
    if (count('hashed') || count('wildcard') || count('text')) errors.unique = 'Hashed, wildcard and text indexes can\'t be unique.'
    else options.unique = true
  }
  if (draft.sparse) options.sparse = true
  if (draft.hidden) options.hidden = true
  const ttl = draft.ttl.trim()
  if (ttl) {
    if (!/^\d+$/.test(ttl) || Number(ttl) > 2147483647) errors.ttl = 'TTL is a whole number of seconds, 0 to 2147483647.'
    else if (rows.length !== 1 || (kinds[0] !== '1' && kinds[0] !== '-1')) errors.ttl = 'A TTL index has one ascending or descending field (a date).'
    else if (keyField(rows[0]!) === '_id') errors.ttl = 'The _id index can\'t expire documents.'
    else options.expireAfterSeconds = { $numberInt: ttl }
  }
  const doc = (field: 'partial' | 'collation' | 'wildcardProjection' | 'weights' | 'extra', what: string): JsonObject | undefined => {
    const text = draft[field].trim()
    if (!text) return undefined
    try {
      return parseShellDocument(text, what, { now })
    } catch (error) {
      errors[field] = error instanceof ShellParseError ? error.message : String(error)
      return undefined
    }
  }
  const partial = doc('partial', 'partial filter')
  if (partial) {
    if (draft.sparse) errors.partial = 'Use a partial filter or sparse, not both.'
    else options.partialFilterExpression = partial
  }
  const collation = doc('collation', 'collation')
  if (collation) {
    if (typeof collation.locale !== 'string') errors.collation = 'A collation needs a locale, such as { locale: \'en\', strength: 2 }.'
    else options.collation = collation
  }
  const wp = doc('wildcardProjection', 'wildcard projection')
  if (wp) {
    if (!rows.some((r) => r.kind === 'wildcard' && !r.field.trim())) errors.wildcardProjection = 'A wildcard projection goes with a wildcard index on all fields ($**).'
    else options.wildcardProjection = wp
  }
  const weights = doc('weights', 'weights')
  if (weights) {
    if (!count('text')) errors.weights = 'Weights are for text indexes.'
    else options.weights = weights
  }
  if (draft.defaultLanguage.trim()) {
    if (!count('text')) errors.defaultLanguage = 'The default language is for text indexes.'
    else options.default_language = draft.defaultLanguage.trim()
  }
  if (draft.languageOverride.trim()) {
    if (!count('text')) errors.languageOverride = 'The language field is for text indexes.'
    else options.language_override = draft.languageOverride.trim()
  }
  const extra = doc('extra', 'other options')
  if (extra) {
    for (const [k, v] of Object.entries(extra)) {
      if (k in options) errors.extra = `${k} is set above already.`
      else if (!KNOWN_OPTIONS.has(k)) errors.extra = `${k} is not an index option Mongo Studio knows. Known here: ${EXTRA_OPTIONS.join(', ')}.`
      else options[k] = v
    }
  }
  if (Object.keys(errors).length) return { errors }
  return { key, options, errors }
}

/** The mongosh command for the index. */
export function createIndexCommand(collection: string, key: JsonObject, options: JsonObject): string {
  const coll = /^[A-Za-z_][A-Za-z0-9_]*$/.test(collection) && !collection.startsWith('system') ? `db.${collection}` : `db.getCollection(${shellString(collection)})`
  const opts = Object.keys(options).length ? `, ${toShellInline(options)}` : ''
  return `${coll}.createIndex(${toShellInline(key)}${opts})`
}

/** Checks options the worker passes on to `createIndexes`: only names it knows. */
export function unknownIndexOptions(options: JsonObject): string[] {
  return Object.keys(options).filter((k) => !KNOWN_OPTIONS.has(k))
}
