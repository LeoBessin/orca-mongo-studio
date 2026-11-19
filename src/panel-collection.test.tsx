// Collection tabs over a stand-in worker: querying, paging, the views, the editors, the Query
// Builder and history. What the person sees, and what reaches the worker.
import { assert, describe, mockHost, mount, test, type MockRequests, type MountOptions } from 'orca/testing'
import type { ConnectionsState, JobState, QueryLibrary, QueryPage, QuerySpec, QueryText } from './protocol'
import type { JsonObject, JsonValue } from './shared/ejson-view'
import * as panel from './panel'
import { docTabIdFor, tabIdFor } from './panel/collection-state'
import { AGGREGATION_PLACES, COLLECTION_PLACES, noticePlace } from './panel/notice-view'

const state: ConnectionsState = {
  connections: [{ id: 'c1', name: 'Local dev', group: '', subtitle: 'localhost', topology: 'replicaSet', connected: true, readOnly: false }],
  favourites: [],
  secretsProtection: 'os-keyring'
}

const oid = (n: number): JsonObject => ({ $oid: `6542f1a2b3c4d5e6f7a8b9${String(n).padStart(2, '0')}` })
const orders: JsonObject[] = Array.from({ length: 3 }, (_, i) => ({
  _id: oid(i),
  status: i === 0 ? 'shipped' : 'pending',
  total: { $numberDecimal: `${(i + 1) * 10}.5` },
  qty: { $numberInt: String(i + 1) },
  payment: { method: 'card', last4: '1234' },
  createdAt: { $date: { $numberLong: '1794832496789' } }
}))

type Calls = { runs: { spec: QuerySpec; pageSize: number; text?: QueryText }[]; pages: { offset: number }[]; [k: string]: unknown[] }

function setup(extra: MockRequests = {}, kind: 'coll' | 'view' = 'coll', storage: Record<string, JsonValue> = {}, settings: Record<string, JsonValue> = {}) {
  const calls: Calls = { runs: [], pages: [], updates: [], replaces: [], inserts: [], deletes: [] }
  let library: QueryLibrary = { history: [], saved: [] }
  const page = (offset: number, docs: JsonObject[], hasMore: boolean): QueryPage => ({ queryId: 'q1', offset, docs, truncated: [], hasMore, stoppedForSize: false, ms: 3 })
  const host = mockHost({
    storage,
    settings,
    requests: {
      'connections.state': state,
      'tree.children': ({ key }) =>
        key === 'conn:c1'
          ? { nodes: [{ key: 'conn:c1/db:shop', kind: 'db', label: 'shop', hasChildren: true }] }
          : { nodes: [{ key: `conn:c1/db:shop/${kind}:orders`, kind, label: 'orders', hasChildren: kind !== 'view' }] },
      'tree.details': { title: 'orders', subtitle: 'Collection', items: [] },
      'query.run': (input) => {
        calls.runs.push(input)
        if (input.text) library = { ...library, history: [{ at: 1, query: input.text }, ...library.history] }
        return page(0, orders, true)
      },
      'query.page': (input) => {
        calls.pages.push(input)
        return page(input.offset, input.offset >= 3 ? [{ ...orders[0]!, _id: oid(9) }] : orders, false)
      },
      'query.count': { count: 4, approximate: false, ms: 1 },
      'query.close': null,
      'doc.get': ({ id }) => ({ doc: orders.find((o) => JSON.stringify(o._id) === JSON.stringify(id)) ?? null }),
      'doc.updateField': (input) => {
        calls.updates!.push(input)
        return { matched: 1, modified: 1 }
      },
      'doc.replace': (input) => {
        calls.replaces!.push(input)
        return { matched: 1, modified: 1 }
      },
      'doc.insert': (input) => {
        calls.inserts!.push(input)
        return { insertedIds: [oid(50)] }
      },
      'doc.deleteMany': (input) => {
        calls.deletes!.push(input)
        return { deleted: input.ids.length }
      },
      'history.list': () => library,
      'saved.save': ({ name, query }) => (library = { ...library, saved: [{ name, at: 2, query }] }),
      ...extra
    }
  })
  return { host, calls }
}

async function openOrders(host: ReturnType<typeof setup>['host'], kind: 'coll' | 'view' = 'coll', persisted?: MountOptions['persisted']) {
  const view = await mount(panel, { host, persisted })
  const tree = { type: 'Tree' }
  await view.expand(tree, 'conn:c1')
  await view.expand(tree, 'conn:c1/db:shop')
  await view.selectItem(tree, `conn:c1/db:shop/${kind}:orders`)
  await view.press({ text: kind === 'view' ? 'Open view' : 'Open' })
  return view
}

const table = { type: 'Table', label: 'Documents' }

/** A finished update job, as `job.poll` answers it. */
const updateJob = (jobId: string, matched: number, modified: number, failed?: string): JobState => ({
  jobId,
  kind: 'update',
  status: failed ? 'failed' : 'done',
  version: 2,
  phase: failed ? 'Failed' : 'Done',
  done: 0,
  total: null,
  unit: 'documents',
  errors: [],
  errorCount: 0,
  ...(failed ? { message: failed } : { result: { kind: 'update', matched, modified } }),
  started: 0,
  ms: 5
})
const RESULT_VIEW = 'mongo-studio.resultView'
const DOC_VIEW = 'mongo-studio.docView'

describe('Copy as JSON', () => {
  /** The orders, with the second one's long values shortened by the worker. */
  const shortened = (): MockRequests => {
    const copies: unknown[] = []
    return {
      copies,
      'query.run': () => ({ queryId: 'q1', offset: 0, docs: orders, truncated: [1], hasMore: false, stoppedForSize: false, ms: 3 }),
      'clipboard.copyDocuments': (input) => {
        copies.push(input)
        return { copied: input.items.length, reread: input.items.filter((i) => i.reread).length, gone: 0 }
      }
    } as MockRequests
  }

  test('copies what the page shows, reading a shortened document again only without a projection', async () => {
    const extra = shortened()
    const copies = (extra as unknown as { copies: { items: { doc: JsonObject; reread?: boolean }[] }[] }).copies
    const { host } = setup(extra)
    const view = await openOrders(host)
    await view.selectRows(table, [JSON.stringify(oid(0)), JSON.stringify(oid(1))])
    await view.press({ text: 'Copy as JSON' })
    assert.deepEqual(copies[0]!.items, [{ doc: orders[0] }, { doc: orders[1], reread: true }])
    assert.ok(view.find({ text: 'Copied 2 documents as JSON.' }))

    // A projection shapes the page: reading the document again would bring back what it removed.
    await view.type({ label: 'Projection' }, '{ status: 1 }', { replace: true })
    await view.press({ text: 'Run' })
    await view.selectRows(table, [JSON.stringify(oid(1))])
    await view.press({ text: 'Copy as JSON' })
    assert.deepEqual(copies[1]!.items, [{ doc: orders[1] }])
    assert.ok(view.find({ text: 'Copied 1 document as JSON. It has long values shortened, as on this page.' }))
  })

  test('a view is copied as its page shows it: its _id need not be unique', async () => {
    const extra = shortened()
    const copies = (extra as unknown as { copies: { items: { reread?: boolean }[] }[] }).copies
    const { host } = setup(extra, 'view')
    const view = await openOrders(host, 'view')
    await view.selectRows(table, [JSON.stringify(oid(1))])
    await view.press({ text: 'Copy as JSON' })
    assert.equal(copies[0]!.items[0]!.reread, undefined)
  })

  test('an open document copies itself, as read whole, with its own JSON setting', async () => {
    const extra = shortened()
    const copies = (extra as unknown as { copies: { items: { doc: JsonObject; reread?: boolean }[]; relaxed: boolean }[] }).copies
    const { host } = setup(extra)
    const view = await openOrders(host)
    await view.selectRows(table, [JSON.stringify(oid(1))])
    await view.press({ type: 'Button', text: 'Open' })
    await view.press({ text: 'JSON' })
    await view.toggle({ label: 'Relaxed Extended JSON' })
    const relaxed = view.valueOf({ label: 'Relaxed Extended JSON' })
    await view.press({ text: 'Copy as JSON' })
    assert.deepEqual(copies[0]!.items, [{ doc: orders[1] }], 'not read again: it already is whole')
    assert.equal(copies[0]!.relaxed, relaxed)
    assert.ok(view.find({ text: 'Copied 1 document as JSON.' }))
  })

  test('an open document shortens long strings so it stays highlighted, and shows them on demand', async () => {
    const poly = 'BG06m79C0z24M7'.repeat(300)
    const { host } = setup({ 'doc.get': () => ({ doc: { ...orders[0]!, flexipoly: [poly] } }) })
    const view = await openOrders(host)
    await view.selectRows(table, [JSON.stringify(oid(0))])
    await view.press({ type: 'Button', text: 'Open' })
    await view.press({ text: 'JSON' })
    const code = (): string => view.find({ type: 'CodeView', label: 'Document as Extended JSON' })!.props.code as string
    assert.equal(code().includes(poly), false)
    assert.ok(code().includes('… [4,080 more characters]'))
    assert.ok(view.find({ text: /^1 long value is shortened here so the rest stays highlighted/ }))
    await view.toggle({ label: 'Show long values in full' })
    assert.ok(code().includes(poly))
  })

  test('the JSON view copies the whole page', async () => {
    const extra = shortened()
    const copies = (extra as unknown as { copies: { items: unknown[] }[] }).copies
    const { host } = setup(extra)
    const view = await openOrders(host)
    await view.press({ text: 'JSON' })
    await view.press({ text: 'Copy page as JSON' })
    assert.equal(copies[0]!.items.length, 3)
    assert.ok(view.find({ text: /^Copied 3 documents as JSON\./ }))
  })
})

