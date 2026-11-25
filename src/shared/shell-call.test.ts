// Shell statements read without running them: each method group, the ways of naming the
// collection, options, and what is refused.
import { assert, describe, test } from 'orca/testing'
import { isShellStatement, readStatement, type StatementRead } from './shell-call'
import { parseShell } from './shell-parse'
import type { JsonObject } from './ejson-view'

const f = (s: string): JsonObject => parseShell(s) as JsonObject
const target = (r: StatementRead): string => {
  const { db, collection } = r.kind === 'find' || r.kind === 'aggregate' ? r.op : r
  return `${db}.${collection}`
}

/** The statement from issue #32, as pasted from Compass. */
const PRODUCTS_AGGREGATE = `db.getCollection("products").aggregate([
  { "$match": { "category": "books", "status": "active",
      "$or": [ { "options.featured": { "$exists": true } }, { "options.on_sale": true } ] } },
  { "$project": { "_id": 0, "title": 1,
      "len": { "$strLenCP": { "$trim": { "input": { "$ifNull": ["$title", ""] } } } } } },
  { "$match": { "len": { "$gt": 40 } } },
  { "$sort": { "len": -1 } }
])`

describe('statements: telling one from a filter', () => {
  test('a statement starts with db. or db[', () => {
    assert.equal(isShellStatement("db.orders.find({ status: 'A' })"), true)
    assert.equal(isShellStatement("  db['my orders'].find()"), true)
    assert.equal(isShellStatement('// pasted\ndb.getCollection("x").find()'), true)
    assert.equal(isShellStatement("{ status: 'A' }"), false)
    assert.equal(isShellStatement('db'), false)
    assert.equal(isShellStatement('dbx.find()'), false)
    assert.equal(isShellStatement(''), false)
  })
})

describe('statements: naming the collection', () => {
  test('db.<collection>, getCollection and getSiblingDB', () => {
    assert.equal(target(readStatement("db.orders.find({ status: 'A' })", 'shop')), 'shop.orders')
    assert.equal(target(readStatement('db.getCollection("order-lines").find()', 'shop')), 'shop.order-lines')
    assert.equal(target(readStatement("db.getSiblingDB('blog').posts.find()", 'shop')), 'blog.posts')
    assert.equal(target(readStatement("db.getSiblingDB('blog').getCollection('post-tags').countDocuments()", 'shop')), 'blog.post-tags')
    assert.equal(target(readStatement("db['orders'].distinct('status')", 'shop')), 'shop.orders')
  })
})

describe('statements: find and findOne', () => {
  test('cursor methods, a trailing ; and no-ops', () => {
    const r = readStatement("db.orders.find({ status: 'A' }).project({ _id: 0 }).sort({ at: -1 }).skip(5).limit(10).collation({ locale: 'fr' }).toArray();", 'shop')
    assert.deepEqual(r, {
      kind: 'find',
      method: 'find',
      op: { kind: 'find', db: 'shop', collection: 'orders', filter: f("{ status: 'A' }"), projection: f('{ _id: 0 }'), sort: f('{ at: -1 }'), skip: 5, limit: 10, collation: f("{ locale: 'fr' }") },
      ignored: []
    })
    assert.equal(readStatement('db.orders.find().pretty().allowDiskUse()', 'shop').kind, 'find')
  })
  test("mongosh's options argument, with what the query bar can't take listed", () => {
    const r = readStatement('db.orders.find({}, { total: 1 }, { sort: { at: 1 }, limit: 3, maxTimeMS: 500 })', 'shop')
    assert.equal(r.kind, 'find')
    if (r.kind !== 'find') return
    assert.deepEqual(r.op.projection, f('{ total: 1 }'))
    assert.deepEqual(r.op.sort, f('{ at: 1 }'))
    assert.equal(r.op.limit, 3)
    assert.deepEqual(r.ignored, ['maxTimeMS'])
  })
  test('findOne is a find with limit 1', () => {
    const r = readStatement("db.users.findOne({ name: 'Ann' })", 'x')
    assert.equal(r.kind === 'find' && r.method, 'findOne')
    assert.equal(r.kind === 'find' && r.op.limit, 1)
  })
})

describe('statements: aggregate', () => {
  test('a pasted Compass statement with quoted keys', () => {
    const r = readStatement(PRODUCTS_AGGREGATE, 'shop')
    assert.equal(r.kind, 'aggregate')
    if (r.kind !== 'aggregate') return
    assert.equal(target(r), 'shop.products')
    assert.deepEqual(r.op.pipeline.map((s) => Object.keys(s)[0]), ['$match', '$project', '$match', '$sort'])
  })
  test('options: allowDiskUse kept, collation kept, the rest listed', () => {
    const r = readStatement("db.orders.aggregate([{ $match: {} }], { allowDiskUse: true, collation: { locale: 'fr' }, maxTimeMS: 100 })", 'shop')
    assert.deepEqual(r.kind === 'aggregate' && r.options, { allowDiskUse: true, collation: f("{ locale: 'fr' }") })
    assert.deepEqual(r.kind === 'aggregate' && r.ignored, ['maxTimeMS'])
    const chained = readStatement('db.orders.aggregate([]).allowDiskUse()', 'shop')
    assert.equal(chained.kind === 'aggregate' && chained.options.allowDiskUse, true)
  })
  test('stages given as separate arguments', () => {
    const r = readStatement("db.orders.aggregate({ $match: { a: 1 } }, { $count: 'n' })", 'shop')
    assert.deepEqual(r.kind === 'aggregate' && r.op.pipeline, [f('{ $match: { a: 1 } }'), f("{ $count: 'n' }")])
  })
})

