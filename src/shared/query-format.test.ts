// Format and one line for the query bar: tokens rearranged, never what the text means.
import { assert, describe, test } from 'orca/testing'
import { compactQuery, formatQuery, type FormatResult } from './query-format'
import { parseShellDocument, shellProblem } from './shell-parse'

const text = (r: FormatResult): string => {
  if (!r.ok) throw new Error(r.problem)
  return r.text
}
const problem = (r: FormatResult): string => (r.ok ? `formatted as ${JSON.stringify(r.text)}` : r.problem)
const fmt = (s: string): string => text(formatQuery(s))
const one = (s: string): string => text(compactQuery(s))

describe('formatQuery', () => {
  test('a document with several keys goes one key per line; short values stay inline', () => {
    assert.equal(fmt("{status:'shipped',total:{$gt:100}}"), "{\n  status: 'shipped',\n  total: { $gt: 100 }\n}")
    assert.equal(fmt('{a:1}'), '{ a: 1 }')
    assert.equal(fmt('{ a: [1,2,3], b: {} }'), '{\n  a: [1, 2, 3],\n  b: {}\n}')
  })

  test('nested documents break when they do not fit, and a trailing comma goes', () => {
    const s = "{ $or: [ { status: 'shipped', total: { $gte: NumberDecimal('100.5') } }, { createdAt: { $gte: ISODate('2026-01-02T03:04:05Z') } }, ], name: /^ab/i }"
    assert.equal(
      fmt(s),
      [
        '{',
        '  $or: [',
        '    {',
        "      status: 'shipped',",
        "      total: { $gte: NumberDecimal('100.5') }",
        '    },',
        "    { createdAt: { $gte: ISODate('2026-01-02T03:04:05Z') } }",
        '  ],',
        '  name: /^ab/i',
        '}'
      ].join('\n')
    )
  })

  test('literals keep their spelling, and keys typed together stay together', () => {
    const out = fmt(`{ a: "x", b: -1, c: 2.50, e: new Date(), items.0.price: { $gt: 10 }, stats.2024: -1 }`)
    for (const piece of ['a: "x"', 'b: -1', 'c: 2.50', 'e: new Date()', 'items.0.price: { $gt: 10 }', 'stats.2024: -1']) assert.ok(out.includes(piece), piece)
    assert.equal(one('{ stats.2024: -1 }'), '{ stats.2024: -1 }')
  })

  test('comments stay with the code they describe', () => {
    assert.equal(fmt('{ a: 1, // the a\n b: -1 /* desc */, }'), '{\n  a: 1, // the a\n  b: -1 /* desc */\n}')
    assert.equal(fmt('{ // only\n}'), '{\n  // only\n}')
    assert.equal(fmt('{ a: 1 }\n// trailing'), '{ a: 1 }\n// trailing')
    assert.equal(fmt('{ a: 1,\n// c1\n// c2\n}'), '{\n  a: 1\n  // c1\n  // c2\n}')
    assert.equal(fmt('{\n  // before a\n  a: 1,\n  b: /* inside */ 2\n}'), '{\n  // before a\n  a: 1,\n  b: /* inside */ 2\n}')
  })

  test('refuses what it cannot rearrange without changing it, with where', () => {
    assert.equal(problem(formatQuery('{ a: 1')), 'This { is never closed with } (line 1, column 1)')
    assert.equal(problem(formatQuery("{ a: 'x }")), 'This string is never closed (line 1, column 6)')
    assert.equal(problem(formatQuery('{ a: 1 ]')), 'Expected "}" but found "]" (line 1, column 8)')
    assert.equal(problem(formatQuery('{ a: 1 /* x }')), 'This comment is never closed with */ (line 1, column 8)')
    assert.equal(problem(formatQuery('{ a: [1,,3] }')), 'Nothing before this "," (line 1, column 9)')
    assert.equal(problem(formatQuery('{ a: 1, ,b: 2 }')), 'Nothing before this "," (line 1, column 9)')
    assert.equal(problem(formatQuery('{ , }')), 'Nothing before this "," (line 1, column 3)')
    assert.equal(problem(formatQuery('{a:1}/*x*/,')), 'Only one document fits here; remove the "," (line 1, column 11)')
    assert.equal(fmt('  '), '  ')
  })

  test('large inputs stay fast', () => {
    const ids = Array.from({ length: 2000 }, (_, i) => `ObjectId('${i.toString(16).padStart(24, '0')}')`)
    const started = Date.now()
    const out = fmt(`{ _id: { $in: [${ids.join(', ')}] }, a: { b: { c: { d: { e: [${ids.slice(0, 200).join(',')}] } } } } }`)
    assert.ok(Date.now() - started < 1000, `took ${Date.now() - started} ms`)
    assert.equal(out.split('\n').length > 2000, true)
  })
})

