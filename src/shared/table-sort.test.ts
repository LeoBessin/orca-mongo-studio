// Sorting a results page in the panel: MongoDB's type order, values compared as their type,
// missing cells last, and ties kept in page order.
import { assert, describe, test } from 'orca/testing'
import type { JsonValue } from './ejson-view'
import { codePointOrder, compareValues, sortedOrder } from './table-sort'

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
    const values: JsonValue[] = [date, true, id, { a: 1 }, 'b', 2, null]
    assert.deepEqual(sortValues(values), [null, 2, 'b', { a: 1 }, id, true, date])
    // A cell's array sorts by an element (see below); arrays inside a value rank as arrays.
    assert.ok(compareValues([1], { a: 1 }) > 0 && compareValues([1], id) < 0)
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

  test('a long past 2^53 against a double, and decimals past 17 digits, compare exactly', () => {
    assert.equal(compareValues({ $numberLong: '9007199254740993' }, { $numberDouble: '9007199254740992' }), 1)
    assert.equal(compareValues({ $numberDecimal: '1.00000000000000000001' }, { $numberDecimal: '1.00000000000000000002' }), -1)
    assert.equal(compareValues({ $numberDecimal: '1E+400' }, { $numberDouble: 'Infinity' }), -1)
    assert.equal(compareValues({ $numberInt: '2' }, { $numberDecimal: '2.0' }), 0)
  })

  test('strings compare by code point, or by the collation given', () => {
    assert.ok(compareValues('\uFF01', '😀') < 0, 'U+FF01 before U+1F600, as UTF-8 bytes order them')
    assert.ok(codePointOrder('B', 'a') < 0)
    const fr = { locale: 'fr', strength: { $numberInt: '2' } }
    assert.deepEqual(sortedOrder(['z', 'é', 'a'], 'asc', fr), [2, 1, 0])
    assert.deepEqual(sortedOrder(['b', 'A', 'a'], 'asc', fr), [1, 2, 0], 'case is ignored at strength 2: ties keep page order')
    assert.deepEqual(sortedOrder(['z', 'é'], 'asc', { locale: 'simple' }), [0, 1])
  })

  test('undefined sorts below null; code and DBPointer by their own rules', () => {
    assert.deepEqual(sortValues([null, { $undefined: true }]), [{ $undefined: true }, null])
    const ptr = (ref: string, n: number) => ({ $dbPointer: { $ref: ref, $id: { $oid: `6542f1a2b3c4d5e6f7a8b9${String(n).padStart(2, '0')}` } } })
    assert.deepEqual(sortValues([ptr('aa.b', 1), ptr('z.b', 2), ptr('aa.b', 0)]), [ptr('z.b', 2), ptr('aa.b', 0), ptr('aa.b', 1)])
    assert.deepEqual(sortValues([{ $code: 'b' }, { $code: 'a', $scope: {} }, { $code: 'c' }]), [{ $code: 'b' }, { $code: 'c' }, { $code: 'a', $scope: {} }])
  })

  test('binary data compares by size, subtype, then bytes; both UUID forms alike', () => {
    const bin = (base64: string, subType = '00') => ({ $binary: { base64, subType } })
    assert.deepEqual(sortValues([bin('/A=='), bin('AA==')]), [bin('AA=='), bin('/A==')], '0x00 before 0xFC')
    const uuid = { $uuid: 'ffffffff-ffff-ffff-ffff-ffffffffffff' }
    assert.deepEqual(sortValues([uuid, bin('AAAAAAAAAAAAAAAAAAAAAA==', '04')]), [bin('AAAAAAAAAAAAAAAAAAAAAA==', '04'), uuid])
  })

  test('cut-short values keep the size and kind they stand for', () => {
    const bigBlob = { $msTruncated: { kind: 'binary', size: 1048576, preview: { $binary: { base64: 'AAAA', subType: '00' } } } }
    const small = { $binary: { base64: 'AAAA'.repeat(10), subType: '00' } }
    assert.deepEqual(sortValues([bigBlob, small]), [small, bigBlob], 'the 1 MB blob after the 30-byte one')
    const longText = { $msTruncated: { kind: 'string', size: 9000, preview: 'abc' } }
    assert.equal(compareValues(longText, 'abc'), 1, 'not a tie with its own prefix')
    const deepDoc = { $msTruncated: { kind: 'object', size: 5, preview: null } }
    assert.deepEqual(sortValues([deepDoc, 'z', 1]), [1, 'z', deepDoc], 'a document cut at depth sorts with documents')
    const bigArray = { $msTruncated: { kind: 'array', size: 300, preview: [1, 2] } }
    assert.deepEqual(sortValues([{ a: bigArray }, { a: { x: 1 } }]), [{ a: { x: 1 } }, { a: bigArray }], 'inside a document, a cut array ranks as an array')
    assert.equal(compareValues(bigArray, [1, 2, 3]), 1, 'by its real length')
  })

  test('a field named $msTruncated is data, not a cut-short marker', () => {
    const stored = { $msTruncated: { preview: 'zzz' }, n: 1 }
    assert.deepEqual(sortValues([stored, 'a']), ['a', stored], 'still a document, after strings')
  })

  test('an array cell sorts by its smallest element ascending and largest descending; an empty one below null', () => {
    assert.deepEqual(sortValues(['c', ['b'], 'a']), ['a', ['b'], 'c'])
    assert.deepEqual(sortValues([['a', 'z'], 'm', 'y'], 'desc'), [['a', 'z'], 'y', 'm'])
    assert.deepEqual(sortValues([null, [], 1, undefined]), [[], null, 1, undefined])
  })
})

