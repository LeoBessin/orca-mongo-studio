// Format and one-line for the query bar: tokens rearranged, literals and comments kept as typed.
import { assert, describe, test } from 'orca/testing'
import { compactQuery, formatQuery } from './query-format'
import { parseShellDocument } from './shell-parse'

describe('formatQuery', () => {
  test('a document with several keys goes one key per line; short values stay inline', () => {
    assert.equal(formatQuery("{status:'shipped',total:{$gt:100}}"), "{\n  status: 'shipped',\n  total: { $gt: 100 }\n}")
    assert.equal(formatQuery('{a:1}'), '{ a: 1 }')
    assert.equal(formatQuery('{ a: [1,2,3], b: {} }'), '{\n  a: [1, 2, 3],\n  b: {}\n}')
  })

  test('nested documents break when they do not fit, and trailing commas go', () => {
    const text = "{ $or: [ { status: 'shipped', total: { $gte: NumberDecimal('100.5') } }, { createdAt: { $gte: new Date(Date.now() - 86400000) } }, ], name: /^ab/i }"
    assert.equal(
      formatQuery(text),
      [
        '{',
        '  $or: [',
        '    {',
        "      status: 'shipped',",
        "      total: { $gte: NumberDecimal('100.5') }",
        '    },',
        '    { createdAt: { $gte: new Date(Date.now() - 86400000) } }',
        '  ],',
        '  name: /^ab/i',
        '}'
      ].join('\n')
    )
  })

  test('the value is unchanged: literals keep their spelling and dates stay relative', () => {
    const text = `{ a: "x", b: -1, c: ObjectId('6542f1a2b3c4d5e6f7a8b900'), d: { $in: [1, 2.50, NumberLong('3')] }, e: new Date(), f: /a,b/ }`
    const out = formatQuery(text)!
    assert.match(out, /e: new Date\(\)/)
    assert.match(out, /a: "x"/)
    assert.match(out, /b: -1/)
    assert.match(out, /2\.50/)
    assert.deepEqual(parseShellDocument(out, 'filter', { now: 0 }), parseShellDocument(text, 'filter', { now: 0 }))
  })

  test('comments stay where they were', () => {
    assert.equal(formatQuery('{ a: 1, // the a\n b: -1 /* desc */, }'), '{\n  a: 1, // the a\n  b: -1 /* desc */\n}')
    assert.equal(formatQuery('{ // only\n}'), '{\n  // only\n}')
  })

  test('unclosed brackets, strings or comments are not formatted', () => {
    assert.equal(formatQuery('{ a: 1'), undefined)
    assert.equal(formatQuery("{ a: 'x }"), undefined)
    assert.equal(formatQuery('{ a: 1 ]'), undefined)
    assert.equal(formatQuery('{ a: 1 /* x }'), undefined)
    assert.equal(formatQuery('  '), '  ')
  })
})

describe('compactQuery', () => {
  test('puts a formatted value back on one line', () => {
    const text = "{ $or: [{ status: 'shipped' }, { total: { $gt: 1 } }], name: /^ab/i }"
    assert.equal(compactQuery(formatQuery(text)!), text)
  })
  test('line comments become block comments, so the rest of the line still counts', () => {
    assert.equal(compactQuery('{\n  a: 1, // the a */ b\n  b: 2\n}'), '{ a: 1 /* the a * / b */, b: 2 }')
  })
  test('unclosed text is left alone', () => {
    assert.equal(compactQuery('{\n a: [1,'), undefined)
    assert.equal(compactQuery(' \n '), '')
  })
})
