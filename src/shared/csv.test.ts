import { assert, describe, test } from 'orca/testing'
import { cellText, cellValue, columnsFor, CsvReader, csvRow, guessDelimiter, headerColumn, inferType, mappingProblems, parseCsv, rowDocument, valueAtDotted } from './csv'

describe('reading CSV', () => {
  test('quotes, doubled quotes, delimiters and line breaks inside quotes, CRLF and a BOM', () => {
    const text = '﻿name,note\r\n"Smith, Ada","said ""hi""\nthen left"\r\nGrace,\r\n\r\n,last\n'
    assert.deepEqual(parseCsv(text), [['name', 'note'], ['Smith, Ada', 'said "hi"\nthen left'], ['Grace', ''], ['', 'last']])
  })

  test('the same rows whatever the pieces it is given in', () => {
    const text = 'a;b;c\n"x;1";"y""2";z\r\n1;2;3\r\n"multi\r\nline";;\n'
    const whole = parseCsv(text, ';')
    for (let size = 1; size <= 7; size++) {
      const r = new CsvReader(';')
      const rows: string[][] = []
      for (let at = 0; at < text.length; at += size) rows.push(...r.feed(text.slice(at, at + size)).rows)
      rows.push(...r.end().rows)
      assert.deepEqual(rows, whole, `pieces of ${size}`)
    }
    assert.deepEqual(whole, [['a', 'b', 'c'], ['x;1', 'y"2', 'z'], ['1', '2', '3'], ['multi\r\nline', '', '']])
  })

  test('line numbers of rows, and an unclosed quote', () => {
    const r = new CsvReader(',')
    const out = r.feed('a,b\n"x\ny",1\nlast,2')
    const end = r.end()
    assert.deepEqual([...out.lines, ...end.lines], [1, 2, 4])
    assert.throws(() => parseCsv('a\n"open'), /Line 2: a quoted value is never closed/)
  })

  test('the delimiter of a first line', () => {
    assert.equal(guessDelimiter('a,b,c'), ',')
    assert.equal(guessDelimiter('a;b;c'), ';')
    assert.equal(guessDelimiter('a\tb'), '\t')
    assert.equal(guessDelimiter('one column'), ',')
  })
})

describe('types', () => {
  test('inference picks the narrowest type every value fits', () => {
    assert.equal(inferType(['1', '-2', '', '300']), 'int')
    assert.equal(inferType(['1', '3000000000']), 'long')
    assert.equal(inferType(['1', '99999999999999999999']), 'double')
    assert.equal(inferType(['1.5', '2', '1e3']), 'double')
    assert.equal(inferType(['007', '12']), 'string', 'leading zeros stay text')
    assert.equal(inferType(['true', 'FALSE']), 'bool')
    assert.equal(inferType(['2026-01-02', '2026-01-02T03:04:05Z', '2026-01-02 03:04:05.123+02:00']), 'date')
    assert.equal(inferType(['6542f1a2b3c4d5e6f7a8b9c0']), 'objectId')
    assert.equal(inferType(['[1,2]', '{"a":1}']), 'json')
    assert.equal(inferType(['', '']), 'string')
    assert.equal(inferType(['1', 'x']), 'string')
  })

  test('cells become canonical Extended JSON, or say why not', () => {
    assert.deepEqual(cellValue('42', 'int', false), { $numberInt: '42' })
    assert.deepEqual(cellValue('9223372036854775807', 'long', false), { $numberLong: '9223372036854775807' })
    assert.deepEqual(cellValue('2', 'double', false), { $numberDouble: '2.0' })
    assert.deepEqual(cellValue('1.25', 'double', false), { $numberDouble: '1.25' })
    assert.deepEqual(cellValue('+0.10', 'decimal', false), { $numberDecimal: '0.10' })
    assert.equal(cellValue('Yes', 'bool', false), true)
    assert.deepEqual(cellValue('2026-01-02', 'date', false), { $date: { $numberLong: String(Date.UTC(2026, 0, 2)) } })
    assert.deepEqual(cellValue('2026-01-02 03:04:05', 'date', false), { $date: { $numberLong: String(Date.UTC(2026, 0, 2, 3, 4, 5)) } })
    assert.deepEqual(cellValue('1700000000000', 'date', false), { $date: { $numberLong: '1700000000000' } })
    assert.deepEqual(cellValue('6542F1A2B3C4D5E6F7A8B9C0', 'objectId', false), { $oid: '6542f1a2b3c4d5e6f7a8b9c0' })
    assert.deepEqual(cellValue('[1,{"a":2}]', 'json', false), [1, { a: 2 }])
    assert.equal(cellValue(' padded ', 'string', false), ' padded ')
    assert.equal(cellValue('', 'string', false), '')
    assert.equal(cellValue('', 'int', false), null)
    assert.equal(cellValue('', 'int', true), undefined)
    assert.equal(cellValue('x', 'skip', false), undefined)
    assert.throws(() => cellValue('4.5', 'int', false), /not a whole number/)
    assert.throws(() => cellValue('3000000000', 'int', false), /outside the Int32 range/)
    assert.throws(() => cellValue('maybe', 'bool', false), /not true or false/)
    assert.throws(() => cellValue('02/01/2026', 'date', false), /not an ISO 8601 date/)
    assert.throws(() => cellValue('{bad', 'json', false), /not Extended JSON/)
  })

  test('typed headers as mongoimport writes them', () => {
    assert.deepEqual(headerColumn('age.int32()'), { field: 'age', type: 'int' })
    assert.deepEqual(headerColumn('address.zip.string()'), { field: 'address.zip', type: 'string' })
    assert.deepEqual(headerColumn('n.auto()'), { field: 'n' })
    assert.deepEqual(headerColumn('plain'), { field: 'plain' })
    assert.match(headerColumn('b.binary(base64)').note ?? '', /not supported/)
    assert.match(headerColumn('d.date(2006-01-02)').note ?? '', /date layouts/)
  })

  test('columns from a header and a sample; a repeated name is skipped', () => {
    const { columns, notes } = columnsFor(['id', 'when.date()', 'id'], [['1', '2026-01-01', 'x'], ['2', '', 'y']])
    assert.deepEqual(columns, [
      { name: 'id', field: 'id', type: 'int' },
      { name: 'when.date()', field: 'when', type: 'date' },
      { name: 'id', field: 'id', type: 'skip' }
    ])
    assert.match(notes[0]!, /repeats "id"/)
    assert.deepEqual(columnsFor(undefined, [['a', '1']]).columns.map((c) => c.field), ['field1', 'field2'])
  })
})

