// Golden tests for the shell literal parser: what people type, and where errors point.
import { assert, describe, test } from 'orca/testing'
import { compareKey } from './compare'
import { rowDocument } from './csv'
import { toRelaxed, toShell, toShellInline, type JsonObject } from './ejson-view'
import { parseShell, parseShellDocument, ShellParseError, shellProblem } from './shell-parse'

const ok = (text: string, expected: unknown, now?: number): void => {
  assert.deepEqual(parseShell(text, now === undefined ? {} : { now }), expected, text)
}

function err(text: string): ShellParseError {
  try {
    parseShell(text)
  } catch (error) {
    if (error instanceof ShellParseError) return error
    throw error
  }
  assert.fail(`expected "${text}" to fail`)
}

describe('shell parser: valid input', () => {
  test('JSON and shell object syntax', () => {
    ok('{"a": 1}', { a: { $numberInt: '1' } })
    ok("{ a: 'x', b: \"y\", $or: [], 'c d': true, e: null, f: false, }", { a: 'x', b: 'y', $or: [], 'c d': true, e: null, f: false })
    ok('{ items.sku: 1 }', { 'items.sku': { $numberInt: '1' } })
    ok('[1, 2,]', [{ $numberInt: '1' }, { $numberInt: '2' }])
    ok('{} ;', {})
  })

  test('comments and whitespace', () => {
    ok('// find\n{ a: /* inline */ 1 } // done', { a: { $numberInt: '1' } })
  })

  test('numbers keep the type the shell gives them', () => {
    ok('42', { $numberInt: '42' })
    ok('-7', { $numberInt: '-7' })
    ok('2147483648', { $numberDouble: '2147483648.0' })
    ok('3.0', { $numberDouble: '3.0' })
    ok('1.5', { $numberDouble: '1.5' })
    ok('1e3', { $numberDouble: '1000.0' })
    ok('.5', { $numberDouble: '0.5' })
    ok('0x1F', { $numberInt: '31' })
    ok('-Infinity', { $numberDouble: '-Infinity' })
    ok('NaN', { $numberDouble: 'NaN' })
    ok('-0.0', { $numberDouble: '-0.0' })
  })

  test('strings and escapes', () => {
    ok(String.raw`'it\'s \n é \x41 \u{1F600}'`, "it's \n é A 😀")
    ok('"héllo wörld"', 'héllo wörld')
  })

  test('regex literals and RegExp', () => {
    ok('/^mongo.*$/i', { $regularExpression: { pattern: '^mongo.*$', options: 'i' } })
    ok('/a\\/b[/]c/mi', { $regularExpression: { pattern: 'a\\/b[/]c', options: 'im' } })
    ok('RegExp("x", "si")', { $regularExpression: { pattern: 'x', options: 'is' } })
  })

  test('constructors', () => {
    ok('ObjectId("6542F1A2B3C4D5E6F7A8B9C0")', { $oid: '6542f1a2b3c4d5e6f7a8b9c0' })
    ok("ISODate('2026-11-16T12:34:56.789Z')", { $date: { $numberLong: '1794832496789' } })
    ok("ISODate('2026-11-16')", { $date: { $numberLong: '1794787200000' } })
    ok("new Date('2026-11-16T12:34:56')", { $date: { $numberLong: '1794832496000' } })
    ok('new Date(0)', { $date: { $numberLong: '0' } })
    ok('new Date()', { $date: { $numberLong: '5' } }, 5)
    ok('NumberInt(42)', { $numberInt: '42' })
    ok("NumberInt('7')", { $numberInt: '7' })
    ok("NumberLong('9007199254740993')", { $numberLong: '9007199254740993' })
    ok('NumberLong(12)', { $numberLong: '12' })
    ok('Long("-9223372036854775808")', { $numberLong: '-9223372036854775808' })
    ok("NumberDecimal('0.1000000000000000000000000000000001')", { $numberDecimal: '0.1000000000000000000000000000000001' })
    ok('Double(2)', { $numberDouble: '2.0' })
    ok("UUID('3b241101-e2bb-4255-8caf-4136c566a962')", { $binary: { base64: 'OyQRAeK7QlWMr0E2xWapYg==', subType: '04' } })
    ok("BinData(0, 'SGVsbG8=')", { $binary: { base64: 'SGVsbG8=', subType: '00' } })
    ok("HexData(128, '48656c6c6f')", { $binary: { base64: 'SGVsbG8=', subType: '80' } })
    ok('Timestamp({ t: 1794835766, i: 7 })', { $timestamp: { t: 1794835766, i: 7 } })
    ok('Timestamp(5, 6)', { $timestamp: { t: 5, i: 6 } })
    ok('MinKey()', { $minKey: 1 })
    ok('{ lo: MinKey, hi: new MaxKey() }', { lo: { $minKey: 1 }, hi: { $maxKey: 1 } })
    ok("Code('function () { return 1 }')", { $code: 'function () { return 1 }' })
  })

  test('Extended JSON passes through', () => {
    ok('{ "_id": { "$oid": "6542f1a2b3c4d5e6f7a8b9c0" }, "n": { "$numberLong": "5" } }', { _id: { $oid: '6542f1a2b3c4d5e6f7a8b9c0' }, n: { $numberLong: '5' } })
  })

  test('a blank query field is an empty document', () => {
    assert.deepEqual(parseShellDocument('  ', 'filter'), {})
    assert.equal(shellProblem('{ status: "A" }', 'filter'), null)
  })
})

