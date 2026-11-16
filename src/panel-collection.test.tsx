// Collection tabs over a stand-in worker: querying, paging, the views, the editors, the Query
// Builder and history. What the person sees, and what reaches the worker.
import { assert, describe, mockHost, mount, test, type MockRequests } from 'orca/testing'
import type { ConnectionsState, QueryLibrary, QueryPage, QuerySpec, QueryText } from './protocol'
import type { JsonObject, JsonValue } from './shared/ejson-view'
import * as panel from './panel'
import { tabIdFor } from './panel/collection-state'

const state: ConnectionsState = {
  connections: [{ id: 'c1', name: 'Local dev', group: '', subtitle: 'localhost', topology: 'replicaSet', connected: true }],
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

function setup(extra: MockRequests = {}, kind: 'coll' | 'view' = 'coll') {
  const calls: Calls = { runs: [], pages: [], updates: [], replaces: [], inserts: [], deletes: [] }
  let library: QueryLibrary = { history: [], saved: [] }
  const page = (offset: number, docs: JsonObject[], hasMore: boolean): QueryPage => ({ queryId: 'q1', offset, docs, truncated: [], hasMore, stoppedForSize: false, ms: 3 })
  const host = mockHost({
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

async function openOrders(host: ReturnType<typeof setup>['host'], kind: 'coll' | 'view' = 'coll') {
  const view = await mount(panel, { host })
  const tree = { type: 'Tree' }
  await view.expand(tree, 'conn:c1')
  await view.expand(tree, 'conn:c1/db:shop')
  await view.selectItem(tree, `conn:c1/db:shop/${kind}:orders`)
  await view.press({ text: kind === 'view' ? 'Open view' : 'Open' })
  return view
}

const table = { type: 'Table', label: 'Documents' }

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
