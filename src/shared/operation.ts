// A read operation on one collection, as plain data in canonical Extended JSON: what code
// generation turns into driver code, what SQL translates to, and what the shell recognises in a
// statement such as `db.orders.find({...}).sort({...}).limit(10)`.
import { toShell, toShellInline, type JsonObject } from './ejson-view'

export type FindOperation = {
  kind: 'find'
  db: string
  collection: string
  filter: JsonObject
  projection?: JsonObject
  sort?: JsonObject
  collation?: JsonObject
  /** Omitted or 0: none. */
  skip?: number
  /** Omitted or 0: no limit. */
  limit?: number
}

export type AggregateOperation = {
  kind: 'aggregate'
  db: string
  collection: string
  pipeline: JsonObject[]
}

export type Operation = FindOperation | AggregateOperation

const IDENT = /^[A-Za-z_$][A-Za-z0-9_$]*$/

/** `db.orders`, or `db.getCollection('my-orders')` when the name is not a plain identifier. */
export function shellCollection(collection: string): string {
  const reserved = /^(?:getCollection|getName|getSiblingDB|runCommand|aggregate|stats|constructor|prototype|__proto__)$/
  return IDENT.test(collection) && !reserved.test(collection) && !collection.startsWith('$')
    ? `db.${collection}`
    : `db.getCollection(${toShellInline(collection)})`
}

function shellArg(value: JsonObject | JsonObject[]): string {
  const inline = toShellInline(value)
  return inline.length <= 80 ? inline : toShell(value)
}

/** The operation as one mongosh statement. */
export function operationToShell(op: Operation): string {
  const coll = shellCollection(op.collection)
  if (op.kind === 'aggregate') return `${coll}.aggregate(${shellArg(op.pipeline)})`
  const hasProjection = op.projection && Object.keys(op.projection).length > 0
  let out = `${coll}.find(${shellArg(op.filter)}${hasProjection ? `, ${shellArg(op.projection!)}` : ''})`
  if (op.sort && Object.keys(op.sort).length) out += `\n  .sort(${shellArg(op.sort)})`
  if (op.collation && Object.keys(op.collation).length) out += `\n  .collation(${shellArg(op.collation)})`
  if (op.skip) out += `\n  .skip(${op.skip})`
  if (op.limit) out += `\n  .limit(${op.limit})`
  return out
}