describe('documents', () => {
  test('dotted fields make sub-documents; skipped columns and empty cells are left out', () => {
    const columns = [
      { name: 'a', field: 'name.first', type: 'string' as const },
      { name: 'b', field: 'name.last', type: 'string' as const },
      { name: 'c', field: 'age', type: 'int' as const },
      { name: 'd', field: 'x', type: 'skip' as const }
    ]
    assert.deepEqual(rowDocument(columns, ['Ada', 'Lovelace', '36', 'ignored'], true), { name: { first: 'Ada', last: 'Lovelace' }, age: { $numberInt: '36' } })
    assert.deepEqual(rowDocument(columns, ['Ada', '', ''], true), { name: { first: 'Ada' } })
    assert.throws(() => rowDocument(columns, ['Ada', 'L', 'old'], true), /^Error: c: "old" is not a whole number/)
    assert.throws(() => rowDocument(columns, ['1', '2', '3', '4', 'extra'], true), /5 values for 4 columns/)
  })

  test('mapping problems are named before importing', () => {
    assert.deepEqual(mappingProblems([{ name: 'a', field: 'x', type: 'string' }, { name: 'b', field: 'x.y', type: 'int' }, { name: 'c', field: '', type: 'int' }, { name: 'd', field: '$bad', type: 'int' }, { name: 'e', field: 'x', type: 'int' }]), [
      'Column "c" needs a field name, or skip it.',
      '"$bad": field names can\'t start with $.',
      'Two columns fill "x".',
      '"x" and "x.y": one field can\'t be both a value and a sub-document.'
    ])
    assert.deepEqual(mappingProblems([{ name: 'a', field: '', type: 'skip' }]), [])
  })
})

describe('writing CSV', () => {
  const doc = {
    _id: { $oid: '6542f1a2b3c4d5e6f7a8b9c0' },
    n: { $numberInt: '5' },
    big: { $numberLong: '9007199254740993' },
    d: { $numberDouble: '2.0' },
    price: { $numberDecimal: '9.90' },
    at: { $date: { $numberLong: '1794787200000' } },
    note: 'says "hi", then\nleaves',
    tags: ['a', 'b'],
    address: { city: 'Paris', geo: { lat: { $numberDouble: '48.85' } } },
    none: null
  }

  test('cells: scalars as text, dates in ISO 8601, others as relaxed Extended JSON', () => {
    assert.equal(cellText(doc._id), '6542f1a2b3c4d5e6f7a8b9c0')
    assert.equal(cellText(doc.n), '5')
    assert.equal(cellText(doc.big), '9007199254740993')
    assert.equal(cellText(doc.d), '2')
    assert.equal(cellText(doc.price), '9.90')
    assert.equal(cellText(doc.at), '2026-11-16T00:00:00Z')
    assert.equal(cellText(doc.tags), '["a","b"]')
    assert.equal(cellText(doc.address), '{"city":"Paris","geo":{"lat":48.85}}')
    assert.equal(cellText(doc.none), '')
    assert.equal(cellText(undefined), '')
  })

  test('rows by dotted field, quoted where needed', () => {
    assert.equal(valueAtDotted(doc, 'address.geo.lat') !== undefined, true)
    assert.equal(valueAtDotted(doc, 'tags.1'), 'b')
    assert.equal(valueAtDotted(doc, 'tags.x'), undefined)
    assert.equal(csvRow(doc, ['_id', 'address.city', 'address.geo.lat', 'note', 'tags', 'missing'], ','), '6542f1a2b3c4d5e6f7a8b9c0,Paris,48.85,"says ""hi"", then\nleaves","[""a"",""b""]",\r\n')
    assert.equal(csvRow({ a: ' x', b: 'y;z' }, ['a', 'b'], ';'), '" x";"y;z"\r\n')
  })

  test('what is written reads back to the same text', () => {
    const fields = ['_id', 'note', 'tags', 'address.city']
    const back = parseCsv(csvRow(doc, fields, ','))
    assert.deepEqual(back, [['6542f1a2b3c4d5e6f7a8b9c0', 'says "hi", then\nleaves', '["a","b"]', 'Paris']])
  })
})
