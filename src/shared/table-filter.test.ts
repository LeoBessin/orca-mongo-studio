// Filter by the selected rows: the filter made from table cells, the projection check, and
// merging into a filter as typed.
import { assert, describe, test } from 'orca/testing'
import type { JsonObject } from './ejson-view'
import { parseShellDocument } from './shell-parse'
import { filterablePath, filterFromRows, mergeFilters, mergeFilterText, projectionKeeps, type FilterColumn } from './table-filter'

const oid = (n: number) => ({ $oid: `6542f1a2b3c4d5e6f7a8b9${String(n).padStart(2, '0')}` })
const col = (name: string): FilterColumn => {
  const [field, sub] = name.split('.') as [string, string?]
  return sub === undefined ? { field, name } : { field, sub, name }
}
const cut = (preview: string) => ({ $msTruncated: { kind: 'string', size: 9000, preview } })

describe('filter from rows', () => {
  test('one value is an equality, several fields are ANDed', () => {
    const r = filterFromRows([{ status: 'shipped', country: 'FR' }], [col('status'), col('country')])
    assert.deepEqual(r.filter, { status: 'shipped', country: 'FR' })
  })

  test('several values of one field are an $in, without repeats, keeping their types', () => {
    const rows: JsonObject[] = [
      { status: 'shipped', owner: oid(1), qty: { $numberInt: '1' } },
      { status: 'paid', owner: oid(2), qty: { $numberInt: '1' } },
      { status: 'shipped', owner: oid(1), qty: { $numberInt: '1' } }
    ]
    assert.deepEqual(filterFromRows(rows, [col('status'), col('owner'), col('qty')]).filter, {
      status: { $in: ['shipped', 'paid'] },
      owner: { $in: [oid(1), oid(2)] },
      qty: { $numberInt: '1' }
    })
  })

  test('a missing field is null, which also matches missing; a sub-document key reads into it', () => {
    assert.deepEqual(filterFromRows([{ payment: 'cash' }, { payment: { method: 'card' } }, {}], [col('payment.method')]).filter, { 'payment.method': { $in: [null, 'card'] } })
    assert.deepEqual(filterFromRows([{}], [col('note')]).filter, { note: null })
  })

  test('a regular expression, or a sub-document with $ keys, is matched as stored', () => {
    const re = { $regularExpression: { pattern: '^a', options: '' } }
    assert.deepEqual(filterFromRows([{ rule: re }], [col('rule')]).filter, { rule: { $eq: re } })
    assert.deepEqual(filterFromRows([{ meta: { $foo: 1 } }], [col('meta')]).filter, { meta: { $eq: { $foo: 1 } } })
    assert.deepEqual(filterFromRows([{ meta: { $foo: 1 } }, { meta: 2 }], [col('meta')]).filter, { meta: { $in: [{ $foo: 1 }, 2] } })
    assert.match(filterFromRows([{ rule: re }, { rule: 'x' }], [col('rule')]).error!, /select only that row/)
  })

  test('refuses what the page doesn’t show as stored', () => {
    const stub = { _id: oid(3), '(document)': { $msTruncated: { kind: 'object', size: 5000, preview: null } } }
    assert.match(filterFromRows([{ status: 'x' }, stub], [col('status')]).error!, /too big to show here/)
    assert.deepEqual(filterFromRows([stub], [col('_id')]).filter, { _id: oid(3) })
    assert.match(filterFromRows([{ payment: [{ method: 'card' }] }], [col('payment.method')]).error!, /payment is an array/)
    assert.match(filterFromRows([{ body: cut('abc') }], [col('body')]).error!, /body is too long/)
    assert.match(filterFromRows([{ tags: ['a', cut('b')] }], [col('tags')]).error!, /tags is too long/)
    // Only the worker's marker counts, not text or keys that look like it.
    assert.deepEqual(filterFromRows([{ s: 'a"$msTruncated' }], [col('s')]).filter, { s: 'a"$msTruncated' })
  })

  test('says what is missing', () => {
    assert.match(filterFromRows([], [col('a')]).error!, /Select the rows/)
    assert.match(filterFromRows([{ a: 1 }], []).error!, /Choose a column/)
  })
})

