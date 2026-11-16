// Saved tasks: checking a request, what a run would drop or change, the description, and the
// sentence a finished run leaves.
import { assert, describe, test } from 'orca/testing'
import { checkTaskName, checkTaskRequest, describeTask, freeTaskName, resultSummary, taskConnections, taskDanger, taskKindLabel, taskWriteConnection, type TaskRequest } from './tasks'

const a = { connectionId: 'c1', db: 'shop', collection: 'orders' }
const b = { connectionId: 'c2', db: 'shop', collection: 'orders' }
const name = (id: string): string => ({ c1: 'Local', c2: 'Staging' })[id] ?? id
const rules = { ignoreFields: [], ignoreOrder: false }

const exportJson: TaskRequest = { kind: 'export', source: { kind: 'query', ns: a, spec: { filter: { status: 'shipped' }, skip: 0, limit: 0 } }, options: { format: 'json', json: { layout: 'lines', relaxed: true, pretty: false } }, destination: { kind: 'path', path: '/tmp/o.json', overwrite: true } }
const copyReplace: TaskRequest = { kind: 'export', source: { kind: 'query', ns: a, spec: { filter: {}, skip: 0, limit: 0 } }, options: { format: 'collection', collection: { connectionId: 'c2', db: 'shop', collection: 'orders_copy', mode: 'replace', indexes: true, options: true } }, destination: { kind: 'download' } }
const importDrop: TaskRequest = { kind: 'import', source: { kind: 'path', path: '/data/o.json' }, options: { format: 'auto', mode: 'insert', drop: true, stopOnError: false, indexes: true }, ns: a }
const sync: TaskRequest = { kind: 'sync', from: a, to: b, rules, insert: true, replace: false, remove: true }

describe('task requests', () => {
  test('each kind passes its shape check', () => {
    for (const r of [exportJson, copyReplace, importDrop, sync, { kind: 'compare', a, b, rules } as TaskRequest]) assert.deepEqual(checkTaskRequest(r), r)
  })

  test('what is refused, with a reason', () => {
    const reasons: [unknown, RegExp][] = [
      [null, /needs a request/],
      [{ kind: 'nope' }, /Unknown kind/],
      [{ ...importDrop, source: { kind: 'upload', uploadId: 'u' } }, /pasted text can't be saved/],
      [{ ...exportJson, destination: { kind: 'path', path: ' ' } }, /no path/],
      [{ ...exportJson, options: { format: 'xml' } }, /no export format/],
      [{ ...sync, insert: false, remove: false }, /at least one change/],
      [{ kind: 'compare', a, b: { connectionId: 'c2', db: 'shop' }, rules }, /collection B is not a collection/]
    ]
    for (const [raw, why] of reasons) assert.throws(() => checkTaskRequest(raw), why)
    assert.throws(() => checkTaskName('  '), /Give the task a name/)
    assert.throws(() => checkTaskName('x'.repeat(101)), /at most 100/)
    assert.equal(checkTaskName('  Nightly copy '), 'Nightly copy')
  })

  test('connections used and written to', () => {
    assert.deepEqual(taskConnections(copyReplace), ['c1', 'c2'])
    assert.deepEqual(taskConnections(exportJson), ['c1'])
    assert.equal(taskWriteConnection(exportJson), undefined)
    assert.equal(taskWriteConnection(copyReplace), 'c2')
    assert.equal(taskWriteConnection(importDrop), 'c1')
    assert.equal(taskWriteConnection(sync), 'c2')
    assert.deepEqual([exportJson, copyReplace, importDrop, sync].map(taskKindLabel), ['Export', 'Copy', 'Import', 'Sync'])
  })
})

describe('confirmations before a run', () => {
  test('a drop or replace names the collection to count', () => {
    assert.equal(taskDanger(exportJson, name), undefined)
    assert.equal(taskDanger({ ...importDrop, options: { ...(importDrop as { options: object }).options, drop: false } } as TaskRequest, name), undefined)
    assert.deepEqual(taskDanger(importDrop, name), { title: 'Drop Local · shop.orders?', text: 'The collection is dropped with its indexes, then the import writes into it.', ns: a })
    assert.deepEqual(taskDanger(copyReplace, name)?.ns, { connectionId: 'c2', db: 'shop', collection: 'orders_copy' })
    const s = taskDanger(sync, name)!
    assert.equal(s.title, 'Change Staging · shop.orders?')
    assert.match(s.text, /inserts what is only in the source, deletes what is only in the target/)
    assert.deepEqual(s.ns, b)
  })

  test('a whole database or a dump folder has nothing single to count', () => {
    const db: TaskRequest = { ...copyReplace, source: { kind: 'database', connectionId: 'c1', db: 'shop' } } as TaskRequest
    assert.equal(taskDanger(db, name)?.ns, undefined)
    const folder = { ...importDrop, ns: { ...a, collection: '' } } as TaskRequest
    assert.match(taskDanger(folder, name)!.title, /Replace collections of Local · shop\?/)
  })
})

describe('descriptions and summaries', () => {
  test('the settings in lines', () => {
    assert.deepEqual(describeTask(exportJson, name), [
      { label: 'From', value: 'Local · shop.orders' },
      { label: 'Query', value: "{ status: 'shipped' }" },
      { label: 'Format', value: 'JSON lines' },
      { label: 'To', value: '/tmp/o.json (replaced)' }
    ])
    assert.deepEqual(describeTask(copyReplace, name).slice(-2), [
      { label: 'Into', value: 'Staging · shop.orders_copy' },
      { label: 'Writes', value: 'drop first, then insert' }
    ])
    assert.deepEqual(describeTask(sync, name).at(-1), { label: 'Changes', value: 'insert, delete' })
  })

  test('a finished run in a sentence', () => {
    assert.equal(resultSummary({ kind: 'import', read: 3, inserted: 2, updated: 0, failed: 1, collections: ['x'] }), 'Read 3 documents: 2 inserted, 1 failed.')
    assert.equal(resultSummary({ kind: 'export', docs: 1, collections: 1, bytes: 9, written: ['/tmp/o.json'] }), 'Wrote 1 document to /tmp/o.json.')
    assert.equal(resultSummary({ kind: 'export', docs: 5, collections: 1, bytes: 9, download: { name: 'o.json', mimeType: 'x', size: 9 } }), 'Exported 5 documents, ready to save as o.json.')
    assert.equal(resultSummary({ kind: 'export', docs: 5, collections: 2, bytes: 9, inserted: 5 }), 'Copied 5 documents of 2 collections: 5 inserted.')
    assert.equal(resultSummary({ kind: 'compare', same: 1, differ: 2, onlyA: 3, onlyB: 4, ids: { differ: [], onlyA: [], onlyB: [] }, capped: false }), '1 the same, 2 differ, 3 only in A, 4 only in B.')
    assert.equal(resultSummary({ kind: 'sync', inserted: 1, replaced: 0, deleted: 2, failed: 0 }), '1 inserted, 0 replaced, 2 deleted.')
  })

  test('a free name', () => {
    assert.equal(freeTaskName('Copy', []), 'Copy')
    assert.equal(freeTaskName('Copy', ['copy']), 'Copy (2)')
    assert.equal(freeTaskName('Copy', ['Copy', 'Copy (2)']), 'Copy (3)')
  })
})
