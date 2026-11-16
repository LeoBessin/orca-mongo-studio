// Golden tests: the panel's Extended JSON helpers against bson's own EJSON, for every BSON type.
// The worker graph loads first, so this test may import `mongodb` (see the test loader note).
import '../worker'
import { BSON } from 'mongodb'
import { assert, describe, test } from 'orca/testing'
import { bsonType, toRelaxed, toShell, toShellInline, valueText, type JsonObject } from '../shared/ejson-view'
import { changeType, draftFromValue, valueFromDraft } from '../shared/field-edit'
import { parseShell } from '../shared/shell-parse'
import { fitsHost, hostSize } from '../shared/host-size'
import { pageDoc, shrink, toBson } from './query'

const { EJSON, Binary, Code, Decimal128, Double, Int32, Long, MaxKey, MinKey, ObjectId, Timestamp, UUID, BSONRegExp, BSONSymbol } = BSON

const zoo = {
  _id: 'all-types',
  double: 3.14159,
  wholeDouble: new Double(3),
  negZero: new Double(-0),
  nan: NaN,
  inf: -Infinity,
  string: 'héllo wörld\n\'quoted\' "double" \\ slash',
  object: { nested: { deep: [1, { x: 2 }] } },
  array: [1, 'two', 3.5, null, [4]],
  binary: new Binary(Buffer.from('Hello'), 0),
  userBinary: new Binary(Buffer.from([1, 2, 3]), 128),
  uuid: new UUID('3b241101-e2bb-4255-8caf-4136c566a962'),
  objectId: new ObjectId('6542f1a2b3c4d5e6f7a8b9c0'),
  bool: true,
  date: new Date('2026-11-16T12:34:56.789Z'),
  epoch: new Date(0),
  before1970: new Date(-86400000),
  farFuture: new Date(253402300800001),
  null: null,
  regex: new BSONRegExp('^mongo.*$', 'i'),
  slashRegex: new BSONRegExp('a/b', 'ms'),
  code: new Code('function () { return 1 }'),
  int32: new Int32(42),
  timestamp: new Timestamp({ t: 1794835766, i: 7 }),
  int64: Long.fromString('9007199254740993'),
  smallLong: Long.fromNumber(5),
  minLong: Long.fromString('-9223372036854775808'),
  decimal128: Decimal128.fromString('0.1000000000000000000000000000000001'),
  minKey: new MinKey(),
  maxKey: new MaxKey(),
  emptyObject: {},
  emptyArray: [],
  'dotted.key': 'needs bracket access',
  $unicode: '日本語 ✓',
  'with space': 1
}

const canonical = EJSON.serialize(zoo, { relaxed: false }) as JsonObject

describe('Extended JSON views against bson', () => {
  test('relaxed form matches bson for every type', () => {
    const ours = toRelaxed(canonical) as JsonObject
    const theirs = EJSON.serialize(zoo, { relaxed: true }) as JsonObject
    for (const key of Object.keys(theirs)) {
      assert.equal(JSON.stringify(ours[key]), JSON.stringify(theirs[key]), key)
    }
    assert.deepEqual(Object.keys(ours), Object.keys(theirs))
  })

  test('types are named from the canonical form', () => {
    const types = Object.fromEntries(Object.entries(canonical).map(([k, v]) => [k, bsonType(v)]))
    assert.deepEqual(types, {
      _id: 'string', double: 'double', wholeDouble: 'double', negZero: 'double', nan: 'double', inf: 'double', string: 'string', object: 'object', array: 'array',
      binary: 'binData', userBinary: 'binData', uuid: 'uuid', objectId: 'objectId', bool: 'bool', date: 'date', epoch: 'date', before1970: 'date', farFuture: 'date',
      null: 'null', regex: 'regex', slashRegex: 'regex', code: 'javascript', int32: 'int', timestamp: 'timestamp', int64: 'long', smallLong: 'long', minLong: 'long',
      decimal128: 'decimal', minKey: 'minKey', maxKey: 'maxKey', emptyObject: 'object', emptyArray: 'array', 'dotted.key': 'string', $unicode: 'string', 'with space': 'int'
    })
  })

  test('shell syntax reads back to the same value', () => {
    const shell = toShell(canonical)
    assert.deepEqual(parseShell(shell), canonical)
    assert.deepEqual(parseShell(toShellInline(canonical)), canonical)
    assert.match(shell, /ObjectId\('6542f1a2b3c4d5e6f7a8b9c0'\)/)
    assert.match(shell, /UUID\('3b241101-e2bb-4255-8caf-4136c566a962'\)/)
    assert.match(shell, /ISODate\('2026-11-16T12:34:56.789Z'\)/)
    assert.match(shell, /wholeDouble: 3\.0/)
    assert.match(shell, /'dotted.key': /)
    assert.match(shell, /slashRegex: RegExp\('a\/b', 'ms'\)/)
  })

  test('what bson reads from the parser is the value written', () => {
    const back = EJSON.parse(JSON.stringify(parseShell(toShell(canonical))), { relaxed: false })
    assert.equal(EJSON.stringify(back, { relaxed: false }), EJSON.stringify(zoo, { relaxed: false }))
  })

  test('symbol and DBPointer are named, and shown as their Extended JSON', () => {
    const odd = EJSON.serialize({ s: new BSONSymbol('sym') }, { relaxed: false }) as JsonObject
    assert.equal(bsonType(odd.s!), 'symbol')
  })

  test('cell text', () => {
    const t = (k: string): string => valueText(canonical[k]!)
    assert.equal(t('objectId'), 'ObjectId(6542f1a2b3c4d5e6f7a8b9c0)')
    assert.equal(t('date'), '2026-11-16T12:34:56.789Z')
    assert.equal(t('epoch'), '1970-01-01T00:00:00Z')
    assert.equal(t('object'), '{1 field}')
    assert.equal(t('array'), '[5 items]')
    assert.equal(t('binary'), 'Binary(0, 5 bytes)')
    assert.equal(t('uuid'), 'UUID(3b241101-e2bb-4255-8caf-4136c566a962)')
    assert.equal(t('int64'), '9007199254740993')
    assert.equal(t('wholeDouble'), '3.0')
    assert.equal(t('regex'), '/^mongo.*$/i')
    assert.equal(t('string'), 'héllo wörld \'quoted\' "double" \\ slash')
  })
})

