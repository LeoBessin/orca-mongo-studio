// Data movement tabs over a stand-in worker: import (pasted CSV with its column mapping, drop
// first), export (a query to the save dialog, CSV columns, a pipeline), copy and paste between
// connections, compare and sync, and the GridFS browser.
import { assert, describe, mockHost, mount, test, type MockRequests } from 'orca/testing'
import type { ConnectionsState, ExportResult, GridFile, ImportPreview, JobResult, JobState } from './protocol'
import * as panel from './panel'

const state: ConnectionsState = {
  connections: [
    { id: 'c1', name: 'Local dev', group: '', subtitle: 'localhost', topology: 'replicaSet', connected: true, readOnly: false },
    { id: 'c2', name: 'Staging', group: '', subtitle: 'staging', topology: 'replicaSet', connected: true, readOnly: false }
  ],
  favourites: [],
  secretsProtection: 'os-keyring'
}
const ns = { connectionId: 'c1', db: 'shop', collection: 'orders' }
const int = (n: number) => ({ $numberInt: String(n) })

const done = (jobId: string, kind: JobState['kind'], result: JobResult, extra: Partial<JobState> = {}): JobState => ({
  jobId,
  kind,
  status: 'done',
  version: 9,
  phase: 'Done',
  done: 10,
  total: 10,
  unit: 'documents',
  errors: [],
  errorCount: 0,
  result,
  started: 0,
  ms: 40,
  ...extra
})

const files: GridFile[] = [
  { id: { $oid: '6542f1a2b3c4d5e6f7a8b9c0' }, filename: 'readme.md', length: 40, chunkSize: 261120, uploadDate: 1_794_800_000_000, contentType: 'text/markdown' },
  { id: { $oid: '6542f1a2b3c4d5e6f7a8b9c1' }, filename: 'big.csv', length: 170_000, chunkSize: 261120, uploadDate: 1_794_700_000_000, contentType: 'text/csv', metadata: '{"contentType":"text/csv"}' }
]

const csvPreview: ImportPreview = {
  docs: [{ name: 'Ada', age: int(36) }],
  columns: [
    { name: 'name', field: 'name', type: 'string', samples: ['Ada', 'Grace'] },
    { name: 'age', field: 'age', type: 'int', samples: ['36', '45'] },
    { name: 'zip', field: 'zip', type: 'string', samples: ['01234'] }
  ],
  notes: [],
  errors: [],
  bytes: 40,
  format: 'csv'
}

type Calls = Record<string, unknown[]>