describe('compactQuery', () => {
  test('puts a formatted value back on one line', () => {
    const s = "{ $or: [{ status: 'shipped' }, { total: { $gt: 1 } }], name: /^ab/i }"
    assert.equal(one(fmt(s)), s)
  })
  test('comments become one-line block comments, so the rest of the line still counts', () => {
    assert.equal(one('{\n  a: 1, // the a */ b\n  b: 2\n}'), '{ a: 1 /* the a * / b */, b: 2 }')
    assert.equal(one('{ a: 1 /* multi\n   line */, b: 2 }'), '{ a: 1 /* multi line */, b: 2 }')
    assert.equal(one('{ a: 1,\n// c1\n// c2\n}'), '{ a: 1 /* c1 */ /* c2 */ }')
  })
  test('refuses unclosed text and holes', () => {
    assert.equal(problem(compactQuery('{\n a: [1,')), 'This [ is never closed with ] (line 2, column 5)')
    assert.equal(problem(compactQuery('[1,,2]')), 'Nothing before this "," (line 1, column 4)')
    assert.equal(one(' \n '), '')
  })
})

describe('format and one line never change what a query means', () => {
  const inputs = [
    "{status:'shipped',total:{$gt:100}}",
    '{ items.0.price: { $gt: 10 }, stats.2024: -1, a.b: 1 }',
    "{ $or: [ { a: 1 }, { b: { $in: [1, 2.50, NumberLong('3'), -4] } } ], c: /a,b/i, d: ObjectId('6542f1a2b3c4d5e6f7a8b900') }",
    "{ a: 1, // one\n b: 'two', /* two */\n c: [ // list\n 1, 2 ], d: { e: null } }",
    '{ a: 1 /* multi\nline */, b: 2 }',
    '{ a: 1,\n// c1\n// c2\n}',
    "{ 'quoted key': true, \"d\": false, $expr: { $gt: ['$a', '$b'] } }",
    '{ t: Timestamp({ t: 1, i: 2 }), u: UUID(\'3b241101-e2bb-4255-8caf-4136c566a962\'), n: -1.5e3, x: 0x1f }',
    '{ e: new Date() };'
  ]
  for (const input of inputs) {
    test(JSON.stringify(input).slice(0, 60), () => {
      const expected = parseShellDocument(input, 'filter', { now: 0 })
      for (const out of [fmt(input), one(input), one(fmt(input)), fmt(one(input))]) {
        assert.deepEqual(parseShellDocument(out, 'filter', { now: 0 }), expected, out)
      }
      assert.ok(!one(input).includes('\n'), 'one line is one line')
    })
  }
  test('text the parser rejects is never turned into text it accepts', () => {
    for (const bad of ['{ a: [1,,3] }', '{ a: 1, ,b: 2 }', '{a:1}/*x*/,', '{ , }', '{ a: 1 ]']) {
      assert.ok(shellProblem(bad, 'filter'), bad)
      const f = formatQuery(bad)
      const c = compactQuery(bad)
      if (f.ok) assert.ok(shellProblem(f.text, 'filter'), `format made ${bad} valid`)
      if (c.ok) assert.ok(shellProblem(c.text, 'filter'), `one line made ${bad} valid`)
    }
  })
})