describe('notice places', () => {
  test('a notice shows in its own place, or at the top of a tab that has no such place', () => {
    assert.equal(noticePlace({ at: 'results' }, COLLECTION_PLACES), 'results')
    assert.equal(noticePlace({ at: 'builder' }, COLLECTION_PLACES), 'builder')
    assert.equal(noticePlace({}, COLLECTION_PLACES), 'top')
    assert.equal(noticePlace({ at: 'builder' }, AGGREGATION_PLACES), 'top', 'an aggregation tab has no Query Builder')
    assert.equal(noticePlace({ at: 'view' }, COLLECTION_PLACES), 'top')
  })

  test('a deleted document is reported with the title Done', async () => {
    const { host } = setup({}, 'coll', {}, { confirmDeleteDocs: false })
    const view = await openOrders(host)
    await view.selectRows(table, [JSON.stringify(oid(2))])
    await view.press({ text: 'Delete' })
    assert.ok(view.findAll({ type: 'Callout' }).some((c) => c.props.title === 'Done'), 'titled Done, not Orca\'s default Tip')
    assert.ok(view.find({ text: /^Deleted 1 document from shop\.orders\.$/ }))
  })
})

describe('collection tabs', () => {
  test('opening a collection runs it and shows a table with the count', async () => {
    const { host, calls } = setup()
    const view = await openOrders(host)
    assert.equal(view.valueOf({ type: 'Tabs' }), tabIdFor({ connectionId: 'c1', db: 'shop', collection: 'orders' }))
    assert.equal(calls.runs.length, 1)
    assert.deepEqual(calls.runs[0]!.spec, { filter: {}, skip: 0, limit: 0 })
    assert.equal(calls.runs[0]!.text, undefined, 'opening is not recorded in the history')
    assert.deepEqual(view.columnsOf(table), ['_id', 'status', 'total', 'qty', 'payment', 'createdAt'])
    const rows = view.find(table)!.props.rows as { cells: Record<string, string> }[]
    assert.deepEqual(rows[0]!.cells, { _id: 'ObjectId(6542f1a2b3c4d5e6f7a8b900)', status: 'shipped', total: '10.5', qty: '1', payment: '{2 fields}', createdAt: '2026-11-16T12:34:56.789Z' })
    assert.ok(view.find({ text: '1–3 of 4' }))
    assert.ok(view.find({ type: 'Text', text: 'shop.orders' }))
    assert.ok(view.find({ type: 'Text', text: 'Local dev' }), 'under its namespace, the tab names its connection')
    assert.deepEqual(view.errors, [])
    assert.deepEqual(view.warnings, [])
  })

  test('Enter on a collection in the tree opens it too, once', async () => {
    const { host } = setup()
    const view = await mount(panel, { host })
    await view.expand({ type: 'Tree' }, 'conn:c1')
    await view.expand({ type: 'Tree' }, 'conn:c1/db:shop')
    await view.activateItem({ type: 'Tree' }, 'conn:c1/db:shop/coll:orders')
    await view.select({ type: 'Tabs' }, 'tree')
    await view.activateItem({ type: 'Tree' }, 'conn:c1/db:shop/coll:orders')
    assert.equal(view.valueOf({ type: 'Tabs' }), tabIdFor({ connectionId: 'c1', db: 'shop', collection: 'orders' }))
    assert.equal(view.findAll({ type: 'Tab' }).length, 2)
  })

  test('the query bar parses shell syntax, records history, and points at errors', async () => {
    const { host, calls } = setup()
    const view = await openOrders(host)
    await view.type({ label: 'Filter' }, "{ status: 'shipped', _id: { $gt: ObjectId('6542f1a2b3c4d5e6f7a8b900') } ")
    await view.press({ text: 'Run' })
    assert.equal(calls.runs.length, 1, 'nothing runs with a broken filter')
    assert.ok(view.find({ text: /never closed with \} \(line 1, column 1\)/ }))
    await view.type({ label: 'Filter' }, '}')
    await view.type({ label: 'Sort' }, '{ total: -1 }', { submit: true })
    const last = calls.runs.at(-1)!
    assert.deepEqual(last.spec.filter, { status: 'shipped', _id: { $gt: { $oid: '6542f1a2b3c4d5e6f7a8b900' } } })
    assert.deepEqual(last.spec.sort, { total: { $numberInt: '-1' } })
    assert.equal(last.text!.sort, '{ total: -1 }')
    await view.toggle({ type: 'Collapsible', label: 'History and saved queries' })
    assert.equal(view.rowsOf({ type: 'Table', label: 'Recent queries' }).length, 1)
  })

  test('the query bar says what is wrong while typing, but not about text that is only unfinished', async () => {
    const { host, calls } = setup()
    const view = await openOrders(host)
    const full = "{ active: true, _id: ObjectId('6542f1a2b3c4d5e6f7a8b900'), n: -1.5e3, at: { $gte: new Date('2026-01-02') } }"
    for (const c of full) {
      await view.type({ label: 'Filter' }, c)
      assert.equal(view.find({ type: 'Field', label: 'Filter' })!.props.error, undefined, view.valueOf({ label: 'Filter' }) as string)
    }
    await view.type({ label: 'Filter' }, ' ]')
    assert.ok(view.find({ text: /Unexpected "\]" after the value/ }), 'a wrong bracket is reported before running')
    await view.toggle({ type: 'Collapsible', label: 'Collation, skip and limit' })
    await view.type({ label: 'Limit' }, 'x')
    assert.ok(view.find({ text: 'Limit is a whole number, 0 or more.' }))
    assert.equal(calls.runs.length, 1)
  })

  test('Format puts a field on several lines, Ctrl+Enter runs it, and one line puts it back', async () => {
    const { host, calls } = setup()
    const view = await openOrders(host)
    await view.type({ label: 'Filter' }, "{status:'shipped',total:{$gt:100}}")
    await view.press({ type: 'IconButton', label: 'Format the filter on several lines' })
    assert.equal(view.valueOf({ label: 'Filter' }), "{\n  status: 'shipped',\n  total: { $gt: 100 }\n}")
    assert.ok(view.find({ type: 'Textarea', label: 'Filter' }))
    assert.ok(view.find({ text: 'Ctrl+Enter or Cmd+Enter runs the query.' }))
    await view.submit({ label: 'Filter' })
    assert.deepEqual(calls.runs.at(-1)!.spec.filter, { status: 'shipped', total: { $gt: { $numberInt: '100' } } })
    assert.equal(calls.runs.at(-1)!.text!.filter, "{\n  status: 'shipped',\n  total: { $gt: 100 }\n}", 'the history keeps it formatted')
    await view.press({ type: 'IconButton', label: 'Put the filter on one line' })
    assert.equal(view.valueOf({ label: 'Filter' }), "{ status: 'shipped', total: { $gt: 100 } }")
    assert.ok(view.find({ type: 'Input', label: 'Filter' }))
    await view.type({ label: 'Sort' }, '{ total: -1')
    await view.press({ type: 'IconButton', label: 'Format the sort on several lines' })
    assert.equal(view.valueOf({ label: 'Sort' }), '{ total: -1', 'unclosed text is not reformatted')
    assert.ok(view.find({ type: 'Textarea', label: 'Sort' }), 'but it still gets the room to finish it')
    assert.ok(view.find({ text: "Can't format: This { is never closed with } (line 1, column 1)" }))
    assert.deepEqual(view.warnings, [])
    assert.deepEqual(view.errors, [])
  })

  test('a multi-line box stays one while typed in, and follows text replaced from elsewhere', async () => {
    const { host } = setup()
    const view = await openOrders(host)
    await view.type({ label: 'Filter' }, "{\n  status: 'shipped'\n}")
    assert.ok(view.find({ type: 'Textarea', label: 'Filter' }), 'text with a line break opens multi-line')
    await view.type({ label: 'Filter' }, "{ status: 'shipped' }", { replace: true })
    assert.ok(view.find({ type: 'Textarea', label: 'Filter' }), 'joining the lines keeps the box being typed in')
    await view.type({ label: 'Sort' }, '{ qty: 1, total: -1 }')
    await view.press({ type: 'IconButton', label: 'Format the sort on several lines' })
    assert.ok(view.find({ type: 'Textarea', label: 'Sort' }))
    await view.sort(table, 'total')
    assert.equal(view.valueOf({ label: 'Sort' }), '{ total: 1 }')
    assert.ok(view.find({ type: 'Input', label: 'Sort' }), 'a sorted column writes one line, in a one-line box')
  })

  test('one line re-checks the field, and Format refuses to pass what the history keeps', async () => {
    const { host } = setup()
    const view = await openOrders(host)
    await view.type({ label: 'Filter' }, '{\n  a: 1\n  b: 2\n}')
    assert.ok(view.find({ text: /\(line 3, column 3\)/ }))
    await view.press({ type: 'IconButton', label: 'Put the filter on one line' })
    assert.equal(view.valueOf({ label: 'Filter' }), '{ a: 1 b: 2 }')
    assert.equal(view.find({ text: /line 3/ }), null, 'the old position is gone')
    assert.ok(view.find({ text: /\(line 1, column 8\)/ }))
    const ids = Array.from({ length: 140 }, (_, i) => `'${String(i).padStart(24, '0')}'`).join(',')
    await view.type({ label: 'Filter' }, `{ _id: { $in: [${ids}] } }`, { replace: true })
    await view.press({ type: 'IconButton', label: 'Format the filter on several lines' })
    assert.ok(view.find({ text: /Formatted, this would be [\d,]+ characters, and the query history keeps up to 4,000\. Left as it is\./ }))
    assert.ok(view.find({ type: 'Input', label: 'Filter' }))
  })

  test('paging reads on from the current page, and sorting a column re-runs', async () => {
    const { host, calls } = setup()
    const view = await openOrders(host)
    await view.press({ label: 'Next page' })
    assert.deepEqual(calls.pages.map((p) => p.offset), [3])
    assert.ok(view.find({ text: '4–4 of 4' }))
    await view.press({ label: 'Previous page' })
    assert.deepEqual(calls.pages.map((p) => p.offset), [3, 0])
    await view.sort(table, 'total')
    assert.deepEqual(calls.runs.at(-1)!.spec.sort, { total: { $numberInt: '1' } })
    assert.deepEqual(view.find(table)!.props.sort, { column: 'total', direction: 'asc' })
  })

  test('a sub-document can be shown as dotted columns', async () => {
    const { host } = setup()
    const view = await openOrders(host)
    await view.select({ label: 'Show a sub-document as columns' }, 'payment')
    assert.deepEqual(view.columnsOf(table), ['_id', 'status', 'total', 'qty', 'payment.method', 'payment.last4', 'createdAt'])
  })

  test('wide documents stay within the columns and keys Orca draws, sub-document columns first', async () => {
    const long = 'x'.repeat(80)
    const wide: JsonObject = { _id: oid(0), options: Object.fromEntries(Array.from({ length: 10 }, (_, i) => [`o${i}`, i])), '': 'empty', [long]: 'long', 'options.o1': 'literal' }
    for (let i = 0; i < 30; i++) wide[`f${String(i).padStart(2, '0')}`] = i
    const twin: JsonObject = { ...wide, f00: 'unwound' }
    const { host } = setup({ 'query.run': () => ({ queryId: 'q1', offset: 0, docs: [wide, twin], truncated: [], hasMore: false, stoppedForSize: false, ms: 1 }) })
    const view = await openOrders(host)
    const cols = (): { key: string; label: string }[] => view.find(table)!.props.columns as { key: string; label: string }[]
    assert.equal(cols().length, 32)
    assert.ok(view.find({ text: 'Showing 32 of 35 columns, as many as Orca draws. Tree, JSON and Open show every field.' }))
    assert.ok(cols().some((c) => c.label === '(empty name)'))
    assert.ok(cols().every((c) => c.key.length >= 1 && c.key.length <= 64))

    await view.select({ label: 'Show a sub-document as columns' }, 'options')
    assert.equal(cols().length, 32)
    const labels = cols().map((c) => c.label)
    assert.deepEqual(labels.slice(0, 11), ['_id', ...Array.from({ length: 10 }, (_, i) => `options.o${i}`)], 'the sub-document asked for keeps its columns')
    const keys = cols().map((c) => c.key)
    assert.equal(new Set(keys).size, keys.length, 'a top-level "options.o1" next to options.o1 gets its own key')
    const rows = view.find(table)!.props.rows as { key: string; cells: Record<string, string> }[]
    assert.deepEqual(rows.map((r) => r.key), [JSON.stringify(oid(0)), '#1'], 'a repeated _id gets its place as a key')
    assert.equal(rows[0]!.cells[keys[labels.indexOf('options.o3')]!], '3')
    await view.selectRows(table, ['#1'])
    assert.ok(view.find({ text: 'Edit document' }))
    assert.deepEqual(view.errors, [])
    assert.deepEqual(view.warnings, [])
  })

  test('field editor: the type is its own choice, and saving sets that path', async () => {
    const { host, calls } = setup()
    const view = await openOrders(host)
    await view.selectRows(table, [JSON.stringify(oid(1))])
    await view.select({ label: 'Edit a field' }, 'qty')
    assert.ok(view.find({ type: 'Card', label: 'Edit qty' }))
    assert.equal(view.valueOf({ label: 'Type' }), 'int')
    assert.equal(view.find({ text: 'Save field' })!.disabled, true, 'nothing to save before a change')
    await view.type({ label: 'Value' }, '3000000000', { replace: true })
    assert.ok(view.find({ text: /Use Int64/ }))
    await view.select({ label: 'Type' }, 'long')
    assert.ok(view.find({ text: /changes the type from Int32 to Int64/ }))
    await view.press({ text: 'Save field' })
    assert.deepEqual(calls.updates, [{ ns: { connectionId: 'c1', db: 'shop', collection: 'orders' }, id: oid(1), path: ['qty'], value: { $numberLong: '3000000000' } }])
    assert.ok(view.find({ text: 'Saved qty.' }))
  })

  test('document editor: shell syntax in, replaceOne out; clone inserts without _id', async () => {
    const { host, calls } = setup()
    const view = await openOrders(host)
    await view.activateRow(table, JSON.stringify(oid(0)))
    const text = view.valueOf({ label: 'Document' }) as string
    assert.match(text, /_id: ObjectId\('6542f1a2b3c4d5e6f7a8b900'\)/)
    assert.match(text, /total: NumberDecimal\('10.5'\)/)
    await view.type({ label: 'Document' }, text.replace("status: 'shipped'", "status: 'delivered'"), { replace: true })
    await view.press({ text: 'Save document' })
    const replaced = calls.replaces![0] as { doc: JsonObject; id: JsonValue }
    assert.equal(replaced.doc.status, 'delivered')
    assert.deepEqual(replaced.id, oid(0))

    await view.selectRows(table, [JSON.stringify(oid(2))])
    await view.press({ text: 'Clone' })
    assert.equal(/_id/.test(view.valueOf({ label: 'Document' }) as string), false)
    await view.type({ label: 'Document' }, '{ broken: ', { replace: true })
    assert.equal(view.find({ text: 'Insert' })!.disabled, true)
    await view.select({ label: 'Syntax' }, 'ejson')
    assert.ok(view.find({ text: /Fix the document before switching/ }))
    await view.type({ label: 'Document' }, '{ status: "copy", n: NumberLong(5) }', { replace: true })
    await view.press({ text: 'Insert' })
    assert.deepEqual((calls.inserts![0] as { docs: JsonObject[] }).docs, [{ status: 'copy', n: { $numberLong: '5' } }])
    assert.ok(view.find({ text: /Inserted a document with _id ObjectId\('6542f1a2b3c4d5e6f7a8b950'\)/ }))
  })

  test('bulk delete names the namespace and count, and waits for the confirmation', async () => {
    const { host, calls } = setup()
    const view = await openOrders(host)
    await view.selectRows(table, [JSON.stringify(oid(0)), JSON.stringify(oid(2))])
    await view.press({ text: 'Delete 2' })
    assert.ok(view.find({ type: 'Callout', label: 'Delete 2 documents from shop.orders?' }))
    assert.deepEqual(calls.deletes, [])
    await view.press({ text: 'Delete 2 documents' })
    assert.deepEqual((calls.deletes![0] as { ids: JsonValue[] }).ids, [oid(0), oid(2)])
    assert.ok(view.find({ text: 'Deleted 2 documents from shop.orders.' }))
  })

  test('update many: selected rows by _id, previewed before and after, then confirmed', async () => {
    const previews: unknown[] = []
    const { host, calls } = setup({
      'doc.updatePreview': (input) => {
        previews.push(input)
        return {
          count: 2,
          approximate: false,
          sample: { before: orders[0]!, after: { ...orders[0]!, status: 'archived' }, diffs: [{ path: 'status', kind: 'changed', a: "'shipped'", b: "'archived'" }], capped: false },
          ms: 2
        }
      },
      'doc.updateMany': (input) => {
        calls.updates!.push(input)
        return { jobId: 'u1' }
      },
      'job.poll': ({ jobId }) => updateJob(jobId, 2, 1)
    })
    const view = await openOrders(host)
    await view.selectRows(table, [JSON.stringify(oid(0)), JSON.stringify(oid(2))])
    await view.press({ text: 'Update 2' })
    assert.equal(view.valueOf({ type: 'RadioGroup', label: 'Documents' }), 'selection')
    await view.type({ label: 'Update' }, '{ status: 1 }')
    assert.ok(view.find({ text: /"status" is not an update operator/ }))
    await view.type({ label: 'Update' }, "{ $set: { status: 'archived' } }", { replace: true })
    await view.press({ text: 'Preview' })
    assert.deepEqual(previews, [{ ns: { connectionId: 'c1', db: 'shop', collection: 'orders' }, scope: { kind: 'ids', ids: [oid(0), oid(2)] }, update: { $set: { status: 'archived' } } }])
    assert.ok(view.find({ text: '2 documents would be updated.' }))
    assert.deepEqual(view.rowsOf({ type: 'Table', label: 'Changes to the first document' }), ['d0'])
    assert.deepEqual(calls.updates, [], 'nothing is written by the preview')
    await view.press({ text: 'Update 2 documents' })
    assert.deepEqual(calls.updates, [{ ns: { connectionId: 'c1', db: 'shop', collection: 'orders' }, scope: { kind: 'ids', ids: [oid(0), oid(2)] }, update: { $set: { status: 'archived' } } }])
    assert.ok(view.find({ text: 'Updated shop.orders: 2 matched, 1 modified.' }))
    assert.equal(view.find({ type: 'Card', label: 'Update documents' }), null)
    assert.deepEqual(view.errors, [])
  })

  test('update many: the query reaches every match, and the whole collection asks for its name', async () => {
    const { host, calls } = setup({
      'doc.updatePreview': ({ scope }) => ({ count: scope.kind === 'all' ? 20000 : 7, approximate: scope.kind === 'all', ms: 2 }),
      'doc.updateMany': (input) => {
        calls.updates!.push(input)
        return { jobId: 'u1' }
      },
      'job.poll': ({ jobId }) => updateJob(jobId, 20000, 20000)
    })
    const view = await openOrders(host)
    await view.type({ label: 'Filter' }, "{ status: 'pending' }", { submit: true })
    await view.press({ text: 'Update many' })
    assert.equal(view.valueOf({ type: 'RadioGroup', label: 'Documents' }), 'query', 'with no selection it starts on the query')
    await view.type({ label: 'Update' }, '[{ $set: { n: 1 } }]')
    await view.press({ text: 'Preview' })
    assert.ok(view.find({ text: '7 documents would be updated.' }))
    // Changing the scope drops the preview: what runs is always what was previewed.
    await view.select({ type: 'RadioGroup', label: 'Documents' }, 'all')
    assert.equal(view.find({ text: '7 documents would be updated.' }), null)
    await view.press({ text: 'Preview' })
    assert.ok(view.find({ text: 'About 20,000 documents would be updated.' }))
    assert.ok(view.find({ type: 'Callout', label: 'Update every document in shop.orders?' }))
    const run = { type: 'Button', text: 'Update every document' }
    assert.equal(view.find(run)!.props.disabled, true)
    await view.type({ label: 'Type orders to confirm' }, 'order')
    assert.equal(view.find(run)!.props.disabled, true)
    await view.type({ label: 'Type orders to confirm' }, 'orders', { replace: true })
    await view.press(run)
    assert.deepEqual(calls.updates, [{ ns: { connectionId: 'c1', db: 'shop', collection: 'orders' }, scope: { kind: 'all' }, update: [{ $set: { n: { $numberInt: '1' } } }] }])
  })

  test('update many: a date in the update is fixed when typed, so the preview and the run agree', async () => {
    const { host, calls } = setup({
      'doc.updatePreview': { count: 3, approximate: false, ms: 1 },
      'doc.updateMany': (input) => {
        calls.updates!.push(input)
        return { jobId: 'u1' }
      },
      'job.poll': ({ jobId }) => updateJob(jobId, 3, 3)
    })
    const view = await openOrders(host)
    await view.type({ label: 'Filter' }, "{ status: 'pending' }", { submit: true })
    await view.press({ text: 'Update many' })
    await view.type({ label: 'Update' }, '{ $set: { at: new Date() } }')
    await view.press({ text: 'Preview' })
    await new Promise((r) => setTimeout(r, 5))
    await view.rerender()
    assert.ok(view.find({ text: '3 documents would be updated.' }), 'the preview stays current as time passes')
    await view.press({ text: 'Update 3 documents' })
    assert.equal(calls.updates!.length, 1)
  })

  test('update many: a refused first document blocks the run, and a failed run needs a new preview', async () => {
    let refuse = true
    const { host, calls } = setup({
      'doc.updatePreview': () => ({
        count: 3,
        approximate: false,
        sample: { before: orders[0]!, diffs: [], capped: false, ...(refuse ? { error: 'Cannot apply $inc to a value of non-numeric type.' } : {}) },
        ms: 1
      }),
      'doc.updateMany': (input) => {
        calls.updates!.push(input)
        return { jobId: 'u1' }
      },
      'job.poll': ({ jobId }) => updateJob(jobId, 0, 0, 'Plan executor error during update.')
    })
    const view = await openOrders(host)
    await view.type({ label: 'Filter' }, "{ status: 'pending' }", { submit: true })
    await view.press({ text: 'Update many' })
    await view.type({ label: 'Update' }, '{ $inc: { status: 1 } }')
    await view.press({ text: 'Preview' })
    assert.ok(view.find({ text: /Cannot apply \$inc/ }))
    assert.equal(view.find({ text: 'Update 3 documents' }), null, 'no confirmation while the server refuses it')
    refuse = false
    await view.press({ text: 'Preview again' })
    await view.press({ text: 'Update 3 documents' })
    assert.ok(view.find({ type: 'Callout', label: 'The update failed' }))
    assert.equal(view.find({ text: 'Update 3 documents' }), null, 'the preview is gone: pressing again cannot repeat it')
    assert.ok(view.find({ type: 'Button', text: 'Preview' }))
    assert.equal(calls.updates!.length, 1)
  })

  test('update many: running the query again drops the preview and its confirmation', async () => {
    const { host } = setup({ 'doc.updatePreview': { count: 3, approximate: false, ms: 1 } })
    const view = await openOrders(host)
    await view.press({ text: 'Update many' })
    await view.type({ label: 'Update' }, "{ $set: { a: 1 } }")
    await view.press({ text: 'Preview' })
    await view.type({ label: 'Type orders to confirm' }, 'orders')
    await view.type({ label: 'Filter' }, '{ a: 1 }', { submit: true })
    await view.type({ label: 'Filter' }, '', { replace: true, submit: true })
    assert.equal(view.find({ text: '3 documents would be updated.' }), null)
    assert.equal(view.find({ text: 'Update every document' }), null)
  })

  test('update many is not offered on a read-only connection', async () => {
    const { host } = setup({ 'connections.state': { ...state, connections: [{ ...state.connections[0]!, readOnly: true }] } })
    const view = await openOrders(host)
    assert.equal(view.find({ text: 'Update many' }), null)
    await view.selectRows(table, [JSON.stringify(oid(0))])
    assert.equal(view.find({ text: /^Update/ }), null)
  })

  test('tree view: fields with types, and Add to query fills the builder', async () => {
    const { host, calls } = setup()
    const view = await openOrders(host)
    await view.press({ text: 'Tree' })
    const tree = { type: 'Tree', label: 'Documents' }
    await view.expand(tree, 'r0')
    const items = view.find(tree)!.props.items as { label: string; children?: { label: string; description: string }[] }[]
    assert.deepEqual(items[0]!.children!.slice(0, 3).map((c) => [c.label, c.description]), [
      ['_id: ObjectId(6542f1a2b3c4d5e6f7a8b900)', 'ObjectId'],
      ['status: shipped', 'String'],
      ['total: 10.5', 'Decimal128']
    ])
    await view.selectItem(tree, 'r0/status')
    await view.press({ text: 'Add to query' })
    await view.press({ text: 'Apply to filter and run' })
    assert.equal(view.valueOf({ label: 'Filter' }), "{ status: 'shipped' }")
    assert.deepEqual(calls.runs.at(-1)!.spec.filter, { status: 'shipped' })
  })

  test('table view: columns of the selected rows replace the filter, as equalities or $in, keeping types', async () => {
    const { host, calls } = setup()
    const view = await openOrders(host)
    await view.selectRows(table, [JSON.stringify(oid(0)), JSON.stringify(oid(1))])
    assert.ok(view.find({ text: /their values in the selected rows become the filter/ }))
    await view.select({ label: 'Filter by' }, 'status')
    await view.select({ label: 'Filter by' }, 'total')
    await view.select({ label: 'Filter by' }, 'createdAt')
    assert.ok(view.find({ text: /^\{ status: \{ \$in: \['shipped', 'pending'\] \}, total: \{ \$in: \[NumberDecimal/ }))
    await view.select({ label: 'Filter by' }, 'total')
    await view.press({ text: 'Replace filter' })
    assert.deepEqual(calls.runs.at(-1)!.spec.filter, { status: { $in: ['shipped', 'pending'] }, createdAt: { $date: { $numberLong: '1794832496789' } } })
    assert.match(view.valueOf({ label: 'Filter' }) as string, /^\{ status: \{ \$in: \['shipped', 'pending'\] \}, createdAt: ISODate\(/)
  })

  test('table view: Add to filter ANDs onto the filter typed, sub-document columns included', async () => {
    const { host, calls } = setup()
    const view = await openOrders(host)
    await view.type({ label: 'Filter' }, '{ qty: { $gte: 1 } }')
    await view.select({ label: 'Show a sub-document as columns' }, 'payment')
    await view.selectRows(table, [JSON.stringify(oid(2))])
    await view.select({ label: 'Filter by' }, 'payment.method')
    await view.select({ label: 'Filter by' }, 'qty')
    await view.press({ text: 'Add to filter' })
    assert.deepEqual(calls.runs.at(-1)!.spec.filter, { $and: [{ qty: { $gte: { $numberInt: '1' } } }, { qty: { $numberInt: '3' }, 'payment.method': 'card' }] })
    assert.equal(view.valueOf({ label: 'Filter' }), "{ $and: [{ qty: { $gte: 1 } }, { qty: 3, 'payment.method': 'card' }] }")
  })

  test('table view: Add to filter keeps the filter as typed, starts from the first match, and says when nothing is new', async () => {
    const { host, calls } = setup()
    const view = await openOrders(host)
    await view.type({ label: 'Filter' }, '{ createdAt: { $lt: new Date() } }')
    await view.toggle({ type: 'Collapsible', label: 'Collation, skip and limit' })
    await view.type({ label: 'Skip' }, '100')
    await view.selectRows(table, [JSON.stringify(oid(0))])
    await view.select({ label: 'Filter by' }, 'status')
    await view.press({ text: 'Add to filter' })
    assert.equal(view.valueOf({ label: 'Filter' }), "{ createdAt: { $lt: new Date() }, status: 'shipped' }")
    assert.equal(calls.runs.at(-1)!.spec.skip, 0)
    const runs = calls.runs.length
    await view.selectRows(table, [JSON.stringify(oid(0))])
    await view.press({ text: 'Add to filter' })
    assert.equal(calls.runs.length, runs)
    assert.ok(view.find({ text: 'The filter already has these conditions.' }))
  })

  test('table view: Add to filter with a filter that does not parse says so and runs nothing', async () => {
    const { host, calls } = setup()
    const view = await openOrders(host)
    await view.type({ label: 'Filter' }, '{ a: ')
    await view.selectRows(table, [JSON.stringify(oid(0))])
    await view.select({ label: 'Filter by' }, 'status')
    const runs = calls.runs.length
    await view.press({ text: 'Add to filter' })
    assert.equal(calls.runs.length, runs)
    assert.equal(view.valueOf({ label: 'Filter' }), '{ a: ')
  })

  test('table view: rows the page cannot show as stored are refused, not filtered as null', async () => {
    const stub: JsonObject = { _id: oid(7), '(document)': { $msTruncated: { kind: 'object', size: 5000, preview: null } } }
    const docs: JsonObject[] = [orders[0]!, stub, { _id: oid(8), status: 'paid', payment: [{ method: 'card' }] }]
    const { host } = setup({ 'query.run': () => ({ queryId: 'q1', offset: 0, docs, truncated: [1], hasMore: false, stoppedForSize: false, ms: 1 }) })
    const view = await openOrders(host)
    await view.selectRows(table, [JSON.stringify(oid(0)), JSON.stringify(oid(7))])
    await view.select({ label: 'Filter by' }, 'status')
    assert.ok(view.find({ text: /too big to show here/ }))
    assert.equal(view.find({ text: 'Replace filter' })!.props.disabled, true)
    await view.select({ label: 'Show a sub-document as columns' }, 'payment')
    await view.selectRows(table, [JSON.stringify(oid(0)), JSON.stringify(oid(8))])
    await view.select({ label: 'Filter by' }, 'status')
    await view.select({ label: 'Filter by' }, 'payment.method')
    assert.ok(view.find({ text: /payment is an array in a selected row/ }))
  })

  test('table view: columns the projection changes cannot be picked', async () => {
    const { host } = setup()
    const view = await openOrders(host)
    await view.type({ label: 'Projection' }, "{ status: 1, 'payment.method': 1 }", { submit: true })
    await view.selectRows(table, [JSON.stringify(oid(0))])
    const options = view.find({ label: 'Filter by' })!.props.options as { value: string; label: string; disabled?: boolean }[]
    assert.deepEqual(options.filter((o) => o.disabled).map((o) => o.label), ['total (changed by the projection)', 'qty (changed by the projection)', 'payment (changed by the projection)', 'createdAt (changed by the projection)'])
    assert.deepEqual(options.filter((o) => !o.disabled).map((o) => o.value), ['_id', 'status'])
  })

  test('a read-only view selects several rows to filter by', async () => {
    const { host, calls } = setup({}, 'view')
    const view = await openOrders(host, 'view')
    assert.equal(view.find(table)!.props.selectionMode, 'multiple')
    await view.selectRows(table, [JSON.stringify(oid(0)), JSON.stringify(oid(2))])
    await view.select({ label: 'Filter by' }, '_id')
    await view.press({ text: 'Replace filter' })
    assert.deepEqual(calls.runs.at(-1)!.spec.filter, { _id: { $in: [oid(0), oid(2)] } })
  })

  test('JSON view switches between relaxed and canonical Extended JSON', async () => {
    const { host } = setup()
    const view = await openOrders(host)
    await view.press({ text: 'JSON' })
    const code = (): string => view.find({ type: 'CodeView' })!.props.code as string
    assert.match(code(), /"qty": 1,/)
    assert.match(code(), /"\$date": "2026-11-16T12:34:56.789Z"/)
    await view.toggle({ label: 'Relaxed Extended JSON' })
    assert.match(code(), /"qty": \{\n\s+"\$numberInt": "1"/)
  })

  test('Query Builder: nested OR, problems per row, and loading a filter back', async () => {
    const { host, calls } = setup()
    const view = await openOrders(host)
    await view.toggle({ type: 'Collapsible', label: 'Query Builder' })
    await view.press({ text: 'Condition' })
    await view.select({ label: 'Field' }, 'status')
    await view.type({ label: 'Value' }, 'shipped')
    await view.press({ text: 'Group' })
    const valueInputs = view.findAll({ label: 'Value' })
    await view.type(valueInputs[1]!, 'nope(1)')
    await view.press({ text: 'Apply to filter and run' })
    assert.ok(view.find({ text: /Unknown name "nope"/ }))
    const before = calls.runs.length
    await view.select(view.findAll({ label: 'Field' })[1]!, 'qty')
    await view.select(view.findAll({ label: 'Operator' })[1]!, 'gte')
    await view.type(view.findAll({ label: 'Value' })[1]!, '2', { replace: true })
    await view.press({ text: 'Apply to filter and run' })
    assert.equal(calls.runs.length, before + 1)
    assert.deepEqual(calls.runs.at(-1)!.spec.filter, { status: 'shipped', qty: { $gte: { $numberInt: '2' } } })
    assert.equal(view.valueOf({ label: 'Filter' }), "{ status: 'shipped', qty: { $gte: 2 } }")

    await view.type({ label: 'Filter' }, '{ $expr: { $gt: ["$a", 1] } }', { replace: true })
    await view.press({ text: 'Load from filter' })
    assert.ok(view.find({ text: /can't show/ }))
  })

  test('saved queries: save by name, run from the list', async () => {
    const { host, calls } = setup()
    const view = await openOrders(host)
    await view.type({ label: 'Filter' }, "{ status: 'pending' }")
    await view.toggle({ type: 'Collapsible', label: 'History and saved queries' })
    await view.type({ label: 'Save this query as' }, 'Pending', { submit: true })
    assert.deepEqual(view.rowsOf({ type: 'Table', label: 'Saved queries' }), ['s:Pending'])
    await view.type({ label: 'Filter' }, '', { replace: true })
    await view.activateRow({ type: 'Table', label: 'Saved queries' }, 's:Pending')
    assert.deepEqual(calls.runs.at(-1)!.spec.filter, { status: 'pending' })
    assert.equal(view.valueOf({ label: 'Filter' }), "{ status: 'pending' }")
  })

  test('views are read only', async () => {
    const { host } = setup({}, 'view')
    const view = await openOrders(host, 'view')
    assert.ok(view.find({ text: 'View · read only' }))
    assert.equal(view.find({ text: 'Insert document' }), null)
    await view.selectRows(table, [JSON.stringify(oid(0))])
    assert.equal(view.find({ text: 'Edit document' }), null)
    assert.ok(view.find({ text: 'Show in Tree' }))
  })

  test('Open shows one whole document over the results, and Back returns to them as they were', async () => {
    const gets: JsonValue[] = []
    const { host, calls } = setup({
      'doc.get': ({ id }) => {
        gets.push(id)
        return { doc: orders.find((o) => JSON.stringify(o._id) === JSON.stringify(id)) ?? null }
      }
    })
    const view = await openOrders(host)
    await view.selectRows(table, [JSON.stringify(oid(1))])
    await view.press({ text: 'Open' })
    assert.deepEqual(gets, [oid(1)], 'the document is read whole from the server')
    assert.equal(view.find({ label: 'Filter' }), null, 'it covers the query bar and the results')
    assert.equal(view.find(table), null)
    assert.ok(view.find({ text: "ObjectId('6542f1a2b3c4d5e6f7a8b901')" }))
    assert.ok(view.find({ text: 'Local dev › shop.orders · 6 fields' }))
    const fields = { type: 'Tree', label: 'Fields' }
    const labels = (): string[] => (view.find(fields)!.props.items as { label: string }[]).map((i) => i.label)
    assert.deepEqual(labels().slice(0, 3), ['_id: ObjectId(6542f1a2b3c4d5e6f7a8b901)', 'status: pending', 'total: 20.5'])
    await view.expand(fields, 'r0/payment')
    const payment = (view.find(fields)!.props.items as { key: string; children?: { label: string }[] }[]).find((i) => i.key === 'r0/payment')!
    assert.deepEqual(payment.children!.map((c) => c.label), ['method: card', 'last4: 1234'])

    await view.press({ text: 'Shell' })
    assert.match(view.find({ type: 'CodeView' })!.props.code as string, /qty: 2,/)
    await view.press({ text: 'JSON' })
    assert.match(view.find({ type: 'CodeView' })!.props.code as string, /"status": "pending"/)

    await view.press({ text: 'Tree' })
    await view.activateItem(fields, 'r0/qty')
    await view.type({ label: 'Value' }, '7', { replace: true })
    await view.press({ text: 'Save field' })
    assert.deepEqual(calls.updates, [{ ns: { connectionId: 'c1', db: 'shop', collection: 'orders' }, id: oid(1), path: ['qty'], value: { $numberInt: '7' } }])
    assert.equal(gets.length, 3, 'Edit field reads it whole, and saving reads it again')
    assert.ok(view.find({ text: 'Saved qty.' }))

    const runs = calls.runs.length
    await view.press({ text: 'Back to results' })
    assert.ok(view.find(table))
    assert.ok(view.find({ label: 'Filter' }))
    assert.equal(calls.runs.length, runs, 'going back does not run the query again')
    assert.deepEqual(view.errors, [])
    assert.deepEqual(view.warnings, [])
  })

  test('deleting the open document asks first, then goes back to the results', async () => {
    const { host, calls } = setup()
    const view = await openOrders(host)
    await view.selectRows(table, [JSON.stringify(oid(2))])
    await view.press({ text: 'Open' })
    await view.press({ text: 'Delete' })
    assert.ok(view.find({ type: 'Callout', label: 'Delete 1 document from shop.orders?' }))
    assert.deepEqual(calls.deletes, [])
    await view.press({ text: 'Delete document' })
    assert.deepEqual((calls.deletes![0] as { ids: JsonValue[] }).ids, [oid(2)])
    assert.ok(view.find(table), 'back on the results')
    assert.ok(view.find({ text: 'Deleted 1 document from shop.orders.' }))
  })

  test('Open in a tab adds one tab per document, next to its collection, that edits on its own', async () => {
    const { host, calls } = setup()
    const view = await openOrders(host)
    const collTab = tabIdFor({ connectionId: 'c1', db: 'shop', collection: 'orders' })
    const docTab = docTabIdFor({ connectionId: 'c1', db: 'shop', collection: 'orders' }, oid(0))
    await view.press({ text: 'Tree' })
    await view.selectItem({ type: 'Tree', label: 'Documents' }, 'r0')
    await view.press({ label: 'Open in a tab' })
    assert.equal(view.valueOf({ type: 'Tabs' }), docTab)
    assert.deepEqual(view.findAll({ type: 'Tab' }).map((t) => t.props.value), ['tree', collTab, docTab])
    assert.match(view.findAll({ type: 'Tab' })[2]!.props.label as string, /^orders · ObjectId\('6542f1a2b3c4/)
    assert.equal(view.find({ text: 'Back to results' }), null, 'a tab closes instead of going back')

    await view.press({ text: 'Edit document' })
    const text = view.valueOf({ label: 'Document' }) as string
    await view.type({ label: 'Document' }, text.replace("status: 'shipped'", "status: 'returned'"), { replace: true })
    await view.press({ text: 'Save document' })
    assert.equal((calls.replaces![0] as { doc: JsonObject }).doc.status, 'returned')
    assert.ok(view.find({ text: 'Document saved.' }))
    assert.equal(calls.runs.length, 1, 'the document tab never runs a query')

    await view.select({ type: 'Tabs' }, collTab)
    await view.press({ text: 'Table' })
    await view.selectRows(table, [JSON.stringify(oid(0))])
    await view.press({ label: 'Open in a tab' })
    assert.equal(view.findAll({ type: 'Tab' }).length, 3, 'the same document finds its tab again')
    assert.equal(view.valueOf({ type: 'Tabs' }), docTab)

    await view.press({ text: 'Delete' })
    await view.press({ text: 'Delete document' })
    assert.ok(view.find({ type: 'EmptyState', label: 'Document deleted' }))
    await view.press({ label: `Close orders · ${"ObjectId('6542f1a2b3c4d5e6f7a8b900')".slice(0, 24)}` })
    assert.deepEqual(view.findAll({ type: 'Tab' }).map((t) => t.props.value), ['tree', collTab])
    assert.deepEqual(view.errors, [])
  })

  test('Open in a tab keeps the view the document is shown in, not the one chosen last', async () => {
    const { host } = setup({}, 'coll', { [DOC_VIEW]: 'json' })
    const view = await openOrders(host)
    const collTab = tabIdFor({ connectionId: 'c1', db: 'shop', collection: 'orders' })
    await view.selectRows(table, [JSON.stringify(oid(0))])
    await view.press({ label: 'Open in a tab' })
    await view.select({ type: 'Tabs' }, collTab)
    await view.selectRows(table, [JSON.stringify(oid(1))])
    await view.press({ text: 'Open' })
    assert.match(view.find({ type: 'CodeView' })!.props.code as string, /"status": "pending"/, 'it opens in the remembered JSON')
    await view.select({ type: 'Tabs' }, docTabIdFor({ connectionId: 'c1', db: 'shop', collection: 'orders' }, oid(0)))
    await view.press({ text: 'Shell' })
    assert.equal(host.data().storage[DOC_VIEW], 'shell')
    await view.select({ type: 'Tabs' }, collTab)
    await view.press({ label: 'Open in a tab' })
    assert.equal(view.valueOf({ type: 'Tabs' }), docTabIdFor({ connectionId: 'c1', db: 'shop', collection: 'orders' }, oid(1)))
    assert.match(view.find({ type: 'CodeView' })!.props.code as string, /"status": "pending"/, 'still JSON, as it was on screen')
    assert.deepEqual(view.errors, [])
  })

  test('a remembered view that is not one any more falls back to Table and Tree', async () => {
    const { host } = setup({}, 'coll', { [RESULT_VIEW]: 'grid', [DOC_VIEW]: 42 })
    const view = await openOrders(host)
    assert.ok(view.find(table))
    await view.selectRows(table, [JSON.stringify(oid(1))])
    await view.press({ text: 'Open' })
    assert.ok(view.find({ type: 'Tree', label: 'Fields' }))
    assert.deepEqual(view.errors, [])
  })

  test('Show in Tree in a read-only view is remembered like pressing Tree', async () => {
    const { host } = setup({}, 'view')
    const view = await openOrders(host, 'view')
    await view.selectRows(table, [JSON.stringify(oid(1))])
    await view.press({ text: 'Show in Tree' })
    assert.ok(view.find({ type: 'Tree', label: 'Documents' }))
    assert.equal(host.data().storage[RESULT_VIEW], 'tree')
  })

  test('in a read-only view, Enter on a row opens the document, with nothing to edit', async () => {
    const { host } = setup({}, 'view')
    const view = await openOrders(host, 'view')
    await view.activateRow(table, JSON.stringify(oid(0)))
    assert.ok(view.find({ type: 'Tree', label: 'Fields' }))
    assert.ok(view.find({ text: 'Read only' }))
    assert.equal(view.find({ text: 'Edit document' }), null)
    assert.equal(view.find({ text: 'Delete' }), null)
    await view.press({ text: 'Back to results' })
    assert.ok(view.find(table))
  })

  test('a failed query says so in the tab, and closing the tab goes back', async () => {
    const { host } = setup({
      'query.run': () => {
        throw Object.assign(new Error('unknown top level operator: $bogus'), { code: 'action_failed' })
      }
    })
    const view = await openOrders(host)
    assert.ok(view.find({ type: 'Callout', label: 'The query failed' }))
    await view.press({ label: 'Close orders' })
    assert.equal(view.valueOf({ type: 'Tabs' }), 'tree')
    assert.equal(view.findAll({ type: 'Tab' }).length, 1)
  })
})

describe('switching sidebar tabs', () => {
  // Orca ends the panel's run when another sidebar tab is shown; the next run starts from
  // persisted atoms only. The layout save waits for the panel to settle.
  const LAYOUT = 'mongo-studio.layout'
  async function saved(view: Awaited<ReturnType<typeof mount>>): Promise<Record<string, unknown>> {
    await new Promise((resolve) => setTimeout(resolve, 400))
    await view.settled()
    return view.persisted.workspace
  }
  const ordersTab = tabIdFor({ connectionId: 'c1', db: 'shop', collection: 'orders' })

  test('the next run brings back the tabs, the query and the tree, and runs the query again', async () => {
    const first = setup()
    const before = await openOrders(first.host)
    await before.type({ label: 'Filter' }, "{ status: 'shipped' }")
    await before.press({ text: 'Run' })
    const persisted = await saved(before)
    assert.ok(persisted[LAYOUT])
    assert.ok(!JSON.stringify(persisted[LAYOUT]).includes('6542f1a2'), 'no documents are saved')
    await before.unmount()

    const second = setup()
    const after = await mount(panel, { host: second.host, persisted: { workspace: persisted } })
    await after.settled()
    assert.equal(after.valueOf({ type: 'Tabs' }), ordersTab)
    assert.equal(after.valueOf({ label: 'Filter' }), "{ status: 'shipped' }")
    assert.equal(second.calls.runs.length, 1)
    assert.deepEqual(second.calls.runs[0]!.spec.filter, { status: 'shipped' })
    assert.equal(second.calls.runs[0]!.text, undefined, 'restoring is not recorded in the history')
    assert.ok(after.find({ text: '1–3 of 4' }))
    await after.select({ type: 'Tabs' }, 'tree')
    assert.deepEqual(after.expandedOf({ type: 'Tree' }).filter((k) => k.startsWith('conn:')), ['conn:c1', 'conn:c1/db:shop'])
    assert.deepEqual(after.errors, [])
  })

  test('new tabs and documents open in the views chosen last; restored tabs keep their own', async () => {
    const first = setup()
    const before = await openOrders(first.host)
    const layout = structuredClone(await saved(before))
    await before.selectRows(table, [JSON.stringify(oid(1))])
    await before.press({ text: 'Open' })
    await before.press({ text: 'Shell' })
    await before.press({ text: 'Back to results' })
    await before.press({ text: 'JSON' })
    const prefs = structuredClone(first.host.data().storage) as Record<string, JsonValue>
    assert.equal(prefs[RESULT_VIEW], 'json')
    assert.equal(prefs[DOC_VIEW], 'shell')
    await before.unmount()

    const second = setup()
    const fresh = await openOrders(second.host)
    assert.ok(fresh.find(table), 'without a remembered view, a tab opens as Table')
    await fresh.unmount()

    const third = setup({}, 'coll', prefs)
    const next = await openOrders(third.host)
    assert.equal(next.find(table), null, 'the new tab opens as JSON')
    assert.match(next.find({ type: 'CodeView' })!.props.code as string, /"status": "shipped"/)
    await next.press({ text: 'Table' })
    await next.selectRows(table, [JSON.stringify(oid(1))])
    await next.press({ text: 'Open' })
    assert.match(next.find({ type: 'CodeView' })!.props.code as string, /qty: 2,/, 'the document opens as Shell')
    assert.deepEqual(next.errors, [])
    await next.unmount()

    const fourth = setup({}, 'coll', prefs)
    const restored = await mount(panel, { host: fourth.host, persisted: { workspace: layout } })
    await restored.settled()
    assert.equal(restored.valueOf({ type: 'Tabs' }), ordersTab)
    assert.ok(restored.find(table), 'a restored tab keeps the Table it was saved with')
    assert.deepEqual(restored.errors, [])
    await restored.unmount()
  })

  test('a restored document tab keeps its own view', async () => {
    const first = setup()
    const before = await openOrders(first.host)
    await before.selectRows(table, [JSON.stringify(oid(0))])
    await before.press({ label: 'Open in a tab' })
    await before.press({ text: 'JSON' })
    const layout = structuredClone(await saved(before))
    await before.press({ text: 'Shell' })
    const prefs = structuredClone(first.host.data().storage) as Record<string, JsonValue>
    assert.equal(prefs[DOC_VIEW], 'shell')
    await before.unmount()

    const second = setup({}, 'coll', prefs)
    const after = await mount(panel, { host: second.host, persisted: { workspace: layout } })
    await after.settled()
    assert.equal(after.valueOf({ type: 'Tabs' }), docTabIdFor({ connectionId: 'c1', db: 'shop', collection: 'orders' }, oid(0)))
    assert.match(after.find({ type: 'CodeView' })!.props.code as string, /"status": "shipped"/, 'JSON, as it was saved')
    assert.deepEqual(after.errors, [])
    await after.unmount()
  })

  test('a connection that is no longer open keeps its tabs but does not connect', async () => {
    const first = setup()
    const before = await openOrders(first.host)
    const persisted = await saved(before)
    await before.unmount()

    const closed: ConnectionsState = { ...state, connections: [{ ...state.connections[0]!, connected: false }] }
    let treeReads = 0
    const second = setup({
      'connections.state': closed,
      'tree.children': () => {
        treeReads++
        return { nodes: [] }
      }
    })
    const after = await mount(panel, { host: second.host, persisted: { workspace: persisted } })
    await after.settled()
    assert.equal(after.valueOf({ type: 'Tabs' }), ordersTab)
    assert.equal(second.calls.runs.length, 0)
    assert.equal(treeReads, 0, 'the tree does not open a closed connection')
    assert.ok(after.find({ text: /This connection is not open/ }))
  })

  // Orca stops an idle worker after a few minutes, and every connection closes with it.
  async function afterWorkerStop(resumable: boolean) {
    const first = setup()
    const before = await openOrders(first.host)
    const persisted = await saved(before)
    await before.unmount()
    assert.deepEqual((persisted[LAYOUT] as { open?: string[] }).open, ['c1'])

    let connected = false
    let treeReads = 0
    const conn = () => ({ ...state, connections: [{ ...state.connections[0]!, connected, resumable }] })
    const second = setup({
      'connections.state': conn,
      'tree.children': ({ key }) => {
        treeReads++
        connected = true
        return key === 'conn:c1'
          ? { nodes: [{ key: 'conn:c1/db:shop', kind: 'db', label: 'shop', hasChildren: true }] }
          : { nodes: [{ key: 'conn:c1/db:shop/coll:orders', kind: 'coll', label: 'orders', hasChildren: true }] }
      }
    })
    const after = await mount(panel, { host: second.host, persisted: { workspace: persisted } })
    await after.settled()
    return { after, calls: second.calls, treeReads: () => treeReads }
  }

  test('after the worker stopped, a connection that was open connects again and its tabs run', async () => {
    const { after, calls, treeReads } = await afterWorkerStop(true)
    assert.ok(treeReads() > 0)
    assert.equal(after.valueOf({ type: 'Tabs' }), ordersTab)
    assert.equal(calls.runs.length, 1)
    assert.ok(!after.find({ text: /This connection is not open/ }))
    assert.deepEqual(after.errors, [])
  })

  test('a connection that would need the person (browser sign-in) is not connected again', async () => {
    const { after, calls, treeReads } = await afterWorkerStop(false)
    assert.equal(treeReads(), 0)
    assert.equal(calls.runs.length, 0)
    assert.ok(after.find({ text: /This connection is not open/ }))
  })
})

// The Settings tab itself is tested in panel.test.tsx; these are what each setting does here.
describe('settings', () => {
  test('new tabs start in the chosen view, page size and Extended JSON, whatever was used last', async () => {
    const { host, calls } = setup({}, 'coll', { [RESULT_VIEW]: 'tree', [DOC_VIEW]: 'tree' }, { resultView: 'json', docView: 'shell', pageSize: 20, ejson: 'canonical' })
    const view = await openOrders(host)
    assert.equal(calls.runs[0]!.pageSize, 20)
    const code = view.find({ type: 'CodeView', label: 'Documents as Extended JSON' })!.props.code as string
    assert.match(code, /"\$numberDecimal": "10.5"/, 'canonical keeps the type')
    assert.match(code, /"\$numberInt": "1"/)
    await view.press({ text: 'Table' })
    await view.selectRows(table, [JSON.stringify(oid(0))])
    await view.press({ text: 'Open' })
    assert.ok(view.find({ type: 'CodeView', label: 'Document in shell syntax' }), 'documents open in Shell, not the Tree used last')
    await view.press({ type: 'Button', text: 'JSON' })
    assert.equal(view.valueOf({ type: 'Switch', label: 'Relaxed Extended JSON' }), false)
    assert.deepEqual(view.errors, [])
  })

  test('"Last used" page size and views follow what was chosen last', async () => {
    const { host, calls } = setup({}, 'coll', { [RESULT_VIEW]: 'tree' }, { pageSize: 0 })
    const view = await openOrders(host, 'coll', { plugin: { 'mongo-studio.pageSize': 100 } })
    assert.equal(calls.runs[0]!.pageSize, 100)
    assert.ok(view.find({ type: 'Tree', label: 'Documents' }))
  })

  test('with confirmations off, deleting documents and updating every document go ahead', async () => {
    const { host, calls } = setup({
      'doc.updatePreview': () => ({ count: 4, approximate: false, ms: 2 }),
      'doc.updateMany': (input) => {
        calls.updates!.push(input)
        return { jobId: 'u1' }
      },
      'job.poll': ({ jobId }) => updateJob(jobId, 4, 4)
    }, 'coll', {}, { confirmDeleteDocs: false, confirmByName: false })
    const view = await openOrders(host)
    await view.selectRows(table, [JSON.stringify(oid(2))])
    await view.press({ text: 'Delete' })
    assert.deepEqual((calls.deletes![0] as { ids: JsonValue[] }).ids, [oid(2)])
    assert.equal(view.find({ type: 'Callout', label: 'Delete 1 document from shop.orders?' }), null)
    assert.ok(view.find({ text: 'Deleted 1 document from shop.orders.' }))
    await view.press({ text: 'Update many' })
    await view.select({ type: 'RadioGroup', label: 'Documents' }, 'all')
    await view.type({ label: 'Update' }, '{ $set: { n: 1 } }')
    await view.press({ text: 'Preview' })
    assert.equal(view.find({ label: 'Type orders to confirm' }), null)
    await view.press({ type: 'Button', text: 'Update every document' })
    assert.equal(calls.updates!.length, 1)
  })

  test('with checking while typing off, errors wait for Run; with Format buttons off, there are none', async () => {
    const { host, calls } = setup({}, 'coll', {}, { liveCheck: false, formatButtons: false })
    const view = await openOrders(host)
    assert.equal(view.find({ type: 'IconButton', label: 'Format the filter on several lines' }), null)
    await view.type({ label: 'Filter' }, '{ a: 1 ]')
    assert.equal(view.find({ type: 'Field', label: 'Filter' })!.props.error, undefined)
    await view.submit({ label: 'Filter' })
    assert.ok(view.find({ type: 'Field', label: 'Filter' })!.props.error, 'Run still says what is wrong')
    assert.equal(calls.runs.length, 1)
    await view.type({ label: 'Filter' }, '{\n  a: 1\n}', { replace: true })
    assert.ok(view.find({ type: 'IconButton', label: 'Put the filter on one line' }), 'a multi-line box can always go back')
  })
})

describe('settings: deleting without asking', () => {
  test('shows no confirmation while the deletion runs, and a second press sends nothing', async () => {
    let finish: (() => void) | undefined
    const { host, calls } = setup({
      'doc.deleteMany': (input) => {
        calls.deletes!.push(input)
        return new Promise((resolve) => (finish = () => resolve({ deleted: input.ids.length })))
      }
    }, 'coll', {}, { confirmDeleteDocs: false })
    const view = await openOrders(host)
    await view.selectRows(table, [JSON.stringify(oid(2))])
    const pressing = view.press({ text: 'Delete' })
    await new Promise((r) => setTimeout(r, 0))
    assert.equal(view.find({ type: 'Callout', label: 'Delete 1 document from shop.orders?' }), null)
    assert.equal(view.find({ text: 'Delete document' }), null, 'nothing to confirm or cancel')
    void view.press({ text: 'Delete' }).catch(() => undefined)
    await new Promise((r) => setTimeout(r, 0))
    finish!()
    await pressing
    await view.settled()
    assert.equal(calls.deletes!.length, 1)
    assert.ok(view.find({ text: 'Deleted 1 document from shop.orders.' }))
  })
})