function setup(extra: MockRequests = {}) {
  const calls: Calls = {}
  const log = (name: string, input: unknown) => {
    ;(calls[name] ??= []).push(input)
  }
  const results = new Map<string, JobState>()
  let n = 0
  const start = <I,>(name: string, kind: JobState['kind'], result: (input: I) => JobResult, extraState: Partial<JobState> = {}) => (input: I) => {
    log(name, input)
    const jobId = `job${++n}`
    results.set(jobId, done(jobId, kind, result(input), extraState))
    return { jobId }
  }
  const content = Buffer.from('{"a":1}\n{"a":2}\n')
  const host = mockHost({
    requests: {
      'connections.state': state,
      'tree.children': ({ key }) =>
        key === 'conn:c1' || key === 'conn:c2'
          ? { nodes: [{ key: `${key}/db:shop`, kind: 'db', label: 'shop', hasChildren: true }] }
          : {
              nodes: [
                { key: `${key}/bucket:attachments`, kind: 'bucket', label: 'attachments', hasChildren: true },
                { key: `${key}/coll:orders`, kind: 'coll', label: 'orders', hasChildren: true },
                { key: `${key}/coll:archive`, kind: 'coll', label: 'archive', hasChildren: true }
              ]
            },
      'tree.details': { title: 'x', subtitle: 'Collection', items: [] },
      'query.run': (input) => {
        log('queryRun', input)
        return { queryId: 'q1', offset: 0, docs: [{ _id: int(1), a: 1 }, { _id: int(2), a: 2 }], truncated: [], hasMore: false, stoppedForSize: false, ms: 1 }
      },
      'query.count': { count: 2, approximate: false, ms: 1 },
      'history.list': { history: [], saved: [] },
      'import.upload': (input) => {
        log('upload', input)
        return { uploadId: 'up1', bytes: input.chunk.length }
      },
      'import.preview': (input) => {
        log('preview', input)
        return csvPreview
      },
      'import.start': start('importStart', 'import', () => ({ kind: 'import', read: 2, inserted: 2, updated: 0, failed: 0, collections: ['people'] })),
      'export.start': start('exportStart', 'export', (input: { options: { format: string } }) =>
        input.options.format === 'collection'
          ? { kind: 'export', docs: 2, collections: 1, bytes: 0, inserted: 2, updated: 0, failed: 0, indexes: 1 }
          : ({ kind: 'export', docs: 2, collections: 1, bytes: content.length, download: { name: 'orders.json', mimeType: 'application/x-ndjson', size: content.length } } satisfies ExportResult)
      ),
      'export.fields': { fields: ['_id', 'status', 'total', 'shipping.city'] },
      'data.count': (input) => {
        log('count', input)
        return { exists: true, count: 1234, kind: 'collection' }
      },
      'job.poll': ({ jobId }) => results.get(jobId)!,
      'job.read': ({ offset, size }) => ({ base64: content.subarray(offset, offset + Math.min(size, 7)).toString('base64'), total: content.length }),
      'job.close': null,
      'job.cancel': null,
      'compare.start': start('compareStart', 'compare', () => ({ kind: 'compare', same: 90, differ: 2, onlyA: 3, onlyB: 1, ids: { differ: [int(4), int(9)], onlyA: [int(1), int(2), int(3)], onlyB: ['x'] }, capped: false })),
      'compare.diff': (input) => {
        log('diff', input)
        return { a: { _id: int(4), n: int(1) }, b: { _id: int(4), n: int(2) }, diffs: [{ path: 'n', kind: 'changed', a: '1', b: '2' }], capped: false }
      },
      'compare.sync': start('sync', 'sync', () => ({ kind: 'sync', inserted: 3, replaced: 2, deleted: 0, failed: 0 })),
      'gridfs.list': (input) => {
        log('gridList', input)
        return { files: input.filename ? files.filter((f) => f.filename.includes(input.filename!)) : files, total: 2, ms: 1 }
      },
      'gridfs.preview': { text: '# Attachments\n', cut: false, binary: false, length: 40, chunks: 1, expectedChunks: 1 },
      'gridfs.download': start('gridDownload', 'gridfs-download', () => ({ kind: 'export', docs: 0, collections: 0, bytes: content.length, download: { name: 'readme.md', mimeType: 'text/markdown', size: content.length } })),
      'gridfs.upload': start('gridUpload', 'gridfs-upload', () => ({ kind: 'gridfs-upload', id: files[0]!.id, bytes: 5 })),
      'gridfs.delete': (input) => {
        log('gridDelete', input)
        return null
      },
      'gridfs.rename': (input) => {
        log('gridRename', input)
        return null
      },
      ...extra
    }
  })
  return { host, calls, content }
}

const tree = { type: 'Tree', label: 'Connections' }

async function at(host: ReturnType<typeof setup>['host'], key: string) {
  const view = await mount(panel, { host })
  await view.expand(tree, 'conn:c1')
  await view.expand(tree, 'conn:c1/db:shop')
  await view.selectItem(tree, key)
  return view
}

