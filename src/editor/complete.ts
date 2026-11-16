// Autocomplete for the shell editor: where the cursor is comes from shared/js-scan, what to offer
// from shared/shell-vocab, and collection and field names from the worker (sampled, cached).
import type { Completion, CompletionContext, CompletionResult, EditorView } from './vendor/codemirror.js'
import { completionContext } from '../shared/js-scan'
import { AGGREGATE_CURSOR_METHODS, COLLECTION_METHODS, DB_METHODS, FIND_CURSOR_METHODS, fieldsFit, GLOBALS, operatorsFor, type VocabItem } from '../shared/shell-vocab'

export type Names = { collections: string[]; fields: string[] }
export type NameSource = (collection?: string) => Promise<Names>

const IDENT = /^[A-Za-z_$][A-Za-z0-9_$]*$/
const CACHE_MS = 60_000

function item(v: VocabItem, type: string, boost = 0): Completion {
  return { label: v.label, type, ...(v.detail ? { detail: v.detail } : {}), ...(v.info ? { info: v.info } : {}), boost }
}

function jsString(s: string, quote: string): string {
  return quote + s.replace(/\\/g, '\\\\').replace(new RegExp(quote, 'g'), `\\${quote}`) + quote
}

/** Cached names per connection, database and collection; failures read as none. */
export function cachedNames(load: (collection?: string) => Promise<Names>): NameSource & { clear(): void } {
  const cache = new Map<string, { at: number; value: Promise<Names> }>()
  const fn = (collection?: string): Promise<Names> => {
    const key = collection ?? ''
    const hit = cache.get(key)
    if (hit && Date.now() - hit.at < CACHE_MS) return hit.value
    const value = load(collection).catch(() => ({ collections: [], fields: [] }))
    cache.set(key, { at: Date.now(), value })
    return value
  }
  return Object.assign(fn, { clear: () => cache.clear() })
}

export function shellCompletions(names: () => NameSource | undefined) {
  return async (ctx: CompletionContext): Promise<CompletionResult | null> => {
    const text = ctx.state.doc.toString()
    const place = completionContext(text, ctx.pos)
    if (!place) return null
    if (!ctx.explicit && place.prefix === '' && (place.kind === 'global' || place.kind === 'key')) return null
    const source = names()
    const options: Completion[] = []
    switch (place.kind) {
      case 'global':
        options.push(...GLOBALS.map((v) => item(v, v.label === 'db' ? 'variable' : 'function', v.label === 'db' ? 2 : 0)))
        break
      case 'db': {
        const { collections } = source ? await source() : { collections: [] }
        for (const name of collections) {
          if (IDENT.test(name) && !DB_METHODS.some((d) => d.label === name)) options.push({ label: name, type: 'class', detail: 'collection', boost: 1 })
          else {
            // Not an identifier: db.getCollection('name').
            options.push({
              label: name,
              type: 'class',
              detail: 'collection',
              apply: (view: EditorView, _c: Completion, from: number, to: number) => {
                const insert = `getCollection(${jsString(name, "'")})`
                view.dispatch({ changes: { from, to, insert }, selection: { anchor: from + insert.length } })
              }
            })
          }
        }
        options.push(...DB_METHODS.map((v) => item(v, 'method', -1)))
        break
      }
      case 'collection':
        options.push(...COLLECTION_METHODS.map((v) => item(v, 'method')))
        break
      case 'cursor':
        options.push(...(place.cursor === 'find' ? FIND_CURSOR_METHODS : AGGREGATE_CURSOR_METHODS).map((v) => item(v, 'method')))
        break
      case 'key': {
        if (fieldsFit(place.flavor) && place.collection !== undefined && source) {
          const { fields } = await source(place.collection)
          for (const f of fields) {
            const plain = place.quote !== undefined || IDENT.test(f)
            options.push({ label: f, type: 'property', boost: 1, ...(plain ? {} : { apply: jsString(f, "'") }) })
          }
        }
        if (place.quote === undefined) options.push(...operatorsFor(place.flavor).map((v) => item(v, 'keyword')))
        break
      }
      case 'fieldRef': {
        if (place.collection !== undefined && source) {
          const { fields } = await source(place.collection)
          options.push(...fields.map((f) => ({ label: f, type: 'property' })))
        }
        break
      }
    }
    if (!options.length) return null
    return { from: place.from, options, validFor: /^[\w$]*$/ }
  }
}