describe('shell parser: errors point at the problem', () => {
  const cases: [string, RegExp, number, number][] = [
    ['{ a: 1', /never closed with \}/, 1, 1],
    ['{ a: 1 b: 2 }', /Expected "," or "\}" but found "b"/, 1, 8],
    ['{\n  a: ,\n}', /Unexpected ","/, 2, 6],
    ["{ a: 'x }", /string is never closed/, 1, 6],
    ['{ a: ObjectId("123") }', /24 hex digits/, 1, 6],
    ['{ a: Foo(1) }', /Unknown name "Foo"/, 1, 6],
    ['{ a: undefined }', /Use null/, 1, 6],
    ['{ a: NumberInt(3000000000) }', /whole number from/, 1, 6],
    ['{ a: NumberLong(9007199254740993) }', /Quote it/, 1, 6],
    ["{ a: ISODate('yesterday') }", /is not a date/, 1, 6],
    ['{ a: 1, a: 2 }', /appears twice/, 1, 9],
    ['{ a: /x/g }', /Unknown regular expression flag "g"/, 1, 6],
    ['{ a: 1 } x', /after the value/, 1, 10],
    ['/* open', /never closed with \*\//, 1, 1],
    ['ObjectId()', /leave _id out/, 1, 1],
    ['12abc', /after the number/, 1, 3],
    ['{ a: [1, 2 }', /Expected "," or "\]" but found "\}"/, 1, 12]
  ]
  for (const [text, pattern, line, column] of cases) {
    test(text.replace(/\n/g, '⏎'), () => {
      const e = err(text)
      assert.match(e.message, pattern)
      assert.deepEqual([e.line, e.column], [line, column], `${e.message}`)
    })
  }

  test('a query field must be a document', () => {
    assert.match(shellProblem('[1]', 'projection')!.message, /projection must be a document/)
  })
})

describe('a field named __proto__ stays a field', () => {
  // JSON.parse makes `__proto__` an own field, as it is in documents from the worker.
  const doc = JSON.parse('{"_id":{"$numberInt":"1"},"__proto__":{"x":{"$numberInt":"1"}},"a":{"__proto__":"y"}}') as JsonObject
  const own = (o: unknown, k: string): boolean => Object.prototype.hasOwnProperty.call(o, k)

  test('toShell writes a computed key, and the parser reads it back', () => {
    const text = toShell(doc)
    assert.match(text, /\['__proto__'\]: \{/)
    assert.match(toShellInline(doc), /\['__proto__'\]: 'y'/)
    const back = parseShell(text) as JsonObject
    assert.ok(own(back, '__proto__'))
    assert.equal(Object.getPrototypeOf(back), Object.prototype)
    assert.equal(JSON.stringify(back), JSON.stringify(doc))
    // In real JavaScript, as in the shell editor, the computed key is a field too.
    const js = new Function(`return (${toShellInline(JSON.parse('{"__proto__":"v"}') as JsonObject)})`)() as object
    assert.ok(own(js, '__proto__'))
    assert.equal(Object.getPrototypeOf(js), Object.prototype)
  })

  test('every key form the parser takes makes an own field', () => {
    for (const text of ['{ __proto__: 1 }', "{ '__proto__': 1 }", '{ "__proto__": 1 }', "{ ['__proto__']: 1 }", '{ [ "__proto__" ] : 1 }']) {
      const v = parseShell(text) as JsonObject
      assert.ok(own(v, '__proto__'), text)
      assert.deepEqual(Object.keys(v), ['__proto__'], text)
    }
    assert.match(err('{ [a]: 1 }').message, /must be a quoted string/)
    assert.match(err("{ ['a': 1 }").message, /Expected "\]"/)
    assert.match(err('{ __proto__: 1, "__proto__": 2 }').message, /appears twice/)
  })

  test('relaxed JSON, compare keys and CSV rows keep it', () => {
    assert.ok(own(toRelaxed(doc), '__proto__'))
    assert.match(compareKey(doc, { ignoreFields: [], ignoreOrder: true }), /"__proto__"/)
    const row = rowDocument([{ name: 'p', field: '__proto__.x', type: 'string' }, { name: 'c', field: 'constructor.y', type: 'string' }], ['a', 'b'], true)
    assert.equal(JSON.stringify(row), '{"__proto__":{"x":"a"},"constructor":{"y":"b"}}')
  })
})