describe('import', () => {
  test('pasted CSV: preview, change a column, import, and the counts', async () => {
    const { host, calls } = setup()
    const view = await at(host, 'conn:c1/db:shop')
    await view.press({ label: 'Import into this database: a file, pasted documents or a mongodump folder' })
    await view.type({ type: 'Input', label: 'Collection' }, 'people')
    await view.type({ type: 'Textarea', label: 'Documents' }, 'name,age,zip\nAda,36,01234\n')
    await view.press({ text: 'Preview' })
    assert.deepEqual(calls.upload, [{ chunk: 'name,age,zip\nAda,36,01234\n' }])
    assert.deepEqual(view.rowsOf({ type: 'Table', label: 'Columns' }), ['name', 'age', 'zip'])
    assert.deepEqual(view.columnsOf({ type: 'Table', label: 'Columns' }, { width: 340 }), ['name', 'field', 'type'])
    await view.selectRows({ type: 'Table', label: 'Columns' }, ['age'])
    await view.select({ type: 'Select', label: 'Type' }, 'long')
    await view.type({ type: 'Input', label: 'Field for "age"' }, 'person.age', { replace: true })
    await view.press({ type: 'Button', text: 'Import' })
    assert.equal(calls.upload!.length, 1, 'the same text is not sent twice')
    const started = calls.importStart![0] as { source: unknown; ns: unknown; options: { format: string; csv: { columns: unknown } } }
    assert.deepEqual(started.source, { kind: 'upload', uploadId: 'up1' })
    assert.deepEqual(started.ns, { connectionId: 'c1', db: 'shop', collection: 'people' })
    assert.deepEqual(started.options.csv.columns, [
      { name: 'name', field: 'name', type: 'string' },
      { name: 'age', field: 'person.age', type: 'long' },
      { name: 'zip', field: 'zip', type: 'string' }
    ])
    assert.ok(view.find({ text: 'Read 2 documents: 2 inserted.' }))
    assert.ok(view.find({ text: 'Open the collection' }))
    assert.deepEqual(view.errors, [])
    assert.deepEqual(view.warnings, [])
  })

  test('dropping first asks, naming the collection and its count', async () => {
    const { host, calls } = setup()
    const view = await at(host, 'conn:c1/db:shop/coll:orders')
    await view.press({ label: 'Import into this collection' })
    await view.select({ type: 'RadioGroup', label: 'Source' }, 'path')
    await view.type({ type: 'Input', label: 'Path' }, '~/orders.json')
    await view.toggle({ type: 'Collapsible', label: 'How to write' })
    await view.toggle({ type: 'Checkbox', label: 'Drop the collection first' })
    await view.press({ type: 'Button', text: 'Import' })
    assert.ok(view.find({ type: 'Callout', label: 'Drop shop.orders?' }))
    assert.ok(view.find({ text: /its 1,234 documents and its indexes are deleted/ }))
    assert.equal(calls.importStart, undefined)
    await view.press({ text: 'Drop and import' })
    const started = calls.importStart![0] as { source: unknown; options: { drop: boolean } }
    assert.deepEqual(started.source, { kind: 'path', path: '~/orders.json' })
    assert.equal(started.options.drop, true)
  })
})

describe('export', () => {
  test('a collection tab\'s query to the save dialog', async () => {
    const { host, calls, content } = setup()
    const view = await at(host, 'conn:c1/db:shop/coll:orders')
    await view.press({ text: 'Open' })
    await view.type({ type: 'Input', label: 'Filter' }, "{ status: 'shipped' }")
    await view.press({ label: 'Export this query: JSON, CSV, BSON or another collection' })
    assert.equal(view.valueOf({ type: 'Input', label: 'Filter' }), "{ status: 'shipped' }")
    await view.press({ type: 'Button', text: 'Export' })
    const started = calls.exportStart![0] as { source: { kind: string; spec: { filter: unknown } }; options: unknown; destination: unknown }
    assert.deepEqual(started.source.spec.filter, { status: 'shipped' })
    assert.deepEqual(started.options, { format: 'json', json: { layout: 'lines', relaxed: true, pretty: false } })
    assert.deepEqual(started.destination, { kind: 'download' })
    await view.press({ text: /^Save orders\.json/ })
    const saved = host.callsOf('files.saveAs') as { suggestedName: string; data: ArrayBuffer }[]
    assert.equal(saved[0]!.suggestedName, 'orders.json')
    assert.deepEqual(Buffer.from(saved[0]!.data).toString('utf8'), content.toString('utf8'))
    assert.deepEqual(view.refusals, [])
  })

  test('CSV columns from sampled fields; a bad filter stops it', async () => {
    const { host, calls } = setup()
    const view = await at(host, 'conn:c1/db:shop/coll:orders')
    await view.press({ label: 'Export: JSON, CSV, BSON or another collection' })
    await view.select({ type: 'RadioGroup', label: 'Format' }, 'csv')
    await view.press({ text: 'Load the fields' })
    assert.deepEqual(view.rowsOf({ type: 'Table', label: 'Columns' }), ['_id', 'status', 'total', 'shipping.city'])
    await view.selectRows({ type: 'Table', label: 'Columns' }, ['total'])
    await view.press({ text: 'Remove 1' })
    await view.type({ type: 'Input', label: 'Filter' }, '{ a: ')
    await view.press({ type: 'Button', text: 'Export' })
    assert.equal(calls.exportStart, undefined)
    assert.ok(view.find({ text: /Fix the query first/ }))
    await view.type({ type: 'Input', label: 'Filter' }, '{ a: 1 }', { replace: true })
    await view.select({ type: 'RadioGroup', label: 'Save to' }, 'path')
    await view.type({ type: 'Input', label: 'Path' }, '/tmp/orders.csv')
    await view.press({ type: 'Button', text: 'Export' })
    const started = calls.exportStart![0] as { options: unknown; destination: unknown }
    assert.deepEqual(started.options, { format: 'csv', csv: { fields: ['_id', 'status', 'shipping.city'], delimiter: ',', header: true } })
    assert.deepEqual(started.destination, { kind: 'path', path: '/tmp/orders.csv', overwrite: false })
  })

  test('a database goes to a folder only', async () => {
    const { host, calls } = setup()
    const view = await at(host, 'conn:c1/db:shop')
    await view.press({ label: 'Export or copy the whole database' })
    assert.equal(view.valueOf({ type: 'RadioGroup', label: 'Save to' }), 'path')
    await view.select({ type: 'RadioGroup', label: 'Format' }, 'bson')
    await view.type({ type: 'Input', label: 'Folder' }, '~/dumps/shop')
    await view.press({ type: 'Button', text: 'Export' })
    const started = calls.exportStart![0] as { source: unknown; options: unknown }
    assert.deepEqual(started.source, { kind: 'database', connectionId: 'c1', db: 'shop' })
    assert.deepEqual(started.options, { format: 'bson', bson: { metadata: true } })
  })
})

