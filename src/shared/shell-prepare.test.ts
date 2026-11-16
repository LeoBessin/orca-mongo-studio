// Statements as the shell thread runs them, and the editor's script header and merge.
import { assert, describe, test } from 'orca/testing'
import { mergeLines, readHeader, writeHeader } from '../editor/header'
import { prepareStatements } from './shell-prepare'
import { COLLECTION_METHODS, DB_METHODS, FIND_CURSOR_METHODS, GLOBALS, operatorsFor } from './shell-vocab'
import { DB_METHOD_NAMES } from './js-scan'

describe('prepared statements', () => {
  test('shell commands become calls; declarations become reusable assignments, columns kept', () => {
    const p = prepareStatements(`use shop
show collections
const n = db.orders.countDocuments()
let { a, b } = { a: 1, b: 2 }
var x = 1, y = 2
class Point {}
function f() { return 1 }
n`)
    assert.deepEqual(
      p.map((s) => [s.code, s.quiet, s.line, s.column]),
      [
        ['use("shop")', false, 1, 1],
        ['show("collections")', false, 2, 1],
        ['      n = db.orders.countDocuments()', true, 3, 1],
        ['var { a, b } = { a: 1, b: 2 }', true, 4, 1],
        ['var x = 1, y = 2', true, 5, 1],
        ['Point = class Point {}', true, 6, 1],
        ['function f() { return 1 }', true, 7, 1],
        ['n', false, 8, 1]
      ]
    )
  })

  test('a selection keeps its place in the editor', () => {
    const p = prepareStatements("db.a.find()\nprint('x')", 10, 5)
    assert.deepEqual(p.map((s) => [s.line, s.column]), [[10, 5], [11, 1]])
  })

  test("use and show only as commands: `use(x)` and `show.x` stay as written", () => {
    assert.deepEqual(prepareStatements('use(dbName)\nshow.x = 1').map((s) => s.code), ['use(dbName)', 'show.x = 1'])
  })
})

describe('script header', () => {
  test('reads, writes and adds the header', () => {
    const text = '// @mongo-studio connection="Local \\"dev\\"" db="shop"\ndb.a.find()'
    assert.deepEqual(readHeader(text), { connection: 'Local "dev"', db: 'shop', line: 0 })
    assert.equal(writeHeader(text, { connection: 'x', db: 'y' }), '// @mongo-studio connection="x" db="y"\ndb.a.find()')
    assert.equal(writeHeader('db.a.find()', { connection: 'x', db: '' }), '// @mongo-studio connection="x" db=""\ndb.a.find()')
    assert.deepEqual(readHeader('db.a.find()'), { connection: '', db: '', line: -1 })
  })
})

describe('merging an outside write with unsaved typing', () => {
  const base = 'a\nb\nc\nd'
  test('changes to different lines both survive', () => {
    assert.equal(mergeLines(base, 'A\nb\nc\nd', 'a\nb\nc\nD'), 'A\nb\nc\nD')
    assert.equal(mergeLines(base, 'a\nb\nc\nd\ne', 'x\na\nb\nc\nd'), 'x\na\nb\nc\nd\ne')
  })
  test('one side unchanged takes the other; a clash keeps both, outside first', () => {
    assert.equal(mergeLines(base, base, 'mine'), 'mine')
    assert.equal(mergeLines(base, 'theirs', base), 'theirs')
    assert.equal(mergeLines(base, 'a\nB1\nc\nd', 'a\nB2\nc\nd'), 'a\nB1\nB2\nc\nd')
  })
})

describe('vocabulary', () => {
  test('labels are unique per list, and database method names match the scanner', () => {
    for (const list of [GLOBALS, DB_METHODS, COLLECTION_METHODS, FIND_CURSOR_METHODS, operatorsFor('stage'), operatorsFor('query'), operatorsFor('update')]) {
      const labels = list.map((v) => v.label)
      assert.equal(new Set(labels).size, labels.length, labels.join(','))
    }
    for (const m of DB_METHODS) assert.ok(DB_METHOD_NAMES.has(m.label), m.label)
  })
})
