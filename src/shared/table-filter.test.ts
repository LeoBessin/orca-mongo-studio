// Filter by the selected rows: the filter made from table cells, and merging it into a filter.
import { assert, describe, test } from 'orca/testing'
import { filterablePath, filterFromColumns, mergeFilters } from './table-filter'

const oid = (n: number) => ({ $oid: `6542f1a2b3c4d5e6f7a8b9${String(n).padStart(2, '0')}` })

describe('filter from columns', () => {
  test('one value is an equality, several fields are ANDed', () => {
    const r = filterFromColumns([
      { path: 'status', values: ['shipped'] },
      { path: 'country', values: ['FR'] }
    ])
    assert.deepEqual(r.filter, { status: 'shipped', country: 'FR' })
  })

  test('several values of one field are an $in, without repeats, keeping their types', () => {
    const r = filterFromColumns([
      { path: 'status', values: ['shipped', 'paid', 'shipped'] },
      { path: 'owner', values: [oid(1), oid(2), oid(1)] },
      { path: 'qty', values: [{ $numberInt: '1' }, { $numberInt: '1' }, { $numberInt: '1' }] }
    ])
    assert.deepEqual(r.filter, {
      status: { $in: ['shipped', 'paid'] },
      owner: { $in: [oid(1), oid(2)] },
      qty: { $numberInt: '1' }
    })
  })

  test('a missing field is null, which also matches missing', () => {
    assert.deepEqual(filterFromColumns([{ path: 'payment.method', values: [undefined, 'card'] }]).filter, { 'payment.method': { $in: [null, 'card'] } })
    assert.deepEqual(filterFromColumns([{ path: 'note', values: [undefined] }]).filter, { note: null })
  })

  test('a regular expression is matched as itself', () => {
    const re = { $regularExpression: { pattern: '^a', options: '' } }
    assert.deepEqual(filterFromColumns([{ path: 'rule', values: [re] }]).filter, { rule: { $eq: re } })
    assert.match(filterFromColumns([{ path: 'rule', values: [re, 'x'] }]).error!, /select only that row/)
  })

  test('says why it can’t', () => {
    assert.match(filterFromColumns([]).error!, /Choose a column/)
    assert.match(filterFromColumns([{ path: 'a', values: [] }]).error!, /Select the rows/)
    assert.match(filterFromColumns([{ path: 'body', values: [{ $msTruncated: { kind: 'string', size: 9000, preview: 'abc' } }] }]).error!, /body is too long/)
  })
})

describe('merging into a filter', () => {
  test('new fields join, the same condition stays once, a different one goes into $and', () => {
    assert.deepEqual(mergeFilters({}, { a: 1 }), { a: 1 })
    assert.deepEqual(mergeFilters({ a: 1 }, { b: 2 }), { a: 1, b: 2 })
    assert.deepEqual(mergeFilters({ a: 1, b: 2 }, { a: 1 }), { a: 1, b: 2 })
    assert.deepEqual(mergeFilters({ a: { $gt: 1 } }, { a: 5, b: 2 }), { $and: [{ a: { $gt: 1 }, b: 2 }, { a: 5 }] })
  })
})

describe('filterable paths', () => {
  test('names with a dot, a leading $ or nothing are left out', () => {
    assert.ok(filterablePath(['status']))
    assert.ok(filterablePath(['payment', 'method']))
    assert.ok(!filterablePath(['a.b']))
    assert.ok(!filterablePath(['$x']))
    assert.ok(!filterablePath(['']))
  })
})