describe('copy and paste', () => {
  test('a collection pasted on another connection\'s database copies it, with its indexes', async () => {
    const { host, calls } = setup()
    const view = await at(host, 'conn:c1/db:shop/coll:orders')
    await view.press({ label: 'Copy, to paste into another database or connection' })
    assert.ok(view.find({ text: /Copied shop\.orders\./ }))
    assert.ok(view.find({ text: 'Clipboard: shop.orders' }))
    await view.expand(tree, 'conn:c2')
    await view.selectItem(tree, 'conn:c2/db:shop')
    await view.press({ type: 'Button', text: 'Paste' })
    assert.equal(view.valueOf({ type: 'RadioGroup', label: 'Format' }), 'collection')
    assert.equal(view.valueOf({ type: 'Select', label: 'Connection' }), 'c2')
    assert.equal(view.valueOf({ type: 'Input', label: 'Collection' }), 'orders')
    assert.ok(view.find({ text: 'From: Local dev › shop.orders · Into: Staging › shop.orders' }), 'a copy names where it writes')
    await view.select({ type: 'RadioGroup', label: 'When the documents are there already' }, 'replace')
    await view.press({ type: 'Button', text: 'Copy' })
    assert.ok(view.find({ text: /This drops shop\.orders on Staging \(1,234 documents\)/ }))
    assert.deepEqual(calls.count, [{ ns: { connectionId: 'c2', db: 'shop', collection: 'orders' } }])
    await view.press({ text: 'Drop and copy' })
    const started = calls.exportStart![0] as { source: { kind: string; ns: unknown }; options: unknown }
    assert.equal(started.source.kind, 'query')
    assert.deepEqual(started.options, { format: 'collection', collection: { connectionId: 'c2', db: 'shop', mode: 'replace', indexes: true, options: true, collection: 'orders' } })
    assert.ok(view.find({ text: 'Copied 2 documents: 2 inserted, 1 indexes.' }))
  })

  test('selected documents pasted on a collection merge by _id', async () => {
    const { host, calls } = setup()
    const view = await at(host, 'conn:c1/db:shop/coll:orders')
    await view.press({ text: 'Open' })
    await view.press({ text: 'Run' })
    await view.selectRows({ type: 'Table', label: 'Documents' }, ['{"$numberInt":"1"}', '{"$numberInt":"2"}'])
    await view.press({ label: 'Copy these 2 documents, to paste into another collection' })
    await view.select({ type: 'Tabs' }, 'tree')
    await view.selectItem(tree, 'conn:c1/db:shop/coll:archive')
    await view.press({ type: 'Button', text: 'Paste' })
    assert.equal(view.valueOf({ type: 'Input', label: 'Filter' }), '{ _id: { $in: [1, 2] } }')
    assert.equal(view.valueOf({ type: 'Input', label: 'Collection' }), 'archive')
    assert.equal(view.valueOf({ type: 'RadioGroup', label: 'When the documents are there already' }), 'upsert')
    await view.press({ type: 'Button', text: 'Copy' })
    const started = calls.exportStart![0] as { source: { spec: { filter: unknown } } }
    assert.deepEqual(started.source.spec.filter, { _id: { $in: [int(1), int(2)] } })
  })
})