describe('projections', () => {
  test('a column is usable when the page shows it as stored', () => {
    assert.ok(projectionKeeps(undefined, 'status'))
    assert.ok(projectionKeeps({}, 'status'))
    assert.ok(projectionKeeps({ status: { $numberInt: '1' } }, 'status'))
    assert.ok(projectionKeeps({ status: true }, '_id'))
    assert.ok(projectionKeeps({ payment: { $numberInt: '1' } }, 'payment.method'))
    assert.ok(projectionKeeps({ notes: { $numberInt: '0' } }, 'status'))
  })

  test('not when it changes it', () => {
    assert.ok(!projectionKeeps({ 'payment.method': { $numberInt: '1' } }, 'payment'))
    assert.ok(!projectionKeeps({ 'payment.last4': { $numberInt: '0' } }, 'payment'))
    assert.ok(!projectionKeeps({ items: { $slice: { $numberInt: '2' } } }, 'items'))
    assert.ok(!projectionKeeps({ total: '$amount' }, 'total'))
    assert.ok(!projectionKeeps({ _id: { $numberInt: '0' }, status: { $numberInt: '1' } }, '_id'))
  })
})

describe('merging into a filter', () => {
  test('new fields join, a condition already there stays once, a different one goes into $and', () => {
    assert.deepEqual(mergeFilters({}, { a: 1 }), { a: 1 })
    assert.deepEqual(mergeFilters({ a: 1 }, { b: 2 }), { a: 1, b: 2 })
    assert.equal(mergeFilters({ a: 1, b: 2 }, { a: 1 }), undefined)
    const once = mergeFilters({ a: { $gt: 1 } }, { a: 5, b: 2 })!
    assert.deepEqual(once, { $and: [{ a: { $gt: 1 } }, { a: 5, b: 2 }] })
    assert.equal(mergeFilters(once, { a: 5 }), undefined)
  })

  const merge = (text: string, add: JsonObject) => mergeFilterText(text, parseShellDocument(text, 'filter', { now: 0 }), add)

  test('written into the text as typed, keeping expressions, comments and layout', () => {
    assert.equal(merge('', { a: 1 }), '{ a: 1 }')
    assert.equal(merge('{}', { a: 1 }), '{ a: 1 }')
    assert.equal(merge('{ createdAt: { $gt: new Date() } } // since now', { status: 'x' }), "{ createdAt: { $gt: new Date() }, status: 'x' } // since now")
    assert.equal(merge('{\n  a: 1, // first\n}', { b: 2 }), '{\n  a: 1, b: 2 // first\n}')
    assert.equal(merge('{ a: 1 // first\n}', { b: 2 }), '{ a: 1, b: 2 // first\n}')
  })

  test('a clash wraps the text in $and, and adding it again changes nothing', () => {
    const once = merge('{ at: { $gt: new Date() } }', { at: { $date: { $numberLong: '0' } } })!
    assert.equal(once, "{ $and: [{ at: { $gt: new Date() } }, { at: ISODate('1970-01-01T00:00:00Z') }] }")
    assert.equal(merge(once, { at: { $date: { $numberLong: '0' } } }), undefined)
    // Both sides are canonical, as the page and the parsed filter are.
    assert.equal(merge('{ a: 1 }', { a: { $numberInt: '1' } }), undefined)
  })
})

describe('filterable columns', () => {
  test('names with a dot, a leading $, nothing, or past 1,000 characters are left out', () => {
    assert.ok(filterablePath(col('status')))
    assert.ok(filterablePath(col('payment.method')))
    assert.ok(!filterablePath({ field: 'a.b', name: 'a.b' }))
    assert.ok(!filterablePath(col('$x')))
    assert.ok(!filterablePath({ field: '', name: '' }))
    assert.ok(!filterablePath(col('x'.repeat(1001))))
  })
})