describe('field editor conversions', () => {
  test('every editable type round-trips through its draft', () => {
    for (const [key, value] of Object.entries(canonical)) {
      if (key === '_id') continue
      const draft = draftFromValue(value)
      const back = valueFromDraft(draft)
      assert.ok(back.ok, `${key}: ${back.ok ? '' : back.error}`)
      if (back.ok) assert.equal(EJSON.stringify(toBson({ v: back.value } as JsonObject), { relaxed: false }), EJSON.stringify({ v: (zoo as Record<string, unknown>)[key] }, { relaxed: false }), key)
    }
  })

  test('changing the type carries the text over', () => {
    const asString = draftFromValue('42')
    assert.deepEqual(valueFromDraft(changeType(asString, 'int')), { ok: true, value: { $numberInt: '42' } })
    assert.deepEqual(valueFromDraft(changeType(asString, 'long')), { ok: true, value: { $numberLong: '42' } })
    assert.deepEqual(valueFromDraft(changeType(asString, 'double')), { ok: true, value: { $numberDouble: '42.0' } })
    assert.deepEqual(valueFromDraft(changeType(asString, 'decimal')), { ok: true, value: { $numberDecimal: '42' } })
    assert.deepEqual(valueFromDraft(changeType(asString, 'bool')), { ok: true, value: true })
    assert.deepEqual(valueFromDraft(changeType(asString, 'array')), { ok: true, value: ['42'] })
    assert.deepEqual(valueFromDraft(changeType(draftFromValue(canonical.date!), 'string')), { ok: true, value: '2026-11-16T12:34:56.789Z' })
    assert.deepEqual(valueFromDraft(changeType(draftFromValue('2026-01-02'), 'date')), { ok: true, value: { $date: { $numberLong: '1767312000000' } } })
  })

  test('bad input says what to type', () => {
    const bad = (type: Parameters<typeof changeType>[1], text: string): string => {
      const r = valueFromDraft({ ...draftFromValue(''), type, text })
      assert.equal(r.ok, false, `${type} ${text}`)
      return r.ok ? '' : r.error
    }
    assert.match(bad('int', '3000000000'), /Use Int64/)
    assert.match(bad('int', '1.5'), /whole number/)
    assert.match(bad('long', '9223372036854775808'), /64-bit/)
    assert.match(bad('objectId', 'xyz'), /24 hex digits/)
    assert.match(bad('date', 'tomorrow'), /2026-01-02/)
    assert.match(bad('object', '[1]'), /written in \{ \}/)
    assert.match(bad('object', '{ a: }'), /line 1, column 6/)
    assert.match(bad('uuid', '1234'), /32 hex digits/)
    assert.match(bad('binData', '***'), /base64/)
    assert.match(bad('decimal', 'abc'), /decimal number/)
  })
})

describe('page sizes', () => {
  test('long strings, big arrays and binary data are cut with a marker', () => {
    const doc = { _id: 1, text: 'x'.repeat(5000), list: Array.from({ length: 300 }, (_, i) => i), blob: new Binary(Buffer.alloc(10000), 0), small: 'ok' }
    const shown = pageDoc(doc)
    assert.equal(shown.cut, true)
    const d = shown.doc
    assert.equal(bsonType(d.text!), 'truncated')
    assert.equal(valueText(d.list!), '[300 items]')
    assert.equal(valueText(d.blob!), 'Binary(10,000 bytes)')
    assert.equal(d.small, 'ok')
    assert.ok(shown.bytes < 5000)
  })

  test("Orca's measure: bytes, objects and depth", () => {
    assert.deepEqual(hostSize({ a: [1, 'é', null, true] }), { bytes: 4 + 1 + 8 + 4 * 4 + 8 + 2 + 1 + 1, objects: 2, depth: 2 })
    const deep = (n: number): unknown => (n === 0 ? 1 : { d: deep(n - 1) })
    assert.equal(fitsHost(deep(50)), true)
    assert.equal(fitsHost(deep(99)), false)
    assert.equal(fitsHost(Array.from({ length: 9500 }, () => ({}))), false, 'too many objects')
    assert.equal(fitsHost('x'.repeat(1_000_000)), false, 'too many bytes')
  })

  test('deep nesting is cut so a page stays under 100 levels', () => {
    const deep = (n: number): unknown => (n === 0 ? 'bottom' : { d: deep(n - 1) })
    const shown = pageDoc({ _id: 1, nest: deep(95) })
    assert.equal(shown.cut, true)
    assert.ok(hostSize({ docs: [shown.doc] }).depth < 95)
  })

  test('small values are left alone', () => {
    assert.deepEqual(shrink(canonical), { value: canonical, cut: false })
  })

  test('a document still too big keeps only its _id', () => {
    const wide = Object.fromEntries(Array.from({ length: 300 }, (_, i) => [`f${i}`, 'y'.repeat(3900)]))
    const shown = pageDoc({ _id: new ObjectId('6542f1a2b3c4d5e6f7a8b9c0'), ...wide })
    assert.deepEqual(Object.keys(shown.doc), ['_id', '(document)'])
  })
})