describe('compare and sync', () => {
  test('counts, a pair\'s differences, and a sync asked first', async () => {
    const { host, calls } = setup()
    const view = await at(host, 'conn:c1/db:shop/coll:orders')
    await view.press({ label: 'Compare with another collection' })
    await view.select({ type: 'Select', label: 'Compare with, on' }, 'c2')
    await view.type({ type: 'Input', label: 'Collection' }, 'orders')
    await view.type({ type: 'Input', label: 'Leave out fields' }, 'updatedAt, meta.v')
    await view.press({ type: 'Button', text: 'Compare' })
    assert.deepEqual(calls.compareStart, [{ a: ns, b: { connectionId: 'c2', db: 'shop', collection: 'orders' }, rules: { ignoreFields: ['updatedAt', 'meta.v'], ignoreOrder: false } }])
    assert.deepEqual(view.rowsOf({ type: 'Table', label: 'Documents' }), ['{"$numberInt":"4"}', '{"$numberInt":"9"}'])
    await view.selectRows({ type: 'Table', label: 'Documents' }, ['{"$numberInt":"4"}'])
    assert.deepEqual((calls.diff![0] as { id: unknown }).id, int(4))
    assert.deepEqual(view.rowsOf({ type: 'Table', label: 'Differences' }), ['d0'])
    const sides = { text: 'A: Local dev › shop.orders · B: Staging › shop.orders' }
    assert.ok(view.find(sides), 'a compare names both sides')
    await view.select({ type: 'Select', label: 'Compare with, on' }, 'c1')
    assert.ok(view.find(sides), 'until it compares again, the line names the pair Sync writes to')
    await view.select({ type: 'Select', label: 'Compare with, on' }, 'c2')
    await view.press({ text: 'Only in A (3)' })
    assert.equal(view.rowsOf({ type: 'Table', label: 'Documents' }).length, 3)
    await view.toggle({ type: 'Collapsible', label: 'Sync' })
    await view.toggle({ type: 'Checkbox', label: 'Delete what is only in B' })
    await view.press({ text: 'Sync 6 documents' })
    assert.ok(view.find({ type: 'Callout', label: 'Change shop.orders on Staging?' }))
    assert.ok(view.find({ text: /3 inserted, 2 replaced, 1 deleted/ }))
    assert.equal(calls.sync, undefined)
    await view.press({ type: 'Button', text: 'Sync' })
    assert.deepEqual(calls.sync, [{ from: ns, to: { connectionId: 'c2', db: 'shop', collection: 'orders' }, rules: { ignoreFields: ['updatedAt', 'meta.v'], ignoreOrder: false }, insert: true, replace: true, remove: true }])
    assert.ok(view.find({ text: /Synced shop\.orders: 3 inserted, 2 replaced, 0 deleted/ }))
    assert.deepEqual(view.warnings, [])
  })

  test('deleting side B\'s connection closes the comparison', async () => {
    const { host } = setup({ 'connections.delete': null })
    const view = await at(host, 'conn:c1/db:shop/coll:orders')
    await view.press({ label: 'Compare with another collection' })
    await view.select({ type: 'Select', label: 'Compare with, on' }, 'c2')
    assert.ok(view.find({ type: 'Tab', label: 'Compare: orders' }))
    await view.select({ type: 'Tabs' }, 'tree')
    await view.selectItem(tree, 'conn:c2')
    await view.press({ label: 'Delete connection' })
    await view.press({ text: 'Delete connection' })
    assert.equal(view.find({ type: 'Tab', label: 'Compare: orders' }), null)
  })

  test('the same collection is refused', async () => {
    const { host } = setup()
    const view = await at(host, 'conn:c1/db:shop/coll:orders')
    await view.press({ label: 'Compare with another collection' })
    await view.type({ type: 'Input', label: 'Collection' }, 'orders')
    assert.ok(view.find({ text: 'Choose another collection: this is the same one.' }))
    assert.equal(view.find({ type: 'Button', text: 'Compare' })!.disabled, true)
  })
})

