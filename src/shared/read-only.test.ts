// What a read-only connection lets through: commands, pipelines and the shell's calls.
import { assert, describe, test } from 'orca/testing'
import { commandWrites, readOnlyMessage, shellCallWrites, writeStageOf } from './read-only'

/** Stands in for a BSON number from the shell thread (Int32 has `valueOf`, Long `toNumber`). */
const int32 = (n: number) => ({ _bsontype: 'Int32', valueOf: () => n })
const long = (n: number) => ({ _bsontype: 'Long', toNumber: () => n })

describe('read-only commands', () => {
  test('commands that read pass, whatever their case', () => {
    for (const c of [{ find: 'orders' }, { count: 'orders' }, { listCollections: 1 }, { ping: 1 }, { serverStatus: 1 }, { isMaster: 1 }, { ismaster: 1 }, { buildinfo: 1 }, { dbStats: 1 }, { collStats: 'x' }, { getMore: long(1), collection: 'x' }, { usersInfo: 1 }, { replSetGetStatus: 1 }]) {
      assert.equal(commandWrites(c), undefined, JSON.stringify(c))
    }
  })

  test('commands that write, and unknown ones, are refused by name', () => {
    assert.equal(commandWrites({ insert: 'x', documents: [] }), 'insert')
    assert.equal(commandWrites({ drop: 'x' }), 'drop')
    assert.equal(commandWrites({ dropDatabase: 1 }), 'dropDatabase')
    assert.equal(commandWrites({ createIndexes: 'x', indexes: [] }), 'createIndexes')
    assert.equal(commandWrites({ shutdown: 1 }), 'shutdown')
    assert.equal(commandWrites({ setParameter: 1 }), 'setParameter')
    assert.equal(commandWrites({ someFutureCommand: 1 }), 'someFutureCommand')
    assert.equal(commandWrites({}), 'an empty command')
    assert.equal(commandWrites(null), 'an unknown command')
  })

  test('aggregate writes only with $out or $merge', () => {
    assert.equal(commandWrites({ aggregate: 'x', pipeline: [{ $match: {} }], cursor: {} }), undefined)
    assert.equal(commandWrites({ aggregate: 'x', pipeline: [{ $match: {} }, { $out: 'y' }], cursor: {} }), '$out')
    assert.equal(commandWrites({ aggregate: 1, pipeline: [{ $merge: { into: 'y' } }] }), '$merge')
  })

  test('profile reads only at -1; mapReduce only inline', () => {
    assert.equal(commandWrites({ profile: -1 }), undefined)
    assert.equal(commandWrites({ profile: int32(-1) }), undefined)
    assert.equal(commandWrites({ profile: 1 }), 'profile (changing the profiler)')
    assert.equal(commandWrites({ mapReduce: 'x', map: '', reduce: '', out: { inline: 1 } }), undefined)
    assert.equal(commandWrites({ mapReduce: 'x', map: '', reduce: '', out: { inline: int32(1) } }), undefined)
    assert.equal(commandWrites({ mapReduce: 'x', map: '', reduce: '', out: 'y' }), 'mapReduce with an output collection')
  })

  test('explain plans writes without applying them, but not unknown commands', () => {
    assert.equal(commandWrites({ explain: { find: 'x' } }), undefined)
    assert.equal(commandWrites({ explain: { update: 'x', updates: [] } }), undefined)
    assert.equal(commandWrites({ explain: { delete: 'x', deletes: [] } }), undefined)
    assert.equal(commandWrites({ explain: { aggregate: 'x', pipeline: [{ $out: 'y' }] } }), undefined)
    assert.equal(commandWrites({ explain: { drop: 'x' } }), 'explain of drop')
    assert.equal(commandWrites({ explain: 1 }), 'explain of an unknown command')
  })

  test('the write stage of a pipeline, wherever it stands', () => {
    assert.equal(writeStageOf([{ $match: {} }]), undefined)
    assert.equal(writeStageOf([{ $out: 'x' }, { $match: {} }]), '$out')
    assert.equal(writeStageOf('not a pipeline'), undefined)
  })
})

describe('read-only shell calls', () => {
  test('reads pass', () => {
    assert.equal(shellCallWrites('find.open', [{ db: 'shop', collection: 'orders' }, {}]), undefined)
    assert.equal(shellCallWrites('cursor.next', [1, 100]), undefined)
    assert.equal(shellCallWrites('aggregate.open', [{ db: 'shop', collection: 'orders' }, [{ $group: { _id: null } }]]), undefined)
    for (const m of ['findOne', 'countDocuments', 'estimatedDocumentCount', 'distinct', 'indexes', 'isCapped', 'stats']) assert.equal(shellCallWrites('collection', [{}, m, []]), undefined, m)
    for (const m of ['collectionNames', 'collectionInfos', 'listDatabases']) assert.equal(shellCallWrites('database', ['shop', m, []]), undefined, m)
    assert.equal(shellCallWrites('database', ['shop', 'command', [{ ping: 1 }]]), undefined)
  })

  test('writes are refused by method', () => {
    for (const m of ['insertOne', 'insertMany', 'updateOne', 'updateMany', 'replaceOne', 'deleteOne', 'deleteMany', 'findOneAndUpdate', 'findOneAndReplace', 'findOneAndDelete', 'bulkWrite', 'createIndex', 'createIndexes', 'dropIndex', 'dropIndexes', 'drop', 'rename']) {
      assert.equal(shellCallWrites('collection', [{}, m, []]), m)
    }
    assert.equal(shellCallWrites('database', ['shop', 'createCollection', ['x']]), 'createCollection')
    assert.equal(shellCallWrites('database', ['shop', 'dropDatabase', []]), 'dropDatabase')
    assert.equal(shellCallWrites('database', ['shop', 'command', [{ drop: 'x' }]]), 'drop')
    assert.equal(shellCallWrites('aggregate.open', [{ db: 'shop', collection: 'orders' }, [{ $out: 'copy' }]]), '$out')
    assert.equal(shellCallWrites('something.new', []), 'something.new')
  })

  test('the message names the connection and what was refused', () => {
    assert.equal(readOnlyMessage('Prod', 'dropping a collection'), '"Prod" is read only, so Mongo Studio refuses dropping a collection. Turn off "Read only" in the connection\'s settings to allow changes.')
  })
})
