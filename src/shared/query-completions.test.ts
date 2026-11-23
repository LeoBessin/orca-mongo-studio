import { assert, describe, test } from 'orca/testing'
import { queryCompletions, queryDiagnostics } from './query-completions'

const labels = (items: { label: string }[]) => items.map((i) => i.label)

describe('query field suggestions', () => {
  test('a filter offers its fields first, then query operators and value helpers', () => {
    const items = labels(queryCompletions('filter', ['_id', 'status']))
    assert.deepEqual(items.slice(0, 2), ['_id', 'status'])
    assert.ok(items.includes('$gt'))
    assert.ok(items.includes('ObjectId'))
    assert.ok(!items.includes('db'))
    assert.ok(!items.includes('$set'))
  })

  test('a sort offers only fields, a collation only its options', () => {
    assert.deepEqual(labels(queryCompletions('sort', ['a', 'b.c'])), ['a', 'b.c'])
    assert.ok(labels(queryCompletions('collation', ['a'])).includes('locale'))
    assert.ok(!labels(queryCompletions('collation', ['a'])).includes('a'))
  })
})

describe('query field problems', () => {
  test('mark the character where parsing stopped', () => {
    assert.deepEqual(queryDiagnostics('filter', '{ a: 1 b: 2 }', 'x'), [{ from: 7, to: 8, message: 'x' }])
  })

  test('mark the last character when the text stops early, and nothing when it parses', () => {
    assert.deepEqual(queryDiagnostics('filter', '{ a: ', 'x'), [{ from: 4, to: 5, message: 'x' }])
    assert.deepEqual(queryDiagnostics('filter', '{ a: 1 }', 'x'), [])
    assert.deepEqual(queryDiagnostics('filter', '  ', 'x'), [])
  })
})
