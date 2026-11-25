// The query bar's fields as one shell statement, for Shell mode.
import { assert, describe, test } from 'orca/testing'
import { queryStatement } from './query-statement'
import { readStatement } from './shell-call'

const empty = { filter: '', projection: '', sort: '', collation: '', skip: '', limit: '' }

describe('the query bar as a statement', () => {
  test('an empty query bar is a find of everything, naming the collection with getCollection', () => {
    assert.equal(queryStatement('orders', empty), 'db.getCollection("orders").find({})')
    assert.equal(queryStatement('order "lines"', empty), 'db.getCollection("order \\"lines\\"").find({})')
  })
  test('each field as typed, short on one line and long on several', () => {
    assert.equal(queryStatement('orders', { ...empty, filter: " { status: 'A' } ", projection: '{ total: 1 }', limit: '5' }), `db.getCollection("orders").find({ status: 'A' }, { total: 1 }).limit(5)`)
    const long = queryStatement('orders', { ...empty, filter: "{ status: 'shipped', total: { $gt: 100 } }", sort: '{ createdAt: -1 }', collation: "{ locale: 'fr' }", skip: '20', limit: '10' })
    assert.equal(long, `db.getCollection("orders").find({ status: 'shipped', total: { $gt: 100 } })\n  .sort({ createdAt: -1 })\n  .collation({ locale: 'fr' })\n  .skip(20)\n  .limit(10)`)
  })
  test('what it writes reads back as the same query', () => {
    const r = readStatement(queryStatement('orders', { ...empty, filter: "{ at: { $gt: ISODate('2024-01-01') } }", sort: '{ at: -1 }', skip: '3' }), 'shop')
    assert.equal(r.kind, 'find')
    assert.equal(r.kind === 'find' && r.op.collection, 'orders')
    assert.equal(r.kind === 'find' && r.op.skip, 3)
  })
})
