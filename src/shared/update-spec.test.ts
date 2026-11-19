// Update many: the update text as operators or a pipeline, and the scopes it applies to.
import { assert, describe, test } from 'orca/testing'
import { parseUpdateText, scopeFilter, scopeIsEverything, scopeProblem, updateProblem, UPDATE_IDS_MAX } from './update-spec'

describe('update text', () => {
  test('operators parse from shell syntax into canonical Extended JSON', () => {
    const r = parseUpdateText("{ $set: { status: 'archived', at: ISODate('2026-01-01') }, $inc: { n: 1 } }")
    assert.equal(r.error, undefined)
    assert.deepEqual(r.update, { $set: { status: 'archived', at: { $date: { $numberLong: '1767225600000' } } }, $inc: { n: { $numberInt: '1' } } })
  })

  test('a pipeline in [ ] is an update pipeline', () => {
    const r = parseUpdateText("[{ $set: { total: { $add: ['$a', '$b'] } } }, { $unset: 'tmp' }]")
    assert.equal(r.error, undefined)
    assert.ok(Array.isArray(r.update))
  })

  test('says what is wrong, in words', () => {
    assert.match(parseUpdateText('').error!, /Write the change/)
    assert.match(parseUpdateText('{ $set: { a: 1 }').error!, /never closed/)
    assert.match(parseUpdateText('{ status: 1 }').error!, /"status" is not an update operator.*\$set: \{ status/)
    assert.match(parseUpdateText('{ $sett: { a: 1 } }').error!, /\$sett is not an update operator/)
    assert.match(parseUpdateText('{ $set: 1 }').error!, /\$set takes a document of fields/)
    assert.match(parseUpdateText('{ $set: {} }').error!, /\$set names no fields/)
    assert.match(parseUpdateText('{}').error!, /Write the change/)
    assert.match(parseUpdateText('[]').error!, /at least one stage/)
    assert.match(parseUpdateText('[{ $match: { a: 1 } }]').error!, /\$match can't be used in an update pipeline/)
    assert.match(parseUpdateText('[{ $set: {}, $unset: "a" }]').error!, /Stage 1 must be a document with one stage name/)
    assert.match(parseUpdateText("ObjectId('6542f1a2b3c4d5e6f7a8b900')").error!, /An update is a document of operators/)
  })

  test('the worker checks what it is sent the same way', () => {
    assert.equal(updateProblem({ $unset: { a: '' } }), undefined)
    assert.match(updateProblem({ $set: { $oid: '6542f1a2b3c4d5e6f7a8b900' } })!, /\$set takes a document of fields/, 'a BSON value is not a document of fields')
    assert.match(updateProblem('x')!, /An update is a document/)
  })
})

describe('update scopes', () => {
  test('each scope stands for a filter', () => {
    assert.deepEqual(scopeFilter({ kind: 'ids', ids: [1, 'a'] }), { _id: { $in: [1, 'a'] } })
    assert.deepEqual(scopeFilter({ kind: 'filter', filter: { status: 'x' } }), { status: 'x' })
    assert.deepEqual(scopeFilter({ kind: 'all' }), {})
  })

  test('everything is the whole collection, or a query with an empty filter', () => {
    assert.equal(scopeIsEverything({ kind: 'all' }), true)
    assert.equal(scopeIsEverything({ kind: 'filter', filter: {} }), true)
    assert.equal(scopeIsEverything({ kind: 'filter', filter: { a: 1 } }), false)
    assert.equal(scopeIsEverything({ kind: 'ids', ids: [1] }), false)
  })

  test('refuses an empty or oversized selection', () => {
    assert.match(scopeProblem({ kind: 'ids', ids: [] })!, /Select the documents/)
    assert.match(scopeProblem({ kind: 'ids', ids: Array.from({ length: UPDATE_IDS_MAX + 1 }, (_, i) => i) })!, /at most 10,000/)
    assert.match(scopeProblem({ kind: 'filter', filter: 1 as never })!, /filter must be a document/)
    assert.match(scopeProblem({ kind: 'nope' } as never)!, /Choose which documents/)
    assert.equal(scopeProblem({ kind: 'all' }), undefined)
  })
})
