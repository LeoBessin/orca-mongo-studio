import { assert, describe, test } from 'orca/testing'
import { base64Bytes, joinBytes } from './base64'
import { compareKey, diffDocuments, parseFieldList } from './compare'

const strict = { ignoreFields: [], ignoreOrder: false }
const int = (n: number) => ({ $numberInt: String(n) })
const dbl = (n: number) => ({ $numberDouble: String(n) })

describe('comparing documents', () => {
  test('types count, field order counts unless told not to, _id never', () => {
    const a = { _id: int(1), x: int(1), y: { p: 1, q: 2 } }
    assert.equal(compareKey(a, strict), compareKey({ _id: int(2), x: int(1), y: { p: 1, q: 2 } }, strict))
    assert.notEqual(compareKey(a, strict), compareKey({ _id: int(1), x: dbl(1), y: { p: 1, q: 2 } }, strict))
    assert.notEqual(compareKey(a, strict), compareKey({ _id: int(1), y: { q: 2, p: 1 }, x: int(1) }, strict))
    assert.equal(compareKey(a, { ignoreFields: [], ignoreOrder: true }), compareKey({ _id: int(1), y: { q: 2, p: 1 }, x: int(1) }, { ignoreFields: [], ignoreOrder: true }))
  })

  test('left-out fields, top-level and dotted', () => {
    const rules = { ignoreFields: ['updatedAt', 'meta.v'], ignoreOrder: false }
    assert.equal(compareKey({ a: 1, updatedAt: 1, meta: { v: 1, k: 'x' } }, rules), compareKey({ a: 1, updatedAt: 2, meta: { v: 9, k: 'x' } }, rules))
    assert.notEqual(compareKey({ a: 1, meta: { k: 'x' } }, rules), compareKey({ a: 1, meta: { k: 'y' } }, rules))
    // Only that path: a field of the same name elsewhere still counts.
    assert.notEqual(compareKey({ other: { updatedAt: 1 } }, rules), compareKey({ other: { updatedAt: 2 } }, rules))
  })

  test('differences field by field, into sub-documents and arrays', () => {
    const a = { _id: int(1), name: 'Ada', n: int(1), tags: ['x', 'y'], addr: { city: 'Paris', zip: '75001' }, gone: true }
    const b = { _id: int(1), name: 'Ada', n: dbl(1), tags: ['x', 'z', 'w'], addr: { city: 'Lyon', zip: '75001' }, added: null }
    const { diffs, capped } = diffDocuments(a, b, strict)
    assert.equal(capped, false)
    assert.deepEqual(diffs, [
      { path: 'n', kind: 'changed', a: '1', b: '1.0', types: ['int', 'double'] },
      { path: 'tags.1', kind: 'changed', a: 'y', b: 'z' },
      { path: 'tags.2', kind: 'added', b: 'w' },
      { path: 'addr.city', kind: 'changed', a: 'Paris', b: 'Lyon' },
      { path: 'gone', kind: 'removed', a: 'true' },
      { path: 'added', kind: 'added', b: 'null' }
    ])
  })

  test('a reordered sub-document is one difference, unless order does not count', () => {
    const a = { m: { a: 1, b: 2 } }
    const b = { m: { b: 2, a: 1 } }
    assert.deepEqual(diffDocuments(a, b, strict).diffs.map((d) => d.path), ['m'])
    assert.deepEqual(diffDocuments(a, b, { ignoreFields: [], ignoreOrder: true }).diffs, [])
  })

  test('at most `max` differences', () => {
    const a = Object.fromEntries(Array.from({ length: 20 }, (_, i) => [`f${i}`, i]))
    const r = diffDocuments(a, {}, strict, 5)
    assert.equal(r.diffs.length, 5)
    assert.equal(r.capped, true)
  })

  test('field lists', () => {
    assert.deepEqual(parseFieldList(' a, b.c  d,,_id, a'), ['a', 'b.c', 'd'])
  })
})

describe('base64 in the panel', () => {
  test('decodes what Buffer encodes, any length', () => {
    for (let n = 0; n < 70; n++) {
      const bytes = Buffer.from(Array.from({ length: n }, (_, i) => (i * 37 + n) % 256))
      assert.deepEqual([...base64Bytes(bytes.toString('base64'))], [...bytes], `length ${n}`)
    }
    assert.throws(() => base64Bytes('ab$c'), /Not base64/)
  })

  test('joins pieces into one buffer', () => {
    const buf = joinBytes([new Uint8Array([1, 2]), new Uint8Array([]), new Uint8Array([3])])
    assert.deepEqual([...new Uint8Array(buf)], [1, 2, 3])
  })
})
