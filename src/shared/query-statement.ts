// The query bar's fields as one shell statement, for the collection tab's Shell mode:
// `db.getCollection("orders").find({ status: 'A' }).sort({ at: -1 }).limit(5)`. The fields' text
// is kept as typed (comments, layout, BSON constructors), not parsed and printed again. Pure.
import type { QueryText } from '../protocol'

/** Past this length a statement puts each cursor method on a line of its own. */
const ONE_LINE_MAX = 80

/** The statement a Shell mode tab starts with and that the query bar's fields stand for. */
export function queryStatement(collection: string, text: QueryText): string {
  const filter = text.filter.trim() || '{}'
  const projection = text.projection.trim()
  const head = `db.getCollection(${JSON.stringify(collection)}).find(${filter}${projection ? `, ${projection}` : ''})`
  const chain = (['sort', 'collation', 'skip', 'limit'] as const).filter((k) => text[k].trim()).map((k) => `.${k}(${text[k].trim()})`)
  const flat = head + chain.join('')
  if (chain.length === 0 || (flat.length <= ONE_LINE_MAX && !flat.includes('\n'))) return flat
  return [head, ...chain.map((c) => `  ${c}`)].join('\n')
}
