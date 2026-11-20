// Sorting a results page in the panel: MongoDB's type order, values compared as their type,
// missing cells last, and ties kept in page order.
import { assert, describe, test } from 'orca/testing'
import type { JsonValue } from './ejson-view'
import { compareValues, sortedOrder } from './table-sort'

const sortValues = (values: (JsonValue | undefined)[], direction: 'asc' | 'desc' = 'asc'): (JsonValue | undefined)[] =>
  sortedOrder(values, direction).map((i) => values[i])

describe('table sort', () => {
  test('numbers compare by value across int, long, double and decimal', () => {
    const values: JsonValue[] = [{ $numberInt: '10' }, { $numberDouble: '9.5' }, { $numberLong: '2' }, 100, { $numberDecimal: '3.25' }, { $numberDouble: 'NaN' }]
    assert.deepEqual(sortValues(values), [{ $numberDouble: 'NaN' }, { $numberLong: '2' }, { $numberDecimal: '3.25' }, { $numberDouble: '9.5' }, { $numberInt: '10' }, 100])
  })

  test('longs past 2^53 still compare exactly', () => {
    assert.equal(compareValues({ $numberLong: '9007199254740993' }, { $numberLong: '9007199254740992' }), 1)
  })

  test('types sort in MongoDB order: null, numbers, strings, objects, arrays, ObjectIds, booleans, dates', () => {
    const date = { $date: { $numberLong: '0' } }
    const id = { $oid: '6542f1a2b3c4d5e6f7a8b900' }
    const values: JsonValue[] = [date, true, id, [1], { a: 1 }, 'b', 2, null]
    assert.deepEqual(sortValues(values), [null, 2, 'b', { a: 1 }, [1], id, true, date])
  })

  test('dates compare by instant, whatever form they come in', () => {
    const a = { $date: '2024-05-01T00:00:00Z' }
    const b = { $date: { $numberLong: String(Date.parse('2023-01-01T00:00:00Z')) } }
    assert.deepEqual(sortValues([a, b]), [b, a])
  })

  test('missing cells go last in both directions, and ties keep page order', () => {
    assert.deepEqual(sortedOrder([undefined, 2, 1, undefined, 2], 'asc'), [2, 1, 4, 0, 3])
    assert.deepEqual(sortedOrder([undefined, 2, 1, undefined, 2], 'desc'), [1, 4, 2, 0, 3])
  })

  test('a cut-short string compares by the part the page kept', () => {
    const cut = { $msTruncated: { kind: 'string', size: 9000, preview: 'aaa' } }
    assert.deepEqual(sortValues(['b', cut]), [cut, 'b'])
  })
})