describe('GridFS', () => {
  test('lists, previews, downloads, renames, deletes and uploads', async () => {
    const { host, calls, content } = setup()
    const view = await at(host, 'conn:c1/db:shop/bucket:attachments')
    await view.press({ text: 'Browse files' })
    assert.deepEqual(view.rowsOf({ type: 'Table', label: 'Files' }), files.map((f) => JSON.stringify(f.id)))
    assert.deepEqual(view.columnsOf({ type: 'Table', label: 'Files' }, { width: 420 }), ['name', 'size', 'at'])
    await view.selectRows({ type: 'Table', label: 'Files' }, [JSON.stringify(files[0]!.id)])
    assert.equal(view.find({ type: 'CodeView', label: 'Start of readme.md' })!.props.code, '# Attachments\n')
    await view.press({ text: 'Prepare the download' })
    assert.deepEqual((calls.gridDownload![0] as { destination: unknown }).destination, { kind: 'download' })
    await view.press({ text: /^Save readme\.md/ })
    const saved = host.callsOf('files.saveAs') as { data: ArrayBuffer }[]
    assert.equal(Buffer.from(saved[0]!.data).toString('utf8'), content.toString('utf8'))
    await view.type({ type: 'Input', label: 'Name' }, 'README.md', { replace: true })
    await view.press({ text: 'Rename' })
    assert.deepEqual(calls.gridRename, [{ connectionId: 'c1', db: 'shop', bucket: 'attachments', id: files[0]!.id, filename: 'README.md' }])
    await view.press({ label: 'Delete readme.md' })
    assert.ok(view.find({ type: 'Callout', label: 'Delete readme.md?' }))
    await view.press({ text: 'Delete file' })
    assert.deepEqual(calls.gridDelete, [{ connectionId: 'c1', db: 'shop', bucket: 'attachments', id: files[0]!.id }])
    await view.type({ type: 'Input', label: 'Name contains' }, 'big', { submit: true })
    assert.deepEqual((calls.gridList!.at(-1) as { filename: string }).filename, 'big')
    await view.toggle({ type: 'Collapsible', label: 'Upload a file' })
    await view.select({ type: 'RadioGroup', label: 'Source' }, 'paste')
    await view.type({ type: 'Textarea', label: 'Text' }, 'hello')
    await view.type({ type: 'Input', label: 'File name' }, 'hello.txt')
    await view.type({ type: 'Input', label: 'Metadata' }, "{ owner: 'me' }")
    await view.press({ type: 'Button', text: 'Upload' })
    assert.deepEqual(calls.gridUpload, [{ connectionId: 'c1', db: 'shop', bucket: 'attachments', source: { kind: 'upload', uploadId: 'up1' }, filename: 'hello.txt', metadata: { owner: 'me' } }])
    assert.ok(view.find({ text: 'Uploaded hello.txt (5 B).' }))
    assert.deepEqual(view.errors, [])
    assert.deepEqual(view.warnings, [])
    assert.deepEqual(view.refusals, [])
  })
})

describe('jobs', () => {
  test('a failed job says why, and errors are listed', async () => {
    const failed = (jobId: string): JobState => ({ ...done(jobId, 'import', { kind: 'import', read: 3, inserted: 1, updated: 0, failed: 2, collections: ['x'] }), status: 'failed', message: 'The file ends in the middle of document 3.', errorCount: 2, errors: [{ record: 1, ns: 'shop.x', message: 'E11000 duplicate key' }, { record: 2, ns: 'shop.x', message: 'Line 2: not a document' }] })
    const { host } = setup({ 'import.start': () => ({ jobId: 'bad' }), 'job.poll': ({ jobId }) => failed(jobId) })
    const view = await at(host, 'conn:c1/db:shop/coll:orders')
    await view.press({ label: 'Import into this collection' })
    await view.type({ type: 'Textarea', label: 'Documents' }, '{"a":1}')
    await view.press({ type: 'Button', text: 'Import' })
    assert.ok(view.find({ type: 'Callout', label: 'The import failed' }))
    assert.ok(view.find({ text: /The file ends in the middle of document 3\./ }))
    assert.deepEqual(view.rowsOf({ type: 'Table', label: 'Errors' }), ['e0', 'e1'])
  })
})
