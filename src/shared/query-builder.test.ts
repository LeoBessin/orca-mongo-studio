// Query Builder ↔ filter conversion.
import { assert, describe, test } from 'orca/testing'
import { builderToFilter, filterToBuilder, newCondition, type Group } from './query-builder'
import { parseShell } from './shell-parse'
import type { JsonObject } from './ejson-view'

const group = (join: 'and' | 'or', ...items: Group['items']): Group => ({ kind: 'group', id: 'g', join, items })
const f = (text: string): JsonObject => parseShell(text) as JsonObject

describe('builder → filter', () => {
  test('equality, ranges on one field merge, and bare words are strings', () => {
    const g = group('and', newCondition('status', 'eq', 'shipped'), newCondition('total', 'gte', '100'), newCondition('total', 'lt', '500.5'))
    assert.deepEqual(builderToFilter(g), { filter: f("{ status: 'shipped', total: { $gte: 100, $lt: 500.5 } }"), problems: [] })
  })

  test('OR groups nest, constructors and regexes work in values', () => {
    const g = group(
      'and',
      newCondition('customerId', 'eq', 'ObjectId("6542f1a2b3c4d5e6f7a8b9c0")'),
      group('or', newCondition('email', 'regex', '/@example\\.com$/i'), newCondition('tags', 'in', "['vip', 'beta']"))
    )
    assert.deepEqual(builderToFilter(g).filter, f("{ customerId: ObjectId('6542f1a2b3c4d5e6f7a8b9c0'), $or: [{ email: /@example\\.com$/i }, { tags: { $in: ['vip', 'beta'] } }] }"))
  })

  test('clashing conditions on one field use $and', () => {
    const g = group('and', newCondition('a', 'eq', '1'), newCondition('a', 'ne', '2'))
    assert.deepEqual(builderToFilter(g).filter, f('{ $and: [{ a: 1 }, { a: { $ne: 2 } }] }'))
  })

  test('exists, size and type', () => {
    const g = group('and', newCondition('deletedAt', 'notExists'), newCondition('items', 'size', '3'), newCondition('n', 'type', "'long'"))
    assert.deepEqual(builderToFilter(g).filter, f("{ deletedAt: { $exists: false }, items: { $size: 3 }, n: { $type: 'long' } }"))
  })

  test('incomplete rows are reported, not guessed', () => {
    const missingField = newCondition('', 'eq', '1')
    const badValue = newCondition('a', 'eq', '{ x: ')
    const notList = newCondition('b', 'in', '5')
    const { filter, problems } = builderToFilter(group('and', missingField, badValue, notList))
    assert.deepEqual(filter, {})
    assert.deepEqual(problems.map((p) => p.id), [missingField.id, badValue.id, notList.id])
    assert.match(problems[2]!.message, /takes a list/)
  })

  test('an empty builder is an empty filter', () => {
    assert.deepEqual(builderToFilter(group('and')), { filter: {}, problems: [] })
  })
})

describe('filter → builder', () => {
  const roundTrip = (text: string): void => {
    const filter = f(text)
    const g = filterToBuilder(filter)
    assert.ok(g, `${text} fits the builder`)
    assert.deepEqual(builderToFilter(g).filter, filter, text)
  }

  test('filters that fit come back the same', () => {
    roundTrip("{ status: 'shipped', total: { $gte: 100, $lt: 500 } }")
    roundTrip("{ $or: [{ status: 'A' }, { qty: { $lt: 30 } }] }")
    roundTrip("{ a: 1, $or: [{ b: 2 }, { c: { $in: [1, 2] } }] }")
    roundTrip('{ name: /^al/i, deleted: { $exists: false } }')
    roundTrip("{ createdAt: { $gte: ISODate('2026-01-01T00:00:00Z') } }")
  })

  test('rows show values in shell syntax', () => {
    const g = filterToBuilder(f("{ _id: ObjectId('6542f1a2b3c4d5e6f7a8b9c0'), n: { $gt: NumberLong('5') } }"))!
    assert.deepEqual(
      g.items.map((i) => (i.kind === 'cond' ? [i.field, i.op, i.value] : null)),
      [['_id', 'eq', "ObjectId('6542f1a2b3c4d5e6f7a8b9c0')"], ['n', 'gt', "NumberLong('5')"]]
    )
  })

  test('$regex with $options becomes one regex row', () => {
    const g = filterToBuilder(f("{ name: { $regex: '^a', $options: 'mi' } }"))!
    assert.deepEqual(g.items.map((i) => (i.kind === 'cond' ? i.value : '')), ['/^a/im'])
  })

  test('filters the builder cannot show stay as text', () => {
    assert.equal(filterToBuilder(f('{ $expr: { $gt: ["$a", "$b"] } }')), null)
    assert.equal(filterToBuilder(f('{ a: { $elemMatch: { b: 1 } } }')), null)
    assert.equal(filterToBuilder(f('{ $text: { $search: "x" } }')), null)
  })
})