describe('statements: count and distinct', () => {
  test('countDocuments, count and estimatedDocumentCount', () => {
    assert.deepEqual(readStatement("db.orders.countDocuments({ status: 'A' }, { limit: 100 })", 'shop'), { kind: 'count', method: 'countDocuments', db: 'shop', collection: 'orders', filter: f("{ status: 'A' }"), limit: 100, ignored: [] })
    assert.deepEqual(readStatement('db.orders.count()', 'shop'), { kind: 'count', method: 'count', db: 'shop', collection: 'orders', filter: {}, ignored: [] })
    assert.deepEqual(readStatement('db.orders.estimatedDocumentCount({ maxTimeMS: 100 })', 'shop'), { kind: 'count', method: 'estimatedDocumentCount', db: 'shop', collection: 'orders', filter: {}, ignored: ['maxTimeMS'] })
  })
  test("a cursor's count leaves skip and limit out unless asked; itcount applies them", () => {
    const c = readStatement("db.orders.find({ a: 1 }).skip(2).limit(5).count()", 'shop')
    assert.deepEqual(c.kind === 'count' && [c.filter, c.skip, c.limit], [f('{ a: 1 }'), undefined, undefined])
    const i = readStatement("db.orders.find({ a: 1 }).skip(2).limit(5).itcount()", 'shop')
    assert.deepEqual(i.kind === 'count' && [i.skip, i.limit], [2, 5])
  })
  test('distinct with a filter and a collation', () => {
    assert.deepEqual(readStatement("db.orders.distinct('status', { total: { $gt: 5 } }, { collation: { locale: 'fr' } })", 'shop'), {
      kind: 'distinct',
      db: 'shop',
      collection: 'orders',
      field: 'status',
      filter: f('{ total: { $gt: 5 } }'),
      collation: f("{ locale: 'fr' }"),
      ignored: []
    })
    assert.throws(() => readStatement('db.orders.distinct()', 'shop'), /field's name/)
  })
})

describe('statements: what only the shell runs', () => {
  test('writes are read, never refused, and marked as writes', () => {
    for (const s of ['db.orders.insertOne({ a: 1 })', 'db.orders.deleteMany({})', 'db.orders.updateOne({ a: 1 }, { $set: { b: 2 } })', 'db.orders.findOneAndUpdate({}, { $inc: { n: 1 } })', 'db.orders.drop()', 'db.orders.someNewMethod()']) {
      const r = readStatement(s, 'shop')
      assert.equal(r.kind === 'shell' && r.writes, true, s)
    }
    const r = readStatement('db.orders.getIndexes()', 'shop')
    assert.deepEqual(r, { kind: 'shell', method: 'getIndexes', db: 'shop', collection: 'orders', writes: false })
  })
  test('an updateMany keeps its filter and update for Update many, when they are literals', () => {
    const r = readStatement("db.orders.updateMany({ status: 'A' }, { $set: { status: 'B' } })", 'shop')
    assert.deepEqual(r.kind === 'shell' && r.updateMany, { filter: f("{ status: 'A' }"), update: f("{ $set: { status: 'B' } }") })
    const multi = readStatement("db.orders.update({}, [{ $set: { n: 1 } }], { multi: true })", 'shop')
    assert.deepEqual(multi.kind === 'shell' && multi.updateMany, { filter: {}, update: [f('{ $set: { n: 1 } }')] })
    // Not the same as Update many: one document, an upsert, or values only the script knows.
    for (const s of ["db.orders.updateOne({}, { $set: { a: 1 } })", "db.orders.updateMany({}, { $set: { a: 1 } }, { upsert: true })", 'db.orders.updateMany({ a: x }, { $set: { a: 1 } })']) {
      const x = readStatement(s, 'shop')
      assert.equal(x.kind === 'shell' && x.updateMany, undefined, s)
    }
  })
})

describe('statements: refused', () => {
  test('variables and functions other than BSON constructors', () => {
    assert.throws(() => readStatement('db.users.find({ age: minAge })', 'x'), /literal value.*minAge|literal value/)
    assert.throws(() => readStatement('db.users.aggregate(pipeline)', 'x'), /literal/)
    assert.equal(readStatement("db.users.find({ _id: ObjectId('64b7f0c2a1b2c3d4e5f60718'), at: { $gt: ISODate('2024-01-01') } })", 'x').kind, 'find')
  })
  test('several statements, other code, and cursor methods that need running', () => {
    assert.throws(() => readStatement('db.a.find(); db.b.find()', 'x'), /2 statements/)
    assert.throws(() => readStatement('print(1)', 'x'), /find\(\.\.\.\)/)
    assert.throws(() => readStatement('db.a.find().explain()', 'x'), /explain/)
    assert.throws(() => readStatement('db.a.find().limit(n)', 'x'), /whole number/)
  })
})
