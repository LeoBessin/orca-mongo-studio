// The shell script scanner: statements, the statement under the cursor, autocomplete places.
import { assert, describe, test } from 'orca/testing'
import { completionContext, splitStatements, statementAt, tokenize } from './js-scan'
import { operationFromStatement } from './shell-call'
import { parseShell } from './shell-parse'
import type { JsonObject } from './ejson-view'

const texts = (src: string): string[] => splitStatements(src).map((s) => s.text)
/** Completion context at the `|` marker. */
const at = (src: string) => {
  const offset = src.indexOf('|')
  return completionContext(src.slice(0, offset) + src.slice(offset + 1), offset)
}

describe('tokens', () => {
  test('regex versus division, templates with nested code, comments', () => {
    const t = tokenize('a = b / 2 / c; x = /a\\/b[/]/gi.test(s); `x ${ {a: `y`}.a } z` // done')
    assert.deepEqual(
      t.filter((x) => x.type === 'regex' || x.type === 'template').map((x) => x.value),
      ['/a\\/b[/]/gi', '`x ${ {a: `y`}.a } z`']
    )
    assert.equal(t.filter((x) => x.type === 'punct' && x.value === '/').length, 2)
  })
  test('unfinished strings are open', () => {
    const t = tokenize('db.c.find({ name: "Ad')
    assert.equal(t[t.length - 1]!.open, true)
  })
})

describe('statements', () => {
  test('semicolons and line breaks end statements', () => {
    assert.deepEqual(texts('use shop\ndb.orders.find()\nshow collections; db.x.drop()'), ['use shop', 'db.orders.find()', 'show collections;', 'db.x.drop()'])
  })

  test('chains and open brackets go on across lines', () => {
    const src = `db.orders
  .find({
    status: 'A'
  })
  .sort({ at: -1 })
const total = 1 +
  2
print(total)`
    assert.deepEqual(texts(src), ["db.orders\n  .find({\n    status: 'A'\n  })\n  .sort({ at: -1 })", 'const total = 1 +\n  2', 'print(total)'])
  })

  test('blocks, else, catch and headers without braces', () => {
    const src = `if (x) {
  a()
}
else {
  b()
}
for (const d of docs)
  print(d)
try { f() }
catch (e) { g() }
function h() {
  return 1
}
h()`
    assert.deepEqual(texts(src), ['if (x) {\n  a()\n}\nelse {\n  b()\n}', 'for (const d of docs)\n  print(d)', 'try { f() }\ncatch (e) { g() }', 'function h() {\n  return 1\n}', 'h()'])
  })

  test('comments between statements belong to none, and lines and columns are 1-based', () => {
    const s = splitStatements('// header\n\n  db.a.find() /* note */\n\n// end')
    assert.equal(s.length, 1)
    assert.equal(s[0]!.text, 'db.a.find()')
    assert.equal(s[0]!.line, 3)
    assert.equal(s[0]!.column, 3)
  })

  test('the statement under the cursor', () => {
    const src = 'db.a.find()\n\ndb.b.find({\n  x: 1\n})   \n'
    assert.equal(statementAt(src, src.indexOf('x: 1'))!.text, 'db.b.find({\n  x: 1\n})')
    assert.equal(statementAt(src, src.indexOf('})') + 4)!.text, 'db.b.find({\n  x: 1\n})')
    assert.equal(statementAt(src, 0)!.text, 'db.a.find()')
    assert.equal(statementAt(src, 12), undefined)
  })
})

