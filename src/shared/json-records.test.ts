import { assert, describe, test } from 'orca/testing'
import { JsonRecordReader, splitJsonRecords } from './json-records'

const texts = (s: string) => splitJsonRecords(s).map((r) => r.text)

describe('splitting JSON into documents', () => {
  test('an array, one per line, and documents one after another', () => {
    assert.deepEqual(texts('[{"a":1}, {"b":[1,{"c":"]}"}]}]'), ['{"a":1}', '{"b":[1,{"c":"]}"}]}'])
    assert.deepEqual(texts('{"a":1}\n{"a":2}\n\n{"a":3}\n'), ['{"a":1}', '{"a":2}', '{"a":3}'])
    assert.deepEqual(texts('{\n  "a": 1\n}\n{\n  "a": "}{\\" ["\n}'), ['{\n  "a": 1\n}', '{\n  "a": "}{\\" ["\n}'])
    assert.deepEqual(texts('{"a":1},{"a":2}'), ['{"a":1}', '{"a":2}'])
    assert.deepEqual(texts('[]'), [])
    assert.deepEqual(texts('  '), [])
  })

  test('line numbers point at where each document starts', () => {
    assert.deepEqual(splitJsonRecords('[\n {"a":1},\n\n {"a":2}\n]').map((r) => r.line), [2, 4])
  })

  test('bare values are records too (refused later as "not a document")', () => {
    assert.deepEqual(texts('[1, "x", null, {"a":1}]'), ['1', '"x"', 'null', '{"a":1}'])
    assert.deepEqual(texts('{"a":1}\n42\n'), ['{"a":1}', '42'])
  })

  test('the same records whatever the pieces it is given in', () => {
    const text = '﻿[\n{"s":"a\\"b}","n":[1,2,{"x":"[]"}]},\n{"e":"\\\\"}\n]\n'
    const whole = texts(text)
    assert.deepEqual(whole, ['{"s":"a\\"b}","n":[1,2,{"x":"[]"}]}', '{"e":"\\\\"}'])
    for (let size = 1; size <= 9; size++) {
      const r = new JsonRecordReader()
      const out: string[] = []
      for (let at = 0; at < text.length; at += size) out.push(...r.feed(text.slice(at, at + size)).map((x) => x.text))
      out.push(...r.end().map((x) => x.text))
      assert.deepEqual(out, whole, `pieces of ${size}`)
    }
  })

  test('unclosed documents and arrays, and text after an array', () => {
    assert.throws(() => splitJsonRecords('{"a":1}\n{"b":'), /Line 2: the document starting here is never closed/)
    assert.throws(() => splitJsonRecords('[{"a":1}'), /never closed with \]/)
    assert.throws(() => splitJsonRecords('[{"a":1}] {"b":2}'), /text after the end of the array/)
  })
})