describe('completion places', () => {
  test('db members, collection members and cursor members', () => {
    assert.deepEqual(at('db.|'), { kind: 'db', from: 3, prefix: '' })
    assert.deepEqual(at('db.ord|'), { kind: 'db', from: 3, prefix: 'ord' })
    assert.deepEqual(at('db.orders.fi|'), { kind: 'collection', from: 10, prefix: 'fi', collection: 'orders' })
    assert.deepEqual(at("db.getCollection('my-c').|"), { kind: 'collection', from: 25, prefix: '', collection: 'my-c' })
    assert.deepEqual(at('db.orders.find({}).so|'), { kind: 'cursor', from: 19, prefix: 'so', cursor: 'find' })
    assert.deepEqual(at('db.orders.aggregate([]).|'), { kind: 'cursor', from: 24, prefix: '', cursor: 'aggregate' })
    assert.equal(at('x.|'), undefined)
  })

  test('keys in a filter, a projection, an update and stages', () => {
    assert.deepEqual(at('db.orders.find({ sta|'), { kind: 'key', from: 17, prefix: 'sta', collection: 'orders', flavor: 'query' })
    assert.equal(at('db.orders.find({ total: { $g| } })')!.kind, 'key')
    assert.equal((at('db.orders.find({ total: { $g| } })') as { flavor: string }).flavor, 'query')
    assert.equal((at('db.orders.find({}, { na| })') as { flavor: string }).flavor, 'projection')
    assert.equal((at('db.orders.updateOne({ a: 1 }, { $s| })') as { flavor: string }).flavor, 'update')
    assert.equal((at('db.orders.updateOne({ a: 1 }, { $set: { st| } })') as { flavor: string }).flavor, 'fields')
    assert.equal((at('db.orders.aggregate([{ $m| }])') as { flavor: string }).flavor, 'stage')
    assert.equal((at('db.orders.aggregate([{ $match: { st| } }])') as { flavor: string }).flavor, 'query')
    assert.equal((at('db.orders.aggregate([{ $group: { _id: null, n: { $s| } } }])') as { flavor: string }).flavor, 'accumulator')
    assert.equal((at('db.orders.find({}).sort({ a| })') as { flavor: string }).flavor, 'fields')
  })

  test('quoted keys and $field paths in strings', () => {
    assert.deepEqual(at("db.orders.find({ 'cust|"), { kind: 'key', from: 18, prefix: 'cust', collection: 'orders', flavor: 'query', quote: "'" })
    assert.deepEqual(at('db.orders.aggregate([{ $group: { _id: "$cu|" } }])'), { kind: 'fieldRef', from: 40, prefix: 'cu', collection: 'orders', quote: '"' })
  })

  test('values, globals and comments', () => {
    assert.deepEqual(at('Obj|'), { kind: 'global', from: 0, prefix: 'Obj' })
    assert.equal(at('db.orders.find({ a: Obj| })')!.kind, 'global')
    assert.equal(at('// db.|'), undefined)
    assert.equal(at('db.orders.find({ a: "x|" })'), undefined)
  })
})

describe('statement → operation', () => {
  const f = (s: string): JsonObject => parseShell(s) as JsonObject
  test('a find with its cursor methods', () => {
    const op = operationFromStatement("db.orders.find({ status: 'A' }, { _id: 0, total: 1 }).sort({ at: -1 }).skip(5).limit(10).collation({ locale: 'fr' });", 'shop')
    assert.deepEqual(op, { kind: 'find', db: 'shop', collection: 'orders', filter: f("{ status: 'A' }"), projection: f('{ _id: 0, total: 1 }'), sort: f('{ at: -1 }'), skip: 5, limit: 10, collation: f("{ locale: 'fr' }") })
  })
  test('an aggregate on a sibling database and a quoted collection', () => {
    const op = operationFromStatement("db.getSiblingDB('blog').getCollection('post-tags').aggregate([{ $match: { n: { $gt: 2 } } }, { $count: 'n' }])", 'shop')
    assert.deepEqual(op, { kind: 'aggregate', db: 'blog', collection: 'post-tags', pipeline: [f('{ $match: { n: { $gt: 2 } } }'), f("{ $count: 'n' }")] })
  })
  test('findOne is a find with limit 1', () => {
    assert.deepEqual(operationFromStatement('db.users.findOne()', 'x'), { kind: 'find', db: 'x', collection: 'users', filter: {}, limit: 1 })
  })
  test('variables and other methods are refused with a reason', () => {
    assert.throws(() => operationFromStatement('db.users.find({ age: minAge })', 'x'), /literal/)
    assert.throws(() => operationFromStatement('db.users.insertOne({ a: 1 })', 'x'), /insertOne/)
    assert.throws(() => operationFromStatement('print(1)', 'x'), /find\(\.\.\.\)/)
  })
})
